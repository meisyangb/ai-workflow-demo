/**
 * 鉴权与 Token 生命周期管理
 *
 * 对应用户消息中要求的「鉴权」架构组件：
 * - AuthProvider 接口：setToken / getToken / clearToken / isExpired / login 占位 / logout / onAuthChange 订阅
 * - JWT 解析：轻量 base64 解码 payload（不需要第三方库），提取 `exp` 字段用于过期判断
 * - 存储抽象层（StorageLike）：localStorage / sessionStorage / 测试用 in-memory 可自由注入
 * - 应用到通信层的钩子：
 *   · HTTP Client：request 前自动拼 Authorization: Bearer <token>（拦截器式 setAuthHeaders）
 *   · WebSocket Client：URL 拼接 ?token= 或订阅 auth 变化自动重建连接
 *
 * 当前项目无后端，login/refresh 为占位 Promise resolve（返回 TokenPayload，留作以后接 /api/auth/login）；
 * 但 Store 与通信层可以直接消费本模块的 token/过期钩子，后端就绪时只需替换 login/refresh 内部实现。
 */

// ===== 数据模型 =====
export interface TokenPayload {
  /** access_token（JWT） */
  accessToken: string;
  /** 可选的 refresh_token（用于 /api/auth/refresh 换发新 token） */
  refreshToken?: string;
  /** 过期时刻（Unix 秒，与 JWT `exp` 对齐）；undefined 表示不校验过期 */
  expiresAtSec?: number;
  /** 可选的用户信息（留作未来对接后端后写死在 payload 里，或者单独请求 /api/me） */
  userId?: string;
  username?: string;
}

// ===== 存储抽象 =====
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 纯 JS base64 解码 fallback（当运行环境没有 atob 时使用，避免依赖 Node.js Buffer）。
 * 仅处理标准 base64（含 padding），非 base64 字符抛错由调用方 try/catch。
 */
function base64Decode(base64: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const idxMap = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) idxMap.set(alphabet[i], i);
  const input = base64.replace(/=+$/, '');
  let bits = 0;
  let accum = 0;
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const v = idxMap.get(input[i]);
    if (v === undefined) throw new Error('invalid base64 char');
    accum = (accum << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const code = (accum >>> bits) & 0xff;
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/**
 * 简易 JWT payload 解码（无签名校验——仅用于客户端判断 `exp` 是否过期。
 * 签名校验应该放在后端，客户端不会也不该持有签名公钥。）
 * 返回未解析成功为 null（例如 accessToken 不是 xxx.yyy.zzz 三段式）。
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payloadBase64 = parts[1];
  if (!payloadBase64) return null;
  try {
    // JWT 的 base64 是 URL-safe（- _ 代替 + /，缺 padding）
    const standard = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '=');
    const json = typeof atob === 'function' ? atob(padded) : base64Decode(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 从 JWT `exp` 字段推断 expiresAtSec；缺省 fallbackSec 秒（如后端不发 exp，
 * 默认 1 小时后过期）；exp 解析失败或 exp 非法时按 fallbackSec 处理。
 */
export function deriveExpiresAt(token: string, fallbackSec = 3600, nowSec?: number): number {
  const payload = decodeJwtPayload(token);
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const exp = payload?.exp;
  if (typeof exp === 'number' && Number.isFinite(exp)) return Math.floor(exp);
  return now + fallbackSec;
}

// ===== 事件类型 =====
export const AuthEventType = {
  /** 登录 / setToken 后，或从 storage 成功还原 */
  LOGGED_IN: 'logged-in',
  /** 手动 logout / clearToken，或自动检查发现过期后自动清理 */
  LOGGED_OUT: 'logged-out',
  /** token 内容更新（refresh 换发、或者 payload 字段变更） */
  TOKEN_UPDATED: 'token-updated',
} as const;
export type AuthEventType = (typeof AuthEventType)[keyof typeof AuthEventType];

export interface AuthChangedEvent {
  type: AuthEventType;
  /** 变更后的 token（LOGGED_OUT 为 null） */
  token: TokenPayload | null;
}

export interface AuthSubscription {
  unsubscribe(): void;
}

// ===== 接口 =====
export interface AuthProvider {
  /** 当前 token（未登录或已过期为 null）；每次读取都检查一次过期 */
  readonly token: TokenPayload | null;
  /** 是否已登录（等价于 token !== null） */
  readonly isAuthenticated: boolean;
  /** 当前 token 是否在 {withinSec} 秒内过期；未登录时返回 true（视为"已过期"） */
  isExpired(withinSec?: number): boolean;

  /**
   * 登录（占位：当前直接把传入的 token 写入；
   * 未来替换成真实 POST /api/auth/login + 解析响应为 TokenPayload。）
   */
  login(creds: TokenPayload): Promise<TokenPayload>;

  /**
   * Token 换发（占位：当前若 refreshToken 存在则延长 expiresAt；
   * 未来替换成 POST /api/auth/refresh。）
   */
  refresh(): Promise<TokenPayload>;

  /** 登出：清 storage + 通知 LOGGED_OUT */
  logout(): void;

  /**
   * 手动设置 token（应用场景：从 deep link / SSR 响应 / 本地初始化还原）；
   * 若 token 已过期则返回 false 且不写入。
   */
  setToken(payload: TokenPayload): boolean;

  /** 订阅登录状态变化 */
  onAuthChange(listener: (event: AuthChangedEvent) => void): AuthSubscription;
}

// ===== 工厂参数 =====
export interface AuthProviderOptions {
  /** 持久化 key 前缀；最终 localStorage/sessionStorage 内的 key = `${storageKeyPrefix}:token` */
  storageKeyPrefix?: string;
  /** 持久化实现；默认浏览器 localStorage（依赖注入便于单测用 in-memory 替换） */
  storage?: StorageLike;
  /** 时间源（Unix 毫秒）；默认 Date.now()；依赖注入便于单测确定性推进时间 */
  nowMs?: () => number;
  /**
   * JWT 缺省过期秒数（后端没发 exp 字段时按 now + fallbackSec 算）；
   * 默认 3600 = 1 小时
   */
  tokenFallbackSec?: number;
}

// ===== 内存 Storage（供单测 / SSR 无 localStorage 环境使用）=====
export class InMemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k) ?? null : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

// ===== 工厂函数 =====
const DEFAULT_STORAGE_KEY = 'ai-workflow-demo:auth';

export function createAuthProvider(options: AuthProviderOptions = {}): AuthProvider {
  const {
    storageKeyPrefix = DEFAULT_STORAGE_KEY,
    storage,
    nowMs = () => Date.now(),
    tokenFallbackSec = 3600,
  } = options;

  // storage 默认值延迟解析：避免 SSR 下直接访问 globalThis.localStorage 抛错
  const _storage: StorageLike =
    storage ??
    (typeof globalThis.localStorage !== 'undefined'
      ? globalThis.localStorage as StorageLike
      : new InMemoryStorage());
  const TOKEN_KEY = `${storageKeyPrefix}:token`;

  const listeners = new Set<(event: AuthChangedEvent) => void>();
  const emit = (event: AuthChangedEvent) => {
    for (const fn of listeners) fn(event);
  };

  // ===== 内部辅助 =====
  const nowSec = () => Math.floor(nowMs() / 1000);

  function normalize(p: TokenPayload): TokenPayload {
    // 若无 expiresAtSec，则尝试从 JWT 提取 exp；仍不可得时按 fallbackSec 给一个默认
    if (p.expiresAtSec !== undefined && Number.isFinite(p.expiresAtSec)) {
      return { ...p, expiresAtSec: Math.floor(p.expiresAtSec) };
    }
    return { ...p, expiresAtSec: deriveExpiresAt(p.accessToken, tokenFallbackSec, nowSec()) };
  }

  /** 内部内存里的 token；写入 storage 时同步更新 */
  let cached: TokenPayload | null = null;

  const saveAndNotify = (next: TokenPayload | null, eventType: AuthEventType) => {
    cached = next;
    if (next) {
      try {
        _storage.setItem(TOKEN_KEY, JSON.stringify(next));
      } catch {
        // 某些隐私模式 / 配额耗尽忽略，保持内存内 token 仍有效
      }
    } else {
      try {
        _storage.removeItem(TOKEN_KEY);
      } catch {
        // ignore
      }
    }
    emit({ type: eventType, token: next });
  };

  /** 检查当前缓存 token 是否已过期；若过期则自动 LOGGED_OUT 并清理 */
  function autoCleanIfExpired(): TokenPayload | null {
    if (!cached) return null;
    if (cached.expiresAtSec !== undefined && cached.expiresAtSec <= nowSec()) {
      saveAndNotify(null, AuthEventType.LOGGED_OUT);
      return null;
    }
    return cached;
  }

  /** 从 storage 还原（首次创建 provider 时调用） */
  function hydrate(): void {
    try {
      const raw = _storage.getItem(TOKEN_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as TokenPayload;
      const norm = normalize(parsed);
      cached = norm; // 先写缓存，后面 autoCleanIfExpired 再按时间决定是否清
      autoCleanIfExpired();
      if (cached) emit({ type: AuthEventType.LOGGED_IN, token: cached });
    } catch {
      // storage 损坏：静默清除
      try {
        _storage.removeItem(TOKEN_KEY);
      } catch {
        // ignore
      }
    }
  }
  hydrate();

  // ===== 对外 API =====
  const api: AuthProvider = {
    get token() {
      return autoCleanIfExpired();
    },
    get isAuthenticated() {
      return autoCleanIfExpired() !== null;
    },

    isExpired(withinSec = 0) {
      const t = cached;
      if (!t) return true; // 未登录视为"已过期"
      if (t.expiresAtSec === undefined) return false; // 未设过期时间视为永不过期
      return t.expiresAtSec - withinSec <= nowSec();
    },

    async login(creds: TokenPayload): Promise<TokenPayload> {
      // 占位：这里本应 POST /api/auth/login，然后把响应转成 TokenPayload。
      // 先按「creds 本身就是后端返回的 token 结构体」来用。
      const norm = normalize(creds);
      saveAndNotify(norm, AuthEventType.LOGGED_IN);
      return norm;
    },

    async refresh(): Promise<TokenPayload> {
      const cur = autoCleanIfExpired();
      if (!cur) {
        // 未登录直接抛（refresh 需要 refresh token 或当前 token）
        throw new Error('未登录，无法 refresh token');
      }
      // 占位：这里本应 POST /api/auth/refresh（refreshToken）+ 拿新 token。
      // 前端 mock：若存在 refreshToken 字段，则把 expiresAt 延 1 小时；否则抛错。
      if (!cur.refreshToken) {
        throw new Error('没有 refreshToken，无法换发新 token（请重新登录）');
      }
      const refreshed: TokenPayload = {
        ...cur,
        accessToken: cur.accessToken, // 真实场景此处应是后端新发
        expiresAtSec: nowSec() + tokenFallbackSec,
      };
      saveAndNotify(refreshed, AuthEventType.TOKEN_UPDATED);
      return refreshed;
    },

    logout() {
      if (cached === null) return;
      saveAndNotify(null, AuthEventType.LOGGED_OUT);
    },

    setToken(payload: TokenPayload): boolean {
      const norm = normalize(payload);
      if (norm.expiresAtSec !== undefined && norm.expiresAtSec <= nowSec()) {
        return false; // 传进来就过期：拒绝写入
      }
      saveAndNotify(norm, AuthEventType.LOGGED_IN);
      return true;
    },

    onAuthChange(listener) {
      listeners.add(listener);
      return { unsubscribe() { listeners.delete(listener); } };
    },
  };

  return api;
}

// ===== 与通信层的便利整合工具 =====

import type { HttpClient, RequestOptions } from './httpClient';

/**
 * 构造一个在原 HTTP Client 之上的「带鉴权」外观：
 * - 每次 get/post/put/delete 调用时，若 auth.token 非空，自动给请求级 headers 补上
 *   `Authorization: Bearer <accessToken>`
 * - 用户显式在单次请求里传了 Authorization，以用户为准
 * - 不 monkey-patch 原 client（避免原 client 闭包里对 request 的直接引用不生效），
 *   返回一个独立的 wrapper，类型仍然是 HttpClient。
 */
export function withHttpAuth(httpClient: HttpClient, auth: AuthProvider): HttpClient {
  const authHeaders = (config?: RequestOptions): RequestOptions | undefined => {
    const t = auth.token;
    if (!t) return config;
    const authH = (config?.headers?.Authorization) ?? `Bearer ${t.accessToken}`;
    return { ...config, headers: { ...(config?.headers ?? {}), Authorization: authH } };
  };
  const authStreamHeaders = (cfg: Parameters<HttpClient['stream']>[0]) => {
    const t = auth.token;
    if (!t) return cfg;
    const headers = {
      ...(cfg.headers ?? {}),
      Authorization: cfg.headers?.Authorization ?? `Bearer ${t.accessToken}`,
    };
    return { ...cfg, headers };
  };
  return {
    request: <T>(cfg: Parameters<HttpClient['request']>[0]) => {
      const t = auth.token;
      if (!t) return httpClient.request<T>(cfg);
      const headers = {
        ...(cfg.headers ?? {}),
        Authorization: cfg.headers?.Authorization ?? `Bearer ${t.accessToken}`,
      };
      return httpClient.request<T>({ ...cfg, headers });
    },
    get: <T>(url: string, config?: RequestOptions) =>
      httpClient.get<T>(url, authHeaders(config)),
    post: <T>(url: string, body?: unknown, config?: RequestOptions) =>
      httpClient.post<T>(url, body, authHeaders(config)),
    put: <T>(url: string, body?: unknown, config?: RequestOptions) =>
      httpClient.put<T>(url, body, authHeaders(config)),
    delete: <T>(url: string, config?: RequestOptions) =>
      httpClient.delete<T>(url, authHeaders(config)),
    stream: (cfg: Parameters<HttpClient['stream']>[0]) => httpClient.stream(authStreamHeaders(cfg)),
  };
}

/**
 * 把 AuthProvider 注入到 WebSocket Client 启动前的 URL 构建步骤：
 * 构造出的 `connectWithAuth()` 等价于 `ws.connect()`，但会在 token 存在时把
 * token 作为 query 参数拼到 URL 上（WebSocket 协议本身无法设置请求头，这是主流实践）。
 *
 * 若 onAuthChange 监听到 LOGGED_OUT / TOKEN_UPDATED，会调用 onAuthChanged 回调让调用方
 * 决定是否断开重连（典型：断开后自动走 WS 自身的重连机制重新建连即可带上新 token）。
 */
export function bindAuthToWsConnect(
  wsClient: { connect(): void; disconnect(reason?: string): void },
  auth: AuthProvider,
  buildUrl: (baseUrl: string, token: TokenPayload | null) => string,
  baseUrl: string,
  onAuthChanged?: (event: AuthChangedEvent) => void,
): { connectWithAuth(): void; tokenParamUrl(): string } {
  // 订阅事件
  auth.onAuthChange((event) => {
    if (event.type === AuthEventType.LOGGED_OUT || event.type === AuthEventType.TOKEN_UPDATED) {
      // token 失效或换发：先断开，让调用方通过 WS 自动重连 / 手动重连带新 URL
      wsClient.disconnect(event.type === AuthEventType.LOGGED_OUT ? 'auth_logged_out' : 'token_updated');
    }
    onAuthChanged?.(event);
  });

  const tokenParamUrl = () => buildUrl(baseUrl, auth.token);

  return {
    connectWithAuth() {
      // 先把 URL 上的参数通过 WS Client 构造时带进去；这里调用方应把 buildUrl(...) 的结果
      // 传给 createWebSocketClient 的 url 选项。connectWithAuth 仅作语义化包装。
      wsClient.connect();
    },
    tokenParamUrl,
  };
}

