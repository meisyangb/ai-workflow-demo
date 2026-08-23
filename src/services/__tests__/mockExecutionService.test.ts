import { describe, it, expect } from 'vitest';
import {
  MockExecutionService,
  type MockExecutionServiceOptions,
} from '../mockExecutionService';
import type { ExecutionEvent, WorkflowSnapshot } from '../executionService';
import {
  NodeType,
  NodeStatus as NS,
  defaultNodeData,
  type WorkflowNode,
  type WorkflowEdge,
} from '../../domains/workflow';

// ---------- Fixture ----------
function mkNode(id: string, type: keyof typeof NodeType): WorkflowNode {
  return {
    id,
    type: NodeType[type],
    position: { x: 0, y: 0 },
    data: defaultNodeData(NodeType[type]),
  };
}

function chainFixture(): { snapshot: WorkflowSnapshot; order: string[] } {
  const a = mkNode('a', 'LLM');
  const b = mkNode('b', 'CONDITION');
  // v0.3.1：MockExecutionService 现在真 eval CONDITION expression；
  // 要让这条测试链路（b -[sourceHandle='true']→ c）保持 100% 命中 true 分支 → 走 c，
  // 所以显式把 expression 写为 true。其余链路仍按原拓扑 [a,b,c]。
  b.data = { ...b.data, expression: 'true' };
  const c = mkNode('c', 'CODE');
  const edges: WorkflowEdge[] = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c', sourceHandle: 'true' },
  ];
  return { snapshot: { nodes: [a, b, c], edges }, order: ['a', 'b', 'c'] };
}

/** 手动控制的 scheduler：事件顺序可控 */
function makeManualScheduler() {
  let tick: (() => void) | null = null;
  let currentMs = 0;
  let cleared = false;
  const scheduler: Required<MockExecutionServiceOptions>['scheduler'] = (ms, cb) => {
    currentMs = ms;
    tick = cb;
    cleared = false;
    return {
      clear: () => {
        tick = null;
        cleared = true;
      },
    };
  };
  const runOne = () => {
    const fn = tick;
    tick = null;
    fn?.();
  };
  return { scheduler, runOne, getMs: () => currentMs, wasCleared: () => cleared };
}

/** 等待所有已排定的 microtasks 执行完（比 setTimeout(0) 精确）*/
function flushMicrotasks(): Promise<void> {
  return new Promise((res) => queueMicrotask(res));
}

// ---------- 测试 ----------
describe('MockExecutionService', () => {
  describe('前置校验', () => {
    it('空画布：同步错误，不发 started', async () => {
      const svc = new MockExecutionService({ delayRangeMs: [0, 0] });
      const events: ExecutionEvent[] = [];
      const handle = svc.start({ nodes: [], edges: [] }, (e) => events.push(e));
      const res = await handle.done();
      expect(res.error).toBe('画布为空，请先添加节点');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run-finished');
    });

    it('存在环路：同步错误，不发 started', async () => {
      const svc = new MockExecutionService({ delayRangeMs: [0, 0] });
      const a = mkNode('a', 'LLM');
      const b = mkNode('b', 'LLM');
      const cycleEdges: WorkflowEdge[] = [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ];
      const events: ExecutionEvent[] = [];
      const handle = svc.start({ nodes: [a, b], edges: cycleEdges }, (e) => events.push(e));
      const res = await handle.done();
      expect(res.error).toBe('检测到环路，无法执行工作流');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run-finished');
    });
  });

  describe('全成功流程', () => {
    it('successRate=1 + 手动推进：最终完成(reason=null)；事件含 started + 3 节点成功 + 3 条边激活 + finished', async () => {
      const s = makeManualScheduler();
      const svc = new MockExecutionService({ scheduler: s.scheduler, successRate: 1 });
      const { snapshot, order } = chainFixture();

      const events: ExecutionEvent[] = [];
      const handle = svc.start(snapshot, (e) => events.push(e));
      await flushMicrotasks();

      // 关键事件存在性断言（避免微任务顺序差异）
      const started = events.find((e) => e.type === 'run-started') as
        | Extract<ExecutionEvent, { type: 'run-started' }>
        | undefined;
      expect(started).toBeDefined();
      expect(started!.order).toEqual(order);

      // 每个节点都 IDLE 过
      const idleFor = (id: string) =>
        events.some(
          (e) => e.type === 'node-status-changed' && e.nodeId === id && e.status === NS.IDLE,
        );
      expect(idleFor('a') && idleFor('b') && idleFor('c')).toBe(true);

      // 按拓扑顺序逐节点推进（每个节点需要一次 runOne 来解出 wait）
      for (const _nodeId of order) {
        s.runOne();
        await flushMicrotasks();
      }

      // 3 个节点均 SUCCESS
      const successSet = new Set(
        events
          .filter(
            (e) => e.type === 'node-status-changed' && e.status === NS.SUCCESS,
          )
          .map((e) => (e.type === 'node-status-changed' ? e.nodeId : '')),
      );
      expect([...successSet].sort()).toEqual(['a', 'b', 'c']);

      // 3 条边激活事件（每个成功节点一条）
      const activatedSources = events
        .filter((e) => e.type === 'node-edges-activated')
        .map((e) => (e.type === 'node-edges-activated' ? e.sourceNodeId : ''));
      expect(activatedSources.sort()).toEqual(['a', 'b', 'c']);

      const res = await handle.done();
      expect(res.error).toBeNull();
      const finished = events[events.length - 1];
      expect(finished.type).toBe('run-finished');
    });
  });

  describe('失败行为', () => {
    it('successRate=0 → 第一个节点失败并立即停止，finished 带 failedNodeId', async () => {
      const s = makeManualScheduler();
      const svc = new MockExecutionService({ scheduler: s.scheduler, successRate: 0 });
      const { snapshot } = chainFixture();
      const events: ExecutionEvent[] = [];
      const handle = svc.start(snapshot, (e) => events.push(e));
      await flushMicrotasks();

      // 推进一轮（a RUNNING → wait → 失败）
      s.runOne();
      await flushMicrotasks();

      const res = await handle.done();
      expect(res.error).toBe('节点执行失败');
      const finished = events[events.length - 1];
      expect(finished.type).toBe('run-finished');
      if (finished.type === 'run-finished') {
        expect(finished.reason).toBe('节点执行失败');
        expect(finished.failedNodeId).toBe('a');
      }
      // b / c 从未成功
      const anySuccess = events.some(
        (e) => e.type === 'node-status-changed' && e.status === NS.SUCCESS,
      );
      expect(anySuccess).toBe(false);
    });
  });

  describe('取消', () => {
    it('运行期间 cancel() → 立即 run-finished(reason=已取消)，且 pending scheduler 被 clear', async () => {
      const s = makeManualScheduler();
      const svc = new MockExecutionService({ scheduler: s.scheduler, successRate: 1 });
      const { snapshot } = chainFixture();
      const events: ExecutionEvent[] = [];
      const handle = svc.start(snapshot, (e) => events.push(e));
      await flushMicrotasks();

      expect(handle.running).toBe(true);
      handle.cancel();
      expect(handle.running).toBe(false);
      handle.cancel(); // 幂等

      const res = await handle.done();
      expect(res.error).toBe('已取消');
      const finished = events[events.length - 1];
      expect(finished.type).toBe('run-finished');

      // 再手动 tick：无新增事件，scheduler 已被 clear
      const countBefore = events.length;
      expect(s.wasCleared()).toBe(true);
      s.runOne();
      await flushMicrotasks();
      expect(events.length).toBe(countBefore);
    });
  });

  describe('并发行为（Service 自身允许多 start）', () => {
    it('两次 start 得到两个独立句柄，可分别取消', async () => {
      const s = makeManualScheduler();
      const svc = new MockExecutionService({ scheduler: s.scheduler, successRate: 1 });
      const { snapshot } = chainFixture();
      const h1 = svc.start(snapshot, () => {});
      const h2 = svc.start(snapshot, () => {});
      await flushMicrotasks();
      expect(h1.running).toBe(true);
      expect(h2.running).toBe(true);
      h1.cancel();
      expect(h1.running).toBe(false);
      expect(h2.running).toBe(true);
      h2.cancel();
      expect(h2.running).toBe(false);
    });
  });

  describe('nextDelay 边界', () => {
    it('delayRangeMs 反序会被自动归一化，rng=1 时返回 max', () => {
      const s = makeManualScheduler();
      const svc = new MockExecutionService({
        scheduler: s.scheduler,
        delayRangeMs: [1500, 800], // 反序
        successRate: 1,
        rng: () => 1,
      });
      const { snapshot } = chainFixture();
      svc.start(snapshot, () => {});
      // 归一化后 min=800 max=1500，rng=1 → 1500
      expect(s.getMs()).toBe(1500);
    });

    it('rng=0 时返回 min', () => {
      const s = makeManualScheduler();
      const svc = new MockExecutionService({
        scheduler: s.scheduler,
        delayRangeMs: [10, 20],
        successRate: 1,
        rng: () => 0,
      });
      const { snapshot } = chainFixture();
      svc.start(snapshot, () => {});
      expect(s.getMs()).toBe(10);
    });
  });
});
