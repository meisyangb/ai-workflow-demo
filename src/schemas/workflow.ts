import { z } from 'zod';

/**
 * 工作流画布数据契约（导入 / 导出 JSON 的运行时校验 Schema）
 *
 * 设计说明：
 * - 与 src/store/workflowStore.ts 中的 TS 类型一一对应（静态 + 运行时双重保障）
 * - 使用 discriminatedUnion 按 type 区分三种节点，字段强校验
 * - 默认 strip 模式：未知字段自动剔除，防止脏数据进入 store
 * - animated 缺省时默认 false，label 可选，提升手工编写 JSON 的容错
 */

// ===== 基础枚举 =====
export const NODE_STATUS_VALUES = ['idle', 'running', 'success', 'failed'] as const;
export const NodeStatusSchema = z.enum(NODE_STATUS_VALUES);

export const NODE_TYPE_VALUES = ['llmNode', 'conditionNode', 'codeNode'] as const;

// ===== 坐标 =====
const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

// ===== 节点（按 type 判别联合）=====
const baseNodeShape = {
  id: z.string().min(1, '节点 id 不能为空'),
  position: PositionSchema,
};

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseNodeShape,
    type: z.literal('llmNode'),
    data: z.object({
      label: z.string().min(1, '节点名称不能为空'),
      status: NodeStatusSchema,
      model: z.string().min(1),
      prompt: z.string(),
      temperature: z.number().min(0).max(2, 'temperature 取值范围 0~2'),
      maxTokens: z.number().int().min(1).max(32768),
    }),
  }),
  z.object({
    ...baseNodeShape,
    type: z.literal('conditionNode'),
    data: z.object({
      label: z.string().min(1, '节点名称不能为空'),
      status: NodeStatusSchema,
      expression: z.string(),
      trueLabel: z.string(),
      falseLabel: z.string(),
    }),
  }),
  z.object({
    ...baseNodeShape,
    type: z.literal('codeNode'),
    data: z.object({
      label: z.string().min(1, '节点名称不能为空'),
      status: NodeStatusSchema,
      language: z.string().min(1),
      code: z.string(),
      timeout: z.number().int().min(1).max(300, 'timeout 取值范围 1~300 秒'),
    }),
  }),
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
