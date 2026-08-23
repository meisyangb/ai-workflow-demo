import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { Connection, Edge, Node, NodeChange, EdgeChange } from '@xyflow/react';
import { WorkflowDefSchema, formatZodError } from '../schemas/workflow';

// ===== 枚举（常量对象 + 派生字面量联合类型）=====
export const NodeStatus = {
  IDLE: 'idle', // 待执行 (默认灰)
  RUNNING: 'running', // 运行中 (黄)
  SUCCESS: 'success', // 成功 (绿)
  FAILED: 'failed', // 失败 (红)
} as const;
export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];

export const NodeType = {
  LLM: 'llmNode',
  CONDITION: 'conditionNode',
  CODE: 'codeNode',
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

// ===== 节点数据模型（type 别名以兼容 xyflow 的 Record<string, unknown> 约束）=====
export type LLMNodeData = {
  label: string;
  status: NodeStatus;
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
};

export type ConditionNodeData = {
  label: string;
  status: NodeStatus;
  expression: string;
  trueLabel: string;
  falseLabel: string;
};

export type CodeNodeData = {
  label: string;
  status: NodeStatus;
  language: string;
  code: string;
  timeout: number;
};

export type WorkflowNodeData = LLMNodeData | ConditionNodeData | CodeNodeData;

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

/** 撤销/重做历史快照 */
export interface HistorySnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// 状态对应颜色
export const statusColor = (status: NodeStatus): string => {
  switch (status) {
    case NodeStatus.RUNNING:
      return '#faad14'; // 黄
    case NodeStatus.SUCCESS:
      return '#52c41a'; // 绿
    case NodeStatus.FAILED:
      return '#ff4d4f'; // 红
    default:
      return '#bfbfbf';
  }
};

// 状态对应中文文本
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

// 各节点类型的默认配置
export const defaultNodeData = (type: NodeType): WorkflowNodeData => {
  switch (type) {
    case NodeType.LLM:
      return {
        label: '大模型节点',
        status: NodeStatus.IDLE,
        model: 'GPT-4o',
        prompt: '你是一个有用的AI助手，请根据用户输入回答问题。\n用户输入：{{input}}',
        temperature: 0.7,
        maxTokens: 2048,
      };
    case NodeType.CONDITION:
      return {
        label: '条件分支',
        status: NodeStatus.IDLE,
        expression: '{{input}} > 10',
        trueLabel: '满足条件',
        falseLabel: '不满足',
      };
    case NodeType.CODE:
      return {
        label: '代码执行',
        status: NodeStatus.IDLE,
        language: 'javascript',
        code: '// 输入变量通过 input 获取\nconst result = input * 2;\nreturn { output: result };',
        timeout: 30,
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
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[]
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
  // 有环：result 长度 < 节点数
  const hasCycle = result.length !== nodes.length;
  return { hasCycle, order: result };
}

// 检查添加某条边后是否会成环
export function wouldCreateCycle(
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
  newEdge: GraphEdgeLike
): boolean {
  const tempEdges = [...edges, newEdge];
  const { hasCycle } = topologicalSort(nodes, tempEdges);
  return hasCycle;
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
    },
  },
  {
    id: 'n_cond_1',
    type: NodeType.CONDITION,
    position: { x: 380, y: 120 },
    data: {
      ...defaultNodeData(NodeType.CONDITION),
      expression: 'result.keywords.length > 3',
    },
  },
  {
    id: 'n_code_1',
    type: NodeType.CODE,
    position: { x: 700, y: 40 },
    data: {
      ...defaultNodeData(NodeType.CODE),
      label: '3a. 生成代码',
      code: '// 根据分析结果生成代码模板\nreturn { template: `function ${input.name}() { /* TODO */ }` };',
    },
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
    },
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

  // 修改节点参数
  updateNodeData(nodeId: string, patch: Partial<WorkflowNodeData>): void;

  // 删除节点（单个 / 批量）
  deleteNodes(ids: string | string[]): void;

  // 删除单条连线
  deleteEdge(edgeId: string): void;

  // 清空画布
  clearCanvas(): void;

  // 重置所有节点状态
  resetStatus(): void;

  // 模拟运行工作流
  runWorkflow(): Promise<{ error: string | null }>;
  stopRun(): void;

  // 导入 / 导出 JSON
  importFlow(payload: string | Record<string, unknown>): { error: string | null };
  exportFlow(): string;
}

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  // ===== 核心数据 =====
  nodes: initialNodes,
  edges: initialEdges,
  selectedNodeId: null,
  selectedEdgeIds: [],

  // ===== 运行状态 =====
  isRunning: false,

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
      nodes: applyNodeChanges(changes, state.nodes),
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

  // ===== 模拟运行工作流 =====
  async runWorkflow() {
    const { nodes, edges, resetStatus } = get();
    if (nodes.length === 0) {
      return { error: '画布为空，请先添加节点' };
    }
    resetStatus();

    const { hasCycle, order } = topologicalSort(nodes, edges);
    if (hasCycle) {
      return { error: '检测到环路，无法执行工作流' };
    }

    set({ isRunning: true });

    // 设置某条连线动画
    const setEdgeAnimated = (sourceId: string, animated: boolean) => {
      set((state) => ({
        edges: state.edges.map((e) => (e.source === sourceId ? { ...e, animated } : e)),
      }));
    };

    // 依次执行
    for (const nodeId of order) {
      // 停止检查（如果中途调用 reset/clear）
      if (!get().isRunning) break;

      // 高亮该节点为运行中
      set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, status: NodeStatus.RUNNING } } : n
        ),
      }));
      // 模拟延时 0.8~1.5s
      const delay = 800 + Math.floor(Math.random() * 700);
      await new Promise((r) => setTimeout(r, delay));

      if (!get().isRunning) break;

      // 85% 成功，15% 失败（让演示画面丰富）
      const succeed = Math.random() < 0.85;
      set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, status: succeed ? NodeStatus.SUCCESS : NodeStatus.FAILED } }
            : n
        ),
      }));
      // 连线动画反馈
      setEdgeAnimated(nodeId, true);

      // 如果失败，演示时这里就停下来
      if (!succeed) break;
    }

    set({ isRunning: false });
    return { error: null };
  },

  stopRun() {
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
