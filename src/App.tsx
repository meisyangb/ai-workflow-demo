import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import FlowCanvas from './components/FlowCanvas';
import ConfigPanel from './components/ConfigPanel';
import './index.css';

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
        <div
          style={{
            width: '100vw',
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: '#f5f7fa',
          }}
        >
          <Toolbar />
          <div
            style={{
              flex: 1,
              display: 'flex',
              minHeight: 0,
            }}
          >
            <Sidebar />
            <FlowCanvas />
            <ConfigPanel />
          </div>
        </div>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
