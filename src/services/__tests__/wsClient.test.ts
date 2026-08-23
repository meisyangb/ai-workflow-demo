import { describe, it, expect, beforeEach } from 'vitest';
import {
  createWebSocketClient,
  READY_STATE,
  WsState,
  WsCloseCode,
  type WsEvent,
  type WsLike,
  type WsLikeCloseEvent,
  type WsLikeConstructor,
} from '../wsClient';

// ===== MockSocket：完全可控的 WsLike 实现 =====
interface MockSocketHandlers {
  open: Array<() => void>;
  message: Array<(ev: { data: unknown }) => void>;
  error: Array<() => void>;
  close: Array<(ev: WsLikeCloseEvent) => void>;
}

class MockSocket implements WsLike {
  public readyState: number = READY_STATE.CONNECTING;
  private handlers: MockSocketHandlers = { open: [], message: [], error: [], close: [] };
  public sendCalls: string[] = [];
  public closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(public readonly url: string, public readonly protocols?: string | string[]) {}

  send(data: string): void {
    this.sendCalls.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = READY_STATE.CLOSING;
    this.closeCalls.push({ code, reason });
  }

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: never): void {
    this.handlers[type].push(listener);
  }

  removeEventListener(type: string, listener: never): void {
    const arr = this.handlers[type as keyof MockSocketHandlers];
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
  }

  // ===== 测试辅助：触发事件 =====
  $open() {
    this.readyState = READY_STATE.OPEN;
    for (const fn of [...this.handlers.open]) fn();
  }
  $message(data: unknown) {
    for (const fn of [...this.handlers.message]) fn({ data });
  }
  $error() {
    for (const fn of [...this.handlers.error]) fn();
  }
  $close(code = 1000, reason = '', wasClean = true) {
    this.readyState = READY_STATE.CLOSED;
    const ev: WsLikeCloseEvent = { code, reason, wasClean };
    for (const fn of [...this.handlers.close]) fn(ev);
  }
  $disconnectWithError() {
    this.$error();
    this.$close(1006, 'abnormal_closure', false);
  }
}

/**
 * 可手动推进的计时器：setTimeout 回调加入队列，advanceTime(ms) 触发到期者。
 * 简化实现：按到期时间排序顺序触发，支持多次 advance。
 */
function createTimerMock() {
  type Task = { id: number; due: number; cb: () => void };
  let now = 0;
  let nextId = 1;
  const tasks = new Map<number, Task>();
  const setTimeoutImpl = (cb: () => void, ms: number) => {
    const id = nextId++;
    tasks.set(id, { id, due: now + ms, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutImpl = (id: ReturnType<typeof setTimeout> | number) => {
    tasks.delete(id as unknown as number);
  };
  /** 推进虚拟时间，触发所有 due ≤ now+ms 的任务（任务回调内可能继续 set 新任务，循环直到没有到期的） */
  const advanceTime = (ms: number) => {
    const endAt = now + ms;
    let progressed = true;
    let rounds = 0;
    while (progressed && rounds < 1000) {
      progressed = false;
      rounds += 1;
      const sorted = [...tasks.values()].sort((a, b) => a.due - b.due);
      for (const t of sorted) {
        if (t.due <= endAt) {
          now = Math.max(now, t.due);
          tasks.delete(t.id);
          progressed = true;
          t.cb();
          break; // 重新取排序（新任务可能被 set 出来）
        }
      }
    }
    now = endAt;
  };
  const pendingCount = () => tasks.size;
  return { setTimeoutImpl, clearTimeoutImpl, advanceTime, pendingCount };
}

/**
 * MockSocket 工厂：每次调用 `factory(url, protocols)` 返回一个新的 MockSocket；
 * 所有生成的实例加入 `createdSockets` 数组，方便测试按索引抓取。
 */
function makeMockSocketFactory(): {
  factory: WsLikeConstructor;
  createdSockets: MockSocket[];
} {
  const createdSockets: MockSocket[] = [];
  return {
    createdSockets,
    factory: ((url: string, protocols?: string | string[]) => {
      const s = new MockSocket(url, protocols);
      createdSockets.push(s);
      return s;
    }) as WsLikeConstructor,
  };
}

// ===== 收集事件 helper =====
function record(ws: ReturnType<typeof createWebSocketClient>) {
  const events: WsEvent[] = [];
  ws.subscribe((e) => events.push(e));
  return events;
}

// ===== 测试 =====
describe('WebSocketClient', () => {
  let sockets: MockSocket[];
  let factory: WsLikeConstructor;
  let timer: ReturnType<typeof createTimerMock>;

  beforeEach(() => {
    const m = makeMockSocketFactory();
    sockets = m.createdSockets;
    factory = m.factory;
    timer = createTimerMock();
  });

  function create(overrides: Partial<Parameters<typeof createWebSocketClient>[0]> = {}) {
    return createWebSocketClient({
      url: 'ws://example.test/flow',
      wsFactory: factory,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 1000,
      maxReconnectAttempts: 3,
      heartbeatIntervalMs: 500,
      ...overrides,
    });
  }

  it('connect → 构造 1 个 socket；服务端 accept：状态 OPEN + connected event(attempt=1)', () => {
    const ws = create();
    const events = record(ws);
    ws.connect();
    expect(sockets).toHaveLength(1);
    expect(ws.state).toBe(WsState.CONNECTING);

    sockets[0].$open();
    expect(ws.state).toBe(WsState.OPEN);
    expect(events.filter((e) => e.type === 'connected')).toEqual([
      { type: 'connected', attempt: 1 },
    ]);
  });

  it('connect 幂等：OPEN 中重复 connect() 不新建 socket', () => {
    const ws = create();
    ws.connect();
    sockets[0].$open();
    ws.connect();
    ws.connect();
    expect(sockets).toHaveLength(1);
  });

  it('send：对象自动 JSON.stringify；OPEN 前返回 false', () => {
    const ws = create();
    ws.connect();
    expect(ws.send({ action: 'run' })).toBe(false);
    sockets[0].$open();
    expect(ws.send({ action: 'run', id: 7 })).toBe(true);
    expect(ws.send('plain-text')).toBe(true);
    expect(sockets[0].sendCalls).toEqual([
      JSON.stringify({ action: 'run', id: 7 }),
      'plain-text',
    ]);
  });

  it('收到 message：JSON 自动解析到 data；非 JSON data=undefined；心跳定时器重置', () => {
    const ws = create({ heartbeatIntervalMs: 500 });
    const events = record(ws);
    ws.connect();
    sockets[0].$open();

    sockets[0].$message('{"type":"node","id":"a","status":"success"}');
    sockets[0].$message('plain-text-not-json');

    const msgs = events.filter((e): e is Extract<WsEvent, { type: 'message' }> => e.type === 'message');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].data).toEqual({ type: 'node', id: 'a', status: 'success' });
    expect(msgs[0].raw).toBe('{"type":"node","id":"a","status":"success"}');
    expect(msgs[1].data).toBeUndefined();
    expect(msgs[1].raw).toBe('plain-text-not-json');

    // 心跳：刚 OPEN + 2 条消息过后，下一个心跳应还在 500ms 之后
    timer.advanceTime(499);
    // 未超时（closeCalls 为空）
    expect(sockets[0].closeCalls).toHaveLength(0);
  });

  it('心跳超时：主动 close(1011, heartbeat_timeout) 并触发错误事件', () => {
    const ws = create({ heartbeatIntervalMs: 500 });
    const events = record(ws);
    ws.connect();
    sockets[0].$open();

    // 开 1000ms：首次心跳在 +500ms 触发超时
    timer.advanceTime(1000);
    const errs = events.filter((e) => e.type === 'error');
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(sockets[0].closeCalls).toHaveLength(1);
    expect(sockets[0].closeCalls[0].code).toBe(WsCloseCode.UNEXPECTED_CONDITION);
    expect(sockets[0].closeCalls[0].reason).toBe('heartbeat_timeout');
  });

  it('异常断连 → 每次成功后重连计数归零，重连 delay 从 base 重新累计', () => {
    const ws = create({ reconnectBaseDelayMs: 100, maxReconnectAttempts: 3 });
    const events = record(ws);
    ws.connect();

    // 首连成功 → 立即异常断连
    sockets[0].$open();
    sockets[0].$disconnectWithError(); // error + close(1006)
    expect(ws.state).toBe(WsState.RECONNECT_WAIT);
    const firstDisc = events.find((e) => e.type === 'disconnected');
    expect(firstDisc?.type === 'disconnected' && firstDisc.willReconnect).toBe(true);

    // 首次重连 delay = base * 2^(attempt-1) = 100 * 2^(1-1) = 100ms
    timer.advanceTime(100);
    expect(sockets).toHaveLength(2);
    sockets[1].$open();
    expect(ws.reconnectAttempts).toBe(0); // 连接成功后归零

    // 第 2 次断连：从零开始，delay 仍然是 100ms（不是 200ms）
    sockets[1].$disconnectWithError();
    timer.advanceTime(100);
    expect(sockets).toHaveLength(3);
    sockets[2].$open();

    // 第 3 次断连：同样 100ms 后再连
    sockets[2].$disconnectWithError();
    timer.advanceTime(100);
    expect(sockets).toHaveLength(4);
    sockets[3].$open();

    const connectedEvents = events.filter(
      (e): e is Extract<WsEvent, { type: 'connected' }> => e.type === 'connected',
    );
    expect(connectedEvents.map((e) => e.attempt)).toEqual([1, 2, 3, 4]);
  });

  it('超过 maxReconnectAttempts=3 后停止重连，发 disconnected(willReconnect=false)', () => {
    const ws = create({ reconnectBaseDelayMs: 10, maxReconnectAttempts: 3 });
    const events = record(ws);
    ws.connect();

    // 首连未 open 就 abnormal close → 重连 attempt 1；再 2 次重连均失败：
    // attempt 1 后 close → attempt 2；close → attempt 3；close → attempts>=max → 停止
    for (let i = 0; i < 4; i++) {
      // 第 4 轮：socket 4 close(abnormal) 后 willReconnect=false
      sockets[sockets.length - 1].$close(1006, 'abnormal', false);
      timer.advanceTime(10_000);
    }
    // 首连 + 3 次重连 = 4 个 socket（不会有第 5 个）
    expect(sockets).toHaveLength(4);
    const lastDisconnect = [...events]
      .reverse()
      .find((e) => e.type === 'disconnected') as Extract<WsEvent, { type: 'disconnected' }> | undefined;
    expect(lastDisconnect?.willReconnect).toBe(false);
    expect(ws.state).toBe(WsState.CLOSED);
  });

  it('主动 disconnect() → manual close：不重连，发送 disconnected(willReconnect=false)', () => {
    const ws = create();
    ws.connect();
    sockets[0].$open();
    ws.disconnect('bye-bye');
    // mock socket 的 close() 不会自己触发 close 事件，需要 $close() 配合
    // 检查已调用 socket.close(code, reason)
    expect(sockets[0].closeCalls).toHaveLength(1);
    expect(sockets[0].closeCalls[0].code).toBe(WsCloseCode.NORMAL);
    expect(sockets[0].closeCalls[0].reason).toBe('bye-bye');

    // 触发原生 close 后，应当不再重连
    sockets[0].$close(WsCloseCode.NORMAL, 'bye-bye', true);
    timer.advanceTime(10_000); // 等一个很长的窗口，确认没启动新连接
    expect(ws.state).toBe(WsState.CLOSED);
    expect(sockets).toHaveLength(1); // 没有新 socket 被构造
  });

  it('subscribe 可 unsubscribe：unsubscribe 后不再收到事件', () => {
    const ws = create();
    const events: WsEvent[] = [];
    const sub = ws.subscribe((e) => events.push(e));
    ws.connect();
    sockets[0].$open();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const before = events.length;
    sub.unsubscribe();
    sockets[0].$message('{"after":1}');
    sockets[0].$open();
    expect(events.length).toBe(before); // 无新增
  });

  it('关闭心跳（heartbeatIntervalMs=0）：永远不会触发心跳超时 close', () => {
    const ws = create({ heartbeatIntervalMs: 0 });
    ws.connect();
    sockets[0].$open();
    timer.advanceTime(1_000_000);
    expect(sockets[0].closeCalls).toHaveLength(0);
  });
});
