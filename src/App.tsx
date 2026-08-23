import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Suspense, lazy } from 'react';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import FlowCanvas from './components/FlowCanvas';
import ConfigPanel from './components/ConfigPanel';
import './index.css';

// 桌面端专属 UI 用 React.lazy 切独立 chunk，配合 @tauri-apps 动态 import，
// 确保 Vercel 构建的首屏 entry chunks 里永不包含 Tauri 桌面端代码字符串。
const DesktopTitlebar = lazy(
  () =>
    import(
      /* webpackChunkName: "desktop-titlebar" */
      './components/DesktopTitlebar'
    ),
);

function App() {
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
            <Suspense fallback={null}>
              <DesktopTitlebar />
            </Suspense>
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
