import { useRef } from 'react';
import {
  Button,
  Space,
  Tooltip,
  message,
  Divider,
  Statistic,
  Row,
  Col,
} from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  UndoOutlined,
  RedoOutlined,
  ClearOutlined,
  DownloadOutlined,
  UploadOutlined,
  ReloadOutlined,
  BulbOutlined,
} from '@ant-design/icons';
import { useWorkflowStore } from '../store/workflowStore';

const toolbarStyle = {
  padding: '10px 16px',
  borderBottom: '1px solid #f0f0f0',
  background: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 12,
};

const titleStyle = {
  margin: 0,
  fontSize: 16,
  fontWeight: 700,
  background: 'linear-gradient(90deg,#1677ff,#722ed1)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
};

const subTitleStyle = {
  marginLeft: 10,
  fontSize: 12,
  color: '#8c8c8c',
};

export default function Toolbar() {
  const fileInputRef = useRef(null);

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
    msgApi.info('▶ 开始执行工作流（模拟）...', 1.5);
    const res = await runWorkflow();
    if (res?.error) {
      msgApi.error(res.error);
    } else {
      msgApi.success('✅ 工作流执行完毕');
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

  const onImportFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target?.result || '');
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
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={titleStyle}>
            <BulbOutlined /> AI Workflow 编排编辑器
          </h2>
          <span style={subTitleStyle}>类 Coze 扣子 / Dify 工作流 - 纯前端 Demo</span>
        </div>

        <Space size="middle" split={<Divider type="vertical" />}>
          {/* 统计 */}
          <Row gutter={16}>
            <Col>
              <Statistic title="节点" value={nodes.length} valueStyle={{ fontSize: 14 }} />
            </Col>
            <Col>
              <Statistic title="连线" value={edges.length} valueStyle={{ fontSize: 14 }} />
            </Col>
          </Row>

          <Space>
            <Tooltip title="撤销 (保留最近 50 步)">
              <Button
                icon={<UndoOutlined />}
                onClick={onUndo}
                disabled={isRunning || past.length === 0}
              >
                撤销
              </Button>
            </Tooltip>
            <Tooltip title="重做">
              <Button
                icon={<RedoOutlined />}
                onClick={onRedo}
                disabled={isRunning || future.length === 0}
              >
                重做
              </Button>
            </Tooltip>
          </Space>

          <Space>
            <Tooltip title="导入 JSON 文件恢复画布">
              <Button icon={<UploadOutlined />} onClick={onImportClick} disabled={isRunning}>
                导入
              </Button>
            </Tooltip>
            <Tooltip title="导出当前画布为 JSON">
              <Button icon={<DownloadOutlined />} onClick={onExport} disabled={nodes.length === 0}>
                导出
              </Button>
            </Tooltip>
            <Tooltip title="清空画布">
              <Button
                danger
                icon={<ClearOutlined />}
                onClick={onClear}
                disabled={isRunning || nodes.length === 0}
              >
                清空
              </Button>
            </Tooltip>
          </Space>

          <Space>
            <Tooltip title="重置所有节点状态为待执行">
              <Button icon={<ReloadOutlined />} onClick={onReset}>
                重置状态
              </Button>
            </Tooltip>
            {!isRunning ? (
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={onRun}
                size="middle"
              >
                ▶ 运行工作流
              </Button>
            ) : (
              <Button
                type="primary"
                danger
                icon={<StopOutlined />}
                onClick={onStop}
                size="middle"
              >
                停止
              </Button>
            )}
          </Space>
        </Space>
      </div>
    </>
  );
}
