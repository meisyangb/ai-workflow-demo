import { Handle, Position } from '@xyflow/react';
import { RobotOutlined, ForkOutlined, CodeOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { NodeStatus } from '../store/workflowStore';

const ICON_COLOR = '#595959';

const iconWrap = (size = 14) => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: size,
  height: size,
  color: ICON_COLOR,
  marginRight: 6,
});

// 根据状态返回颜色
export const statusColor = (status) => {
  switch (status) {
    case NodeStatus.RUNNING:
      return '#faad14'; // 黄
    case NodeStatus.SUCCESS:
      return '#52c41a'; // 绿
    case NodeStatus.FAILED:
      return '#ff4d4f'; // 红
    default:
      return '#bfbfbf';
  }
};

export const statusText = (status) => {
  switch (status) {
    case NodeStatus.RUNNING:
      return '运行中';
    case NodeStatus.SUCCESS:
      return '成功';
    case NodeStatus.FAILED:
      return '失败';
    default:
      return '待执行';
  }
};

export const statusDot = (status) => (
  <span
    style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: statusColor(status),
      marginRight: 6,
      boxShadow:
        status === NodeStatus.RUNNING
          ? `0 0 0 3px ${statusColor(status)}33`
          : 'none',
    }}
  />
);

const nodeWrapperStyle = (status) => ({
  width: 220,
  border: `2px solid ${statusColor(status)}`,
  borderRadius: 8,
  background: '#fff',
  boxShadow: `0 2px 8px ${statusColor(status)}33`,
  fontSize: 12,
});

const headerStyle = (status) => ({
  padding: '6px 10px',
  borderRadius: '6px 6px 0 0',
  background: `${statusColor(status)}15`,
  borderBottom: `1px dashed ${statusColor(status)}55`,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
});

const bodyStyle = {
  padding: '8px 10px',
  color: '#595959',
  lineHeight: 1.5,
  wordBreak: 'break-all',
};

/**
 * LLM 大模型节点
 */
export function LLMNode({ data, selected }) {
  return (
    <div
      style={{
        ...nodeWrapperStyle(data.status),
        outline: selected ? '2px solid #1677ff' : 'none',
        outlineOffset: 2,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={headerStyle(data.status)}>
        <span title="大模型节点" style={{ display: 'flex', alignItems: 'center', color: '#262626' }}>
          <span style={iconWrap(14)}><RobotOutlined /></span>
          <span>{data.label}</span>
        </span>
        <span title={statusText(data.status)} style={{ display: 'inline-flex', alignItems: 'center' }}>
          {statusDot(data.status)}
        </span>
      </div>
      <div style={bodyStyle}>
        <div style={{ marginBottom: 4 }}>
          <b>模型：</b>
          {data.model} · T={data.temperature}
        </div>
        <div style={{ maxHeight: 60, overflow: 'hidden' }}>
          <b>提示词：</b>
          {(data.prompt || '').slice(0, 60)}
          {(data.prompt || '').length > 60 ? '…' : ''}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/**
 * 条件分支节点（双输出口）
 */
export function ConditionNode({ data, selected }) {
  return (
    <div
      style={{
        ...nodeWrapperStyle(data.status),
        outline: selected ? '2px solid #1677ff' : 'none',
        outlineOffset: 2,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={headerStyle(data.status)}>
        <span title="条件分支" style={{ display: 'flex', alignItems: 'center', color: '#262626' }}>
          <span style={iconWrap(14)}><ForkOutlined /></span>
          <span>{data.label}</span>
        </span>
        <span title={statusText(data.status)} style={{ display: 'inline-flex', alignItems: 'center' }}>
          {statusDot(data.status)}
        </span>
      </div>
      <div style={bodyStyle}>
        <div style={{ marginBottom: 4 }}>
          <b>表达式：</b>
        </div>
        <div
          style={{
            fontFamily: 'monospace',
            background: '#f6f8fa',
            padding: 4,
            borderRadius: 4,
            fontSize: 11,
          }}
        >
          {data.expression || '-'}
        </div>
        <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ color: '#52c41a', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <CheckOutlined /> {data.trueLabel}
          </span>
          <span style={{ color: '#ff4d4f', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <CloseOutlined /> {data.falseLabel}
          </span>
        </div>
      </div>
      {/* 两个输出口：true / false */}
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        style={{ top: 72, background: '#52c41a', border: '2px solid #fff' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="false"
        style={{ top: 110, background: '#ff4d4f', border: '2px solid #fff' }}
      />
    </div>
  );
}

/**
 * 代码执行节点
 */
export function CodeNode({ data, selected }) {
  return (
    <div
      style={{
        ...nodeWrapperStyle(data.status),
        outline: selected ? '2px solid #1677ff' : 'none',
        outlineOffset: 2,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={headerStyle(data.status)}>
        <span title="代码执行" style={{ display: 'flex', alignItems: 'center', color: '#262626' }}>
          <span style={iconWrap(14)}><CodeOutlined /></span>
          <span>{data.label}</span>
        </span>
        <span title={statusText(data.status)} style={{ display: 'inline-flex', alignItems: 'center' }}>
          {statusDot(data.status)}
        </span>
      </div>
      <div style={bodyStyle}>
        <div style={{ marginBottom: 4 }}>
          <b>语言：</b>
          {data.language} · 超时 {data.timeout}s
        </div>
        <div
          style={{
            fontFamily: 'monospace',
            background: '#0f172a',
            color: '#e2e8f0',
            padding: 6,
            borderRadius: 4,
            fontSize: 10.5,
            whiteSpace: 'pre',
            maxHeight: 64,
            overflow: 'hidden',
          }}
        >
          {(data.code || '').slice(0, 120)}
          {(data.code || '').length > 120 ? '\n…' : ''}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
