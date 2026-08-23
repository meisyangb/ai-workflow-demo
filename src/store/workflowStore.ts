import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import { WorkflowDefSchema, formatZodError } from '../schemas/workflow';
import { MockExecutionService } from '../services/mockExecutionService';
import type { ExecutionEvent, ExecutionService, RunHandle } from '../services/executionService';
// 领域模型与纯函数从独立 domains 模块导入（打破循环依赖）
import {
  NodeStatus,
  NodeType,
  defaultNodeData,
  wouldCreateCycle,
} from '../domains/workflow';
import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeData,
  LLMNodeData,
  ConditionNodeData,
  CodeNodeData,
  Connection,
  NodeChange,
  EdgeChange,
  NodeStatus as _NodeStatus,
  NodeType as _NodeType,
} from '../domains/workflow';

// 类型与枚举 re-export：保持向后兼容（其他组件从 './workflowStore' 导入）
export { NodeStatus, NodeType, defaultNodeData };
export type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeData,
  LLMNodeData,
  ConditionNodeData,
  CodeNodeData,
  Connection,
  NodeChange,
  EdgeChange,
};
// 供消费方使用：状态颜色/文本（避免引入 domains 造成 import 路径碎片化，统一从 store 出口）
export { statusColor, statusText, topologicalSort, wouldCreateCycle } from '../domains/workflow';

/** 撤销/重做历史快照 */
export interface HistorySnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// 初始示例数据（开箱可用）
const initialNodes: WorkflowNode[] = [
  {
    id: 'n_llm_1',
    type: NodeType.LLM,
    position: { x: 60, y: 120 },
    data: {
      ...defaultNodeData(NodeType.LLM),
      label: '1. 需求理解',
      prompt: '请分析以下用户需求，提炼关键点：\n{{input}}',
    } as WorkflowNodeData,
  },
  {
    id: 'n_cond_1',
    type: NodeType.CONDITION,
    position: { x: 380, y: 120 },
    data: {
      ...defaultNodeData(NodeType.CONDITION),
      expression: 'result.keywords.length > 3',
    } as WorkflowNodeData,
  },
  {
    id: 'n_code_1',
    type: NodeType.CODE,
    position: { x: 700, y: 40 },
    data: {
      ...defaultNodeData(NodeType.CODE),
      label: '3a. 生成代码',
      code: '// 根据分析结果生成代码模板\nreturn { template: `function ${input.name}() { /* TODO */ }` };',
    } as WorkflowNodeData,
  },
  {
    id: 'n_llm_2',
    type: NodeType.LLM,
    position: { x: 700, y: 220 },
    data: {
      ...defaultNodeData(NodeType.LLM),
      label: '3b. 补充追问',
      prompt: '需求信息不足，请生成3个追问问题：\n上下文：{{input}}',
      model: 'GPT-4o-mini',
    } as WorkflowNodeData,
  },
];

const initialEdges: WorkflowEdge[] = [
  {
    id: 'e1',
    source: 'n_llm_1',
    target: 'n_cond_1',
    sourceHandle: null,
    targetHandle: null,
    animated: false,
  },
  {
    id: 'e2',
    source: 'n_cond_1',
    sourceHandle: 'true',
    target: 'n_code_1',
    targetHandle: null,
    label: '满足',
    animated: false,
  },
  {
    id: 'e3',
    source: 'n_cond_1',
    sourceHandle: 'false',
    target: 'n_llm_2',
    targetHandle: null,
    label: '不满足',
    animated: false,
  },
];

// ===== Store 类型定义 =====
interface WorkflowState {
  // 核心数据
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
  selectedEdgeIds: string[];

  // 运行状态
  isRunning: boolean;

  // 运行时句柄（ExecutionService 产生，取消时用）
  _runHandle: RunHandle | null;

  // 撤销重做历史
  past: HistorySnapshot[];
  future: HistorySnapshot[];

  // 操作：快照（用于撤销重做）
  _snapshot(): HistorySnapshot;
  _pushHistory(): void;
  undo(): void;
  redo(): void;

  // 节点变更（ReactFlow 回调）
  onNodesChange(changes: NodeChange<WorkflowNode>[]): void;
  onEdgesChange(changes: EdgeChange<WorkflowEdge>[]): void;
  commitDrag(): void;

  // 连线
  onConnect(params: Connection): { error: string | null };

  // 添加节点
  addNode(type: NodeType, position: { x: number; y: number }): string;

  // 选中节点
  setSelectedNodeId(id: string | null): void;

  // 修改节点参数（patch 允许任意扩展字段，配合 BaseNodeData 索引签名使用）
  updateNodeData(nodeId: string, patch: Record<string, unknown>): void;

  // 删除节点（单个 / 批量）
  deleteNodes(ids: string | string[]): void;

  // 删除单条连线
  deleteEdge(edgeId: string): void;

  // 清空画布
  clearCanvas(): void;

  // 重置所有节点状态
  resetStatus(): void;

  // 通过 ExecutionService 运行工作流（业务层建立在 Service 接口之上）
  runWorkflow(): Promise<{ error: string | null }>;
  stopRun(): void;

  // 导入 / 导出 JSON
  importFlow(payload: string | Record<string, unknown>): { error: string | null };
  exportFlow(): string;
}

/**
 * Store 与 ExecutionService 的事件桥：
 * - 任何 Service 实现发出 event → 这里统一 dispatch 到 Zustand state
 *   （业务层 workflowStore 只知道"收到一个执行事件要刷新 UI"，
 *    不用关心事件来自 Mock 还是 HTTP/WS）
 */
function applyEventToState(state: WorkflowState, event: ExecutionEvent): Partial<WorkflowState> {
  switch (event.type) {
    case 'run-started':
      return { isRunning: true };
    case 'node-status-changed':
      return {
        nodes: state.nodes.map((n) =>
          n.id === event.nodeId
            ? { ...n, data: { ...n.data, status: event.status } }
            : n,
        ) as WorkflowNode[],
      };
    case 'node-edges-activated':
      return {
        edges: state.edges.map((e) =>
          e.source === event.sourceNodeId ? { ...e, animated: true } : e,
        ),
      };
    case 'run-finished':
      return { isRunning: false };
    default:
      return {};
  }
}

/**
 * 全局默认的 ExecutionService 实现。
 * 切换实现（如未来换成 HttpExecutionService）只需改这里一处。
 * 通过模块级单例确保同一时间只有一个执行实例在跑（runWorkflow 内部并发保护）。
 */
const DEFAULT_EXECUTION_SERVICE: ExecutionService = new MockExecutionService();

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  // ===== 核心数据 =====
  nodes: initialNodes,
  edges: initialEdges,
  selectedNodeId: null,
  selectedEdgeIds: [],

  // ===== 运行状态 =====
  isRunning: false,
  _runHandle: null,

  // ===== 撤销重做历史 =====
  past: [],
  future: [],

  // ===== 操作：快照（用于撤销重做）=====
  _snapshot() {
    const s = get();
    return {
      nodes: JSON.parse(JSON.stringify(s.nodes)) as WorkflowNode[],
      edges: JSON.parse(JSON.stringify(s.edges)) as WorkflowEdge[],
    };
  },
  _pushHistory() {
    const snap = get()._snapshot();
    set((state) => ({
      past: [...state.past, snap].slice(-50),
      future: [],
    }));
  },
  undo() {
    const { past } = get();
    if (past.length === 0) return;
    const current = get()._snapshot();
    const prev = past[past.length - 1];
    set((state) => ({
      past: state.past.slice(0, -1),
      future: [current, ...state.future].slice(0, 50),
      nodes: prev.nodes,
      edges: prev.edges,
      selectedNodeId: null,
    }));
  },
  redo() {
    const { future } = get();
    if (future.length === 0) return;
    const current = get()._snapshot();
    const next = future[0];
    set((state) => ({
      past: [...state.past, current].slice(0, 50),
      future: state.future.slice(1),
      nodes: next.nodes,
      edges: next.edges,
      selectedNodeId: null,
    }));
  },

  // ===== 节点变更（ReactFlow 回调）=====
  onNodesChange(changes) {
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes as never[]) as WorkflowNode[],
    }));
  },
  onEdgesChange(changes) {
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
    }));
  },

  // 位置拖动结束：记录一次历史
  commitDrag() {
    get()._pushHistory();
  },

  // ===== 连线 =====
  onConnect(params) {
    if (!params.source || !params.target) {
      return { error: '连线无效：缺少源节点或目标节点' };
    }
    const { nodes, edges } = get();
    const newEdge: WorkflowEdge = {
      id: `e_${uuidv4().slice(0, 8)}`,
      source: params.source,
      target: params.target,
      sourceHandle: params.sourceHandle ?? null,
      targetHandle: params.targetHandle ?? null,
      animated: false,
    };
    // 环检测
    if (wouldCreateCycle(nodes, edges, newEdge)) {
      return { error: '禁止创建环路，工作流不能出现循环依赖' };
    }
    get()._pushHistory();
    set((state) => ({
      edges: addEdge(newEdge, state.edges),
    }));
    return { error: null };
  },

  // ===== 添加节点 =====
  addNode(type, position) {
    get()._pushHistory();
    const id = `n_${type}_${uuidv4().slice(0, 6)}`;
    const node: WorkflowNode = {
      id,
      type,
      position,
      data: defaultNodeData(type),
    };
    set((state) => ({
      nodes: [...state.nodes, node],
      selectedNodeId: id,
    }));
    return id;
  },

  // ===== 选中节点 =====
  setSelectedNodeId(id) {
    set({ selectedNodeId: id });
  },

  // ===== 修改节点参数 =====
  updateNodeData(nodeId, patch) {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n
      ) as WorkflowNode[],
    }));
  },

  // ===== 删除节点（单个 / 批量）=====
  deleteNodes(ids) {
    const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
    if (idSet.size === 0) return;
    get()._pushHistory();
    set((state) => ({
      nodes: state.nodes.filter((n) => !idSet.has(n.id)),
      edges: state.edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
      selectedNodeId: idSet.has(state.selectedNodeId ?? '') ? null : state.selectedNodeId,
    }));
  },

  // ===== 删除单条连线 =====
  deleteEdge(edgeId) {
    get()._pushHistory();
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== edgeId),
    }));
  },

  // ===== 清空画布 =====
  clearCanvas() {
    get()._pushHistory();
    set({ nodes: [], edges: [], selectedNodeId: null });
  },

  // ===== 重置所有节点状态 =====
  resetStatus() {
    set((state) => ({
      nodes: state.nodes.map((n) => ({
        ...n,
        data: { ...n.data, status: NodeStatus.IDLE },
      })),
      edges: state.edges.map((e) => ({ ...e, animated: false })),
      isRunning: false,
    }));
  },

  // ===== 通过 ExecutionService 运行工作流 =====
  async runWorkflow() {
    const { resetStatus, _runHandle } = get();

    // 并发保护：同一时间只允许一个执行实例
    if (get().isRunning || _runHandle?.running) {
      return { error: '已有工作流正在执行，请先停止' };
    }

    resetStatus(); // 先清所有状态为 IDLE / 边 animated 清掉

    const snapshot = {
      nodes: get().nodes,
      edges: get().edges,
    };

    let resolveFinished!: (result: { error: string | null }) => void;
    const finishedPromise = new Promise<{ error: string | null }>((res) => {
      resolveFinished = res;
    });

    // 用 ExecutionService 启动；事件通过 applyEventToState 桥到 store
    const handle = DEFAULT_EXECUTION_SERVICE.start(snapshot, (event) => {
      set((state) => applyEventToState(state, event));
      if (event.type === 'run-finished') {
        // 清句柄
        if (get()._runHandle === handle) set({ _runHandle: null });
        resolveFinished({ error: event.reason ?? (event.failedNodeId ? `节点执行失败` : null) });
      }
    });

    set({ _runHandle: handle });

    return finishedPromise;
  },

  stopRun() {
    const handle = get()._runHandle;
    if (handle?.running) {
      handle.cancel();
    }
    // 兜底：若 Service 事件还没回来，先把 UI 标志停掉（避免用户点多次停止造成卡顿）
    set({ isRunning: false });
  },

  // ===== 导入 JSON（Zod 契约校验）=====
  importFlow(payload) {
    let raw: unknown;
    try {
      raw = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      return { error: `JSON 解析失败：${(e as Error).message}` };
    }
    const parsed = WorkflowDefSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: formatZodError(parsed.error) };
    }
    get()._pushHistory();
    set({
      nodes: parsed.data.nodes as WorkflowNode[],
      edges: parsed.data.edges as WorkflowEdge[],
      selectedNodeId: null,
      isRunning: false,
    });
    return { error: null };
  },

  // ===== 导出 JSON =====
  exportFlow() {
    const { nodes, edges } = get();
    return JSON.stringify({ nodes, edges }, null, 2);
  },
}));
