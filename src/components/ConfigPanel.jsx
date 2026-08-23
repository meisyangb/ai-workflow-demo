import { useMemo } from 'react';
import {
  Form,
  Input,
  Select,
  InputNumber,
  Button,
  Card,
  Divider,
  Typography,
  Empty,
  Tag,
} from 'antd';
import {
  DeleteOutlined,
  RobotOutlined,
  CodeOutlined,
  ForkOutlined,
} from '@ant-design/icons';
import {
  useWorkflowStore,
  NodeType,
  NodeStatus,
  statusColor,
  statusText,
} from '../store/workflowStore';

const { TextArea } = Input;
const { Text, Title } = Typography;

const panelWrapStyle = {
  width: 340,
  borderLeft: '1px solid #f0f0f0',
  background: '#fff',
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle = (status) => ({
  padding: '14px 16px',
  borderBottom: '1px solid #f0f0f0',
  background: `${statusColor(status)}10`,
});

function typeIcon(type) {
  const gray = '#595959';
  switch (type) {
    case NodeType.LLM:
      return <RobotOutlined style={{ color: gray }} />;
    case NodeType.CONDITION:
      return <ForkOutlined style={{ color: gray }} />;
    case NodeType.CODE:
      return <CodeOutlined style={{ color: gray }} />;
    default:
      return null;
  }
}

function typeName(type) {
  switch (type) {
    case NodeType.LLM:
      return 'LLM 大模型节点';
    case NodeType.CONDITION:
      return '条件分支节点';
    case NodeType.CODE:
      return '代码执行节点';
    default:
      return '节点';
  }
}

/**
 * LLM 节点配置
 */
function LLMConfigForm({ node, update, disabled }) {
  return (
    <Form layout="vertical" size="small">
      <Form.Item label="节点名称">
        <Input
          value={node.data.label}
          disabled={disabled}
          onChange={(e) => update({ label: e.target.value })}
          placeholder="节点显示名称"
        />
      </Form.Item>
      <Form.Item label="模型名称">
        <Select
          value={node.data.model}
          disabled={disabled}
          onChange={(v) => update({ model: v })}
          options={[
            { value: 'GPT-4o', label: 'GPT-4o' },
            { value: 'GPT-4o-mini', label: 'GPT-4o-mini' },
            { value: 'GPT-4 Turbo', label: 'GPT-4 Turbo' },
            { value: 'Claude 3.5 Sonnet', label: 'Claude 3.5 Sonnet' },
            { value: 'DeepSeek-V2', label: 'DeepSeek-V2' },
          ]}
        />
      </Form.Item>
      <Form.Item label="温度 (temperature)">
        <InputNumber
          min={0}
          max={2}
          step={0.1}
          style={{ width: '100%' }}
          value={node.data.temperature}
          disabled={disabled}
          onChange={(v) => update({ temperature: v ?? 0 })}
        />
      </Form.Item>
      <Form.Item label="最大输出 Token">
        <InputNumber
          min={1}
          max={32768}
          step={128}
          style={{ width: '100%' }}
          value={node.data.maxTokens}
          disabled={disabled}
          onChange={(v) => update({ maxTokens: v ?? 2048 })}
        />
      </Form.Item>
      <Form.Item label="提示词 (Prompt) - 用 {{变量}} 引用上游">
        <TextArea
          rows={8}
          value={node.data.prompt}
          disabled={disabled}
          onChange={(e) => update({ prompt: e.target.value })}
          placeholder="你是一个有用的AI助手..."
          style={{ fontFamily: 'monospace' }}
        />
      </Form.Item>
    </Form>
  );
}

/**
 * 条件分支配置
 */
function ConditionConfigForm({ node, update, disabled }) {
  return (
    <Form layout="vertical" size="small">
      <Form.Item label="节点名称">
        <Input
          value={node.data.label}
          disabled={disabled}
          onChange={(e) => update({ label: e.target.value })}
        />
      </Form.Item>
      <Form.Item label="条件表达式">
        <TextArea
          rows={3}
          value={node.data.expression}
          disabled={disabled}
          onChange={(e) => update({ expression: e.target.value })}
          placeholder="例如：{{input}} > 10  或  result.keywords.includes('代码')"
          style={{ fontFamily: 'monospace' }}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          返回 truthy 走 true 分支，否则走 false 分支
        </Text>
      </Form.Item>
      <Form.Item label="True 分支标签">
        <Input
          value={node.data.trueLabel}
          disabled={disabled}
          onChange={(e) => update({ trueLabel: e.target.value })}
        />
      </Form.Item>
      <Form.Item label="False 分支标签">
        <Input
          value={node.data.falseLabel}
          disabled={disabled}
          onChange={(e) => update({ falseLabel: e.target.value })}
        />
      </Form.Item>
    </Form>
  );
}

/**
 * 代码执行配置
 */
function CodeConfigForm({ node, update, disabled }) {
  return (
    <Form layout="vertical" size="small">
      <Form.Item label="节点名称">
        <Input
          value={node.data.label}
          disabled={disabled}
          onChange={(e) => update({ label: e.target.value })}
        />
      </Form.Item>
      <Form.Item label="语言">
        <Select
          value={node.data.language}
          disabled={disabled}
          onChange={(v) => update({ language: v })}
          options={[
            { value: 'javascript', label: 'JavaScript' },
            { value: 'python', label: 'Python' },
            { value: 'typescript', label: 'TypeScript' },
            { value: 'bash', label: 'Bash' },
          ]}
        />
      </Form.Item>
      <Form.Item label="超时时间 (秒)">
        <InputNumber
          min={1}
          max={300}
          step={1}
          style={{ width: '100%' }}
          value={node.data.timeout}
          disabled={disabled}
          onChange={(v) => update({ timeout: v ?? 30 })}
        />
      </Form.Item>
      <Form.Item label="代码 - 输入通过 input 获取，return 输出">
        <TextArea
          rows={10}
          value={node.data.code}
          disabled={disabled}
          onChange={(e) => update({ code: e.target.value })}
          placeholder="// 例如：\nreturn { result: input.x + input.y };"
          style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
        />
      </Form.Item>
    </Form>
  );
}

export default function ConfigPanel() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const isRunning = useWorkflowStore((s) => s.isRunning);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const deleteNodes = useWorkflowStore((s) => s.deleteNodes);

  const node = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId]
  );

  if (!node) {
    return (
      <div style={panelWrapStyle}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty
            description={<Text type="secondary">点击画布上的节点进行配置</Text>}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      </div>
    );
  }

  const status = node.data.status;
  const update = (patch) => updateNodeData(node.id, patch);

  return (
    <div style={panelWrapStyle}>
      <div style={headerStyle(status)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {typeIcon(node.type)}
          <Title level={5} style={{ margin: 0 }}>
            {typeName(node.type)}
          </Title>
        </div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
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
          >
            {statusText(status)}
          </Tag>
          <Text type="secondary" style={{ fontSize: 11 }}>
            ID: {node.id}
          </Text>
        </div>
      </div>

      <div style={{ padding: 16, flex: 1 }}>
        {node.type === NodeType.LLM && (
          <LLMConfigForm node={node} update={update} disabled={isRunning} />
        )}
        {node.type === NodeType.CONDITION && (
          <ConditionConfigForm node={node} update={update} disabled={isRunning} />
        )}
        {node.type === NodeType.CODE && (
          <CodeConfigForm node={node} update={update} disabled={isRunning} />
        )}
      </div>

      <Divider style={{ margin: 0 }} />

      <div style={{ padding: 12 }}>
        <Card size="small" title="节点坐标" variant="borderless">
          <Text type="secondary" style={{ fontSize: 12 }}>
            X: {Math.round(node.position.x)}，Y: {Math.round(node.position.y)}
          </Text>
        </Card>
        <Button
          danger
          block
          icon={<DeleteOutlined />}
          disabled={isRunning}
          style={{ marginTop: 12 }}
          onClick={() => deleteNodes(node.id)}
        >
          删除该节点
        </Button>
      </div>
    </div>
  );
}
