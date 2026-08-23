/**
 * 桌面端自定义标题栏。
 *
 * 隔离原则：
 *  - 在 Web 模式下 detectRuntime().tauri === false → 组件返回 null，零 DOM 输出；
 *  - Tauri window API 通过动态 import('@tauri-apps/api/window') 加载，避免被 Vercel Web 构建
 *    的首屏 chunk 静态包含（配合 App.tsx 的 React.lazy 进一步切分 chunk）。
 *
 * 功能：
 *  - 自定义拖动区（data-tauri-drag-region 语义，按钮区除外）；
 *  - 三窗口按钮：最小化 / 最大化切换 / 关闭；
 *  - 左侧显示桌面端 Badge + 产品名；
 *  - 双击拖动区切换最大化；
 *  - 最大化状态变化时同步图标 + html[data-maximized] 切换布局。
 */
import { useEffect, useMemo, useState } from 'react';
import { Tag } from 'antd';
import { DesktopOutlined } from '@ant-design/icons';
import { detectRuntime, setMaximizedAttr } from '../services/runtimeEnv';

const TITLEBAR_HEIGHT = 36;

type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized?: (cb: () => void) => Promise<() => void>;
};

export default function DesktopTitlebar() {
  const env = detectRuntime();
  const [maximized, setMaximized] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [win, setWin] = useState<TauriWindow | null>(null);

  // useMemo / useState / useEffect 必须全部在任何 early return 之前调用（hooks 规则）。
  const titleStyle = useMemo(
    () => ({ height: TITLEBAR_HEIGHT, lineHeight: `${TITLEBAR_HEIGHT}px` }),
    [],
  );

  useEffect(() => {
    if (!env.tauri) return;
    let alive = true;
    // 动态加载 Tauri API；在生产 web 构建里不会进入此分支（env.tauri=false 早 return）。
    import('@tauri-apps/api/window')
      .then((winMod) => {
        if (!alive) return;
        const current = (winMod.getCurrentWindow as () => TauriWindow)();
        setWin(current);
        setMounted(true);
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
        // 最大化/还原/缩放都会触发 onResized，用它来同步图标状态 + HTML 属性。
        // 注意：个别 Win11 DWM 切换（例如 Win+↑ 最大化、Snapped Layouts）会在 onResized
        // 时 isMaximized() 尚未立刻翻转为 true，因此配合 200ms 防抖 + ResizeObserver 双通道兜底。
        const syncFromTauri = () => {
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
        let syncTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleSync = () => {
          if (syncTimer) clearTimeout(syncTimer);
          syncTimer = setTimeout(syncFromTauri, 200);
        };
        if (typeof current.onResized === 'function') {
          void current
            .onResized(() => scheduleSync())
            .then((off) => {
              void off;
            })
            .catch(() => {
              /* ignore */
            });
        }
        // 额外监听 DOM 侧尺寸变化（作为 Tauri 事件被 DWM 跳过的兜底）
        if (typeof ResizeObserver !== 'undefined' && document.body) {
          const ro = new ResizeObserver(() => scheduleSync());
          ro.observe(document.body);
          // 观察 html 根节点以便窗口从任意方向伸缩都会被捕获
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

  // Web 环境：返回空节点。注意此返回必须在所有 hook 调用之后，不能影响 hooks 调用顺序。
  if (!env.tauri) return null;

  const badgeColor = 'purple';

  // 双击标题栏 -> 切换最大化（模拟原生标题栏行为）。
  const onDoubleClick = () => {
    if (!win) return;
    void win.toggleMaximize().then(() =>
      win.isMaximized().then((v) => {
        setMaximized(v);
        setMaximizedAttr(v);
      }),
    );
  };

  const onMin = () => win && void win.minimize();
  const onToggleMax = () => {
    if (!win) return;
    void win.toggleMaximize().then(() =>
      win.isMaximized().then((v) => {
        setMaximized(v);
        setMaximizedAttr(v);
      }),
    );
  };
  const onClose = () => win && void win.close();

  // 「已挂载」才渲染按钮；在按钮上不绑 drag-region，确保可以点击。
  const controls = mounted ? (
    <div className="desktop-titlebar__controls">
      <button
        type="button"
        className="desktop-titlebar__btn desktop-titlebar__btn--min"
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
        className="desktop-titlebar__btn desktop-titlebar__btn--max"
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
        className="desktop-titlebar__btn desktop-titlebar__btn--close"
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
  ) : null;

  return (
    <div
      data-tauri-drag-region
      data-testid="desktop-titlebar"
      className="desktop-titlebar"
      style={titleStyle}
      onDoubleClick={onDoubleClick}
    >
      <div className="desktop-titlebar__left">
        <Tag
          icon={<DesktopOutlined />}
          color={badgeColor}
          style={{ marginInlineEnd: 10 }}
          data-testid="desktop-titlebar-badge"
        >
          桌面模式{env.tauriVersion ? ` ${env.tauriVersion}` : ''}
        </Tag>
        <span className="desktop-titlebar__title" data-tauri-drag-region>
          AI Workflow Demo
        </span>
      </div>
      <div className="desktop-titlebar__spacer" data-tauri-drag-region />
      {controls}
    </div>
  );
}
