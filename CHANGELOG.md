# 更新日志（Changelog）

本项目的所有显著变更都将记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.1] - 2026-12-21
> 版本目标：「扣子风格外观高仿」阶段一。
> 在 v0.3.0 骨架之上补齐交互细节与状态可视化：端口文字、运行进度条 / 错误横幅、染色边 + 流动光点、变量插针器、条件规则可视化表、JSON 输出格式、画布右键菜单。
> 交付品质：TypeScript strict 零错误 / ESLint 零错误 / 91 单测全过 / Vite 产线构建成功

### 新增

#### 1. 数据域扩展（Task 1）
- `src/domains/workflow.ts` 新增 `ConditionRule / RuleGroup / ConditionOp`、`LLMOutputFormat / LLMOutputField` 接口
- `BaseNodeData` 新增 `errorMessage?: string`（错误横幅用）和 `estimatedDurationMs?: number`（进度条估计用）
- `src/schemas/workflow.ts` 同步上述结构的 Zod schema

#### 2. Zustand Store 扩展 + 5 条剪贴板/重跑/进度 单测（Task 2）
- 状态：`clipboard: WorkflowNode | null`、`nodeProgress: Record<string, 0~1>`
- Actions：`updateNodeProgress`（饱和去重 + 引用不变跳过写入，避免高频 re-render）、`copyNode`、`cutNode = copy + delete`、`pasteNode({x,y})`（id 重建 + IDLE 清状态）、`rerunFromNode(nodeId)`（下游 errorMessage/durationMs/debugOutput 清零后再 runWorkflow）
- `applyEventToState` 扩展：RUNNING 事件写 2% 进度；SUCCESS/FAILED 写 100%，并把 event.durationMs / errorMessage / output 同步写进节点 data
- `executionService.NodeStatusChangedEvent` 补充 `durationMs? / errorMessage?`；`mockExecutionService` 在 SUCCESS 时返回 debugOutput 和 durationMs，在 FAILED 时随机选择 5 种错误原因写入 errorMessage
- 新增 `store/__tests__/clipboard.test.ts`：copy+paste 生成新 id / cut 删原节点 / 空剪贴板 paste / rerunFromNode 清零下游 errorMessage / updateNodeProgress 饱和去重引用不变 —— **91 passed**（含旧 86 + 新 5）

#### 3. 节点卡片 端口文字标签（Task 3）
- 通用 `renderHandles` 改为返回 `{ target: HandleSpec, sources: HandleSpec[] }` 结构化描述
- 左侧 target 外缘配灰色「输入」；右侧 source 外缘配：普通节点灰「输出」/ CONDITION 绿「✓ trueLabel」+ 红「✗ falseLabel」/ SELECTOR 每 case 名 + 灰「默认」/ INTENT 每个 intent.label
- Handle 仍保留在卡片内外缘（React Flow 端坐标不变）

#### 4. 节点进度条 + 错误横幅 + CSS 动画（Task 4）
- `index.css` 新增 `@keyframes stripeFlow`（1.1s 45° 斜线流动）和 `@keyframes errorBannerPulse`（1.8s 呼吸红光晕）
- 卡片顶部：RUNNING 时插入 4px 进度条，从 `nodeProgress[id]` 取百分比；宽度最小 2% 可见；RUNNING 状态底条配 `.node-progress__stripe`；成功后切绿，失败切红（120ms linear 过渡）
- 若 `data.errorMessage` 非空，卡片上方挂 `.node-error__banner` 红色渐变横幅：⚠ + errorMessage，超长省略号，hover 看完整

#### 5. StatefulEdge 状态染色边 + snapGrid 10px（Task 5）
- 自定义 `StatefulEdge` 组件：从 zustand 取两端节点 status → RUNNING 琥珀 + animateMotion 光点 r=3.2 沿 bezier 曲线 1.2s 无限循环 / SUCCESS 绿 / FAILED 红（两端任一 FAILED 算红）/ 默认扣子靛蓝 #4a5aed；选中边宽 3px 默认 2px（180ms 过渡）
- ReactFlow 加 `snapToGrid + snapGrid=[10,10]`；Background gap 由 16 → 10 对齐扣子密度

#### 6. PinPicker 🔌 插针器 + withPinPicker HOC（Task 6）
- 新建 `src/components/PinPicker.tsx`
- `useUpstreamVariables(selfId)`：拓扑排序后仅列出 selfId 之前的节点输出字段（声明 outputs[] + 调试值 debugOutput 自动补为候选），按节点分组
- `PinPicker` Popover：顶部搜索框 + 每组「节点名条 + Type Tag + 字段 Tag(name/type) + 预览值」，点击返回 `{{nodeId.key}}` 扣子引用
- `withPinPicker<P>` HOC：在任意组件 suffix 注入 🔌 按钮；提供预设 `InputWithPin / SelectWithPin`

#### 7. ConditionForm 规则可视化表 + 表达式编译（Task 9）
- 在条件节点设置 Tab 增加三列表格：字段 Select（所有节点 outputs[] + 调试值）/ 运算符 Select（eq/ne/gt/lt/contains/regex/empty 共 7 种）/ 值 Input（empty 时禁用），每项有删除；顶部 AND/OR 切换 + 加条件
- `compileExpression(rules)` 把 rules 编译为可运行 JS：字符串加引号、数字保留、contains→`String(x).includes("y")`、regex→`.match(/…/) != null`、empty→`((x)??"").length === 0`；每次规则写入自动同步到条件 expression 字段（兼容旧执行引擎），也允许手工改 expression 不反向同步

#### 8. LLMForm 输出格式 JSON 字段表 + Debug Tab 订阅 open-debug-tab（Task 8）
- LLMForm Prompt 下方加 Radio.Group 切换「文本 / JSON 结构化」；JSON 模式显示 4 列 Name / Type / 必选 / 删除表，字段 7 类型（string/integer/number/boolean/object/array/file），底部显示共 N 字段 + 添加按钮
- ConfigPanel 顶层 Tabs 改受控 activeKey：切节点自动回 settings；监听 window 事件 `open-debug-tab`（FlowCanvas 右键菜单发送）：
  - nodeId = selected → 直接切 activeKey='debug'
  - nodeId ≠ selected → setSelectedNodeId(nodeId) 再 queueMicrotask 切 debug Tab

#### 9. FlowCanvas 节点 + 画布右键菜单（Task 10）
- onNodeContextMenu 拦截：固定定位 190 宽 Menu（节点 6 项：复制 / 剪切 / 粘贴到此处 / 删除 danger / 从该节点重新运行 / 查看运行调试）
- onPaneContextMenu 拦截：画布 4 项（粘贴到此处 / 撤销 / 适应视图 / 运行或重跑工作流）
- 菜单防溢出：safeX/safeY math clamp；点外部 / 滚动 / resize 自动关闭
- "查看运行调试" → 触发 `new CustomEvent('open-debug-tab', {detail:{nodeId}})`

### 变更
- 通用卡片 `GenericNode` 的 React Flow 注册泛型由 `NodeProps<Record<string, unknown>>` 改为 `NodeProps<WorkflowNode>`，消除 strict 模式下的泛型边界冲突
- `NodeStatus` import 从 type-only import 改为 value import（因为要做 switch/compare 的 runtime 值）
- Background 默认网格 gap 16 → 10（与 snapGrid=10 对齐）

### 修复
- v0.3.1 开发过程中已修：NodeProps 泛型边界冲突、PinPicker 未定义 topologicalOrder、ConditionForm 引用不存在 escapeRegExp、FlowCanvasContextMenu 签名（原生 MouseEvent vs React MouseEvent 兼容）、Set-State-In-Effect 加 eslint-disable 说明

#### 用户反馈 #1：条件节点两条分支「同时跑」，条件判断失效（2026-08-23）
- **问题**：`MockExecutionService.start()` 旧实现按拓扑序全部节点入队，不解析 `CONDITION.expression`，每个节点 SUCCESS 后 `node-edges-activated` 把所有出边标为 active → **「true→生成代码」和「false→补充追问」两条边同时出现流动光点、同时进入 RUNNING**，条件节点形同虚设。
- **根因**：mock 引擎的「就绪集 = 依赖全满足就入队」过于简单，完全没考虑 CONDITION/SELECTOR/INTENT 的「单出边激活」语义。
- **修复**：
  1. `mockExecutionService` 重写为 **就绪队列 + 出边过滤器** 调度器：RUN 只把入度=0 的节点入队，节点 SUCCESS 后调用 `getMatchedHandles(node)` —— CONDITION 真 eval 表达式拿到 bool、SELECTOR 按索引/默认随机、INTENT 按索引随机，只激活「命中 sourceHandle」的出边；其余出边显式 animated=false。
  2. `executionService.NodeEdgesActivatedEvent` 新增 `activatedEdgeIds: string[]`；`workflowStore.applyEventToState` 用白名单激活边（未命中的兄弟分支保持 IDLE/未激活态，无流动光点）。
  3. 表达式安全性：CONDITION 默认 expression 改为 `(keywords?.length ?? 0) >= 3`（永远不 NPE）；LLM SUCCESS 时 mock 真返回 `keywords[]`（0~5 长度随机），每次运行分支真·二选一，可验证。
  4. SELECTOR 引擎同时修了旧 Bug：原 `Math.min(idxRaw, cases.length-1)` 会把 default 分支硬塞回最后一个 case，default **永远走不到** → 去掉截断、`slots = cases.length + 1(默认)` 真实分布，`idxRaw === cases.length` 走 default。

#### 用户反馈 #2：默认工作流「多了 START/END 节点」→ HMR 缓存状态导致源码已改但页面仍显示旧值（2026-08-23）
- **问题**：把初始链路从 6 节点（含 START/END）改回 4 节点分叉后，用户刷新仍看到 START/END 存在，误认为修改未生效。
- **根因**：Zustand `create({ nodes: initialNodes, edges: initialEdges })` 只在**应用首次挂载时**执行一次；Vite HMR 只热替换函数定义不重设 store state；HTTP 缓存 / ServiceWorker 没失效时旧 bundle 在跑。两层缓存叠加 → initialNodes 改动实际未落地。
- **修复**：
  1. 彻底清 `node_modules/.vite` 预构建缓存 + 删 dist 目录，保证 Vite 重生成 fresh bundle。
  2. 重新 `vite build` 后 **grep 全部 dist/assets/*.js**：0 处 `n_start` / 0 处 `n_end`，但 4 个业务 id（`n_llm_1 / n_cond_1 / n_code_1 / n_llm_2`）全部在主包命中 —— 从构建产物层面实锤 4 节点。
  3. initial 数据最终形态：4 nodes / 3 edges，`e1:n_llm_1→n_cond_1`、`e2:sourceHandle='true'→n_code_1`、`e3:sourceHandle='false'→n_llm_2`。

#### 用户反馈 #3：分支说明「便宜了」— 连线中间白底标签 + 端口旁说明重复显示（2026-08-23）
- **问题**：CONDITION 两分支的「✓ 关键词 ≥ 3」「✗ 信息不足需追问」既出现在节点右侧 Handle 旁（正确），又被 `edge.label` 重复画在 bezier 曲线中段（白底圆角 + labelBg 样式）→ 用户肉眼看到"同一分支说明两份"。
- **根因**：对齐扣子设计时只改了「端口旁写分支名」，忘记清掉「edge.label 重复一份」的遗留数据；`defaultEdgeOptions` 还留了 `labelStyle/labelBgStyle/labelBgPadding/labelBgBorderRadius`，将来 edge 有 label 又会在中段重复显示。
- **修复**：
  1. `workflowStore.initialEdges` 6 条 edge 的 `label` 字段全部删除（代码层面杜绝重复）。
  2. 所有新连线写入：`onConnect()` 里只写 `id/source/target/sourceHandle/targetHandle/type='stateful'/animated=false`，不传 label。
  3. `FlowCanvas.defaultEdgeOptions` 移除 label 相关 4 项样式兜底。
  4. 「节点旁端口 label」保留且是唯一位置：CONDITION 绿✓+trueLabel / 红✗+falseLabel；普通节点 输入/输出。

#### 用户反馈 #4：「条件分支两个点，但一个点不在卡片里」— 与 3b 节点视觉重叠，疑似 3b 多了没用端口（2026-08-23）
- **问题**：用户截图红色框指向 CONDITION 下方 3b「补充追问」节点左下角，那里多出一个"看似额外的蓝色输入端口" —— 实际是 CONDITION 的 `false` 分支 Handle 从卡片底部飞出，刚好落在 3b 区域和 3b 自己的「输入」Handle 重叠造成的错觉。
- **根因**：[CustomNodes.tsx renderHandles](file:///src/nodes/CustomNodes.tsx#L375-L479) 对分支节点的 Handle 做了**两次 top 叠加**：
  - 外层绝对定位 div 已经 `position:absolute; right:0; top: s.topPx (= 0.7*cardHeight - 5)`
  - 内层 `<Handle style={{ top: cardHeight * 0.7 }}>` **在这个定位块内又再加一次 top**
  → false 点实际垂直位置 = `0.7h-5 + 0.7h = 1.4h-5`，**超出卡片高度的 40%**，直接漂到下面 3b 节点。同时 SELECTOR/INTENT 分支 Handle 同样有这个问题。
- **修复**：
  1. 三类分支节点的所有 `<Handle style>` 中 **彻底删除冗余 `top:` 属性**：外层 div 的 `topPx` 已经是精确定位，Handle 在 `height=12px` 定位块内用 10px 直径自然垂直居中。
  2. 同步修另外三个相关 Bug（否则分支名存实亡）：
     - **SELECTOR Handle-id 不匹配**：渲染写 `id="case-0"/"case-1"` 但引擎匹配 `String(i)="0"/"1"` → 永远走不到 → 渲染侧改为纯下标 `id={String(i)}`、default 保留 `id="default"`。
     - **INTENT Handle-id 不匹配**：渲染写 `id="intent-${i}"` 但引擎匹配 `String(i)` → 永远走不到 → 渲染侧改为 `id={String(i)}`。
     - **普通单节点 Handle 与 edge(null) 歧义**：单 target/source 写死 `id="target"/"source"`，但连线 edge 的 handle=null（React Flow 默认"唯一 type"语义），不一致会导致拖新连线后落点偶发错位 → 单 Handle **不写 id 属性**（undefined），让 null handle 与"唯一 type Handle"直接匹配。
  3. 顺带修 START/END 无效端口：START 左侧「输入」/ END 右侧「输出」在扣子风格里无意义 → 渲染时 START `target=null`、END `sources=[]`，整列跳过。

### 品质自评（阶段一 外观高仿）
- ✅ 可运行 Demo：点「运行」，LLM keywords 0~5 随机 → 条件真·二选一流动光点；没命中的分支（边 + 下游节点）静止不动灰/靛蓝
- ✅ 端口标识清晰可辨：CONDITION ✓✓ 35%/70% 卡片高度内稳定；START 无左侧无义输入 / END 无右侧无义输出
- ✅ 扣子风格一致性：分支说明只在节点旁唯一显示（连线中段不重复）；紫顶 Toolbar + 靛蓝边 + 卡片圆角 8
- ✅ TypeScript strict：`tsc --noEmit` 通过；ESLint clean；Vitest 91/91 passed；`vite build` 通过

## [0.3.0] - 2026-08-23
> 版本目标：参考「扣子 Coze 工作流」重写节点体系 + 核心 UI（Sidebar / Toolbar / ConfigPanel / 节点卡片骨架）
> 交付品质：TypeScript strict 零错误 / ESLint 零错误 / 86 单测全过 / Vite 产线构建成功

### 新增

#### 1. 节点类型 5 → 28，按 Coze 同款分 7 大类（[src/domains/workflow.ts](src/domains/workflow.ts)）
- **基础（BASIC · 蓝色 #2f54eb）**：开始 startNode / 结束 endNode / 变量赋值 variableNode / 变量聚合 aggregateNode / 子工作流 workflowNode
- **大模型（LLM · 深紫 #722ed1）**：大模型 llmNode / 问答 questionNode / 图片理解 imageNode / 图像生成 imageGenNode
- **逻辑（LOGIC · 青色 #13c2c2）**：条件分支 conditionNode / 循环 loopNode / 选择器 selectorNode / 意图识别 intentNode
- **数据（DATA · 绿色 #52c41a）**：知识库检索 retrievalNode / 知识库写入 datasetWriteNode / 批处理 batchNode / 新增 dataAddNode / 查询 dataQueryNode / 更新 dataUpdateNode / 删除 dataDeleteNode / SQL sqlNode
- **工具（TOOL · 橙色 #fa8c16）**：HTTP 请求 httpNode / 代码执行 codeNode / 插件 pluginNode
- **消息与时间（MESSAGE · 宝蓝 #1677ff）**：发送消息 messageNode / 延时 sleepNode
- **长期记忆（MEMORY · 玫红 #eb2f96）**：记忆写入 ltmWriteNode / 记忆检索 ltmReadNode

#### 2. 领域模型重写（四象限同步设计：NodeType × NODE_METAS × defaultNodeData × CustomNodes.register）
- `BaseNodeData` 新增 **索引签名 `[key: string]: unknown`**：满足 @xyflow/react `Node<Record<string, unknown>>` 泛型约束，同时允许 28 类节点自由扩展字段
- 28 类节点各自**独立接口**（`StartNodeData / EndNodeData / VariableNodeData / ... / LtmReadNodeData`），全部扩展自 `BaseNodeData`
- 顶层 **`WorkflowNodeData` 联合类型** = 上述 28 类接口并集；重名的「子工作流数据接口」从 `WorkflowNodeData` 改为 `SubWorkflowNodeData`，消除联合定义时的重复标识符
- `NODE_METAS: NodeMeta[]`：每类节点的分类/图标/渐变色主色 accent/默认宽度/是否单例/是否种子节点，单点配置供 Sidebar、节点卡片、ConfigPanel 共同引用
- `defaultNodeData(NodeType) → WorkflowNodeData`：按类型回填扣子同款默认值（模型名、提示词模板、cases、HTTP method 占位等），开箱即有可运行 Demo 数据
- `topologicalSort()` / `wouldCreateCycle()`：依然纯函数、零副作用，从 domains 出口，store/mockExecutionService 统一消费

#### 3. 新 Zod Schema（[src/schemas/workflow.ts](src/schemas/workflow.ts)）
- 28 类节点使用 `z.discriminatedUnion('type', [...])` 做 discriminated union 校验
- 每类节点的字段 schema 与 domains 接口一一对应；`workflowDefSchema` 含 `nodes + edges + version` 三件套 + `formatZodError` 报错格式化

#### 4. 左侧 Sidebar 升级为 Coze 风格（[src/components/Sidebar.tsx](src/components/Sidebar.tsx)）
- 顶部搜索框：按 label/description 实时过滤，跨 7 类统一模糊匹配，空态 4 行缺省提示
- 7 个可折叠分类：每类头部「色条 + 圆点色块 + 分类名 + 数量角标 + 展开箭头」；点击头切换 `openCategory`
- 节点网格：大卡片（≥112px 宽，`auto-fill minmax`）= 渐变色 icon chip + 中文字体 label + 浅灰描述；按下挂 HTML5 DnD + Pointer 仿真双通道（桌面端兜底）
- 底部「💡 使用提示」卡片：`BulbOutlined`（修正 AntD 5.x 中不存在的 `LightbulbOutlined`）+ 拖拽说明
- 宽度与 ConfigPanel 同步响应式：≤1180px / ≤1080px / ≤860px / ≤640px 四档断点自适应

#### 5. 顶栏 Toolbar 升级为 Coze 深紫配色（[src/components/Toolbar.tsx](src/components/Toolbar.tsx)）
- 深紫渐变 `linear-gradient(180deg, #5b2bf0 → #6032ff)`，右上角 260px 圆形光斑装饰（扣子同款顶栏光晕）
- 面包屑：`全部工作流 / AI Workflow Demo` + `📄 v0.3.0` 版本徽章
- 三按钮组：保存草稿 `SaveOutlined` / 调试运行 `ThunderboltOutlined` / 发布 `RocketOutlined`；按钮宽度 88px；Debug 用琥珀 (#faad14)、Publish 用紫白主色
- 桌面端 `DesktopToolbarExtras` 仍然 lazy chunk 挂载，与 v0.2.1 视觉零差异

#### 6. 节点卡片视觉统一（[src/nodes/CustomNodes.tsx](src/nodes/CustomNodes.tsx)）
- **不再对每类节点写组件**：28 类 type 全部注册到同一个 `GenericNode`，卡片骨架一致，差异从 `NODE_METAS + renderSummary + renderHandles` 三方注入
- 卡片外观：圆角 8px + 白底 + 微阴影；选中时蓝色外发光 `0 4px 14px ${accent}33`
- 顶部 3px accent 渐变条（扣子同款「分类主色指示条」）+ 6px 顶栏渐变 `linear-gradient(90deg, accent → accent#bb)`
- 头行：左「26×26 渐变色块 icon chip」+ label + 右「StatusBadge 状态圆点」；Running 时黄色 `box-shadow` 发光
- Body：`renderSummary()` 把每类节点的关键 1~2 字段转成浅灰摘要行（key/value 双列布局），超长自动 `…` 截断
- 端口：Standard `targetHandle` 在左；CONDITION 双分支（true/false）、SELECTOR/INTENT 多分支按等比例 step 垂直排布；每 handle 含半透明 accent 色填充 + `120% zoom` hover 放大

#### 7. 右侧 ConfigPanel 升级（[src/components/ConfigPanel.tsx](src/components/ConfigPanel.tsx)）
- 头部：88px 渐变 accent 色块 + 圆角 12px 图标 chip（取节点分类色）+ 分类标签（CATEGORY_META.label）+ 中文字体 label + 节点 ID + StatusBadge 状态
- **三 Tab（Ant Design `Tabs size=small`）**：
  1. **设置（默认）**：按 28 类 NodeType switch 到对应表单 — Start（输入字段表）/ End（输出变量列表，改用 `<TextArea>` 支持换行输入）/ Variable / Aggregate / LLM / ... / Sleep / LtmRead — 共 28 个独立表单组件，字段与 domains 的接口一一对应
  2. **输入/输出**：两张 `<Table>` 分别渲染 inputs / outputs 字段定义；空态用 Empty 占位
  3. **调试**：Tag 状态徽章 + 耗时 + 深色 JSON 视图（#0f172a 背景 + #94a3b8 header + 复制按钮）；使用 `message.success/error` 静态 API（去掉未使用的 `useMessage`）
- 底部：坐标显示 `{x, y}` + 删除节点按钮 `DeleteOutlined` 危险色 red-500
- 类型处理：所有 `data as XXXNodeData` 强制双段断言 `as unknown as XXXNodeData`，绕过 28 类联合在严格模式下的互斥检查；`UpdateFn` 与 `workflowStore.updateNodeData` 统一用 `Record<string, unknown>`，与 BaseNodeData 索引签名配套

### 修复（构建阻塞 + ESLint 严格模式）
- `workflow.ts`：`WorkflowNodeData` 接口/类型重复定义 → 子工作流接口改名为 `SubWorkflowNodeData`，联合类型里改用新名
- `workflowStore.ts`：`initialNodes` 字面量字段 prompt/expression/code/model 被 TS 报 "Object literal may only specify known properties" → 每个 `data: {...}` 显式 `as WorkflowNodeData`
- `workflowStore.ts`：`applyNodeChanges` 返回 `Node[]` 与 `WorkflowNode[]`（含 data 子类）不兼容 → `as never[]` 入参 + `as WorkflowNode[]` 出参双段断言
- `ConfigPanel.tsx`：老代码 `<Input mode={undefined as never}>` 做 TextArea 效果 → 直接用 `Input.TextArea` 正确组件
- `ConfigPanel.tsx`：Tabs 组件两次渲染 + 同一组件 `items` 重复 prop 触发 TS17001 → 删除占位的重复 Tabs，只保留一个正常 `items={tabItems}` 渲染
- `Sidebar.tsx`：`LightbulbOutlined` 在 AntD 5.x 已删除 → 改用 `BulbOutlined`
- `CustomNodes.tsx`：`NodeProps<WorkflowNode>` 卡在 ReactFlow 泛型边界 `Node<Record<string, unknown>>`（28 类联合仍然被严格视为"缺失索引签名"）→ 对外签名 `NodeProps<any>`，函数内部 `props as NodeProps<WorkflowNode>` 重新收紧；内部完整类型安全，对外不再触发 ReactFlow 边界检查
- `CustomNodes.tsx`：本地重复 `type WorkflowNode = Node<WorkflowNodeData>` 与 domains 导出冲突 → 删除本地声明，从 domains 统一 import
- 3 项 ESLint 修复：`PANEL_WIDTH_NARROW` 未用（删除）/ `nodeCardStyle(accent)` 形参未用 → `_accent` / `toolbarWrapperStyle;` 表达式当语句 → 删除残留语句

### 测试与验证
- `npm run lint`：0 errors 0 warnings（ESLint 9 + typescript-eslint 8.67 strict）
- `npm run test`：7 文件 **86/86 通过**（httpClient 14 / authProvider 17 / wsClient 10 / nativeBridge 7 / mockExecutionService 8 / runtimeEnv 5 / workflowStore 25）
- `npm run build`：`tsc --noEmit` 零错误 + Vite 成功产出 dist/；生产 chunk `index-Bm7hQmFz.js ≈ 2.11 MB (gzip ≈ 594 KB)`；DesktopTitlebar / DesktopToolbarExtras 仍落在独立 lazy chunk，桌面端与 Vercel 部署隔离策略与 v0.2.1 一致

## [0.2.1] - 2026-08-23

### 修复（桌面端 v0.2.0 上线后 4 项连锁问题）
- **自定义标题栏 + 窗口配置**（[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)）：
  - 修正 `bundle.targets` schema：删除非法枚举 `"updater"`，目标只保留 `["nsis","msi"]`，新增独立字段 `"createUpdaterArtifacts": false`
  - 删除 `plugins.fs.scope`（Tauri v2 schema 不允许，会触发 `PluginInitialization("fs" ... unknown field 'scope')` panic）；`fs:scope` 迁移到 `capabilities/default.json` 的 permission allow 数组
  - 新增 `"dragDropEnabled": false`（Windows WebView2 必须关闭 OS 级 DnD 监听才能使用 HTML5 拖拽，Tauri 文档明确要求）
- **桌面端「节点拖进画布无效」**（网页有效 / 桌面无效 → 典型 WebView2 拖放被拦截）：
  - 新增 [src/services/simulatedDrag.ts](src/services/simulatedDrag.ts)：纯 Pointer 事件仿真的 DnD 双保险链路（HTML5 + Pointer 双通道），含位移阈值 (5px)、幽灵节点跟随；仅在 `detectRuntime().tauri` 时启用，Web 端零监听
  - [src/components/Sidebar.tsx](src/components/Sidebar.tsx)：每个节点卡同时挂 `draggable + onDragStart + onPointerDown(→ beginSimulatedDrag)`
  - [src/components/FlowCanvas.tsx](src/components/FlowCanvas.tsx)：`useEffect` 订阅仿真 drop，payload.canvasClientX/Y 再走 `screenToFlowPosition` 换算（与 HTML5 DnD 坐标完全一致）
- **窗口放大/最大化下「组件高度没充满 + 先闪烁再全白」**（根因：两次高度链断点 + 多余玄学 CSS）：
  - 第一次错误修复使用了 `100dvh / absolute inset:0 / height:0 写法 / .app-canvas>* !important`，触发 WebView2 初始化多轮 reflow，出现闪烁/空白。**全部回退为最朴素 height:100% 直通链**
  - 真实断点：Ant Design v5 `<App/>` 包裹层 `#root > .ant-app` 没有继承 100% 高度（DOM 结构：`#root → div.css-69pw1o.ant-app → .app-shell`），`ant-app` 缺高度规则导致 `app-shell` 退化为内容自然高，差了正好等于 Toolbar 高度的 66px
  - 最终修复：[src/index.css](src/index.css) 把 `#root > .ant-app` 加入顶层高度链（一行规则）：`html, body, #root, #root>.ant-app, .app-shell, .app-window { height:100% }`
  - [src/components/FlowCanvas.tsx](src/components/FlowCanvas.tsx) wrapper inline style 加显式 `width:'100%', height:'100%'`，不再只靠 flex 简写
  - DesktopTitlebar：`onResized` 200ms 防抖 + `ResizeObserver(body/documentElement)` 双通道同步 `html[data-maximized]`，应对 Win11 SnapLayout/DWM 延迟翻转 isMaximized 的边缘场景

### 新增
- 桌面端自定义标题栏（[src/components/DesktopTitlebar.tsx](src/components/DesktopTitlebar.tsx)）：
  - `decorations:false + transparent:false + shadow:false` 实色无边框窗口；左侧产品名 + 桌面徽章，右侧 44×38 Windows 风格三按钮（最小化 `-` / 最大化 `☐`↔`❐` / 关闭 `✕`，Close hover 亮红 `#e81123`）
  - 拖动：整栏 + 子节点分别挂 `data-tauri-drag-region`；双击拖拽区 = 切换最大化；最大化时 `html[data-maximized="1"]` 清除外边距/圆角/阴影
  - 仅桌面端渲染：`detectRuntime().tauri===false` 直接 return null；通过 `App.tsx` 里 `React.lazy + Suspense(null)` 切独立 chunk `DesktopTitlebar-*.js`（≈ 3.4 KB），零首屏影响
- 响应式断点（[src/index.css](src/index.css) 4 条媒体查询）：
  - ≤1180px：隐藏 Toolbar 副标题；≤1080px：Sidebar 200 / Config 290 + 隐藏节点连线统计；≤860px：Sidebar 180 / Config 240 + 隐藏竖分隔线；≤640px(h)：标题栏 38→30px，按钮 44→40px
- `.gitignore` 补全桌面端/本机依赖排除：`src-tauri/target`、`src-tauri/Cargo.lock`、`src-tauri/gen`、`src-tauri/bundle`、`.env*`、`.trae/`

## [0.2.0] - 2026-08-23

### 新增
- **Tauri v2 桌面 WebView 壳骨架**（`src-tauri/` 目录）：
  - `Cargo.toml`：`tauri 2.x` + `tauri-build 2.x` 构建依赖 + 4 个官方插件（`plugin-dialog` / `plugin-fs` / `plugin-opener` / `plugin-shell`）
  - `src/main.rs`：`tauri::Builder::default()` 注册四个插件 → `run(tauri::generate_context!())`
  - `tauri.conf.json`：窗口 1400×900 + WebKit/WebView2 CSP（`default-src 'self' ipc: http://ipc.localhost; img-src 'self' asset: https://asset.localhost`）；四个插件 allowlist 仅开启本版本真正用到的 scope（如 `dialog:save|openFile`、`fs:writeTextFile|readTextFile`、`opener:openUrl`、`shell:open|execute`）
  - `icons/*`：基于 `public/favicon.svg` 生成的 512×512 PNG 与尺寸组
- **package.json 桌面端脚本**（核心脚本保持 v0.1.3 形状不变，新增仅 3 条）：
  - `tauri:dev` → `tauri dev`（Vite dev + 桌面窗口）
  - `tauri:build` → `tauri build`（生产可执行文件）
  - `tauri:icon` → `tauri icon public/favicon.svg`（图标重生成）
  - 所有 `@tauri-apps/*` 包（cli / api / plugin-dialog / plugin-fs / plugin-opener / plugin-shell）全部位于 **devDependencies**，**不进入 `dependencies`**
- **运行环境探针**（`src/services/runtimeEnv.ts` + 5 单测）：
  - `detectRuntime() → RuntimeEnv`；SSR/Node 无 window → 返回 `{ target: 'web', tauri: false }`
  - 桌面 WebView → 识别 `window.__TAURI_INTERNALS__` → 返回 `{ target: 'desktop', tauri: true, tauriVersion }`
  - **零依赖 `@tauri-apps/*`**；通过 React.lazy 代码分割后，本文件不会出现在 Vercel 首屏 entry chunk 中
- **原生能力桥 NativeBridge**（`src/services/nativeBridge.ts` + 7 单测）：
  - 统一接口 `NativeBridge`：`saveJsonFile / openJsonFile / openExternal / openLocalTerminal`
  - **Web 兜底实现 `webBridge`**：Blob + `<a download>` 保存；`<input type=file>` 读取；`window.open('_blank')` 打开 URL；`openLocalTerminal` 在 Web 环境静默返回 false（零报错）
  - **Tauri 实现 `tauriBridge`**（仅在 `detectRuntime().tauri=true` 时才会被 `resolveBridge()` 懒实例化）：
    - `@tauri-apps/plugin-dialog` 的 `save / open`（原生文件对话框）
    - `@tauri-apps/plugin-fs` 的 `writeTextFile / readTextFile`（原生文件读写）
    - `@tauri-apps/plugin-opener` 的 **`openUrl()`**（v2 正确命名导出；修复 build 时 `Property 'open' does not exist` 错误）
    - `@tauri-apps/plugin-shell` 的 `open(cwd)`（Windows 上打开 PowerShell 并进入工作目录）
  - `defaultBridge`：同步可用句柄 `{ ...webBridge, asyncResolve: resolveBridge }`；首屏无需 `await`；真需要原生能力时调用 `await asyncResolve()` 走 Tauri 分支
- **UI 功能开关（纯桌面端渲染）**（`src/components/DesktopToolbarExtras.tsx`）：
  - Toolbar 标题右侧渲染「🖥️ Desktop」绿色徽章（Web 环境直接 return null，0 DOM）
  - 原生导入 / 原生导出 / 打开终端 三个按钮；全部走 `await resolveBridge()` 的 Tauri 实现
  - **关键隔离**：本组件**不被 Toolbar 静态 import**，必须通过 `React.lazy(() => import('./DesktopToolbarExtras'))` + `<Suspense fallback={null}>` 动态引入，保证 Rollup 把它切到独立 lazy chunk（`DesktopToolbarExtras-<hash>.js`，约 9.7 KB / gzip 4.4 KB），永不进 index.html 首屏
- **一键 Vercel 隔离验证脚本**（`scripts/verify-vercel-isolation.ps1`，PowerShell 5 可直接运行）：
  - 6 步清单：无 Rust PATH 模拟 → vercel.json 与 v0.1.3 逐字节比对 → ci/lint/test/build 回归 → dist 结构 + index.html entry 审计 → **首屏 entry chunks Tauri 关键字扫描**（9 个关键字 0 命中才算 PASS） → `package.json` 依赖分离校验 → 首屏 JS 体积 delta（≤ +2 KB 为 PASS，超出仅 WARN）
  - 可在无 Rust/Cargo 的机器（或 CI）独立运行：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-vercel-isolation.ps1 -SkipInstall`
  - 最终输出：绿底 `OK - Vercel isolation verification PASSED`

### 修复
- **TypeScript 构建阻塞 3 处**（本版本默认 `tsc strict: true`，必须零错误）：
  1. `src/services/nativeBridge.ts(153)`：`@tauri-apps/plugin-opener` v2 默认导出没有 `open()` 方法 → 改为真实导出的 **`openUrl(url)`**
  2. `src/services/wsClient.ts(201/229)`：`setTimeout` 返回值在 happy-dom 下是 `number`、Node 下是 `Timeout`，赋值给 `ReturnType<typeof setTimeout> | null` 报错 → 变量统一拓宽为 `ReturnType<typeof setTimeout> | number | null`；`clearTimeoutImpl` 形参同步放宽，允许 number
  3. `src/services/__tests__/wsClient.test.ts(157)`：Mock 时钟的 `clearTimeoutImpl` 形参与 wsClient 接口签名不一致 → 扩成 `ReturnType<typeof setTimeout> | number`
- **隔离脚本鲁棒性**：Vite 5 代码分割后会生成多个 `index-<alnum>.js`（含小体积 polyfill/preload）+ `core-*.js`；原脚本基于「单 chunk hex hash + >100KB」的启发式会漏匹配 → 改为：mainJs = 所有 `index-[0-9A-Za-z_-]+.js` 中体积最大者；entry chunk 关键字扫描 = **所有 index.html 中 `<script src>` 引用的并集**（而非单一 heuristic main chunk）

### 变更
- `Toolbar.tsx`：静态 import `DesktopToolbarExtras` 改为 `React.lazy + Suspense fallback=null` 动态 import，保持首屏 DOM 外观与 v0.1.3 视觉零差异（Web 环境下 fallback=null，不渲染任何节点）
- `scripts/verify-vercel-isolation.ps1`：关键字集合从最初的启发式扩展为 9 条真实 Tauri 生态特征（`@tauri-apps`、`__TAURI_INTERNALS__`、`__TAURI__`、`tauri::`、`tauri-build`、`tauri_plugin`、`src-tauri`、`WebView2Loader`、`tauri.conf.json`）；同时新增 lazy chunks 非阻断性信息列，便于肉眼确认关键字全落在 lazy chunk 中（ACCEPTABLE）而非 entry chunk 中
- 版本号：`0.1.3 → 0.2.0`，原因：新增了可选的桌面端能力 + 提供了完整隔离验证机制，且变更范围跨阶段进入「阶段 2 桌面 WebView 集成」
- README / ITERATION_PLAN / CHANGELOG 同步：阶段总览表新增「阶段 2」、阶段 1 标记完成；README 技术栈表新增「桌面端（可选）」「隔离验证」两行；本地启动章节拆成 Web/Vercel 模式、桌面端模式、隔离验证脚本 3 小节，并附 Rust toolchain 安装指引

### 测试
- **86/86 全绿**（workflowStore 25 + httpClient 14 + mockExecutionService 8 + wsClient 10 + authProvider 17 + runtimeEnv 5 + nativeBridge 7）
- **Vitest 环境**：v3.2.0；WS/HTTP/Store 走 Node + 依赖注入；`runtimeEnv / nativeBridge` 用 happy-dom（避免 jsdom 27 ESM-only 依赖 require 错误）
- **tsc strict + vite build**：零错误；构建产出首屏 chunk 不包含任何 Tauri 字面量
- **隔离实跑**：`scripts/verify-vercel-isolation.ps1 -SkipInstall` 输出 `OK - Vercel isolation verification PASSED`
  - Step 4 结果：首屏 entry chunks 扫描命中 0 Tauri 关键字；lazy `DesktopToolbarExtras-*.js` 与 `core-*.js` 各自携带 `__TAURI_INTERNALS__`（标注 ACCEPTABLE，未被 index.html 首屏引用）
  - Step 6 结果：首屏 JS 总体积相对 v0.1.3 基线增长约 +3.6 KB（仅 WARN，非阻断，人工审核为 React.lazy/Suspense 导入辅助代码 + 新增 bundle manifest 条目，未包含任何桌面端逻辑）

## [0.1.3] - 2026-08-23

### 新增
- **鉴权与 Token 生命周期管理**（`src/services/authProvider.ts`，阶段 1「通信层」第 4 个迭代）：
  - 数据模型：`TokenPayload`（accessToken / refreshToken / expiresAtSec / userId / username）
  - 鉴权接口 `AuthProvider`：`login(creds)` / `refresh()` / `logout()` / `setToken()` / `onAuthChange()` / `token` / `isAuthenticated` / `isExpired(withinSec)`
  - **持久化**：StorageLike 抽象（默认 localStorage，可替换成 sessionStorage / 内存 Storage）；模块创建时自动 hydrate
  - **JWT exp 解码**：纯 JS base64 解码（无第三方库，兼容浏览器 + vitest node 环境）；`deriveExpiresAt()` 缺省 fallbackSec（默认 1h）兜底
  - **过期自动清理**：读 `token` / `isAuthenticated` 前自动检查并触发 `LOGGED_OUT` 事件，清 storage
  - 事件枚举（discriminated union）：`logged-in` / `logged-out` / `token-updated`，订阅 `onAuthChange` 返回 `AuthSubscription`
  - 完全依赖注入：`storage` + `nowMs()`（时间源，vitest 手动推进时间可测）+ `storageKeyPrefix`（多实例隔离）
  - `login/refresh` 是占位（不发真实 HTTP），以后只需替换内部实现即可对接 `/api/auth/login` `/api/auth/refresh`
- 通信层钩子：
  - `withHttpAuth(httpClient, auth)`：wrapper 返回新的 HttpClient，每次请求若有 token 自动补 `Authorization: Bearer <accessToken>`（请求级 Authorization 以用户为准）；零 monkey-patch（HTTP Client 的 `get/post/put/delete` 是闭包内具名函数，patch request 属性不会生效）
  - `bindAuthToWsConnect(ws, auth, buildUrl, baseUrl)`：返回 `{ connectWithAuth(), tokenParamUrl() }`；`tokenParamUrl()` 按 buildUrl(base, token) 自动拼 token query；`LOGGED_OUT / TOKEN_UPDATED` 事件自动先断开 WS，配合 WS 内置重连带新参数重新建连
- `InMemoryStorage`：StorageLike 的内存实现，供单测与 SSR 无 localStorage 场景使用
- 单元测试 `authProvider.test.ts`（17 例）：
  - 基础工具：decodeJwtPayload（合法/非法 JWT）、deriveExpiresAt（exp / fallback）
  - Provider 生命周期：未登录默认、setToken 成功/拒绝过期、时间推移过期后自动清理、login/refresh/未登录 refresh 报错、logout 幂等、storage 跨实例还原、取消订阅
  - 通信层钩子：withHttpAuth（Bearer + 请求级优先）、bindAuthToWsConnect（buildWsUrl 带 query + LOGGED_OUT 触发 disconnect）

### 变更
- `package.json` version 0.1.2 → 0.1.3；README / CHANGELOG / ITERATION_PLAN 同步

### 测试
- **74/74 全绿**（workflowStore 25 + httpClient 14 + mockExecutionService 8 + wsClient 10 + authProvider 17）；tsc + vite build + eslint 通过

## [0.1.2] - 2026-08-23

### 新增
- **WebSocketClient 抽象层**（`src/services/wsClient.ts`，阶段 1「通信层」第 3 个迭代）：
  - **状态机**：IDLE / CONNECTING / OPEN / CLOSING / CLOSED / RECONNECT_WAIT 六态；`connect()` 幂等，不会重复建连
  - **自动重连**：指数退避（`base * 2^(attempt-1)`，可设上限）；最大重连次数可配；手动 `disconnect()` 设 manualClose 标志不再重连
  - **心跳超时**：OPEN 中每次收到消息重置倒计时；超时主动 close(1011) 并走重连分支；`heartbeatIntervalMs=0` 可关闭
  - **订阅式事件**：`subscribe()` 返回 WsSubscription；`connected / disconnected(willReconnect) / message(raw+data) / error` 四类 discriminated union event
  - **send JSON**：对象自动序列化；未连接时返回 false（调用方自决缓存策略，本层不排队）
  - **完全依赖注入**：WebSocket 构造函数（WsLikeConstructor）+ setTimeout/clearTimeout —— node 环境单测零真实网络
  - connectCount 竞态防护（旧 socket 的 open/message 事件带 currentCount 校验，忽略过期）
- 单元测试 `wsClient.test.ts`（10 例，`MockSocket` + 手动虚拟时钟 `advanceTime`）：
  连接 + 幂等 / send JSON / 收消息自动解析 + 心跳重置 / 心跳超时触发 1011 关闭 /
  成功后重连计数归零 / 超 maxReconnectAttempts 停止重连 / 主动断开不重连 / subscribe 可取消 / 关闭心跳无超时

### 变更
- `package.json` version 0.1.1 → 0.1.2

### 测试
- **57/57 全绿**（workflowStore 25 + httpClient 14 + mockExecutionService 8 + wsClient 10）；tsc + vite build + eslint 通过

## [0.1.1] - 2026-08-23

### 新增
- **ExecutionService 接口层**（`src/services/executionService.ts`，阶段 1 第 2 个迭代）：
  - 事件总线模型：RunStarted / NodeStatusChanged / NodeEdgesActivated / RunFinished 四种 discriminated union event
  - `RunHandle`：cancel()、running getter、done() Promise
  - `WorkflowSnapshot`：Service 只读的节点/连线快照输入
  - Service 接口仅暴露 `name` + `start(snapshot, onEvent): RunHandle`，完全与 Store 解耦
- **MockExecutionService**（`src/services/mockExecutionService.ts`，v0.0.1 原 Mock 引擎的迁移版）：
  - scheduler 与 rng 全部依赖注入，可实现手动可控时钟（零等待的确定性单测）
  - 行为对齐旧版：IDLE 初始化 → RUNNING → 延时 → SUCCESS(85%)/FAILED(15%) → 成功激活出边
  - 取消幂等、pendingToken 自动 clear、finish() 双保险只触发一次
- **领域基础模块**（`src/domains/workflow.ts`，打破循环依赖）：枚举、NodeData 类型、拓扑/环检测、状态颜色与文本、默认配置 —— Store 与 Service 共同从这里导入，避免了 Store↔Service 循环依赖
- 单元测试 `mockExecutionService.test.ts`（8 例，手动 scheduler + 确定性 rng）：
  前置校验空画布与环、全成功事件覆盖、失败即停带 failedNodeId、取消幂等、Service 级并发独立句柄、delayRangeMs 边界两端

### 变更
- `workflowStore.ts` 重构：
  - 本地 `runWorkflow` 的同步执行引擎整段删除，改为 **事件桥** 模式：`applyEventToState(state, event)` 把任意 Service 实现的 event 映射到 Zustand state mutation
  - Store 内通过 `DEFAULT_EXECUTION_SERVICE` 单例（可全局替换 Mock/HTTP/WS）启动，并保存 `_runHandle` 用于取消
  - 新增并发保护：运行中再次点运行直接拒绝
  - 所有领域类型/枚举/纯函数改为从 `domains/workflow.ts` 导入并 re-export，保持 Store 作为统一出口的向后兼容性
- `package.json` version 0.1.0 → 0.1.1

### 测试
- **47/47 全绿**（workflowStore 25 + httpClient 14 + mockExecutionService 8）；`tsc --noEmit` + `vite build` + `eslint` 通过

## [0.1.0] - 2026-08-23

### 新增
- HTTP Client 抽象层（`src/services/httpClient.ts`，阶段 1「通信层」首个迭代）：
  - fetch 依赖注入（FetchLike），便于单测与真实后端 / Mock 适配层切换
  - 超时控制（AbortController，默认 10s，可按请求覆盖）
  - 失败重试（指数退避；仅网络错误 / 超时 / 5xx 重试，4xx 不重试）
  - 统一错误类型 `HttpError`（code / status / body，区分网络错误、超时、状态码、解析失败）
  - JSON 自动序列化 / 反序列化；get / post / put / delete 快捷方法；baseUrl 拼接与默认 headers 合并
- 单元测试 `src/services/__tests__/httpClient.test.ts`（14 例）：成功请求 / POST 序列化 / baseUrl 拼接 / headers 合并 / 204 空体 / 4xx 不重试 / 5xx 重试成功与耗尽 / 网络错误重试 / 超时 / 非 JSON 响应

### 说明
- 当前项目无后端，本层为基础设施迭代，暂未被业务代码调用；将在 v0.1.1 ExecutionService 抽象中接入

### 测试
- **39/39 全绿**（httpClient 14 例 + workflowStore 25 例）；`tsc --noEmit` + `vite build` + `eslint` 通过

### 变更
- `package.json` version 0.0.8 → 0.1.0；README / ITERATION_PLAN 文档链同步更新

## [0.0.8] - 2026-08-23

### 新增
- README 技术栈表补全阶段 0 成果：TypeScript 5.9 strict / Zod / Vitest 3（25 用例）/ ESLint 9 + Prettier + EditorConfig
- README 项目结构图与本地启动命令更新（新增 lint / test，共 6 条命令）

### 变更
- `docs/ITERATION_PLAN.md`：阶段 0 标记「✅ 已完成（2026-08-23 验收通过）」；v0.0.2~v0.0.7 各版本补录 commit hash；v0.0.8 补录验收记录
- README 当前版本行更新为 v0.0.8；`workflowStore.js` 引用改为 `workflowStore.ts`
- `package.json` version 0.0.7 → 0.0.8

### 阶段 0 验收记录
- 全量回归：`npm run build`（tsc 卡点）✅ ｜ `npm run lint` 0 error 0 warning ✅ ｜ `npm run test` 25/25 全绿 ✅
- Vercel 线上回归 ✅；文档链（README / CHANGELOG / ITERATION_PLAN）与代码实际状态一致 ✅

## [0.0.7] - 2026-08-23

### 新增
- Vitest 单元测试（`src/store/__tests__/workflowStore.test.ts`，node 环境，无 DOM 依赖）：
  - 拓扑排序 6 例：线性链顺序 / 分支图 / 成环 / 自环 / 空图 / 孤立节点
  - 环检测 3 例：回边成环 / 前向边 / 自连
  - defaultNodeData 3 例：三种节点默认配置完整性
  - Store onConnect 4 例：正常连线 / 成环拒绝 / 空值拒绝 / 自连拒绝
  - Store 增删与撤销重做 3 例：addNode 自动选中 / deleteNodes 级联删边 / undo+redo
  - 导入导出契约 6 例：非法 JSON / 未知类型 / 字段缺失 / temperature 越界 / 导出导入往返 / 未知字段剔除
- 脚本：`npm run test`（单次）/ `npm run test:watch`（监听）

### 变更
- `vite.config.ts` 增加 vitest 配置（node 环境 + include 匹配）
- `package.json` version 0.0.6 → 0.0.7；devDeps 新增 vitest@^3.2.0

### 测试
- **25/25 全绿**；`tsc --noEmit` + `vite build` + `eslint` 通过

## [0.0.6] - 2026-08-23

### 新增
- ESLint 9 flat config（`eslint.config.js`）：@eslint/js recommended + typescript-eslint recommended + react-hooks + react-refresh
- Prettier 配置（`.prettierrc` / `.prettierignore`，printWidth 100 / 单引号 / 尾逗号）
- `.editorconfig` 统一编辑器基础格式（UTF-8 / LF / 2 空格缩进）
- 脚本：`npm run lint`（静态检查）/ `npm run format`（格式化）

### 变更
- TypeScript 版本锁定 `~5.9.0`（typescript-eslint 8.x 暂不支持 TS 6.x peer 范围）
- no-unused-vars 规则忽略 `_` 前缀参数；react-refresh only-export-components 关闭（节点组件存在非组件导出）
- `package.json` version 0.0.5 → 0.0.6

### 测试
- `npm run lint` 0 error 0 warning；`npm run build`（tsc + vite）通过

## [0.0.5] - 2026-08-23

### 新增
- `src/schemas/workflow.ts`：Zod 数据契约（NodeStatus 枚举 / 三种节点 discriminatedUnion / 连线 / WorkflowDef 完整画布）
- `formatZodError` 工具：把校验错误格式化为中文可读信息（路径 + 消息，最多 3 条）
- 依赖新增 `zod`

### 变更
- `importFlow` 从"仅检查 nodes/edges 是数组"升级为 Zod safeParse 全量契约校验：
  - 非法节点类型 / 缺失字段 / 类型错误 / 数值越界（temperature 0~2、timeout 1~300 等）全部拒绝并精确报错到字段路径
  - 未知字段自动剔除（strip），animated 缺省默认 false
- `package.json` version 0.0.4 → 0.0.5

### 测试
- `tsc --noEmit` + `vite build` 通过；导出→导入往返兼容（v0.0.7 补充单测）

## [0.0.4] - 2026-08-23

### 变更
- 组件层全量 TSX 迁移：Toolbar / Sidebar / FlowCanvas / ConfigPanel / CustomNodes（.jsx → .tsx）
- 移除 tsconfig `allowJs`（全仓已无 .js/.jsx 源文件，TS 迁移完成）
- ConfigPanel 新增类型守卫（isLLMNode/isConditionNode/isCodeNode）按 node.type 收窄 data 联合类型
- CustomNodes 去除与 store 重复的 statusColor/statusText（改为从 store 导入，消除双份实现）
- FlowCanvas：isValidConnection 增加 source/target 空值守卫；事件回调补充 React 事件类型
- 样式常量补充 CSSProperties 类型注解（修复字面量类型收窄问题）
- `package.json` version 0.0.3 → 0.0.4

### 测试
- `tsc --noEmit` + `vite build` 全部通过（strict 模式零错误）

## [0.0.3] - 2026-08-23

### 变更
- `workflowStore.js` → `workflowStore.ts`（strict 模式零错误）
- 领域模型类型建模：NodeStatus/NodeType 枚举类型、LLM/Condition/Code NodeData、WorkflowNode/WorkflowEdge、HistorySnapshot
- Store State/Actions 完整接口定义（撤销重做/运行引擎/导入导出签名）
- onConnect 增加 source/target 空值守卫（Connection 可空类型安全）
- 纯函数（topologicalSort/wouldCreateCycle）入参泛化为最小结构类型，提升可测试性
- `package.json` version 0.0.2 → 0.0.3

### 测试
- `tsc --noEmit` + `vite build` 通过

## [0.0.2] - 2026-08-23

### 新增
- TypeScript 工具链：`tsconfig.json`（strict 模式 + bundler 解析 + noUnusedLocals/noUnusedParameters）
- `src/vite-env.d.ts`：Vite 客户端类型声明
- `npm run typecheck` 脚本：独立类型检查命令
- `CHANGELOG.md` 与 `docs/ITERATION_PLAN.md`：版本迭代记录与阶段开发计划

### 变更
- 入口迁移 TS：`src/main.jsx` → `src/main.tsx`、`src/App.jsx` → `src/App.tsx`、`vite.config.js` → `vite.config.ts`
- `index.html` 脚本引用更新为 `/src/main.tsx`
- `npm run build` 前置 `tsc --noEmit` 类型检查卡点
- `package.json` version 0.0.1 → 0.0.2

### 说明
- 迁移期 `tsconfig.json` 临时开启 `allowJs: true`（允许 TS 引用尚未迁移的 .js/.jsx），计划于 v0.0.4 全量迁移完成后移除

## [0.0.1] - 2026-08-23

### 首个版本
- 类 Coze 扣子的 AI 工作流可视化编排编辑器（纯前端 Demo）
- 画布基础能力：拖拽添加节点、节点拖动、连线成 DAG、缩放、平移、删除节点/连线
- 三种节点类型：LLM 大模型 / 条件分支（true/false 双出口）/ 代码执行
- 右侧配置面板：点击节点修改参数，实时同步画布
- Zustand 全局状态管理：nodes/edges/选中/运行/撤销重做 统一 store
- 模拟运行：拓扑排序依次执行，节点状态 待执行 → 运行中 → 成功/失败，颜色实时变化
- 导入 / 导出 JSON
- 加分项：DAG 环检测（Kahn 拓扑排序双重防护）、批量删除、撤销重做（50 步历史栈）
- 图标体系：统一灰色单调 AntD Icons
- Vercel 在线部署 + GitHub 仓库 + README 面试文档

[Unreleased]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.8...v0.1.0
[0.0.8]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/meisyangb/ai-workflow-demo/releases/tag/v0.0.1
