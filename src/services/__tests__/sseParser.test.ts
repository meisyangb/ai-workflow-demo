import { describe, it, expect, vi } from 'vitest';
import { parseSseStream, fetchSseStream, SseIdleTimeoutError, SseHttpError } from '../sseParser';
import type { SseRawEvent } from '../../schemas/ssePackets';

/** 把一个 Uint8Array 按给定 chunkSizes 切成多段，模拟网络分片 */
function splitChunks(
  bytes: Uint8Array,
  chunkSizes: number[],
): ReadableStream<Uint8Array> {
  let offset = 0;
  const queue: Uint8Array[] = [];
  for (const size of chunkSizes) {
    if (offset >= bytes.length) break;
    queue.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) queue.push(bytes.slice(offset));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of queue) controller.enqueue(c);
      controller.close();
    },
  });
}

function s(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parseSseStream 基础帧解析', () => {
  it('空 body：返回 0 事件，未报错', async () => {
    const events: SseRawEvent[] = [];
    const stream = splitChunks(new Uint8Array(0), []);
    const stats = await parseSseStream(stream, {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(stats.events).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('单行 data + 默认 event=message', async () => {
    const events: SseRawEvent[] = [];
    const body = 'data: hello world\n\n';
    await parseSseStream(splitChunks(s(body), [body.length]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('message');
    expect(events[0]!.data).toBe('hello world');
    expect(events[0]!.id).toBeNull();
  });

  it('多行 data 按 \n 拼接', async () => {
    const events: SseRawEvent[] = [];
    const body = 'data: line1\ndata: line2\n\n';
    await parseSseStream(splitChunks(s(body), [body.length]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(events[0]!.data).toBe('line1\nline2');
  });

  it('id / event / retry 字段全部赋值', async () => {
    const events: SseRawEvent[] = [];
    const body = 'id: evt-1\nevent: workflow-started\nretry: 3000\ndata: {}\n\n';
    const stats = await parseSseStream(splitChunks(s(body), [body.length]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(events[0]!.id).toBe('evt-1');
    expect(events[0]!.event).toBe('workflow-started');
    expect(events[0]!.retryMs).toBe(3000);
    expect(stats.lastEventId).toBe('evt-1');
    expect(stats.retryMs).toBe(3000);
  });

  it('注释行 :keep-alive 不计数，但作为一次心跳', async () => {
    const events: SseRawEvent[] = [];
    const body = ':keep-alive\n\ndata: ok\n\n';
    const stats = await parseSseStream(splitChunks(s(body), [body.length]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(stats.events).toBe(1);
    expect(events[0]!.data).toBe('ok');
  });

  it('兼容 \r\n 行分隔符', async () => {
    const events: SseRawEvent[] = [];
    const body = 'data: hello\r\n\r\n';
    await parseSseStream(splitChunks(s(body), [body.length]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(events[0]!.data).toBe('hello');
  });

  it('末尾无空行：emitFrame flush 最后一帧', async () => {
    const events: SseRawEvent[] = [];
    const body = 'data: tail';
    await parseSseStream(splitChunks(s(body), [body.length]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('tail');
  });
});

describe('parseSseStream 分片边界', () => {
  it('多行 data + JSON 被跨 chunk 截断 → 解析后 JSON 完整', async () => {
    const events: SseRawEvent[] = [];
    const body = 'data: {"name":"xiaoming","tags":[1,2,3]}\n\n';
    const bytes = s(body);
    // 切分在 JSON 中间（第 10 字节、第 20 字节...）
    await parseSseStream(splitChunks(bytes, [10, 10, 10, 100]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(events).toHaveLength(1);
    expect(() => JSON.parse(events[0]!.data)).not.toThrow();
    expect(JSON.parse(events[0]!.data)).toEqual({ name: 'xiaoming', tags: [1, 2, 3] });
  });

  it('UTF-8 多字节字符被切分 → 不出现乱码（�）', async () => {
    const events: SseRawEvent[] = [];
    // "中文" 两字每个 3 字节；把切片卡在第一个"中"(E4 B8 AD) 中间
    const body = 'data: 中文中文中文\n\n';
    const bytes = s(body);
    // 找到"中"的起始字节之前的位置：data: 占 6，空格占 1 => 索引 7 开始是 UTF-8 中(E4 B8 AD)
    // 切成 8 字节 + 1 字节 + 1 字节 + 剩余：确保 3 字节的"中"被切成 1+1+1
    await parseSseStream(splitChunks(bytes, [8, 1, 1, bytes.length]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('中文中文中文');
    expect(events[0]!.data.includes('\uFFFD')).toBe(false);
  });

  it('行边界截断：半行跨 chunk → 下一个 chunk 续上', async () => {
    const events: SseRawEvent[] = [];
    // "data: 123456789\n\n" 切为 "data: 123" + "456789\n\n"
    const part1 = 'data: 123';
    const part2 = '456789\n\n';
    const bytes = s(part1 + part2);
    await parseSseStream(splitChunks(bytes, [part1.length, part2.length]), {
      onEvent: (e) => { events.push(e); },
    }, { idleTimeoutMs: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('123456789');
  });
});

describe('parseSseStream 心跳 / 空闲超时', () => {
  it('idleTimeoutMs 内无帧 → 抛错（reader.cancel 触发循环终止）', async () => {
    // 构造一个 ReadableStream：只有 pull 才 produce，pull 永不 resolve → reader.read() 永久 pending
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // start 不做任何事 → 第一次 reader.read() 会等待 pull
      },
      pull() {
        // 返回永久 pending Promise：让 read() 一直阻塞，直到 idle timer 调 reader.cancel
        return new Promise(() => {});
      },
    });
    const events: SseRawEvent[] = [];
    let caught: unknown = null;
    try {
      await parseSseStream(stream, { onEvent: (e) => { events.push(e); } }, { idleTimeoutMs: 20 });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
  }, 10_000);

  it('onBytesChunk 被按 chunk 调用且 offset 递增', async () => {
    const body = 'data: a\n\ndata: b\n\n';
    const bytes = s(body);
    const chunks: Array<{ len: number; offset: number }> = [];
    await parseSseStream(splitChunks(bytes, [3, bytes.length]), {
      onBytesChunk: (buf, off) => { chunks.push({ len: buf.length, offset: off }); },
    }, { idleTimeoutMs: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.offset).toBe(0);
    expect(chunks[1]!.offset).toBeGreaterThan(0);
    expect(chunks.reduce((a, c) => a + c.len, 0)).toBe(bytes.length);
  });
});

describe('fetchSseStream 顶层封装', () => {
  it('200 正常 SSE：回调事件序列，返回 events/bytesRead 统计', async () => {
    const mockFetch = vi.fn(async (): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode('id: 1\nevent: node-token\ndata: {"node_id":"n1","delta":"h"}\n\n'));
          c.enqueue(enc.encode('id: 2\nevent: node-token\ndata: {"node_id":"n1","delta":"i"}\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const events: SseRawEvent[] = [];
    const stats = await fetchSseStream('https://api.example.com/run/stream', {
      onEvent: (e) => { events.push(e); },
    }, { fetchImpl: mockFetch, timeoutMs: 5_000, idleTimeoutMs: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as unknown as [string, RequestInit?];
    expect(call[0]).toBe('https://api.example.com/run/stream');
    expect(new Headers(call[1]?.headers as Record<string, string>).get('Accept')).toBe('text/event-stream');
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe('1');
    expect(events[1]!.id).toBe('2');
    expect(stats.events).toBe(2);
    expect(stats.bytesRead).toBeGreaterThan(10);
  });

  it('401 + body JSON：抛 SseHttpError(status=401, body=parsed)', async () => {
    const mockFetch = vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({ code: 401, msg: 'token expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      await fetchSseStream('https://api.example.com/x', {}, { fetchImpl: mockFetch, idleTimeoutMs: 0 });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SseHttpError);
      const err = e as SseHttpError;
      expect(err.status).toBe(401);
      expect(err.body).toEqual({ code: 401, msg: 'token expired' });
    }
  });

  it('AbortController.abort 终止请求 → 抛 AbortError / SseIdleTimeoutError', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn(async (_u: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('abort', 'AbortError'));
        });
      });
    });
    setTimeout(() => controller.abort(), 10);
    await expect(
      fetchSseStream(
        'https://api.example.com/x',
        {},
        { fetchImpl: ((u: string, init?: RequestInit) => mockFetch(u, { ...init, signal: controller.signal })) as typeof fetch, timeoutMs: 0, idleTimeoutMs: 0 },
      ),
    ).rejects.toThrow();
  }, 5_000);

  it('lastEventId 自动写入 Last-Event-ID header（当无同名 header 时）', async () => {
    const mockFetch = vi.fn(async (_u: string, _init?: RequestInit): Promise<Response> => {
      // 返回一个空的 SSE 流
      const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
      return new Response(body, { status: 200 });
    });
    await fetchSseStream('https://api.example.com/x', {}, {
      fetchImpl: mockFetch,
      lastEventId: 'evt-123',
      idleTimeoutMs: 0,
    });
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers as Record<string, string>);
    expect(headers.get('Last-Event-ID')).toBe('evt-123');
  });
});

// 未触发但保留以防后续扩展：SseIdleTimeoutError 类型断言
void SseIdleTimeoutError;
