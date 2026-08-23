# 更新日志（Changelog）

本项目的所有显著变更都将记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.1.2...HEAD
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
