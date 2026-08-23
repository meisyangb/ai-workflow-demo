/**
 * 左侧节点面板（扣子 Coze 工作流风格 v0.3.1）
 *
 * 设计要点：
 * 1. 顶部搜索框：按节点 label / description / category 模糊过滤
 * 2. 七大分类：从 CATEGORY_META 取颜色，左边 3px 色条 + 可折叠展开
 * 3. 节点卡片：图标色块 + 标题 + 描述（hover 上浮阴影）
 * 4. 拖拽：同时支持 HTML5 DnD（Web）与桌面端 simulatedDrag 兜底
 * 5. 数据全部来自 NODE_METAS + CATEGORY_META（单点来源，避免漂移）
 * 6. v0.3.1：整体面板可折叠 → 收起为 14px 垂直窄条，给画布留更大工作区
 */

import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Input, Tooltip, Empty } from 'antd';
import {
  SearchOutlined,
  UpOutlined,
  DownOutlined,
  BulbOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons';
import * as Icons from '@ant-design/icons';
import {
  NODE_METAS,
  CATEGORY_META,
  NodeCategory,
  NodeType,
} from '../domains/workflow';
import type { NodeMeta } from '../domains/workflow';
import { beginSimulatedDrag } from '../services/simulatedDrag';
import { detectRuntime } from '../services/runtimeEnv';
import { useWorkflowStore } from '../store/workflowStore';

const { Search } = Input;

// ===== 图标映射（同 CustomNodes，避免再 import 耦合）=====
const ICON_MAP: Record<string, React.ComponentType<{ style?: CSSProperties }>> =
  Icons as unknown as Record<string, React.ComponentType<{ style?: CSSProperties }>>;

function pickIcon(name: string, color = '#fff', size = 14): ReactNode {
  const Comp = ICON_MAP[name];
  if (!Comp) {
    const Fallback = Icons.AppstoreOutlined;
    return <Fallback style={{ color, fontSize: size }} />;
  }
  return <Comp style={{ color, fontSize: size }} />;
}

// ===== 样式常量 =====
const SIDEBAR_WIDTH = 272;
const SIDEBAR_WIDTH_NARROW = 220;
// 折叠时：不再渲染「边边」条。只保留 0 宽占位容器 + 画布边缘的悬浮按钮（用户："只要两个按钮"）。
// 但为了 flex 布局不塌陷、过渡动画顺滑，折叠态使用 0px 宽度/基础宽度 + visible overflow，
// 让唯一的圆形按钮（绝对定位在 right:-12 top:50%）能完全悬浮在画布上。
const SIDEBAR_COLLAPSED_WIDTH = 0;

// 运行时根据 uiSidebarCollapsed 决定宽度与边框、边距等细节
const buildSidebarStyle = (collapsed: boolean): CSSProperties => ({
  flex: collapsed
    ? `0 0 ${SIDEBAR_COLLAPSED_WIDTH}px`
    : `0 0 ${SIDEBAR_WIDTH}px`,
  width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH,
  background: collapsed
    ? 'linear-gradient(180deg, #f5f7fa 0%, #eef2f7 100%)'
    : '#fff',
  borderRight: '1px solid #eef0f3',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  justifyContent: collapsed ? 'flex-start' : 'flex-start',
  minWidth: 0,
  boxSizing: 'border-box',
  height: '100%',
  overflow: collapsed ? 'visible' : 'hidden',
  position: 'relative',
  transition:
    'width 220ms ease, flex-basis 220ms ease, background-color 220ms ease, border-color 220ms ease',
  padding: 0,
  zIndex: collapsed ? 4 : 1,
});

// 折叠态不再需要边条/竖排文字装饰（用户要求"只要两个按钮"）。
// 这里保留历史样式名占位，避免后续大面积搜索替换；不参与渲染。
const _collapsedRailStyle: CSSProperties = { display: 'none' };
const _collapsedRailTextStyle: CSSProperties = { display: 'none' };
// 实际属性访问避免 TS6133（display 是必写字段，必存在）
void _collapsedRailStyle.display;
void _collapsedRailTextStyle.display;

// 侧栏宽度设计常量：正常/窄窗/折叠三种尺寸供 CSS 响应式断点与其它组件复用
export const SIDEBAR_DESIGN_WIDTHS = {
  normal: SIDEBAR_WIDTH,
  narrow: SIDEBAR_WIDTH_NARROW,
  collapsed: SIDEBAR_COLLAPSED_WIDTH,
} as const;
// 引用一次避免 TS6133 / unused（同时保证常量在运行时存在）
void SIDEBAR_DESIGN_WIDTHS.normal;

const headerBlock: CSSProperties = {
  padding: '14px 14px 10px 14px',
  borderBottom: '1px solid #f3f4f6',
  flexShrink: 0,
  background: '#fafbfc',
};

const headerTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: '#1f2937',
  margin: 0,
  marginBottom: 10,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  whiteSpace: 'nowrap',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

// ===== 折叠/展开按钮：位于面板「边界垂直居中」的轮播样式 —— 只有圆形按钮 =====
// 用户："只要两个按钮，不要那个边边" → 去掉所有 Rail/渐变边条/竖排文字，只剩一枚完整圆形按钮。
// Sidebar 按钮悬在画布最左边缘（贴在画布上而不是面板里），视觉独立。
const midRailCollapseBtnStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  right: -12, // 完全悬浮在画布（与面板右缘对齐，按钮一半在面板一半在画布）
  transform: 'translateY(-50%)',
  width: 24,
  height: 24,
  padding: 0,
  borderRadius: '50%', // 完整正圆
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#4b5563',
  cursor: 'pointer',
  border: '1px solid #e5e7eb',
  background: '#ffffff',
  boxShadow: '0 2px 8px rgba(15,23,42,0.14)',
  fontSize: 11,
  zIndex: 7,
  userSelect: 'none',
  lineHeight: 1,
  transition: 'background-color 150ms ease, box-shadow 150ms ease, color 150ms ease, transform 150ms ease',
};

// 按钮 hover：上浮 + 紫边强调
const applyMidBtnHover = (target: HTMLButtonElement, enter: boolean) => {
  if (enter) {
    target.style.background = '#f5f3ff';
    target.style.color = '#6032ff';
    target.style.boxShadow = '0 4px 14px rgba(15,23,42,0.18)';
    target.style.borderColor = '#d8c6ff';
  } else {
    target.style.background = '#ffffff';
    target.style.color = '#4b5563';
    target.style.boxShadow = '0 2px 8px rgba(15,23,42,0.14)';
    target.style.borderColor = '#e5e7eb';
  }
};

const categoryListStyle: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  padding: '6px 0 12px 0',
  scrollbarGutter: 'stable',
};

const categoryRowStyle = (color: string): CSSProperties => ({
  marginBottom: 2,
  borderRadius: 0,
  borderLeft: `3px solid ${color}`,
  background: '#fff',
  cursor: 'pointer',
  transition: 'background-color 120ms ease',
});

const categoryHeaderInner: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 12px 10px 10px',
  userSelect: 'none',
};

const categoryLabelRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
};

const categoryColorDot = (color: string): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: 2,
  background: color,
  flexShrink: 0,
  boxShadow: `0 0 0 2px ${color}22`,
});

const categoryNameStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: '#1f2937',
};

const categoryCountBadge: CSSProperties = {
  fontSize: 11,
  padding: '0 6px',
  height: 16,
  lineHeight: '16px',
  borderRadius: 8,
  background: '#f3f4f6',
  color: '#6b7280',
  fontWeight: 500,
  flexShrink: 0,
};

const nodeGridStyle: CSSProperties = {
  padding: '4px 10px 10px 10px',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))',
  gap: 8,
};

const nodeCardStyle = (_accent: string): CSSProperties => ({
  position: 'relative',
  padding: '10px 10px 9px 10px',
  borderRadius: 8,
  border: '1px solid #eef0f3',
  background: '#fff',
  cursor: 'grab',
  userSelect: 'none',
  transition:
    'transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease, background-color 120ms ease',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
});

const nodeIconChip = (accent: string): CSSProperties => ({
  width: 30,
  height: 30,
  borderRadius: 7,
  background: `linear-gradient(135deg, ${accent} 0%, ${accent}cc 100%)`,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: `0 2px 4px ${accent}33`,
  flexShrink: 0,
});

const nodeTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#1f2937',
  lineHeight: '16px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

const nodeDescStyle: CSSProperties = {
  fontSize: 10.5,
  color: '#9ca3af',
  lineHeight: '14px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  minHeight: 28,
};

const tipBoxStyle: CSSProperties = {
  marginTop: 10,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'linear-gradient(135deg, #f0f5ff 0%, #faf5ff 100%)',
  border: '1px solid #e0e7ff',
  fontSize: 11.5,
  color: '#4b5563',
  lineHeight: 1.65,
};

const tipTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontWeight: 600,
  color: '#6032ff',
  fontSize: 11.5,
  marginBottom: 4,
};

export default function Sidebar() {
  const runtime = detectRuntime();
  const [keyword, setKeyword] = useState('');

  // v0.3.1：面板折叠（画布获得更大横向空间）。状态放到 workflowStore，
  // 与画布顶部操作条/Toolbar 保持同一 UI 源，不入 undo 历史。
  const collapsed = useWorkflowStore((s) => s.uiSidebarCollapsed);
  const toggleCollapsed = useWorkflowStore((s) => s.toggleSidebarCollapsed);

  // 默认展开基础、LLM、逻辑、工具四类；数据/消息/记忆默认收起（减少一次性视觉噪音）
  const [expanded, setExpanded] = useState<Record<NodeCategory, boolean>>({
    [NodeCategory.BASIC]: true,
    [NodeCategory.LLM]: true,
    [NodeCategory.LOGIC]: true,
    [NodeCategory.DATA]: false,
    [NodeCategory.TOOL]: true,
    [NodeCategory.MESSAGE]: false,
    [NodeCategory.MEMORY]: false,
  });

  // ===== 数据处理 =====
  // 1. 按分类分组
  const byCategory = useMemo(() => {
    const map = new Map<NodeCategory, NodeMeta[]>();
    NODE_METAS.forEach((m) => {
      if (!map.has(m.category)) map.set(m.category, []);
      map.get(m.category)!.push(m);
    });
    return map;
  }, []);

  // 2. 过滤关键字（命中 label 或 description 或 category label）
  const filteredByCategory = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const result = new Map<NodeCategory, NodeMeta[]>();
    byCategory.forEach((list, cat) => {
      const catLabel = CATEGORY_META[cat].label.toLowerCase();
      const matched = list.filter((m) => {
        if (!kw) return true;
        return (
          m.label.toLowerCase().includes(kw) ||
          m.description.toLowerCase().includes(kw) ||
          catLabel.includes(kw) ||
          m.type.toLowerCase().includes(kw)
        );
      });
      if (matched.length > 0) result.set(cat, matched);
    });
    return result;
  }, [byCategory, keyword]);

  // 有搜索时：全部展开
  const isExpanded = (cat: NodeCategory): boolean => {
    if (keyword.trim().length > 0) return true;
    return expanded[cat];
  };

  const toggleCategory = (cat: NodeCategory) => {
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  // ===== 拖拽：HTML5 + 桌面端仿真 =====
  const onDragStart = (event: React.DragEvent<HTMLDivElement>, nodeType: NodeType) => {
    event.dataTransfer.setData('application/reactflow-type', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>, nodeType: NodeType) => {
    if (!runtime.tauri) return;
    beginSimulatedDrag(event, nodeType);
  };

  // ===== 渲染分类顺序（按 CATEGORY_META 定义，保证稳定）=====
  const categoryOrder: NodeCategory[] = Object.keys(CATEGORY_META) as NodeCategory[];

  const totalVisibleNodes = Array.from(filteredByCategory.values()).reduce(
    (acc, arr) => acc + arr.length,
    0,
  );

  // 按钮：位于面板右边缘（画布左边界）垂直居中的正圆独立按钮。
  // 语义：折叠态（0 宽）= 把左侧节点面板从画布左边「展开出来」→ RightOutlined（向右展开）
  //       展开态 = 把左侧节点面板「收回到左边」→ LeftOutlined（向左收起）
  const carouselButton = (
    <Tooltip
      title={collapsed ? '展开节点面板' : '收起节点面板（获得更大画布空间）'}
      placement="right"
    >
      <button
        type="button"
        aria-label={collapsed ? '展开节点面板' : '收起节点面板'}
        style={midRailCollapseBtnStyle}
        onClick={(e) => {
          e.stopPropagation();
          toggleCollapsed();
        }}
        onMouseEnter={(e) => applyMidBtnHover(e.currentTarget as HTMLButtonElement, true)}
        onMouseLeave={(e) => applyMidBtnHover(e.currentTarget as HTMLButtonElement, false)}
      >
        {collapsed ? (
          <RightOutlined style={{ fontSize: 10 }} />
        ) : (
          <LeftOutlined style={{ fontSize: 10 }} />
        )}
      </button>
    </Tooltip>
  );

  return (
    <aside
      className={collapsed ? 'app-sidebar is-collapsed' : 'app-sidebar'}
      style={buildSidebarStyle(collapsed)}
      data-collapsed={collapsed}
    >
      {/* ===== 折叠态：完全没有"边边"——只有画布边缘的那一个圆形按钮（用户要求"只要两个按钮"）。
          面板容器在折叠时宽度=0，按钮通过 absolute right:-12 悬在画布最左边缘之上。 */}
      {!collapsed && (
        <>
          {/* 顶部：标题 + 搜索 */}
          <div style={headerBlock}>
            <h3 style={headerTitle}>
              <BulbOutlined style={{ color: '#6032ff' }} />
              节点面板
            </h3>
            <Search
              placeholder="搜索节点 / 分类..."
              allowClear
              size="small"
              prefix={<SearchOutlined style={{ color: '#9ca3af' }} />}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>

      {/* 分类列表 */}
      <div style={categoryListStyle}>
        {totalVisibleNodes === 0 ? (
          <div style={{ padding: '40px 12px' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span style={{ fontSize: 12, color: '#9ca3af' }}>没有匹配「{keyword}」的节点</span>
              }
            />
          </div>
        ) : (
          categoryOrder.map((cat) => {
            const nodes = filteredByCategory.get(cat);
            if (!nodes || nodes.length === 0) return null;
            const meta = CATEGORY_META[cat];
            const open = isExpanded(cat);
            return (
              <div key={cat} style={categoryRowStyle(meta.color)}>
                <div
                  style={categoryHeaderInner}
                  onClick={() => toggleCategory(cat)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') toggleCategory(cat);
                  }}
                >
                  <div style={categoryLabelRow}>
                    <span style={categoryColorDot(meta.color)} />
                    <span style={categoryNameStyle}>{meta.label}</span>
                    <span style={categoryCountBadge}>{nodes.length}</span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      color: '#9ca3af',
                      display: 'inline-flex',
                      alignItems: 'center',
                    }}
                  >
                    {open ? <UpOutlined /> : <DownOutlined />}
                  </span>
                </div>

                {open && (
                  <div style={nodeGridStyle}>
                    {nodes.map((nodeMeta) => {
                      const accent = nodeMeta.accent;
                      return (
                        <Tooltip
                          key={nodeMeta.type}
                          title={
                            <div style={{ maxWidth: 220 }}>
                              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                                {nodeMeta.label}
                              </div>
                              <div style={{ fontSize: 11, opacity: 0.9 }}>
                                {nodeMeta.description}
                              </div>
                            </div>
                          }
                          placement="right"
                          mouseEnterDelay={0.4}
                        >
                          <div
                            style={nodeCardStyle(accent)}
                            draggable
                            onDragStart={(e) => onDragStart(e, nodeMeta.type)}
                            onPointerDown={(e) => onPointerDown(e, nodeMeta.type)}
                            onMouseEnter={(e) => {
                              const el = e.currentTarget;
                              el.style.transform = 'translateY(-1px)';
                              el.style.boxShadow = `0 6px 14px ${accent}22, 0 2px 4px rgba(0,0,0,0.05)`;
                              el.style.borderColor = accent;
                              el.style.background = `linear-gradient(180deg, #fff 0%, ${accent}08 100%)`;
                            }}
                            onMouseLeave={(e) => {
                              const el = e.currentTarget;
                              el.style.transform = '';
                              el.style.boxShadow = '';
                              el.style.borderColor = '';
                              el.style.background = '';
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={nodeIconChip(accent)}>
                                {pickIcon(nodeMeta.icon, '#fff', 15)}
                              </span>
                              <span style={nodeTitleStyle} title={nodeMeta.label}>
                                {nodeMeta.label}
                              </span>
                            </div>
                            <div style={nodeDescStyle} title={nodeMeta.description}>
                              {nodeMeta.description}
                            </div>
                          </div>
                        </Tooltip>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* 底部操作提示 */}
        {totalVisibleNodes > 0 && (
          <div style={{ padding: '0 12px' }}>
            <div style={tipBoxStyle}>
              <div style={tipTitleStyle}>
                <Icons.BulbOutlined />
                使用提示
              </div>
              按住节点卡片拖到画布即可创建。<br />
              <span style={{ color: '#9ca3af' }}>
                · Delete 键删除 &nbsp; · 空格+拖拽平移 &nbsp; · 滚轮缩放
              </span>
            </div>
          </div>
        )}
      </div>
        </>
      )}

      {/* 折叠/展开按钮固定在面板右边缘中点（与折叠态 Rail 的按钮位置对齐）——
          视觉上像轮播图左侧面板「prev」胶囊按钮 */}
      {carouselButton}
    </aside>
  );
}

// 让窄窗响应式 CSS 能覆盖宽度（272 → 220）
export const __SIDEBAR_DESIGN_WIDTH = { normal: SIDEBAR_WIDTH, narrow: SIDEBAR_WIDTH_NARROW };
