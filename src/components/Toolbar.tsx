/**
 * 顶部工具栏（扣子 Coze 工作流风格 v0.3.1）
 *
 * 设计要点（对齐扣子工作流编辑页）：
 * 1. 深紫主色（扣子品牌色 #6032ff）：顶栏背景深紫渐变，文字反白
 * 2. 左侧面包屑：我的空间 / 工作流 / 当前草稿，提供层级信息
 * 3. 桌面端窗口控件通过 React.lazy 动态引入，保持 Vercel 零引用
 * 4. 布局为水平一行：
 *        左 = Logo 块 + 面包屑（草稿 tag），整行启用 data-tauri-drag-region
 *        右 = 最小化 / 最大化 / 关闭 三按钮（绝对定位在 wrapper 右上角）
 * 5. 撤销 / 重做 / 更多 / 保存草稿 / 调试 / 发布 / 节点连线统计
 *    已迁移到画布区域顶部中央（CanvasActionBar），不再与标题栏放一起。
 */

import { lazy, Suspense, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Tag, Breadcrumb } from 'antd';
import {
  ApartmentOutlined,
  CloudOutlined,
  FileTextOutlined,
  HomeOutlined,
} from '@ant-design/icons';
import { detectRuntime } from '../services/runtimeEnv';

// 🔴 Vercel 隔离关键：桌面端窗口控件必须走 React.lazy 动态 import，
// 确保 Vercel 首屏 chunk 不会包含 @tauri-apps 相关代码串。
const WindowControls = lazy(() =>
  import(
    /* webpackChunkName: "window-controls" */
    './WindowControls'
  ).then((m) => ({ default: m.default })),
);

// ===== 扣子配色 =====
const COZE_PURPLE = '#6032ff';
const COZE_ORANGE = '#ff7a45';

// ===== 顶栏整体（水平一行布局）=====
// 按用户最新要求：把「Logo + 面包屑」和「控制窗口」合并到同一行。
// 左侧放信息（Logo 块 / 面包屑 / 草稿 tag），右侧绝对定位窗口三按钮。
// 由于业务按钮已全部移到画布操作条，行上再无与拖动冲突的交互控件，
// 因此整行可直接标记为 data-tauri-drag-region。
const toolbarWrapperStyle: CSSProperties = {
  padding: '8px 16px',
  background: `linear-gradient(180deg, #5b2bf0 0%, ${COZE_PURPLE} 100%)`,
  color: '#fff',
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 14,
  minWidth: 0,
  width: '100%',
  minHeight: 50,
  boxSizing: 'border-box',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  boxShadow:
    '0 1px 2px rgba(0,0,0,0.1), 0 0 0 1px rgba(255,255,255,0.04) inset',
  flexShrink: 0,
  position: 'relative',
  zIndex: 10,
};

// 旧的行1（纯拖行 34px）：合并为一行后不再需要，保留引用以便后续切回
// const titleDragRowStyle: CSSProperties = { ... };

// 水平单行：左侧信息条承载区（Logo + 面包屑）
const contentRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  flexWrap: 'nowrap',
  gap: 14,
  minWidth: 0,
  flex: '1 1 auto',
  paddingRight: 140, // 给右侧窗口三按钮预留空间（46*3≈138），防止面包屑被遮住
  boxSizing: 'border-box',
  position: 'relative',
  zIndex: 1,
};

// 光斑装饰
const glowDecor: CSSProperties = {
  position: 'absolute',
  right: -80,
  top: -80,
  width: 260,
  height: 260,
  borderRadius: '50%',
  background:
    'radial-gradient(circle, rgba(255,122,69,0.25) 0%, rgba(96,50,255,0) 70%)',
  pointerEvents: 'none',
  zIndex: 0,
};

const logoBlockStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '2px 10px 2px 2px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.08)',
  backdropFilter: 'blur(8px)',
  flexShrink: 0,
  border: '1px solid rgba(255,255,255,0.12)',
};

// 注意：行1拖行已不再显示左侧标题文字（用户要求"不要这个"），
// logoChip 仅在行2 Logo 块中使用。
const logoChipStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  background: `linear-gradient(135deg, ${COZE_ORANGE} 0%, #ffa940 100%)`,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  boxShadow: '0 2px 6px rgba(255,122,69,0.35)',
};

// 拖行左侧 logo 小图标（仅在行1有装饰时使用，当前隐藏，保留定义便于未来切回）
// const dragRowLogoChipStyle: CSSProperties = { ... };

const logoTextStyle: CSSProperties = {
  fontSize: 14.5,
  fontWeight: 700,
  letterSpacing: 0.3,
  color: '#fff',
  whiteSpace: 'nowrap',
};

const draftTagStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.12)',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.2)',
  padding: '1px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
  marginLeft: 4,
};

// 面包屑中的 Tag 可复用 draftTagStyle（下方已定义）。
// 旧「行1拖行标题文字」样式因合并为单行不再使用，保留引用以防回退
// const dragRowTitleStyle: CSSProperties = { ... };

export default function Toolbar() {
  const dragRowRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ===== 桌面端：双击顶栏切换最大化 =====
  // 合并一行后，dragRowRef 绑定到内容行（整个顶栏都带 data-tauri-drag-region），
  // 双击与拖动在同一个元素上生效，和原生窗口标题栏行为一致。
  useEffect(() => {
    if (!detectRuntime().tauri) return;
    const el = dragRowRef.current ?? wrapperRef.current;
    if (!el) return;
    const onDbl = () => {
      void import('@tauri-apps/api/window')
        .then((m) => m.getCurrentWindow())
        .then((w) => w.toggleMaximize())
        .catch(() => {
          /* ignore */
        });
    };
    el.addEventListener('dblclick', onDbl);
    return () => el.removeEventListener('dblclick', onDbl);
  }, []);

  return (
    <div
      style={toolbarWrapperStyle}
      ref={wrapperRef}
      data-testid="toolbar-wrapper"
    >
      <span style={glowDecor} aria-hidden />

      {/* 合并后的单行：左=Logo 块+面包屑，右=绝对定位的窗口三按钮。
           行内的 logoChip / Draft tag / Breadcrumb 链接自身是非拖拽子元素，
           但在用户明确希望整行参与拖动的前提下（业务按钮已全部移到画布），
           整行带 data-tauri-drag-region 更贴近原生窗口标题栏体验。 */}
      <div
        style={contentRowStyle}
        ref={dragRowRef}
        data-tauri-drag-region
        data-testid="toolbar-drag-row"
        aria-label="窗口拖动区 / 顶部信息区"
      >
        <div style={logoBlockStyle}>
          <span style={logoChipStyle}>
            <ApartmentOutlined style={{ fontSize: 15 }} />
          </span>
          <span style={logoTextStyle}>AI Workflow</span>
          <Tag style={draftTagStyle}>Demo</Tag>
        </div>

        <Breadcrumb
          style={{
            color: 'rgba(255,255,255,0.85)',
            fontSize: 12.5,
            minWidth: 0,
            flex: '0 1 auto',
            overflow: 'hidden',
          }}
          separator={
            <span style={{ color: 'rgba(255,255,255,0.4)' }}>/</span>
          }
          items={[
            {
              title: (
                <span
                  style={{
                    color: 'rgba(255,255,255,0.8)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <HomeOutlined />
                  我的空间
                </span>
              ),
            },
            {
              title: (
                <span
                  style={{
                    color: 'rgba(255,255,255,0.85)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <CloudOutlined />
                  工作流
                </span>
              ),
            },
            {
              title: (
                <span
                  style={{
                    color: '#fff',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <FileTextOutlined />
                  未命名工作流
                  <Tag
                    style={{
                      marginLeft: 6,
                      background: 'rgba(255,255,255,0.15)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.2)',
                      padding: '0 5px',
                      fontSize: 10,
                    }}
                  >
                    草稿
                  </Tag>
                </span>
              ),
            },
          ]}
        />
      </div>

      {/* 窗口控件：三按钮绝对定位在紫色块右上角，高度与 wrapper 总高度一致
          —— 现在合并为单行，按钮与 Logo/面包屑共享同一垂直行，视觉上是一行。 */}
      <div className="toolbar__window-controls">
        <Suspense fallback={null}>
          <WindowControls />
        </Suspense>
      </div>
    </div>
  );
}

// 为历史文件保留旧别名（避免其他 import 侧用到时直接破构建）
export {};
