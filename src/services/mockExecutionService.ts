/**
 * MockExecutionService —— 纯前端 Mock 运行实现
 *
 * 把原 workflowStore.runWorkflow() 的逻辑迁移到这里：
 * - 拓扑排序得到执行顺序
 * - 按顺序切换节点状态：RUNNING → (延时 0.8~1.5s) → SUCCESS(85%) / FAILED(15%)
 * - 每成功一个节点 → 激活其出边动画
 * - 遇到失败停止后续；遇到 cancel() 立即收尾并发 RunFinished(reason='cancelled')
 *
 * 所有副作用通过 setTimeout + 外部 cancel() 控制，可测、可复用。
 */

import { topologicalSort } from '../domains/workflow';
import { NodeStatus as NS, type NodeStatus } from '../domains/workflow';
import type {
  ExecutionEvent,
  ExecutionService,
  RunHandle,
  WorkflowSnapshot,
} from './executionService';

export interface MockExecutionServiceOptions {
  /** 随机延时范围（毫秒）[min, max]；默认 [800, 1500] */
  delayRangeMs?: [number, number];
  /** 节点成功率（0~1）；默认 0.85 */
  successRate?: number;
  /**
   * 延时器实现（依赖注入，便于单测注入可控时钟）
   */
  scheduler?: (ms: number, onTick: () => void) => { clear: () => void };
  /** 随机数实现（依赖注入，便于单测固定 seed）；默认 Math.random */
  rng?: () => number;
}

type SchedulerToken = { clear: () => void };

export class MockExecutionService implements ExecutionService {
  readonly name = 'mock';

  private readonly delayMin: number;
  private readonly delayMax: number;
  private readonly successRate: number;
  private readonly scheduler: (ms: number, onTick: () => void) => SchedulerToken;
  private readonly rng: () => number;

  constructor(options: MockExecutionServiceOptions = {}) {
    const [dMin, dMax] = options.delayRangeMs ?? [800, 1500];
    this.delayMin = Math.max(0, Math.min(dMin, dMax));
    this.delayMax = Math.max(0, Math.max(dMin, dMax));
    this.successRate = Math.max(0, Math.min(1, options.successRate ?? 0.85));
    this.scheduler = options.scheduler ?? ((ms, cb) => {
      const id = setTimeout(cb, ms);
      return { clear: () => clearTimeout(id) };
    });
    this.rng = options.rng ?? (() => Math.random());
  }

  start(snapshot: WorkflowSnapshot, onEvent: (event: ExecutionEvent) => void): RunHandle {
    // ===== 生命周期状态 =====
    let cancelled = false;
    let running = true;
    let pendingToken: SchedulerToken | null = null;
    let doneResolve!: (result: { error: string | null }) => void;
    const donePromise = new Promise<{ error: string | null }>((res) => {
      doneResolve = res;
    });

    // 在 start 作用域内缓存 this 的成员，避免 this 别名 lint 错误；
    // 同时避免 IIFE 中每次 await 后再读 this 的不确定影响
    const { scheduler, rng, successRate } = this;
    const nextDelay = (): number => this.nextDelay(); // 直接调用 getter，不别名 this

    // ===== 工具 =====
    const finish = (reason: string | null, failedNodeId?: string) => {
      if (!running) return;
      running = false;
      if (pendingToken) {
        pendingToken.clear();
        pendingToken = null;
      }
      onEvent({
        type: 'run-finished',
        reason,
        ...(failedNodeId ? { failedNodeId } : {}),
      });
      doneResolve({ error: reason });
    };

    const emitStatus = (nodeId: string, status: NodeStatus, output?: unknown) => {
      onEvent({ type: 'node-status-changed', nodeId, status, output });
    };

    const wait = (ms: number): Promise<boolean> =>
      new Promise((resolve) => {
        pendingToken = scheduler(ms, () => {
          pendingToken = null;
          resolve(!cancelled);
        });
      });

    // ===== 前置校验 =====
    if (snapshot.nodes.length === 0) {
      queueMicrotask(() => finish('画布为空，请先添加节点'));
      return buildHandle();
    }
    const { hasCycle, order } = topologicalSort(snapshot.nodes, snapshot.edges);
    if (hasCycle) {
      queueMicrotask(() => finish('检测到环路，无法执行工作流'));
      return buildHandle();
    }

    // ===== 主循环 =====
    queueMicrotask(() => onEvent({ type: 'run-started', order }));
    void (async () => {
      for (const n of snapshot.nodes) emitStatus(n.id, NS.IDLE);
      for (const nodeId of order) {
        if (cancelled) return;
        emitStatus(nodeId, NS.RUNNING);
        const ok = await wait(nextDelay());
        if (!ok || cancelled) return;
        const success = rng() < successRate;
        emitStatus(nodeId, success ? NS.SUCCESS : NS.FAILED);
        if (success) onEvent({ type: 'node-edges-activated', sourceNodeId: nodeId });
        if (!success) { finish('节点执行失败', nodeId); return; }
      }
      finish(null);
    })();

    function buildHandle(): RunHandle {
      return {
        get running() {
          return running;
        },
        cancel() {
          if (!running) return;
          cancelled = true;
          finish('已取消');
        },
        done() {
          return donePromise;
        },
      };
    }
    return buildHandle();
  }

  private nextDelay(): number {
    const [min, max] = [this.delayMin, this.delayMax];
    if (min === max) return min;
    // 范围 size = max - min（不含最大值边界），再加上 min；
    // 当 rng() 刚好等于 1（理论边界）时，返回 max（闭区间）
    const size = max - min;
    return Math.min(max, Math.floor(min + this.rng() * (size + 1)));
  }
}
