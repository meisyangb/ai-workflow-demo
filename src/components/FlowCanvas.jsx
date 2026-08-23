import { useCallback, useRef, useMemo, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import {
  useWorkflowStore,
  NodeType,
  wouldCreateCycle,
} from '../store/workflowStore';
import { LLMNode, ConditionNode, CodeNode } from '../nodes/CustomNodes';

// 注册自定义节点
const nodeTypes = {
  [NodeType.LLM]: LLMNode,
  [NodeType.CONDITION]: ConditionNode,
  [NodeType.CODE]: CodeNode,
};

/**
 * 画布内部组件（在 ReactFlowProvider 里面，所以可以用 useReactFlow hook）
 */
function FlowCanvasInner() {
  const reactFlowWrapper = useRef(null);
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
    (params) => {
      const res = onConnectRaw(params);
      if (res && res.error) {
        // 用浏览器的 alert 简单直接，面试演示也清晰
        // eslint-disable-next-line no-alert
        alert(res.error);
      }
    },
    [onConnectRaw]
  );

  // 连线创建前拦截：禁止同一节点连自己、禁止创建环
  const isValidConnection = useCallback(
    (connection) => {
      if (connection.source === connection.target) return false;
      const curNodes = useWorkflowStore.getState().nodes;
      const curEdges = useWorkflowStore.getState().edges;
      const newEdge = {
        source: connection.source,
        target: connection.target,
      };
      if (wouldCreateCycle(curNodes, curEdges, newEdge)) {
        return false;
      }
      return true;
    },
    []
  );

  // 允许把外部 DOM 拖进来
  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow-type');
      if (!type) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(type, { x: position.x - 110, y: position.y - 40 });
    },
    [screenToFlowPosition, addNode]
  );

  // 点击节点：记录选中
  const onNodeClick = useCallback(
    (_e, node) => {
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

  // 删除键：删除选中节点 / 连线
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const s = useWorkflowStore.getState();
        // 删除选中节点
        if (s.selectedNodeId) {
          e.preventDefault();
          deleteNodes(s.selectedNodeId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteNodes]);

  const defaultEdgeOptions = useMemo(
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
      edges.map((e) => ({
        ...e,
        deletable: !isRunning,
      })),
    [edges, isRunning]
  );

  return (
    <div
      ref={reactFlowWrapper}
      style={{ flex: 1, position: 'relative', background: '#fafcff' }}
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
            const st = n.data?.status;
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
 * 外层包装 Provider，供 App.jsx 直接引用
 */
export default function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner />
    </ReactFlowProvider>
  );
}
