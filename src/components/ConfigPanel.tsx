/**
 * 右侧配置面板（扣子 Coze 工作流风格 v0.3.0）
 *
 * 设计要点：
 * 1. 顶部渐变条（按节点分类 accent 色）
 * 2. 头部：图标（渐变色块）+ 节点类型 + 状态徽章 + ID
 * 3. Tabs：
 *    - 设置（默认）：按节点类型渲染专属字段表单
 *    - 输入：显示 inputs / outputs 字段定义（字段表）
 *    - 调试：debugOutput JSON 预览 + 耗时
 * 4. 底部：节点坐标 + 删除按钮
 * 5. 类型处理：采用「按 NodeType 分支 switch」策略覆盖全部 28 类节点，
 *    数据字段引用 domains/workflow.ts 的接口
 */

import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Form,
  Input,
  Select,
  InputNumber,
  Button,
  Tabs,
  Typography,
  Empty,
  Tag,
  Divider,
  Table,
  Tooltip,
} from 'antd';
import {
  DeleteOutlined,
  CopyOutlined,
  ApiOutlined,
  SettingOutlined,
  BugOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import * as Icons from '@ant-design/icons';
import type { TabsProps } from 'antd';
import {
  useWorkflowStore,
  NodeType,
  NodeStatus,
  statusColor,
  statusText,
} from '../store/workflowStore';
import { getMeta, CATEGORY_META } from '../domains/workflow';
import type {
  WorkflowNode,
  WorkflowNodeData,
  NodeStatus as NodeStatusType,
  WorkflowFieldDef,
  NodeType as NodeTypeUnion,
  // —— 各节点 data 类型（配置表单按需渲染）——
  StartNodeData,
  EndNodeData,
  VariableNodeData,
  AggregateNodeData,
  SubWorkflowNodeData,
  LLMNodeData,
  QuestionNodeData,
  ImageNodeData,
  ImageGenNodeData,
  ConditionNodeData,
  LoopNodeData,
  SelectorNodeData,
  IntentNodeData,
  RetrievalNodeData,
  DatasetWriteNodeData,
  BatchNodeData,
  DataAddNodeData,
  DataQueryNodeData,
  DataUpdateNodeData,
  DataDeleteNodeData,
  SqlNodeData,
  HttpNodeData,
  CodeNodeData,
  PluginNodeData,
  MessageNodeData,
  SleepNodeData,
  LtmWriteNodeData,
  LtmReadNodeData,
} from '../domains/workflow';
import { message } from 'antd';

const { TextArea } = Input;
const { Text } = Typography;

// ===== 图标映射 =====
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

// ===== 面板尺寸 =====
const PANEL_WIDTH = 360;

const panelWrapStyle: CSSProperties = {
  flex: `0 0 ${PANEL_WIDTH}px`,
  width: PANEL_WIDTH,
  borderLeft: '1px solid #eef0f3',
  background: '#fff',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  boxSizing: 'border-box',
  height: '100%',
};

const topAccentStyle = (accent: string): CSSProperties => ({
  height: 4,
  background: `linear-gradient(90deg, ${accent} 0%, ${accent}aa 100%)`,
  flexShrink: 0,
});

const headerStyle = (accent: string): CSSProperties => ({
  padding: '14px 16px',
  background: `linear-gradient(180deg, ${accent}10 0%, #ffffff 100%)`,
  flexShrink: 0,
});

const iconChipBig = (accent: string): CSSProperties => ({
  width: 34,
  height: 34,
  borderRadius: 8,
  background: `linear-gradient(135deg, ${accent} 0%, ${accent}cc 100%)`,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: `0 2px 6px ${accent}33`,
  flexShrink: 0,
});

const typeNameStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: '#1f2937',
  marginBottom: 2,
};

const tabsContainerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const tabPaneStyle: CSSProperties = {
  padding: '8px 16px 16px 16px',
  overflow: 'auto',
  flex: 1,
  minHeight: 0,
};

// ===== 工具：复用 =====
/** patch 用宽松 Record<string, unknown>：避免 28 类联合字段之间的 TS 严格冲突；
 *  BaseNodeData 已经有索引签名，下游 store 的 updateNodeData 也接受同签名。 */
type UpdateFn = (patch: Record<string, unknown>) => void;

const MODEL_OPTIONS = [
  { value: 'GPT-4o', label: 'GPT-4o' },
  { value: 'GPT-4o-mini', label: 'GPT-4o-mini' },
  { value: 'GPT-4 Turbo', label: 'GPT-4 Turbo' },
  { value: 'Claude 3.5 Sonnet', label: 'Claude 3.5 Sonnet' },
  { value: 'Claude 3 Opus', label: 'Claude 3 Opus' },
  { value: 'DeepSeek-V2', label: 'DeepSeek-V2' },
  { value: '通义千问 Max', label: '通义千问 Max' },
  { value: '文心一言 4.0', label: '文心一言 4.0' },
];

const LANG_OPTIONS = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'typescript', label: 'TypeScript' },
];

const HTTP_METHODS: ('GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH')[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
];

// ===== 通用表单区块：节点名称（所有节点第一行）=====
function NodeNameField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <Form.Item label="节点名称" required style={{ marginBottom: 12 }}>
      <Input
        size="small"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="节点显示名称"
      />
    </Form.Item>
  );
}

function SectionTitle({ children, desc }: { children: ReactNode; desc?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginTop: 10,
        marginBottom: 6,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          color: '#6032ff',
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        }}
      >
        {children}
      </div>
      {desc && (
        <Text type="secondary" style={{ fontSize: 10.5 }}>
          {desc}
        </Text>
      )}
    </div>
  );
}

// ============================================================
// 28 类节点配置表单（按 NodeType 分派）
// ============================================================
interface ConfigFormProps<TData> {
  data: TData;
  update: UpdateFn;
  disabled: boolean;
}

function StartForm({ data, update, disabled }: ConfigFormProps<StartNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <SectionTitle desc="至少 1 个必填输入字段">输入字段</SectionTitle>
      <FieldDefEditor
        fields={data.inputs}
        onChange={(inputs) => update({ inputs })}
        disabled={disabled}
      />
    </Form>
  );
}

function EndForm({ data, update, disabled }: ConfigFormProps<EndNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <SectionTitle desc="使用 {{节点id.字段}} 形式引用">输出变量列表</SectionTitle>
      <TextArea
        value={data.variables.join('\n')}
        onChange={(e) =>
          update({
            variables: e.target.value
              .split(/[\n,;]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
        disabled={disabled}
        placeholder="每行一个，例如：&#10;llmNode.result&#10;httpNode.data"
        autoSize={{ minRows: 4, maxRows: 10 }}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
    </Form>
  );
}

function VariableForm({ data, update, disabled }: ConfigFormProps<VariableNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="变量名">
        <Input
          size="small"
          value={data.variableName}
          disabled={disabled}
          onChange={(e) => update({ variableName: e.target.value })}
          placeholder="myVariable"
        />
      </Form.Item>
      <Form.Item label="数据类型">
        <Select
          size="small"
          value={data.dataType}
          disabled={disabled}
          onChange={(v) => update({ dataType: v })}
          options={[
            { value: 'string', label: 'string（字符串）' },
            { value: 'integer', label: 'integer（整数）' },
            { value: 'number', label: 'number（浮点）' },
            { value: 'boolean', label: 'boolean（布尔）' },
            { value: 'object', label: 'object（对象）' },
            { value: 'array', label: 'array（数组）' },
            { value: 'file', label: 'file（文件）' },
          ]}
        />
      </Form.Item>
      <Form.Item label="赋值表达式（支持 {{上游节点.字段}}）">
        <TextArea
          rows={4}
          value={data.expression}
          disabled={disabled}
          onChange={(e) => update({ expression: e.target.value })}
          placeholder="'hello' 或 {{startNode.input}} + ' world'"
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Form.Item>
    </Form>
  );
}

function AggregateForm({ data, update, disabled }: ConfigFormProps<AggregateNodeData>) {
  const rows = data.mapping.length;
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <SectionTitle desc={`共 ${rows} 个字段`}>字段别名映射</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.mapping.map((row, i) => (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            <Input
              size="small"
              placeholder="别名 alias"
              value={row.alias}
              disabled={disabled}
              onChange={(e) => {
                const next = [...data.mapping];
                next[i] = { ...next[i], alias: e.target.value };
                update({ mapping: next });
              }}
              style={{ flex: '0 0 40%' }}
            />
            <Input
              size="small"
              placeholder="引用 ref（{{...}}）"
              value={row.ref}
              disabled={disabled}
              onChange={(e) => {
                const next = [...data.mapping];
                next[i] = { ...next[i], ref: e.target.value };
                update({ mapping: next });
              }}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
            <Button
              size="small"
              danger
              type="text"
              disabled={disabled}
              onClick={() =>
                update({ mapping: data.mapping.filter((_, idx) => idx !== i) })
              }
            >
              <Icons.DeleteOutlined />
            </Button>
          </div>
        ))}
        <Button
          size="small"
          type="dashed"
          block
          disabled={disabled}
          onClick={() =>
            update({
              mapping: [
                ...data.mapping,
                { alias: `field${data.mapping.length + 1}`, ref: '' },
              ],
            })
          }
        >
          + 新增字段
        </Button>
      </div>
    </Form>
  );
}

function WorkflowSubForm({
  data,
  update,
  disabled,
}: ConfigFormProps<SubWorkflowNodeData>) {
  const keys = Object.keys(data.args);
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="目标工作流">
        <Input
          size="small"
          value={data.workflowName}
          disabled={disabled}
          onChange={(e) => update({ workflowName: e.target.value })}
          placeholder="从空间选择，或输入工作流名称"
          prefix={<Icons.ApartmentOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <SectionTitle desc={`共 ${keys.length} 个参数`}>参数映射</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {keys.map((k) => (
          <div key={k} style={{ display: 'flex', gap: 6 }}>
            <Input
              size="small"
              placeholder="参数名"
              value={k}
              disabled={disabled}
              onChange={(e) => {
                const oldVal = data.args[k];
                const nextArgs: Record<string, string> = {};
                Object.keys(data.args).forEach((ok) => {
                  if (ok === k) nextArgs[e.target.value] = oldVal;
                  else nextArgs[ok] = data.args[ok];
                });
                update({ args: nextArgs });
              }}
              style={{ flex: '0 0 38%' }}
            />
            <Input
              size="small"
              placeholder="值（{{...}}）"
              value={data.args[k]}
              disabled={disabled}
              onChange={(e) => update({ args: { ...data.args, [k]: e.target.value } })}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
            <Button
              size="small"
              type="text"
              danger
              disabled={disabled}
              onClick={() => {
                const next: Record<string, string> = {};
                Object.keys(data.args).forEach((ok) => {
                  if (ok !== k) next[ok] = data.args[ok];
                });
                update({ args: next });
              }}
            >
              <Icons.DeleteOutlined />
            </Button>
          </div>
        ))}
        <Button
          size="small"
          type="dashed"
          block
          disabled={disabled}
          onClick={() =>
            update({ args: { ...data.args, [`param${keys.length + 1}`]: '' } })
          }
        >
          + 新增参数
        </Button>
      </div>
    </Form>
  );
}

function LLMForm({ data, update, disabled }: ConfigFormProps<LLMNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <SectionTitle>模型设置</SectionTitle>
      <Form.Item label="模型">
        <Select
          size="small"
          value={data.model}
          disabled={disabled}
          onChange={(v) => update({ model: v })}
          options={MODEL_OPTIONS}
          showSearch
          placeholder="选择模型"
        />
      </Form.Item>
      <div style={{ display: 'flex', gap: 10 }}>
        <Form.Item label="温度 Temperature" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={0}
            max={2}
            step={0.1}
            style={{ width: '100%' }}
            value={data.temperature}
            disabled={disabled}
            onChange={(v) => update({ temperature: v ?? 0 })}
          />
        </Form.Item>
        <Form.Item label="最大 Token" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={1}
            max={32768}
            step={128}
            style={{ width: '100%' }}
            value={data.maxTokens}
            disabled={disabled}
            onChange={(v) => update({ maxTokens: v ?? 2048 })}
          />
        </Form.Item>
      </div>
      <SectionTitle desc="支持 {{节点.字段}} 模板插值">提示词 Prompt</SectionTitle>
      <TextArea
        rows={10}
        value={data.prompt}
        disabled={disabled}
        onChange={(e) => update({ prompt: e.target.value })}
        placeholder="你是一个有用的AI助手..."
        style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
      />
    </Form>
  );
}

function QuestionForm({ data, update, disabled }: ConfigFormProps<QuestionNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="模型">
        <Select
          size="small"
          value={data.model}
          disabled={disabled}
          onChange={(v) => update({ model: v })}
          options={MODEL_OPTIONS}
          showSearch
        />
      </Form.Item>
      <Form.Item label="关联知识库">
        <Input
          size="small"
          value={data.knowledgeRef}
          disabled={disabled}
          onChange={(e) => update({ knowledgeRef: e.target.value })}
          placeholder="knowledge-base-id"
          prefix={<Icons.CloudServerOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <Form.Item label="问题（支持 {{...}}）">
        <TextArea
          rows={4}
          value={data.question}
          disabled={disabled}
          onChange={(e) => update({ question: e.target.value })}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Form.Item>
    </Form>
  );
}

function ImageForm({ data, update, disabled }: ConfigFormProps<ImageNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="模型">
        <Select
          size="small"
          value={data.model}
          disabled={disabled}
          onChange={(v) => update({ model: v })}
          options={MODEL_OPTIONS}
          showSearch
        />
      </Form.Item>
      <Form.Item label="图片输入（URL / {{引用}}）">
        <Input
          size="small"
          value={data.imageInput}
          disabled={disabled}
          onChange={(e) => update({ imageInput: e.target.value })}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          prefix={<Icons.FileImageOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <Form.Item label="Prompt">
        <TextArea
          rows={4}
          value={data.prompt}
          disabled={disabled}
          onChange={(e) => update({ prompt: e.target.value })}
          placeholder="描述这张图片里的内容..."
        />
      </Form.Item>
    </Form>
  );
}

function ImageGenForm({ data, update, disabled }: ConfigFormProps<ImageGenNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="模型">
        <Select
          size="small"
          value={data.model}
          disabled={disabled}
          onChange={(v) => update({ model: v })}
          options={[
            { value: 'DALL-E 3', label: 'DALL-E 3' },
            { value: 'Stable Diffusion XL', label: 'Stable Diffusion XL' },
            { value: 'Midjourney', label: 'Midjourney（需接入）' },
          ]}
        />
      </Form.Item>
      <div style={{ display: 'flex', gap: 10 }}>
        <Form.Item label="宽度" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={256}
            max={4096}
            step={64}
            style={{ width: '100%' }}
            value={data.width}
            disabled={disabled}
            onChange={(v) => update({ width: v ?? 1024 })}
          />
        </Form.Item>
        <Form.Item label="高度" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={256}
            max={4096}
            step={64}
            style={{ width: '100%' }}
            value={data.height}
            disabled={disabled}
            onChange={(v) => update({ height: v ?? 1024 })}
          />
        </Form.Item>
      </div>
      <Form.Item label="Prompt">
        <TextArea
          rows={4}
          value={data.prompt}
          disabled={disabled}
          onChange={(e) => update({ prompt: e.target.value })}
        />
      </Form.Item>
    </Form>
  );
}

function ConditionForm({ data, update, disabled }: ConfigFormProps<ConditionNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="条件表达式">
        <TextArea
          rows={3}
          value={data.expression}
          disabled={disabled}
          onChange={(e) => update({ expression: e.target.value })}
          placeholder="例：{{startNode.input}}.length > 10"
          style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          返回 truthy 走 true（绿色口），否则走 false（红色口）
        </Text>
      </Form.Item>
      <div style={{ display: 'flex', gap: 10 }}>
        <Form.Item label="True 分支名" style={{ flex: 1 }}>
          <Input
            size="small"
            value={data.trueLabel}
            disabled={disabled}
            onChange={(e) => update({ trueLabel: e.target.value })}
            prefix={<span style={{ color: '#52c41a' }}>✓</span>}
          />
        </Form.Item>
        <Form.Item label="False 分支名" style={{ flex: 1 }}>
          <Input
            size="small"
            value={data.falseLabel}
            disabled={disabled}
            onChange={(e) => update({ falseLabel: e.target.value })}
            prefix={<span style={{ color: '#ff4d4f' }}>✕</span>}
          />
        </Form.Item>
      </div>
    </Form>
  );
}

function LoopForm({ data, update, disabled }: ConfigFormProps<LoopNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="循环模式">
        <Select
          size="small"
          value={data.mode}
          disabled={disabled}
          onChange={(v) => update({ mode: v })}
          options={[
            { value: 'array', label: '数组遍历（for each）' },
            { value: 'count', label: '指定次数（N 次）' },
            { value: 'infinite', label: '无限循环（需中断条件）' },
          ]}
        />
      </Form.Item>
      {data.mode === 'array' && (
        <Form.Item label="数组引用 {{节点.数组字段}}">
          <Input
            size="small"
            value={data.arrayRef ?? ''}
            disabled={disabled}
            onChange={(e) => update({ arrayRef: e.target.value })}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </Form.Item>
      )}
      {data.mode === 'count' && (
        <Form.Item label="次数（数字或 {{引用}}）">
          <Input
            size="small"
            value={data.countRef ?? ''}
            disabled={disabled}
            onChange={(e) => update({ countRef: e.target.value })}
            placeholder="10 或 {{startNode.count}}"
          />
        </Form.Item>
      )}
      <Form.Item label="中断条件（可选）">
        <Input
          size="small"
          value={data.breakCondition ?? ''}
          disabled={disabled}
          onChange={(e) => update({ breakCondition: e.target.value })}
          placeholder="例：result.count > 100"
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Form.Item>
    </Form>
  );
}

function SelectorForm({ data, update, disabled }: ConfigFormProps<SelectorNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="选择值（{{...}}）">
        <Input
          size="small"
          value={data.valueRef}
          disabled={disabled}
          onChange={(e) => update({ valueRef: e.target.value })}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          placeholder="{{节点.字段}}"
        />
      </Form.Item>
      <SectionTitle desc={`共 ${data.cases.length} 个分支`}>Case 分支</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.cases.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            <Input
              size="small"
              placeholder="分支名"
              value={c.label}
              disabled={disabled}
              onChange={(e) => {
                const next = [...data.cases];
                next[i] = { ...next[i], label: e.target.value };
                update({ cases: next });
              }}
              style={{ flex: '0 0 32%' }}
            />
            <Input
              size="small"
              placeholder="匹配值"
              value={c.value}
              disabled={disabled}
              onChange={(e) => {
                const next = [...data.cases];
                next[i] = { ...next[i], value: e.target.value };
                update({ cases: next });
              }}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
            <Button
              size="small"
              type="text"
              danger
              disabled={disabled}
              onClick={() =>
                update({ cases: data.cases.filter((_, idx) => idx !== i) })
              }
            >
              <Icons.DeleteOutlined />
            </Button>
          </div>
        ))}
        <Button
          size="small"
          type="dashed"
          block
          disabled={disabled}
          onClick={() =>
            update({
              cases: [
                ...data.cases,
                { label: `Case ${data.cases.length + 1}`, value: String(data.cases.length + 1) },
              ],
            })
          }
        >
          + 新增分支
        </Button>
      </div>
      <Form.Item
        label="包含默认分支"
        style={{ marginTop: 14, marginBottom: 0 }}
      >
        <Select
          size="small"
          value={data.hasDefault ? '1' : '0'}
          disabled={disabled}
          onChange={(v) => update({ hasDefault: v === '1' })}
          options={[
            { value: '1', label: '是（不匹配时走默认出口）' },
            { value: '0', label: '否（不匹配则停止）' },
          ]}
        />
      </Form.Item>
    </Form>
  );
}

function IntentForm({ data, update, disabled }: ConfigFormProps<IntentNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="识别模型">
        <Select
          size="small"
          value={data.model}
          disabled={disabled}
          onChange={(v) => update({ model: v })}
          options={MODEL_OPTIONS}
          showSearch
        />
      </Form.Item>
      <SectionTitle desc={`共 ${data.intents.length} 个意图`}>意图列表</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.intents.map((it, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <Input
              size="small"
              placeholder="意图名"
              value={it.label}
              disabled={disabled}
              onChange={(e) => {
                const next = [...data.intents];
                next[i] = { ...next[i], label: e.target.value };
                update({ intents: next });
              }}
              style={{ flex: '0 0 30%' }}
            />
            <Input
              size="small"
              placeholder="描述 / 示例（帮助模型识别）"
              value={it.description}
              disabled={disabled}
              onChange={(e) => {
                const next = [...data.intents];
                next[i] = { ...next[i], description: e.target.value };
                update({ intents: next });
              }}
              style={{ flex: 1 }}
            />
            <Button
              size="small"
              type="text"
              danger
              disabled={disabled}
              onClick={() =>
                update({ intents: data.intents.filter((_, idx) => idx !== i) })
              }
            >
              <Icons.DeleteOutlined />
            </Button>
          </div>
        ))}
        <Button
          size="small"
          type="dashed"
          block
          disabled={disabled}
          onClick={() =>
            update({
              intents: [
                ...data.intents,
                { label: `意图 ${data.intents.length + 1}`, description: '' },
              ],
            })
          }
        >
          + 新增意图
        </Button>
      </div>
    </Form>
  );
}

function RetrievalForm({ data, update, disabled }: ConfigFormProps<RetrievalNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="知识库 ID / 名称">
        <Input
          size="small"
          value={data.knowledgeRef}
          disabled={disabled}
          onChange={(e) => update({ knowledgeRef: e.target.value })}
          prefix={<Icons.CloudServerOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <Form.Item label="查询 Query（{{...}}）">
        <TextArea
          rows={3}
          value={data.query}
          disabled={disabled}
          onChange={(e) => update({ query: e.target.value })}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Form.Item>
      <div style={{ display: 'flex', gap: 10 }}>
        <Form.Item label="TopK" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={1}
            max={50}
            style={{ width: '100%' }}
            value={data.topK}
            disabled={disabled}
            onChange={(v) => update({ topK: v ?? 5 })}
          />
        </Form.Item>
        <Form.Item label="相似度阈值" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={0}
            max={1}
            step={0.05}
            style={{ width: '100%' }}
            value={data.threshold}
            disabled={disabled}
            onChange={(v) => update({ threshold: v ?? 0.7 })}
          />
        </Form.Item>
      </div>
    </Form>
  );
}

function DatasetWriteForm({
  data,
  update,
  disabled,
}: ConfigFormProps<DatasetWriteNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="目标知识库">
        <Input
          size="small"
          value={data.knowledgeRef}
          disabled={disabled}
          onChange={(e) => update({ knowledgeRef: e.target.value })}
          prefix={<Icons.CloudUploadOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <Form.Item label="内容引用 {{...}}">
        <Input
          size="small"
          value={data.contentRef}
          disabled={disabled}
          onChange={(e) => update({ contentRef: e.target.value })}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Form.Item>
      <div style={{ display: 'flex', gap: 10 }}>
        <Form.Item label="切块大小" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={10}
            max={5000}
            step={50}
            style={{ width: '100%' }}
            value={data.chunkSize}
            disabled={disabled}
            onChange={(v) => update({ chunkSize: v ?? 500 })}
          />
        </Form.Item>
        <Form.Item label="块重叠" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={0}
            max={500}
            step={10}
            style={{ width: '100%' }}
            value={data.chunkOverlap}
            disabled={disabled}
            onChange={(v) => update({ chunkOverlap: v ?? 50 })}
          />
        </Form.Item>
      </div>
    </Form>
  );
}

function BatchForm({ data, update, disabled }: ConfigFormProps<BatchNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="数组引用">
        <Input
          size="small"
          value={data.arrayRef}
          disabled={disabled}
          onChange={(e) => update({ arrayRef: e.target.value })}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          placeholder="{{retrievalNode.result}}"
        />
      </Form.Item>
      <Form.Item label="并发度（1~100）">
        <InputNumber
          size="small"
          min={1}
          max={100}
          style={{ width: '100%' }}
          value={data.parallelism}
          disabled={disabled}
          onChange={(v) => update({ parallelism: v ?? 3 })}
        />
      </Form.Item>
    </Form>
  );
}

function DataAddForm({ data, update, disabled }: ConfigFormProps<DataAddNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="目标数据表">
        <Input
          size="small"
          value={data.table}
          disabled={disabled}
          onChange={(e) => update({ table: e.target.value })}
          prefix={<Icons.TableOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <SectionTitle desc={`共 ${data.fields.length} 个字段`}>列映射</SectionTitle>
      <KeyValueEditor
        rows={data.fields.map((f) => ({ k: f.column, v: f.valueRef }))}
        kPlaceholder="列名 column"
        vPlaceholder="值 {{...}}"
        disabled={disabled}
        onChange={(rows) => update({ fields: rows.map((r) => ({ column: r.k, valueRef: r.v })) })}
      />
    </Form>
  );
}

function DataQueryForm({ data, update, disabled }: ConfigFormProps<DataQueryNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="数据表">
        <Input
          size="small"
          value={data.table}
          disabled={disabled}
          onChange={(e) => update({ table: e.target.value })}
          prefix={<Icons.TableOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <SectionTitle>过滤条件</SectionTitle>
      <FilterEditor
        filters={data.filters}
        disabled={disabled}
        onChange={(filters) => update({ filters })}
      />
      <Form.Item label="返回条数 limit" style={{ marginTop: 12 }}>
        <InputNumber
          size="small"
          min={1}
          max={1000}
          style={{ width: '100%' }}
          value={data.limit}
          disabled={disabled}
          onChange={(v) => update({ limit: v ?? 100 })}
        />
      </Form.Item>
    </Form>
  );
}

function DataUpdateForm({ data, update, disabled }: ConfigFormProps<DataUpdateNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="数据表">
        <Input
          size="small"
          value={data.table}
          disabled={disabled}
          onChange={(e) => update({ table: e.target.value })}
          prefix={<Icons.TableOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <SectionTitle>过滤条件</SectionTitle>
      <FilterEditor
        filters={data.filters}
        disabled={disabled}
        onChange={(filters) => update({ filters })}
      />
      <SectionTitle>更新赋值（SET）</SectionTitle>
      <KeyValueEditor
        rows={data.sets.map((s) => ({ k: s.column, v: s.valueRef }))}
        kPlaceholder="列名"
        vPlaceholder="值 / {{...}}"
        disabled={disabled}
        onChange={(rows) => update({ sets: rows.map((r) => ({ column: r.k, valueRef: r.v })) })}
      />
    </Form>
  );
}

function DataDeleteForm({ data, update, disabled }: ConfigFormProps<DataDeleteNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="数据表">
        <Input
          size="small"
          value={data.table}
          disabled={disabled}
          onChange={(e) => update({ table: e.target.value })}
          prefix={<Icons.TableOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <SectionTitle>删除条件（至少 1 条）</SectionTitle>
      <FilterEditor
        filters={data.filters}
        disabled={disabled}
        onChange={(filters) => update({ filters })}
      />
    </Form>
  );
}

function SqlForm({ data, update, disabled }: ConfigFormProps<SqlNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="数据表（可选，用于辅助）">
        <Input
          size="small"
          value={data.table}
          disabled={disabled}
          onChange={(e) => update({ table: e.target.value })}
        />
      </Form.Item>
      <SectionTitle>SQL 语句（使用 :param 占位）</SectionTitle>
      <TextArea
        rows={6}
        value={data.sql}
        disabled={disabled}
        onChange={(e) => update({ sql: e.target.value })}
        placeholder="SELECT * FROM orders WHERE id = :id AND status = :s"
        style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
      />
      <SectionTitle desc={`共 ${data.params.length} 个参数`}>参数绑定</SectionTitle>
      <KeyValueEditor
        rows={data.params.map((p) => ({ k: p.key, v: p.valueRef }))}
        kPlaceholder="占位名（不带冒号）"
        vPlaceholder="值 / {{...}}"
        disabled={disabled}
        onChange={(rows) => update({ params: rows.map((r) => ({ key: r.k, valueRef: r.v })) })}
      />
    </Form>
  );
}

function HttpForm({ data, update, disabled }: ConfigFormProps<HttpNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Form.Item label="方法" style={{ flex: '0 0 110px' }}>
          <Select
            size="small"
            value={data.method}
            disabled={disabled}
            onChange={(v) => update({ method: v as HttpNodeData['method'] })}
            options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
          />
        </Form.Item>
        <Form.Item label="URL" style={{ flex: 1 }}>
          <Input
            size="small"
            value={data.url}
            disabled={disabled}
            onChange={(e) => update({ url: e.target.value })}
            placeholder="https://api.example.com/..."
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            prefix={<Icons.GlobalOutlined style={{ color: '#9ca3af' }} />}
          />
        </Form.Item>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Form.Item label="超时（秒）" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={1}
            max={600}
            style={{ width: '100%' }}
            value={data.timeout}
            disabled={disabled}
            onChange={(v) => update({ timeout: v ?? 15 })}
          />
        </Form.Item>
        <Form.Item label="认证方式" style={{ flex: 1 }}>
          <Select
            size="small"
            value={data.authType}
            disabled={disabled}
            onChange={(v) => update({ authType: v as HttpNodeData['authType'] })}
            options={[
              { value: 'none', label: '无' },
              { value: 'bearer', label: 'Bearer Token' },
              { value: 'basic', label: 'Basic Auth' },
            ]}
          />
        </Form.Item>
      </div>
      {data.authType !== 'none' && (
        <Form.Item label={data.authType === 'bearer' ? 'Token' : '用户名:密码'}>
          <Input.Password
            size="small"
            value={data.authValue}
            disabled={disabled}
            onChange={(e) => update({ authValue: e.target.value })}
            placeholder={data.authType === 'bearer' ? 'sk-...' : 'user:pass'}
          />
        </Form.Item>
      )}
      <SectionTitle desc={`共 ${data.headers.length} 个请求头`}>Headers</SectionTitle>
      <KeyValueEditor
        rows={data.headers.map((h) => ({ k: h.key, v: h.value }))}
        kPlaceholder="Header 名"
        vPlaceholder="值"
        disabled={disabled}
        onChange={(rows) => update({ headers: rows.map((r) => ({ key: r.k, value: r.v })) })}
      />
      <SectionTitle>Body</SectionTitle>
      <TextArea
        rows={5}
        value={data.body}
        disabled={disabled}
        onChange={(e) => update({ body: e.target.value })}
        placeholder='{"key": "{{startNode.input}}"}'
        style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
      />
    </Form>
  );
}

function CodeForm({ data, update, disabled }: ConfigFormProps<CodeNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <div style={{ display: 'flex', gap: 10 }}>
        <Form.Item label="语言" style={{ flex: 1 }}>
          <Select
            size="small"
            value={data.language}
            disabled={disabled}
            onChange={(v) => update({ language: v })}
            options={LANG_OPTIONS}
          />
        </Form.Item>
        <Form.Item label="超时（秒）" style={{ flex: 1 }}>
          <InputNumber
            size="small"
            min={1}
            max={600}
            style={{ width: '100%' }}
            value={data.timeout}
            disabled={disabled}
            onChange={(v) => update({ timeout: v ?? 30 })}
          />
        </Form.Item>
      </div>
      <SectionTitle desc="输入通过 input 变量；返回对象作为节点输出">代码</SectionTitle>
      <TextArea
        rows={14}
        value={data.code}
        disabled={disabled}
        onChange={(e) => update({ code: e.target.value })}
        placeholder="// 例如：\nconst r = input.value * 2;\nreturn { result: r };"
        style={{
          fontFamily: 'Consolas, monospace',
          fontSize: 12,
          background: '#0f172a',
          color: '#e2e8f0',
          border: '1px solid #1e293b',
        }}
      />
    </Form>
  );
}

function PluginForm({ data, update, disabled }: ConfigFormProps<PluginNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="插件名称">
        <Input
          size="small"
          value={data.pluginName}
          disabled={disabled}
          onChange={(e) => update({ pluginName: e.target.value })}
          prefix={<Icons.AppstoreOutlined style={{ color: '#9ca3af' }} />}
        />
      </Form.Item>
      <SectionTitle desc={`共 ${data.args.length} 个参数`}>插件参数</SectionTitle>
      <KeyValueEditor
        rows={data.args.map((p) => ({ k: p.key, v: p.valueRef }))}
        kPlaceholder="参数名"
        vPlaceholder="值 / {{...}}"
        disabled={disabled}
        onChange={(rows) => update({ args: rows.map((r) => ({ key: r.k, valueRef: r.v })) })}
      />
    </Form>
  );
}

function MessageForm({ data, update, disabled }: ConfigFormProps<MessageNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="发送通道">
        <Select
          size="small"
          value={data.channel}
          disabled={disabled}
          onChange={(v) => update({ channel: v })}
          options={[
            { value: 'chat', label: '对话窗口（Chat）' },
            { value: 'webhook', label: 'Webhook' },
            { value: 'sms', label: '短信 SMS' },
          ]}
        />
      </Form.Item>
      <Form.Item label="消息模板（支持 {{节点.字段}}）">
        <TextArea
          rows={5}
          value={data.template}
          disabled={disabled}
          onChange={(e) => update({ template: e.target.value })}
          placeholder="您好，处理结果：{{llmNode.result}}"
        />
      </Form.Item>
    </Form>
  );
}

function SleepForm({ data, update, disabled }: ConfigFormProps<SleepNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="延时（毫秒）">
        <InputNumber
          size="small"
          min={0}
          max={600_000}
          step={100}
          style={{ width: '100%' }}
          value={data.delayMs}
          disabled={disabled}
          onChange={(v) => update({ delayMs: v ?? 1000 })}
          addonAfter={<Text type="secondary">{(data.delayMs / 1000).toFixed(1)}s</Text>}
        />
      </Form.Item>
    </Form>
  );
}

function LtmWriteForm({ data, update, disabled }: ConfigFormProps<LtmWriteNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="写入内容引用">
        <Input
          size="small"
          value={data.contentRef}
          disabled={disabled}
          onChange={(e) => update({ contentRef: e.target.value })}
          placeholder="{{llmNode.result}}"
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Form.Item>
      <Form.Item label="标签 Tags（逗号分隔）">
        <Input
          size="small"
          value={data.tags.join(', ')}
          disabled={disabled}
          onChange={(e) =>
            update({
              tags: e.target.value
                .split(/[,;，]/)
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="workflow, summary, user-pref"
        />
      </Form.Item>
    </Form>
  );
}

function LtmReadForm({ data, update, disabled }: ConfigFormProps<LtmReadNodeData>) {
  return (
    <Form layout="vertical" size="small">
      <NodeNameField
        value={data.label}
        onChange={(v) => update({ label: v })}
        disabled={disabled}
      />
      <Form.Item label="查询 Query">
        <Input
          size="small"
          value={data.query}
          disabled={disabled}
          onChange={(e) => update({ query: e.target.value })}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          placeholder="{{startNode.input}}"
        />
      </Form.Item>
      <Form.Item label="召回条数 TopK">
        <InputNumber
          size="small"
          min={1}
          max={50}
          style={{ width: '100%' }}
          value={data.topK}
          disabled={disabled}
          onChange={(v) => update({ topK: v ?? 5 })}
        />
      </Form.Item>
    </Form>
  );
}

// ===== 通用小组件 =====

interface KVRow {
  k: string;
  v: string;
}
function KeyValueEditor({
  rows,
  onChange,
  disabled,
  kPlaceholder,
  vPlaceholder,
}: {
  rows: KVRow[];
  onChange: (r: KVRow[]) => void;
  disabled?: boolean;
  kPlaceholder?: string;
  vPlaceholder?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <Input
            size="small"
            value={row.k}
            disabled={disabled}
            placeholder={kPlaceholder}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i], k: e.target.value };
              onChange(next);
            }}
            style={{ flex: '0 0 38%' }}
          />
          <Input
            size="small"
            value={row.v}
            disabled={disabled}
            placeholder={vPlaceholder}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...next[i], v: e.target.value };
              onChange(next);
            }}
            style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
          />
          <Button
            size="small"
            type="text"
            danger
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
          >
            <Icons.DeleteOutlined />
          </Button>
        </div>
      ))}
      <Button
        size="small"
        type="dashed"
        block
        disabled={disabled}
        onClick={() => onChange([...rows, { k: '', v: '' }])}
      >
        + 新增一项
      </Button>
    </div>
  );
}

type FilterRow = { column: string; op: string; valueRef: string };
function FilterEditor({
  filters,
  onChange,
  disabled,
}: {
  filters: FilterRow[];
  onChange: (f: FilterRow[]) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {filters.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <Input
            size="small"
            value={row.column}
            disabled={disabled}
            placeholder="列 column"
            onChange={(e) => {
              const next = [...filters];
              next[i] = { ...next[i], column: e.target.value };
              onChange(next);
            }}
            style={{ flex: '0 0 28%' }}
          />
          <Select
            size="small"
            value={row.op}
            disabled={disabled}
            onChange={(v) => {
              const next = [...filters];
              next[i] = { ...next[i], op: v };
              onChange(next);
            }}
            style={{ flex: '0 0 70px' }}
            options={[
              { value: '=', label: '=' },
              { value: '!=', label: '!=' },
              { value: '>', label: '>' },
              { value: '<', label: '<' },
              { value: '>=', label: '>=' },
              { value: '<=', label: '<=' },
              { value: 'LIKE', label: 'LIKE' },
              { value: 'IN', label: 'IN' },
            ]}
          />
          <Input
            size="small"
            value={row.valueRef}
            disabled={disabled}
            placeholder="值 / {{...}}"
            onChange={(e) => {
              const next = [...filters];
              next[i] = { ...next[i], valueRef: e.target.value };
              onChange(next);
            }}
            style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
          />
          <Button
            size="small"
            type="text"
            danger
            disabled={disabled}
            onClick={() => onChange(filters.filter((_, idx) => idx !== i))}
          >
            <Icons.DeleteOutlined />
          </Button>
        </div>
      ))}
      <Button
        size="small"
        type="dashed"
        block
        disabled={disabled}
        onClick={() => onChange([...filters, { column: '', op: '=', valueRef: '' }])}
      >
        + 新增条件
      </Button>
    </div>
  );
}

function FieldDefEditor({
  fields,
  onChange,
  disabled,
}: {
  fields: WorkflowFieldDef[];
  onChange: (f: WorkflowFieldDef[]) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {fields.map((f, i) => (
        <div
          key={i}
          style={{
            padding: 8,
            border: '1px solid #eef0f3',
            borderRadius: 6,
            background: '#fafbfc',
          }}
        >
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Input
              size="small"
              value={f.key}
              disabled={disabled}
              placeholder="字段 key"
              onChange={(e) => {
                const next = [...fields];
                next[i] = { ...next[i], key: e.target.value };
                onChange(next);
              }}
              style={{ flex: 1 }}
            />
            <Input
              size="small"
              value={f.label}
              disabled={disabled}
              placeholder="展示 label"
              onChange={(e) => {
                const next = [...fields];
                next[i] = { ...next[i], label: e.target.value };
                onChange(next);
              }}
              style={{ flex: 1 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Select
              size="small"
              value={f.type}
              disabled={disabled}
              onChange={(v) => {
                const next = [...fields];
                next[i] = { ...next[i], type: v as WorkflowFieldDef['type'] };
                onChange(next);
              }}
              style={{ flex: '0 0 120px' }}
              options={[
                { value: 'string', label: 'string' },
                { value: 'integer', label: 'integer' },
                { value: 'number', label: 'number' },
                { value: 'boolean', label: 'boolean' },
                { value: 'object', label: 'object' },
                { value: 'array', label: 'array' },
                { value: 'file', label: 'file' },
              ]}
            />
            <Select
              size="small"
              value={f.required ? '1' : '0'}
              disabled={disabled}
              onChange={(v) => {
                const next = [...fields];
                next[i] = { ...next[i], required: v === '1' };
                onChange(next);
              }}
              style={{ flex: '0 0 90px' }}
              options={[
                { value: '1', label: '必填' },
                { value: '0', label: '选填' },
              ]}
            />
            <Input
              size="small"
              value={f.defaultValue === undefined ? '' : JSON.stringify(f.defaultValue)}
              disabled={disabled}
              placeholder="默认值（JSON）"
              onChange={(e) => {
                const next = [...fields];
                try {
                  next[i] = {
                    ...next[i],
                    defaultValue: e.target.value ? JSON.parse(e.target.value) : undefined,
                  };
                } catch {
                  next[i] = { ...next[i], defaultValue: e.target.value };
                }
                onChange(next);
              }}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
            <Button
              size="small"
              type="text"
              danger
              disabled={disabled}
              onClick={() => onChange(fields.filter((_, idx) => idx !== i))}
            >
              <Icons.DeleteOutlined />
            </Button>
          </div>
        </div>
      ))}
      <Button
        size="small"
        type="dashed"
        block
        disabled={disabled}
        onClick={() =>
          onChange([
            ...fields,
            {
              key: `field_${fields.length + 1}`,
              label: `字段 ${fields.length + 1}`,
              type: 'string',
              required: true,
            },
          ])
        }
      >
        + 新增字段
      </Button>
    </div>
  );
}

// ===== 28 种 type → 表单组件 =====
function renderSettingForm(
  type: NodeTypeUnion,
  data: WorkflowNodeData,
  update: UpdateFn,
  disabled: boolean,
): ReactNode {
  switch (type) {
    case NodeType.START:
      return <StartForm data={data as unknown as StartNodeData} update={update} disabled={disabled} />;
    case NodeType.END:
      return <EndForm data={data as unknown as EndNodeData} update={update} disabled={disabled} />;
    case NodeType.VARIABLE:
      return <VariableForm data={data as unknown as VariableNodeData} update={update} disabled={disabled} />;
    case NodeType.AGGREGATE:
      return <AggregateForm data={data as unknown as AggregateNodeData} update={update} disabled={disabled} />;
    case NodeType.WORKFLOW:
      return <WorkflowSubForm data={data as unknown as SubWorkflowNodeData} update={update} disabled={disabled} />;
    case NodeType.LLM:
      return <LLMForm data={data as unknown as LLMNodeData} update={update} disabled={disabled} />;
    case NodeType.QUESTION:
      return <QuestionForm data={data as unknown as QuestionNodeData} update={update} disabled={disabled} />;
    case NodeType.IMAGE:
      return <ImageForm data={data as unknown as ImageNodeData} update={update} disabled={disabled} />;
    case NodeType.IMAGE_GEN:
      return <ImageGenForm data={data as unknown as ImageGenNodeData} update={update} disabled={disabled} />;
    case NodeType.CONDITION:
      return <ConditionForm data={data as unknown as ConditionNodeData} update={update} disabled={disabled} />;
    case NodeType.LOOP:
      return <LoopForm data={data as unknown as LoopNodeData} update={update} disabled={disabled} />;
    case NodeType.SELECTOR:
      return <SelectorForm data={data as unknown as SelectorNodeData} update={update} disabled={disabled} />;
    case NodeType.INTENT:
      return <IntentForm data={data as unknown as IntentNodeData} update={update} disabled={disabled} />;
    case NodeType.RETRIEVAL:
      return <RetrievalForm data={data as unknown as RetrievalNodeData} update={update} disabled={disabled} />;
    case NodeType.DATASET_WRITE:
      return <DatasetWriteForm data={data as unknown as DatasetWriteNodeData} update={update} disabled={disabled} />;
    case NodeType.BATCH:
      return <BatchForm data={data as unknown as BatchNodeData} update={update} disabled={disabled} />;
    case NodeType.DATA_ADD:
      return <DataAddForm data={data as unknown as DataAddNodeData} update={update} disabled={disabled} />;
    case NodeType.DATA_QUERY:
      return <DataQueryForm data={data as unknown as DataQueryNodeData} update={update} disabled={disabled} />;
    case NodeType.DATA_UPDATE:
      return <DataUpdateForm data={data as unknown as DataUpdateNodeData} update={update} disabled={disabled} />;
    case NodeType.DATA_DELETE:
      return <DataDeleteForm data={data as unknown as DataDeleteNodeData} update={update} disabled={disabled} />;
    case NodeType.SQL:
      return <SqlForm data={data as unknown as SqlNodeData} update={update} disabled={disabled} />;
    case NodeType.HTTP:
      return <HttpForm data={data as unknown as HttpNodeData} update={update} disabled={disabled} />;
    case NodeType.CODE:
      return <CodeForm data={data as unknown as CodeNodeData} update={update} disabled={disabled} />;
    case NodeType.PLUGIN:
      return <PluginForm data={data as unknown as PluginNodeData} update={update} disabled={disabled} />;
    case NodeType.MESSAGE:
      return <MessageForm data={data as unknown as MessageNodeData} update={update} disabled={disabled} />;
    case NodeType.SLEEP:
      return <SleepForm data={data as unknown as SleepNodeData} update={update} disabled={disabled} />;
    case NodeType.LTM_WRITE:
      return <LtmWriteForm data={data as unknown as LtmWriteNodeData} update={update} disabled={disabled} />;
    case NodeType.LTM_READ:
      return <LtmReadForm data={data as unknown as LtmReadNodeData} update={update} disabled={disabled} />;
    default:
      return (
        <Form layout="vertical" size="small">
          <NodeNameField
            value={data.label}
            onChange={(v) => update({ label: v })}
            disabled={disabled}
          />
          <Empty
            description={<Text type="secondary">该类型暂无专项配置表单（v0.3.0 Demo）</Text>}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </Form>
      );
  }
}

// ===== 输入/输出 Tab：字段表 =====
function IOFieldsTab({ node }: { node: WorkflowNode }) {
  const columns = [
    {
      title: 'Key',
      dataIndex: 'key',
      key: 'key',
      width: 110,
      render: (v: string) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#1f2937' }}>{v}</span>
      ),
    },
    {
      title: 'Label',
      dataIndex: 'label',
      key: 'label',
      render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span>,
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (v: string) => (
        <Tag color="blue" style={{ fontSize: 11, margin: 0 }}>
          {v}
        </Tag>
      ),
    },
    {
      title: '必填',
      dataIndex: 'required',
      key: 'required',
      width: 56,
      render: (v?: boolean) => (v ? '是' : '否'),
    },
    {
      title: '默认值',
      dataIndex: 'defaultValue',
      key: 'defaultValue',
      render: (v: unknown) =>
        v === undefined || v === null ? (
          <span style={{ color: '#c0c4cc' }}>-</span>
        ) : (
          <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{String(v)}</span>
        ),
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <Divider orientation="left" style={{ margin: '6px 0' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: '#6032ff' }}>
            <ApiOutlined /> 输入字段（{node.data.inputs?.length ?? 0}）
          </span>
        </Divider>
        {(node.data.inputs ?? []).length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span style={{ fontSize: 12 }}>未定义输入字段</span>}
            style={{ padding: '20px 0' }}
          />
        ) : (
          <Table
            size="small"
            columns={columns}
            dataSource={(node.data.inputs ?? []).map((f, i) => ({ ...f, key: i }))}
            pagination={false}
          />
        )}
      </div>
      <div>
        <Divider orientation="left" style={{ margin: '6px 0' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: '#52c41a' }}>
            <Icons.ExportOutlined /> 输出字段（{node.data.outputs?.length ?? 0}）
          </span>
        </Divider>
        {(node.data.outputs ?? []).length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ fontSize: 12 }}>
                该节点输出由执行器自动推断，可在调试 Tab 查看结果
              </span>
            }
            style={{ padding: '20px 0' }}
          />
        ) : (
          <Table
            size="small"
            columns={columns}
            dataSource={(node.data.outputs ?? []).map((f, i) => ({ ...f, key: i }))}
            pagination={false}
          />
        )}
      </div>
    </div>
  );
}

// ===== 调试 Tab：JSON + 耗时 =====
function DebugTab({ node }: { node: WorkflowNode }) {
  const debug = node.data.debugOutput;
  const duration = node.data.durationMs;
  const hasOutput = debug !== undefined && debug !== null;

  const onCopy = () => {
    if (!hasOutput) return;
    const txt = JSON.stringify(debug, null, 2);
    navigator.clipboard
      ?.writeText(txt)
      .then(() => message.success('已复制到剪贴板'))
      .catch(() => message.error('复制失败'));
  };

  return (
    <>
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Tag
          color={
            node.data.status === NodeStatus.SUCCESS
              ? 'green'
              : node.data.status === NodeStatus.FAILED
                ? 'red'
                : node.data.status === NodeStatus.RUNNING
                  ? 'gold'
                  : 'default'
          }
        >
          状态：{statusText(node.data.status)}
        </Tag>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          耗时：
          <b style={{ color: '#1f2937', margin: '0 2px' }}>
            {duration === undefined ? '--' : `${duration} ms`}
          </b>
        </span>
      </div>
      <div
        style={{
          padding: 4,
          borderRadius: 6,
          background: '#0f172a',
          border: '1px solid #1e293b',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '4px 8px',
            borderBottom: '1px solid #1e293b',
            marginBottom: 4,
          }}
        >
          <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 500 }}>debugOutput.json</span>
          <Tooltip title="复制 JSON">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={onCopy}
              disabled={!hasOutput}
              style={{ color: '#e2e8f0', height: 22, padding: '0 6px' }}
            >
              复制
            </Button>
          </Tooltip>
        </div>
        <pre
          style={{
            margin: 0,
            padding: '8px 10px',
            color: '#e2e8f0',
            fontFamily: 'Consolas, monospace',
            fontSize: 11.5,
            lineHeight: 1.55,
            maxHeight: 360,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {hasOutput ? JSON.stringify(debug, null, 2) : '// 尚未运行。点击顶栏「调试」查看输出。'}
        </pre>
      </div>
    </>
  );
}

// ===== 主组件 =====
export default function ConfigPanel() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const isRunning = useWorkflowStore((s) => s.isRunning);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const deleteNodes = useWorkflowStore((s) => s.deleteNodes);

  const node = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId],
  );

  if (!node) {
    return (
      <div className="app-config" style={panelWrapStyle}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty
            description={<Text type="secondary">点击画布节点查看 / 修改配置</Text>}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      </div>
    );
  }

  const type = node.type as NodeTypeUnion;
  const meta = getMeta(type);
  const accent = meta.accent;
  const catMeta = CATEGORY_META[meta.category];
  const status: NodeStatusType = node.data.status;

  const update: UpdateFn = (patch) => updateNodeData(node.id, patch);

  const tabItems: TabsProps['items'] = [
    {
      key: 'settings',
      label: (
        <span>
          <SettingOutlined style={{ marginRight: 4 }} />
          设置
        </span>
      ),
      children: (
        <div style={tabPaneStyle}>
          {renderSettingForm(type, node.data, update, isRunning)}
        </div>
      ),
    },
    {
      key: 'io',
      label: (
        <span>
          <ApiOutlined style={{ marginRight: 4 }} />
          输入/输出
        </span>
      ),
      children: (
        <div style={tabPaneStyle}>
          <IOFieldsTab node={node} />
        </div>
      ),
    },
    {
      key: 'debug',
      label: (
        <span>
          <BugOutlined style={{ marginRight: 4 }} />
          调试
          {node.data.status !== NodeStatus.IDLE && (
            <span
              style={{
                display: 'inline-block',
                marginLeft: 6,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: statusColor(node.data.status),
                boxShadow:
                  node.data.status === NodeStatus.RUNNING
                    ? `0 0 0 2px ${statusColor(node.data.status)}33`
                    : undefined,
              }}
            />
          )}
        </span>
      ),
      children: (
        <div style={tabPaneStyle}>
          <DebugTab node={node} />
        </div>
      ),
    },
  ];

  return (
    <div className="app-config" style={panelWrapStyle}>
      {/* accent 顶条 */}
      <div style={topAccentStyle(accent)} />

      {/* 头部：图标 + 类型名 + 状态 + ID */}
      <div style={headerStyle(accent)}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={iconChipBig(accent)}>{pickIcon(meta.icon, '#fff', 18)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={typeNameStyle}>{meta.label}</div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                marginTop: 4,
              }}
            >
              <Tag
                color={catMeta.color}
                style={{ margin: 0, fontSize: 11, padding: '0 6px', height: 18, lineHeight: '16px' }}
              >
                {catMeta.label}
              </Tag>
              <Tag
                color={
                  status === NodeStatus.RUNNING
                    ? 'gold'
                    : status === NodeStatus.SUCCESS
                      ? 'green'
                      : status === NodeStatus.FAILED
                        ? 'red'
                        : 'default'
                }
                style={{ margin: 0, fontSize: 11, height: 18, lineHeight: '16px' }}
              >
                {statusText(status)}
              </Tag>
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: '#9ca3af',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <InfoCircleOutlined /> ID：{node.id}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs（含 3 个面板） */}
      <div style={tabsContainerStyle}>
        <Tabs
          defaultActiveKey="settings"
          size="small"
          items={tabItems}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, margin: 0 }}
          tabBarStyle={{
            padding: '0 12px',
            borderBottom: '1px solid #f0f2f5',
            margin: 0,
          }}
        />
      </div>

      {/* 底部：坐标 + 删除 */}
      <div
        style={{
          padding: 12,
          borderTop: '1px solid #f0f2f5',
          background: '#fafbfc',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
            fontSize: 12,
            color: '#6b7280',
            padding: '6px 10px',
            borderRadius: 6,
            background: '#fff',
            border: '1px solid #eef0f3',
          }}
        >
          <span>
            坐标：X&nbsp;<b style={{ color: '#1f2937' }}>{Math.round(node.position.x)}</b>
            &nbsp;&nbsp;Y&nbsp;<b style={{ color: '#1f2937' }}>{Math.round(node.position.y)}</b>
          </span>
          <span style={{ color: '#9ca3af' }}>type: {type}</span>
        </div>
        <Button
          danger
          block
          icon={<DeleteOutlined />}
          disabled={isRunning}
          onClick={() => deleteNodes(node.id)}
        >
          删除该节点
        </Button>
      </div>
    </div>
  );
}
