/**
 * scripts/stress.mjs —— 仓库层面的「压力测试 CLI」（不依赖 vitest 环境）。
 *
 * 用法：
 *   # 1. 执行层（store + MockExecutionService）压力（纯内存，无 DOM）
 *   node scripts/stress.mjs data --sizes 50,200,500,1000,2000 --patterns linear,fanout
 *
 *   # 2. 只看生成耗时（不执行 workflow）：快速测 O(N) 构造能力
 *   node scripts/stress.mjs generate --sizes 1000,2000,4000
 *
 *   # 3. 10 轮随机规模（模拟 CI 的 soak test）
 *   node scripts/stress.mjs soak --rounds 10
 *
 * 脚本直接走 Node + ES 入口绕过 Vite，使用 'zx' 风格的原生 ESM；
 * 由于 .ts store / services 需要被转译，本脚本只做"参数 + 结果打印"，真实执行
 * 统一走 `npm run test -- src/store/__tests__/stress.test.ts`（vitest happy-dom
 * 已包含 TS 即时编译 + zustand/react 等 deps 的运行时）。
 *
 * 如果你需要 **真实浏览器的 FPS / 交互拖动 / 首帧**：
 *   1) npm run dev
 *   2) 浏览器控制台执行：
 *        // 生成 1000 节点线性链
 *        window.__stressGenerate('linear', 1000);
 *        // 运行并等待结束
 *        window.__stressRun();
 *        // 获得报告 {nodes, edges, execMs, eventsCount, memoryRssMb...}
 *        window.__stressReport();
 *      这些 window 钩子在 App.tsx 里有暴露（仅 DEV）。
 */

import { spawnSync } from 'node:child_process';
import { argv, stdout, stderr, memoryUsage, hrtime } from 'node:process';
import { performance } from 'node:perf_hooks';

function usage() {
  stdout.write(
    [
      'Usage: node scripts/stress.mjs <command> [options]',
      '',
      'Commands:',
      '  data        运行 vitest stress.test.ts 的生成+执行压力（主入口）',
      '  generate    只跑生成规模基准（跳过 runWorkflow，测 4000/8000 节点构造开销）',
      '  soak        10 轮随机规模 soak test（线性+扇出交替）',
      '',
      'Options:',
      '  --sizes a,b,c         节点数列表，默认 50,200,500,1000,2000',
      '  --patterns a,b        linear / fanout 逗号分隔，默认两者均跑',
      '  --rounds N            soak 模式的轮数，默认 10',
      '',
    ].join('\n'),
  );
}

function parseKV(list, key) {
  const i = list.indexOf(key);
  if (i === -1 || i === list.length - 1) return null;
  return list[i + 1];
}

function main() {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    usage();
    return;
  }
  const cmd = args[0];

  const sizesRaw = parseKV(args, '--sizes') ?? '50,200,500,1000,2000';
  const patternsRaw = parseKV(args, '--patterns') ?? 'linear,fanout';
  const rounds = Math.max(1, Number(parseKV(args, '--rounds') ?? '10'));

  const sizes = sizesRaw.split(',').map((s) => Math.max(3, Number(s.trim())));
  const patterns = patternsRaw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p === 'linear' || p === 'fanout');

  const env = { ...process.env };

  if (cmd === 'data' || cmd === 'generate' || cmd === 'soak') {
    stdout.write(`[stress] command=${cmd} sizes=${sizes.join(',')} patterns=${patterns.join(',')} rounds=${rounds}\n`);
    const t0 = performance.now();

    const extraVitestArgs = [];
    if (cmd === 'generate') {
      // 生成基准只跑 .test 里的 "预热：N=X linear"（用例名 prefix 一致）
      extraVitestArgs.push('-t', '预热*');
    } else if (cmd === 'soak') {
      // soak：使用 sizes 随机，rounds 轮；通过 STRESS_* 环境变量让 stress.test.ts 切换？
      // 为保持简单：我们把 rounds × 随机 size 直接映射成一个 vitest 调用：
      // 设置 STRESS_SOAK=true + STRESS_SIZES + STRESS_ROUNDS
      env.STRESS_SOAK = '1';
      env.STRESS_ROUNDS = String(rounds);
      env.STRESS_SIZES = sizes.join(',');
      env.STRESS_PATTERNS = patterns.join(',');
    }

    // 触发 vitest 里的 stress.test.ts；若用户只想 generate，上面加了 -t 过滤。
    const vitest = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', 'src/store/__tests__/stress.test.ts', ...extraVitestArgs],
      {
        cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)\//, '$1/'),
        stdio: 'inherit',
        env,
        shell: process.platform === 'win32',
      },
    );

    const totalMs = performance.now() - t0;
    const mem = memoryUsage ? memoryUsage() : null;
    stdout.write(
      `[stress] finished in ${(totalMs / 1000).toFixed(2)}s; exitCode=${vitest.status ?? -1}; rss=${
        mem ? `${(mem.rss / 1024 / 1024).toFixed(1)} MB` : 'N/A'
      }\n`,
    );

    // 用 stderr 输出机器可解析的尾部 JSON（便于 CI 取数）；不污染 stdout 表格。
    stderr.write(
      `\nSTRESS_RESULT=${JSON.stringify({
        command: cmd,
        sizes,
        patterns,
        rounds,
        totalMs: +totalMs.toFixed(2),
        rssMb: mem ? +(mem.rss / 1024 / 1024).toFixed(1) : null,
        exitCode: vitest.status,
      })}\n`,
    );

    if (vitest.status !== 0) process.exit(vitest.status ?? 1);
    return;
  }

  usage();
  process.exit(1);
}

void hrtime; // 避免未用
main();
