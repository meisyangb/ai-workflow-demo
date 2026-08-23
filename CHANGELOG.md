# 更新日志（Changelog）

本项目的所有显著变更都将记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.5...HEAD
[0.0.5]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/meisyangb/ai-workflow-demo/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/meisyangb/ai-workflow-demo/releases/tag/v0.0.1
