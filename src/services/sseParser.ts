/**
 * SSE（Server-Sent Events）流式解析器 + 发起入口。
 *
 * 为什么不用浏览器原生 `new EventSource(url)`？
 *   1. EventSource 只支持 GET，不能自定义 Header（Bearer Token 只能放 URL 参数，容易泄露）；
 *   2. 对响应状态码 / 响应头错误不可控（401/429 EventSource 直接重连，没法按错误码走 auth refresh）；
 *   3. 扣子服务端会返回非 UTF-8 或分片数据 JSON 跨包的场景，需要我们自己做文本编解码与帧拼装。
 *
 * 因此本模块采用 `fetch + ReadableStream + TextDecoder` 手写 SSE 解析：
 *   - 支持 POST/任意方法 + 任意 Headers（含 Authorization）
 *   - 按 `\n\n` 分事件帧，自动把多行 data / id / event / retry 字段合并为一个 SseRawEvent
 *   - `idleTimeoutMs`：如 "两个事件帧之间 > 60s 没有任何字节"，主动抛 IdleTimeout（匹配扣子对"流式插件每包间隔 60s"的要求）
 *   - `Last-Event-ID`：自动记录上一个 event.id，重连时可作为请求头（调用方通过 `createParser().lastEventId` 取）
 *   - 支持 AbortController 取消（调用方 cancel() → fetch abort → stream cancel → 解析循环抛出 AbortError）
 *   - UTF-8 分片边界处理：TextDecoder 用 streaming=true，保证多字节字符跨 byte chunk 时不丢字节
 *   - 分帧同时给出 `retryMs`：服务端可以通过 `retry: 3000` 动态调整重连间隔
 */
import type { SseRawEvent } from '../schemas/ssePackets';

export interface SseParserCallbacks {
  /** 每次解析出一个完整事件帧就调用一次（含 event: message / interrupt / done / error 等） */
  onEvent?: (raw: SseRawEvent) => void | Promise<void>;
  /** 空闲超时触发：两次事件帧的时间戳差超过 idleTimeoutMs */
  onIdleTimeout?: (idleMs: number) => void | Promise<void>;
  /** 解析循环读取到新一批字节时的钩子（用于写入 HTTP body 原始日志、计算吞吐） */
  onBytesChunk?: (bytes: Uint8Array, offset: number) => void | Promise<void>;
  /** 响应头就绪（status+headers）；返回 false 可提前中止读取（如 401 不读 body，由上层抛错） */
  onResponseHeaders?: (res: { status: number; headers: Headers; url: string }) => boolean | void;
}

export interface SseParserOptions {
  /** 空闲超时毫秒（缺省 = 60_000ms，与扣子流式插件约束一致） */
  idleTimeoutMs?: number;
  /** 单条 data 行的最大字符数（防御：服务端打挂一条无限帧）；缺省 262_144 = 256KB */
  maxEventBytes?: number;
  /** 文本编码（缺省 utf-8） */
  encoding?: string;
  /** 起始 lastEventId（用于断线续推） */
  lastEventId?: string | null;
}

/** SSE 解析结果：循环完整读完 body 后返回统计信息 */
export interface SseParserStats {
  /** 解析出的事件帧数（不含注释行） */
  events: number;
  /** 解析消耗的字节总数（按原始流 chunk 统计） */
  bytesRead: number;
  /** 最后一个事件 ID（如果有） */
  lastEventId: string | null;
  /** 服务端通过 retry: 字段设置的重连间隔（如果有多个，以最后一条为准）；未收到为 null */
  retryMs: number | null;
}

export class SseIdleTimeoutError extends Error {
  constructor(public readonly idleMs: number, message?: string) {
    super(message ?? `SSE 空闲超时（${idleMs}ms 未收到新数据帧）`);
    this.name = 'SseIdleTimeoutError';
  }
}

/**
 * 纯流式解析循环：给定一个"已打开的 Response body ReadableStream<Uint8Array>"，
 * 消费到 body 完成，逐帧回调 `onEvent`，返回累计统计。
 *
 * 纯函数、可单测：不依赖全局 fetch、没有网络 I/O；
 * 单测里直接构造 ReadableStream.from(asyncIterator) 喂假数据即可。
 */
export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: SseParserCallbacks,
  options: SseParserOptions = {},
): Promise<SseParserStats> {
  const {
    idleTimeoutMs = 60_000,
    maxEventBytes = 256 * 1024,
    encoding = 'utf-8',
    lastEventId: initId = null,
  } = options;

  const decoder = new TextDecoder(encoding, { fatal: false });
  const reader = stream.getReader();

  /** 当前正在拼的事件帧的各字段 */
  let bufId: string | null = initId;
  let bufEvent: string | null = null;
  let bufDataLines: string[] = [];
  let bufRetry: number | null = null;
  /** 最近一次 emit 成功后的事件 ID（stats.lastEventId 使用，避免 emitFrame 末尾 bufId=null 把结果覆盖） */
  let emittedId: string | null = initId;
  /** 最近一次 emit 成功后的 retryMs */
  let emittedRetryMs: number | null = null;
  /** 原始偏移（字节数，每 consume 一批就累加） */
  let offset = 0;
  /** 文本行缓冲区：处理 "\n" 切分时被 chunk 截断的半行 */
  let lineBuf = '';
  /** 事件帧起始偏移（字符级估算，按上次完成后行缓冲的位置）—— 仅调试用 */
  let frameOffset = 0;
  /** 事件计数 */
  let eventCount = 0;
  /** 最近一条事件帧的完成时间（毫秒） */
  let lastFrameAtMs = Date.now();
  /** 空闲超时触发标记：由 timer 置 true，reader.read() 返回后立即抛。
   *  不必依赖 reader.cancel 把 reason 透传到 read reject，避免不同 ReadableStream polyfill 行为差异。 */
  let idleExpired: { idleMs: number } | null = null;
  /** 空闲超时 timer（每读到一批字节 reset；每完成一帧 reset） */
  let idleTimer: ReturnType<typeof setTimeout> | null = scheduleIdleCheck();

  function scheduleIdleCheck(): ReturnType<typeof setTimeout> | null {
    if (idleTimeoutMs <= 0) return null;
    return setTimeout(() => {
      const idle = Date.now() - lastFrameAtMs;
      if (idle >= idleTimeoutMs) {
        idleExpired = { idleMs: idle };
        void Promise.resolve(callbacks.onIdleTimeout?.(idle)).catch(() => {});
        // 尽量取消 reader，释放底层连接；即使 cancel reason 未透传到 read reject，
        // 下一次循环会在 read() 返回后检查 idleExpired 并抛错。
        void reader.cancel(new SseIdleTimeoutError(idle)).catch(() => {});
      } else {
        idleTimer = scheduleRel(Math.max(1, idleTimeoutMs - idle));
      }
    }, idleTimeoutMs);
  }
  function scheduleRel(ms: number) {
    return setTimeout(() => {
      const idle = Date.now() - lastFrameAtMs;
      if (idle >= idleTimeoutMs) {
        idleExpired = { idleMs: idle };
        void Promise.resolve(callbacks.onIdleTimeout?.(idle)).catch(() => {});
        void reader.cancel(new SseIdleTimeoutError(idle)).catch(() => {});
      } else {
        idleTimer = scheduleRel(Math.max(1, idleTimeoutMs - idle));
      }
    }, ms);
  }
  function resetIdle() {
    lastFrameAtMs = Date.now();
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = scheduleIdleCheck();
    }
  }
  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  /** 把当前 buf* 清空 → emit 一个 SseRawEvent */
  function emitFrame(): void {
    // 空事件（只有空行/注释行）：跳过计数但重置 buffer
    const hasAny = bufId !== null || bufEvent !== null || bufDataLines.length > 0 || bufRetry !== null;
    if (!hasAny) {
      // 注释行也算一次活跃（服务端发 ":keep-alive\n\n" 心跳），重置空闲
      resetIdle();
      return;
    }
    const raw: SseRawEvent = {
      id: bufId,
      event: bufEvent ?? 'message',
      data: bufDataLines.join('\n'),
      retryMs: bufRetry,
      offset: frameOffset,
    };
    if (raw.id !== null) emittedId = raw.id;
    if (raw.retryMs !== null) emittedRetryMs = raw.retryMs;
    eventCount += 1;
    resetIdle();
    void Promise.resolve(callbacks.onEvent?.(raw)).catch((err) => {
      // onEvent 抛错不要阻塞解析流；上层应通过 onEvent 内部 try/catch 记录。
      console.error('[sseParser] onEvent 回调抛错（已忽略）：', err);
    });
    // reset
    bufId = null;
    bufEvent = null;
    bufDataLines = [];
    bufRetry = null;
    frameOffset = offset;
  }

  /** 处理一行（已经去掉末尾 \r\n；":" 开头是注释） */
  function handleLine(line: string): void {
    if (line === '') {
      emitFrame();
      return;
    }
    if (line.startsWith(':')) return; // 注释 / keep-alive ping，忽略整行
    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    // 字段后如果是 ": " 开头的 value，多跳一个空格；如果是":"直接跟值则不跳
    let value: string;
    if (colonIdx === -1) {
      value = '';
    } else {
      const rest = line.slice(colonIdx + 1);
      value = rest.startsWith(' ') ? rest.slice(1) : rest;
    }
    switch (field) {
      case 'id':
        // SSE 规范：id 中不能含 NUL；含有则忽略整条
        if (!value.includes('\0')) bufId = value;
        break;
      case 'event':
        bufEvent = value;
        break;
      case 'data':
        if (bufDataLines.length === 0 && value.length > maxEventBytes) {
          // 防御：单个 data 字段就超上限，截断并加警告标记
          bufDataLines.push(value.slice(0, maxEventBytes) + '…');
        } else {
          bufDataLines.push(value);
        }
        break;
      case 'retry': {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) bufRetry = Math.floor(n);
        break;
      }
      default:
        // 未知字段按规范忽略
        break;
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (idleExpired) throw new SseIdleTimeoutError((idleExpired as { idleMs: number }).idleMs);
      if (done) break;
      const chunk = value as Uint8Array | undefined;
      if (chunk && chunk.length > 0) {
        callbacks.onBytesChunk?.(chunk, offset);
        offset += chunk.length;
        resetIdle();
        // streaming=true：保留跨 chunk 的部分多字节序列
        const text = decoder.decode(chunk, { stream: true });
        if (text.length === 0) continue;
        // 切行：按 \n；注意 SSE 规范用 \n 作为行分隔，但也兼容 \r\n（我们在 handleLine 之前 strip \r）
        let head = 0;
        for (let i = 0; i < text.length; i++) {
          if (text.charCodeAt(i) === 10 /* \n */) {
            let piece = text.slice(head, i);
            if (piece.charCodeAt(piece.length - 1) === 13) piece = piece.slice(0, -1); // strip \r
            head = i + 1;
            handleLine(lineBuf + piece);
            lineBuf = '';
          }
        }
        if (head < text.length) {
          let piece = text.slice(head);
          if (piece.charCodeAt(piece.length - 1) === 13) piece = piece.slice(0, -1);
          lineBuf += piece;
        }
      }
    }
    // 流结束：flush
    if (lineBuf.length > 0) {
      handleLine(lineBuf);
      lineBuf = '';
    }
    emitFrame(); // flush 最后一个未分隔的事件（服务端有时会省掉末尾空行）
  } finally {
    clearIdle();
    // 关闭 reader；如果因为 Abort/IdleCancel 已关，releaseLock 安全
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    // flush decoder 尾部剩余字节
    const tail = decoder.decode();
    if (tail.length > 0) {
      // tail 一般是结尾空串；若有行则尝试 handleLine
      const lines = tail.split('\n');
      for (const l of lines) handleLine(l.endsWith('\r') ? l.slice(0, -1) : l);
      emitFrame();
    }
  }

  return {
    events: eventCount,
    bytesRead: offset,
    lastEventId: emittedId,
    retryMs: emittedRetryMs,
  };
}

/**
 * 顶层便利函数：发起 fetch + 调用 parseSseStream 完成 SSE 消费。
 *
 * - 返回 stats；遇到非 2xx 会通过 `onResponseHeaders` 钩子让上层决定，
 *   然后抛带 status/body 的 HttpError（与 httpClient 共享错误语义）。
 * - fetch / Headers 均支持注入（tests 用 FetchLike）。
 */
export interface FetchSseOptions extends SseParserOptions {
  method?: 'GET' | 'POST' | string;
  headers?: Record<string, string>;
  body?: unknown; // object 自动 JSON；string/BufferSource/Blob 原样
  /** 可注入的 fetch 实现（与 httpClient FetchLike 兼容） */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** 总请求超时（毫秒），0 表示不设；缺省 0 —— 因为 SSE 常几分钟长 */
  timeoutMs?: number;
  /** 上次 lastEventId：会自动写入 Last-Event-ID header；若 headers 里已有同名则以 headers 为准 */
  lastEventId?: string | null;
  /** 是否自动追加 Accept: text/event-stream（默认 true） */
  autoAccept?: boolean;
}

export class SseHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `SSE 请求失败：HTTP ${status}（${url}）`);
    this.name = 'SseHttpError';
  }
}

export async function fetchSseStream(
  url: string,
  callbacks: SseParserCallbacks,
  options: FetchSseOptions = {},
): Promise<SseParserStats> {
  const {
    method = 'POST',
    headers = {},
    body,
    fetchImpl = fetch,
    timeoutMs = 0,
    lastEventId = null,
    autoAccept = true,
    ...parserOpts
  } = options;

  const ctrl = new AbortController();
  const timeoutTimer =
    timeoutMs > 0 ? setTimeout(() => ctrl.abort(new DOMException('SSE timeout', 'TimeoutError')), timeoutMs) : null;

  const reqHeaders: Record<string, string> = { ...(autoAccept ? { Accept: 'text/event-stream' } : {}), ...headers };
  if (lastEventId && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'last-event-id')) {
    reqHeaders['Last-Event-ID'] = lastEventId;
  }

  let reqBody: BodyInit | undefined;
  if (body !== undefined) {
    if (typeof body === 'string' || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)
      || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body as object))
      || (typeof Blob !== 'undefined' && body instanceof Blob)) {
      reqBody = body as BodyInit;
    } else {
      reqBody = JSON.stringify(body);
      if (!Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
        reqHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: reqHeaders,
      body: reqBody,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    const name = (err as Error)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new SseIdleTimeoutError(timeoutMs ?? 0, `SSE 请求总超时（${timeoutMs ?? 0}ms）`);
    }
    throw err;
  }
  if (timeoutTimer) clearTimeout(timeoutTimer);

  const goOn = callbacks.onResponseHeaders?.({ status: res.status, headers: res.headers, url: res.url || url });
  if (goOn === false) {
    // 上层要求中止（如 401 要去 refresh token 再重试，不读 body）
    try { await res.body?.cancel(); } catch { /* ignore */ }
    let bodyJson: unknown = null;
    try { bodyJson = await res.clone().text().then((t) => t ? JSON.parse(t) : null).catch(() => null); } catch { /* ignore */ }
    throw new SseHttpError(res.status, res.url || url, bodyJson);
  }
  if (!res.ok || !res.body) {
    let bodyJson: unknown = null;
    try { bodyJson = await res.clone().text().then((t) => t ? JSON.parse(t) : null).catch(() => null); } catch { /* ignore */ }
    throw new SseHttpError(res.status, res.url || url, bodyJson);
  }

  return parseSseStream(res.body, callbacks, parserOpts);
}
