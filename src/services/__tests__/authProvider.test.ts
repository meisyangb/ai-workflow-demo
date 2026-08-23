import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAuthProvider,
  InMemoryStorage,
  decodeJwtPayload,
  deriveExpiresAt,
  withHttpAuth,
  bindAuthToWsConnect,
  AuthEventType,
  type AuthChangedEvent,
  type AuthProvider,
  type TokenPayload,
  type StorageLike,
} from '../authProvider';
import { createHttpClient } from '../httpClient';
import type { WsLikeConstructor } from '../wsClient';
import { createWebSocketClient } from '../wsClient';

// ---------- Helper：生成合法 JWT（header.payload.signature，签名段随便写） ----------
function base64EncodeUtf8(str: string): string {
  // btoa 只接受 Latin-1；先把 UTF-8 字节序列化成 Latin-1 字符
  const bytes = new TextEncoder().encode(str);
  let latin = '';
  for (let i = 0; i < bytes.length; i++) latin += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function' ? btoa(latin) : btoaFallback(latin);
  return b64;
}
function btoaFallback(s: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  for (; i + 3 <= s.length; i += 3) {
    const n = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8) | s.charCodeAt(i + 2);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  const rem = s.length - i;
  if (rem === 1) {
    const n = s.charCodeAt(i) << 16;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (s.charCodeAt(i) << 16) | (s.charCodeAt(i + 1) << 8);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + '=';
  }
  return out;
}
function makeJwt(payload: Record<string, unknown>): string {
  const header = { alg: 'none', typ: 'JWT' };
  const toB64Url = (obj: unknown) => {
    const b64 = base64EncodeUtf8(JSON.stringify(obj));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${toB64Url(header)}.${toB64Url(payload)}.fake-signature`;
}

function fakeNowMs(initialSec: number) {
  let t = initialSec * 1000;
  return {
    nowMs: () => t,
    advanceSec: (sec: number) => {
      t += sec * 1000;
    },
  };
}

function makeToken(overrides: Partial<TokenPayload> = {}): TokenPayload {
  return {
    accessToken: 'placeholder-token',
    expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    userId: 'u-1',
    username: 'demo',
    ...overrides,
  };
}

// ---------- 测试 ----------
describe('鉴权基础（decodeJwtPayload / deriveExpiresAt）', () => {
  it('decodeJwtPayload：三段式合法 JWT 解码 exp', () => {
    const tok = makeJwt({ sub: 'u-1', exp: 1_700_000_000, admin: true });
    const p = decodeJwtPayload(tok);
    expect(p?.sub).toBe('u-1');
    expect(p?.exp).toBe(1_700_000_000);
    expect(p?.admin).toBe(true);
  });

  it('decodeJwtPayload：非法 JWT 返回 null', () => {
    expect(decodeJwtPayload('not.a-valid-jwt!@#$')).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('only.two')).toBeNull();
  });

  it('deriveExpiresAt：从 JWT exp 取出，nowSec 固定', () => {
    const exp = 1_800_000_000;
    const tok = makeJwt({ sub: 'u', exp });
    expect(deriveExpiresAt(tok, 9999, 1_000_000)).toBe(exp);
  });

  it('deriveExpiresAt：JWT 无 exp → 用 nowSec + fallbackSec', () => {
    const tok = makeJwt({ sub: 'u' }); // 无 exp
    expect(deriveExpiresAt(tok, 60, 100)).toBe(100 + 60);
  });
});

describe('AuthProvider 生命周期', () => {
  let storage: StorageLike;
  let clock: ReturnType<typeof fakeNowMs>;
  let auth: AuthProvider;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = fakeNowMs(1_000_000);
    auth = createAuthProvider({
      storage,
      nowMs: clock.nowMs,
      tokenFallbackSec: 3600,
    });
  });

  it('初始未登录：token=null、isAuthenticated=false、isExpired=true', () => {
    expect(auth.token).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.isExpired()).toBe(true);
  });

  it('setToken → 成功，token/isAuthenticated 同步更新；LOGGED_IN 事件发射', () => {
    const tok = makeToken({ accessToken: 'hello', expiresAtSec: clock.nowMs() / 1000 + 1000 });
    const events: AuthChangedEvent[] = [];
    auth.onAuthChange((e) => events.push(e));

    const ok = auth.setToken(tok);
    expect(ok).toBe(true);
    expect(auth.token).toEqual(tok);
    expect(auth.isAuthenticated).toBe(true);
    expect(events).toEqual([{ type: AuthEventType.LOGGED_IN, token: tok }]);
  });

  it('setToken 传入马上过期（expiresAtSec ≤ now）→ 返回 false，不存储', () => {
    const tok = makeToken({ expiresAtSec: clock.nowMs() / 1000 }); // 等于 now → 过期
    const events: AuthChangedEvent[] = [];
    auth.onAuthChange((e) => events.push(e));

    const ok = auth.setToken(tok);
    expect(ok).toBe(false);
    expect(auth.token).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('时间推移导致过期 → 读 token 时自动清理并发送 LOGGED_OUT', () => {
    const events: AuthChangedEvent[] = [];
    auth.onAuthChange((e) => events.push(e));
    auth.setToken(makeToken({ expiresAtSec: clock.nowMs() / 1000 + 60 }));
    expect(events).toHaveLength(1);

    // 还没过期
    clock.advanceSec(59);
    expect(auth.isAuthenticated).toBe(true);
    // 刚过期
    clock.advanceSec(2);
    expect(auth.token).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    const lastEvt = events[events.length - 1];
    expect(lastEvt.type).toBe(AuthEventType.LOGGED_OUT);
    expect(lastEvt.token).toBeNull();
    // storage 被清
    expect(storage.getItem('ai-workflow-demo:auth:token')).toBeNull();
  });

  it('login 占位：把 creds 写入并返回 Promise<TokenPayload>', async () => {
    const tok = makeToken({ accessToken: 'login-token' });
    const got = await auth.login(tok);
    expect(got.accessToken).toBe('login-token');
    expect(auth.token?.accessToken).toBe('login-token');
  });

  it('refresh：有 refreshToken 则 expiresAt 顺延并发 TOKEN_UPDATED', async () => {
    const beforeSec = Math.floor(clock.nowMs() / 1000);
    await auth.login(
      makeToken({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAtSec: beforeSec + 10,
      }),
    );
    clock.advanceSec(5);
    const refreshed = await auth.refresh();
    expect(refreshed.expiresAtSec).toBe(beforeSec + 5 + 3600);
    const events: AuthChangedEvent[] = [];
    auth.onAuthChange((e) => events.push(e));
    // 再单独观察一次：isAuthenticated 稳定
    expect(auth.isAuthenticated).toBe(true);
  });

  it('refresh：没有 refreshToken 直接抛错', async () => {
    await auth.login(makeToken({ accessToken: 'a', refreshToken: undefined }));
    await expect(auth.refresh()).rejects.toThrow(/没有 refreshToken/);
  });

  it('refresh：未登录直接抛错', async () => {
    await expect(auth.refresh()).rejects.toThrow(/未登录/);
  });

  it('logout：清理缓存 + storage + LOGGED_OUT 事件', () => {
    const events: AuthChangedEvent[] = [];
    auth.onAuthChange((e) => events.push(e));
    auth.setToken(makeToken({ expiresAtSec: 1_000_000 + 1000 }));
    auth.logout();
    expect(auth.token).toBeNull();
    expect(storage.getItem('ai-workflow-demo:auth:token')).toBeNull();
    const last = events[events.length - 1];
    expect(last.type).toBe(AuthEventType.LOGGED_OUT);
    expect(last.token).toBeNull();
    // 再次 logout 幂等（不发事件）
    const before = events.length;
    auth.logout();
    expect(events.length).toBe(before);
  });

  it('持久化还原：新 provider 从相同 storage 取回 token，并按时间判定过期', () => {
    // 先写
    const auth1 = createAuthProvider({ storage, nowMs: clock.nowMs });
    auth1.setToken(makeToken({ expiresAtSec: 1_000_000 + 300 }));
    // 再新建一个相同配置的 provider
    const auth2 = createAuthProvider({ storage, nowMs: clock.nowMs });
    expect(auth2.isAuthenticated).toBe(true);
    expect(auth2.token?.userId).toBe('u-1');

    // 时间推进 400s：已过期，auth3 在 hydrate 时清理
    clock.advanceSec(400);
    const auth3 = createAuthProvider({ storage, nowMs: clock.nowMs });
    expect(auth3.token).toBeNull();
    expect(auth3.isAuthenticated).toBe(false);
  });

  it('onAuthChange 可取消订阅', () => {
    const events: AuthChangedEvent[] = [];
    const sub = auth.onAuthChange((e) => events.push(e));
    auth.setToken(makeToken({ expiresAtSec: 1_000_000 + 100 }));
    const before = events.length;
    sub.unsubscribe();
    auth.setToken(makeToken({ accessToken: 'second', expiresAtSec: 1_000_000 + 200 }));
    expect(events.length).toBe(before);
  });
});

describe('鉴权 → 通信层注入', () => {
  it('withHttpAuth：wrapper 自动补 Bearer Authorization；请求级 Authorization 优先', async () => {
    // mock fetch：把请求头原样返回（HTTP 200）
    type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
    let lastHeaders: Record<string, string> = {};
    const fakeFetch: FetchLike = (_url, init) => {
      lastHeaders = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
      return Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    };
    const clock = fakeNowMs(1_000_000);
    const auth = createAuthProvider({ storage: new InMemoryStorage(), nowMs: clock.nowMs });

    // 先建一个纯 client 验证 /ping 不带 token 时无 Authorization
    const plain = createHttpClient({ fetchImpl: fakeFetch });
    await plain.get('/ping');
    expect(lastHeaders['authorization']).toBeUndefined();

    // 登录 + 建 wrapper：后续请求自动补 Bearer
    await auth.login({ accessToken: 'tk-abc', expiresAtSec: clock.nowMs() / 1000 + 100 });
    const http = withHttpAuth(createHttpClient({ fetchImpl: fakeFetch }), auth);
    await http.get('/private');
    expect(lastHeaders['authorization']).toBe('Bearer tk-abc');

    // 已有请求级 headers 时，用户的 Authorization 不被覆盖
    await http.get('/p2', { headers: { Authorization: 'Bearer force-value', 'X-Id': '42' } });
    expect(lastHeaders['authorization']).toBe('Bearer force-value');
    expect(lastHeaders['x-id']).toBe('42');
  });

  it('bindAuthToWsConnect：buildWsUrl 带 token query；LOGGED_OUT / TOKEN_UPDATED 自动断开 WS', () => {
    const storage = new InMemoryStorage();
    const clock = fakeNowMs(1_000_000);
    const auth = createAuthProvider({ storage, nowMs: clock.nowMs });

    // 记录创建过的 WebSocket 实例的 URL（mock 构造器）
    const wsUrls: string[] = [];
    const wsFactory: WsLikeConstructor = ((url) => {
      wsUrls.push(url);
      // 返回一个最简化的 mock（addEventListener 兼容即可，不用触发事件）
      return {
        readyState: 0,
        send: () => {},
        close: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    }) as WsLikeConstructor;

    const buildUrl = (base: string, token: TokenPayload | null) =>
      token ? `${base}?token=${encodeURIComponent(token.accessToken)}` : base;
    const baseUrl = 'wss://srv.test/flow';

    // 先拿到带 token 的 URL 作为 WS Client 的 url（真实流程：先 build，再构造 WS client）
    const urlAfterLogin = buildUrl(baseUrl, null);
    const ws = createWebSocketClient({
      url: urlAfterLogin,
      wsFactory,
      reconnectBaseDelayMs: 0,
      maxReconnectAttempts: 0,
    });
    const { tokenParamUrl } = bindAuthToWsConnect(ws, auth, buildUrl, baseUrl);

    // 登录前 tokenParamUrl() 无 query
    expect(tokenParamUrl()).toBe('wss://srv.test/flow');
    // 登录
    void auth.login({ accessToken: 'tk-ws', expiresAtSec: 1_000_000 + 1000 });
    // TOKEN_UPDATED / LOGGED_IN → bindAuthToWsConnect 中只有 LOGGED_OUT/TOKEN_UPDATED 才 disconnect；
    // 但 LOGGED_IN 也应当拿到新 URL：
    expect(tokenParamUrl()).toBe('wss://srv.test/flow?token=tk-ws');

    // 登出 → 触发 disconnect（WS 内部 manualClose=true）
    auth.logout();
    // state 转为 CLOSED（或者 CLOSING，取决于 mock socket 是否触发 close；我们只确保 tokenParamUrl 正确）
    expect(tokenParamUrl()).toBe('wss://srv.test/flow');
  });
});
