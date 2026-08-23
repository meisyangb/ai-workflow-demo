/**
 * HTTP Client 抽象层
 *
 * 统一的请求封装：
 * - 超时控制（AbortController）
 * - 失败重试（指数退避；仅网络错误 / 超时 / 5xx 重试，4xx 不重试）
 * - 统一错误类型（HttpError，区分网络错误 / 超时 / 状态码 / 解析失败）
 * - JSON 自动序列化 / 反序列化
 *
 * fetch 通过构造参数注入（依赖注入），便于单元测试与将来在
 * 真实后端 / Mock 适配层之间切换。
 */

export const HttpMethod = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
} as const;
export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

export const HttpErrorCode = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  BAD_STATUS: 'BAD_STATUS',
  PARSE_ERROR: 'PARSE_ERROR',
} as const;
export type HttpErrorCode = (typeof HttpErrorCode)[keyof typeof HttpErrorCode];

/** 可注入的 fetch 实现（与全局 fetch 签名兼容） */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 请求配置 */
export interface HttpRequestConfig {
  /** 相对 baseUrl 的路径，或以 http(s) 开头的完整 URL */
  url: string;
  method?: HttpMethod;
  /** 请求体：自动 JSON 序列化并设置 Content-Type */
  body?: unknown;
  headers?: Record<string, string>;
  /** 本次请求超时（毫秒），缺省取客户端配置 */
  timeoutMs?: number;
  /** 本次请求额外重试次数，缺省取客户端配置 */
  retries?: number;
}

/** 请求快捷方法的可选配置 */
export type RequestOptions = Omit<HttpRequestConfig, 'url' | 'method'>;

/** 流式请求：返回原始 Response + body ReadableStream（用于 SSE / 大文件下载）。 */
export interface StreamRequestConfig extends HttpRequestConfig {
  /** 响应体解析策略；SSE 模式下客户端用 sseParser 自己读 ReadableStream，不做 JSON。
   *  - 'stream': 直接抛 { res, url }；调用方负责消费/关闭。
   *  - 'text' / 'json'：正常 request() 行为（与 request<T>() 默认一致）。
   */
  responseType?: 'json' | 'text' | 'stream' | 'blob' | 'arrayBuffer';
  /** 为 stream 模式取消 Abort 超时，改为由调用方消费流时控制（如 SSE idleTimeoutMs）。*/
  skipTimeoutSignal?: boolean;
}

/** 响应封装 */
export interface HttpResponse<T> {
  status: number;
  data: T;
}

/** 统一 HTTP 错误 */
export class HttpError extends Error {
  readonly code: HttpErrorCode;
  /** HTTP 状态码；网络错误 / 超时 / 解析失败时为 null */
  readonly status: number | null;
  readonly url: string;
  /** 服务端返回的错误体（若可解析） */
  readonly body: unknown;

  constructor(
    code: HttpErrorCode,
    message: string,
    url: string,
    status: number | null = null,
    body: unknown = null,
  ) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface HttpClientOptions {
  /** 基础 URL，与每次请求的 url 拼接 */
  baseUrl?: string;
  /** 全局默认请求头 */
  defaultHeaders?: Record<string, string>;
  /** 默认超时（毫秒） */
  timeoutMs?: number;
  /** 默认额外重试次数 */
  retries?: number;
  /** 重试基础延迟（毫秒），按指数退避：base * 2^attempt */
  retryBaseDelayMs?: number;
  /** 注入的 fetch 实现（默认全局 fetch） */
  fetchImpl?: FetchLike;
  /**
   * v0.4.1 钩子：收到 401/403 且请求即将抛错前调用；
   * 返回值：
   *  - true：已经完成了 token 刷新 / 注入 cookie 等动作 → 重试当前请求（不消耗 retries 计数）
   *  - false：不处理，走原有重试/抛错逻辑
   * 最多会被调用 maxUnauthorizedAttempts 次（避免无限循环 refresh）。
   */
  onUnauthorized?: (err: HttpError, attempt: number) => Promise<boolean> | boolean;
  /** onUnauthorized 最大调用次数，缺省 1。 */
  maxUnauthorizedAttempts?: number;
}

export interface HttpClient {
  request<T>(config: HttpRequestConfig): Promise<HttpResponse<T>>;
  get<T>(url: string, config?: RequestOptions): Promise<HttpResponse<T>>;
  post<T>(url: string, body?: unknown, config?: RequestOptions): Promise<HttpResponse<T>>;
  put<T>(url: string, body?: unknown, config?: RequestOptions): Promise<HttpResponse<T>>;
  delete<T>(url: string, config?: RequestOptions): Promise<HttpResponse<T>>;
  /**
   * v0.4.1 流式请求：返回原始 Response（含 body ReadableStream）；
   * 调用方负责消费/关闭。配合 sseParser 做 SSE 消费最顺手。
   *
   * 错误语义：4xx/5xx 统一抛 HttpError（body 已保留）。
   */
  stream(config: StreamRequestConfig): Promise<{
    status: number;
    headers: Headers;
    url: string;
    /** body：未被消费的 ReadableStream；注意：必须消费或 cancel，否则连接会泄漏。 */
    body: ReadableStream<Uint8Array>;
  }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;

function joinUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/** 网络错误 / 超时 / 5xx 可重试；4xx 除了 429（限流）/ 408（超时） 外通常不重试。
 * 注意：429/408 属于"服务端/网关压力下短暂失败"，重试通常有效，但需要按 Retry-After 睡一下。
 * 401/403：是否重试交给 onUnauthorized 钩子（通常刷新 token 后重试 1 次）。
 */
function isRetryable(err: unknown, allow401Refresh = false): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.code === HttpErrorCode.BAD_STATUS) {
    const s = err.status ?? 0;
    if (s >= 500) return true;
    if (s === 408 || s === 429 || s === 425) return true;
    if (allow401Refresh && (s === 401 || s === 403)) return true;
    return false;
  }
  return err.code === HttpErrorCode.NETWORK_ERROR || err.code === HttpErrorCode.TIMEOUT;
}

/** 从 HttpError.body 里读取 Retry-After（秒 / 毫秒都兼容），返回毫秒；找不到返回 null */
export function extractRetryAfter(err: HttpError): number | null {
  if (!err) return null;
  const b = err.body as
    | { retry_after_ms?: unknown; retryAfterMs?: unknown; retry_after?: unknown; wait_ms?: unknown }
    | null;
  if (b && typeof b === 'object') {
    const v = [b.retry_after_ms, b.retryAfterMs, b.retry_after, b.wait_ms].find(
      (x) => typeof x === 'number' && Number.isFinite(x) && (x as number) >= 0,
    ) as number | undefined;
    if (typeof v === 'number') {
      // retry_after（无后缀）通常是秒；retry_after_ms / wait_ms 通常是毫秒
      if (v === b.retry_after && v > 0 && v < 1000) return v * 1000;
      return v;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const {
    baseUrl = '',
    defaultHeaders = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    fetchImpl = fetch,
    onUnauthorized = null,
    maxUnauthorizedAttempts = 1,
  } = options;

  /**
   * 单次请求（不含重试）。
   * T 的语义由 responseType 决定：
   *  - json：T = parsed JSON
   *  - text：T = string
   *  - blob：T = Blob
   *  - arrayBuffer：T = ArrayBuffer
   *  - stream：T = { status, headers, url, body: ReadableStream }（不抛 ok 错，stream() 外层判定 4xx/5xx）
   */
  async function requestOnceInternal(
    config: HttpRequestConfig,
    fullUrl: string,
    timeout: number,
    responseType: 'json' | 'text' | 'blob' | 'arrayBuffer' | 'stream',
    skipTimeoutSignal: boolean,
  ): Promise<HttpResponse<unknown> | { streamPayload: { status: number; headers: Headers; url: string; body: ReadableStream<Uint8Array> } }> {
    const controller = new AbortController();
    const timer = skipTimeoutSignal || timeout <= 0 ? null : setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetchImpl(fullUrl, {
        method: config.method ?? HttpMethod.GET,
        headers: {
          ...(config.body !== undefined && responseType !== 'stream' ? { 'Content-Type': 'application/json' } : {}),
          ...(config.body !== undefined && responseType === 'stream' ? { 'Content-Type': 'application/json' } : {}),
          ...defaultHeaders,
          ...config.headers,
        },
        body: config.body !== undefined && (typeof config.body === 'string'
          || (typeof ArrayBuffer !== 'undefined' && config.body instanceof ArrayBuffer)
          || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(config.body as object))
          || (typeof Blob !== 'undefined' && config.body instanceof Blob))
          ? (config.body as BodyInit)
          : config.body !== undefined
            ? JSON.stringify(config.body)
            : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'AbortError') {
        throw new HttpError(HttpErrorCode.TIMEOUT, `请求超时（${timeout}ms）：${fullUrl}`, fullUrl);
      }
      throw new HttpError(HttpErrorCode.NETWORK_ERROR, `网络错误：${(err as Error).message}`, fullUrl);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (responseType === 'stream') {
      return {
        streamPayload: {
          status: res.status,
          headers: res.headers,
          url: res.url || fullUrl,
          body: (res.body ?? new ReadableStream<Uint8Array>({ start(c) { c.close(); } })) as ReadableStream<Uint8Array>,
        },
      };
    }

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json().catch(() => null);
      } catch {
        body = null;
      }
      throw new HttpError(HttpErrorCode.BAD_STATUS, `HTTP ${res.status}：${fullUrl}`, fullUrl, res.status, body);
    }

    if (res.status === 204) {
      return { status: res.status, data: null as unknown };
    }

    switch (responseType) {
      case 'text': {
        const text = await res.text();
        return { status: res.status, data: text };
      }
      case 'blob': {
        const blob = await res.blob();
        return { status: res.status, data: blob };
      }
      case 'arrayBuffer': {
        const ab = await res.arrayBuffer();
        return { status: res.status, data: ab };
      }
      case 'json':
      default: {
        const text = await res.text();
        if (!text) return { status: res.status, data: null as unknown };
        try {
          return { status: res.status, data: JSON.parse(text) as unknown };
        } catch {
          throw new HttpError(HttpErrorCode.PARSE_ERROR, `响应体不是合法 JSON：${fullUrl}`, fullUrl, res.status);
        }
      }
    }
  }

  async function request<T>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
    const fullUrl = joinUrl(baseUrl, config.url);
    const timeout = config.timeoutMs ?? timeoutMs;
    const maxAttempts = 1 + (config.retries ?? retries);

    let unauthorizedAttempts = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const r = await requestOnceInternal(config, fullUrl, timeout, 'json', false);
        return r as HttpResponse<T>;
      } catch (err) {
        // 401/403 + onUnauthorized：最多尝试 maxUnauthorizedAttempts 次 token 刷新
        if (
          onUnauthorized &&
          err instanceof HttpError &&
          (err.status === 401 || err.status === 403) &&
          unauthorizedAttempts < maxUnauthorizedAttempts
        ) {
          try {
            const refreshed = await Promise.resolve(onUnauthorized(err, unauthorizedAttempts));
            unauthorizedAttempts += 1;
            if (refreshed) {
              // 不算进 attempt 重试计数（这是"鉴权修复"，不是普通网络重试）
              attempt -= 1;
              continue;
            }
          } catch {
            // 钩子自身异常：降级为普通抛错流程
            unauthorizedAttempts += 1;
          }
        }
        if (attempt === maxAttempts - 1 || !isRetryable(err, false)) throw err;
        let delay = retryBaseDelayMs * 2 ** attempt;
        if (err instanceof HttpError && err.status === 429) {
          const retryAfterMs = extractRetryAfter(err);
          if (retryAfterMs != null) delay = Math.max(delay, retryAfterMs);
        }
        await sleep(delay);
      }
    }
    // 循环内必 return / throw，此处仅为满足类型系统
    throw new HttpError(HttpErrorCode.NETWORK_ERROR, `请求失败：${fullUrl}`, fullUrl);
  }

  async function stream(config: StreamRequestConfig): Promise<{
    status: number;
    headers: Headers;
    url: string;
    body: ReadableStream<Uint8Array>;
  }> {
    const fullUrl = joinUrl(baseUrl, config.url);
    const timeout = config.timeoutMs ?? timeoutMs;
    const maxAttempts = 1 + (config.retries ?? retries);
    let unauthorizedAttempts = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const r = await requestOnceInternal(
          config,
          fullUrl,
          timeout,
          'stream',
          config.skipTimeoutSignal ?? true,
        ) as { streamPayload: { status: number; headers: Headers; url: string; body: ReadableStream<Uint8Array> } };
        const p = r.streamPayload;
        if (p.status < 200 || p.status >= 300) {
          // 非 2xx：读取一下 body（尽可能）然后抛错，防止 stream 泄漏
          let body: unknown = null;
          try {
            const texts: string[] = [];
            const reader = p.body.getReader();
            const dec = new TextDecoder('utf-8', { fatal: false });
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              texts.push(dec.decode(value, { stream: true }));
            }
            texts.push(dec.decode());
            const t = texts.join('');
            if (t) body = JSON.parse(t);
          } catch {
            body = null;
          }
          throw new HttpError(HttpErrorCode.BAD_STATUS, `HTTP ${p.status}：${fullUrl}`, fullUrl, p.status, body);
        }
        return p;
      } catch (err) {
        if (
          onUnauthorized &&
          err instanceof HttpError &&
          (err.status === 401 || err.status === 403) &&
          unauthorizedAttempts < maxUnauthorizedAttempts
        ) {
          try {
            const refreshed = await Promise.resolve(onUnauthorized(err, unauthorizedAttempts));
            unauthorizedAttempts += 1;
            if (refreshed) { attempt -= 1; continue; }
          } catch {
            unauthorizedAttempts += 1;
          }
        }
        if (attempt === maxAttempts - 1 || !isRetryable(err, false)) throw err;
        let delay = retryBaseDelayMs * 2 ** attempt;
        if (err instanceof HttpError && err.status === 429) {
          const retryAfterMs = extractRetryAfter(err);
          if (retryAfterMs != null) delay = Math.max(delay, retryAfterMs);
        }
        await sleep(delay);
      }
    }
    throw new HttpError(HttpErrorCode.NETWORK_ERROR, `请求失败：${fullUrl}`, fullUrl);
  }

  return {
    request,
    get: <T,>(url: string, config?: RequestOptions) => request<T>({ ...config, url, method: HttpMethod.GET }),
    post: <T,>(url: string, body?: unknown, config?: RequestOptions) => request<T>({ ...config, url, method: HttpMethod.POST, body }),
    put: <T,>(url: string, body?: unknown, config?: RequestOptions) => request<T>({ ...config, url, method: HttpMethod.PUT, body }),
    delete: <T,>(url: string, config?: RequestOptions) => request<T>({ ...config, url, method: HttpMethod.DELETE }),
    stream,
  };
}
