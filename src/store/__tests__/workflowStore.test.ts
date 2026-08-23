import { describe, it, expect, beforeEach } from 'vitest';
import {
  useWorkflowStore,
  NodeStatus,
  NodeType,
  topologicalSort,
  wouldCreateCycle,
  defaultNodeData,
} from '../workflowStore';

/**
 * 测试基线数据：a(LLM) -> b(条件) -> c(代码)，b 从 true 口连 c
 */
const fixture = {
  nodes: [
    {
      id: 'a',
      type: 'llmNode',
      position: { x: 0, y: 0 },
      data: {
        label: 'A',
        status: 'idle',
        model: 'GPT-4o',
        prompt: 'p',
        temperature: 0.7,
        maxTokens: 2048,
      },
    },
    {
      id: 'b',
      type: 'conditionNode',
      position: { x: 100, y: 0 },
      data: { label: 'B', status: 'idle', expression: 'x > 1', trueLabel: 'T', falseLabel: 'F' },
    },
    {
      id: 'c',
      type: 'codeNode',
      position: { x: 200, y: 0 },
      data: { label: 'C', status: 'idle', language: 'javascript', code: 'return 1;', timeout: 30 },
    },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b', sourceHandle: null, targetHandle: null, animated: false },
    {
      id: 'e2',
      source: 'b',
      target: 'c',
      sourceHandle: 'true',
      targetHandle: null,
      animated: false,
    },
  ],
};

const ids = (nodes: Array<{ id: string }>) => nodes.map((n) => n.id).sort();

beforeEach(() => {
  const res = useWorkflowStore.getState().importFlow(JSON.stringify(fixture));
  expect(res.error).toBeNull();
});

// ==================== 拓扑排序 ====================
describe('topologicalSort 拓扑排序（Kahn）', () => {
  it('线性链 a->b->c：无环且顺序合法（a 先于 b 先于 c）', () => {
    const { hasCycle, order } = topologicalSort(fixture.nodes, fixture.edges);
    expect(hasCycle).toBe(false);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    expect(order).toHaveLength(3);
  });

  it('分支图（a->b, a->c）：包含全部节点且 a 最先', () => {
    const nodes = fixture.nodes;
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ];
    const { hasCycle, order } = topologicalSort(nodes, edges);
    expect(hasCycle).toBe(false);
    expect(order[0]).toBe('a');
    expect(order.slice(1).sort()).toEqual(['b', 'c']);
  });

  it('成环 a->b->a：hasCycle 为 true', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    const { hasCycle } = topologicalSort(fixture.nodes, edges);
    expect(hasCycle).toBe(true);
  });

  it('自环 a->a：hasCycle 为 true', () => {
    const { hasCycle } = topologicalSort(fixture.nodes, [{ source: 'a', target: 'a' }]);
    expect(hasCycle).toBe(true);
  });

  it('空图：返回空序且无环', () => {
    const { hasCycle, order } = topologicalSort([], []);
    expect(hasCycle).toBe(false);
    expect(order).toEqual([]);
  });

  it('孤立节点（无边）：全部包含在结果中', () => {
    const { hasCycle, order } = topologicalSort(fixture.nodes, []);
    expect(hasCycle).toBe(false);
    expect(order.sort()).toEqual(['a', 'b', 'c']);
  });
});

// ==================== 环检测 ====================
describe('wouldCreateCycle 环检测', () => {
  it('回边 c->a（现有 a->b->c）返回 true', () => {
    expect(wouldCreateCycle(fixture.nodes, fixture.edges, { source: 'c', target: 'a' })).toBe(true);
  });

  it('前向边 a->c（现有 a->b->c）返回 false', () => {
    expect(wouldCreateCycle(fixture.nodes, fixture.edges, { source: 'a', target: 'c' })).toBe(
      false,
    );
  });

  it('自连 a->a 返回 true', () => {
    expect(wouldCreateCycle(fixture.nodes, fixture.edges, { source: 'a', target: 'a' })).toBe(true);
  });
});

// ==================== 默认节点配置 ====================
describe('defaultNodeData 默认节点配置', () => {
  it('LLM 节点：status 为 idle 且含全部必填字段', () => {
    const d = defaultNodeData(NodeType.LLM);
    expect(d.status).toBe(NodeStatus.IDLE);
    expect(d).toHaveProperty('model');
    expect(d).toHaveProperty('prompt');
    expect(d).toHaveProperty('temperature');
    expect(d).toHaveProperty('maxTokens');
  });

  it('条件节点：含 expression 与双分支标签', () => {
    const d = defaultNodeData(NodeType.CONDITION);
    expect(d.status).toBe(NodeStatus.IDLE);
    expect(d).toHaveProperty('expression');
    expect(d).toHaveProperty('trueLabel');
    expect(d).toHaveProperty('falseLabel');
  });

  it('代码节点：含 language / code / timeout', () => {
    const d = defaultNodeData(NodeType.CODE);
    expect(d.status).toBe(NodeStatus.IDLE);
    expect(d).toHaveProperty('language');
    expect(d).toHaveProperty('code');
    expect(d).toHaveProperty('timeout');
  });
});

// ==================== Store：连线 ====================
describe('Store onConnect', () => {
  it('正常连线成功且 edges +1', () => {
    const before = useWorkflowStore.getState().edges.length;
    const res = useWorkflowStore.getState().onConnect({
      source: 'a',
      target: 'c',
      sourceHandle: null,
      targetHandle: null,
    });
    expect(res.error).toBeNull();
    expect(useWorkflowStore.getState().edges.length).toBe(before + 1);
  });

  it('成环连线被拒绝且不产生新边', () => {
    const before = useWorkflowStore.getState().edges.length;
    const res = useWorkflowStore.getState().onConnect({
      source: 'c',
      target: 'a',
      sourceHandle: null,
      targetHandle: null,
    });
    expect(res.error).toContain('环路');
    expect(useWorkflowStore.getState().edges.length).toBe(before);
  });

  it('缺 source 的无效连线被拒绝', () => {
    // 运行时防御：v12 类型上 source 非空，但保留对空值的运行时守卫
    const res = useWorkflowStore.getState().onConnect({
      source: null as unknown as string,
      target: 'a',
      sourceHandle: null,
      targetHandle: null,
    });
    expect(res.error).not.toBeNull();
  });

  it('自连线被环检测拒绝', () => {
    const res = useWorkflowStore.getState().onConnect({
      source: 'a',
      target: 'a',
      sourceHandle: null,
      targetHandle: null,
    });
    expect(res.error).not.toBeNull();
  });
});

// ==================== Store：节点增删 / 撤销重做 ====================
describe('Store addNode / deleteNodes / undo / redo', () => {
  it('addNode 添加节点并自动选中', () => {
    const before = useWorkflowStore.getState().nodes.length;
    const id = useWorkflowStore.getState().addNode(NodeType.LLM, { x: 300, y: 300 });
    const s = useWorkflowStore.getState();
    expect(s.nodes.length).toBe(before + 1);
    expect(s.selectedNodeId).toBe(id);
    expect(s.nodes.find((n) => n.id === id)?.data.label).toBeTruthy();
  });

  it('deleteNodes 批量删除并级联清理关联边', () => {
    useWorkflowStore.getState().deleteNodes(['b', 'c']);
    const s = useWorkflowStore.getState();
    expect(ids(s.nodes)).toEqual(['a']);
    // e1(a->b)、e2(b->c) 都应被级联删除
    expect(s.edges).toHaveLength(0);
  });

  it('undo 撤销 addNode，redo 恢复', () => {
    const pastLen = useWorkflowStore.getState().past.length;
    const before = useWorkflowStore.getState().nodes.length;
    useWorkflowStore.getState().addNode(NodeType.CODE, { x: 0, y: 0 });
    expect(useWorkflowStore.getState().nodes.length).toBe(before + 1);
    expect(useWorkflowStore.getState().past.length).toBe(pastLen + 1);

    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().nodes.length).toBe(before);

    useWorkflowStore.getState().redo();
    expect(useWorkflowStore.getState().nodes.length).toBe(before + 1);
  });
});

// ==================== 导入导出契约 ====================
describe('importFlow / exportFlow（Zod 契约）', () => {
  it('非法 JSON 字符串：返回解析失败错误', () => {
    const res = useWorkflowStore.getState().importFlow('{ not valid json ]');
    expect(res.error).toContain('解析失败');
  });

  it('未知节点类型：拒绝', () => {
    const bad = JSON.stringify({
      nodes: [{ ...fixture.nodes[0], type: 'unknownNode' }],
      edges: [],
    });
    const res = useWorkflowStore.getState().importFlow(bad);
    expect(res.error).toContain('校验失败');
  });

  it('节点数据字段缺失：拒绝且画布不变', () => {
    const before = ids(useWorkflowStore.getState().nodes);
    const bad = JSON.stringify({
      nodes: [{ id: 'x', type: 'llmNode', position: { x: 0, y: 0 }, data: { label: 'X' } }],
      edges: [],
    });
    const res = useWorkflowStore.getState().importFlow(bad);
    expect(res.error).toContain('校验失败');
    expect(ids(useWorkflowStore.getState().nodes)).toEqual(before);
  });

  it('temperature 越界（>2）：拒绝', () => {
    const bad = JSON.stringify({
      nodes: [
        {
          ...fixture.nodes[0],
          data: { ...fixture.nodes[0].data, temperature: 9 },
        },
      ],
      edges: [],
    });
    const res = useWorkflowStore.getState().importFlow(bad);
    expect(res.error).toContain('校验失败');
  });

  it('导出 -> 导入 往返：画布一致', () => {
    const json = useWorkflowStore.getState().exportFlow();
    const res = useWorkflowStore.getState().importFlow(json);
    expect(res.error).toBeNull();
    const s = useWorkflowStore.getState();
    expect(ids(s.nodes)).toEqual(ids(fixture.nodes));
    expect(s.edges).toHaveLength(fixture.edges.length);
  });

  it('未知字段被剔除（strip），animated 缺省默认 false', () => {
    const withExtra = JSON.stringify({
      nodes: [{ ...fixture.nodes[0], extraField: 'hack' }],
      edges: [{ ...fixture.edges[0], animated: undefined }],
    });
    const res = useWorkflowStore.getState().importFlow(withExtra);
    expect(res.error).toBeNull();
    const node = useWorkflowStore.getState().nodes.find((n) => n.id === 'a');
    expect(node).toBeDefined();
    expect(node).not.toHaveProperty('extraField');
  });
});
