/**
 * 桌面端 HTML5 DnD 模拟兜底（鼠标事件仿真）。
 *
 * 背景：
 *  - 在 Windows 平台的 Tauri v2 WebView2 中，若 Tauri 窗口未显式 "dragDropEnabled: false"，
 *    操作系统级拖放处理器会拦截 HTML5 的 dragstart/dragover/drop 事件，导致「节点拖进画布无反应」。
 *  - 我们已经在 tauri.conf.json 关闭了原生 DnD，但为兼容不同 WebView2 runtime 版本，
 *    额外提供一套基于 PointerDown / PointerMove / PointerUp 的仿真逻辑：
 *    1) Sidebar 在拖拽源头处广播 nodeType；
 *    2) FlowCanvas 负责监听全局 pointerup，如果命中 canvas 容器，就直接调用 addNode。
 *  - Web 环境（Vercel/浏览器）下本模块的「已启用」判定为 false → 不注册任何监听，
 *    标准 HTML5 DnD 正常工作。
 */
import { detectRuntime } from './runtimeEnv';

type NodeTypeString = string;

type DragSession = {
  nodeType: NodeTypeString;
  // 起始鼠标位置，用于避免「click 误触发拖放」
  startX: number;
  startY: number;
  // 是否已实际移动（>阈值才算真正的拖拽意图）
  moved: boolean;
  ghostEl: HTMLElement | null;
};

const DRAG_THRESHOLD = 5; // px，超过才算开始拖
const BUS = new EventTarget();
const EVENT_NAME = '__desktop_simulated_node_drop';

type SimDropPayload = {
  nodeType: NodeTypeString;
  // 画布（app-canvas）内的像素坐标（client 空间下）
  canvasClientX: number;
  canvasClientY: number;
};

type CanvasDropEvent = CustomEvent<SimDropPayload>;

/**
 * 仅在 Tauri 桌面端启用本仿真器。
 * 这样 Web 环境下零副作用（无 listener、无 class 名写入）。
 */
export function isSimulatedDragEnabled(): boolean {
  return detectRuntime().tauri;
}

let session: DragSession | null = null;
let globalListenersInstalled = false;

function removeGhost() {
  if (!session) return;
  if (session.ghostEl && session.ghostEl.parentNode) {
    session.ghostEl.parentNode.removeChild(session.ghostEl);
  }
  session.ghostEl = null;
}

function cleanupSession() {
  removeGhost();
  session = null;
  window.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('pointerup', onPointerUp, true);
  window.removeEventListener('pointercancel', onPointerUp, true);
}

function onPointerMove(ev: PointerEvent) {
  if (!session) return;
  const dx = ev.clientX - session.startX;
  const dy = ev.clientY - session.startY;
  if (!session.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
    session.moved = true;
    // 创建「幽灵节点」——半透明跟随鼠标，给用户可视化反馈
    const ghost = document.createElement('div');
    ghost.style.position = 'fixed';
    ghost.style.zIndex = '99999';
    ghost.style.pointerEvents = 'none';
    ghost.style.opacity = '0.88';
    ghost.style.transform = 'translate(-50%, -50%) rotate(-2deg)';
    ghost.style.width = '200px';
    ghost.style.border = '2px dashed #1677ff';
    ghost.style.borderRadius = '8px';
    ghost.style.background = '#e6f4ff';
    ghost.style.color = '#0958d9';
    ghost.style.padding = '8px 10px';
    ghost.style.fontSize = '12px';
    ghost.style.fontWeight = '600';
    ghost.style.boxShadow = '0 8px 24px rgba(22,119,255,0.22)';
    ghost.textContent = `创建节点：${labelOf(session.nodeType)}`;
    document.body.appendChild(ghost);
    session.ghostEl = ghost;
  }
  if (session.ghostEl) {
    session.ghostEl.style.left = `${ev.clientX}px`;
    session.ghostEl.style.top = `${ev.clientY}px`;
  }
}

function onPointerUp(ev: PointerEvent) {
  if (!session) return;
  const moved = session.moved;
  const nodeType = session.nodeType;
  cleanupSession();
  if (!moved) return;

  // 判定落点：命中 .app-canvas → 触发 drop。
  const target = document.elementFromPoint(ev.clientX, ev.clientY);
  const canvas = target?.closest<HTMLElement>('.app-canvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const payload: SimDropPayload = {
    nodeType,
    // 相对 canvas 左上角的 client 坐标（等比换算到 flow 空间由 FlowCanvas 处理）
    canvasClientX: ev.clientX - rect.left,
    canvasClientY: ev.clientY - rect.top,
  };
  const evt: CanvasDropEvent = new CustomEvent(EVENT_NAME, { detail: payload, bubbles: true });
  BUS.dispatchEvent(evt);
  // 同时在 canvas DOM 上派发一份（ReactFlow 包裹层也可能监听此处）
  canvas.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload }));
}

/**
 * Sidebar 入口：在 pointerdown 时发起一次「准备拖拽」。
 * 注：不影响原生 HTML5 DnD（两者共存，桌面端优先用 pointer 仿真兜底）。
 */
export function beginSimulatedDrag(
  ev: React.PointerEvent<HTMLElement> | PointerEvent,
  nodeType: NodeTypeString,
): void {
  if (!isSimulatedDragEnabled()) return;
  if (session) cleanupSession();
  // 仅主按钮（左键）触发
  if ('button' in ev && ev.button !== 0) return;

  session = {
    nodeType,
    startX: ev.clientX,
    startY: ev.clientY,
    moved: false,
    ghostEl: null,
  };
  if (!globalListenersInstalled) {
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    globalListenersInstalled = true;
  }
}

/**
 * FlowCanvas 侧订阅：监听 BUS。使用方在 useEffect 里调用，拿到 canvas 相对坐标后自己做
 * 进一步的 viewport → flow 坐标转换（ReactFlow screenToFlowPosition）。
 */
export function onSimulatedDrop(
  handler: (payload: SimDropPayload) => void,
): () => void {
  const cb = (evt: Event) => {
    const detail = (evt as CanvasDropEvent).detail;
    if (detail && typeof detail.nodeType === 'string') handler(detail);
  };
  BUS.addEventListener(EVENT_NAME, cb as EventListener);
  return () => {
    BUS.removeEventListener(EVENT_NAME, cb as EventListener);
  };
}

const LABELS: Record<NodeTypeString, string> = {
  llm: '大模型节点',
  condition: '条件分支',
  code: '代码执行',
};

function labelOf(t: NodeTypeString): string {
  return LABELS[t] ?? `节点（${t}）`;
}
