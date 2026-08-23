import { NodeType } from '../store/workflowStore';
import { RobotOutlined, ForkOutlined, CodeOutlined, InfoCircleOutlined } from '@ant-design/icons';

const ICON_COLOR = '#595959';

const ITEMS = [
  {
    type: NodeType.LLM,
    icon: <RobotOutlined />,
    title: 'LLM 大模型节点',
    desc: '调用大模型推理，支持配置模型、提示词',
  },
  {
    type: NodeType.CONDITION,
    icon: <ForkOutlined />,
    title: '条件分支节点',
    desc: 'If 判断，分 true / false 两条路径',
  },
  {
    type: NodeType.CODE,
    icon: <CodeOutlined />,
    title: '代码执行节点',
    desc: '执行 JavaScript / Python 代码片段',
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

const itemStyle = {
  padding: 12,
  border: '1px solid #d9d9d9',
  borderRadius: 8,
  background: '#fff',
  cursor: 'grab',
  userSelect: 'none',
  transition: 'all 0.15s',
};

const iconWrapStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  borderRadius: 6,
  marginRight: 8,
  background: '#f5f5f5',
  color: ICON_COLOR,
  fontSize: 14,
};

const infoStyle = {
  marginTop: 16,
  padding: 10,
  borderRadius: 6,
  background: '#fafafa',
  border: '1px solid #f0f0f0',
  fontSize: 11.5,
  color: '#595959',
  lineHeight: 1.6,
};

const infoTitleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontWeight: 600,
  color: '#262626',
  marginBottom: 4,
};

export default function Sidebar() {
  const onDragStart = (event, nodeType) => {
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
          style={itemStyle}
          draggable
          onDragStart={(e) => onDragStart(e, it.type)}
          onMouseOver={(e) => {
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
            e.currentTarget.style.borderColor = '#bfbfbf';
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.transform = '';
            e.currentTarget.style.boxShadow = '';
            e.currentTarget.style.borderColor = '';
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: 13,
              fontWeight: 600,
              color: '#262626',
              marginBottom: 4,
            }}
          >
            <span style={iconWrapStyle}>{it.icon}</span>
            {it.title}
          </div>
          <div style={{ fontSize: 11, color: '#8c8c8c', lineHeight: 1.5, marginLeft: 36 }}>
            {it.desc}
          </div>
        </div>
      ))}

      <div style={infoStyle}>
        <div style={infoTitleStyle}>
          <InfoCircleOutlined style={{ color: '#8c8c8c' }} />
          快捷键
        </div>
        <div style={{ paddingLeft: 20 }}>
          · Backspace / Delete 删除选中节点
          <br />· 空格 + 拖拽 = 平移画布
          <br />· 滚轮 = 缩放画布
        </div>
      </div>
    </aside>
  );
}
