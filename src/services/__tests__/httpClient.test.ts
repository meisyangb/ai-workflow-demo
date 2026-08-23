import { describe, it, expect, vi } from 'vitest';
import {
  createHttpClient,
  HttpError,
  HttpErrorCode,
  HttpMethod,
  type FetchLike,
  type HttpClientOptions,
} from '../httpClient';

/** 构造 JSON 响应 */
function jsonResponse(status: number, data: unknown): Response {
  return new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 构造一个永不主动 resolve、仅在被 abort 时拒绝的挂起请求（用于超时测试） */
function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
}

/** 创建注入 mock fetch 的客户端（重试延迟 0，避免拖慢测试） */
function createClient(fetchImpl: FetchLike, options: HttpClientOptions = {}) {
  const fetchMock = vi.fn(fetchImpl);
  const client = createHttpClient({
    fetchImpl: fetchMock,
    retryBaseDelayMs: 0,
    ...options,
  });
  return { client, fetchMock };
}

describe('httpClient 基础请求', () => {
  it('GET 成功：返回 status 与反序列化后的 data', async () => {
    const { client, fetchMock } = createClient(() =>
      Promise.resolve(jsonResponse(200, { ok: true, list: [1, 2] })),
    );

    const res = await client.get<{ ok: boolean; list: number[] }>('/workflows');

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true, list: [1, 2] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET 成功：透传 url 与 method 到 fetch', async () => {
    const { client, fetchMock } = createClient(() => Promise.resolve(jsonResponse(200, {})));

    await client.get('/workflows/1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/workflows/1');
    expect(init?.method).toBe(HttpMethod.GET);
  });

  it('POST：body 自动 JSON 序列化并设置 Content-Type', async () => {
    const { client, fetchMock } = createClient(() => Promise.resolve(jsonResponse(201, { id: 'x' })));

    const res = await client.post('/workflows', { name: 'demo' });

    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe(HttpMethod.POST);
    expect(init?.body).toBe(JSON.stringify({ name: 'demo' }));
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('baseUrl 拼接：相对路径拼到 baseUrl 后，斜杠不重复', async () => {
    const { client, fetchMock } = createClient(() => Promise.resolve(jsonResponse(200, {})), {
      baseUrl: 'https://api.example.com/v1/',
    });

    await client.get('/workflows');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/workflows');
  });

  it('完整 URL 不拼接 baseUrl', async () => {
    const { client, fetchMock } = createClient(() => Promise.resolve(jsonResponse(200, {})), {
      baseUrl: 'https://api.example.com',
    });

    await client.get('https://other.example.com/health');

    expect(fetchMock.mock.calls[0][0]).toBe('https://other.example.com/health');
  });

  it('默认 headers 与请求级 headers 合并（请求级优先）', async () => {
    const { client, fetchMock } = createClient(() => Promise.resolve(jsonResponse(200, {})), {
      defaultHeaders: { Authorization: 'Bearer token', 'X-Trace': 'default' },
    });

    await client.post('/run', {}, { headers: { 'X-Trace': 'override' } });

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token');
    expect(headers.get('X-Trace')).toBe('override');
  });

  it('204 与空响应体：data 为 null', async () => {
    const noContent = createClient(() => Promise.resolve(new Response(null, { status: 204 })));
    const emptyBody = createClient(() => Promise.resolve(new Response('', { status: 200 })));

    await expect(noContent.client.delete('/workflows/1')).resolves.toEqual({ status: 204, data: null });
    await expect(emptyBody.client.get('/ping')).resolves.toEqual({ status: 200, data: null });
  });
});

describe('httpClient 错误处理', () => {
  it('4xx：抛 HttpError（code/status/body），且不重试', async () => {
    const { client, fetchMock } = createClient(() =>
      Promise.resolve(jsonResponse(404, { message: 'not found' })),
    );

    const err = await client.get('/workflows/404').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe(HttpErrorCode.BAD_STATUS);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).body).toEqual({ message: 'not found' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 4xx 不重试
  });

  it('5xx：按指数退避重试，重试后成功', async () => {
    let calls = 0;
    const { client } = createClient(() => {
      calls++;
      return calls === 1
        ? Promise.resolve(jsonResponse(500, { error: 'boom' }))
        : Promise.resolve(jsonResponse(200, { recovered: true }));
    });

    const res = await client.get('/flaky');

    expect(res.data).toEqual({ recovered: true });
    expect(calls).toBe(2);
  });

  it('5xx：重试耗尽后抛最后一次的 HttpError', async () => {
    const { client, fetchMock } = createClient(() => Promise.resolve(jsonResponse(503, {})), {
      retries: 2,
    });

    const err = await client.get('/down').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 次原始 + 2 次重试
  });

  it('网络错误：重试后成功', async () => {
    let calls = 0;
    const { client } = createClient(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(jsonResponse(200, { ok: 1 }));
    });

    const res = await client.get('/flaky-network');

    expect(res.data).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it('网络错误：包装为 HttpError（code=NETWORK_ERROR）', async () => {
    const { client } = createClient(() => Promise.reject(new TypeError('fetch failed')), { retries: 0 });

    const err = await client.get('/dead').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe(HttpErrorCode.NETWORK_ERROR);
    expect((err as HttpError).status).toBeNull();
  });

  it('超时：抛 HttpError（code=TIMEOUT）', async () => {
    const { client } = createClient(hangingFetch(), { timeoutMs: 20, retries: 0 });

    const err = await client.get('/slow').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe(HttpErrorCode.TIMEOUT);
  });

  it('成功状态但响应体非 JSON：抛 HttpError（code=PARSE_ERROR）', async () => {
    const { client } = createClient(() => Promise.resolve(new Response('<html>not json</html>', { status: 200 })));

    const err = await client.get('/bad-json').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe(HttpErrorCode.PARSE_ERROR);
    expect((err as HttpError).status).toBe(200);
  });
});
