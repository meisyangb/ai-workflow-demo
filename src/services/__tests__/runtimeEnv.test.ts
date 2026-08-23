/**
 * @vitest-environment happy-dom
 * 测试 detectRuntime 在不同 window 形态下的表现；happy-dom 对 Node 20.18 无 ESM/CJS 问题。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { detectRuntime } from '../runtimeEnv';

/** 把在 test 运行期间给 globalThis 挂的 window 清理干净，避免污染其它用例 */
function resetWindow() {
  // @ts-expect-error - allow deleting window for tests
  delete globalThis.window;
}

beforeEach(resetWindow);

describe('detectRuntime() 环境探针', () => {
  it('window 不存在（node / SSR）时返回 web', () => {
    resetWindow();
    expect(detectRuntime()).toMatchObject({ target: 'web', tauri: false });
    expect(detectRuntime().tauriVersion).toBeUndefined();
  });

  it('window 无 __TAURI_INTERNALS__（普通浏览器/Vercel）时返回 web', () => {
    // @ts-expect-error - inject minimal window
    globalThis.window = {};
    const env = detectRuntime();
    expect(env.target).toBe('web');
    expect(env.tauri).toBe(false);
  });

  it('window.__TAURI_INTERNALS__ 存在时返回 desktop，并能读出版本', () => {
    // @ts-expect-error - inject tauri-style window
    globalThis.window = { __TAURI_INTERNALS__: { metadata: { version: '2.0.3' } } };
    const env = detectRuntime();
    expect(env.target).toBe('desktop');
    expect(env.tauri).toBe(true);
    expect(env.tauriVersion).toBe('2.0.3');
  });

  it('存在 __TAURI_INTERNALS__ 但 metadata 缺失时，版本兜底为 2.x', () => {
    // @ts-expect-error - inject without metadata
    globalThis.window = { __TAURI_INTERNALS__: {} };
    const env = detectRuntime();
    expect(env.target).toBe('desktop');
    expect(env.tauriVersion).toBe('2.x');
  });

  it('重复调用幂等；结果对象字段只读语义', () => {
    // @ts-expect-error - inject
    globalThis.window = { __TAURI_INTERNALS__: { metadata: { version: '2.0.0' } } };
    const a = detectRuntime();
    const b = detectRuntime();
    expect(a).toStrictEqual(b);
    // 调用不应改动 window 上的字段
    expect((globalThis.window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__)
      .toMatchObject({ metadata: { version: '2.0.0' } });
  });
});
