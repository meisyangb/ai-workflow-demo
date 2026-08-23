import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect } from 'react';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import FlowCanvas from './components/FlowCanvas';
import ConfigPanel from './components/ConfigPanel';
import { useWorkflowStore } from './store/workflowStore';
import './index.css';

// 只在开发/本地时暴露 window 级压力测试 CLI 钩子，
// 便于在真实浏览器里手测「生成 N 节点 → 运行 → FPS / DOM 绘制成本」。
type StressPattern = 'linear' | 'fanout';
interface StressRunReport {
  nodes: number;
  edges: number;
  execMs: number;
  pollIterations: number;
  storeReport: ReturnType<ReturnType<(typeof useWorkflowStore)['getState']>['__stressReport']>;
  fps?: { mean: number; min5: number; droppedFrames: number };
}

function installStressGlobals() {
  const has =
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    !(window as unknown as { __stressInstalled?: boolean }).__stressInstalled;
  if (!has) return;
  const w = window as unknown as {
    __stressInstalled: boolean;
    __stressGenerate: (
      pattern?: StressPattern,
      nodes?: number,
      perCol?: number,
    ) => { nodes: number; edges: number };
    __stressRun: (timeoutMs?: number) => Promise<StressRunReport>;
    __stressReport: () => unknown;
  };
  w.__stressInstalled = true;

  w.__stressGenerate = (pattern = 'linear', nodes = 500, perCol = 20) =>
    useWorkflowStore.getState().__stressGenerate({ nodes, pattern, perCol });

  w.__stressRun = async (timeoutMs = 300_000) => {
    // FPS 采样：rAF 计数 + 帧间隔判定丢帧
    let rafId = 0;
    let stopFps = false;
    const frameTimes: number[] = [];
    let lastTs = performance.now();
    const loop = (t: number) => {
      if (stopFps) return;
      const dt = t - lastTs;
      lastTs = t;
      frameTimes.push(dt);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    const t0 = performance.now();
    useWorkflowStore.getState().runWorkflow();
    const deadline = t0 + timeoutMs;
    let polls = 0;
    while (useWorkflowStore.getState().isRunning && performance.now() < deadline) {
      polls += 1;
      await new Promise<void>((r) => setTimeout(r, 8));
    }
    const totalMs = performance.now() - t0;
    stopFps = true;
    cancelAnimationFrame(rafId);

    const fps: StressRunReport['fps'] = (() => {
      if (frameTimes.length < 2) return undefined;
      const meanDt = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const p5 = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
      const mean = 1000 / Math.max(0.0001, meanDt);
      const min5 = 1000 / Math.max(0.0001, p5);
      // 丢帧数：每帧若 dt > 24ms 就算"丢失一帧的一半以上"，累计 diff / 16.67
      let dropped = 0;
      for (const dt of frameTimes) if (dt > 22) dropped += Math.ceil(dt / 16.67) - 1;
      return {
        mean: +mean.toFixed(2),
        min5: +min5.toFixed(2),
        droppedFrames: dropped,
      };
    })();

    return {
      nodes: useWorkflowStore.getState().nodes.length,
      edges: useWorkflowStore.getState().edges.length,
      execMs: +totalMs.toFixed(2),
      pollIterations: polls,
      storeReport: useWorkflowStore.getState().__stressReport(),
      fps,
    };
  };

  w.__stressReport = () => useWorkflowStore.getState().__stressReport();
}

function App() {
  useEffect(() => {
    if (import.meta.env.DEV || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      installStressGlobals();
    }
  }, []);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 6,
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
        },
      }}
    >
      {/* AntApp 给 message/modal 提供上下文 */}
      <AntApp>
        <div className="app-shell">
          <div className="app-window">
            <div className="app-body">
              <Toolbar />
              <div className="app-main">
                <Sidebar />
                <FlowCanvas />
                <ConfigPanel />
              </div>
            </div>
          </div>
        </div>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
