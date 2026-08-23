import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyRuntimeDataAttr } from './services/runtimeEnv';
import { MockExecutionService } from './services/mockExecutionService';
import { configureExecutionService } from './store/workflowStore';

// v0.4.0：在装配层（最顶层入口）注入"运行时使用的 ExecutionService 实现"。
// 这一步解除 store 对 MockExecutionService 的硬耦合，将来切换 HTTP/WS 后端时只改这里。
configureExecutionService(new MockExecutionService());

// 在应用启动前就写入 data-runtime，确保首帧 CSS 命中正确分支：
//  - Vercel / 浏览器 → data-runtime="web" → 全屏无 margin
//  - Tauri 桌面     → data-runtime="desktop" → 预留阴影边距
applyRuntimeDataAttr();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
