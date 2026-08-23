/**
 * 运行环境探针：仅通过运行时特性判断当前是否处于 Tauri 桌面 WebView。
 *
 * 设计约束（保证 Vercel 首屏零侵入）：
 *  - 本文件不 import 任何 @tauri-apps/* 模块；
 *  - 探测只依赖 `window.__TAURI_INTERNALS__`（由 Tauri 壳在 WebView 启动时写入）。
 */

export type RuntimeTarget = 'web' | 'desktop';

export interface RuntimeEnv {
  readonly target: RuntimeTarget;
  /** 是否检测到 Tauri 桌面壳（等价于 target === 'desktop'） */
  readonly tauri: boolean;
  /** Tauri 元数据版本号；Web 环境下为 undefined */
  readonly tauriVersion?: string;
}

interface TauriInternalsShape {
  metadata?: { version?: string };
}

/**
 * 返回当前运行环境的描述。
 * - 纯浏览器/Vercel/SSR/node 环境 → { target: 'web', tauri: false }
 * - Tauri WebView 环境 → { target: 'desktop', tauri: true, tauriVersion: '2.x.x' }
 *
 * 幂等、无副作用；可在任意时刻（包括 window 不存在时）安全调用。
 */
export function detectRuntime(): RuntimeEnv {
  if (typeof window === 'undefined') {
    return { target: 'web', tauri: false };
  }
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternalsShape };
  const internals = w.__TAURI_INTERNALS__;
  if (internals && typeof internals === 'object') {
    return {
      target: 'desktop',
      tauri: true,
      tauriVersion: internals.metadata?.version ?? '2.x',
    };
  }
  return { target: 'web', tauri: false };
}

/**
 * 在 <html> 上写入 data-runtime / data-maximized 属性，用于 CSS 切换：
 *  - data-runtime="web" 时 .app-window 去 margin/shadow，保持浏览器端全屏视觉；
 *  - data-maximized="1" 时 .app-window 去 margin/radius/shadow。
 *
 * 本函数零依赖 @tauri-apps，可在 entrypoint 直接调用。
 */
export function applyRuntimeDataAttr(): void {
  if (typeof document === 'undefined') return;
  const env = detectRuntime();
  document.documentElement.dataset.runtime = env.target;
  // 最大化属性由 DesktopTitlebar 运行时同步，这里给个安全初值。
  if (document.documentElement.dataset.maximized === undefined) {
    document.documentElement.dataset.maximized = '0';
  }
}

/** 设置最大化属性（供 DesktopTitlebar 调用）。*/
export function setMaximizedAttr(value: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.maximized = value ? '1' : '0';
}

