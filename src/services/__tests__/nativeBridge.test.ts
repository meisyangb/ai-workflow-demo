/**
 * @vitest-environment happy-dom
 * NativeBridge 的 Web fallback 依赖 DOM（document / window / Blob / URL），happy-dom 更轻量
 * 且对 Node 20.18 无 ERR_REQUIRE_ESM 问题。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webBridge, resolveBridge, defaultBridge } from '../nativeBridge';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** 捕获 document.createElement 针对指定标签生成的元素引用（最新一个）。 */
function captureTag<T extends HTMLElement>(tag: 'input' | 'a'): { latest: () => T | undefined; restore: () => void } {
  const orig = document.createElement.bind(document);
  const list: T[] = [];
  type CE = typeof document.createElement;
  const typedMock: (t: Parameters<CE>[0]) => ReturnType<CE> = (t) => {
    const el = orig(t) as T;
    if (t.toLowerCase() === tag) list.push(el);
    return el as ReturnType<CE>;
  };
  const spy = vi.spyOn(document, 'createElement').mockImplementation(typedMock);
  return {
    latest: () => list[list.length - 1],
    restore: () => spy.mockRestore(),
  };
}

describe('webBridge（纯 Web fallback）', () => {
  it('openExternal 调用 window.open 并带 noopener,noreferrer', async () => {
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await webBridge.openExternal('https://example.com/a?x=1');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://example.com/a?x=1', '_blank', 'noopener,noreferrer');
  });

  it('saveJsonFile 创建带 download 属性的 <a>，触发 click，随后异步 revoke', async () => {
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { latest, restore } = captureTag<HTMLAnchorElement>('a');

    const ok = await webBridge.saveJsonFile('w', JSON.stringify({ a: 1 }));
    expect(ok).toBe(true);
    const a = latest();
    expect(a).not.toBeUndefined();
    expect(a!.getAttribute('download')).toBe('w.json');
    // click 被触发：click 方法若原生不存在于 happy-dom，则 stub 也会被调用
    expect(a!.href).toContain('blob:');
    // 完成动作后 <a> 已被 removeChild，body 不残留
    expect(document.body.querySelector('a')).toBeNull();

    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(revoke).toHaveBeenCalledTimes(1);
    restore();
    vi.useRealTimers();
  });

  it('saveJsonFile 若名称已是 .json 结尾保持不变', async () => {
    const { latest, restore } = captureTag<HTMLAnchorElement>('a');
    await webBridge.saveJsonFile('keep.json', '{}');
    expect(latest()?.getAttribute('download')).toBe('keep.json');
    restore();
  });

  it('pickJsonFile 在模拟用户 change 事件后返回 {name, content}', async () => {
    const { latest, restore } = captureTag<HTMLInputElement>('input');
    const p = webBridge.pickJsonFile();
    const input = latest();
    expect(input).not.toBeUndefined();
    expect(input!.type).toBe('file');
    expect(input!.accept).toMatch(/json/);

    const file = new File([JSON.stringify({ nodes: [] })], 'demo.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', {
      value: [file],
      writable: false,
      configurable: true,
    });
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    const res = await p;
    expect(res).toMatchObject({ name: 'demo.json', content: JSON.stringify({ nodes: [] }) });
    restore();
  });

  it('pickJsonFile 若用户取消/未选文件返回 null', async () => {
    const { latest, restore } = captureTag<HTMLInputElement>('input');
    const p = webBridge.pickJsonFile();
    const input = latest();
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await p).toBeNull();
    restore();
  });
});

describe('resolveBridge() — 环境切换', () => {
  it('Web 环境直接 resolve 到 webBridge（不触发动态 import）', async () => {
    // @ts-expect-error - ensure clean window
    delete globalThis.window.__TAURI_INTERNALS__;
    const b = await resolveBridge();
    expect(b).toBe(webBridge);
    // defaultBridge.asyncResolve 也返回同一个
    expect(await defaultBridge.asyncResolve()).toBe(webBridge);
  });

  it('window.open 缺失时 openExternal 不抛错（容错分支）', async () => {
    const w = window as unknown as { open: typeof window.open | undefined };
    const orig = w.open;
    w.open = undefined;
    await expect(webBridge.openExternal('http://x')).resolves.toBeUndefined();
    w.open = orig;
  });
});
