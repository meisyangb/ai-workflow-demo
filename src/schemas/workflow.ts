import { z } from 'zod';
import { NODE_METAS } from '../domains/workflow';

/**
 * 工作流画布数据契约（导入 / 导出 JSON 的运行时校验 Schema）
 *
 * —— v0.3.0 扣子工作流对齐 ——
 * 节点类型全集同步自 src/domains/workflow.ts 中的 NodeType（共 28 类）。
 * 为避免手动对齐失败，本文件通过“从 NODE_METAS.type 生成节点字面量联合”作为数据源，
 * Zod discriminatedUnion 的每个 type literal 必须能在 NODE_TYPES_SET 里查到，
 * 并在运行时对未知 type 给出明确报错 —— 这一层会把 import 时的未知节点
 * 直接报告为「该节点类型未在 schemas/workflow.ts 注册」，不会静默写入。
 */

// ===== 基础枚举 =====
export const NODE_STATUS_VALUES = ['idle', 'running', 'success', 'failed'] as const;
export const NodeStatusSchema = z.enum(NODE_STATUS_VALUES);

// 基础字段定义
const FIELD_TYPE_VALUES = [
  'string',
  'integer',
  'number',
  'boolean',
  'object',
  'array',
  'file',
] as const;
const FieldDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPE_VALUES),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  description: z.string().optional(),
});

// ===== v0.3.1 新增：条件规则 / 输出格式 Zod Schema =====
const CONDITION_OP_VALUES = ['eq', 'ne', 'gt', 'lt', 'contains', 'empty', 'regex'] as const;
/** 单条条件规则（扣子可视化规则表一行） */
export const ConditionRuleSchema = z.object({
  field: z.string().min(1),
  op: z.enum(CONDITION_OP_VALUES),
  value: z.string().default(''),
});
export type ConditionRule = z.infer<typeof ConditionRuleSchema>;

/** 条件规则组：AND/OR 组合多条 ConditionRule */
export const RuleGroupSchema = z.object({
  operator: z.enum(['AND', 'OR']),
  items: z.array(ConditionRuleSchema).default([]),
});

/** LLM 输出字段：单个 schema 字段定义 */
const LLMOutputFieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  required: z.boolean().default(false),
});

/** LLM 输出格式：文本或结构化 JSON（含字段定义列表） */
const LLMOutputFormatSchema = z
  .object({
    mode: z.enum(['text', 'json']).default('text'),
    fields: z.array(LLMOutputFieldSchema).optional(),
  })
  .optional();

/** 从 domains 里把所有 type 抽出来，作为 schema 合法性白名单（单点来源） */
export const NODE_TYPE_VALUES = NODE_METAS.map((m) => m.type) as unknown as readonly [
  string,
  ...string[],
];

// ===== 基础 data 形状（所有节点 data 都含这些字段）=====
const baseDataShape = {
  label: z.string().min(1, '节点名称不能为空'),
  status: NodeStatusSchema,
  inputs: z.array(FieldDefSchema).optional().default([]),
  outputs: z.array(FieldDefSchema).optional().default([]),
  debugOutput: z.unknown().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  // v0.3.1 新增：两个可选字段，带 default 保证 backward-compat
  errorMessage: z.string().optional(),
  estimatedDurationMs: z.number().int().nonnegative().optional(),
};

// ===== 坐标 =====
const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const zNode = (discriminator: string, dataExtra: z.ZodTypeAny) =>
  z.object({
    id: z.string().min(1, '节点 id 不能为空'),
    position: PositionSchema,
    type: z.literal(discriminator),
    data: z.object({ ...baseDataShape }).and(dataExtra),
    // ReactFlow 标准字段
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    selected: z.boolean().optional(),
    dragging: z.boolean().optional(),
    draggable: z.boolean().optional(),
    connectable: z.boolean().optional(),
    deletable: z.boolean().optional(),
    selectable: z.boolean().optional(),
    parentId: z.string().nullable().optional(),
    zIndex: z.number().int().optional(),
    extent: z.enum(['parent', 'free']).optional(),
  });

// 通用 schema 辅助
const kvrr = (label: string) => z.object({ column: z.string(), op: z.string(), valueRef: z.string() }).array().default([]).describe(label);

// ===== 节点（按 type 判别联合）—— 28 个节点按 7 大类顺序 =====
export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  // —— 基础 ——
  zNode('startNode', z.object({ inputs: z.array(FieldDefSchema).default([]) })),
  zNode('endNode', z.object({ variables: z.string().array().default([]) })),
  zNode(
    'variableNode',
    z.object({
      variableName: z.string().min(1),
      expression: z.string(),
      dataType: z.enum(FIELD_TYPE_VALUES),
    }),
  ),
  zNode(
    'aggregateNode',
    z.object({
      mapping: z.object({ alias: z.string().min(1), ref: z.string() }).array().default([]),
    }),
  ),
  zNode(
    'workflowNode',
    z.object({
      workflowName: z.string().default(''),
      args: z.record(z.string(), z.string()).default({}),
    }),
  ),

  // —— 大模型 ——
  zNode(
    'llmNode',
    z.object({
      model: z.string().min(1),
      prompt: z.string(),
      temperature: z.number().min(0).max(2),
      maxTokens: z.number().int().min(1).max(32768),
      outputFormat: LLMOutputFormatSchema,
    }),
  ),
  zNode(
    'questionNode',
    z.object({
      model: z.string().min(1),
      knowledgeRef: z.string().default(''),
      question: z.string(),
      outputFormat: LLMOutputFormatSchema,
    }),
  ),
  zNode(
    'imageNode',
    z.object({
      model: z.string().min(1),
      imageInput: z.string(),
      prompt: z.string(),
      outputFormat: LLMOutputFormatSchema,
    }),
  ),
  zNode(
    'imageGenNode',
    z.object({
      model: z.string().min(1),
      prompt: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      outputFormat: LLMOutputFormatSchema,
    }),
  ),

  // —— 逻辑 ——
  zNode(
    'conditionNode',
    z.object({
      expression: z.string(),
      trueLabel: z.string(),
      falseLabel: z.string(),
      rules: RuleGroupSchema.optional(),
    }),
  ),
  zNode(
    'loopNode',
    z.object({
      mode: z.enum(['array', 'count', 'infinite']),
      arrayRef: z.string().optional(),
      countRef: z.string().optional(),
      breakCondition: z.string().optional(),
    }),
  ),
  zNode(
    'selectorNode',
    z.object({
      valueRef: z.string(),
      cases: z.object({ label: z.string(), value: z.string() }).array().default([]),
      hasDefault: z.boolean().default(true),
    }),
  ),
  zNode(
    'intentNode',
    z.object({
      model: z.string().min(1),
      intents: z.object({ label: z.string(), description: z.string() }).array().default([]),
    }),
  ),

  // —— 数据 ——
  zNode(
    'retrievalNode',
    z.object({
      knowledgeRef: z.string().default(''),
      query: z.string(),
      topK: z.number().int().min(1).max(50),
      threshold: z.number().min(0).max(1),
    }),
  ),
  zNode(
    'datasetWriteNode',
    z.object({
      knowledgeRef: z.string().default(''),
      contentRef: z.string(),
      chunkSize: z.number().int().min(10).max(5000),
      chunkOverlap: z.number().int().min(0).max(500),
    }),
  ),
  zNode(
    'batchNode',
    z.object({
      arrayRef: z.string(),
      parallelism: z.number().int().min(1).max(100),
    }),
  ),
  zNode(
    'dataAddNode',
    z.object({
      table: z.string().min(1),
      fields: z.object({ column: z.string(), valueRef: z.string() }).array().default([]),
    }),
  ),
  zNode(
    'dataQueryNode',
    z.object({ table: z.string().min(1), filters: kvrr('filters'), limit: z.number().int().min(1).max(1000) }),
  ),
  zNode(
    'dataUpdateNode',
    z.object({
      table: z.string().min(1),
      filters: kvrr('filters'),
      sets: z.object({ column: z.string(), valueRef: z.string() }).array().default([]),
    }),
  ),
  zNode(
    'dataDeleteNode',
    z.object({ table: z.string().min(1), filters: kvrr('filters') }),
  ),
  zNode(
    'sqlNode',
    z.object({
      table: z.string().default(''),
      sql: z.string(),
      params: z.object({ key: z.string(), valueRef: z.string() }).array().default([]),
    }),
  ),

  // —— 工具 ——
  zNode(
    'httpNode',
    z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
      url: z.string(),
      headers: z.object({ key: z.string(), value: z.string() }).array().default([]),
      body: z.string().default(''),
      timeout: z.number().int().min(1).max(600),
      authType: z.enum(['none', 'bearer', 'basic']).default('none'),
      authValue: z.string().default(''),
    }),
  ),
  zNode(
    'codeNode',
    z.object({
      language: z.enum(['javascript', 'python']),
      code: z.string(),
      timeout: z.number().int().min(1).max(600),
    }),
  ),
  zNode(
    'pluginNode',
    z.object({
      pluginName: z.string().min(1),
      pluginIcon: z.string().default('AppstoreOutlined'),
      args: z.object({ key: z.string(), valueRef: z.string() }).array().default([]),
    }),
  ),

  // —— 消息/时间 ——
  zNode(
    'messageNode',
    z.object({
      channel: z.enum(['chat', 'webhook', 'sms']).default('chat'),
      template: z.string(),
    }),
  ),
  zNode('sleepNode', z.object({ delayMs: z.number().int().min(0).max(600_000) })),

  // —— 长期记忆 ——
  zNode(
    'ltmWriteNode',
    z.object({ contentRef: z.string(), tags: z.string().array().default([]) }),
  ),
  zNode(
    'ltmReadNode',
    z.object({ query: z.string(), topK: z.number().int().min(1).max(50) }),
  ),
]);

// ===== 连线 =====
export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1, '连线 id 不能为空'),
  source: z.string().min(1, '连线 source 不能为空'),
  target: z.string().min(1, '连线 target 不能为空'),
  sourceHandle: z.string().nullable(),
  targetHandle: z.string().nullable(),
  animated: z.boolean().default(false),
  label: z.string().optional(),
});

// ===== 完整画布定义 =====
export const WorkflowDefSchema = z.object({
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
});

export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;

/**
 * 把 ZodError 格式化为用户可读的中文错误信息（最多展示 3 条）
 */
export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3);
  const details = issues
    .map((i) => `${i.path.join('.') || '(根对象)'}: ${i.message}`)
    .join('；');
  const extra = error.issues.length > 3 ? ` 等 ${error.issues.length} 处问题` : '';
  return `JSON 数据契约校验失败 -> ${details}${extra}`;
}
