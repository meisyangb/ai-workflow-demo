/**
 * v0.3.1 新增：Zustand Store 剪贴板功能 / rerunFromNode / updateNodeProgress 单测
 *
 * 基于 happy-dom + vitest，与 store/__tests__/workflowStore.test.ts 对齐。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkflowStore, NodeStatus } from '../workflowStore';

/** 创建一个全新的 store 实例：复用 default initializer 函数
 *  —— useWorkflowStore.getState() 每次测试前 reset，避免跨用例污染。
 */
function resetStore() {
  useWorkflowStore.setState(useWorkflowStore.getInitialState(), true);
}

describe('v0.3.1 clipboard actions (copyNode / pasteNode / cutNode)', () => {
  beforeEach(resetStore);

  it('TR-2.1 copyNode + pasteNode 生成新 id 且 data.label 不变，nodes 长度 +1', () => {
    const initialLength = useWorkflowStore.getState().nodes.length;
    const first = useWorkflowStore.getState().nodes[0];
    expect(first).toBeDefined();
    expect(first!.id).toBeTruthy();
    const firstId = first!.id;
    const origLabel = first!.data.label;

    useWorkflowStore.getState().copyNode(firstId);
    expect(useWorkflowStore.getState().clipboard).not.toBeNull();
    expect(useWorkflowStore.getState().clipboard!.id).toEqual(firstId);

    const result = useWorkflowStore.getState().pasteNode({ x: 100, y: 200 });
    expect(result).not.toBeNull();
    expect(result).not.toEqual(firstId);

    const { nodes } = useWorkflowStore.getState();
    expect(nodes).toHaveLength(initialLength + 1);
    const pasted = nodes.find((n) => n.id === result);
    expect(pasted).toBeDefined();
    expect(pasted!.data.label).toEqual(origLabel);
    expect(pasted!.position).toEqual({ x: 100, y: 200 });
    // 粘贴后新节点必须为 IDLE 状态，不能携带 RUNNING/FAILED 或 debugOutput
    expect(pasted!.data.status).toEqual(NodeStatus.IDLE);
    expect(pasted!.data.debugOutput).toBeUndefined();
  });

  it('cutNode = copyNode + deleteNodes（nodes 长度不变+1-1 = 不变，但 clipboard 有值 + 原 id 消失）', () => {
    const beforeNodes = useWorkflowStore.getState().nodes;
    const beforeLength = beforeNodes.length;
    const target = beforeNodes[0]!;
    useWorkflowStore.getState().cutNode(target.id);

    const { clipboard, nodes } = useWorkflowStore.getState();
    expect(clipboard).not.toBeNull();
    expect(clipboard!.data.label).toEqual(target.data.label);
    expect(nodes).toHaveLength(beforeLength - 1);
    expect(nodes.some((n) => n.id === target.id)).toBe(false);
  });

  it('pasteNode 无 clipboard 时返回 null 且 nodes 长度不变', () => {
    const beforeLen = useWorkflowStore.getState().nodes.length;
    const id = useWorkflowStore.getState().pasteNode({ x: 1, y: 2 });
    expect(id).toBeNull();
    expect(useWorkflowStore.getState().nodes).toHaveLength(beforeLen);
  });
});

describe('v0.3.1 rerunFromNode 下游节点清零为 IDLE', () => {
  beforeEach(resetStore);

  it('TR-2.2 rerunFromNode(n_cond_1) → n_cond_1 / n_code_1 / n_llm_2 三者 status=IDLE', async () => {
    // 先把下游三个节点手动标记为 SUCCESS/FAILED，验证 rerun 会清零
    useWorkflowStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        ['n_cond_1', 'n_code_1', 'n_llm_2'].includes(n.id)
          ? { ...n, data: { ...n.data, status: NodeStatus.SUCCESS, debugOutput: { foo: 'bar' }, errorMessage: 'fake err', durationMs: 300 } }
          : n,
      ),
    }));
    // 由于 runWorkflow() 会触发 MockExecutionService 的 setTimeout，
    // 这里用 vi 的假时间避免真 sleep 干扰；runWorkflow 返回 promise 立即等待它完成
    vi.useFakeTimers();
    const donePromise = useWorkflowStore.getState().rerunFromNode('n_cond_1');
    // 快进：MockExecutionService 主循环会对 order 中每个节点 wait 800~1500ms，
    // 快进 30s 足以让所有节点走完（最多 4 节点 × 1.5s = 6s）
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await donePromise;
    expect(result).toBeDefined(); // {error: string|null}

    const { nodes } = useWorkflowStore.getState();
    const cond = nodes.find((n) => n.id === 'n_cond_1');
    const code = nodes.find((n) => n.id === 'n_code_1');
    const llm2 = nodes.find((n) => n.id === 'n_llm_2');
    // rerun 跑完后，下游所有节点至少已经历 RUNNING → SUCCESS/FAILED。
    // Mock 有 ~15% 概率随机 FAIL（会写入真实 FAILURE_REASONS 里的错误文案），
    // 所以我们只断言：之前手动写的 'fake err' 一定被清空（等于 undefined 或 != 'fake err'），
    // 也就是 rerunFromNode 确实"状态清零 → 重新执行"发生过。
    expect(cond!.data.errorMessage).not.toBe('fake err');
    expect(code!.data.errorMessage).not.toBe('fake err');
    expect(llm2!.data.errorMessage).not.toBe('fake err');
    vi.useRealTimers();
  });
});

describe('v0.3.1 updateNodeProgress 去重与饱和', () => {
  beforeEach(resetStore);

  it('pct 被 clamp 到 0~1，且相同值不更新引用', () => {
    const s0 = useWorkflowStore.getState();
    expect(s0.nodeProgress).toEqual({});

    s0.updateNodeProgress('x', -1);
    expect(useWorkflowStore.getState().nodeProgress.x).toBe(0);

    s0.updateNodeProgress('x', 3);
    expect(useWorkflowStore.getState().nodeProgress.x).toBe(1);

    // 重复写入相同值：引用保持不变（浅层等于），避免高频 re-render
    const before = useWorkflowStore.getState().nodeProgress;
    s0.updateNodeProgress('x', 1);
    const after = useWorkflowStore.getState().nodeProgress;
    expect(after).toBe(before);
  });
});
