# 迭代开发计划（Incremental Development Plan）

> 增量开发策略：每次提交仅包含少量、聚焦的变更；每个版本有明确的功能目标、完成标准与测试要求。
> 当前所处阶段：**阶段 1 —— 通信层（HTTP Client / ExecutionService / WebSocket / 鉴权）**

---

## 阶段总览

| 阶段 | 范围 | 版本区间 | 状态 |
| --- | --- | --- | --- |
| 阶段 0 | 技术基础：TS 迁移、Zod 契约、ESLint/Prettier、Vitest 单测 | v0.0.2 ~ v0.0.8 | ✅ 已完成（2026-08-23 验收通过） |
| 阶段 1 | 通信层：HTTP Client、ExecutionService 抽象、WS Client、鉴权 | v0.1.x | 🔄 进行中 |
| 阶段 2 | 可维护性：EventBus、Store 拆分、Feature 目录、ErrorBoundary | v0.2.x | ⏸ 未开始 |
| 阶段 3 | 加分项：持久化、操作审计、请求缓存层、路由 | v0.3.x | ⏸ 未开始 |

---

## 阶段 0 迭代明细

### v0.0.1 —— 基线（已完成 ✅）

- **目标**：纯前端演示版稳定基线
- **完成标准**：功能全量可演示、构建通过、已部署 Vercel
- **测试要求**：构建验证 + 手动演示流程走通
- **基线标签**：`v0.0.1`（回滚点）

### v0.0.2 —— TS 工具链 + 入口迁移（已完成 ✅ commit f94e26c）

- **目标**：建立 TypeScript strict 基础设施，迁移入口文件
- **范围**：tsconfig.json / vite-env.d.ts / main.tsx / App.tsx / vite.config.ts / index.html / package.json 脚本 + CHANGELOG + 本计划文档
- **完成标准**：`tsc --noEmit` 零错误；`npm run build` 通过；页面功能不变
- **测试要求**：构建即验证（类型检查卡点）；手动打开 dev 页面确认渲染正常

### v0.0.3 —— Store 领域层 TS 化（已完成 ✅ commit 7275e39）

- **目标**：`workflowStore.js` → `workflowStore.ts`，完成领域模型类型建模
- **范围**：NodeStatus/NodeType 枚举类型化；LLM/Condition/Code 三种 NodeData 类型；WorkflowNode/WorkflowEdge 类型；Store State/Actions 接口
- **完成标准**：`tsc --noEmit` 零错误；`npm run build` 通过；运行功能不变
- **测试要求**：构建即验证 + 手动运行工作流走通

### v0.0.4 —— 组件层 TSX 迁移（已完成 ✅ commit be5c102）

- **目标**：全部组件 .jsx → .tsx，移除 `allowJs`
- **范围**：Toolbar / Sidebar / FlowCanvas / ConfigPanel / CustomNodes
- **完成标准**：仓库内无 .jsx/.js 源文件；`tsc --noEmit` 零错误；build 通过
- **测试要求**：构建即验证 + 手动全功能回归（拖拽/连线/配置/运行/导入导出/撤销重做）

### v0.0.5 —— Zod 数据契约（已完成 ✅ commit df8d412）

- **目标**：运行时数据校验，定义导入/导出的 JSON 契约
- **范围**：`src/schemas/workflow.ts`（NodeStatus/Node/Edge/WorkflowDef Zod Schema）；`importFlow` 接入 safeParse，错误信息精确到字段
- **完成标准**：非法 JSON（缺字段/类型错/未知节点类型）被拒并返回具体路径错误；合法导出 JSON 可完整回导
- **测试要求**：手动正反例导入；v0.0.7 补充单测

### v0.0.6 —— ESLint + Prettier 工程规范（已完成 ✅ commit 1ca6746）

- **目标**：代码质量静态卡点
- **范围**：eslint 9 flat config（typescript-eslint + react-hooks + react-refresh）、.prettierrc、.prettierignore、.editorconfig、`npm run lint` / `npm run format` 脚本
- **完成标准**：`npm run lint` 0 error 0 warning
- **测试要求**：lint 全绿作为卡点

### v0.0.7 —— Vitest 单元测试（已完成 ✅ commit 95f58ae，25/25 全绿）

- **目标**：核心纯函数与 Store 逻辑测试覆盖
- **范围**：拓扑排序（链/分支/环/空图）、环检测、defaultNodeData、importFlow（合法/非法/往返）、undo/redo、onConnect 拒环
- **完成标准**：`npm test` 全绿，核心领域函数覆盖
- **测试要求**：Vitest node 环境，无 DOM 依赖

### v0.0.8 —— 阶段验收收尾（已完成 ✅）

- **目标**：文档链完整，阶段 0 验收
- **范围**：README 技术栈/脚本/项目结构更新；CHANGELOG 汇总；打 `v0.0.8` 验收标签
- **完成标准**：全量回归（build + lint + test）通过；文档与实际一致
- **测试要求**：build + lint + test 三件套全绿
- **验收记录（2026-08-23）**：
  - `npm run build`（tsc --noEmit + vite build）✅
  - `npm run lint` 0 error 0 warning ✅
  - `npm run test` 25/25 通过 ✅
  - Vercel 生产部署回归通过 ✅

---

## 阶段 1 迭代明细（通信层）

### v0.1.0 —— HTTP Client 抽象层

- **目标**：统一的 HTTP 请求封装，为对接真实后端打地基（当前项目无后端，本层暂未被业务调用，属基础设施迭代）
- **范围**：`src/services/httpClient.ts` —— fetch 依赖注入（FetchLike）、超时控制（AbortController）、失败重试（指数退避；仅网络错误/超时/5xx 重试，4xx 不重试）、统一错误类型 HttpError（code/status/body）、JSON 自动序列化与反序列化、get/post/put/delete 快捷方法
- **完成标准**：`tsc --noEmit` 零错误；build / lint / test 三件套通过；httpClient 单测覆盖成功、4xx 不重试、5xx 重试、超时、网络错误、解析失败
- **测试要求**：Vitest node 环境，mock fetch 注入，无需真实网络（14 例）
- **状态**：✅ 已完成

### v0.1.1 —— ExecutionService 抽象（规划中）

- **目标**：把 workflowStore 中的 Mock 运行引擎抽出为 ExecutionService 接口（start/stop/onEvent），本地 Mock 与未来的 HTTP/WS 实现可互换
- **完成标准**：运行行为与 v0.0.x 基线完全一致；Service 层单测覆盖
- **测试要求**：Vitest 单测 + 手动运行工作流回归

---

## 提交规范

- 格式：`<type>(<version>): <subject>`，如 `feat(v0.0.2): TypeScript 工具链与入口迁移`
- type：feat / fix / refactor / docs / chore / test
- 每个版本一个聚焦提交，禁止跨版本混合改动
