/**
 * NativeBridge：桌面端与 Web 环境统一的「少量原生能力」抽象层。
 *
 * 隔离保障（Vercel 侧零副作用、零静态依赖 @tauri-apps 主包）：
 *  - 本文件不出现任何 `import ... from '@tauri-apps/...'` 静态导入；
 *  - 桌面端实现只走 `await import('@tauri-apps/plugin-xxx')`，在 Vite 构建中被拆成独立懒加载 chunk，
 *    只有真的 detectRuntime().tauri === true 时才会被加载；
 *  - Web fallback 的三条能力全部基于标准 DOM / BOM API，任何环境不抛错。
 */

import { detectRuntime } from './runtimeEnv';

/** 选到的本地文件：name + 原始 JSON 文本内容；Web fallback 没有 path，desktop 额外带 path。 */
export interface NativeFileContent {
  readonly name: string;
  readonly content: string;
  readonly path?: string;
}

/**
 * 统一桥接接口；当前暴露 3 项能力，扩展时加方法即可。
 * 所有方法均为 async（即使 Web fallback 内部同步，也包装成 Promise，保持调用方一致）。
 */
export interface NativeBridge {
  /** 弹出文件选择器，允许选择 .json 文件；返回内容；用户取消则返回 null。 */
  pickJsonFile(): Promise<NativeFileContent | null>;
  /** 弹出保存对话框（或 Web 下模拟下载），把 content 保存为 suggestedName。成功 = true。 */
  saveJsonFile(suggestedName: string, content: string): Promise<boolean>;
  /** 用系统默认浏览器打开外链（桌面端），或 tab 打开（Web fallback）。 */
  openExternal(url: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────
// Web fallback：任何浏览器环境可用；node / no-dom 环境下 no-op 且不抛错
// ─────────────────────────────────────────────────────────────────────────

function hasDoc(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

export const webBridge: NativeBridge = {
  async pickJsonFile(): Promise<NativeFileContent | null> {
    if (!hasDoc()) return null;
    return await new Promise((resolve) => {
      try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.multiple = false;
        const done = (f: File | null) => {
          input.removeEventListener('change', onchange);
          if (!f) { resolve(null); return; }
          const reader = new FileReader();
          reader.onerror = () => resolve(null);
          reader.onload = () => {
            const text = typeof reader.result === 'string' ? reader.result : '';
            resolve({ name: f.name, content: text });
          };
          reader.readAsText(f);
        };
        const onchange = () => {
          const f = (input.files?.[0] ?? null) as File | null;
          done(f);
        };
        input.addEventListener('change', onchange);
        // Click only if we have an interactive environment; tests dispatch change manually
        if (typeof input.click === 'function') {
          try { input.click(); } catch { /* ignore environment restrictions */ }
        }
      } catch {
        resolve(null);
      }
    });
  },

  async saveJsonFile(suggestedName: string, content: string): Promise<boolean> {
    if (!hasDoc()) return false;
    try {
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName.endsWith('.json') ? suggestedName : `${suggestedName}.json`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // let the event loop tick so the download starts before revocation
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch {
      return false;
    }
  },

  async openExternal(url: string): Promise<void> {
    if (typeof window === 'undefined' || typeof window.open !== 'function') return;
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch { /* ignore */ }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Desktop (Tauri) 实现：按需动态 import
// ─────────────────────────────────────────────────────────────────────────

/** 延迟加载 Tauri 插件；任何一步失败就 fallback 到 webBridge（容错）。 */
async function loadDesktopBridge(): Promise<NativeBridge> {
  try {
    // 显式把这几个 import 放在函数体内 → Vite 会拆为独立懒加载 chunk
    const [dialog, fs, opener] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
      import('@tauri-apps/plugin-opener'),
    ]);

    return {
      async pickJsonFile() {
        try {
          // Tauri 2 dialog.open 返回 string（单选文件路径）或 string[] 或 null
          const picked = await dialog.open({
            multiple: false,
            directory: false,
            filters: [{ name: 'JSON Workflow', extensions: ['json'] }],
          });
          if (!picked || Array.isArray(picked)) return null;
          const path = picked as string;
          // fs.readTextFile 限定在 $DOCUMENT scope 内；超出则抛错，外层 catch → null
          const content = await fs.readTextFile(path);
          const name = path.split(/[\\/]/).pop() ?? 'workflow.json';
          return { name, content, path };
        } catch {
          return null;
        }
      },
      async saveJsonFile(suggestedName: string, content: string) {
        try {
          const defaultName = suggestedName.endsWith('.json') ? suggestedName : `${suggestedName}.json`;
          const saved = await dialog.save({
            defaultPath: defaultName,
            filters: [{ name: 'JSON Workflow', extensions: ['json'] }],
          });
          if (!saved) return false;
          await fs.writeTextFile(saved, content);
          return true;
        } catch {
          return false;
        }
      },
      async openExternal(url: string) {
        try {
          // plugin-opener v2 exports `openUrl(url, openWith?)` for URLs;
          // it does NOT export a generic `open()` function.
          await opener.openUrl(url);
        } catch {
          // fallback: open inside WebView tab
          if (typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        }
      },
    };
  } catch {
    // Tauri 环境中如果某个插件没加载成功（罕见），退回 web fallback
    return webBridge;
  }
}

// 懒加载单例：只在首次 resolveBridge 时真实触发一次动态 import
let cachedDesktop: NativeBridge | null = null;
let loading: Promise<NativeBridge> | null = null;

/**
 * 获得适合当前环境的 NativeBridge：
 *  - Web 环境：同步返回 webBridge（零 await）
 *  - 桌面环境：首次 await 动态加载 Tauri 插件并缓存；加载失败退化为 webBridge
 */
export function resolveBridge(): Promise<NativeBridge> {
  const env = detectRuntime();
  if (!env.tauri) return Promise.resolve(webBridge);
  if (cachedDesktop) return Promise.resolve(cachedDesktop);
  if (loading) return loading;
  loading = loadDesktopBridge().then((b) => {
    cachedDesktop = b;
    loading = null;
    return b;
  });
  return loading;
}

/**
 * 默认桥：同步可用；对于「桌面端强依赖原生能力」的 UI，应 await resolveBridge()
 * 再调用；对于只是走 openExternal 这种 Web fallback 也可用的场景，可直接用
 * defaultBridge（等于 webBridge）且无需 await。
 */
export const defaultBridge: NativeBridge & { asyncResolve: () => Promise<NativeBridge> } = {
  ...webBridge,
  asyncResolve: resolveBridge,
};
