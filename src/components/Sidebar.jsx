import { NodeType } from '../store/workflowStore';

const ITEMS = [
  {
    type: NodeType.LLM,
    icon: '🤖',
    title: 'LLM 大模型节点',
    desc: '调用大模型推理，支持配置模型、提示词',
    color: '#1677ff',
  },
  {
    type: NodeType.CONDITION,
    icon: '🔀',
    title: '条件分支节点',
    desc: 'If 判断，分 true/false 两条路径',
    color: '#fa8c16',
  },
  {
    type: NodeType.CODE,
    icon: '</>',
    title: '代码执行节点',
    desc: '执行 JavaScript / Python 代码片段',
    color: '#722ed1',
  },
];

const wrapperStyle = {
  width: 240,
  padding: 16,
  borderRight: '1px solid #f0f0f0',
  background: '#fafafa',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  overflow: 'auto',
};

const titleStyle = {
  fontSize: 14,
  fontWeight: 600,
  margin: '0 0 4px 0',
  color: '#262626',
};

const tipStyle = {
  fontSize: 12,
  color: '#8c8c8c',
  marginBottom: 8,
};

const itemStyle = (color) => ({
  padding: 12,
  border: `1px dashed ${color}66`,
  borderRadius: 8,
  background: '#fff',
  cursor: 'grab',
  userSelect: 'none',
  transition: 'all 0.15s',
});

export default function Sidebar() {
  const onDragStart = (event, nodeType) => {
    // 显式通过 HTML5 DnD 传递 nodeType
    event.dataTransfer.setData('application/reactflow-type', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside style={wrapperStyle}>
      <h3 style={titleStyle}>拖拽节点到画布</h3>
      <div style={tipStyle}>从左侧按住节点拖入中间画布</div>

      {ITEMS.map((it) => (
        <div
          key={it.type}
          style={itemStyle(it.color)}
          draggable
          onDragStart={(e) => onDragStart(e, it.type)}
          onMouseOver={(e) => {
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = `0 2px 8px ${it.color}33`;
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = '';
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: 13,
              fontWeight: 600,
              color: it.color,
              marginBottom: 4,
            }}
          >
            <span style={{ marginRight: 6, fontSize: 16 }}>{it.icon}</span>
            {it.title}
          </div>
          <div style={{ fontSize: 11, color: '#8c8c8c', lineHeight: 1.5 }}>{it.desc}</div>
        </div>
      ))}

      <div
        style={{
          marginTop: 16,
          padding: 10,
          borderRadius: 6,
          background: '#e6f4ff',
          border: '1px solid #91caff',
          fontSize: 11.5,
          color: '#0958d9',
          lineHeight: 1.6,
        }}
      >
        💡 快捷键提示：
        <br />• Backspace / Delete 删除选中节点
        <br />• 按住空格 + 拖拽 = 平移画布
        <br />• 滚轮 = 缩放画布
      </div>
    </aside>
  );
}
