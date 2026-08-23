/**
 * 领域基础类型与纯函数（DAG 拓扑排序 / 枚举 / 默认配置 / 节点分类目录）
 *
 * 单独成模块，用于打破循环依赖：
 *   workflowStore  →  services/mockExecutionService  →  store/workflowStore  ❌
 *   抽出本模块后：
 *   workflowStore  →  workflowDomains ✔️
 *   mockExecutionService  →  workflowDomains ✔️
 *
 * 所有导出都是无副作用的类型/常量/纯函数，可安全地从任何模块 import。
 *
 * 节点种类对齐「扣子 Coze 工作流」官方模型（v0.3.0 支持 12 类核心节点）：
 *   - 基础：开始 startNode / 结束 endNode / 变量赋值 variableNode / 变量聚合 aggregateNode
 *   - 大模型：大模型 llmNode / 问答 questionNode / 图片理解 imageNode / 图像生成 imageGenNode
 *   - 逻辑：条件分支 conditionNode / 循环 loopNode / 选择器 selectorNode / 意图识别 intentNode
 *   - 数据：知识库检索 retrievalNode / 知识库写入 datasetWrite / 批处理 batchNode /
 *          新增数据 dataAddNode / 查询数据 dataQueryNode / 更新数据 dataUpdateNode / 删除数据 dataDeleteNode / SQL sqlNode
 *   - 工具：HTTP 请求 httpNode / 代码执行 codeNode / 插件 pluginNode / 子工作流 workflowNode
 *   - 消息：发送消息 messageNode / 延时 sleepNode
 *   - 长期记忆：记忆写入 ltmWriteNode / 记忆检索 ltmReadNode
 */

import type { Connection, Edge, Node } from '@xyflow/react';
import type { NodeChange, EdgeChange } from '@xyflow/react';

// ===== 节点分类（扣子同款分组，供 Sidebar 分类折叠展示）=====
export const NodeCategory = {
  BASIC: 'basic',
  LLM: 'llm',
  LOGIC: 'logic',
  DATA: 'data',
  TOOL: 'tool',
  MESSAGE: 'message',
  MEMORY: 'memory',
} as const;
export type NodeCategory = (typeof NodeCategory)[keyof typeof NodeCategory];

export const CATEGORY_META: Record<
  NodeCategory,
  { label: string; color: string; description: string }
> = {
  [NodeCategory.BASIC]: {
    label: '基础',
    color: '#2f54eb',
    description: '开始/结束、变量、子工作流等流程控制骨架',
  },
  [NodeCategory.LLM]: {
    label: '大模型',
    color: '#722ed1',
    description: 'LLM、图片理解、图像生成、问答等多模态能力',
  },
  [NodeCategory.LOGIC]: {
    label: '逻辑',
    color: '#13c2c2',
    description: '条件、循环、选择器、意图识别等流程分支节点',
  },
  [NodeCategory.DATA]: {
    label: '数据',
    color: '#52c41a',
    description: '知识库、数据集、SQL、批量处理等数据访问节点',
  },
  [NodeCategory.TOOL]: {
    label: '工具',
    color: '#fa8c16',
    description: 'HTTP 请求、代码、插件、外部系统对接节点',
  },
  [NodeCategory.MESSAGE]: {
    label: '消息与时间',
    color: '#1677ff',
    description: '消息发送、延时等交互和时间节点',
  },
  [NodeCategory.MEMORY]: {
    label: '长期记忆',
    color: '#eb2f96',
    description: '长期记忆 LTM 读写',
  },
};

// ===== 枚举（常量对象 + 派生字面量联合类型）=====
export const NodeStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
} as const;
export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];

/**
 * 节点类型全集（v0.3.0 共 28 个）。命名规则：
 *   - 与 import schema @coze 官方的 `type` 字段保持同音、语义一致；
 *   - 以 `xxxNode` 后缀避免与业务/保留字冲突；
 *   - 新增节点时，必须把 type 值也追加到 NODE_TYPE_VALUES、此处的 NodeType、
 *     defaultNodeData 分支、CustomNodes 的 nodeTypes 注册四处，保持四象限同步。
 */
export const NodeType = {
  // —— 基础（BASIC） ——
  START: 'startNode',
  END: 'endNode',
  VARIABLE: 'variableNode',
  AGGREGATE: 'aggregateNode',
  WORKFLOW: 'workflowNode',

  // —— 大模型（LLM） ——
  LLM: 'llmNode',
  QUESTION: 'questionNode',
  IMAGE: 'imageNode',
  IMAGE_GEN: 'imageGenNode',

  // —— 逻辑（LOGIC） ——
  CONDITION: 'conditionNode',
  LOOP: 'loopNode',
  SELECTOR: 'selectorNode',
  INTENT: 'intentNode',

  // —— 数据（DATA） ——
  RETRIEVAL: 'retrievalNode',
  DATASET_WRITE: 'datasetWriteNode',
  BATCH: 'batchNode',
  DATA_ADD: 'dataAddNode',
  DATA_QUERY: 'dataQueryNode',
  DATA_UPDATE: 'dataUpdateNode',
  DATA_DELETE: 'dataDeleteNode',
  SQL: 'sqlNode',

  // —— 工具（TOOL） ——
  HTTP: 'httpNode',
  CODE: 'codeNode',
  PLUGIN: 'pluginNode',

  // —— 消息与时间（MESSAGE） ——
  MESSAGE: 'messageNode',
  SLEEP: 'sleepNode',

  // —— 长期记忆（MEMORY） ——
  LTM_WRITE: 'ltmWriteNode',
  LTM_READ: 'ltmReadNode',
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

/**
 * 节点 → 分类 + 展示元信息（左侧节点面板、右侧 ConfigPanel、节点卡片头部图标/颜色都从这里取）。
 * 视觉风格参考扣子 Coze：
 *   - 深紫/靛蓝主色（LLM）、橙（工具）、青（逻辑）、绿（数据）、红（记忆）、蓝（消息）。
 */
export interface NodeMeta {
  type: NodeType;
  category: NodeCategory;
  label: string;
  description: string;
  /** Ant Design 图标名称（IconName 字符串，由 Sidebar 的 pickIcon() 动态映射） */
  icon: string;
  /** 节点头部渐变条主色（扣子同款顶条） */
  accent: string;
  /** 默认宽度（节点卡片外宽，px） */
  width?: number;
  /** 是否禁止创建多个（开始/结束节点默认只能 1 个） */
  singleton?: boolean;
  /** 是否默认出现在「示例工作流」里 */
  seed?: boolean;
}

export const NODE_METAS: NodeMeta[] = [
  // BASIC
  {
    type: NodeType.START,
    category: NodeCategory.BASIC,
    label: '开始',
    description: '工作流入口，定义输入字段',
    icon: 'PlayCircleOutlined',
    accent: '#1677ff',
    singleton: true,
    seed: true,
    width: 220,
  },
  {
    type: NodeType.END,
    category: NodeCategory.BASIC,
    label: '结束',
    description: '工作流出口，返回结果',
    icon: 'StopOutlined',
    accent: '#ff4d4f',
    singleton: true,
    seed: true,
    width: 220,
  },
  {
    type: NodeType.VARIABLE,
    category: NodeCategory.BASIC,
    label: '变量赋值',
    description: '创建或覆盖一个工作流变量',
    icon: 'FieldNumberOutlined',
    accent: '#2f54eb',
    seed: true,
  },
  {
    type: NodeType.AGGREGATE,
    category: NodeCategory.BASIC,
    label: '变量聚合',
    description: '聚合多个上游节点输出为一个对象',
    icon: 'ApartmentOutlined',
    accent: '#2f54eb',
  },
  {
    type: NodeType.WORKFLOW,
    category: NodeCategory.BASIC,
    label: '子工作流',
    description: '调用当前空间内另一个工作流',
    icon: 'ThunderboltOutlined',
    accent: '#2f54eb',
  },

  // LLM
  {
    type: NodeType.LLM,
    category: NodeCategory.LLM,
    label: '大模型',
    description: '调用大模型生成/推理，含 prompt 模板',
    icon: 'RobotOutlined',
    accent: '#722ed1',
    seed: true,
  },
  {
    type: NodeType.QUESTION,
    category: NodeCategory.LLM,
    label: '问答',
    description: '结合知识库，做端到端问答',
    icon: 'MessageOutlined',
    accent: '#722ed1',
  },
  {
    type: NodeType.IMAGE,
    category: NodeCategory.LLM,
    label: '图片理解',
    description: '多模态 LLM 读取图片并提取信息',
    icon: 'FileImageOutlined',
    accent: '#722ed1',
  },
  {
    type: NodeType.IMAGE_GEN,
    category: NodeCategory.LLM,
    label: '图像生成',
    description: '根据 prompt 生成图像',
    icon: 'PictureOutlined',
    accent: '#722ed1',
  },

  // LOGIC
  {
    type: NodeType.CONDITION,
    category: NodeCategory.LOGIC,
    label: '条件分支',
    description: '表达式为真/假走不同分支',
    icon: 'ForkOutlined',
    accent: '#13c2c2',
    seed: true,
  },
  {
    type: NodeType.LOOP,
    category: NodeCategory.LOGIC,
    label: '循环',
    description: '数组遍历 / 指定次数 / 无限循环三种模式',
    icon: 'SyncOutlined',
    accent: '#13c2c2',
  },
  {
    type: NodeType.SELECTOR,
    category: NodeCategory.LOGIC,
    label: '选择器',
    description: '根据分支值选择一条下游（Switch）',
    icon: 'PartitionOutlined',
    accent: '#13c2c2',
  },
  {
    type: NodeType.INTENT,
    category: NodeCategory.LOGIC,
    label: '意图识别',
    description: '识别用户输入意图，跳到对应下游',
    icon: 'AimOutlined',
    accent: '#13c2c2',
  },

  // DATA
  {
    type: NodeType.RETRIEVAL,
    category: NodeCategory.DATA,
    label: '知识库检索',
    description: '从知识库召回 Top K 相关片段',
    icon: 'SearchOutlined',
    accent: '#52c41a',
    seed: true,
  },
  {
    type: NodeType.DATASET_WRITE,
    category: NodeCategory.DATA,
    label: '知识库写入',
    description: '把文本或文件写入知识库',
    icon: 'UploadOutlined',
    accent: '#52c41a',
  },
  {
    type: NodeType.BATCH,
    category: NodeCategory.DATA,
    label: '批处理',
    description: '对数组每条数据执行子节点序列',
    icon: 'DatabaseOutlined',
    accent: '#52c41a',
  },
  {
    type: NodeType.DATA_ADD,
    category: NodeCategory.DATA,
    label: '新增数据',
    description: '向数据表插入一条记录',
    icon: 'PlusSquareOutlined',
    accent: '#52c41a',
  },
  {
    type: NodeType.DATA_QUERY,
    category: NodeCategory.DATA,
    label: '查询数据',
    description: '根据条件查询数据表记录',
    icon: 'FilterOutlined',
    accent: '#52c41a',
  },
  {
    type: NodeType.DATA_UPDATE,
    category: NodeCategory.DATA,
    label: '更新数据',
    description: '按条件更新数据表记录',
    icon: 'EditOutlined',
    accent: '#52c41a',
  },
  {
    type: NodeType.DATA_DELETE,
    category: NodeCategory.DATA,
    label: '删除数据',
    description: '按条件删除数据表记录',
    icon: 'DeleteOutlined',
    accent: '#52c41a',
  },
  {
    type: NodeType.SQL,
    category: NodeCategory.DATA,
    label: 'SQL 自定义',
    description: '手写 SQL 对数据做复杂查询',
    icon: 'ConsoleSqlOutlined',
    accent: '#52c41a',
  },

  // TOOL
  {
    type: NodeType.HTTP,
    category: NodeCategory.TOOL,
    label: 'HTTP 请求',
    description: '调用外部 API（REST/GraphQL/文件上传等）',
    icon: 'GlobalOutlined',
    accent: '#fa8c16',
    seed: true,
  },
  {
    type: NodeType.CODE,
    category: NodeCategory.TOOL,
    label: '代码执行',
    description: '运行 Python/JS 代码片段，支持输入 input',
    icon: 'CodeOutlined',
    accent: '#fa8c16',
    seed: true,
  },
  {
    type: NodeType.PLUGIN,
    category: NodeCategory.TOOL,
    label: '插件',
    description: '调用扣子插件',
    icon: 'AppstoreOutlined',
    accent: '#fa8c16',
  },

  // MESSAGE + TIME
  {
    type: NodeType.MESSAGE,
    category: NodeCategory.MESSAGE,
    label: '消息',
    description: '在对话流里推送一条消息',
    icon: 'SendOutlined',
    accent: '#1677ff',
  },
  {
    type: NodeType.SLEEP,
    category: NodeCategory.MESSAGE,
    label: '延时',
    description: '暂停 N 毫秒再进入下游',
    icon: 'ClockCircleOutlined',
    accent: '#1677ff',
  },

  // MEMORY
  {
    type: NodeType.LTM_WRITE,
    category: NodeCategory.MEMORY,
    label: '记忆写入',
    description: '把长期记忆写入 LTM',
    icon: 'SaveOutlined',
    accent: '#eb2f96',
  },
  {
    type: NodeType.LTM_READ,
    category: NodeCategory.MEMORY,
    label: '记忆检索',
    description: '从 LTM 中召回相关长期记忆',
    icon: 'FileSearchOutlined',
    accent: '#eb2f96',
  },
];

export const getMeta = (type: NodeType): NodeMeta => {
  const m = NODE_METAS.find((x) => x.type === type);
  if (!m) {
    // 兜底：返回 LLM 元信息，保证不会抛 undefined
    return NODE_METAS[4] as NodeMeta;
  }
  return m;
};

// ===== 字段定义（输入/输出）=====
export type FieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'file';

export interface WorkflowFieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  defaultValue?: unknown;
  description?: string;
}

// ===== v0.3.1 新增：条件规则、输出格式、错误消息等结构 =====
export type ConditionOp = 'eq' | 'ne' | 'gt' | 'lt' | 'contains' | 'empty' | 'regex';
export interface ConditionRule {
  field: string;
  op: ConditionOp;
  /** op=empty 时 value 无意义，可为空串 */
  value: string;
}
export interface RuleGroup {
  operator: 'AND' | 'OR';
  items: ConditionRule[];
}
export type LLMOutputType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export interface LLMOutputField {
  name: string;
  type: LLMOutputType;
  required: boolean;
}
export interface LLMOutputFormat {
  mode: 'text' | 'json';
  fields?: LLMOutputField[];
}

// ===== 节点数据模型 =====
/** 通用基础字段（所有节点 data 都含这几样） */
export interface BaseNodeData {
  label: string;
  status: NodeStatus;
  inputs?: WorkflowFieldDef[];
  outputs?: WorkflowFieldDef[];
  /** 上次运行的调试输出（右侧 ConfigPanel 调试 Tab 预览用） */
  debugOutput?: unknown;
  /** 节点运行耗时（ms） */
  durationMs?: number;
  /** v0.3.1 新增：节点失败时的错误消息（错误横幅 / 调试日志显示） */
  errorMessage?: string;
  /** v0.3.1 新增：预计耗时（毫秒），进度条推算百分比用；缺失时降级为 1200ms */
  estimatedDurationMs?: number;
  /** 索引签名：满足 ReactFlow<Record<string, unknown>> 泛型约束，
   *  并允许各子类节点自由扩展字段（variableName/model/prompt/...） */
  [key: string]: unknown;
}

// —— 基础 ——
export interface StartNodeData extends BaseNodeData {
  /** 入口输入字段 */
  inputs: WorkflowFieldDef[];
}
export interface EndNodeData extends BaseNodeData {
  /** 要输出的变量 key 列表，引用上游节点 */
  variables: string[];
}
export interface VariableNodeData extends BaseNodeData {
  variableName: string;
  /** 支持 {{上游节点.字段}} 模板 */
  expression: string;
  dataType: FieldType;
}
export interface AggregateNodeData extends BaseNodeData {
  mapping: { alias: string; ref: string }[];
}
export interface SubWorkflowNodeData extends BaseNodeData {
  workflowName: string;
  /** 参数映射：当前节点 key → 目标工作流输入 key */
  args: Record<string, string>;
}

// —— 大模型 ——
export interface LLMNodeData extends BaseNodeData {
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  /** v0.3.1 新增：输出格式（文本 vs 结构化 JSON） */
  outputFormat?: LLMOutputFormat;
}
export interface QuestionNodeData extends BaseNodeData {
  model: string;
  knowledgeRef: string;
  question: string;
  /** v0.3.1 新增：输出格式 */
  outputFormat?: LLMOutputFormat;
}
export interface ImageNodeData extends BaseNodeData {
  model: string;
  imageInput: string;
  prompt: string;
  /** v0.3.1 新增：输出格式 */
  outputFormat?: LLMOutputFormat;
}
export interface ImageGenNodeData extends BaseNodeData {
  model: string;
  prompt: string;
  width: number;
  height: number;
  /** v0.3.1 新增：输出格式（图像生成通常 text，但可写结构化描述） */
  outputFormat?: LLMOutputFormat;
}

// —— 逻辑 ——
export interface ConditionNodeData extends BaseNodeData {
  expression: string;
  trueLabel: string;
  falseLabel: string;
  /** v0.3.1 新增：可视化规则表（编译结果回写到 expression，兼容旧执行器） */
  rules?: RuleGroup;
}
export type LoopMode = 'array' | 'count' | 'infinite';
export interface LoopNodeData extends BaseNodeData {
  mode: LoopMode;
  arrayRef?: string;
  countRef?: string;
  breakCondition?: string;
}
export interface SelectorNodeData extends BaseNodeData {
  valueRef: string;
  cases: { label: string; value: string }[];
  hasDefault: boolean;
}
export interface IntentNodeData extends BaseNodeData {
  intents: { label: string; description: string }[];
  model: string;
}

// —— 数据 ——
export interface RetrievalNodeData extends BaseNodeData {
  knowledgeRef: string;
  query: string;
  topK: number;
  threshold: number;
}
export interface DatasetWriteNodeData extends BaseNodeData {
  knowledgeRef: string;
  contentRef: string;
  chunkSize: number;
  chunkOverlap: number;
}
export interface BatchNodeData extends BaseNodeData {
  arrayRef: string;
  parallelism: number;
}
export interface DataAddNodeData extends BaseNodeData {
  table: string;
  fields: { column: string; valueRef: string }[];
}
export interface DataQueryNodeData extends BaseNodeData {
  table: string;
  filters: { column: string; op: string; valueRef: string }[];
  limit: number;
}
export interface DataUpdateNodeData extends BaseNodeData {
  table: string;
  filters: { column: string; op: string; valueRef: string }[];
  sets: { column: string; valueRef: string }[];
}
export interface DataDeleteNodeData extends BaseNodeData {
  table: string;
  filters: { column: string; op: string; valueRef: string }[];
}
export interface SqlNodeData extends BaseNodeData {
  table: string;
  sql: string;
  params: { key: string; valueRef: string }[];
}

// —— 工具 ——
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
export interface HttpNodeData extends BaseNodeData {
  method: HttpMethod;
  url: string;
  headers: { key: string; value: string }[];
  body: string;
  timeout: number;
  authType: 'none' | 'bearer' | 'basic';
  authValue: string;
}
export interface CodeNodeData extends BaseNodeData {
  language: 'javascript' | 'python';
  code: string;
  timeout: number;
}
export interface PluginNodeData extends BaseNodeData {
  pluginName: string;
  pluginIcon: string;
  /** 插件参数：key → 值模板引用（{{上游节点.字段}}），结构与 HttpNode.params 对齐 */
  args: { key: string; valueRef: string }[];
}

// —— 消息/时间 ——
export interface MessageNodeData extends BaseNodeData {
  channel: 'chat' | 'webhook' | 'sms';
  template: string;
}
export interface SleepNodeData extends BaseNodeData {
  delayMs: number;
}

// —— 长期记忆 ——
export interface LtmWriteNodeData extends BaseNodeData {
  contentRef: string;
  tags: string[];
}
export interface LtmReadNodeData extends BaseNodeData {
  query: string;
  topK: number;
}

/** 节点数据联合类型（所有 data 都必须是 BaseNodeData 的子结构） */
export type WorkflowNodeData =
  | StartNodeData
  | EndNodeData
  | VariableNodeData
  | AggregateNodeData
  | SubWorkflowNodeData
  | LLMNodeData
  | QuestionNodeData
  | ImageNodeData
  | ImageGenNodeData
  | ConditionNodeData
  | LoopNodeData
  | SelectorNodeData
  | IntentNodeData
  | RetrievalNodeData
  | DatasetWriteNodeData
  | BatchNodeData
  | DataAddNodeData
  | DataQueryNodeData
  | DataUpdateNodeData
  | DataDeleteNodeData
  | SqlNodeData
  | HttpNodeData
  | CodeNodeData
  | PluginNodeData
  | MessageNodeData
  | SleepNodeData
  | LtmWriteNodeData
  | LtmReadNodeData;

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

export type { Connection, NodeChange, EdgeChange };

// 状态对应颜色 / 文本（UI 用，不依赖 store）
export const statusColor = (status: NodeStatus): string => {
  switch (status) {
    case NodeStatus.RUNNING:
      return '#faad14';
    case NodeStatus.SUCCESS:
      return '#52c41a';
    case NodeStatus.FAILED:
      return '#ff4d4f';
    default:
      return '#e5e6eb';
  }
};

export const statusText = (status: NodeStatus): string => {
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

// ===== 各节点类型的默认配置（扣子风格预设字段）=====
const baseDefaults = (label: string): BaseNodeData => ({
  label,
  status: NodeStatus.IDLE,
  inputs: [],
  outputs: [],
});

export const defaultNodeData = (type: NodeType): WorkflowNodeData => {
  switch (type) {
    // —— 基础 ——
    case NodeType.START:
      return {
        ...baseDefaults('开始'),
        inputs: [
          { key: 'input', label: '输入', type: 'string', required: true, description: '工作流的初始输入' },
        ],
      };
    case NodeType.END:
      return { ...baseDefaults('结束'), variables: ['llmNode.result'] };
    case NodeType.VARIABLE:
      return {
        ...baseDefaults('变量赋值'),
        variableName: 'myVar',
        expression: '{{startNode.input}}',
        dataType: 'string',
      };
    case NodeType.AGGREGATE:
      return {
        ...baseDefaults('变量聚合'),
        mapping: [
          { alias: 'question', ref: '{{startNode.input}}' },
          { alias: 'answer', ref: '{{llmNode.result}}' },
        ],
      };
    case NodeType.WORKFLOW:
      return {
        ...baseDefaults('子工作流'),
        workflowName: '',
        args: { query: '{{startNode.input}}' },
      };

    // —— 大模型 ——
    case NodeType.LLM:
      return {
        ...baseDefaults('大模型节点'),
        outputs: [
          { key: 'result', label: '回复文本', type: 'string', required: true },
          { key: 'keywords', label: '关键词（数组）', type: 'array', required: false },
          { key: 'model', label: '实际模型名', type: 'string', required: false },
          { key: 'tokens', label: '消耗 token 数', type: 'integer', required: false },
        ],
        model: 'GPT-4o',
        prompt: '你是一个有用的 AI 助手，请根据用户输入回答问题。\n用户输入：{{startNode.input}}',
        temperature: 0.7,
        maxTokens: 2048,
      };
    case NodeType.QUESTION:
      return {
        ...baseDefaults('问答'),
        model: 'GPT-4o-mini',
        knowledgeRef: '',
        question: '{{startNode.input}}',
      };
    case NodeType.IMAGE:
      return {
        ...baseDefaults('图片理解'),
        model: 'GPT-4o',
        imageInput: '{{startNode.imageUrl}}',
        prompt: '描述这张图片里的内容',
      };
    case NodeType.IMAGE_GEN:
      return {
        ...baseDefaults('图像生成'),
        model: 'DALL-E 3',
        prompt: '{{startNode.input}}',
        width: 1024,
        height: 1024,
      };

    // —— 逻辑 ——
    case NodeType.CONDITION:
      return {
        ...baseDefaults('条件分支'),
        expression: '{{startNode.input}}.length > 10',
        rules: {
          operator: 'AND',
          items: [
            { field: '{{startNode.input}}.length', op: 'gt', value: '10' },
          ],
        },
        trueLabel: '满足',
        falseLabel: '不满足',
      };
    case NodeType.LOOP:
      return {
        ...baseDefaults('循环'),
        mode: 'array',
        arrayRef: '{{startNode.input}}',
        breakCondition: '',
      };
    case NodeType.SELECTOR:
      return {
        ...baseDefaults('选择器'),
        valueRef: '{{startNode.input}}',
        cases: [
          { label: 'A 路线', value: 'A' },
          { label: 'B 路线', value: 'B' },
        ],
        hasDefault: true,
      };
    case NodeType.INTENT:
      return {
        ...baseDefaults('意图识别'),
        model: 'GPT-4o-mini',
        intents: [
          { label: '投诉', description: '用户表达不满' },
          { label: '咨询', description: '用户询问信息' },
        ],
      };

    // —— 数据 ——
    case NodeType.RETRIEVAL:
      return {
        ...baseDefaults('知识库检索'),
        knowledgeRef: '',
        query: '{{startNode.input}}',
        topK: 5,
        threshold: 0.7,
      };
    case NodeType.DATASET_WRITE:
      return {
        ...baseDefaults('知识库写入'),
        knowledgeRef: '',
        contentRef: '{{startNode.input}}',
        chunkSize: 500,
        chunkOverlap: 50,
      };
    case NodeType.BATCH:
      return {
        ...baseDefaults('批处理'),
        arrayRef: '{{retrievalNode.result}}',
        parallelism: 3,
      };
    case NodeType.DATA_ADD:
      return {
        ...baseDefaults('新增数据'),
        table: 'orders',
        fields: [{ column: 'name', valueRef: '{{startNode.input}}' }],
      };
    case NodeType.DATA_QUERY:
      return {
        ...baseDefaults('查询数据'),
        table: 'orders',
        filters: [{ column: 'id', op: '=', valueRef: '{{startNode.id}}' }],
        limit: 100,
      };
    case NodeType.DATA_UPDATE:
      return {
        ...baseDefaults('更新数据'),
        table: 'orders',
        filters: [{ column: 'id', op: '=', valueRef: '{{startNode.id}}' }],
        sets: [{ column: 'status', valueRef: '"done"' }],
      };
    case NodeType.DATA_DELETE:
      return {
        ...baseDefaults('删除数据'),
        table: 'orders',
        filters: [{ column: 'id', op: '=', valueRef: '{{startNode.id}}' }],
      };
    case NodeType.SQL:
      return {
        ...baseDefaults('SQL 自定义'),
        table: 'orders',
        sql: 'SELECT * FROM orders WHERE id = :id',
        params: [{ key: 'id', valueRef: '{{startNode.id}}' }],
      };

    // —— 工具 ——
    case NodeType.HTTP:
      return {
        ...baseDefaults('HTTP 请求'),
        method: 'GET',
        url: 'https://api.example.com/search?q={{startNode.input}}',
        headers: [{ key: 'Accept', value: 'application/json' }],
        body: '',
        timeout: 15,
        authType: 'none',
        authValue: '',
      };
    case NodeType.CODE:
      return {
        ...baseDefaults('代码执行'),
        language: 'javascript',
        code: '// 输入通过 input 变量（对象）获取\nconst result = input.value * 2;\nreturn { output: result };',
        timeout: 30,
      };
    case NodeType.PLUGIN:
      return {
        ...baseDefaults('插件'),
        pluginName: 'news_search',
        pluginIcon: 'RadarChartOutlined',
        args: [{ key: 'query', valueRef: '{{startNode.input}}' }],
      };

    // —— 消息/时间 ——
    case NodeType.MESSAGE:
      return {
        ...baseDefaults('消息'),
        channel: 'chat',
        template: '处理完成：{{llmNode.result}}',
      };
    case NodeType.SLEEP:
      return {
        ...baseDefaults('延时'),
        delayMs: 1000,
      };

    // —— 长期记忆 ——
    case NodeType.LTM_WRITE:
      return {
        ...baseDefaults('记忆写入'),
        contentRef: '{{llmNode.result}}',
        tags: ['workflow', 'summary'],
      };
    case NodeType.LTM_READ:
      return {
        ...baseDefaults('记忆检索'),
        query: '{{startNode.input}}',
        topK: 5,
      };
  }
};

// ===== DAG 拓扑排序 + 环检测（Kahn 算法，纯函数）=====
interface GraphNodeLike {
  id: string;
}
interface GraphEdgeLike {
  source: string;
  target: string;
}

export function topologicalSort(
  nodes: readonly GraphNodeLike[],
  edges: readonly GraphEdgeLike[],
): { hasCycle: boolean; order: string[] } {
  const inDegree: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};
  nodes.forEach((n) => {
    inDegree[n.id] = 0;
    adjacency[n.id] = [];
  });
  edges.forEach((e) => {
    if (adjacency[e.source] && inDegree[e.target] !== undefined) {
      adjacency[e.source].push(e.target);
      inDegree[e.target] += 1;
    }
  });
  const queue: string[] = [];
  Object.keys(inDegree).forEach((id) => {
    if (inDegree[id] === 0) queue.push(id);
  });
  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    result.push(id);
    adjacency[id].forEach((next) => {
      inDegree[next] -= 1;
      if (inDegree[next] === 0) queue.push(next);
    });
  }
  const hasCycle = result.length !== nodes.length;
  return { hasCycle, order: result };
}

export function wouldCreateCycle(
  nodes: readonly GraphNodeLike[],
  edges: readonly GraphEdgeLike[],
  newEdge: GraphEdgeLike,
): boolean {
  const tempEdges = [...edges, newEdge];
  const { hasCycle } = topologicalSort(nodes, tempEdges);
  return hasCycle;
}
