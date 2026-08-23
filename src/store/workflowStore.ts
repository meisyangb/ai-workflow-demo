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

// 初始示例数据（开箱可用）—— v0.3.1：
//   4 节点分叉结构：LLM → CONDITION → {CODE 生成代码 | LLM 补充追问}
//   注：不强行加 START/END（用户反馈"多了一个节点"），分支作为默认 Demo 更直观。
//   - CONDITION expression 真 eval：(keywords?.length ?? 0) >= 3，绝不抛错
//   - CONDITION true/false 分支在 mock execution 真实二选一（不会同时跑两条）
//   - edge 故意不带 label：分支名由节点 Handle 旁的 trueLabel/falseLabel 承载，避免重复
const initialNodes: WorkflowNode[] = [
  {
    id: 'n_llm_1',
    type: NodeType.LLM,
    position: { x: 60, y: 120 },
    data: {
      ...defaultNodeData(NodeType.LLM),
      label: '1. 需求理解（抽关键词）',
      prompt: '请分析以下用户需求，提炼关键点并列出关键词数组：\n{{n_llm_1.input || "帮我做一个带 RAG 和 Agent 的 AI 工作流"}}',
    } as WorkflowNodeData,
  },
  {
    id: 'n_cond_1',
    type: NodeType.CONDITION,
    position: { x: 400, y: 120 },
    data: {
      ...defaultNodeData(NodeType.CONDITION),
      label: '2. 信息是否充分？',
      trueLabel: '✓ 关键词≥3',
      falseLabel: '✗ 信息不足需追问',
      // 安全链式：keywords 没定义/非数组时 → 0，不会 NPE
      expression: '(keywords?.length ?? 0) >= 3',
    } as WorkflowNodeData,
  },
  {
    id: 'n_code_1',
    type: NodeType.CODE,
    position: { x: 740, y: 0 },
    data: {
      ...defaultNodeData(NodeType.CODE),
      label: '3a. 信息充分 → 生成代码',
      code: [
        '// 基于需求分析生成可运行的代码模板',
        'const analysis = {{n_llm_1}};',
        'return {',
        '  template: `class ${analysis.keywords?.[0] ?? "Workflow"}Handler { ... }`,',
        '  keywords: analysis.keywords,',
        '  ok: true,',
        '};',
      ].join('\n'),
    } as WorkflowNodeData,
  },
  {
    id: 'n_llm_2',
    type: NodeType.LLM,
    position: { x: 740, y: 240 },
    data: {
      ...defaultNodeData(NodeType.LLM),
      label: '3b. 信息不足 → 补充追问',
      prompt: [
        '当前需求理解仅提取到 {{n_llm_1.keywords?.length || 0}} 个关键词，不足以继续实现。',
        '请基于上下文生成 3 条对用户的澄清追问问题，按顺序输出：',
        '上下文：{{n_llm_1.result}}',
        '已提取关键词：{{n_llm_1.keywords}}',
      ].join('\n'),
      model: 'GPT-4o-mini',
    } as WorkflowNodeData,
  },
];

const initialEdges: WorkflowEdge[] = [
  {
    id: 'e_llm1_cond',
    source: 'n_llm_1',
    target: 'n_cond_1',
    animated: false,
    type: 'stateful',
  },
  {
    id: 'e_cond_code',
    source: 'n_cond_1',
    sourceHandle: 'true',
    target: 'n_code_1',
    animated: false,
    type: 'stateful',
  },
  {
    id: 'e_cond_llm2',
    source: 'n_cond_1',
    sourceHandle: 'false',
    target: 'n_llm_2',
    animated: false,
    type: 'stateful',
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

  // v0.3.1 新增：剪贴板（右键菜单「复制/剪切/粘贴」用）。节点内 id 仍为原值，粘贴时才生成新 id。
  clipboard: WorkflowNode | null;

  // v0.3.1 新增：节点运行进度（0~1 小数）。由 FlowCanvas rAF 循环写入，不入 undo 历史。
  nodeProgress: Record<string, number>;

  // v0.3.1 新增：UI 折叠状态（节点面板 / 节点详情面板）。不入 undo 历史，
  // 也不被 importFlow / clearCanvas 等数据操作覆盖。
  uiSidebarCollapsed: boolean;
  uiConfigCollapsed: boolean;

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

  // v0.3.1 新增：更新节点运行进度（不入历史，高频率写）
  updateNodeProgress(nodeId: string, pct: number): void;

  // v0.3.1 新增：剪贴板操作
  copyNode(nodeId: string): void;
  cutNode(nodeId: string): void;
  pasteNode(position: { x: number; y: number }): string | null;

  // v0.3.1 新增：从某节点起重试（把该节点 + 所有下游节点状态清零为 IDLE，
  // 清 debugOutput / durationMs / errorMessage，然后 resume 从该节点重跑）
  rerunFromNode(nodeId: string): Promise<{ error: string | null }>;

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

  // v0.3.1 新增：左侧节点面板折叠（画布获得更大横向工作空间）
  toggleSidebarCollapsed(): void;
  setSidebarCollapsed(collapsed: boolean): void;

  // v0.3.1 新增：右侧节点详情面板折叠
  toggleConfigCollapsed(): void;
  setConfigCollapsed(collapsed: boolean): void;

  // ===== 压力测试辅助（仅 DEV / CI 使用）=====
  /**
   * 生成一条可执行的「压力测试工作流」，覆盖 N 个节点。
   * - pattern = linear：START → N-2 LLM 串行链 → END（纯线性拓扑，测 O(N) 状态写入）
   * - pattern = fanout：START → N-2 并行 LLM（START 的出边扇出到所有 LLM）→ 所有 LLM → END（测并行事件抖动）
   * 生成操作不走 undo/redo 历史，不清空剪贴板；selectedNodeId 自动复位。
   */
  __stressGenerate(opts: {
    nodes: number;
    pattern?: 'linear' | 'fanout';
    /** 节点卡片网格步长（px），默认 260×280 网格排布 */
    cellW?: number;
    cellH?: number;
    /** 每列最多几个节点（fanout 模式生效），默认 20 */
    perCol?: number;
  }): { nodes: number; edges: number };
  /** 执行完一次运行后，从 store 直接拉的静态指标（不含 FPS） */
  __stressReport(): {
    nodes: number;
    edges: number;
    running: boolean;
    progressKeys: number;
    successCount: number;
    failedCount: number;
    idleCount: number;
    pastCount: number;
  };
}

/**
 * Store 与 ExecutionService 的事件桥：
 * - 任何 Service 实现发出 event → 这里统一 dispatch 到 Zustand state
 *   （业务层 workflowStore 只知道"收到一个执行事件要刷新 UI"，
 *    不用关心事件来自 Mock 还是 HTTP/WS）
 * v0.3.1 扩展：node-status-changed 事件同时写入 durationMs / debugOutput / errorMessage；
 *             node-progress（局部触发）单独通过 updateNodeProgress() 高频写入不经过此处。
 */
function applyEventToState(state: WorkflowState, event: ExecutionEvent): Partial<WorkflowState> {
  switch (event.type) {
    case 'run-started':
      return { isRunning: true, nodeProgress: {} };
    case 'node-status-changed': {
      const { nodeId, status, durationMs, output, errorMessage } = event;
      return {
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? ({
                ...n,
                data: {
                  ...n.data,
                  status,
                  ...(typeof durationMs === 'number' ? { durationMs } : null),
                  ...(output !== undefined ? { debugOutput: output } : null),
                  ...(typeof errorMessage === 'string'
                    ? { errorMessage }
                    : status === 'success'
                      ? { errorMessage: undefined }
                      : null),
                },
              } as WorkflowNode)
            : n,
        ),
        nodeProgress:
          status === 'running'
            ? { ...state.nodeProgress, [nodeId]: 0.02 }
            : status === 'success'
              ? { ...state.nodeProgress, [nodeId]: 1 }
              : status === 'failed'
                ? { ...state.nodeProgress, [nodeId]: 1 }
                : state.nodeProgress,
      };
    }
    case 'node-edges-activated':
      return {
        edges: state.edges.map((e) => {
          if (e.source !== event.sourceNodeId) return e;
          // v0.3.1：若 activatedEdgeIds 提供 → 仅指定 id 的出边 animated=true，
          // 其它出边（该 source 下的兄弟分支，如 CONDITION 的另一分支）明确 animated=false，
          // 保证 StatefulEdge 不同时显示两条分支流动光点，符合二选一语义。
          if (Array.isArray(event.activatedEdgeIds)) {
            return event.activatedEdgeIds.includes(e.id)
              ? { ...e, animated: true }
              : { ...e, animated: false };
          }
          // 兼容：未指定时全部 animated=true（老代码路径）
          return { ...e, animated: true };
        }),
      };
    case 'run-finished':
      return { isRunning: false };
    default:
      return {};
  }
}

/**
 * 全局 ExecutionService 运行时注册表（模块级可变容器，但只通过 configureExecutionService() 写入）。
 *
 * - 正常应用启动：在 main.tsx 装配层 configureExecutionService(new MockExecutionService()) 注入默认。
 * - CI / 压力测试：在 beforeAll 注入零延时微任务服务（stressTestRuntime.service 不再额外污染）。
 * - 切换 HTTP/WS 后端：也只需要在装配层重新 configure，不改业务 store 代码。
 * - 未注入时 get() 会在首次调用时懒加载 Mock（保持兼容，但主入口建议显式注入）。
 */
const executionServiceRegistry: { instance: ExecutionService | null; configured: boolean } = {
  instance: null,
  configured: false,
};

/**
 * 配置全局执行服务（仅装配层 / 测试 beforeAll 调用；可重复调用以热切换后端实现）。
 * 若运行中有进行中的 run，会取消旧 handle 但不负责清理节点状态（由调用方显式 importFlow/reset 保证）。
 */
export function configureExecutionService(
  service: ExecutionService,
  opts: { markConfigured?: boolean } = { markConfigured: true },
): ExecutionService {
  executionServiceRegistry.instance = service;
  if (opts.markConfigured) executionServiceRegistry.configured = true;
  return service;
}

/** 只读获取当前执行服务（内部使用；未 configure 时懒回退到 Mock 保证兼容）。*/
function getExecutionService(): ExecutionService {
  if (executionServiceRegistry.instance) return executionServiceRegistry.instance;
  // 懒回退：只在"用户没 configure"兜底，不标记 configured，方便以后检测"是否主动注入"
  const fallback = new MockExecutionService();
  executionServiceRegistry.instance = fallback;
  return fallback;
}

// 兼容旧 stress test 导出（v0.3.1 stress.test.ts 通过 stressTestRuntime.service 注入；
// v0.4.0 统一改走 configureExecutionService，这里保留引用避免外部 import 报错）。
// 实现上把它同步到 registry：读=get()，写=configure（不 mark configured，测试切换更自由）。
export const stressTestRuntime: { service: ExecutionService | null } = {
  get service() {
    return executionServiceRegistry.configured ? executionServiceRegistry.instance : null;
  },
  set service(next: ExecutionService | null) {
    if (next) {
      configureExecutionService(next, { markConfigured: false });
    } else {
      executionServiceRegistry.instance = null;
      executionServiceRegistry.configured = false;
    }
  },
};

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  // ===== 核心数据 =====
  nodes: initialNodes,
  edges: initialEdges,
  selectedNodeId: null,
  selectedEdgeIds: [],

  // ===== 运行状态 =====
  isRunning: false,
  _runHandle: null,

  // ===== v0.3.1 剪贴板 + 节点进度 =====
  clipboard: null,
  nodeProgress: {},

  // ===== v0.3.1 UI 折叠状态（两侧面板折叠；默认均展开）=====
  uiSidebarCollapsed: false,
  uiConfigCollapsed: false,

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
      type: 'stateful',
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

  // ===== v0.3.1 新增：更新节点运行进度（高频写入，不入 undo 历史）=====
  updateNodeProgress(nodeId, pct) {
    const safe = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
    set((state) =>
      state.nodeProgress[nodeId] === safe
        ? state // 避免 1000fps 触发无意义 re-render
        : {
            nodeProgress: { ...state.nodeProgress, [nodeId]: safe },
          },
    );
  },

  // ===== v0.3.1 新增：剪贴板操作 =====
  copyNode(nodeId) {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // 深拷贝 data，避免粘贴后修改影响原节点（浅层 JSON clone 足以，节点不含函数/日期）
    const cloned: WorkflowNode = JSON.parse(JSON.stringify(node)) as WorkflowNode;
    // 状态改为 IDLE，避免把 RUNNING/FAILED 一起粘过去
    cloned.data = { ...cloned.data, status: NodeStatus.IDLE, debugOutput: undefined, durationMs: undefined, errorMessage: undefined };
    set({ clipboard: cloned });
  },
  cutNode(nodeId) {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // 先 copy（逻辑上 cut = copy + delete）
    const cloned: WorkflowNode = JSON.parse(JSON.stringify(node)) as WorkflowNode;
    cloned.data = { ...cloned.data, status: NodeStatus.IDLE, debugOutput: undefined, durationMs: undefined, errorMessage: undefined };
    set({ clipboard: cloned });
    get().deleteNodes(nodeId);
  },
  pasteNode(position) {
    const { clipboard } = get();
    if (!clipboard) return null;
    get()._pushHistory();
    // 生成新 id：clipboard.id + 后缀（保证唯一性 + 用户能看到来源）
    const suffix = uuidv4().slice(0, 6);
    const idExists = new Set(get().nodes.map((n) => n.id));
    let newId = `${clipboard.id}_cp_${suffix}`;
    // 极小概率撞 id → 再补一轮随机
    while (idExists.has(newId)) newId = `${clipboard.id}_cp_${uuidv4().slice(0, 6)}`;
    const cloned: WorkflowNode = JSON.parse(JSON.stringify(clipboard)) as WorkflowNode;
    cloned.id = newId;
    cloned.position = { ...position };
    cloned.data = { ...cloned.data, status: NodeStatus.IDLE, debugOutput: undefined, durationMs: undefined, errorMessage: undefined };
    set((state) => ({
      nodes: [...state.nodes, cloned],
      selectedNodeId: newId,
    }));
    return newId;
  },

  // ===== v0.3.1 新增：从某节点起重试 =====
  // 1. 找到 nodeId 及所有下游节点（拓扑 BFS）
  // 2. 把它们的 status → IDLE、debugOutput/durationMs/errorMessage 清 undefined
  // 3. 清所有从这些节点出发的 edge 的 animated 状态
  // 4. （简化实现）直接调用 runWorkflow() 再跑一次全流程 —— 因为 MockExecutionService
  //    会对 IDLE 状态节点按拓扑跑；效果等价于从该节点起 resume（对用户 UI 完全一致）
  async rerunFromNode(nodeId) {
    const { nodes: curNodes, edges: curEdges } = get();
    if (!curNodes.some((n) => n.id === nodeId)) {
      return { error: `节点 ${nodeId} 不存在` };
    }
    // 构造"从 nodeId 出发可达下游集合"（含自身）
    const adj: Record<string, string[]> = {};
    curNodes.forEach((n) => (adj[n.id] = []));
    curEdges.forEach((e) => {
      if (adj[e.source]) adj[e.source].push(e.target);
    });
    const downstream = new Set<string>([nodeId]);
    const q = [nodeId];
    while (q.length > 0) {
      const id = q.shift() as string;
      (adj[id] ?? []).forEach((next) => {
        if (!downstream.has(next)) { downstream.add(next); q.push(next); }
      });
    }
    get()._pushHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        downstream.has(n.id)
          ? ({
              ...n,
              data: {
                ...n.data,
                status: NodeStatus.IDLE,
                debugOutput: undefined,
                durationMs: undefined,
                errorMessage: undefined,
              },
            } as WorkflowNode)
          : n,
      ),
      edges: state.edges.map((e) =>
        downstream.has(e.source) ? { ...e, animated: false } : e,
      ),
    }));
    // 简化：直接 runWorkflow() 全量重跑；Mock Service 会按拓扑顺序从 0 开始跑。
    return get().runWorkflow();
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
    // （v0.4.0 起：默认实现由装配层 main.tsx 通过 configureExecutionService() 注入；
    //  store 本身不再 new 具体实现，符合"业务只依赖接口"）。
    const svc = getExecutionService();
    const handle = svc.start(snapshot, (event) => {
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

  // ===== 左/右侧面板折叠（仅 UI，不进入 undo/redo 历史）=====
  toggleSidebarCollapsed() {
    set((s) => ({ uiSidebarCollapsed: !s.uiSidebarCollapsed }));
  },
  setSidebarCollapsed(collapsed) {
    set({ uiSidebarCollapsed: collapsed });
  },
  toggleConfigCollapsed() {
    set((s) => ({ uiConfigCollapsed: !s.uiConfigCollapsed }));
  },
  setConfigCollapsed(collapsed) {
    set({ uiConfigCollapsed: collapsed });
  },

  // ===== 压力测试辅助（仅 DEV / CI 使用）=====
  __stressGenerate({
    nodes: N,
    pattern = 'linear',
    cellW = 260,
    cellH = 280,
    perCol = 20,
  }) {
    const count = Math.max(3, Math.floor(N)); // 至少 START + 1 LLM + END
    const nodes: WorkflowNode[] = [];
    const edges: WorkflowEdge[] = [];
    const stamp = `stress-${Date.now().toString(36)}`;

    // ---- 1) START ----
    const startId = `startNode_${stamp}_0`;
    nodes.push({
      id: startId,
      type: NodeType.START,
      position: { x: 40, y: cellH + 40 },
      data: { ...defaultNodeData(NodeType.START) },
    });

    // ---- 2) LLM Nodes = count - 2 ----
    const llmCount = count - 2;
    const llmIds: string[] = [];
    for (let i = 0; i < llmCount; i += 1) {
      const id = `llmNode_${stamp}_${i + 1}`;
      llmIds.push(id);
      let pos: { x: number; y: number };
      if (pattern === 'linear') {
        pos = { x: 40 + (i + 1) * cellW, y: cellH + 40 };
      } else {
        // fanout：第 0 列 START，第 1..M 列按 perCol 堆叠
        const colIdx = 1 + Math.floor(i / perCol);
        const rowIdx = i % perCol;
        pos = { x: 40 + colIdx * cellW, y: 40 + rowIdx * cellH };
      }
      nodes.push({
        id,
        type: NodeType.LLM,
        position: pos,
        data: { ...defaultNodeData(NodeType.LLM) },
      });
    }

    // ---- 3) END ----
    let endPos: { x: number; y: number };
    if (pattern === 'linear') {
      endPos = { x: 40 + (llmCount + 1) * cellW, y: cellH + 40 };
    } else {
      const cols = Math.max(1, Math.ceil(llmCount / perCol));
      const midRow = (Math.min(perCol, llmCount) - 1) / 2;
      endPos = { x: 40 + (cols + 1) * cellW, y: 40 + midRow * cellH };
    }
    const endId = `endNode_${stamp}_E`;
    nodes.push({
      id: endId,
      type: NodeType.END,
      position: endPos,
      data: { ...defaultNodeData(NodeType.END) },
    });

    // ---- 4) 连线 ----
    if (pattern === 'linear') {
      edges.push({
        id: `e_${startId}__${llmIds[0]}`,
        source: startId,
        sourceHandle: 'out',
        target: llmIds[0],
        targetHandle: 'in',
        type: 'stateful',
        animated: false,
      });
      for (let i = 0; i < llmIds.length - 1; i += 1) {
        edges.push({
          id: `e_${llmIds[i]}__${llmIds[i + 1]}`,
          source: llmIds[i],
          sourceHandle: 'out',
          target: llmIds[i + 1],
          targetHandle: 'in',
          type: 'stateful',
          animated: false,
        });
      }
      edges.push({
        id: `e_${llmIds[llmIds.length - 1]}__${endId}`,
        source: llmIds[llmIds.length - 1],
        sourceHandle: 'out',
        target: endId,
        targetHandle: 'in',
        type: 'stateful',
        animated: false,
      });
    } else {
      // fanout
      for (const id of llmIds) {
        edges.push({
          id: `e_${startId}__${id}`,
          source: startId,
          sourceHandle: 'out',
          target: id,
          targetHandle: 'in',
          type: 'stateful',
          animated: false,
        });
      }
      for (const id of llmIds) {
        edges.push({
          id: `e_${id}__${endId}`,
          source: id,
          sourceHandle: 'out',
          target: endId,
          targetHandle: 'in',
          type: 'stateful',
          animated: false,
        });
      }
    }

    // 直接 set，不写入 undo/redo 历史（past / future 保持不变）
    set({
      nodes,
      edges,
      selectedNodeId: null,
      isRunning: false,
      _runHandle: null,
      nodeProgress: {},
    });

    return { nodes: nodes.length, edges: edges.length };
  },
  __stressReport() {
    const s = get();
    let success = 0;
    let failed = 0;
    let idle = 0;
    for (const n of s.nodes) {
      if (n.data.status === NodeStatus.SUCCESS) success += 1;
      else if (n.data.status === NodeStatus.FAILED) failed += 1;
      else if (n.data.status === NodeStatus.IDLE) idle += 1;
    }
    return {
      nodes: s.nodes.length,
      edges: s.edges.length,
      running: s.isRunning,
      progressKeys: Object.keys(s.nodeProgress).length,
      successCount: success,
      failedCount: failed,
      idleCount: idle,
      pastCount: s.past.length,
    };
  },
}));
