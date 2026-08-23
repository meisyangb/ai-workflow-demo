/**
 * WebSocketClient 抽象层
 *
 * 对应架构设计中的 WebSocket 通信组件：
 * - connect / disconnect / send（支持对象，自动 JSON 序列化）
 * - 订阅式事件回调：connected / disconnected / message / error
 * - 断线自动重连（指数退避 + 最大重试次数上限）
 * - 心跳超时（收到 pong/任意消息即重置）
 * - WebSocket 构造函数依赖注入，便于 node 环境单测（无真实网络）
 */

// ===== 枚举 =====
export const WsState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSING: 'closing',
  CLOSED: 'closed',
  RECONNECT_WAIT: 'reconnect_wait', // 断线后等待下一次重连
} as const;
export type WsState = (typeof WsState)[keyof typeof WsState];

export const WsCloseCode = {
  /** 正常关闭 */
  NORMAL: 1000,
  /** 客户端主动取消重连 */
  GOING_AWAY: 1001,
  /** 心跳超时（客户端主动关闭） */
  UNEXPECTED_CONDITION: 1011,
} as const;

// ===== 事件类型（discriminated union）=====
export interface WsConnectedEvent {
  type: 'connected';
  /** 第几次连接成功（首连 = 1，重连递增） */
  attempt: number;
}

export interface WsDisconnectedEvent {
  type: 'disconnected';
  /** 是否会自动重连 */
  willReconnect: boolean;
  /** 关闭代码（原生 WebSocket CloseEvent.code） */
  code: number;
  /** 关闭原因 */
  reason?: string;
}

export interface WsMessageEvent<T = unknown> {
  type: 'message';
  /** 原始消息字符串 / ArrayBuffer */
  raw: string;
  /** 如果原始消息是合法 JSON，这里自动解析好；否则为 undefined */
  data?: T;
}

export interface WsErrorEvent {
  type: 'error';
  /** 可读错误描述 */
  message: string;
  /** 底层原始错误（类型为 unknown，避免绑定到 DOM Event） */
  raw?: unknown;
}

export type WsEvent = WsConnectedEvent | WsDisconnectedEvent | WsMessageEvent | WsErrorEvent;

// ===== WebSocket 原生接口最小子集（用于依赖注入）=====
export interface WsLikeCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type WsLikeListener = (...args: unknown[]) => void;

/** 与浏览器 WebSocket / ws 包兼容的最小子集 */
export interface WsLike {
  readonly readyState: number; // 0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  // 事件监听（addEventListener 模式，兼容浏览器 WebSocket 与 MockSocket）
  addEventListener(type: 'open', listener: WsLikeListener): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: WsLikeListener): void;
  addEventListener(type: 'close', listener: (ev: WsLikeCloseEvent) => void): void;
  removeEventListener(type: string, listener: WsLikeListener): void;
}

export type WsLikeConstructor = (url: string, protocols?: string | string[]) => WsLike;

export interface WebSocketClientOptions {
  /** 服务端 URL */
  url: string;
  /** WebSocket 子协议 */
  protocols?: string | string[];
  /** 最大自动重连次数（0 = 不重连）；默认 5 */
  maxReconnectAttempts?: number;
  /** 重连基础延迟（ms），按 base * 2^attempt 指数退避；默认 1000 */
  reconnectBaseDelayMs?: number;
  /** 最大重连延迟上限（ms），退避不再增长超过此值；默认 30_000 */
  reconnectMaxDelayMs?: number;
  /** 心跳间隔（ms）：超过该间隔未收到任何消息 / pong，主动认为断线并触发重连；0 = 关闭心跳；默认 30_000 */
  heartbeatIntervalMs?: number;
  /** 可注入的 WebSocket 构造函数（单测用）；默认浏览器全局 WebSocket */
  wsFactory?: WsLikeConstructor;
  /** 可注入的 setTimeout/clearTimeout（单测用）；默认全局 setTimeout/clearTimeout */
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * 订阅返回句柄：调用 unsubscribe() 取消订阅
 */
export interface WsSubscription {
  unsubscribe(): void;
}

export interface WebSocketClient {
  /** 当前状态 */
  readonly state: WsState;
  /** 已尝试重连次数（首连不算；成功连接后归零） */
  readonly reconnectAttempts: number;

  /** 连接（幂等：已连接/连接中直接返回） */
  connect(): void;
  /** 主动断开（不会自动重连） */
  disconnect(reason?: string): void;
  /**
   * 发送字符串或对象：
   * - object 自动 JSON.stringify
   * - 若当前未连接，返回 false（调用方自行决定缓存/丢弃策略，本层不排队）
   */
  send(payload: unknown): boolean;

  /** 订阅事件；返回取消订阅句柄 */
  subscribe(listener: (event: WsEvent) => void): WsSubscription;
}

/** 原生 WebSocket readyState 映射 */
export const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

// ===== 工厂函数实现 =====
export function createWebSocketClient(options: WebSocketClientOptions): WebSocketClient {
  const {
    url,
    protocols,
    maxReconnectAttempts = 5,
    reconnectBaseDelayMs = 1000,
    reconnectMaxDelayMs = 30_000,
    heartbeatIntervalMs = 30_000,
    wsFactory,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = options;

  const wsCtor: WsLikeConstructor =
    wsFactory ?? ((globalThis.WebSocket as unknown) as WsLikeConstructor);

  // ===== 内部可变状态 =====
  let state: WsState = WsState.IDLE;
  let reconnectAttempts = 0;
  /** 第几次连接（首连 = 1，每次重新生成 socket 递增） */
  let connectCount = 0;
  let socket: WsLike | null = null;
  /** 自动重连的定时器 id */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 心跳检查定时器 id */
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否主动断开（主动 disconnect 的情况下，close 时不再重连） */
  let manualClose = false;
  /** 订阅者集合 */
  const listeners = new Set<(event: WsEvent) => void>();

  // ===== 工具：对外只读属性通过 getter 暴露 =====
  const emit = (event: WsEvent) => {
    for (const fn of listeners) fn(event);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer !== null) {
      clearTimeoutImpl(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const resetHeartbeat = () => {
    clearHeartbeatTimer();
    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setTimeoutImpl(onHeartbeatTimeout, heartbeatIntervalMs);
    }
  };

  const onHeartbeatTimeout = () => {
    emit({
      type: 'error',
      message: `心跳超时（${heartbeatIntervalMs}ms 未收到消息），主动关闭并准备重连`,
    });
    // 关闭当前 socket；close handler 会根据 manualClose=false 进入重连分支
    try {
      socket?.close(WsCloseCode.UNEXPECTED_CONDITION, 'heartbeat_timeout');
    } catch {
      // ignore
    }
  };

  const scheduleReconnect = () => {
    if (manualClose) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
      state = WsState.CLOSED;
      emit({ type: 'disconnected', willReconnect: false, code: -1, reason: '超过最大重连次数' });
      return;
    }
    state = WsState.RECONNECT_WAIT;
    const attempt = reconnectAttempts + 1;
    const rawDelay = reconnectBaseDelayMs * 2 ** (attempt - 1);
    const delay = Math.min(rawDelay, reconnectMaxDelayMs);
    reconnectTimer = setTimeoutImpl(() => {
      reconnectAttempts = attempt;
      openSocket();
    }, delay);
  };

  const openSocket = () => {
    if (manualClose) return;
    state = WsState.CONNECTING;
    connectCount += 1;
    const ws: WsLike = wsCtor(url, protocols);
    socket = ws;

    const currentCount = connectCount;

    const onOpen = () => {
      // 过期 socket 事件忽略（比如重连时旧 socket 突然 open 的竞态）
      if (currentCount !== connectCount || socket !== ws) return;
      state = WsState.OPEN;
      // 成功后重连计数器归零
      reconnectAttempts = 0;
      resetHeartbeat();
      emit({ type: 'connected', attempt: currentCount });
    };

    const onMessage = (ev: { data: unknown }) => {
      if (currentCount !== connectCount || socket !== ws) return;
      resetHeartbeat();
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = undefined;
      }
      emit({ type: 'message', raw, data });
    };

    const onError = () => {
      if (currentCount !== connectCount || socket !== ws) return;
      // 原生 error event 没有可读信息，发送一个通用错误事件
      emit({ type: 'error', message: 'WebSocket 底层错误（见浏览器控制台详情）' });
    };

    const onClose = (ev: WsLikeCloseEvent) => {
      if (currentCount !== connectCount) return;
      clearHeartbeatTimer();
      if (socket === ws) socket = null;
      // 如果是手动关闭：直接转到 CLOSED 且不重连
      if (manualClose) {
        state = WsState.CLOSED;
        emit({
          type: 'disconnected',
          willReconnect: false,
          code: ev.code,
          reason: ev.reason,
        });
        return;
      }
      state = WsState.CLOSED;
      // 通知已断线
      const willReconnect = reconnectAttempts + 1 <= maxReconnectAttempts;
      emit({
        type: 'disconnected',
        willReconnect,
        code: ev.code,
        reason: ev.reason,
      });
      if (willReconnect) scheduleReconnect();
    };

    ws.addEventListener('open', onOpen as WsLikeListener);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError as WsLikeListener);
    ws.addEventListener('close', onClose);
  };

  // ===== 对外 API =====
  const api: WebSocketClient = {
    get state() {
      return state;
    },
    get reconnectAttempts() {
      return reconnectAttempts;
    },

    connect() {
      // 幂等：正在连 / 已连 / 等待重连时不重复启动
      if (state === WsState.CONNECTING || state === WsState.OPEN || state === WsState.RECONNECT_WAIT) {
        return;
      }
      manualClose = false;
      reconnectAttempts = 0;
      connectCount = 0;
      openSocket();
    },

    disconnect(reason?: string) {
      manualClose = true;
      clearReconnectTimer();
      clearHeartbeatTimer();
      if (!socket) {
        // 已经没连接了，但也要转到 CLOSED 状态（防止 RECONNECT_WAIT 还在计时）
        if (state !== WsState.CLOSED) {
          state = WsState.CLOSED;
          emit({
            type: 'disconnected',
            willReconnect: false,
            code: WsCloseCode.NORMAL,
            reason: reason ?? 'client disconnect',
          });
        }
        return;
      }
      state = WsState.CLOSING;
      try {
        socket.close(WsCloseCode.NORMAL, reason ?? 'client disconnect');
      } catch {
        // ignore
      }
    },

    send(payload: unknown): boolean {
      if (state !== WsState.OPEN || !socket) return false;
      const body: string = typeof payload === 'string' ? payload : JSON.stringify(payload);
      try {
        socket.send(body);
        return true;
      } catch {
        return false;
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return {
        unsubscribe() {
          listeners.delete(listener);
        },
      };
    },
  };

  return api;
}

