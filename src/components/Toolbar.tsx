/**
 * 顶部工具栏（扣子 Coze 工作流风格 v0.3.0）
 *
 * 设计要点（对齐扣子工作流编辑页）：
 * 1. 深紫主色（扣子品牌色 #6032ff）：顶栏背景深紫渐变，文字反白
 * 2. 左侧面包屑：我的空间 / 工作流 / 当前草稿，提供层级信息
 * 3. 右侧主按钮组：
 *    - 保存草稿（次按钮，灰色描边白字）
 *    - 调试运行（主按钮，渐变紫）
 *    - 发布（高亮按钮，橙紫渐变，扣子同款「发布」）
 * 4. 次级操作：撤销/重做、导入/导出、清空（放在下拉菜单或图标按钮里）
 * 5. 状态统计：节点数/连线数 —— 右上角做 Pill 徽标
 * 6. 桌面端独有组件继续走 React.lazy，保持 Vercel 零引用
 */

import { lazy, Suspense, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import {
  Button,
  Space,
  Tooltip,
  message,
  Statistic,
  Row,
  Col,
  Dropdown,
  Tag,
  Breadcrumb,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  UndoOutlined,
  RedoOutlined,
  ClearOutlined,
  DownloadOutlined,
  UploadOutlined,
  ReloadOutlined,
  ApartmentOutlined,
  SaveOutlined,
  RocketOutlined,
  BugOutlined,
  MoreOutlined,
  CloudOutlined,
  FileTextOutlined,
  HomeOutlined,
} from '@ant-design/icons';
import { useWorkflowStore } from '../store/workflowStore';

// 🔴 Vercel 隔离关键：桌面端独有组件必须走 React.lazy 动态 import。
const DesktopToolbarExtras = lazy(() =>
  import(
    /* webpackChunkName: "desktop-extras" */
    /* @vite-ignore */
    './DesktopToolbarExtras'
  ).then((m) => ({ default: m.default })),
);

// ===== 扣子配色 =====
const COZE_PURPLE = '#6032ff';
const COZE_PURPLE_DEEP = '#4a22d4';
const COZE_ORANGE = '#ff7a45';
const COZE_PURPLE_GLOW = 'rgba(126, 76, 255, 0.45)';

// ===== 顶栏整体 =====
const toolbarWrapperStyle: CSSProperties = {
  padding: '10px 16px',
  background: `linear-gradient(180deg, #5b2bf0 0%, ${COZE_PURPLE} 100%)`,
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 12,
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  boxShadow: `0 1px 2px rgba(0,0,0,0.1), 0 0 0 1px rgba(255,255,255,0.04) inset`,
  flexShrink: 0,
  position: 'relative',
  zIndex: 10,
};

// 光斑装饰（扣子同款顶栏右上角光晕）
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

const leftBlockStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  flex: '1 1 auto',
  flexWrap: 'wrap',
  gap: 14,
  position: 'relative',
  zIndex: 1,
};

const rightBlockStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexWrap: 'wrap',
  minWidth: 0,
  gap: 8,
  position: 'relative',
  zIndex: 1,
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

const statsPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  padding: '4px 12px',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.1)',
  border: '1px solid rgba(255,255,255,0.14)',
  color: 'rgba(255,255,255,0.9)',
  fontSize: 11.5,
  flexShrink: 0,
};

const statDivider: CSSProperties = {
  width: 1,
  height: 12,
  background: 'rgba(255,255,255,0.18)',
};

// ===== 通用白字按钮（次按钮）=====
const ghostBtn: CSSProperties = {
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.24)',
  background: 'rgba(255,255,255,0.08)',
  height: 32,
  padding: '0 12px',
  borderRadius: 8,
  fontWeight: 500,
  fontSize: 12.5,
  transition: 'all 120ms ease',
};

// ===== 主按钮：调试运行（紫渐变）=====
const debugBtnStyle = (running: boolean): CSSProperties => ({
  color: '#fff',
  border: 0,
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 12.5,
  background: running
    ? 'linear-gradient(135deg, #ff4d4f 0%, #d32029 100%)'
    : `linear-gradient(135deg, ${COZE_PURPLE_DEEP} 0%, ${COZE_PURPLE} 100%)`,
  boxShadow: running
    ? '0 2px 6px rgba(255,77,79,0.4)'
    : `0 2px 8px ${COZE_PURPLE_GLOW}`,
});

// ===== 发布按钮（橙紫渐变，扣子同款）=====
const publishBtnStyle: CSSProperties = {
  color: '#fff',
  border: 0,
  height: 32,
  padding: '0 14px',
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 12.5,
  background: 'linear-gradient(135deg, #ff7a45 0%, #ff4d4f 50%, #6032ff 100%)',
  boxShadow: '0 2px 10px rgba(255,122,69,0.45)',
};

export default function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isRunning = useWorkflowStore((s) => s.isRunning);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const past = useWorkflowStore((s) => s.past);
  const future = useWorkflowStore((s) => s.future);

  const runWorkflow = useWorkflowStore((s) => s.runWorkflow);
  const stopRun = useWorkflowStore((s) => s.stopRun);
  const undo = useWorkflowStore((s) => s.undo);
  const redo = useWorkflowStore((s) => s.redo);
  const resetStatus = useWorkflowStore((s) => s.resetStatus);
  const clearCanvas = useWorkflowStore((s) => s.clearCanvas);
  const exportFlow = useWorkflowStore((s) => s.exportFlow);
  const importFlow = useWorkflowStore((s) => s.importFlow);

  const [msgApi, msgCtx] = message.useMessage();
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);

  // ===== 业务回调 =====
  const onRun = async () => {
    if (nodes.length === 0) {
      msgApi.warning('画布为空，请先添加节点');
      return;
    }
    msgApi.info('开始调试运行（模拟执行）...', 1.5);
    const res = await runWorkflow();
    if (res.error) {
      msgApi.error(res.error);
    } else {
      msgApi.success('调试运行完成，可查看右侧调试输出');
    }
  };

  const onStop = () => {
    stopRun();
    resetStatus();
    msgApi.info('已停止并重置节点状态');
  };

  const onReset = () => {
    resetStatus();
    msgApi.success('已重置所有节点状态');
  };

  const onExport = () => {
    const json = exportFlow();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-draft-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    msgApi.success(`已导出：${nodes.length} 节点 / ${edges.length} 连线`);
  };

  const onImportClick = () => {
    fileInputRef.current?.click();
  };

  const onImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String((ev.target as FileReader)?.result ?? '');
      const res = importFlow(text);
      if (res.error) msgApi.error(res.error);
      else msgApi.success('导入成功，画布已更新');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const onUndo = () => {
    if (past.length === 0) {
      msgApi.info('没有可撤销的操作');
      return;
    }
    undo();
  };

  const onRedo = () => {
    if (future.length === 0) {
      msgApi.info('没有可重做的操作');
      return;
    }
    redo();
  };

  const onClear = () => {
    if (nodes.length === 0) return;
    if (window.confirm('确定清空整个画布吗？此操作可撤销。')) {
      clearCanvas();
      msgApi.info('画布已清空');
    }
  };

  // ===== 模拟扣子的三个主动作 =====
  const onSaveDraft = () => {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      // 我们的导出 JSON 等价于「草稿快照」
      localStorage.setItem(
        'ai-workflow-demo:draft:latest',
        exportFlow(),
      );
      localStorage.setItem(
        'ai-workflow-demo:draft:savedAt',
        new Date().toISOString(),
      );
      msgApi.success('草稿已保存到本地');
    }, 500);
  };

  const onPublish = () => {
    if (nodes.length === 0) {
      msgApi.warning('画布为空，无法发布');
      return;
    }
    setPublishing(true);
    setTimeout(() => {
      setPublishing(false);
      // Demo 环境：无真实后端，所以这里写入 localStorage 模拟版本记录
      const verKey = `publish:v${Date.now()}`;
      localStorage.setItem(verKey, exportFlow());
      const versions = JSON.parse(localStorage.getItem('publish:versions') || '[]');
      versions.push({ key: verKey, at: new Date().toISOString(), nodes: nodes.length });
      localStorage.setItem('publish:versions', JSON.stringify(versions.slice(-20)));
      msgApi.success('发布成功！版本号已写入本地（Demo 模式）');
    }, 900);
  };

  // ===== 更多操作（下拉菜单）=====
  const moreMenuItems: MenuProps['items'] = [
    {
      key: 'import',
      icon: <UploadOutlined />,
      label: '导入 JSON 工作流',
      disabled: isRunning,
      onClick: onImportClick,
    },
    {
      key: 'export',
      icon: <DownloadOutlined />,
      label: `导出 JSON（${nodes.length} 节点）`,
      disabled: nodes.length === 0,
      onClick: onExport,
    },
    { type: 'divider' },
    {
      key: 'undo',
      icon: <UndoOutlined />,
      label: `撤销（${past.length}）`,
      disabled: isRunning || past.length === 0,
      onClick: onUndo,
    },
    {
      key: 'redo',
      icon: <RedoOutlined />,
      label: `重做（${future.length}）`,
      disabled: isRunning || future.length === 0,
      onClick: onRedo,
    },
    {
      key: 'reset',
      icon: <ReloadOutlined />,
      label: '重置节点状态',
      onClick: onReset,
    },
    { type: 'divider' },
    {
      key: 'clear',
      icon: <ClearOutlined />,
      label: '清空画布',
      danger: true,
      disabled: isRunning || nodes.length === 0,
      onClick: onClear,
    },
  ];

  return (
    <>
      {msgCtx}
      <input
        type="file"
        accept="application/json,.json"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={onImportFile}
      />
      <div style={toolbarWrapperStyle}>
        {/* 右上角光晕装饰 */}
        <span style={glowDecor} aria-hidden />

        {/* 左侧：Logo + 面包屑 */}
        <div style={leftBlockStyle}>
          {/* Logo */}
          <div style={logoBlockStyle}>
            <span style={logoChipStyle}>
              <ApartmentOutlined style={{ fontSize: 15 }} />
            </span>
            <span style={logoTextStyle}>AI Workflow</span>
            <Tag style={draftTagStyle}>Demo</Tag>
          </div>

          {/* 面包屑：我的空间 / 工作流 / 草稿 */}
          <Breadcrumb
            style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12.5 }}
            separator={<span style={{ color: 'rgba(255,255,255,0.4)' }}>/</span>}
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

          {/* 桌面端独有组件 */}
          <Suspense fallback={null}>
            <DesktopToolbarExtras />
          </Suspense>
        </div>

        {/* 右侧：统计 + 主按钮组 */}
        <div style={rightBlockStyle}>
          {/* 统计 Pill */}
          <div className="toolbar__stats" style={statsPillStyle}>
            <span>
              节点&nbsp;<b style={{ color: '#fff' }}>{nodes.length}</b>
            </span>
            <span style={statDivider} />
            <span>
              连线&nbsp;<b style={{ color: '#fff' }}>{edges.length}</b>
            </span>
          </div>

          {/* 撤销/重做 小图标（次操作，放主按钮左侧一行） */}
          <div className="toolbar__actions" style={{ display: 'inline-flex', gap: 6 }}>
            <Tooltip title={`撤销（最近 ${past.length} 步）`}>
              <Button
                shape="circle"
                size="small"
                icon={<UndoOutlined />}
                disabled={isRunning || past.length === 0}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.18)',
                  color: '#fff',
                  width: 30,
                  height: 30,
                }}
                onClick={onUndo}
              />
            </Tooltip>
            <Tooltip title="重做">
              <Button
                shape="circle"
                size="small"
                icon={<RedoOutlined />}
                disabled={isRunning || future.length === 0}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.18)',
                  color: '#fff',
                  width: 30,
                  height: 30,
                }}
                onClick={onRedo}
              />
            </Tooltip>

            <Tooltip title="更多操作（导入/导出/清空...）">
              <Dropdown menu={{ items: moreMenuItems }} trigger={['click']} placement="bottomRight">
                <Button
                  shape="circle"
                  size="small"
                  icon={<MoreOutlined />}
                  style={{
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    color: '#fff',
                    width: 30,
                    height: 30,
                  }}
                />
              </Dropdown>
            </Tooltip>
          </div>

          {/* 主按钮组：保存草稿 / 调试 / 发布 */}
          <Space size={8} wrap style={{ flexShrink: 0 }}>
            <Button
              icon={<SaveOutlined />}
              loading={saving}
              onClick={onSaveDraft}
              style={ghostBtn}
            >
              保存草稿
            </Button>
            {!isRunning ? (
              <Button
                icon={<BugOutlined />}
                onClick={onRun}
                style={debugBtnStyle(false)}
              >
                <span style={{ marginRight: 4 }}>调试</span>
                <PlayCircleOutlined />
              </Button>
            ) : (
              <Button
                icon={<StopOutlined />}
                onClick={onStop}
                style={debugBtnStyle(true)}
              >
                停止
              </Button>
            )}
            <Button
              icon={<RocketOutlined />}
              loading={publishing}
              onClick={onPublish}
              style={publishBtnStyle}
            >
              发布
            </Button>
          </Space>
        </div>
      </div>
    </>
  );
}

// 为 App 层保留旧别名（如果有其他文件 import Statistic 相关不会报错）
export { Row, Col, Statistic };
