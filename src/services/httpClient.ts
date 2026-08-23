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
}

export interface HttpClient {
  request<T>(config: HttpRequestConfig): Promise<HttpResponse<T>>;
  get<T>(url: string, config?: RequestOptions): Promise<HttpResponse<T>>;
  post<T>(url: string, body?: unknown, config?: RequestOptions): Promise<HttpResponse<T>>;
  put<T>(url: string, body?: unknown, config?: RequestOptions): Promise<HttpResponse<T>>;
  delete<T>(url: string, config?: RequestOptions): Promise<HttpResponse<T>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;

function joinUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/** 网络错误 / 超时 / 5xx 可重试；4xx 属于请求方错误，重试无意义 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.code === HttpErrorCode.BAD_STATUS) return (err.status ?? 0) >= 500;
  return err.code === HttpErrorCode.NETWORK_ERROR || err.code === HttpErrorCode.TIMEOUT;
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
  } = options;

  /** 单次请求（不含重试） */
  async function requestOnce<T>(
    config: HttpRequestConfig,
    fullUrl: string,
    timeout: number,
  ): Promise<HttpResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetchImpl(fullUrl, {
        method: config.method ?? HttpMethod.GET,
        headers: {
          ...(config.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...defaultHeaders,
          ...config.headers,
        },
        body: config.body !== undefined ? JSON.stringify(config.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'AbortError') {
        throw new HttpError(HttpErrorCode.TIMEOUT, `请求超时（${timeout}ms）：${fullUrl}`, fullUrl);
      }
      throw new HttpError(HttpErrorCode.NETWORK_ERROR, `网络错误：${(err as Error).message}`, fullUrl);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null; // 错误体非 JSON 时忽略
      }
      throw new HttpError(HttpErrorCode.BAD_STATUS, `HTTP ${res.status}：${fullUrl}`, fullUrl, res.status, body);
    }

    if (res.status === 204) {
      return { status: res.status, data: null as T };
    }

    const text = await res.text();
    if (!text) {
      return { status: res.status, data: null as T };
    }
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      throw new HttpError(HttpErrorCode.PARSE_ERROR, `响应体不是合法 JSON：${fullUrl}`, fullUrl, res.status);
    }
  }

  async function request<T>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
    const fullUrl = joinUrl(baseUrl, config.url);
    const timeout = config.timeoutMs ?? timeoutMs;
    const maxAttempts = 1 + (config.retries ?? retries);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await requestOnce<T>(config, fullUrl, timeout);
      } catch (err) {
        if (attempt === maxAttempts - 1 || !isRetryable(err)) throw err;
        await sleep(retryBaseDelayMs * 2 ** attempt);
      }
    }
    // 循环内必 return / throw，此处仅为满足类型系统
    throw new HttpError(HttpErrorCode.NETWORK_ERROR, `请求失败：${fullUrl}`, fullUrl);
  }

  return {
    request,
    get: (url, config) => request({ ...config, url, method: HttpMethod.GET }),
    post: (url, body, config) => request({ ...config, url, method: HttpMethod.POST, body }),
    put: (url, body, config) => request({ ...config, url, method: HttpMethod.PUT, body }),
    delete: (url, config) => request({ ...config, url, method: HttpMethod.DELETE }),
  };
}
