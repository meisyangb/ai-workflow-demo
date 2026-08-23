/**
 * SSE 包结构 & 扣子（Coze）工作流流式事件的 Zod Schema
 *
 * 参考扣子官方：
 *  - 流式插件接口：`id / event / data.{stream_id, is_finish, is_last_msg, is_last_packet_in_msg, content, output_mode, return_type, ...}`
 *  - 工作流 API 流式响应：`event: message / interrupt / done / error`
 *
 * 本模块只做"协议层的标准化类型 + 校验"，不做 UI / store 绑定；
 * 业务层在 `httpSseExecutionService.ts` 里把这些 SSE 事件桥到 ExecutionEvent。
 */
import { z } from 'zod';

// ===== 一、SSE 原始帧结构 =====
//
// 一个 SSE "事件" 是若干字段行 + 一条空行：
//   id: <id>\n
//   event: <eventName>\n
//   data: <JSON-string-or-text>\n
//   retry: <ms>\n
//   \n
// 说明：data 可以出现多次（多行拼接为一个字符串，中间用 \n 连接）。

export interface SseRawEvent {
  /** 事件 ID（缺失时为 null；用于 Last-Event-ID 重连） */
  id: string | null;
  /** 事件名（缺失时默认为 'message'） */
  event: string;
  /** 拼接后的完整 data 字符串（可能是 JSON / 纯文本 / [DONE]） */
  data: string;
  /** 浏览器建议的重连间隔（扣子/OpenAI 通常不写，缺省 null） */
  retryMs: number | null;
  /** 该帧起始在原始字节流中的偏移（调试用） */
  offset: number;
}

// ===== 二、扣子流式插件 / 工作流内部 packet（data 字段 JSON 体）=====
//
// 参考 docs.coze.cn/guides_Stream_plugin：
//   每个 data JSON：{ stream_id, output_mode?, return_type?, content_type?, context_mode?,
//                     content, is_finish, is_last_msg, is_last_packet_in_msg, ext? }

export const SseStreamPacketSchema = z.object({
  stream_id: z.string().min(1),
  /** 0=一次性 / 1=分片流式（打字机） */
  output_mode: z.union([z.literal(0), z.literal(1)]).optional().default(0),
  /** 0=经模型再输出 / 1=直接输出到用户；output_mode=1 时强制 1 */
  return_type: z.union([z.literal(0), z.literal(1)]).optional().default(0),
  /** 0=文本（当前仅支持 0） */
  content_type: z.literal(0).optional().default(0),
  /** 0=下次对话入上下文 / 1=不入 */
  context_mode: z.union([z.literal(0), z.literal(1)]).optional().default(0),
  /** 本次 packet 输出内容；空 content 会导致 Coze 端智能体最终回复为空，桥接层要注意合并 */
  content: z.string().nullable().optional(),
  /** 是否是整条 SSE 流的最后一个包 */
  is_finish: z.boolean(),
  /** 是否是当前 message 的最后一个包 */
  is_last_msg: z.boolean(),
  /** 是否是当前 packet（分片）所属 message 片段的最后一个包 */
  is_last_packet_in_msg: z.boolean(),
  /** 扩展字段，业务自定义（如 nodeId / executeId / trace_id） */
  ext: z.record(z.string(), z.string()).optional(),
});
export type SseStreamPacket = z.infer<typeof SseStreamPacketSchema>;

// ===== 三、工作流 stream_run 响应事件（HTTP SSE 层的 event 类型）=====
//
// 来源：Coze stream_run + 我们自研的扩展（ext）。
// data 字段 JSON 因 event 而异，用 discriminated union 方便 switch-case 分发。

export const WfRunStartedDataSchema = z.object({
  run_id: z.string().min(1),
  execute_id: z.string().optional(),
  order: z.array(z.string()).optional(),
  /** 扩展：总节点数（UI 总进度条用） */
  total_nodes: z.number().int().nonnegative().optional(),
});
export type WfRunStartedData = z.infer<typeof WfRunStartedDataSchema>;

export const WfNodeStatusDataSchema = z.object({
  run_id: z.string().min(1).optional(),
  node_id: z.string().min(1),
  /** 对应我们 NodeStatus：idle/running/success/failed */
  status: z.enum(['idle', 'running', 'success', 'failed']),
  /** 可选：本次节点的完整结果（成功）/ 调试信息（运行中）/ 错误体（失败） */
  output: z.unknown().optional(),
  duration_ms: z.number().nonnegative().optional(),
  error_message: z.string().optional(),
  /** 扩展：命中的出边 ID 列表（CONDITION/SELECTOR/INTENT 分支激活） */
  activated_edge_ids: z.array(z.string()).optional(),
});
export type WfNodeStatusData = z.infer<typeof WfNodeStatusDataSchema>;

export const WfNodeTokenDataSchema = z.object({
  run_id: z.string().min(1).optional(),
  node_id: z.string().min(1),
  /** 本次追加的增量内容（如 LLM token 片段）；UI 做字符串 concat 即可 */
  delta: z.string(),
  /** 已生成 tokens 估计值（用于进度条；缺失时按字符数/1.3 估计） */
  tokens_estimated: z.number().nonnegative().optional(),
  /** 输出字段 key：如 debugOutput / content / result；缺省表示默认输出 */
  field: z.string().optional(),
});
export type WfNodeTokenData = z.infer<typeof WfNodeTokenDataSchema>;

export const WfInterruptDataSchema = z.object({
  run_id: z.string().min(1),
  execute_id: z.string().min(1),
  /** 中断类型：如 'question'（追问）/'confirm'（确认）/'form'（表单） */
  interrupt_type: z.string().min(1),
  /** 节点触发中断（通常是 INTENT 或 Q&A 节点） */
  node_id: z.string().min(1).optional(),
  /** 前端需要展示给用户的提示（标题/描述/字段 schema JSON） */
  prompt: z.unknown().optional(),
});
export type WfInterruptData = z.infer<typeof WfInterruptDataSchema>;

export const WfMessageDataSchema = z.object({
  run_id: z.string().min(1).optional(),
  /** 消息类别：如 'log' / 'tool_call' / 'tool_result' / 'progress' / 'system' */
  category: z.string().min(1),
  /** 对应节点 id（空表示工作流级消息） */
  node_id: z.string().optional(),
  /** 自由内容（JSON 序列化后的对象、字符串、数字都允许） */
  content: z.unknown().optional(),
  /** 进度类消息的 0~1 百分比 */
  progress: z.number().min(0).max(1).optional(),
});
export type WfMessageData = z.infer<typeof WfMessageDataSchema>;

export const WfErrorDataSchema = z.object({
  run_id: z.string().min(1).optional(),
  /** 业务错误码（如 429=限流 / 401=鉴权 / 500=服务端 / 7xxx=工作流内部） */
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string(),
  /** 触发错误的节点 id（能定位时给出） */
  node_id: z.string().optional(),
  /** 服务端建议重试毫秒（对应 Retry-After） */
  retry_after_ms: z.number().nonnegative().optional(),
});
export type WfErrorData = z.infer<typeof WfErrorDataSchema>;

export const WfDoneDataSchema = z.object({
  run_id: z.string().min(1),
  /** 'success' / 'cancelled' / 'failed' / 'interrupted'（中断等待 resume） */
  outcome: z.enum(['success', 'cancelled', 'failed', 'interrupted']).default('success'),
  /** 失败/取消原因 */
  reason: z.string().optional(),
  /** 失败节点 id（仅 failed） */
  failed_node_id: z.string().optional(),
  /** 工作流最终输出（输出节点的字段映射） */
  outputs: z.record(z.string(), z.unknown()).optional(),
});
export type WfDoneData = z.infer<typeof WfDoneDataSchema>;

/**
 * 工作流式样响应的事件 union；
 * 上层可直接根据 `SseWfEvent.event` 分发 + `zod parse(data)` 拿到强类型。
 */
export type SseWfEvent =
  | { event: 'workflow-started'; data: WfRunStartedData }
  | { event: 'node-status'; data: WfNodeStatusData }
  | { event: 'node-token'; data: WfNodeTokenData }
  | { event: 'interrupt'; data: WfInterruptData }
  | { event: 'message'; data: WfMessageData }
  | { event: 'error'; data: WfErrorData }
  | { event: 'done'; data: WfDoneData }
  /** 未知事件：data 原样保留，业务层忽略即可（向后兼容扩展事件不会炸） */
  | { event: string; data: unknown };

/**
 * 解析一个 SSE 原始帧的 data 字符串 → 工作流事件（未知事件走默认兜底不抛错）。
 * - 如果解析成功且 event=message 且 data 能被 `SseStreamPacketSchema` 校验：自动提取
 *   `packet.content` 作为 WfNodeTokenData 方便 UI 直接消费（同时保留原 data）；
 * - 其它情况：按 event 名称走对应 Schema；失败抛 z.ZodError。
 */
export function parseSseWfEvent(raw: SseRawEvent): SseWfEvent {
  const evt = raw.event || 'message';

  // 扣子 stream plugin 的 SSE：event 恒为 'message'，data 是 packet JSON；
  // 我们的 bridge 在 workflow-stream 模式下通常会把 message 作为 token 增量。
  if (evt === 'message') {
    const trimmed = raw.data.trim();
    if (trimmed === '[DONE]' || trimmed === '') {
      return { event: 'done', data: { run_id: 'unknown', outcome: 'success' } satisfies WfDoneData } as SseWfEvent;
    }
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      // 纯文本 message：当作 node-token delta（兼容非 JSON 插件/流式输出）
      return {
        event: 'node-token',
        data: { run_id: undefined, node_id: '__default__', delta: raw.data },
      } satisfies SseWfEvent as SseWfEvent;
    }
    // 先按 SseStreamPacket 尝试（扣子流式插件）
    const p = SseStreamPacketSchema.safeParse(json);
    if (p.success) {
      const pkt = p.data;
      return {
        event: pkt.is_finish ? 'done' : 'node-token',
        data: pkt.is_finish
          ? ({ run_id: pkt.stream_id, outcome: 'success' } satisfies WfDoneData)
          : ({
              run_id: undefined,
              node_id: pkt.stream_id,
              delta: pkt.content ?? '',
              field: pkt.return_type === 1 ? 'content' : 'debugOutput',
            } satisfies WfNodeTokenData),
      } satisfies SseWfEvent as SseWfEvent;
    }
    // 否则尝试各事件 schema：先按常见字段再按 node-status / node-token / interrupt / message / error / done
    const schemasToTry: Array<[string, z.ZodType, SseWfEvent['event']]> = [
      ['node-status', WfNodeStatusDataSchema, 'node-status'],
      ['workflow-started', WfRunStartedDataSchema, 'workflow-started'],
      ['node-token', WfNodeTokenDataSchema, 'node-token'],
      ['interrupt', WfInterruptDataSchema, 'interrupt'],
      ['error', WfErrorDataSchema, 'error'],
      ['done', WfDoneDataSchema, 'done'],
    ];
    for (const [_label, schema, evName] of schemasToTry) {
      const r = schema.safeParse(json);
      if (r.success) return { event: evName, data: r.data } as SseWfEvent;
    }
    // 兜底：自由 message
    return { event: 'message', data: { category: 'unknown', content: json } satisfies WfMessageData } as SseWfEvent;
  }

  // 非 message 事件：按各自 schema 强校验
  const json = (() => {
    const t = raw.data.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch (err) {
      throw new Error(`SSE event='${evt}' 的 data 不是合法 JSON：${(err as Error).message}`);
    }
  })();

  switch (evt) {
    case 'workflow-started':
      return { event: 'workflow-started', data: WfRunStartedDataSchema.parse(json) };
    case 'node-status':
      return { event: 'node-status', data: WfNodeStatusDataSchema.parse(json) };
    case 'node-token':
      return { event: 'node-token', data: WfNodeTokenDataSchema.parse(json) };
    case 'interrupt':
      return { event: 'interrupt', data: WfInterruptDataSchema.parse(json) };
    case 'error':
      return { event: 'error', data: WfErrorDataSchema.parse(json) };
    case 'done':
      return { event: 'done', data: WfDoneDataSchema.parse(json ?? { run_id: 'unknown' }) };
    default:
      return { event: evt, data: json };
  }
}
