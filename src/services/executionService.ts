/**
 * ExecutionService 接口层
 *
 * 把工作流「运行」这个行为从 Store 抽离为独立的 Service 接口：
 * - MockExecutionService：纯前端 Mock 延时（当前默认实现）
 * - HttpSseExecutionService：HTTP + SSE（对接扣子 / 自研后端的工作流 /run /run/stream /async_run）
 * - 未来可替换为 WsExecutionService（仅用于协同编辑，不作为 AI 主链）
 *
 * 业务层（workflowStore）仅依赖本接口，不依赖具体实现 —— 业务层建立在基础层（HTTP Client 等）之上。
 *
 * v0.4.1 扩展：
 *   - ExecutionEvent 新增 3 类事件：NodeOutputAppendEvent（LLM 打字机增量）、
 *     WorkflowInterruptEvent（INTENT 追问/确认中断）、WorkflowMessageEvent（自由日志/进度/工具调用）
 *   - RunHandle 新增 `resume(payload)` 方法：用于 interrupt 之后恢复执行（如扣子 stream_resume）
 *   - NodeStatusChangedEvent 扩展可选的 `activatedEdgeIds`：服务端可直接返回命中分支边，
 *     无需前端 Mock 再推断。
 */

import type { NodeStatus, WorkflowEdge, WorkflowNode } from '../domains/workflow';

/** 节点状态变更事件（节点进入运行中 / 成功 / 失败） */
export interface NodeStatusChangedEvent {
  type: 'node-status-changed';
  nodeId: string;
  status: NodeStatus;
  /** 可选的运行产出（成功时返回 debugOutput/结果体；失败时通常为 null） */
  output?: unknown;
  /** v0.3.1 新增：本次状态节点耗时（毫秒）；SUCCESS/FAILED 时通常有，RUNNING 通常为 null */
  durationMs?: number;
  /** v0.3.1 新增：仅 status='failed' 时填入，失败原因；UI 错误横幅使用 */
  errorMessage?: string;
  /** v0.4.1 新增：本次节点完成激活的出边（CONDITION/SELECTOR/INTENT 命中分支） */
  activatedEdgeIds?: string[];
}

/** 某节点执行完成 → 其出边开始流动动画 */
export interface NodeEdgesActivatedEvent {
  type: 'node-edges-activated';
  /** 源节点 ID：把该节点的出边标记为 animated（默认所有出边） */
  sourceNodeId: string;
  /**
   * v0.3.1 新增（细粒度控制）：若提供，则只把这些 edgeId 设为 animated=true；
   * 不提供时等价于"source 下全部出边 animated=true"（兼容旧行为）。
   * 典型用途：CONDITION / SELECTOR / INTENT 只激活分支命中的那一条边。
   */
  activatedEdgeIds?: string[];
}

/** 执行启动 */
export interface RunStartedEvent {
  type: 'run-started';
  order: string[]; // 拓扑排序后的执行顺序
  /** v0.4.1：后端生成的 run_id / execute_id（用于 resume、幂等、跨 tab 追踪） */
  runId?: string;
  executeId?: string;
}

/** 执行结束 */
export interface RunFinishedEvent {
  type: 'run-finished';
  /** 中断原因：如果是成功跑完为 null；失败 / 手动停止 / 环检测错误为具体原因 */
  reason: string | null;
  /** 最后失败的节点 ID（仅 reason 为节点失败时存在） */
  failedNodeId?: string;
  /** v0.4.1：对应 outcome（success/cancelled/failed/interrupted） */
  outcome?: 'success' | 'cancelled' | 'failed' | 'interrupted';
  /** v0.4.1：工作流输出（如后端 done 事件返回 outputs 字段） */
  outputs?: Record<string, unknown>;
}

/**
 * v0.4.1 新增：节点输出增量追加（LLM 打字机 / 流式插件分 packet）
 *
 * 性能目标：30 FPS 合并写入，避免 20~80 token/s 的全量 setState 把 FPS 打崩。
 * - UI 层（CustomNodes / ConfigPanel Debug Tab）读取 `debugOutput + pendingDelta`，
 *   store 用 queueMicrotask + 16~33ms 窗口把若干次 append 合并为一次赋值。
 */
export interface NodeOutputAppendEvent {
  type: 'node-output-append';
  nodeId: string;
  /** 追加内容（文本）；业务层直接字符串 concat 到当前输出字段尾部 */
  delta: string;
  /** 已估算 tokens 数（可选），用于进度条/调试信息 */
  tokensEstimated?: number;
  /**
   * 输出字段：缺省 'debugOutput'；
   * 如 'content'（LLM 最终答案）/ 'stdout'（代码节点）/ 自定义 key；
   * 写在 node.data[field] 对应属性尾部（非字符串先转字符串）。
   */
  field?: string;
}

/**
 * v0.4.1 新增：工作流中断（INTENT 追问 / 确认 / 表单）
 * - UI 层：弹出对应中断提示框 + 等待用户输入 → 调 `runHandle.resume(payload)`
 */
export interface WorkflowInterruptEvent {
  type: 'workflow-interrupted';
  /** 后端 execute_id（resume 时需要带回去） */
  executeId: string;
  /** run_id */
  runId?: string;
  /** 触发中断的节点 id（通常是 INTENT/Q&A 节点） */
  nodeId?: string;
  /** 'question'（追问）/ 'confirm'（确认）/ 'form'（结构化表单） */
  interruptType: string;
  /** 任意提示内容（标题/描述/JSON Schema 表单），由 UI 按 interruptType 渲染 */
  prompt?: unknown;
}

/**
 * v0.4.1 新增：工作流自由消息（日志 / 工具调用入参出参 / 进度）
 * - 分类：`category` + `nodeId`，Debug 日志 Tab 可过滤
 * - 可选 0~1 进度：用于生图 / 检索等长耗时节点的百分比条
 */
export interface WorkflowMessageEvent {
  type: 'workflow-message';
  /** 'log' / 'tool_call' / 'tool_result' / 'progress' / 'system' / ... */
  category: string;
  /** 空表示工作流级消息；非空表示属于某节点 */
  nodeId?: string;
  /** 自由内容（对象/字符串均可），不做 Schema 校验，Debug 面板原样展示 */
  content?: unknown;
  /** 0~1 的进度（可选；如果 category='progress' 建议提供） */
  progress?: number;
  /** 对应的 run_id（如果有） */
  runId?: string;
}

export type ExecutionEvent =
  | RunStartedEvent
  | NodeStatusChangedEvent
  | NodeEdgesActivatedEvent
  | NodeOutputAppendEvent
  | WorkflowInterruptEvent
  | WorkflowMessageEvent
  | RunFinishedEvent;

/** 取消句柄（调用 cancel() 会中断执行） */
export interface RunHandle {
  /** 是否仍在执行（中断等待 resume 也算 running=true） */
  readonly running: boolean;
  /** 后端生成的 run_id（有则给；Mock/未启动时 null） */
  readonly runId: string | null;
  /** 若已触发中断：execute_id；否则为 null */
  readonly executeId: string | null;
  /** 取消执行（执行中的 RunFinishedEvent 会带着 reason='cancelled'） */
  cancel(): void;
  /** 等待执行结束并获取结果 */
  done(): Promise<{ error: string | null; outputs?: Record<string, unknown> }>;
  /**
   * v0.4.1：从 interrupt 状态恢复执行。
   * 对应扣子 `POST /v1/workflow/stream_resume` 或自研后端的"恢复"接口。
   * payload 通常是用户回复的答案/确认结果。
   */
  resume(payload: unknown): Promise<void>;
}

/** 运行时环境：Service 可以从外部读取节点/连线快照，且需要更新画布 */
export interface WorkflowSnapshot {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}

export interface ExecutionService {
  /** 名称（用于调试/日志，如 'mock' / 'http-sse' / 'coze'） */
  readonly name: string;
  /**
   * 启动一次工作流执行
   * - onEvent：事件回调（事件驱动 vs 直接 set store，解耦 Service 与 Store 实现）
   * @returns RunHandle：外部可通过它取消 / 等待结束 / 从中断恢复
   */
  start(
    snapshot: WorkflowSnapshot,
    onEvent: (event: ExecutionEvent) => void,
  ): RunHandle;
}
