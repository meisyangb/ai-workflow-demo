/**
 * v0.3.1 PinPicker 🔌 插针器组件 + withPinPicker HOC
 *
 * PinPicker：基于 Ant Design Popover 的"选择上游字段"选择器，
 * 参考扣子的"变量插针"交互：
 *   - 左侧列出当前节点之前（上游）所有节点
 *   - 每个节点下展开它的 outputs[] 字段（key / label / type / previewValue）
 *   - 点击某字段 → onSelect 返回 '{{ upstreamNodeId.outputKey }}' 扣子风格引用
 *
 * withPinPicker：高阶组件包装任何「value? + onChange(v)」受控字段组件，
 * 在控件右侧内嵌一个 🔌 按钮（suffix），点击弹 PinPicker，选中即写入 value。
 * 默认 HOC 提供 <InputWithPin/>，供 ConfigPanel 各 Form 直接用。
 */
import { useMemo, useState } from 'react';
import type { ReactNode, ComponentType } from 'react';
import { Button, Empty, Input, Popover, Select, Tag, Tooltip } from 'antd';
import { ThunderboltOutlined, SearchOutlined } from '@ant-design/icons';
import type { InputProps, SelectProps } from 'antd';
import type { BaseOptionType } from 'rc-select/lib/Select';

import { useWorkflowStore } from '../store/workflowStore';
import type { WorkflowFieldDef, WorkflowNode, WorkflowEdge, FieldType } from '../domains/workflow';

/* ==========================================================================
 * 内部 helper：拓扑排序（Kahn）
 *   用于在 PinPicker 内判断哪些节点在 selfId 之前（= 合法可引用上游）
 * ========================================================================*/
function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const idSet = new Set(nodes.map((n) => n.id));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  nodes.forEach((n) => {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  });
  edges.forEach((e) => {
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  });
  const q: string[] = [];
  indeg.forEach((d, nid) => {
    if (d === 0) q.push(nid);
  });
  const result: string[] = [];
  while (q.length) {
    const id = q.shift()!;
    result.push(id);
    adj.get(id)!.forEach((next) => {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) q.push(next);
    });
  }
  // 含环时，把环内未入列节点补在末尾（尽量保守保证输出完整）
  if (result.length < nodes.length) {
    nodes.forEach((n) => {
      if (!result.includes(n.id)) result.push(n.id);
    });
  }
  return result;
}

/* ==========================================================================
 * 1) 基础数据：收集上游节点输出字段（按拓扑序，排除 selfId，避免自引用）
 * ========================================================================*/
interface UpstreamField {
  /** 扣子风格引用：'{{ nodeId.fieldKey }}' */
  ref: string;
  nodeId: string;
  nodeLabel: string;
  key: string;
  label: string;
  type: WorkflowFieldDef['type'];
  /** 字段当前的预览值（若 upstream 已执行成功过，从 debugOutput/output 中取值 hint） */
  previewValue?: string;
}
interface UpstreamGroup {
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  accent: string;
  fields: UpstreamField[];
}

/** selfId 的上游按拓扑排序节点及其 output 字段列表；若 selectedNodeId=undefined 则取全量输出 */
export function useUpstreamVariables(selfId?: string | null): UpstreamGroup[] {
  const { nodes, edges } = useWorkflowStore((s) => ({ nodes: s.nodes, edges: s.edges }));
  return useMemo<UpstreamGroup[]>(() => {
    // 拓扑 order
    const order = topologicalOrder(nodes, edges);
    const idxSelf = selfId ? order.indexOf(selfId) : -1;
    // output 字段：若 data.outputs 有就用它；否则 debugOutput 是对象的话枚举所有 key 作为候选
    const outFields = (n: WorkflowNode): WorkflowFieldDef[] => {
      const declared = n.data.outputs?.length ? n.data.outputs : undefined;
      if (declared) return declared;
      const dbg = n.data.debugOutput;
      if (dbg && typeof dbg === 'object' && !Array.isArray(dbg)) {
        return Object.keys(dbg as Record<string, unknown>).map<WorkflowFieldDef>((k) => ({
          key: k,
          label: k,
          type: 'string',
        }));
      }
      return [];
    };
    const previewMap = (n: WorkflowNode): Record<string, string> => {
      const dbg = n.data.debugOutput;
      if (!dbg || typeof dbg !== 'object' || Array.isArray(dbg)) return {};
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(dbg as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        const str = typeof v === 'string' ? v : JSON.stringify(v);
        m[k] = str.length > 28 ? `${str.slice(0, 28)}…` : str;
      }
      return m;
    };
    return order
      .map((id) => nodes.find((n) => n.id === id)!)
      .filter((n) => !!n)
      .filter((n) => (idxSelf >= 0 ? order.indexOf(n.id) < idxSelf : n.id !== selfId))
      .map<UpstreamGroup>((n) => {
        const type = (n.type as string) ?? 'unknown';
        const fields = outFields(n);
        const previews = previewMap(n);
        return {
          nodeId: n.id,
          nodeLabel: n.data.label,
          nodeType: type,
          accent: '#6366f1',
          fields: fields.map<UpstreamField>((f) => ({
            ref: `{{ ${n.id}.${f.key} }}`,
            nodeId: n.id,
            nodeLabel: n.data.label,
            key: f.key,
            label: f.label,
            type: f.type,
            previewValue: previews[f.key],
          })),
        };
      })
      .filter((g) => g.fields.length > 0);
  }, [nodes, edges, selfId]);
}

/* ==========================================================================
 * 2) PinPicker 主组件（按钮 + Popover 内两列：节点列表 → 字段列表）
 * ========================================================================*/
export interface PinPickerProps {
  /** 当前编辑的节点 id（用于过滤上游），不传则列全部 */
  selfId?: string | null;
  /** 选中回调：ref 形如 '{{ nodeId.key }}'，展开对象方便自定义 */
  onSelect: (ref: string, field: UpstreamField) => void;
  /** 按钮定制，默认 🔌 插针 */
  label?: ReactNode;
  /** 额外按钮 props */
  buttonProps?: Parameters<typeof Button>[0];
  /** 占位字符（搜索框） */
  searchPlaceholder?: string;
}

const TYPE_COLORS: Record<FieldType, string> = {
  string: '#52c41a',
  integer: '#1677ff',
  number: '#2563eb',
  boolean: '#722ed1',
  object: '#fa8c16',
  array: '#eb2f96',
  file: '#0ea5e9',
};

export function PinPicker(props: PinPickerProps) {
  const { selfId, onSelect, label, buttonProps, searchPlaceholder } = props;
  const groups = useUpstreamVariables(selfId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo<UpstreamGroup[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map<UpstreamGroup>((g) => ({
        ...g,
        fields: g.fields.filter(
          (f) =>
            f.key.toLowerCase().includes(q) ||
            f.label.toLowerCase().includes(q) ||
            f.nodeLabel.toLowerCase().includes(q) ||
            f.ref.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.fields.length > 0);
  }, [groups, query]);

  const content = (
    <div style={{ width: 320, maxHeight: 360, overflow: 'auto' }}>
      <div style={{ marginBottom: 8 }}>
        <Input
          allowClear
          size="small"
          prefix={<SearchOutlined style={{ color: '#a3a3a3' }} />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder ?? '搜索变量 / 节点'}
        />
      </div>
      {filtered.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={groups.length === 0 ? '暂无可引用的上游字段' : '无匹配'}
        />
      ) : (
        filtered.map((g) => (
          <div key={g.nodeId} style={{ marginBottom: 10 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                fontWeight: 600,
                color: '#475569',
                padding: '4px 2px',
                borderBottom: '1px dashed #e5e7eb',
                marginBottom: 4,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 2,
                  background: g.accent,
                  display: 'inline-block',
                }}
              />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {g.nodeLabel}
              </span>
              <Tag color="geekblue" style={{ marginLeft: 'auto', fontSize: 10, padding: '0 4px', lineHeight: 1.6 }}>
                {g.nodeType}
              </Tag>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {g.fields.map((f) => (
                <Tooltip
                  key={`${f.nodeId}-${f.key}`}
                  title={
                    <div style={{ maxWidth: 260, wordBreak: 'break-all' }}>
                      <div style={{ fontWeight: 600 }}>{f.label}</div>
                      <div style={{ opacity: 0.9, fontFamily: 'monospace' }}>{f.ref}</div>
                      {f.previewValue && (
                        <div style={{ marginTop: 4, fontSize: 11 }}>
                          预览：<span style={{ color: '#7dd3fc' }}>{f.previewValue}</span>
                        </div>
                      )}
                    </div>
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    block
                    style={{
                      justifyContent: 'flex-start',
                      height: 26,
                      padding: '0 6px',
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    onClick={() => {
                      onSelect(f.ref, f);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    <Tag
                      bordered={false}
                      style={{
                        color: '#fff',
                        background: TYPE_COLORS[f.type] ?? '#8c8c8c',
                        fontSize: 10,
                        padding: '0 6px',
                        marginRight: 6,
                        lineHeight: 1.6,
                      }}
                    >
                      {f.type}
                    </Tag>
                    <span style={{ fontWeight: 500 }}>{f.label}</span>
                    <span style={{ color: '#94a3b8', marginLeft: 4 }}>.{f.key}</span>
                    {f.previewValue && (
                      <span
                        style={{
                          marginLeft: 'auto',
                          color: '#64748b',
                          fontSize: 11,
                          fontStyle: 'italic',
                          maxWidth: 100,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {f.previewValue}
                      </span>
                    )}
                  </Button>
                </Tooltip>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={['click']}
      placement="bottomRight"
      overlayInnerStyle={{ padding: 8 }}
      content={content}
    >
      <Button
        type="text"
        size="small"
        icon={<ThunderboltOutlined style={{ color: '#6366f1' }} />}
        {...buttonProps}
        onClick={(e) => {
          // 阻止冒泡，避免 Input 的 click 事件触发其他行为
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {label ?? '插针'}
      </Button>
    </Popover>
  );
}

/* ==========================================================================
 * 3) withPinPicker：在任何组件右侧（suffix）注入 🔌 PinPicker 按钮
 *    注：HOC 约定 WrappedComponent 支持 value?/onChange(v)，并且接受 suffix 属性
 *        （Antd Input/Select/Textarea 都天然有 suffix / addonAfter）
 * ========================================================================*/

// PinPicker 注入要求至少存在 selfId? + pinTransform? 两个新字段；
// 至于 value/onChange 由 Wrapped 自行声明，这里不强行改它们的类型。
export interface PinInjectedProps {
  /** 当前节点 id（用于过滤仅显示上游） */
  selfId?: string | null;
  /** 可选：把选中的 ref 字符串转换成 Wrapped 需要的类型后再调用 onChange */
  pinTransform?: (ref: string) => unknown;
}

export function withPinPicker<P extends object>(
  Wrapped: ComponentType<P>,
  slot: 'suffix' | 'addonAfter' = 'suffix',
): ComponentType<P & PinInjectedProps> {
  function WithPinPicker(inProps: P & PinInjectedProps) {
    // 把仅 PinPicker 用的字段拆出来，剩下原封不动传给 Wrapped
    const { selfId, pinTransform, ...rest } = inProps;
    const picker = (
      <PinPicker
        selfId={selfId}
        label={null as ReactNode}
        onSelect={(ref) => {
          const next = pinTransform ? pinTransform(ref) : ref;
          // 调 onChange：从 rest 里取（按 Antd 约定的 onChange 参数）
          const onChange = (rest as unknown as { onChange?: (n: unknown) => void }).onChange;
          onChange?.(next);
        }}
      />
    );
    const merged: Record<string, unknown> = { ...(rest as unknown as Record<string, unknown>) };
    const base = rest as unknown as { suffix?: ReactNode; addonAfter?: ReactNode };
    if (slot === 'suffix') {
      merged.suffix = (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {base.suffix}
          {picker}
        </span>
      );
    } else {
      merged.addonAfter = (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {base.addonAfter}
          {picker}
        </span>
      );
    }
    return <Wrapped {...(merged as P)} />;
  }
  WithPinPicker.displayName = `withPinPicker(${Wrapped.displayName ?? Wrapped.name ?? 'Component'})`;
  return WithPinPicker;
}

/* ==========================================================================
 * 4) 常用 preset：InputWithPin / SelectWithPin
 * ========================================================================*/
type InputPropsBase = InputProps & { selfId?: string | null; pinTransform?: (r: string) => unknown };

export const InputWithPin = withPinPicker(
  function _Input(props: InputPropsBase) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { selfId, pinTransform, ...rest } = props;
    return <Input {...rest} />;
  },
) as ComponentType<InputPropsBase>;

type SelectPropsBase<VT = unknown, Opt extends BaseOptionType = BaseOptionType> = SelectProps<
  VT,
  Opt
> & { selfId?: string | null; pinTransform?: (r: string) => unknown };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SelectWithPin = withPinPicker(function _Select<VT = any, Opt extends BaseOptionType = any>(
  props: SelectPropsBase<VT, Opt>,
) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { selfId, pinTransform, ...rest } = props;
  return <Select<VT, Opt> {...(rest as SelectProps<VT, Opt>)} />;
}) as <VT = unknown, Opt extends BaseOptionType = BaseOptionType>(
  p: SelectPropsBase<VT, Opt>,
) => ReactNode;
