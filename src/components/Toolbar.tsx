import { lazy, Suspense, useRef } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { Button, Space, Tooltip, message, Divider, Statistic, Row, Col } from 'antd';
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
} from '@ant-design/icons';
import { useWorkflowStore } from '../store/workflowStore';

// 🔴 关键隔离点：桌面端独有组件必须走 React.lazy 动态 import。
// 这样 runtimeEnv / nativeBridge 会被 Rollup 切到独立的 lazy chunk，
// 绝对不会被 index.html 首屏 JS 引用 → Vercel bundle 永远不含 Tauri 关键字。
// 对于纯 Web/Vercel 访问者：Suspense fallback = null，WebView 组件零 DOM、零首屏字节。
const DesktopToolbarExtras = lazy(() =>
  import(
    /* webpackChunkName: "desktop-extras" */
    /* @vite-ignore */
    './DesktopToolbarExtras'
  ).then((m) => ({ default: m.default })),
);

const toolbarWrapperStyle: CSSProperties = {
  padding: '8px 14px',
  borderBottom: '1px solid #f0f0f0',
  background: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 10,
  // 关键：允许 toolbar 在窄窗口下被压缩，子区域使用 min-width: 0 以配合 flex 收缩。
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
};

const titleBlockStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  flex: '1 1 auto',
  flexWrap: 'wrap',
  gap: 10,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 700,
  color: '#262626',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

// 副标题：允许显示省略号，但不挤压标题与按钮
const subTitleStyle: CSSProperties = {
  marginLeft: 0,
  fontSize: 12,
  color: '#8c8c8c',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '36vw',
  minWidth: 0,
};

const actionBlockStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexWrap: 'wrap',
  minWidth: 0,
  // 按钮组「优先不换行」，但极端窄窗允许整段折行
  flex: '0 1 auto',
};

// 统计区：极窄窗口（< 1100px）由 CSS helper class 隐藏
const statsStyle: CSSProperties = {
  flexShrink: 0,
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

  const onRun = async () => {
    if (nodes.length === 0) {
      msgApi.warning('画布为空，请先添加节点');
      return;
    }
    msgApi.info('开始执行工作流（模拟）...', 1.5);
    const res = await runWorkflow();
    if (res.error) {
      msgApi.error(res.error);
    } else {
      msgApi.success('工作流执行完毕');
    }
  };

  const onStop = () => {
    stopRun();
    resetStatus();
    msgApi.info('已停止并重置状态');
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
    a.download = `workflow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    msgApi.success(`已导出 ${nodes.length} 个节点、${edges.length} 条连线`);
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
    e.target.value = ''; // 允许再次选择同个文件
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
        <div style={titleBlockStyle}>
          <h2 style={titleStyle}>
            <ApartmentOutlined style={{ color: '#8c8c8c' }} />
            <span>AI Workflow 编排编辑器</span>
          </h2>
          <span className="toolbar__subtitle" style={subTitleStyle}>
            类 Coze 扣子 / Dify 工作流 - 纯前端 Demo
          </span>
          {/* 桌面端独有组件：Web 环境下 React.lazy 加载但 Suspense fallback=null → 零 DOM */}
          <Suspense fallback={null}>
            <DesktopToolbarExtras />
          </Suspense>
        </div>

        <div style={actionBlockStyle}>
          <Space
            size="small"
            split={<Divider type="vertical" />}
            wrap
            className="toolbar__actions"
          >
            {/* 统计：中等宽度以下由 CSS 隐藏 */}
            <div className="toolbar__stats" style={statsStyle}>
              <Row gutter={[12, 0]} wrap={false}>
                <Col flex="none">
                  <Statistic title="节点" value={nodes.length} valueStyle={{ fontSize: 14 }} />
                </Col>
                <Col flex="none">
                  <Statistic title="连线" value={edges.length} valueStyle={{ fontSize: 14 }} />
                </Col>
              </Row>
            </div>

            <Space size="small" wrap>
              <Tooltip title="撤销 (保留最近 50 步)">
                <Button
                  size="small"
                  icon={<UndoOutlined />}
                  onClick={onUndo}
                  disabled={isRunning || past.length === 0}
                >
                  撤销
                </Button>
              </Tooltip>
              <Tooltip title="重做">
                <Button
                  size="small"
                  icon={<RedoOutlined />}
                  onClick={onRedo}
                  disabled={isRunning || future.length === 0}
                >
                  重做
                </Button>
              </Tooltip>
            </Space>

            <Space size="small" wrap>
              <Tooltip title="导入 JSON 文件恢复画布">
                <Button
                  size="small"
                  icon={<UploadOutlined />}
                  onClick={onImportClick}
                  disabled={isRunning}
                >
                  导入
                </Button>
              </Tooltip>
              <Tooltip title="导出当前画布为 JSON">
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={onExport}
                  disabled={nodes.length === 0}
                >
                  导出
                </Button>
              </Tooltip>
              <Tooltip title="清空画布">
                <Button
                  size="small"
                  danger
                  icon={<ClearOutlined />}
                  onClick={onClear}
                  disabled={isRunning || nodes.length === 0}
                >
                  清空
                </Button>
              </Tooltip>
            </Space>

            <Space size="small" wrap>
              <Tooltip title="重置所有节点状态为待执行">
                <Button size="small" icon={<ReloadOutlined />} onClick={onReset}>
                  重置状态
                </Button>
              </Tooltip>
              {!isRunning ? (
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={onRun}
                  size="small"
                >
                  运行
                </Button>
              ) : (
                <Button
                  type="primary"
                  danger
                  icon={<StopOutlined />}
                  onClick={onStop}
                  size="small"
                >
                  停止
                </Button>
              )}
            </Space>
          </Space>
        </div>
      </div>
    </>
  );
}
