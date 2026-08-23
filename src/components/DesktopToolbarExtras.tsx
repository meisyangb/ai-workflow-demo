/**
 * Toolbar 上的桌面端独有小组件：原生对话框演示按钮组。
 * 桌面 Badge 已移到自定义标题栏（DesktopTitlebar）以节省 Toolbar 水平空间。
 *
 * 隔离约束（与 spec Task 5 保持一致）：
 *  - 本组件**不静态 import @tauri-apps**；
 *  - 在 Web 环境下 detectRuntime().tauri === false → 组件直接返回 null（0 DOM 输出）；
 *  - 只有桌面环境才真实 await resolveBridge() 并显示按钮组。
 */
import { useEffect, useState } from 'react';
import { Button, Space, Tooltip, message } from 'antd';
import { FileTextOutlined, SaveOutlined, ExportOutlined, GlobalOutlined } from '@ant-design/icons';
import { detectRuntime } from '../services/runtimeEnv';
import { resolveBridge, type NativeBridge } from '../services/nativeBridge';
import { useWorkflowStore } from '../store/workflowStore';

export default function DesktopToolbarExtras() {
  const env = detectRuntime();
  const [bridge, setBridge] = useState<NativeBridge | null>(null);
  const [msg, msgCtx] = message.useMessage();

  const exportFlow = useWorkflowStore((s) => s.exportFlow);
  const importFlow = useWorkflowStore((s) => s.importFlow);

  // 桌面端首次挂载时异步 resolve 真正的 NativeBridge；Web 端不进分支。
  useEffect(() => {
    if (!env.tauri) return;
    let cancelled = false;
    resolveBridge().then((b) => {
      if (!cancelled) setBridge(b);
    });
    return () => {
      cancelled = true;
    };
  }, [env.tauri]);

  if (!env.tauri) {
    // Web 模式：不渲染任何节点（不占用 React 树）。
    return null;
  }

  const onPickImport = async () => {
    if (!bridge) return;
    const f = await bridge.pickJsonFile();
    if (!f) return;
    const res = importFlow(f.content);
    if (res.error) msg.error(res.error);
    else msg.success(`已从本地文件导入：${f.name}`);
  };

  const onSaveExport = async () => {
    if (!bridge) return;
    const name = `workflow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const content = exportFlow();
    const ok = await bridge.saveJsonFile(name, content);
    if (ok) msg.success(`已保存到：${name}`);
    else msg.warning('保存取消或失败');
  };

  const onOpenDocs = async () => {
    if (!bridge) return;
    await bridge.openExternal('https://github.com/meisyangb/ai-workflow-demo/blob/main/README.md');
  };

  return (
    <>
      {msgCtx}
      <Space size="small" data-testid="desktop-toolbar-extras">
        <Tooltip title="原生对话框：从本地磁盘 .json 导入工作流">
          <Button
            size="small"
            icon={<FileTextOutlined />}
            onClick={onPickImport}
            data-testid="desktop-btn-import"
            disabled={!bridge}
          >
            原生导入
          </Button>
        </Tooltip>
        <Tooltip title="原生对话框：导出工作流到本地磁盘">
          <Button
            size="small"
            icon={<SaveOutlined />}
            onClick={onSaveExport}
            data-testid="desktop-btn-export"
            disabled={!bridge}
          >
            原生导出
          </Button>
        </Tooltip>
        <Tooltip title="用系统默认浏览器打开项目 README">
          <Button
            size="small"
            icon={<GlobalOutlined />}
            onClick={onOpenDocs}
            data-testid="desktop-btn-docs"
            disabled={!bridge}
          >
            <ExportOutlined /> 文档
          </Button>
        </Tooltip>
      </Space>
    </>
  );
}
