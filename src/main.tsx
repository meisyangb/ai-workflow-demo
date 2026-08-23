import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyRuntimeDataAttr } from './services/runtimeEnv';

// 在应用启动前就写入 data-runtime，确保首帧 CSS 命中正确分支：
//  - Vercel / 浏览器 → data-runtime="web" → 全屏无 margin
//  - Tauri 桌面     → data-runtime="desktop" → 预留阴影边距
applyRuntimeDataAttr();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
