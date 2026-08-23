/**
 * 桌面端窗口控件（最小化 / 最大化切换 / 关闭）。
 *
 * 设计说明：
 *  - v0.3.1 之前是整行「自定义标题栏（DesktopTitlebar）」独立显示在 Toolbar 之上，
 *    包含"桌面模式"Tag + 产品名 + 拖动区 + 三按钮。用户反馈要精简，直接把三按钮
 *    放到 Toolbar 紫色块的右上角。
 *  - 该组件仅返回「三个按钮」，不包含标题文字、拖动区。拖动区由外层容器
 *    （Toolbar 整块深紫 div）用 `data-tauri-drag-region` 声明，本组件按钮区
 *    **不**带 drag-region，保证可以点击。
 *  - Vercel 隔离：detectRuntime().tauri === false 返回 null；Tauri API 动态 import。
 */
import { useEffect, useState } from 'react';
import { detectRuntime, setMaximizedAttr } from '../services/runtimeEnv';

type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized?: (cb: () => void) => Promise<() => void>;
};

export default function WindowControls() {
  const env = detectRuntime();
  const [maximized, setMaximized] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [win, setWin] = useState<TauriWindow | null>(null);

  useEffect(() => {
    if (!env.tauri) return;
    let alive = true;
    void import('@tauri-apps/api/window')
      .then((winMod) => {
        if (!alive) return;
        const current = (winMod.getCurrentWindow as () => TauriWindow)();
        setWin(current);
        setMounted(true);
        const syncMax = () => {
          void current
            .isMaximized()
            .then((v) => {
              if (alive) {
                setMaximized(v);
                setMaximizedAttr(v);
              }
            })
            .catch(() => {
              /* ignore */
            });
        };
        void syncMax();
        // Win+↑/Snapped Layouts 触发 onResized 偶发延迟同步，防抖 200ms
        let t: ReturnType<typeof setTimeout> | null = null;
        const scheduleSync = () => {
          if (t) clearTimeout(t);
          t = setTimeout(syncMax, 200);
        };
        if (typeof current.onResized === 'function') {
          void current
            .onResized(scheduleSync)
            .then((off) => {
              void off;
            })
            .catch(() => {
              /* ignore */
            });
        }
        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(scheduleSync);
          if (document.body) ro.observe(document.body);
          if (document.documentElement) ro.observe(document.documentElement);
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      alive = false;
    };
  }, [env.tauri]);

  // Web 环境：不渲染任何控件（浏览器/Vercel 有自己的窗口按钮）
  if (!env.tauri) return null;
  if (!mounted || !win) {
    // 在 Tauri 窗口但 API 还没 ready：占位保持宽度，避免首屏主按钮被后续布局推到左边
    return <div className="window-controls window-controls--placeholder" aria-hidden />;
  }

  const syncAfterToggle = () => {
    void win
      .isMaximized()
      .then((v) => {
        setMaximized(v);
        setMaximizedAttr(v);
      })
      .catch(() => {
        /* ignore */
      });
  };

  const onMin = () => void win.minimize();
  const onToggleMax = () => void win.toggleMaximize().then(syncAfterToggle);
  const onClose = () => void win.close();

  // 注意：这里**不写** data-tauri-drag-region，确保按钮可以接收点击事件
  return (
    <div className="window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="window-controls__btn window-controls__btn--min"
        onClick={onMin}
        aria-label="最小化"
        title="最小化"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" width="12" height="12">
          <rect x="1" y="5.5" width="10" height="1" rx="0.5" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="window-controls__btn window-controls__btn--max"
        onClick={onToggleMax}
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" aria-hidden="true" width="12" height="12">
            <path
              d="M3 2h6a1 1 0 0 1 1 1v1h-1V3H4v4H2V3a1 1 0 0 1 1-1Zm2 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm0 1v5h5V6H5Z"
              fill="currentColor"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" aria-hidden="true" width="12" height="12">
            <rect
              x="1.5"
              y="1.5"
              width="9"
              height="9"
              rx="0.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-controls__btn window-controls__btn--close"
        onClick={onClose}
        aria-label="关闭"
        title="关闭"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" width="12" height="12">
          <path
            d="M2 2l8 8M10 2L2 10"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
