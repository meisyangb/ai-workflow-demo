/**
 * MockExecutionService —— 纯前端 Mock 运行实现
 *
 * 基于「就绪队列 + 拓扑」驱动：
 * - 入度为 0 的节点先入 readyQ，依次执行
 * - 节点 SUCCESS 后：
 *    - 普通节点：所有出边激活，下游 target 剩余入度 -1，归零即入队
 *    - CONDITION 节点：真 eval expression，只激活 true/false 其中一条出边，另一条跳过
 *    - SELECTOR / INTENT：先走第一条分支（简化 mock），后续可接入真实决策
 * - 节点 FAILED：停止一切调度，直接结束
 * - 分支不命中的节点永远保持 IDLE（相当于未执行，UI 无颜色）
 */

import { topologicalSort, NodeType, type WorkflowNode } from '../domains/workflow';
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
    let lastRunId: string | null = null;
    let lastExecuteId: string | null = null;
    let doneResolve!: (result: { error: string | null; outputs?: Record<string, unknown> }) => void;
    const donePromise = new Promise<{ error: string | null; outputs?: Record<string, unknown> }>((res) => {
      doneResolve = res;
    });
    /** v0.4.1：resume 输入的队列（单次中断恢复通常只有 1 条，数组是为了并发排队） */
    const resumeQueue: Array<{ payload: unknown; resolve: () => void; reject: (err: Error) => void }> = [];
    const waitResume = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        // 监听一次 resume 入队即可
        const poll = () => {
          if (!running) {
            reject(new Error('运行已停止，无法等待 resume'));
            return;
          }
          const item = resumeQueue.shift();
          if (item) {
            item.resolve();
            resolve(item.payload);
            return;
          }
          pendingToken = scheduler(50, poll);
        };
        poll();
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

    const emitStatus = (
      nodeId: string,
      status: NodeStatus,
      output?: unknown,
      extra?: { durationMs?: number; errorMessage?: string; activatedEdgeIds?: string[] },
    ) => {
      onEvent({
        type: 'node-status-changed',
        nodeId,
        status,
        output,
        durationMs: extra?.durationMs,
        errorMessage: extra?.errorMessage,
        activatedEdgeIds: extra?.activatedEdgeIds,
      });
    };

    const wait = (ms: number): Promise<boolean> =>
      new Promise((resolve) => {
        pendingToken = scheduler(ms, () => {
          pendingToken = null;
          resolve(!cancelled);
        });
      });

    // ===== 工具（执行期辅助） =====
    const nodeById = new Map<string, WorkflowNode>(snapshot.nodes.map((n) => [n.id, n]));
    const outEdgesOf = (sourceId: string) => snapshot.edges.filter((e) => e.source === sourceId);
    const inEdgesOf = (targetId: string) => snapshot.edges.filter((e) => e.target === targetId);

    /** nodeId → 该节点成功时的 debugOutput；为下游 eval expression 提供上下文 */
    const debugByNode: Record<string, unknown> = {};

    /**
     * 把 nodeId 所有上游（按拓扑 order 之前的节点）的 debugOutput 合并成一个 ctx：
     * - 顶层合并所有字段（后写覆盖前写，语义 = 最近上游优先）
     * - 同时提供 `n_xxx.xxx` 节点前缀访问，避免 key 冲突
     * - 兜底 `$input` = 第一个 START/全局输入的 debugOutput
     */
    const buildCtx = (nodeId: string): Record<string, unknown> => {
      const idxSelf = order.indexOf(nodeId);
      const ctx: Record<string, unknown> = {};
      // 按拓扑序合并，越靠后的上游越后写 → 优先级高
      order.forEach((id, i) => {
        if (i >= idxSelf) return;
        const out = debugByNode[id];
        if (out && typeof out === 'object') {
          Object.assign(ctx, out);
          ctx[id] = out;
        }
      });
      const startNodes = snapshot.nodes.filter(
        (n) => n.type === NodeType.START && debugByNode[n.id],
      );
      ctx['$input'] = startNodes[0] ? debugByNode[startNodes[0].id] : null;
      return ctx;
    };

    /** 安全 eval 任意布尔表达式（默认 false + 异常不抛） */
    const evalBool = (expression: string, ctx: Record<string, unknown>): { value: boolean; error?: string } => {
      if (!expression || typeof expression !== 'string') return { value: false };
      try {
        // 不用 with(ctx)：严格模式下 with 被禁用，改为把 ctx 的 key 全作为参数传入 new Function，
        // 这样 expression 内可以直接写 result / keywords 等短名，也能写 n_llm_1.result 的完整前缀
        const ctxClean = ctx ?? {};
        const keys = Object.keys(ctxClean);
        const values = keys.map((k) => ctxClean[k]);
        const fn = new Function(...keys, `return (${expression});`);
        const v = fn(...values);
        return { value: !!v };
      } catch (e) {
        return { value: false, error: e instanceof Error ? e.message : String(e) };
      }
    };

    /** 根据节点类型算出：成功后哪些 sourceHandle 应当激活（分支命中） */
    const getMatchedHandles = (nodeId: string, ctx: Record<string, unknown>): { handles: string[]; exprErr?: string } => {
      const node = nodeById.get(nodeId);
      if (!node) return { handles: ['__all__'] };
      switch (node.type) {
        case NodeType.CONDITION: {
          const expr: string = (node.data as { expression?: string }).expression ?? 'false';
          const { value, error } = evalBool(expr, ctx);
          return { handles: [value ? 'true' : 'false'], exprErr: error };
        }
        case NodeType.SELECTOR: {
          // mock：按 cases.length + hasDefault(+1) 均匀随机；
          // 0..cases.length-1 = 对应 cases[idx]；cases.length = default（若 hasDefault）
          // 注意：之前 Math.min(cases.length-1, idxRaw) 会把"选中 default 的那一份概率"硬塞回最后一个 case，default 永远走不到
          const data = node.data as { cases?: { label: string; value: string }[]; hasDefault?: boolean };
          const cases = data.cases ?? [];
          const slots = cases.length + (data.hasDefault ? 1 : 0);
          if (slots <= 0) return { handles: [] };
          const idxRaw = Math.floor(rng() * slots);
          if (idxRaw < cases.length) return { handles: [String(idxRaw)] };
          // idxRaw === cases.length：落到 default 槽
          return data.hasDefault ? { handles: ['default'] } : { handles: [] };
        }
        case NodeType.INTENT: {
          const data = node.data as { intents?: { label: string }[] };
          const intents = data.intents ?? [];
          if (intents.length === 0) return { handles: ['default'] };
          const idx = Math.floor(rng() * intents.length);
          return { handles: [String(idx)] };
        }
        default:
          return { handles: ['__all__'] };
      }
    };

    /** LLM/CODE 节点生成带语义的 debugOutput（尤其给 LLM 加 keywords 数组，供 CONDITION expression 引用） */
    const buildSuccessOutput = (nodeId: string): unknown => {
      const node = nodeById.get(nodeId);
      if (!node) return { result: `mock output for ${nodeId}` };
      if (node.type === NodeType.LLM) {
        // 随机 keywords 0~5，覆盖 CONDITION "result.keywords.length > 2" 两种分支
        const kwPool = ['RAG', 'WebSearch', 'Agent', '可视化', '鉴权', '定时', '并发', '多模态', '流式', '审计'];
        const nKws = Math.floor(rng() * 6); // 0~5
        const chosen: string[] = [];
        for (let i = 0; i < nKws; i++) chosen.push(kwPool[Math.floor(rng() * kwPool.length)]);
        const question = node.data.label.includes('追问')
          ? `1. 您希望支持哪种接入方式？\n2. 有鉴权/登录需求吗？\n3. 预期并发量大概多少？`
          : `基于需求的结构化分析结果（${chosen.length} 个关键词）已提炼完成`;
        return {
          result: question,
          keywords: Array.from(new Set(chosen)),
          model: (node.data as { model?: string }).model ?? 'mock-model',
          tokens: Math.floor(100 + rng() * 1200),
        };
      }
      if (node.type === NodeType.CODE) {
        return {
          result: `function workflow() {\n  /* mock 代码：根据 ${nodeId} 生成 */\n  return { ok: true };\n}`,
          language: 'javascript',
          lines: 8 + Math.floor(rng() * 20),
        };
      }
      if (node.type === NodeType.START) {
        return {
          input: '请帮我做一个带 RAG 检索和 Agent 的 AI 工作流，并接入多模型能力',
          sessionId: `sess_${Math.floor(rng() * 1e9)}`,
        };
      }
      if (node.type === NodeType.END) {
        return { done: true, finishedAt: Date.now(), from: nodeId };
      }
      return { result: `mock output for ${nodeId}` };
    };

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

    // v0.4.1：生成 runId / executeId（store 会写 lastRunId / lastExecuteId；中断时用作 resume 的凭证）
    lastRunId = `run_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    lastExecuteId = `exe_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

    // ===== 主循环：就绪队列（分支条件下按拓扑顺序+激活出边推进） =====
    queueMicrotask(() => onEvent({ type: 'run-started', order, runId: lastRunId, executeId: lastExecuteId }));
    void (async () => {
      for (const n of snapshot.nodes) emitStatus(n.id, NS.IDLE);

      const FAILURE_REASONS = [
        '上游变量解析失败：引用的字段不存在',
        'LLM API 返回 HTTP 429 Too Many Requests',
        'HTTP 请求超时（超过 15s）',
        'JSON Schema 校验失败：字段 "price" 应为 number 类型',
      ];

      // 入度（所有 edges 统计）= 理论上需要有多少条"激活的入边"达成才能跑
      // 简化实现：每个 target 节点记录入边数量；每当一条激活的入边 ready，计数 -1，到 0 就执行
      const remainingIncoming = new Map<string, number>();
      snapshot.nodes.forEach((n) => remainingIncoming.set(n.id, inEdgesOf(n.id).length));
      const readyQ: string[] = [];
      remainingIncoming.forEach((cnt, id) => {
        if (cnt === 0) readyQ.push(id);
      });

      // 防重复入队
      const processed = new Set<string>();

      while (readyQ.length > 0) {
        if (cancelled) return;
        // 按拓扑 order 排序当前 readyQ，保证展示顺序稳定
        readyQ.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const nodeId = readyQ.shift()!;
        if (processed.has(nodeId)) continue;
        processed.add(nodeId);

        emitStatus(nodeId, NS.RUNNING);
        const startedAt = Date.now();
        const delay = nextDelay();
        const ok = await wait(delay);
        if (!ok || cancelled) return;
        const durationMs = Date.now() - startedAt;
        const success = rng() < successRate;

        if (!success) {
          const errorMessage =
            FAILURE_REASONS[Math.floor(rng() * FAILURE_REASONS.length)];
          emitStatus(nodeId, NS.FAILED, null, { durationMs, errorMessage });
          finish('节点执行失败', nodeId);
          return;
        }

        // v0.4.1：INTENT 节点模拟"追问/确认→中断→用户 resume→继续"，
        // 验证 ExecutionService 新的 interrupt / resume 语义、store 的 pendingInterrupt 与 resumeWorkflow 链路。
        const node = nodeById.get(nodeId);
        if (node?.type === NodeType.INTENT) {
          const intents = (node.data as { intents?: { label: string }[] }).intents ?? [];
          const prompt = {
            title: '需要补充信息',
            description: `为了选择最合适的意图分支（${intents.map((i) => i.label).join(' / ') || '默认分支'}），请回答：`,
            schema: { type: 'object', properties: { answer: { type: 'string', title: '你的回答' } }, required: ['answer'] },
          };
          const runningDuration = Date.now() - startedAt;
          void runningDuration;
          // 先把 RUNNING 时的提示作为 workflow-message 写入调试面板
          onEvent({ type: 'workflow-message', category: 'system', nodeId, runId: lastRunId ?? undefined, content: prompt });
          // 再抛中断（UI 层会根据 pendingInterrupt 弹对话）
          onEvent({
            type: 'workflow-interrupted',
            executeId: lastExecuteId ?? `mock_exe_${nodeId}`,
            runId: lastRunId ?? undefined,
            nodeId,
            interruptType: 'question',
            prompt,
          });
          const answer = await waitResume();
          // resume 成功：把用户回答拼接进 debugOutput
          onEvent({
            type: 'node-output-append',
            nodeId,
            delta: `> 用户回复：${JSON.stringify(answer)}\n`,
            field: 'debugOutput',
          });
          onEvent({ type: 'workflow-message', category: 'log', nodeId, runId: lastRunId ?? undefined, content: answer });
        }

        // SUCCESS：先产出带语义的 debugOutput，再算"激活哪些出边"
        const output = buildSuccessOutput(nodeId);
        debugByNode[nodeId] = output;
        const ctx = buildCtx(nodeId);
        const { handles, exprErr } = getMatchedHandles(nodeId, ctx);
        const matchedEdgesIds = (() => {
          const outEdges = outEdgesOf(nodeId);
          const matched = outEdges.filter(
            (e) => handles.includes('__all__') || handles.includes(String(e.sourceHandle ?? null)),
          );
          return handles.includes('__all__') ? undefined : matched.map((e) => e.id);
        })();
        // CONDITION：若表达式本身抛错，把错误写进 errorMessage 但仍以 SUCCESS（用 fallback false 分支）继续，避免整体卡
        if (exprErr) {
          emitStatus(nodeId, NS.SUCCESS, output, { durationMs, errorMessage: `表达式求值回落为 false：${exprErr}`, activatedEdgeIds: matchedEdgesIds });
        } else {
          emitStatus(nodeId, NS.SUCCESS, output, { durationMs, activatedEdgeIds: matchedEdgesIds });
        }

        const outEdges = outEdgesOf(nodeId);
        const matchedEdges = outEdges.filter(
          (e) => handles.includes('__all__') || handles.includes(String(e.sourceHandle ?? null)),
        );
        // 精确激活命中的出边：命中 → animated=true；兄弟分支（如 CONDITION 的另一分支）→ animated=false
        // 通过 activatedEdgeIds 细粒度传给 store，保证 StatefulEdge 不会两条分支同时流动光点
        onEvent({
          type: 'node-edges-activated',
          sourceNodeId: nodeId,
          activatedEdgeIds:
            handles.includes('__all__') ? undefined : matchedEdges.map((e) => e.id),
        });

        // 每条命中的 edge：给 target 剩余入度 -1；到 0 就入 readyQ
        for (const edge of matchedEdges) {
          const t = edge.target;
          const left = (remainingIncoming.get(t) ?? 0) - 1;
          remainingIncoming.set(t, Math.max(0, left));
          if (left <= 0 && !processed.has(t)) {
            readyQ.push(t);
          }
        }
      }

      finish(null);
    })();

    function buildHandle(): RunHandle {
      return {
        get running() {
          return running;
        },
        get runId() {
          return lastRunId;
        },
        get executeId() {
          return lastExecuteId;
        },
        cancel() {
          if (!running) return;
          cancelled = true;
          finish('已取消');
        },
        done() {
          return donePromise;
        },
        /** v0.4.1 Mock 的 resume：仅当主循环已经卡在某个 waitResume 时才管用 */
        async resume(payload: unknown) {
          return new Promise<void>((resolve, reject) => {
            if (!running) {
              reject(new Error('Mock run 已结束，无法 resume'));
              return;
            }
            resumeQueue.push({ payload, resolve, reject });
          });
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
