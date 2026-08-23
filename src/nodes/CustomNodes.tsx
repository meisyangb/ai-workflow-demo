/**
 * 自定义节点集合（扣子 Coze 工作流风格）
 *
 * —— v0.3.0 升级 ——
 * 1. 不再对每个 node.type 单独写组件，而是统一用 GenericNode。
 *    所有 28 种节点共用一套卡片骨架，差异点（图标/主色/摘要字段）
 *    全部从 src/domains/workflow.ts 中的 NODE_METAS + defaultData 推断。
 * 2. 视觉风格对齐扣子：
 *    - 顶部一条 3px 渐变 accent 色条
 *    - 卡片圆角 8px、阴影、选中时蓝色 outline
 *    - 头部：左图标 + 标题，右状态小圆点（RUNNING 带光晕）
 *    - 主体：1~2 行关键摘要（不展开完整字段），字体稍浅
 *    - 左右两侧：标准 Handle；CONDITION / SELECTOR 支持多 source handle
 */

import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { CSSProperties, ReactNode } from 'react';
import * as Icons from '@ant-design/icons';
import {
  NODE_METAS,
  NodeType,
  CATEGORY_META,
  getMeta,
  statusColor,
  statusText,
} from '../domains/workflow';
import type {
  NodeStatus as NodeStatusType,
  WorkflowNodeData,
  WorkflowNode,
  ConditionNodeData,
  SelectorNodeData,
  LLMNodeData,
  CodeNodeData,
  HttpNodeData,
  VariableNodeData,
} from '../domains/workflow';

// ===== 图标映射：把 NODE_METAS.icon 字符串转成 Ant Design 图标组件 =====
const ICON_MAP: Record<string, React.ComponentType<{ style?: CSSProperties }>> =
  Icons as unknown as Record<string, React.ComponentType<{ style?: CSSProperties }>>;

export function pickIcon(name: string, color = '#fff', size = 14): ReactNode {
  const Comp = ICON_MAP[name];
  if (!Comp) {
    const Fallback = Icons.AppstoreOutlined;
    return <Fallback style={{ color, fontSize: size }} />;
  }
  return <Comp style={{ color, fontSize: size }} />;
}

// ===== 尺寸与颜色常量（扣子风格）=====
const CARD_WIDTH = 240;
const HEADER_HEIGHT = 40;
const TOP_BAR_HEIGHT = 3;

// ===== 通用状态点（右上） =====
export function statusDot(status: NodeStatusType, size = 8) {
  return (
    <span
      title={statusText(status)}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: statusColor(status),
        boxShadow:
          status === 'running'
            ? `0 0 0 3px ${statusColor(status)}33, 0 0 12px ${statusColor(status)}`
            : `0 0 0 2px #fff`,
      }}
    />
  );
}

// ===== 通用卡片样式 =====
const cardStyle = (accent: string, _status: NodeStatusType, selected: boolean): CSSProperties => ({
  width: CARD_WIDTH,
  borderRadius: 8,
  background: '#fff',
  boxShadow: selected
    ? `0 4px 14px ${accent}33, 0 0 0 2px ${accent}`
    : `0 2px 6px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04)`,
  fontSize: 12,
  overflow: 'hidden',
  border: `1px solid ${selected ? accent : '#eef0f3'}`,
  transition: 'box-shadow 150ms ease, border-color 150ms ease',
});

const topBarStyle = (accent: string): CSSProperties => ({
  height: TOP_BAR_HEIGHT,
  background: `linear-gradient(90deg, ${accent} 0%, ${accent}bb 100%)`,
});

const headerRowStyle = (accent: string): CSSProperties => ({
  height: HEADER_HEIGHT,
  padding: '0 12px 0 10px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  background: `linear-gradient(180deg, ${accent}10 0%, #ffffff 100%)`,
  borderBottom: '1px solid #f0f2f5',
});

const iconChipStyle = (accent: string): CSSProperties => ({
  width: 26,
  height: 26,
  borderRadius: 6,
  background: `linear-gradient(135deg, ${accent} 0%, ${accent}cc 100%)`,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginRight: 8,
  flexShrink: 0,
  boxShadow: `0 2px 4px ${accent}33`,
});

const labelTextStyle: CSSProperties = {
  color: '#1f2937',
  fontWeight: 600,
  fontSize: 13,
  lineHeight: '18px',
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const bodyStyle: CSSProperties = {
  padding: '10px 12px 12px 12px',
  color: '#4b5563',
  lineHeight: 1.55,
  minHeight: 40,
};

const summaryRowStyle: CSSProperties = {
  fontSize: 11.5,
  color: '#6b7280',
  marginBottom: 4,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 4,
};

const summaryKeyStyle: CSSProperties = {
  color: '#9ca3af',
  flexShrink: 0,
};

// ===== 摘要：把不同类型节点的 data 摘要成 1~2 行 =====
function renderSummary(data: WorkflowNodeData, type: NodeType): ReactNode {
  const d = data as unknown as Record<string, unknown>;
  const rows: ReactNode[] = [];

  const line = (key: string, value: ReactNode, maxLen = 80) => {
    const str =
      typeof value === 'string'
        ? value.length > maxLen
          ? value.slice(0, maxLen) + '…'
          : value
        : value;
    rows.push(
      <div key={key} style={summaryRowStyle}>
        <span style={summaryKeyStyle}>{key}：</span>
        <span style={{ flex: 1, minWidth: 0 }}>{str}</span>
      </div>,
    );
  };

  switch (type) {
    case NodeType.START: {
      const arr = d.inputs as { key: string; label: string; type: string }[] | undefined;
      line('输入', arr && arr.length > 0 ? arr.map((f) => f.key).join(', ') : '（空）');
      break;
    }
    case NodeType.END: {
      line('输出', ((d.variables as string[]) ?? []).join(', ') || '（空）');
      break;
    }
    case NodeType.VARIABLE: {
      const vd = data as unknown as VariableNodeData;
      line('变量', `${vd.variableName}: ${vd.dataType}`);
      line('表达式', vd.expression);
      break;
    }
    case NodeType.LLM:
    case NodeType.QUESTION:
    case NodeType.IMAGE:
    case NodeType.IMAGE_GEN: {
      const llm = data as unknown as LLMNodeData;
      line('模型', llm.model);
      line('提示词', (d.prompt as string) || '（空）', 60);
      break;
    }
    case NodeType.CONDITION: {
      const c = data as unknown as ConditionNodeData;
      line('如果', c.expression || '（空）', 70);
      line(
        '分支',
        <span>
          <span style={{ color: '#52c41a' }}>✓ {c.trueLabel}</span>
          <span style={{ color: '#9ca3af', margin: '0 4px' }}>/</span>
          <span style={{ color: '#ff4d4f' }}>✕ {c.falseLabel}</span>
        </span>,
      );
      break;
    }
    case NodeType.LOOP:
      line('模式', String(d.mode));
      if (d.arrayRef) line('遍历', String(d.arrayRef));
      break;
    case NodeType.SELECTOR: {
      const s = data as unknown as SelectorNodeData;
      line('值', s.valueRef);
      line(
        '分支',
        s.cases.map((c) => c.label).join(' | ') + (s.hasDefault ? ' | 默认' : ''),
      );
      break;
    }
    case NodeType.INTENT:
      line(
        '意图',
        ((d.intents as { label: string }[]) ?? []).map((i) => i.label).join(' | ') || '（空）',
      );
      break;
    case NodeType.RETRIEVAL:
      line('查询', String(d.query ?? ''), 60);
      line('TopK', `${String(d.topK ?? '-')} · 阈值 ${String(d.threshold ?? '-')}`);
      break;
    case NodeType.DATASET_WRITE:
      line('内容', String(d.contentRef ?? ''), 60);
      break;
    case NodeType.BATCH:
      line('数组', String(d.arrayRef ?? ''), 60);
      line('并发', `${String(d.parallelism ?? 1)} 条`);
      break;
    case NodeType.DATA_ADD:
    case NodeType.DATA_QUERY:
    case NodeType.DATA_UPDATE:
    case NodeType.DATA_DELETE:
    case NodeType.SQL:
      line('表', String(d.table ?? '-'));
      if (typeof d.sql === 'string') line('SQL', d.sql, 60);
      break;
    case NodeType.HTTP: {
      const h = data as unknown as HttpNodeData;
      line(
        '请求',
        <span>
          <span
            style={{
              padding: '1px 6px',
              borderRadius: 3,
              background: '#f0f5ff',
              color: '#1677ff',
              fontFamily: 'monospace',
              marginRight: 6,
              fontWeight: 700,
            }}
          >
            {h.method}
          </span>
          <span style={{ fontFamily: 'monospace' }}>{h.url}</span>
        </span>,
        70,
      );
      break;
    }
    case NodeType.CODE: {
      const c = data as unknown as CodeNodeData;
      line('语言', `${c.language} · 超时 ${c.timeout}s`);
      line('代码', c.code, 60);
      break;
    }
    case NodeType.PLUGIN:
      line('插件', String(d.pluginName ?? ''));
      break;
    case NodeType.WORKFLOW:
      line('子工作流', String(d.workflowName || '（未选择）'));
      break;
    case NodeType.MESSAGE:
      line('通道', String(d.channel));
      line('模板', String(d.template ?? ''), 60);
      break;
    case NodeType.SLEEP:
      line('延时', `${Number(d.delayMs ?? 0) / 1000} 秒`);
      break;
    case NodeType.LTM_WRITE:
      line('写入', String(d.contentRef ?? ''), 60);
      line('标签', ((d.tags as string[]) ?? []).join(', ') || '（空）');
      break;
    case NodeType.LTM_READ:
      line('查询', String(d.query ?? ''), 60);
      line('TopK', String(d.topK ?? '-'));
      break;
    case NodeType.AGGREGATE:
      line(
        '聚合',
        ((d.mapping as { alias: string }[]) ?? []).map((m) => m.alias).join(', ') || '（空）',
      );
      break;
    default:
      // 兜底：不显示摘要
      break;
  }

  return <div>{rows}</div>;
}

// ===== 端口渲染器：按类型决定 source handle 数量与位置 =====
function renderHandles(
  type: NodeType,
  data: WorkflowNodeData,
  accent: string,
  cardHeight: number,
) {
  // 左：所有节点都有一个 target
  const target = (
    <Handle
      type="target"
      position={Position.Left}
      id="target"
      style={{
        background: accent,
        border: '2px solid #fff',
        boxShadow: `0 0 0 1px ${accent}66`,
        width: 10,
        height: 10,
      }}
    />
  );

  // 右：特殊节点有多个 source；其他一个
  const sources: ReactNode[] = [];

  if (type === NodeType.CONDITION) {
    // 两个：true 在上 / false 在下
    sources.push(
      <Handle
        key="true"
        type="source"
        position={Position.Right}
        id="true"
        title="true"
        style={{
          top: cardHeight * 0.35,
          background: '#52c41a',
          border: '2px solid #fff',
          boxShadow: '0 0 0 1px #52c41a88',
          width: 10,
          height: 10,
        }}
      />,
      <Handle
        key="false"
        type="source"
        position={Position.Right}
        id="false"
        title="false"
        style={{
          top: cardHeight * 0.7,
          background: '#ff4d4f',
          border: '2px solid #fff',
          boxShadow: '0 0 0 1px #ff4d4f88',
          width: 10,
          height: 10,
        }}
      />,
    );
  } else if (type === NodeType.SELECTOR) {
    const s = data as unknown as SelectorNodeData;
    const total = s.cases.length + (s.hasDefault ? 1 : 0);
    const safeTotal = Math.max(total, 1);
    const step = (cardHeight - 30) / (safeTotal + 1);
    let idx = 0;
    s.cases.forEach((c) => {
      idx += 1;
      sources.push(
        <Handle
          key={`case-${idx}`}
          type="source"
          position={Position.Right}
          id={`case-${idx}`}
          title={c.label}
          style={{
            top: 20 + idx * step,
            background: accent,
            border: '2px solid #fff',
            boxShadow: `0 0 0 1px ${accent}99`,
            width: 10,
            height: 10,
          }}
        />,
      );
    });
    if (s.hasDefault) {
      idx += 1;
      sources.push(
        <Handle
          key="default"
          type="source"
          position={Position.Right}
          id="default"
          title="默认"
          style={{
            top: 20 + idx * step,
            background: '#8c8c8c',
            border: '2px solid #fff',
            boxShadow: '0 0 0 1px #8c8c8c99',
            width: 10,
            height: 10,
          }}
        />,
      );
    }
  } else if (type === NodeType.INTENT) {
    const it = data as unknown as { intents: { label: string }[] };
    const total = Math.max(it.intents.length, 1);
    const step = (cardHeight - 30) / (total + 1);
    it.intents.forEach((intent, i) => {
      sources.push(
        <Handle
          key={`intent-${i}`}
          type="source"
          position={Position.Right}
          id={`intent-${i}`}
          title={intent.label}
          style={{
            top: 20 + (i + 1) * step,
            background: accent,
            border: '2px solid #fff',
            boxShadow: `0 0 0 1px ${accent}99`,
            width: 10,
            height: 10,
          }}
        />,
      );
    });
  } else {
    sources.push(
      <Handle
        key="source"
        type="source"
        position={Position.Right}
        id="source"
        style={{
          background: accent,
          border: '2px solid #fff',
          boxShadow: `0 0 0 1px ${accent}66`,
          width: 10,
          height: 10,
        }}
      />,
    );
  }

  return (
    <>
      {target}
      {sources}
    </>
  );
}

// ===== 通用卡片组件：一个组件覆盖全部 28 种 type =====
// 对外签名用 NodeProps<any>：ReactFlow 的泛型约束要求 Record<string, unknown>
// （28 类联合类型 + 索引签名仍然会在严格检查时卡在泛型边界上）
// 函数内部仍然按 WorkflowNodeData/NodeType 做完整强类型。
export function GenericNode(props: NodeProps<any>) {
  const { data, selected, type: nodeType } = props as NodeProps<WorkflowNode>;
  const meta = getMeta(nodeType as NodeType);
  const accent = meta.accent;
  const status = data.status;

  // 估算卡片高度（影响多 handle 的竖向布局）
  const approxBody = Math.min(90, 24 + Math.max(1, (renderSummary(data, nodeType as NodeType) as { props: { children: unknown[] } })?.props?.children?.length ?? 1) * 20);
  const cardHeight = TOP_BAR_HEIGHT + HEADER_HEIGHT + approxBody + 16;

  return (
    <div style={cardStyle(accent, status, selected)}>
      {/* 顶条：accent 渐变 */}
      <div style={topBarStyle(accent)} />
      {/* 头：图标 + 标题 + 状态点 */}
      <div style={headerRowStyle(accent)}>
        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1 }}>
          <span style={iconChipStyle(accent)}>
            {pickIcon(meta.icon, '#fff', 14)}
          </span>
          <span style={labelTextStyle} title={data.label}>
            {data.label}
          </span>
        </div>
        {statusDot(status)}
      </div>
      {/* 体：摘要行 */}
      <div style={bodyStyle}>
        {renderSummary(data, nodeType as NodeType)}
        {/* 分类徽标（小而淡，右下角对齐） */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: 6,
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              padding: '1px 7px',
              borderRadius: 10,
              background: `${CATEGORY_META[meta.category].color}12`,
              color: CATEGORY_META[meta.category].color,
              fontWeight: 500,
            }}
          >
            {CATEGORY_META[meta.category].label}
          </span>
        </div>
      </div>
      {/* 左右端口 */}
      {renderHandles(nodeType as NodeType, data, accent, cardHeight)}
    </div>
  );
}

// ===== 注册字典：给 FlowCanvas 使用 =====
// 扣子风格下：所有 type 共用 GenericNode，不再单独写组件。
export const nodeTypes: Record<string, React.ComponentType<NodeProps<any>>> =
  NODE_METAS.reduce<Record<string, React.ComponentType<NodeProps<any>>>>(
    (acc, meta) => {
      acc[meta.type] = GenericNode;
      return acc;
    },
    {},
  );

// ===== 向后兼容：老组件的别名（避免其他 import 处报错）=====
export const LLMNode = GenericNode;
export const ConditionNode = GenericNode;
export const CodeNode = GenericNode;
