# 更新日志（Changelog）

本项目的所有显著变更都将记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.0] - 2026-08-23
> 版本目标：「基础层清理 + 压力测试 + 工具栏/画布分层重构」。
> 在 v0.3.1 外观高仿的基础上，把所有业务按钮从紫色 Toolbar 行移到画布中上方（CanvasActionBar），
> 两侧面板（Sidebar / ConfigPanel）改为仅保留"圆形中间按钮"折叠器，补齐 N≤2000 节点的压力测试，
> 并修复两处架构耦合：ExecutionService 接口类型不再反向 import store、业务层不再静态 new Mock（改为装配层 DI）。
> 交付品质：TypeScript strict 零错误 / ESLint 零错误 / 107 单测全过（含 16 条压力测试新用例）/ Vite 产线构建成功

### 新增

#### 1. 压力测试基础设施（Task 7 + Task 8 性能评估）
- `src/store/workflowStore.ts` 暴露调试 API（仅 DEV / 测试使用）：
  - `__stressGenerate({ nodes, pattern, cellW, cellH, perCol })`：线性链 `linear` 或 1→N 扇出 `fanout` 生成，生成 50/200/500/1000/2000 节点可直接测
  - `__stressReport()`：返回 `nodeCount / edgeCount / maxInDegree / maxOutDegree / deepCount / shalCount / topologicalSorterMs / storeMemBytes`
  - `stressTestRuntime`：模块级注册表的兼容别名（v0.3.1 外部引用仍可写，但 v0.4.0 推荐走 `configureExecutionService`）
- 新增 `src/store/__tests__/stress.test.ts`：**16 cases**（5 case 线性 + 5 case 扇出 + 6 条基础/报告断言）
  - 线性 N=50/200/500/1000/2000 全部通过（最长 2000 节点单 case < 10s，vitest 每用例超时放宽至 120s）
  - 扇出 1→N（N=50/200/500/1000/2000）全部通过，使用 `Promise.race + done` 保底避免事件风暴漏掉 finish
  - 使用 `beforeAll` 注入"零延时 `queueMicrotask` MockExecutionService"，保证事件顺序但不使用真实 setTimeout
- 新增 `scripts/stress.mjs`：命令行 `node scripts/stress.mjs --nodes 1000 --pattern linear` 跑 vitest 单次压测（文档注释里说明了 FPS/交互需要用真实浏览器测）
- `src/App.tsx` DEV 模式下挂 `window.__stressGenerate / window.__stressReport / window.__stressRun` 三个全局函数，浏览器控制台可直接生成 N 节点并运行，观察 FPS

#### 2. 画布中上方 CanvasActionBar（Task 4 工具栏/画布分层）
- `src/components/FlowCanvas.tsx` 新增 `CanvasActionBar` 组件，放到 `Panel position="top-center"`，固定在画布可视区中上方（不是 Toolbar 里）
- 所有"业务按钮"全部从 Toolbar 移到 CanvasActionBar：撤销 / 重做 / 保存 / 调试 / 发布 + 统计条（N 节点 / N 连线 / Status / 运行进度）
- Toolbar 只保留：项目 Logo+标题 + 导入按钮（原生/JSON） + 右侧三态窗口控制按钮（最小化 / 最大化 / 关闭）

#### 3. 两侧面板折叠：仅保留「垂直中间」圆形按钮（Task 5 / Task 6 收尾）
- `Sidebar.tsx`：移除整个 `.sidebar__rail` 窄条 + Rail 折叠条；折叠按钮改为单个 24px 圆形按钮（白底 1px 灰边 + 阴影），定位在右侧 `transform: translateY(-50%)` 垂直中间
- `ConfigPanel.tsx`：同上，圆形折叠按钮定位在左侧垂直中间；展开状态显示「节点详情」，收起后只显示按钮
- 折叠状态：面板仅 0 宽，按钮突出边框外；状态写入 store（`sidebarCollapsed / configPanelCollapsed`），两侧面板互不冲突

### 变更

#### 1. 架构：ExecutionService 依赖注入（修复「基础层反向 import store」的结构耦合）
- `src/services/executionService.ts`：`NodeStatus / WorkflowNode / WorkflowEdge` 类型引用改从 `../domains/workflow.ts` 导入（**移除唯一的基础层→store 反向箭头**）
- `src/store/workflowStore.ts`：移除模块级 `new MockExecutionService()` 单例，改为 **`configureExecutionService(service, opts?)` 导出函数 + `executionServiceRegistry`**
  - `main.tsx` 装配层（最顶层入口）显式 `configureExecutionService(new MockExecutionService())`，业务层 store 只依赖 `ExecutionService` 接口
  - `runWorkflow` 内部不再引用 `stressTestRuntime.service ?? DEFAULT_EXECUTION_SERVICE`，只调用 `getExecutionService()`
  - 以后切 HTTP/WS 后端时：改 main.tsx 一行（或后端动态切换时调用 configure）即可，无需改 store 代码
- `src/store/__tests__/stress.test.ts`：`beforeAll` 改为 `configureExecutionService(activeService)`；`afterAll` 清空 registry（不再使用可变 `stressTestRuntime.service` 全局）

#### 2. Toolbar 单行化 + 窗口控制
- `src/components/Toolbar.tsx`：合并为**一行**紫色背景（#7c3aed 渐变），结构由「上拖拽 Row + 下按钮 Row」改为：左侧 Logo+标题 + 中间 `原生导入 / JSON 导入` + 右侧 `WindowControls`
- `src/components/WindowControls.tsx`：最小化 / 最大化 / 关闭 三按钮；Tauri 下 `React.lazy` + `@tauri-apps/api/window` 动态导入，Vercel/Web 端为 no-op（`vercel-isolation` 验证：首屏 chunk 不含 tauri 引用）

### 修复
- **Condition 节点 false Handle 溢出卡片外**：移除 `Handle` 样式中重复的 `top`（两处同时写 `top` 导致 Handle 被推到卡片之外），现在 CONDITION 绿/红两个 Handle 都在卡片右侧外缘内
- **默认工作流里多余节点（START/END）**：清掉旧 browser cache + initialNodes 重算，默认链 `LLM → CONDITION → [true→reply 感谢 / false→INTENT 追问 → reply 再聊]` 共 5 节点，没有孤立/无用输出
- **重复 edgeLabel**：`DEFAULT_CASE`（SELECTOR）和 `true/false`（CONDITION）不再给同一组 edge 写 label 两次，画布上每个分支只保留 1 个标签
- **ESLint：组件 effect 内直接 setState 渲染循环风险**：`ConfigPanel.tsx` 里根据 node.data 回写 Form initialValues 的 setState 用 `queueMicrotask` 包一层，避免 render-phase 写 state

### 测试 & 构建
- 单元测试：`npm test -- --run` → **107 passed**（原 91 + 新 16 stress cases）；stress.test.ts 的 fanout 2000 节点用例仍稳定通过（per-case 超时 120s）
- Lint：`npx oxlint .` + `npm run lint` 均为 0 warnings / 0 errors
- Build：`npm run build` → `tsc --noEmit` 通过 + Vite 产物 2.1MB（gzip 约 580KB）；Tauri/Vercel 两端 chunk 分离（window-controls 单独 chunk）

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