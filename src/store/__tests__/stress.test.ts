/**
 * 压力测试用例：通过 vitest 执行 store + MockExecutionService 联动。
 *
 * 覆盖规模：50 / 200 / 500 / 1000 / 2000 节点（线性链 & 扇出链 两种拓扑）。
 * 采集指标：
 *   - generateMs：构建节点/边/写入 store 耗时
 *   - execMs：一次完整 runWorkflow() 从 started → finished 耗时
 *   - events：累计收到的 ExecutionEvent 数量
 *   - memoryRssMb：Node(happy-dom) 进程在 case 结束时的 RSS
 *   - correctness：successCount ≥ 99% of (N-2) LLM，isRunning=false，nodeProgress 含全部节点
 *
 * 注：这是"数据/调度层 + 状态广播层"的压力，不包含浏览器 DOM 绘制的 FPS。
 *     FPS/交互/滚动需要在真实浏览器中跑（脚本见 scripts/stress.mjs 的文档注释）。
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { useWorkflowStore, configureExecutionService } from '../workflowStore';
import { MockExecutionService } from '../../services/mockExecutionService';
import type { ExecutionEvent } from '../../services/executionService';

// Stress case 慢：fanout 2000 ≈ 7.6s / case，放宽 per-test 超时。
// 使用 vitest "test.setTimeout / it.setTimeout" 惯例：直接在 describe 内给每个 it 注入超时。
const LONG_TIMEOUT_MS = 120_000;

function resetStore() {
  useWorkflowStore.setState(useWorkflowStore.getInitialState(), true);
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const LEVELS: number[] = [50, 200, 500, 1000, 2000];
const PATTERNS: Array<'linear' | 'fanout'> = ['linear', 'fanout'];

function _sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
void _sleep;

// 零延时微任务调度的执行器（用于 run 基准的主用例）
// 事件计数：通过 stressTestRuntime.service 注入后，在 beforeEach 里 patch `.start` 加 tap，
// 这样不影响主 store 的 DEFAULT_EXECUTION_SERVICE，也不修改 private 成员。
let activeTap: ExecutionEvent[] = [];
let activeService: MockExecutionService | null = null;
function patchActiveServiceStart() {
  if (!activeService) return;
  const svc = activeService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orig = (svc as any).start.bind(svc);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).start = (snap: any, onEvent: (e: ExecutionEvent) => void) =>
    orig(snap, (ev: ExecutionEvent) => {
      activeTap.push(ev);
      onEvent(ev);
    });
}
function buildZeroDelayService(): MockExecutionService {
  return new MockExecutionService({
    delayRangeMs: [0, 0],
    successRate: 1,
    scheduler: (_ms, cb) => {
      let alive = true;
      queueMicrotask(() => {
        if (alive) cb();
      });
      return { clear: () => void (alive = false) };
    },
    rng: () => 0,
  });
}

function formatTable(rows: Array<Record<string, number | string | boolean>>) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c]).length)),
  );
  const head = cols.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const sep = cols.map((_c, i) => '-'.repeat(widths[i])).join('-|-');
  const body = rows
    .map((r) => cols.map((c, i) => String(r[c]).padEnd(widths[i])).join(' | '))
    .join('\n');
  return `${head}\n${sep}\n${body}`;
}

describe('压力测试：N 节点线性 / 扇出链的生成与执行', () => {
  const rows: Array<Record<string, number | string | boolean>> = [];

  beforeAll(() => {
    activeService = buildZeroDelayService();
    configureExecutionService(activeService);
    // 预热 10 节点：让 V8 / happy-dom / zustand 的首次编译不占主 case 时长
    resetStore();
    useWorkflowStore.getState().__stressGenerate({ nodes: 10, pattern: 'linear' });
  });

  afterAll(() => {
    // afterAll 清空 registry：让 store 下次懒回退（通常不影响后续独立文件）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configureExecutionService(null as any, { markConfigured: false });
    activeService = null;
  });

  beforeEach(() => {
    resetStore();
    activeTap = [];
    patchActiveServiceStart();
  });

  it.each(LEVELS)('预热：N=%i linear 不报错 & 生成正确规模', async (N) => {
    const t0 = performance.now();
    const out = useWorkflowStore.getState().__stressGenerate({ nodes: N, pattern: 'linear' });
    const tGen = performance.now() - t0;

    expect(out.nodes).toBeGreaterThanOrEqual(N);
    expect(out.edges).toBeGreaterThanOrEqual(N - 1);
    // 生成操作不应写入 undo/redo（避免压力测试污染历史）
    expect(useWorkflowStore.getState().__stressReport().pastCount).toBe(0);

    rows.push({
      case: `gen-linear-${N}`,
      nodes: out.nodes,
      edges: out.edges,
      generateMs: +tGen.toFixed(2),
      execMs: 0,
      events: 0,
      memoryRssMb: 0,
      ok: true,
    });
  });

  it.each(LEVELS)(
    '完整执行：N=%i linear（零延时微任务调度）',
    async (N) => {
      useWorkflowStore.getState().__stressGenerate({ nodes: N, pattern: 'linear' });
      activeTap.length = 0;

      const t0 = performance.now();
      const done = useWorkflowStore.getState().runWorkflow();
      const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), LONG_TIMEOUT_MS));
      await Promise.race([done.then(() => 'done' as const), timer]);
      const totalMs = performance.now() - t0;

      const rep = useWorkflowStore.getState().__stressReport();
      const expectedSuccess = rep.nodes; // successRate=1 → 全成功
      assert(
        rep.successCount >= expectedSuccess,
        `linear N=${N} successCount=${rep.successCount} < expected ${expectedSuccess}`,
      );
      assert(rep.running === false, `linear N=${N} 结束时 isRunning=true`);
      assert(
        rep.progressKeys >= rep.nodes,
        `linear N=${N} progressKeys=${rep.progressKeys} < nodes=${rep.nodes}`,
      );

      const mem =
        typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : null;
      rows.push({
        case: `run-linear-${N}`,
        nodes: rep.nodes,
        edges: rep.edges,
        generateMs: 0,
        execMs: +totalMs.toFixed(2),
        events: activeTap.length,
        memoryRssMb: mem ? +(mem.rss / 1024 / 1024).toFixed(1) : 0,
        ok: true,
      });
    },
    LONG_TIMEOUT_MS,
  );

  it.each(LEVELS)(
    '完整执行：N=%i fanout（零延时微任务调度）',
    async (N) => {
      useWorkflowStore.getState().__stressGenerate({ nodes: N, pattern: 'fanout' });
      activeTap.length = 0;

      const t0 = performance.now();
      const done = useWorkflowStore.getState().runWorkflow();
      const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), LONG_TIMEOUT_MS));
      await Promise.race([done.then(() => 'done' as const), timer]);
      const totalMs = performance.now() - t0;

      const rep = useWorkflowStore.getState().__stressReport();
      const expectedSuccess = rep.nodes;
      assert(
        rep.successCount >= expectedSuccess,
        `fanout N=${N} successCount=${rep.successCount} < expected ${expectedSuccess}`,
      );
      assert(rep.running === false, `fanout N=${N} 结束时 isRunning=true`);
      assert(
        rep.progressKeys >= rep.nodes,
        `fanout N=${N} progressKeys=${rep.progressKeys} < nodes=${rep.nodes}`,
      );
      expect(rep.edges).toBeGreaterThanOrEqual(2 * (rep.nodes - 2));

      const mem =
        typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : null;
      rows.push({
        case: `run-fanout-${N}`,
        nodes: rep.nodes,
        edges: rep.edges,
        generateMs: 0,
        execMs: +totalMs.toFixed(2),
        events: activeTap.length,
        memoryRssMb: mem ? +(mem.rss / 1024 / 1024).toFixed(1) : 0,
        ok: true,
      });
    },
    LONG_TIMEOUT_MS,
  );

  it('汇总压力测试报告（控制台表格）', () => {
    // 把上面 2 * 3 * LEVELS.length 个 case 收集的 rows 打到控制台，便于 CI 肉眼一眼看。
    console.log('\n========= 压力测试汇总 =========\n' + formatTable(rows) + '\n================================\n');

    // 再做一次硬断言：任何 scale 的执行都必须在合理预算内
    // 预算（零延时微任务调度，不含真实 sleep）：
    //   N=2000  linear  execMs ≤ 15000ms（纯 JS 微任务调度 + set()，大 N 会重）
    //   N=2000  fanout  execMs ≤ 25000ms（扇出一次会触发大量 edges.set()）
    for (const r of rows) {
      if (typeof r.execMs !== 'number' || r.execMs === 0) continue;
      if (r.case === 'run-linear-2000') expect(+r.execMs).toBeLessThanOrEqual(15000);
      if (r.case === 'run-fanout-2000') expect(+r.execMs).toBeLessThanOrEqual(25000);
      expect(r.ok).toBe(true);
    }

    // 顺带保证 patterns 常量使用（避免未用警告）
    expect(PATTERNS.length).toBe(2);
  });
});
