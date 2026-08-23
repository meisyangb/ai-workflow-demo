/**
 * 领域基础类型与纯函数（DAG 拓扑排序 / 枚举 / 默认配置）
 *
 * 单独成模块，用于打破循环依赖：
 *   workflowStore  →  services/mockExecutionService  →  store/workflowStore  ❌
 *   抽出本模块后：
 *   workflowStore  →  workflowDomains ✔️
 *   mockExecutionService  →  workflowDomains ✔️
 *
 * 所有导出都是无副作用的类型/常量/纯函数，可安全地从任何模块 import。
 */

import type { Connection, Edge, Node } from '@xyflow/react';
import type { NodeChange, EdgeChange } from '@xyflow/react';

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

// ===== 节点数据模型 =====
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
      return '#bfbfbf';
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
