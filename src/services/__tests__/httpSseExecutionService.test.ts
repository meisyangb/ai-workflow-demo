import { describe, it, expect, vi } from 'vitest';
import { HttpSseExecutionService, type HttpSseMode } from '../httpSseExecutionService';
import { createHttpClient, type FetchLike } from '../httpClient';
import type { ExecutionEvent, WorkflowSnapshot } from '../executionService';
import type { SseRawEvent } from '../../schemas/ssePackets';
import { createAuthProvider, InMemoryStorage } from '../authProvider';
import { NodeStatus, NodeType } from '../../domains/workflow';

function jsonResponse(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** 把若干 SseRawEvent 按扣子格式序列化，放入 ReadableStream 作为 Response body */
function sseStreamResponse(status: number, frames: SseRawEvent[]): Response {
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const f of frames) {
    if (f.id) chunks.push(enc.encode(`id: ${f.id}\n`));
    if (f.event && f.event !== 'message') chunks.push(enc.encode(`event: ${f.event}\n`));
    if (f.retryMs) chunks.push(enc.encode(`retry: ${f.retryMs}\n`));
    const dataLines = f.data ? f.data.split('\n') : [];
    for (const line of dataLines) chunks.push(enc.encode(`data: ${line}\n`));
    chunks.push(enc.encode('\n'));
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const SNAPSHOT: WorkflowSnapshot = {
  nodes: [
    {
      id: 'n1',
      type: NodeType.START,
      position: { x: 0, y: 0 },
      data: { label: 'Start', nodeType: 'START', status: NodeStatus.IDLE, inputs: [] },
    },
    {
      id: 'n2',
      type: NodeType.LLM,
      position: { x: 200, y: 0 },
      data: { label: 'LLM', nodeType: 'LLM', prompt: '', status: NodeStatus.IDLE, model: 'gpt', temperature: 0.7, maxTokens: 1024 },
    },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'out', targetHandle: 'in' },
  ],
};

function buildService(mode: HttpSseMode, fetchImpl: FetchLike, httpFetch?: FetchLike) {
  const httpClient = createHttpClient({
    fetchImpl: httpFetch ?? fetchImpl,
    retryBaseDelayMs: 0,
    retries: 0,
  });
  const svc = new HttpSseExecutionService({
    name: 'test-svc',
    mode,
    baseUrl: 'https://api.example.com',
    httpClient,
    fetchImpl,
    sse: {
      idleTimeoutMs: 0,
      reconnectPolicy: 'never',
      maxReconnects: 0,
      reconnectBaseDelayMs: 0,
    },
    asyncPoll: { initialMs: 0, maxMs: 1 },
  });
  return svc;
}

describe('HttpSseExecutionService stream 模式', () => {
  it('扣子 SSE 事件：started → node-status(running) → node-token(分片) → node-status(success) → done(success) → ExecutionEvent 正确映射', async () => {
    const frames: SseRawEvent[] = [
      { id: '1', event: 'workflow-started', data: JSON.stringify({ run_id: 'r1', execute_id: 'x1', order: ['n1', 'n2'] }), retryMs: null, offset: 0 },
      { id: '2', event: 'node-status', data: JSON.stringify({ node_id: 'n1', status: 'running' }), retryMs: null, offset: 0 },
      { id: '3', event: 'node-status', data: JSON.stringify({ node_id: 'n1', status: 'success', activated_edge_ids: ['e1'], duration_ms: 12 }), retryMs: null, offset: 0 },
      { id: '4', event: 'node-token', data: JSON.stringify({ node_id: 'n2', delta: '你', tokens_estimated: 3 }), retryMs: null, offset: 0 },
      { id: '5', event: 'node-token', data: JSON.stringify({ node_id: 'n2', delta: '好' }), retryMs: null, offset: 0 },
      { id: '6', event: 'node-status', data: JSON.stringify({ node_id: 'n2', status: 'success', duration_ms: 100, output: { content: '你好' } }), retryMs: null, offset: 0 },
      { id: '7', event: 'done', data: JSON.stringify({ run_id: 'r1', outcome: 'success', outputs: { answer: '你好' } }), retryMs: null, offset: 0 },
    ];

    const fetchImpl = vi.fn(async (): Promise<Response> => sseStreamResponse(200, frames));
    const svc = buildService('stream', fetchImpl);

    const events: ExecutionEvent[] = [];
    const handle = svc.start(SNAPSHOT, (e) => events.push(e));
    await handle.done();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const started = events.find((e): e is Extract<ExecutionEvent, { type: 'run-started' }> => e.type === 'run-started');
    expect(started).not.toBeUndefined();
    expect(started!.runId).toBe('r1');
    expect(started!.order).toEqual(['n1', 'n2']);

    const tokens = events.filter((e) => e.type === 'node-output-append') as Array<Extract<ExecutionEvent, { type: 'node-output-append' }>>;
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.delta)).toEqual(['你', '好']);

    const edges = events.filter((e) => e.type === 'node-edges-activated') as Array<Extract<ExecutionEvent, { type: 'node-edges-activated' }>>;
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges[0]!.activatedEdgeIds).toEqual(['e1']);

    const finished = events.find((e): e is Extract<ExecutionEvent, { type: 'run-finished' }> => e.type === 'run-finished');
    expect(finished).not.toBeUndefined();
    expect(finished!.reason).toBeNull();
    expect(finished!.outcome).toBe('success');
    expect(finished!.outputs).toEqual({ answer: '你好' });
  });

  it('SSE event=error → 产出 node-status(failed) + run-finished(failed)，handle.done 返回 error', async () => {
    const frames: SseRawEvent[] = [
      { id: '1', event: 'workflow-started', data: JSON.stringify({ run_id: 'r1', order: ['n2'] }), retryMs: null, offset: 0 },
      { id: '2', event: 'error', data: JSON.stringify({ code: 7001, message: '模型调用失败', node_id: 'n2' }), retryMs: null, offset: 0 },
    ];
    const fetchImpl = vi.fn(async (): Promise<Response> => sseStreamResponse(200, frames));
    const svc = buildService('stream', fetchImpl);

    const events: ExecutionEvent[] = [];
    const handle = svc.start(SNAPSHOT, (e) => events.push(e));
    const result = await handle.done();
    expect(result.error).not.toBeNull();

    const failedNodeEvent = events.find(
      (e): e is Extract<ExecutionEvent, { type: 'node-status-changed' }> =>
        e.type === 'node-status-changed' && e.nodeId === 'n2' && e.status === 'failed',
    );
    expect(failedNodeEvent).not.toBeUndefined();
    expect(failedNodeEvent!.errorMessage).toBe('模型调用失败');

    const finished = events.find(
      (e): e is Extract<ExecutionEvent, { type: 'run-finished' }> => e.type === 'run-finished' && e.outcome === 'failed',
    );
    expect(finished).not.toBeUndefined();
    expect(finished!.failedNodeId).toBe('n2');
  });

  it('SSE 401 时调用 auth.refresh，成功后重试 1 次', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      callCount += 1;
      if (callCount < 2) return jsonResponse(401, { code: 401, message: 'token expired' });
      const frames: SseRawEvent[] = [
        { id: '1', event: 'workflow-started', data: JSON.stringify({ run_id: 'r1', order: [] }), retryMs: null, offset: 0 },
        { id: '2', event: 'done', data: JSON.stringify({ run_id: 'r1', outcome: 'success' }), retryMs: null, offset: 0 },
      ];
      return sseStreamResponse(200, frames);
    });
    const auth = createAuthProvider({
      storage: new InMemoryStorage(),
      nowMs: () => 1_700_000_000_000,
    });
    // 手动写一个"过期 token + 有 refreshToken"，方便 refresh 不抛
    auth.setToken({ accessToken: 'expired', refreshToken: 'r', expiresAtSec: Math.floor(Date.now() / 1000) + 3600 });
    const spyRefresh = vi.spyOn(auth, 'refresh');

    const svc = new HttpSseExecutionService({
      name: 'auth-test',
      mode: 'stream',
      baseUrl: 'https://api.example.com',
      httpClient: createHttpClient({ fetchImpl, retryBaseDelayMs: 0, retries: 0 }),
      fetchImpl,
      auth,
      maxRefreshAttemptsFor401: 2,
      sse: { idleTimeoutMs: 0, reconnectPolicy: 'never', maxReconnects: 0, reconnectBaseDelayMs: 0 },
    });
    const events: ExecutionEvent[] = [];
    const handle = svc.start(SNAPSHOT, (e) => events.push(e));
    const result = await handle.done();
    expect(result.error).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(spyRefresh).toHaveBeenCalled();
  });

  it('cancel() 主动终止：最终 run-finished.reason="已取消"', async () => {
    const fetchImpl: FetchLike = (_u, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('abort', 'AbortError'));
        });
      });
    const svc = buildService('stream', fetchImpl);
    const events: ExecutionEvent[] = [];
    const handle = svc.start(SNAPSHOT, (e) => events.push(e));
    handle.cancel();
    const res = await handle.done();
    expect(res.error).toBe('已取消');
    const finished = events.find(
      (e): e is Extract<ExecutionEvent, { type: 'run-finished' }> => e.type === 'run-finished',
    );
    expect(finished).not.toBeUndefined();
    expect(finished!.outcome).toBe('cancelled');
  });
});

describe('HttpSseExecutionService sync 模式', () => {
  it('POST /run 一次性返回 body → 发出 run-started + run-finished，outputs = body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { answer: 42 }));
    const svc = buildService('sync', fetchImpl);
    const events: ExecutionEvent[] = [];
    const handle = svc.start(SNAPSHOT, (e) => events.push(e));
    const res = await handle.done();
    expect(res.error).toBeNull();
    expect(res.outputs).toEqual({ answer: 42 });
    const started = events.find((e) => e.type === 'run-started');
    const finished = events.find((e) => e.type === 'run-finished');
    expect(started).not.toBeUndefined();
    expect(finished).not.toBeUndefined();
    expect((finished as Extract<ExecutionEvent, { type: 'run-finished' }>).outcome).toBe('success');
  });

  it('429 + Retry-After(body.retry_after_ms=10) → handle.done resolve 为 error 非空（retries=0，不做普通重试）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { retry_after_ms: 10, message: 'rate limited' }),
    );
    const svc = buildService('sync', fetchImpl);
    const handle = svc.start(SNAPSHOT, () => {});
    const result = await handle.done();
    expect(result.error).not.toBeNull();
    expect(result.error).toContain('HTTP 429');
  });
});

describe('HttpSseExecutionService async 模式', () => {
  it('POST /async_run → 轮询 /task/{taskId} 直到 success', async () => {
    let pollCount = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/async_run')) {
        expect(init?.method).toBe('POST');
        return jsonResponse(200, { task_id: 't-1' });
      }
      // /task/t-1 第 1 次返回 running；第 2 次返回 success
      pollCount += 1;
      if (pollCount === 1) {
        return jsonResponse(200, { status: 'running', progress: 0.5, wait_ms: 1 });
      }
      return jsonResponse(200, { status: 'success', result: { out: 'final' } });
    });
    const svc = buildService('async', fetchImpl);
    const events: ExecutionEvent[] = [];
    const handle = svc.start(SNAPSHOT, (e) => events.push(e));
    const res = await handle.done();
    expect(res.error).toBeNull();
    // 应有 progress 消息
    const progress = events.find(
      (e): e is Extract<ExecutionEvent, { type: 'workflow-message' }> =>
        e.type === 'workflow-message' && e.category === 'progress',
    );
    expect(progress).not.toBeUndefined();
    expect(progress!.progress).toBe(0.5);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // submit + 2 polls
  });
});

describe('HttpSseExecutionService adapter 自定义', () => {
  it('adaptSseEvent 被调用，覆盖默认映射', async () => {
    const frames: SseRawEvent[] = [
      { id: '1', event: 'message', data: JSON.stringify({ stream_id: 's1', is_finish: true, is_last_msg: true, is_last_packet_in_msg: true, content: '' }), retryMs: null, offset: 0 },
    ];
    const fetchImpl = vi.fn(async (): Promise<Response> => sseStreamResponse(200, frames));
    const myAdapter = {
      adaptSseEvent: vi.fn(async () => [{ type: 'workflow-message' as const, category: 'custom', content: 'hi' }]),
    };
    const httpClient = createHttpClient({ fetchImpl, retryBaseDelayMs: 0, retries: 0 });
    const svc = new HttpSseExecutionService({
      mode: 'stream',
      baseUrl: 'https://api.example.com',
      httpClient,
      fetchImpl,
      adapter: myAdapter,
      sse: { idleTimeoutMs: 0, reconnectPolicy: 'never', maxReconnects: 0, reconnectBaseDelayMs: 0 },
    });
    const events: ExecutionEvent[] = [];
    const handle = svc.start(SNAPSHOT, (e) => events.push(e));
    await handle.done();
    expect(myAdapter.adaptSseEvent).toHaveBeenCalled();
    const msg = events.find(
      (e): e is Extract<ExecutionEvent, { type: 'workflow-message' }> =>
        e.type === 'workflow-message' && e.category === 'custom',
    );
    expect(msg).not.toBeUndefined();
  });
});
