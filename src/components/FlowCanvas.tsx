import { useCallback, useRef, useMemo, useEffect, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent, CSSProperties } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  BaseEdge,
  getBezierPath,
} from '@xyflow/react';
import type { Connection, DefaultEdgeOptions, Edge, EdgeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Menu,
  MenuProps,
} from 'antd';
import {
  CopyOutlined,
  ScissorOutlined,
  DeleteOutlined,
  ReloadOutlined,
  BugOutlined,
  AppstoreAddOutlined,
  UndoOutlined,
  CompressOutlined,
} from '@ant-design/icons';

import { useWorkflowStore, wouldCreateCycle, NodeType } from '../store/workflowStore';
import { NodeStatus } from '../domains/workflow';
import type { WorkflowNode, WorkflowEdge } from '../store/workflowStore';
import { nodeTypes } from '../nodes/CustomNodes';
import { isSimulatedDragEnabled, onSimulatedDrop } from '../services/simulatedDrag';
import type { NodeTypes, EdgeTypes } from '@xyflow/react';

// 注册自定义节点（28 类，全部走 GenericNode，扣子风格）
const rfNodeTypes = nodeTypes as unknown as NodeTypes;

/**
 * v0.3.1 StatefulEdge：根据 source/target 节点状态给 edge 染色 + 运行中 animateMotion 光点流动
 *
 * 配色（参考扣子默认连线色）：
 *  - RUNNING：#faad14（琥珀）+ 光点从 source → target 循环 1.2s
 *  - SUCCESS：#52c41a（绿）
 *  - FAILED：#ef4444（红，两端任一 FAILED）
 *  - 默认：#4a5aed（扣子靛蓝）
 * 选中时 strokeWidth=3，默认 2。
 */
function StatefulEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    markerEnd,
    style,
  } = props;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // 读取两端节点状态
  const nodesMap = useWorkflowStore((s) => {
    const m = new Map<string, WorkflowNode['data']['status']>();
    s.nodes.forEach((n) => m.set(n.id, n.data.status));
    return m;
  });
  const sStatus = nodesMap.get(source);
  const tStatus = nodesMap.get(target);

  let color = '#4a5aed'; // 扣子靛蓝
  let showFlow = false;
  if (sStatus === NodeStatus.FAILED || tStatus === NodeStatus.FAILED) {
    color = '#ef4444';
  } else if (sStatus === NodeStatus.RUNNING || tStatus === NodeStatus.RUNNING) {
    color = '#faad14';
    showFlow = true;
  } else if (sStatus === NodeStatus.SUCCESS && tStatus === NodeStatus.SUCCESS) {
    color = '#52c41a';
  } else if (sStatus === NodeStatus.SUCCESS) {
    color = '#52c41a';
  }

  const strokeWidth = selected ? 3 : 2;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeWidth,
          transition: 'stroke 180ms linear, stroke-width 120ms linear',
          ...style,
        }}
      />
      {showFlow && (
        // 光点：在 edgePath 上按 1.2s 一圈循环从 0→1 流动
        <circle r={3.2} fill={color} style={{ pointerEvents: 'none' }}>
          <animateMotion dur="1.2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
    </>
  );
}

const rfEdgeTypes: EdgeTypes = { stateful: StatefulEdge };

/**
 * 画布内部组件（在 ReactFlowProvider 里面，所以可以用 useReactFlow hook）
 */
function FlowCanvasInner() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const isRunning = useWorkflowStore((s) => s.isRunning);
  const hasClipboard = useWorkflowStore((s) => s.clipboard !== null);
  const canUndo = useWorkflowStore((s) => s.past.length > 0);

  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const onEdgesChange = useWorkflowStore((s) => s.onEdgesChange);
  const onConnectRaw = useWorkflowStore((s) => s.onConnect);
  const addNode = useWorkflowStore((s) => s.addNode);
  const setSelectedNodeId = useWorkflowStore((s) => s.setSelectedNodeId);
  const commitDrag = useWorkflowStore((s) => s.commitDrag);
  const deleteNodes = useWorkflowStore((s) => s.deleteNodes);
  const deleteEdge = useWorkflowStore((s) => s.deleteEdge);
  const copyNode = useWorkflowStore((s) => s.copyNode);
  const cutNode = useWorkflowStore((s) => s.cutNode);
  const pasteNode = useWorkflowStore((s) => s.pasteNode);
  const rerunFromNode = useWorkflowStore((s) => s.rerunFromNode);
  const undo = useWorkflowStore((s) => s.undo);
  const runWorkflow = useWorkflowStore((s) => s.runWorkflow);

  /* ============== v0.3.1 右键菜单（节点 6 项 + 画布 2 项）============== */
  type CtxKind = 'node' | 'pane';
  interface CtxState {
    open: boolean;
    x: number; // viewport 坐标
    y: number;
    kind: CtxKind;
    nodeId?: string;
    // paste 需要的 flow position（相对 canvas 坐标，含 pan/zoom）
    flowPos?: { x: number; y: number };
  }
  const [ctx, setCtx] = useState<CtxState>({ open: false, x: 0, y: 0, kind: 'pane' });
  const closeCtx = useCallback(() => setCtx((c) => ({ ...c, open: false })), []);

  // 点击空白 / 滚动时关闭菜单
  useEffect(() => {
    if (!ctx.open) return;
    const handler = (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      // 不在菜单内部 → 关掉
      if (target && target.closest('[data-flow-ctxmenu="1"]')) return;
      closeCtx();
    };
    window.addEventListener('mousedown', handler, true);
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler, true);
    return () => {
      window.removeEventListener('mousedown', handler, true);
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler, true);
    };
  }, [ctx.open, closeCtx]);

  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: WorkflowNode) => {
      e.preventDefault();
      const fp = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setSelectedNodeId(node.id);
      setCtx({
        open: true,
        x: e.clientX,
        y: e.clientY,
        kind: 'node',
        nodeId: node.id,
        flowPos: fp,
      });
    },
    [screenToFlowPosition, setSelectedNodeId],
  );

  const onPaneContextMenu = useCallback(
    (e: ReactMouseEvent | MouseEvent) => {
      e.preventDefault();
      const { clientX, clientY } = 'clientX' in e ? e : (e as unknown as { clientX: number; clientY: number });
      const fp = screenToFlowPosition({ x: clientX, y: clientY });
      setCtx({
        open: true,
        x: clientX,
        y: clientY,
        kind: 'pane',
        flowPos: fp,
      });
    },
    [screenToFlowPosition],
  );

  // open-debug-tab 事件：让外层 ConfigPanel 切到 Debug Tab。
  // 用 CustomEvent 广播，ConfigPanel 监听。
  const emitOpenDebug = useCallback((nodeId: string) => {
    window.dispatchEvent(
      new CustomEvent('open-debug-tab', { detail: { nodeId } }),
    );
  }, []);

  const nodeMenuItems = useMemo<MenuProps['items']>(() => {
    const nid = ctx.nodeId;
    if (!nid) return [];
    return [
      {
        key: 'copy',
        icon: <CopyOutlined />,
        label: '复制节点',
        disabled: isRunning,
        onClick: () => { copyNode(nid); closeCtx(); },
      },
      {
        key: 'cut',
        icon: <ScissorOutlined />,
        label: '剪切节点',
        disabled: isRunning,
        onClick: () => { cutNode(nid); closeCtx(); },
      },
      {
        key: 'paste',
        icon: <AppstoreAddOutlined />,
        label: '粘贴到此处',
        disabled: isRunning || !hasClipboard || !ctx.flowPos,
        onClick: () => { if (ctx.flowPos) pasteNode(ctx.flowPos); closeCtx(); },
      },
      { type: 'divider' },
      {
        key: 'delete',
        icon: <DeleteOutlined />,
        label: '删除节点',
        disabled: isRunning,
        danger: true,
        onClick: () => { deleteNodes(nid); closeCtx(); },
      },
      {
        key: 'rerun',
        icon: <ReloadOutlined />,
        label: '从该节点重新运行',
        onClick: async () => { closeCtx(); await rerunFromNode(nid); },
      },
      {
        key: 'debug',
        icon: <BugOutlined />,
        label: '查看运行调试',
        onClick: () => { emitOpenDebug(nid); closeCtx(); },
      },
    ];
  }, [ctx.nodeId, ctx.flowPos, isRunning, hasClipboard, copyNode, cutNode, pasteNode, deleteNodes, rerunFromNode, emitOpenDebug, closeCtx]);

  const paneMenuItems = useMemo<MenuProps['items']>(() => ([
    {
      key: 'paste',
      icon: <AppstoreAddOutlined />,
      label: '粘贴节点到此处',
      disabled: isRunning || !hasClipboard || !ctx.flowPos,
      onClick: () => { if (ctx.flowPos) pasteNode(ctx.flowPos); closeCtx(); },
    },
    {
      key: 'undo',
      icon: <UndoOutlined />,
      label: '撤销',
      disabled: isRunning || !canUndo,
      onClick: () => { undo(); closeCtx(); },
    },
    { type: 'divider' },
    {
      key: 'fitview',
      icon: <CompressOutlined />,
      label: '适应视图',
      onClick: () => { fitView({ padding: 0.2, duration: 300 }); closeCtx(); },
    },
    isRunning
      ? {
          key: 'stop',
          icon: <ReloadOutlined spin />,
          label: '（运行中…）重跑流程',
          onClick: async () => { closeCtx(); await runWorkflow(); },
        }
      : {
          key: 'run',
          icon: <ReloadOutlined />,
          label: '运行整个工作流',
          onClick: async () => { closeCtx(); await runWorkflow(); },
        },
  ] as NonNullable<MenuProps['items']>), [isRunning, hasClipboard, ctx.flowPos, canUndo, pasteNode, undo, fitView, runWorkflow, closeCtx]);

  const ctxMenuStyle = useMemo((): CSSProperties => {
    const menuW = 190;
    const menuH = ctx.kind === 'node' ? 230 : 170; // 估算，避免溢出
    const safeX = Math.max(4, Math.min(window.innerWidth - menuW - 4, ctx.x));
    const safeY = Math.max(4, Math.min(window.innerHeight - menuH - 4, ctx.y));
    return {
      position: 'fixed',
      left: safeX,
      top: safeY,
      zIndex: 2000,
      width: menuW,
      background: '#ffffff',
      borderRadius: 8,
      border: '1px solid #e5e7eb',
      boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
      padding: 4,
    };
  }, [ctx.x, ctx.y, ctx.kind]);

  // End: right-click menu ====================================================
  // 连线：环检测 + 错误提示
  const onConnect = useCallback(
    (params: Connection) => {
      const res = onConnectRaw(params);
      if (res.error) {
        // 用浏览器的 alert 简单直接，面试演示也清晰（阶段2 将替换为 EventBus + 全局 Toast）
        alert(res.error);
      }
    },
    [onConnectRaw]
  );

  // 连线创建前拦截：禁止同一节点连自己、禁止创建环
  const isValidConnection = useCallback((connection: Connection | Edge) => {
    if (!connection.source || !connection.target) return false;
    if (connection.source === connection.target) return false;
    const curNodes = useWorkflowStore.getState().nodes;
    const curEdges = useWorkflowStore.getState().edges;
    const newEdge = {
      source: connection.source,
      target: connection.target,
    };
    return !wouldCreateCycle(curNodes, curEdges, newEdge);
  }, []);

  // 允许把外部 DOM 拖进来
  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow-type') as NodeType;
      if (!type) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(type, { x: position.x - 110, y: position.y - 40 });
    },
    [screenToFlowPosition, addNode]
  );

  // 桌面端（Tauri + Windows WebView2）兜底：鼠标模拟 DnD。
  // 仅在桌面端注册 listener；Web 环境下 isSimulatedDragEnabled()=false 不订阅。
  useEffect(() => {
    if (!isSimulatedDragEnabled()) return;
    const wrapper = reactFlowWrapper.current;
    return onSimulatedDrop((payload) => {
      // wrapper 若为空，放弃本次 drop（理论上不会）
      const el = wrapper ?? reactFlowWrapper.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // payload.canvasClientX/Y 已经是相对 canvas 左上角（含 pan/zoom），
      // 为了走和 HTML5 DnD 完全一致的 screenToFlowPosition 换算（处理 zoom/pan），
      // 再转回 screen 坐标：rect.left + relativeX。
      const screenX = rect.left + payload.canvasClientX;
      const screenY = rect.top + payload.canvasClientY;
      const pos = screenToFlowPosition({ x: screenX, y: screenY });
      addNode(payload.nodeType as NodeType, { x: pos.x - 110, y: pos.y - 40 });
    });
  }, [screenToFlowPosition, addNode]);

  // 点击节点：记录选中
  const onNodeClick = useCallback(
    (_e: ReactMouseEvent, node: WorkflowNode) => {
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId]
  );

  // 点击空白：取消选中
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  // 拖拽结束：记录一次历史（支持撤销）
  const onNodeDragStop = useCallback(() => {
    commitDrag();
  }, [commitDrag]);

  // 删除键：删除选中节点
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const s = useWorkflowStore.getState();
        if (s.selectedNodeId) {
          e.preventDefault();
          deleteNodes(s.selectedNodeId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteNodes]);

  const defaultEdgeOptions = useMemo<DefaultEdgeOptions>(
    () => ({
      animated: false,
      type: 'stateful',
      // v0.3.1：把状态颜色/光点动画统一交给自定义 StatefulEdge 渲染；
      // 同时不再默认提供 labelStyle/labelBgStyle，避免在连线中间重复绘标签 ——
      // 分支说明、输入/输出说明一律放在节点 Handle 旁，避免"便宜了/双份"问题
      style: { strokeWidth: 2 },
    }),
    []
  );

  // 把选中节点 ID 同步到 @xyflow/react 的 selected（方便高亮）
  const rfNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: n.id === selectedNodeId,
        draggable: !isRunning,
        connectable: !isRunning,
      })),
    [nodes, selectedNodeId, isRunning]
  );

  const rfEdges = useMemo(
    () =>
      edges.map((e: WorkflowEdge) => ({
        ...e,
        type: 'stateful',
        deletable: !isRunning,
      })),
    [edges, isRunning]
  );

  return (
    <div
      ref={reactFlowWrapper}
      className="app-canvas"
      style={{
        position: 'relative',
        background: '#fafcff',
        flex: '1 1 auto',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={rfNodeTypes}
        edgeTypes={rfEdgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={(nds) => deleteNodes(nds.map((n) => n.id))}
        onEdgesDelete={(eds) => eds.forEach((e) => deleteEdge(e.id))}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        snapToGrid
        snapGrid={[10, 10]}
      >
        <Background color="#c6d3e8" gap={10} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const st = (n.data as WorkflowNode['data'])?.status;
            if (st === 'running') return '#faad14';
            if (st === 'success') return '#52c41a';
            if (st === 'failed') return '#ff4d4f';
            return '#1677ff';
          }}
          style={{
            border: '1px solid #e8e8e8',
            borderRadius: 8,
          }}
        />
      </ReactFlow>

      {/* v0.3.1 右键菜单：放在画布外层，fixed 定位；数据驱动（根据 kind 选 items） */}
      {ctx.open && (
        <div data-flow-ctxmenu="1" style={ctxMenuStyle}>
          <Menu
            mode="vertical"
            selectable={false}
            style={{ border: 'none', boxShadow: 'none', padding: 0 }}
            items={ctx.kind === 'node' ? nodeMenuItems : paneMenuItems}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 外层包装 Provider，供 App.tsx 直接引用
 */
export default function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner />
    </ReactFlowProvider>
  );
}
