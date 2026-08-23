import { useCallback, useRef, useMemo, useEffect } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from '@xyflow/react';
import type { Connection, DefaultEdgeOptions, Edge, NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useWorkflowStore, NodeType, wouldCreateCycle } from '../store/workflowStore';
import type { WorkflowNode, WorkflowEdge } from '../store/workflowStore';
import { LLMNode, ConditionNode, CodeNode } from '../nodes/CustomNodes';
import { isSimulatedDragEnabled, onSimulatedDrop } from '../services/simulatedDrag';

// 注册自定义节点
const nodeTypes: NodeTypes = {
  [NodeType.LLM]: LLMNode,
  [NodeType.CONDITION]: ConditionNode,
  [NodeType.CODE]: CodeNode,
};

/**
 * 画布内部组件（在 ReactFlowProvider 里面，所以可以用 useReactFlow hook）
 */
function FlowCanvasInner() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const isRunning = useWorkflowStore((s) => s.isRunning);

  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const onEdgesChange = useWorkflowStore((s) => s.onEdgesChange);
  const onConnectRaw = useWorkflowStore((s) => s.onConnect);
  const addNode = useWorkflowStore((s) => s.addNode);
  const setSelectedNodeId = useWorkflowStore((s) => s.setSelectedNodeId);
  const commitDrag = useWorkflowStore((s) => s.commitDrag);
  const deleteNodes = useWorkflowStore((s) => s.deleteNodes);
  const deleteEdge = useWorkflowStore((s) => s.deleteEdge);

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
    (_e: MouseEvent, node: WorkflowNode) => {
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
      style: { stroke: '#1677ff', strokeWidth: 2 },
      labelStyle: { fill: '#595959', fontSize: 11 },
      labelBgStyle: { fill: '#fff' },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 4,
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
        deletable: !isRunning,
      })),
    [edges, isRunning]
  );

  return (
    <div
      ref={reactFlowWrapper}
      className="app-canvas"
      style={{ flex: '1 1 auto', position: 'relative', background: '#fafcff', minWidth: 0, minHeight: 0 }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
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
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background color="#c6d3e8" gap={16} />
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
