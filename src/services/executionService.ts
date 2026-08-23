/**
 * ExecutionService 接口层
 *
 * 把工作流「运行」这个行为从 Store 抽离为独立的 Service 接口：
 * - MockExecutionService：纯前端 Mock 延时（当前默认实现）
 * - 未来可替换为 HttpExecutionService / WsExecutionService（调用真实后端）
 *
 * 业务层（workflowStore）仅依赖本接口，不依赖具体实现 —— 业务层建立在基础层（HTTP Client 等）之上。
 */

import type { NodeStatus } from '../store/workflowStore';
import type { WorkflowEdge, WorkflowNode } from '../store/workflowStore';

/** 节点状态变更事件（节点进入运行中 / 成功 / 失败） */
export interface NodeStatusChangedEvent {
  type: 'node-status-changed';
  nodeId: string;
  status: NodeStatus;
  /** 可选的运行产出（留作后端接入时用） */
  output?: unknown;
}

/** 某节点执行完成 → 其出边开始流动动画 */
export interface NodeEdgesActivatedEvent {
  type: 'node-edges-activated';
  /** 源节点 ID：把该节点的所有出边标记为 animated */
  sourceNodeId: string;
}

/** 执行启动 */
export interface RunStartedEvent {
  type: 'run-started';
  order: string[]; // 拓扑排序后的执行顺序
}

/** 执行结束 */
export interface RunFinishedEvent {
  type: 'run-finished';
  /** 中断原因：如果是成功跑完为 null；失败 / 手动停止 / 环检测错误为具体原因 */
  reason: string | null;
  /** 最后失败的节点 ID（仅 reason 为节点失败时存在） */
  failedNodeId?: string;
}

export type ExecutionEvent =
  | RunStartedEvent
  | NodeStatusChangedEvent
  | NodeEdgesActivatedEvent
  | RunFinishedEvent;

/** 取消句柄（调用 cancel() 会中断执行） */
export interface RunHandle {
  /** 是否仍在执行 */
  readonly running: boolean;
  /** 取消执行（执行中的 RunFinishedEvent 会带着 reason='cancelled'） */
  cancel(): void;
  /** 等待执行结束并获取结果 */
  done(): Promise<{ error: string | null }>;
}

/** 运行时环境：Service 可以从外部读取节点/连线快照，且需要更新画布 */
export interface WorkflowSnapshot {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}

export interface ExecutionService {
  /** 名称（用于调试/日志，如 'mock' / 'http'） */
  readonly name: string;
  /**
   * 启动一次工作流执行
   * - onEvent：事件回调（事件驱动 vs 直接 set store，解耦 Service 与 Store 实现）
   * @returns RunHandle：外部可通过它取消 / 等待结束
   */
  start(
    snapshot: WorkflowSnapshot,
    onEvent: (event: ExecutionEvent) => void,
  ): RunHandle;
}
