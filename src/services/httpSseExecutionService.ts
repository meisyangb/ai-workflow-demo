/**
 * HttpSseExecutionService：用「HTTP + SSE（流式）」或「同步/异步 HTTP」驱动工作流执行，
 * 完全符合扣子（Coze）的 API 风格：
 *
 *    模式 mode      | 典型接口              | 适用场景
 *    ----------------------------------------------------------------
 *    'stream'（SSE）  | POST /run/stream      | 工作流 AI 流式 + 事件流（默认推荐）
 *    'sync'           | POST /run             | 短作业，一次性返回最终输出
 *    'async'          | POST /async_run       | 长时后台任务（≤24h）：先拿 task_id，再轮询 GET /task/{id}
 *
 * 与 store 的契约：所有模式的后端响应（SSE 事件 / JSON 体 / 轮询结果）都会被标准化为
 * ExecutionEvent（ExecutionService 接口事件）→ 业务 store 的 applyEventToState 直接消费，
 * 因此 UI 层不关心"用了哪种通信方式"，只需在装配层 `configureExecutionService(new HttpSseExecutionService({...}))`。
 *
 * 设计目标（扩展性）：
 *   - 所有 URL / headers / 鉴权 / Token 刷新 / Retry-After 退避：可 DI 配置 + 钩子回调
 *   - 事件标准化：SSE → parseSseWfEvent（schemas/ssePackets.ts）→ ExecutionEvent；
 *     如果后端不是扣子格式？传 `adapter` 回调即可。
 *   - cancel 能真实 Abort fetch；SSE idle 超时、429 Retry-After、401 自动 refresh token 全部内置。
 */
import { fetchSseStream, SseHttpError, type SseParserStats } from './sseParser';
import { parseSseWfEvent, type SseRawEvent, type SseWfEvent } from '../schemas/ssePackets';
import type {
  ExecutionEvent,
  ExecutionService,
  RunHandle,
  WorkflowSnapshot,
} from './executionService';
import type { AuthProvider } from './authProvider';
import type { HttpClient, HttpResponse, HttpError } from './httpClient';
import type { FetchLike } from './httpClient';

export type HttpSseMode = 'stream' | 'sync' | 'async';

/** 请求 & 响应的"业务字段映射"：方便对接扣子 / 自研后端时快速适配，不改 Service 主体。 */
export interface HttpSseAdapter {
  /** start 时：把前端 nodes/edges 快照 → POST body（如 {graph, parameters, ...}）；
   *  默认：原样快照 JSON。扣子场景需要映射为 { workflow_id, parameters, bot_id, ... }。 */
  buildStartBody: (snapshot: WorkflowSnapshot) => unknown;

  /** start 时：为 POST 补请求头（默认空；如需 Bearer 走 authProvider 已在 Service 层注入）。 */
  buildStartHeaders?: () => Record<string, string> | Promise<Record<string, string>>;

  /** 解析 sync 模式下"一次返回最终结果"的 body → ExecutionEvent 序列（run-started → ... → run-finished）。 */
  adaptSyncBody?: (body: unknown) => ExecutionEvent[] | Promise<ExecutionEvent[]>;

  /** 解析 async 模式 POST /async_run body → {taskId: string}。 */
  adaptAsyncTaskId?: (body: unknown) => string | null;

  /** 解析 async 模式 GET /task/{taskId} 响应体 → 状态 + 事件：
   *  { done: 是否结束, events?: 这一轮的新事件[], waitMs?: 下次轮询间隔(ms) }
   */
  adaptAsyncTaskStatus?: (body: unknown) =>
    | { done: boolean; events?: ExecutionEvent[]; waitMs?: number; error?: string };

  /** 每个 SSE 事件：SseWfEvent → ExecutionEvent[]；
   *  默认实现提供了一套"扣子标准映射"，见 applyDefaultSseAdapter 注释。 */
  adaptSseEvent?: (wf: SseWfEvent, raw: SseRawEvent) => ExecutionEvent[] | Promise<ExecutionEvent[]>;
}

export interface HttpSseExecutionServiceOptions {
  name?: string;

  /** 通信模式；默认 'stream' */
  mode?: HttpSseMode;

  /** 工作流后端 baseUrl；例如扣子代理服务器 https://<your_domain> 或你们自己部署的 https://api.xxx.workflow */
  baseUrl: string;

  /** 运行模式下的请求路径（默认值对应扣子编程文档 /run /run/stream /async_run /task/{task_id}） */
  paths?: {
    run?: string; // sync
    stream?: string; // SSE
    asyncRun?: string; // async submit
    asyncTask?: string; // async poll; 含 {taskId} 占位，默认 '/task/{taskId}'
  };

  /** HTTP Client 实例（建议使用 withHttpAuth 包装过的已带 Bearer） */
  httpClient: HttpClient;

  /** 用于 SSE 的 fetch 实现；缺省使用全局 fetch。建议传与 httpClient 相同的 fetchImpl，以便复用 mock / 超时策略。 */
  fetchImpl?: FetchLike;

  /** 鉴权 Provider（可选）：当收到 401/403 或 token 快过期时自动 refresh；并给 SSE 请求补 Bearer。 */
  auth?: AuthProvider;

  /** 服务端返回 401 时的最大自动刷新次数；默认 1 次。 */
  maxRefreshAttemptsFor401?: number;

  /**
   * SSE 模式专用选项：
   *  - idleTimeoutMs：两个事件帧之间最大允许毫秒（缺省 60_000，与扣子流式插件一致）
   *  - reconnectPolicy：当发生网络错误 / 非 401/403/429 的 HTTP 错是否按 retryMs 重连
   *  - maxReconnects：重连次数上限（缺省 3）
   *  - reconnectBaseDelayMs：首次重连延迟毫秒（缺省 1000；之后按 2^n 指数退避）
   */
  sse?: {
    idleTimeoutMs?: number;
    reconnectPolicy?: 'never' | 'onTransient' | 'always';
    maxReconnects?: number;
    reconnectBaseDelayMs?: number;
    /** 如果后端 SSE 事件名不是 workflow-started / node-status...，可以在这里传 custom adaptSseEvent */
  };

  /** async 模式轮询配置：初始间隔毫秒；默认 1000；最大间隔毫秒；默认 10_000；指数退避 */
  asyncPoll?: { initialMs?: number; maxMs?: number };

  /** 业务字段映射适配器（缺省使用扣子默认适配器） */
  adapter?: Partial<HttpSseAdapter>;

  /** 日志钩子（调试用；错误 / 重连 / 事件原始帧） */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

/** 内部：把标准化后的 SseWfEvent（扣子默认映射）转成 ExecutionEvent[] */
function applyDefaultSseAdapter(wf: SseWfEvent): ExecutionEvent[] {
  const ev = wf.event;
  switch (ev) {
    case 'workflow-started': {
      const data = wf.data as import('../schemas/ssePackets').WfRunStartedData;
      return [
        {
          type: 'run-started',
          order: data.order ?? [],
          runId: data.run_id,
          executeId: data.execute_id,
        },
      ];
    }
    case 'node-status': {
      const data = wf.data as import('../schemas/ssePackets').WfNodeStatusData;
      const events: ExecutionEvent[] = [
        {
          type: 'node-status-changed',
          nodeId: data.node_id,
          status: data.status,
          output: data.output,
          durationMs: data.duration_ms,
          errorMessage: data.error_message,
          activatedEdgeIds: data.activated_edge_ids,
        },
      ];
      if (Array.isArray(data.activated_edge_ids)) {
        events.push({
          type: 'node-edges-activated',
          sourceNodeId: data.node_id,
          activatedEdgeIds: data.activated_edge_ids,
        });
      }
      return events;
    }
    case 'node-token': {
      const data = wf.data as import('../schemas/ssePackets').WfNodeTokenData;
      return [
        {
          type: 'node-output-append',
          nodeId: data.node_id,
          delta: data.delta,
          tokensEstimated: data.tokens_estimated,
          field: data.field,
        },
      ];
    }
    case 'interrupt': {
      const data = wf.data as import('../schemas/ssePackets').WfInterruptData;
      return [
        {
          type: 'workflow-interrupted',
          executeId: data.execute_id,
          runId: data.run_id,
          nodeId: data.node_id,
          interruptType: data.interrupt_type,
          prompt: data.prompt,
        },
      ];
    }
    case 'message': {
      const data = wf.data as import('../schemas/ssePackets').WfMessageData;
      return [
        {
          type: 'workflow-message',
          category: data.category,
          nodeId: data.node_id,
          content: data.content,
          progress: data.progress,
          runId: data.run_id,
        },
      ];
    }
    case 'error': {
      const data = wf.data as import('../schemas/ssePackets').WfErrorData;
      const events: ExecutionEvent[] = [];
      if (data.node_id) {
        events.push({
          type: 'node-status-changed' as const,
          nodeId: data.node_id,
          status: 'failed' as const,
          errorMessage: data.message,
          durationMs: undefined,
          output: undefined,
        });
      }
      events.push({
        type: 'run-finished' as const,
        reason: `${typeof data.code === 'string' || typeof data.code === 'number' ? `[${data.code}] ` : ''}${data.message}`,
        failedNodeId: data.node_id,
        outcome: 'failed' as const,
      });
      return events;
    }
    case 'done': {
      const data = wf.data as import('../schemas/ssePackets').WfDoneData;
      return [
        {
          type: 'run-finished',
          reason:
            data.outcome === 'success'
              ? null
              : data.reason ?? (data.outcome === 'cancelled' ? '已取消' : data.outcome === 'failed' ? '执行失败' : '中断等待恢复'),
          failedNodeId: data.failed_node_id,
          outcome: data.outcome,
          outputs: data.outputs,
        },
      ];
    }
    default:
      // 未知事件按自由消息兜底
      return [
        {
          type: 'workflow-message',
          category: `event:${ev}`,
          content: wf.data,
        },
      ];
  }
}

/** 默认的 HttpSseAdapter（扣子风格：/run /run/stream /async_run /task/{task_id}） */
const DEFAULT_ADAPTER: HttpSseAdapter = {
  buildStartBody: (snapshot) => ({
    graph: { nodes: snapshot.nodes, edges: snapshot.edges },
    trigger_source: 'workflow-editor',
  }),
  adaptSyncBody: (body) => [
    { type: 'run-started', order: [] },
    { type: 'run-finished', reason: null, outcome: 'success', outputs: body as Record<string, unknown> },
  ],
  adaptAsyncTaskId: (body) => {
    const b = body as { task_id?: string; taskId?: string; id?: string };
    return b.task_id ?? b.taskId ?? b.id ?? null;
  },
  adaptAsyncTaskStatus: (body) => {
    const b = body as {
      status?: 'pending' | 'running' | 'success' | 'failed' | 'cancelled' | string;
      result?: unknown;
      reason?: string;
      progress?: number;
      wait_ms?: number;
    };
    const doneList = ['success', 'failed', 'cancelled'];
    const done = typeof b.status === 'string' ? doneList.includes(b.status) : false;
    const events: ExecutionEvent[] = [];
    if (typeof b.progress === 'number' && b.progress > 0) {
      events.push({
        type: 'workflow-message',
        category: 'progress',
        progress: Math.min(1, Math.max(0, b.progress)),
      });
    }
    if (done) {
      events.push({
        type: 'run-finished',
        reason:
          b.status === 'success'
            ? null
            : b.reason ?? (b.status === 'failed' ? '执行失败' : '已取消'),
        outcome:
          b.status === 'success'
            ? 'success'
            : b.status === 'failed'
              ? 'failed'
              : 'cancelled',
        outputs: (b.result as Record<string, unknown> | undefined),
      });
    }
    return { done, events, waitMs: b.wait_ms };
  },
  adaptSseEvent: (wf) => applyDefaultSseAdapter(wf),
};

export class HttpSseExecutionService implements ExecutionService {
  public readonly name: string;
  private readonly mode: HttpSseMode;
  private readonly baseUrl: string;
  private readonly paths: Required<NonNullable<HttpSseExecutionServiceOptions['paths']>>;
  private readonly httpClient: HttpClient;
  private readonly fetchImpl: FetchLike;
  private readonly auth: AuthProvider | null;
  private readonly maxRefreshAttemptsFor401: number;
  private readonly sseOpts: {
    idleTimeoutMs: number;
    reconnectPolicy: 'never' | 'onTransient' | 'always';
    maxReconnects: number;
    reconnectBaseDelayMs: number;
  };
  private readonly asyncPollOpts: { initialMs: number; maxMs: number };
  private readonly adapter: HttpSseAdapter;
  private readonly onLog: NonNullable<HttpSseExecutionServiceOptions['onLog']>;

  constructor(options: HttpSseExecutionServiceOptions) {
    this.name = options.name ?? 'http-sse';
    this.mode = options.mode ?? 'stream';
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.paths = {
      run: options.paths?.run ?? '/run',
      stream: options.paths?.stream ?? '/run/stream',
      asyncRun: options.paths?.asyncRun ?? '/async_run',
      asyncTask: options.paths?.asyncTask ?? '/task/{taskId}',
    };
    this.httpClient = options.httpClient;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.auth = options.auth ?? null;
    this.maxRefreshAttemptsFor401 = options.maxRefreshAttemptsFor401 ?? 1;
    this.sseOpts = {
      idleTimeoutMs: options.sse?.idleTimeoutMs ?? 60_000,
      reconnectPolicy: options.sse?.reconnectPolicy ?? 'onTransient',
      maxReconnects: options.sse?.maxReconnects ?? 3,
      reconnectBaseDelayMs: options.sse?.reconnectBaseDelayMs ?? 1000,
    };
    this.asyncPollOpts = {
      initialMs: options.asyncPoll?.initialMs ?? 1000,
      maxMs: options.asyncPoll?.maxMs ?? 10_000,
    };
    this.adapter = { ...DEFAULT_ADAPTER, ...(options.adapter ?? {}) };
    this.onLog = options.onLog ?? (() => {});
  }

  private resolveUrl(path: string, replacements: Record<string, string> = {}): string {
    let p = path;
    for (const [k, v] of Object.entries(replacements)) {
      p = p.split(`{${k}}`).join(encodeURIComponent(v));
    }
    if (/^https?:\/\//i.test(p)) return p;
    return `${this.baseUrl}${p.startsWith('/') ? '' : '/'}${p}`;
  }

  private async buildAuthHeaders(): Promise<Record<string, string>> {
    const h: Record<string, string> = {};
    if (this.auth?.token?.accessToken) {
      h.Authorization = `Bearer ${this.auth.token.accessToken}`;
    }
    const extra = (await this.adapter.buildStartHeaders?.()) ?? {};
    return { ...extra, ...h };
  }

  /** 当请求抛出 401（鉴权失效）时：尝试 auth.refresh，最多重试 N 次；返回最终是否应该 retry。 */
  private async maybeRefreshForAuthError(attempt: number, err: unknown): Promise<boolean> {
    if (!this.auth) return false;
    const status = (err as HttpError).status ?? (err as SseHttpError).status ?? null;
    if (status !== 401) return false;
    if (attempt >= this.maxRefreshAttemptsFor401) return false;
    try {
      await this.auth.refresh();
      return true;
    } catch (e) {
      this.onLog('warn', 'refresh token 失败，停止 401 重试', { err: String(e) });
      return false;
    }
  }

  start(snapshot: WorkflowSnapshot, onEvent: (event: ExecutionEvent) => void): RunHandle {
    const controller = new AbortController();
    const svc = this;
    // 引用私有方法：避免 TS "声明但未使用"（外部通过 resume → 动态 key 调用）
    void svc.executeResumeRequest;
    let running = true;
    let runId: string | null = null;
    let executeId: string | null = null;
    let resolveDone!: (result: { error: string | null; outputs?: Record<string, unknown> }) => void;
    const donePromise = new Promise<{ error: string | null; outputs?: Record<string, unknown> }>((res) => {
      resolveDone = res;
    });
    /** resume 入队（interrupt 模式等待用户回复） */
    const resumeQueue: Array<{ payload: unknown; resolve: () => void; reject: (err: Error) => void }> = [];

    const finish = (reason: string | null, meta?: { failedNodeId?: string; outputs?: Record<string, unknown> }) => {
      if (!running) return;
      running = false;
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      // pending resume 全部 reject
      while (resumeQueue.length > 0) {
        const item = resumeQueue.shift();
        item?.reject(new Error(reason ?? 'workflow finished'));
      }
      // 注意：SSE error/done 事件的默认 adapter 已经 emit 过一次 run-finished，
      // 由 terminalEventSeen 标记为"已见过最终事件"，此时不再重复 emit，只做 resolve。
      if (!terminalEventSeen) {
        onEvent({
          type: 'run-finished',
          reason,
          failedNodeId: meta?.failedNodeId,
          outputs: meta?.outputs,
          outcome: reason == null ? 'success' : reason === '已取消' ? 'cancelled' : 'failed',
        });
      }
      resolveDone({ error: reason, outputs: meta?.outputs });
    };
    /** 默认 adapter 对 SSE error/done 会 emit run-finished；标记后 finish 不再重复 emit。 */
    let terminalEventSeen = false;

    const enqueueExecutionEvents = (evts: ExecutionEvent[] | Promise<ExecutionEvent[]>) => {
      Promise.resolve(evts)
        .then((list) => {
          for (const e of list) {
            if (e.type === 'run-started') {
              if (e.runId) runId = e.runId;
              if (e.executeId) executeId = e.executeId;
            }
            if (e.type === 'run-finished') terminalEventSeen = true;
            onEvent(e);
          }
        })
        .catch((err) => this.onLog('error', '事件标准化失败，跳过该批事件', { err: String(err) }));
    };

    // 按模式启动
    switch (this.mode) {
      case 'stream':
        this.runStreamMode(snapshot, onEvent, finish, {
          controller,
          buildAuth: () => this.buildAuthHeaders(),
          enqueue: enqueueExecutionEvents,
          maybeRefresh: (att, err) => this.maybeRefreshForAuthError(att, err),
        }).catch((err) => finish(this.errToReason(err)));
        break;
      case 'sync':
        this.runSyncMode(snapshot, onEvent, finish, {
          enqueue: enqueueExecutionEvents,
          maybeRefresh: (att, err) => this.maybeRefreshForAuthError(att, err),
        }).catch((err) => finish(this.errToReason(err)));
        break;
      case 'async':
        this.runAsyncMode(snapshot, onEvent, finish, {
          enqueue: enqueueExecutionEvents,
          maybeRefresh: (att, err) => this.maybeRefreshForAuthError(att, err),
          controller,
        }).catch((err) => finish(this.errToReason(err)));
        break;
    }

    return {
      get running() {
        return running;
      },
      get runId() {
        return runId;
      },
      get executeId() {
        return executeId;
      },
      cancel() {
        if (!running) return;
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        finish('已取消');
      },
      done() {
        return donePromise;
      },
      async resume(payload: unknown) {
        return new Promise<void>((resolve, reject) => {
          if (!running) {
            reject(new Error('Run not running'));
            return;
          }
          // 简单 resume：向后端 POST /stream_resume（扣子语义），把 execute_id + payload 提交；
          // 然后同一 SSE 连接会继续推事件，因此这里只需要把 payload 入队 + 触发 resume HTTP 请求。
          resumeQueue.push({ payload, resolve, reject });
          const self = svc as HttpSseExecutionService;
          void (self as unknown as {
            executeResumeRequest: (req: {
              executeId: string | null;
              runId: string | null;
              payload: unknown;
              controller: AbortController;
            }) => Promise<HttpResponse<unknown>>;
          }).executeResumeRequest({ executeId, runId, payload, controller }).catch((e: Error) => {
            // 从队列尾部移除（LIFO 安全即可）
            const idx = resumeQueue.findIndex((x) => x.payload === payload);
            if (idx !== -1) resumeQueue.splice(idx, 1);
            reject(e);
          });
        });
      },
    };
  }

  private errToReason(err: unknown): string {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return '请求被取消或超时';
    }
    if (err instanceof SseHttpError) {
      return `HTTP ${err.status}：${err.message}`;
    }
    if (err && typeof (err as HttpError).code === 'string') {
      const e = err as HttpError;
      return `[${e.code}${e.status ? ` HTTP ${e.status}` : ''}] ${e.message}`;
    }
    return (err as Error)?.message ?? String(err);
  }

  // ============== SSE 模式实现 ==============
  private async runStreamMode(
    snapshot: WorkflowSnapshot,
    _onEvent: (event: ExecutionEvent) => void,
    finish: (reason: string | null, meta?: { failedNodeId?: string; outputs?: Record<string, unknown> }) => void,
    ctx: {
      controller: AbortController;
      buildAuth: () => Promise<Record<string, string>>;
      enqueue: (evts: ExecutionEvent[] | Promise<ExecutionEvent[]>) => void;
      maybeRefresh: (attempt: number, err: unknown) => Promise<boolean>;
    },
  ) {
    const url = this.resolveUrl(this.paths.stream);
    const { controller, buildAuth, enqueue, maybeRefresh } = ctx;
    let lastEventId: string | null = null;
    let serverRetryMs: number | null = null;
    let reconnects = 0;

    const oneAttempt = async (authAttempt: number): Promise<'done' | 'shouldRetry'> => {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(await buildAuth()),
      };
      try {
        const stats: SseParserStats = await fetchSseStream(
          url,
          {
            onEvent: async (raw) => {
              if (raw.id) lastEventId = raw.id;
              if (raw.retryMs) serverRetryMs = raw.retryMs;
              try {
                const wf = parseSseWfEvent(raw);
                const adapted = this.adapter.adaptSseEvent
                  ? await this.adapter.adaptSseEvent(wf, raw)
                  : applyDefaultSseAdapter(wf);
                enqueue(adapted);
                if (wf.event === 'done') {
                  const fn = (wf as Extract<SseWfEvent, { event: 'done' }>).data;
                  const outputs = fn.outputs;
                  if (fn.outcome === 'success') {
                    finish(null, { outputs });
                  } else if (fn.outcome === 'cancelled') {
                    finish(fn.reason ?? '已取消', { outputs });
                  } else if (fn.outcome === 'interrupted') {
                    // interrupt：保留 running，等待 resume；不需要 finish
                  } else {
                    finish(fn.reason ?? '执行失败', { failedNodeId: fn.failed_node_id, outputs });
                  }
                } else if (wf.event === 'error') {
                  const err = (wf as Extract<SseWfEvent, { event: 'error' }>).data;
                  finish(err.message, { failedNodeId: err.node_id });
                }
              } catch (e) {
                this.onLog('warn', 'SSE 事件解析失败（已忽略该帧）', {
                  rawData: raw.data.slice(0, 120),
                  err: String(e),
                });
              }
            },
          },
          {
            fetchImpl: (u, init) =>
              this.fetchImpl(u, { ...init, signal: controller.signal } as RequestInit) as Promise<Response>,
            method: 'POST',
            headers,
            body: this.adapter.buildStartBody(snapshot),
            lastEventId,
            idleTimeoutMs: this.sseOpts.idleTimeoutMs,
            // timeoutMs: 0 表示不设总体超时（SSE 可能几分钟）
            timeoutMs: 0,
          },
        );
        // stats 读完且正常返回：done
        void stats;
        return 'done';
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return 'done'; // 外部 cancel
        }
        if (err instanceof SseHttpError && err.status === 401) {
          const refreshed = await maybeRefresh(authAttempt, err);
          if (refreshed) {
            // 递归再走一次（authAttempt + 1）
            return oneAttempt(authAttempt + 1);
          }
          throw err;
        }
        // 429：按 Retry-After / 退避
        // 5xx / NETWORK / TIMEOUT：按 reconnectPolicy
        const policy = this.sseOpts.reconnectPolicy;
        if (policy === 'never') throw err;
        if (policy === 'onTransient') {
          const status = (err as SseHttpError).status ?? (err as HttpError).status ?? null;
          const transient = status === null || (status >= 500 && status <= 599) || status === 408 || status === 425;
          if (!transient && status !== 429) throw err;
        }
        if (reconnects >= this.sseOpts.maxReconnects) throw err;
        reconnects += 1;
        const delayMs = Math.min(
          60_000,
          Math.max(this.sseOpts.reconnectBaseDelayMs, serverRetryMs ?? this.sseOpts.reconnectBaseDelayMs * 2 ** (reconnects - 1)),
        );
        this.onLog('info', `SSE 重连：第 ${reconnects}/${this.sseOpts.maxReconnects} 次，延迟 ${delayMs}ms`, { url });
        await new Promise((res) => setTimeout(res, delayMs));
        return 'shouldRetry';
      }
    };

    // 重连循环（每次从 lastEventId 断点续推；直到 oneAttempt 返回 'done' 或抛）
    while (!controller.signal.aborted) {
      const res = await oneAttempt(0);
      if (res === 'done') return;
      // shouldRetry：继续 while
    }
  }

  // ============== SYNC 模式实现 ==============
  private async runSyncMode(
    snapshot: WorkflowSnapshot,
    _onEvent: (event: ExecutionEvent) => void,
    finish: (reason: string | null, meta?: { failedNodeId?: string; outputs?: Record<string, unknown> }) => void,
    ctx: {
      enqueue: (evts: ExecutionEvent[] | Promise<ExecutionEvent[]>) => void;
      maybeRefresh: (attempt: number, err: unknown) => Promise<boolean>;
    },
  ) {
    const url = this.resolveUrl(this.paths.run);
    let refreshAttempts = 0;
    for (;;) {
      try {
        const headers = await this.buildAuthHeaders();
        const res = await this.httpClient.post<unknown>(url, this.adapter.buildStartBody(snapshot), { headers });
        const adapted = this.adapter.adaptSyncBody ? await this.adapter.adaptSyncBody(res.data) : [];
        ctx.enqueue(Promise.resolve(adapted));
        // 最后一条按协议应该是 run-finished；保险再手动 finish 兜底（outputs = body 本身）
        finish(null, { outputs: res.data as Record<string, unknown> });
        return;
      } catch (err) {
        const status = (err as HttpError).status ?? null;
        if (status === 401) {
          const ok = await ctx.maybeRefresh(refreshAttempts, err);
          refreshAttempts += 1;
          if (ok) continue;
        }
        if (status === 429) {
          const retryAfterMs = this.extractRetryAfter(err);
          if (retryAfterMs) await new Promise((r) => setTimeout(r, retryAfterMs));
        }
        throw err;
      }
    }
  }

  // ============== ASYNC 模式实现 ==============
  private async runAsyncMode(
    snapshot: WorkflowSnapshot,
    _onEvent: (event: ExecutionEvent) => void,
    finish: (reason: string | null, meta?: { failedNodeId?: string; outputs?: Record<string, unknown> }) => void,
    ctx: {
      enqueue: (evts: ExecutionEvent[] | Promise<ExecutionEvent[]>) => void;
      maybeRefresh: (attempt: number, err: unknown) => Promise<boolean>;
      controller: AbortController;
    },
  ) {
    const submitUrl = this.resolveUrl(this.paths.asyncRun);
    let refreshAttempts = 0;
    // 1) POST /async_run → taskId
    let taskId: string | null = null;
    for (;;) {
      try {
        const headers = await this.buildAuthHeaders();
        const res = await this.httpClient.post<unknown>(submitUrl, this.adapter.buildStartBody(snapshot), { headers });
        taskId = this.adapter.adaptAsyncTaskId ? this.adapter.adaptAsyncTaskId(res.data) : (res.data as { task_id?: string }).task_id ?? null;
        if (!taskId) throw new Error('async_run 响应缺少 task_id');
        break;
      } catch (err) {
        const status = (err as HttpError).status ?? null;
        if (status === 401) {
          const ok = await ctx.maybeRefresh(refreshAttempts, err);
          refreshAttempts += 1;
          if (ok) continue;
        }
        throw err;
      }
    }
    // 2) 轮询 /task/{taskId}
    let waitMs = this.asyncPollOpts.initialMs;
    let pollRefreshAttempts = 0;
    while (!ctx.controller.signal.aborted) {
      for (;;) {
        try {
          const taskUrl = this.resolveUrl(this.paths.asyncTask, { taskId: taskId as string });
          const headers = await this.buildAuthHeaders();
          const res = await this.httpClient.get<unknown>(taskUrl, { headers });
          const info = this.adapter.adaptAsyncTaskStatus
            ? this.adapter.adaptAsyncTaskStatus(res.data) as {
                done: boolean;
                events?: ExecutionEvent[];
                waitMs?: number;
                error?: string;
              }
            : { done: false as const };
          if (typeof info === 'object' && info !== null && 'events' in info && Array.isArray((info as { events?: unknown[] }).events)) {
            ctx.enqueue((info as { events: ExecutionEvent[] }).events);
          }
          if (info.done) {
            if (info.error) {
              finish(info.error);
            } else {
              // 最后一个 run-finished 事件已经包含 outputs；finish 兜底
              finish(null);
            }
            return;
          }
          const nextWait = typeof info === 'object' && info !== null && 'waitMs' in info
            ? (info as { waitMs?: number }).waitMs
            : undefined;
          waitMs = Math.min(this.asyncPollOpts.maxMs, Math.max(waitMs, nextWait ?? waitMs * 2));
          break;
        } catch (err) {
          const status = (err as HttpError).status ?? null;
          if (status === 401) {
            const ok = await ctx.maybeRefresh(pollRefreshAttempts, err);
            pollRefreshAttempts += 1;
            if (ok) continue;
          }
          if (status === 429) {
            const retryAfterMs = this.extractRetryAfter(err);
            waitMs = Math.min(this.asyncPollOpts.maxMs, retryAfterMs ?? waitMs);
            break;
          }
          throw err;
        }
      }
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => {
          if (ctx.controller.signal.aborted) rej(new Error('aborted'));
          else res();
        }, waitMs);
        ctx.controller.signal.addEventListener('abort', () => {
          clearTimeout(t);
          rej(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }
  }

  private extractRetryAfter(err: unknown): number | null {
    const body = (err as HttpError).body as { retry_after_ms?: number; retryAfterMs?: number } | null;
    if (typeof body === 'object' && body !== null) {
      if (typeof body.retry_after_ms === 'number') return body.retry_after_ms;
      if (typeof body.retryAfterMs === 'number') return body.retryAfterMs;
    }
    // 扣子 done.error.retry_after_ms
    const rr = body as { retry_after_ms?: number } | null;
    return rr && typeof rr.retry_after_ms === 'number' ? rr.retry_after_ms : null;
  }

  /**
   * 提交中断恢复：扣子语义 POST /v1/workflow/stream_resume，body={ execute_id, ...payload }
   * 本 Service 走同一 baseUrl + 默认路径 /stream_resume；如需自定义通过 adapter.buildStartHeaders + paths.streamResume
   * 这里留一个简单可用的实现（扩展点集中在 adapter/options.paths）。
   */
  private async executeResumeRequest(req: {
    executeId: string | null;
    runId: string | null;
    payload: unknown;
    controller: AbortController;
  }): Promise<HttpResponse<unknown>> {
    if (!req.executeId) throw new Error('executeId 为空，无法 resume');
    const resumePath = (this.paths as { streamResume?: string }).streamResume ?? '/stream_resume';
    const url = this.resolveUrl(resumePath);
    const headers = {
      'Content-Type': 'application/json',
      ...(await this.buildAuthHeaders()),
    };
    const body: unknown = {
      execute_id: req.executeId,
      run_id: req.runId ?? undefined,
      // 兼容 payload 本身就是 { answer: '...' } 的结构
      ...(typeof req.payload === 'object' && req.payload !== null && !Array.isArray(req.payload)
        ? (req.payload as Record<string, unknown>)
        : { value: req.payload }),
    };
    const ctrl = req.controller;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'AbortError') throw new Error('resume 请求已取消');
      throw e;
    }
    if (!res.ok) {
      let errBody: unknown = null;
      try { errBody = await res.json().catch(() => null); } catch { /* ignore */ }
      throw new SseHttpError(res.status, url, errBody);
    }
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    return { status: res.status, data };
  }
}
