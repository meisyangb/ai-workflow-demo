# AI Workflow 可视化编排编辑器 Demo

> 类 Coze 扣子 / Dify 的 **AI 工作流前端编排 Demo**。纯前端实现，无后端服务，工作流执行为前端模拟（Mock WebSocket 延时 + 状态机）。
>
> 本项目是为面试 JD 关键词匹配而做的完整可演示项目：**节点拖拽、DAG 工作流画布、复杂交互、全局状态管理、模拟运行实时反馈**。

**当前版本**：v0.1.0（阶段 1「通信层」启动：HTTP Client 抽象层落地；阶段 0「技术基础」已完成，详见 [CHANGELOG.md](./CHANGELOG.md)）

---

## 在线预览 & 源码

- **在线预览（Vercel）**：<https://ai-workflow-demo-rouge.vercel.app/>
- **GitHub 仓库**：<https://github.com/meisyangb/ai-workflow-demo>

> 一键部署：
>
> [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmeisyangb%2Fai-workflow-demo)

---

## 技术栈

| 能力 | 选型 | 作用 |
| --- | --- | --- |
| 框架 | **React 18** + **Vite 5** | 项目脚手架 / HMR / 构建 |
| 类型系统 | **TypeScript 5.9**（strict） | 全仓类型安全：领域模型、Store、组件、事件回调 |
| UI 组件库 | **Ant Design 5** | 按钮 / 表单 / 弹窗 / 消息提示 / 图标 |
| 工作流画布 | **@xyflow/react**（原 React Flow，v12）| 节点拖拽、连线、缩放、平移、MiniMap、Controls |
| 全局状态管理 | **Zustand 4** | 统一管理 `nodes / edges / selectedNodeId / isRunning` 及所有操作（增删改查、撤销重做、运行） |
| 运行时数据校验 | **Zod** | 导入/导出 JSON 契约校验（discriminatedUnion 按节点类型校验字段，错误定位到路径） |
| 单元测试 | **Vitest 3**（39 个用例全绿） | 拓扑排序 / 环检测 / Store 增删 / 撤销重做 / 导入导出契约 / HTTP Client |
| 通信层 | 自研 **HTTP Client 抽象** | fetch 依赖注入、超时控制、指数退避重试、统一错误类型（HttpError） |
| 工程规范 | **ESLint 9** + **Prettier** + **EditorConfig** | flat config + typescript-eslint，lint 0 error 0 warning |
| 其他 | **uuid** ｜ **@ant-design/icons** | 生成唯一 ID / 图标 |

---

## 功能列表（全部实现）

### 必做项 1 - 画布基础能力（@xyflow/react）
- **拖拽添加节点**：左侧节点面板 → 拖入画布即创建节点
- **节点拖动位置**：任意节点支持鼠标拖动调整坐标，拖动结束自动存入撤销历史
- **节点之间连线**：从节点输出口（右侧圆点）拖到目标节点输入口（左侧圆点），自动生成箭头
- **DAG 流程图结构**：条件节点双输出（true / false 两口）
- **画布缩放**：鼠标滚轮缩放，右下角 Controls 按钮缩放（± / 适应画布）
- **画布平移**：按住 `空格 + 鼠标拖拽`、或直接在空白处拖动、或 MiniMap 框选
- **删除节点**：点节点按 `Backspace / Delete` 键，或右侧配置面板「删除该节点」按钮
- **删除连线**：点击连线按 Delete，或直接点击连线右上角 ×（React Flow 默认）

### 必做项 2 - 三种节点类型
- **LLM 大模型节点**：模型、温度、最大 Token、提示词（支持 `{{变量}}` 占位）
- **条件分支节点（If 判断）**：表达式 + True/False 分支标签，两个独立输出口
- **代码执行节点**：语言、超时时间、代码块（输入 `input` → `return` 输出）

### 必做项 3 - 右侧配置面板
- 点击画布任意节点，右侧立刻弹出对应表单
- 修改任意参数，**立刻同步**到画布节点（Label / Prompt / Expression / Code 全部实时更新）
- 运行中自动禁用表单，防止误操作
- 显示当前节点状态徽章、节点 ID、坐标信息

### 必做项 4 - 全局状态管理（Zustand）
- 所有节点、连线数据、选中、运行状态全部统一在 `src/store/workflowStore.ts`
- 任何操作（新增/修改/删除/撤销重做/导入导出/运行）**全部走 store**，组件内无零零散散的 `useState`
- Store 对外暴露纯函数 API，便于单元测试

### 必做项 5 - 模拟运行工作流 + 实时状态反馈
- 顶部「运行工作流」按钮一键启动
- **拓扑排序**按依赖顺序执行，保证前序节点先运行
- Mock 延时（0.8~1.5s）模拟真实 WebSocket / 远程调用耗时
- 节点依次切换状态：`待执行(灰) → 运行中(黄，发光脉冲) → 成功(绿) / 失败(红)`
- **画布节点颜色随状态实时变化**，运行中节点有黄色发光 outline，节点标题栏同步色
- 节点「成功」后，出边自动动画（流动虚线）展示数据流路径
- 失败自动停止后续执行，顶部「停止」按钮可随时中断并重置
- 无后端，纯前端模拟

### 必做项 6 - 导入 / 导出 JSON
- 「导出」按钮：把 `{ nodes, edges }` 下载为 JSON 文件（带时间戳文件名）
- 「导入」按钮：选择 JSON 文件，校验结构后恢复到画布
- 导入/导出前后状态一致，可跨环境迁移

---

## 可选加分项（全部实现）

1. **DAG 环检测**：
   - 每次连线前用 Kahn 拓扑排序算法检测（`wouldCreateCycle`），若会成环则 `isValidConnection` 直接拒绝
   - 即便用户强行连线，`onConnect` 里会再次检测并弹窗提示「禁止创建环路，工作流不能出现循环依赖」
   - 运行前再次校验，确保不可能出现死循环

2. **批量删除**：
   - `deleteNodes(ids)` 支持数组批量删除（React Flow 框选多节点 + Delete 直接触发）
   - 删除节点会自动级联删除关联的入边 / 出边

3. **撤销 / 重做 (Undo / Redo)**：
   - 简易命令模式：任何写入操作（新增节点、删除、连线、拖拽结束、导入、清空）都会 push 快照到 `past`
   - 最多保留最近 50 步历史
   - 工具栏按钮直接操作，快捷键可按需扩展

---

## 不做的东西（省流）

- 无登录 / 注册
- 无聊天对话窗口
- 无后端接口 / 不调用真实大模型
- 无知识库 / 插件系统
- 不搞 UI 美化竞赛，AntD 默认样式 + 业务功能优先

---

## 项目结构

```
ai-workflow-demo/
├── docs/
│   └── ITERATION_PLAN.md         # 分阶段迭代开发计划（目标/完成标准/测试要求）
├── public/                       # 静态资源
├── src/
│   ├── components/
│   │   ├── Toolbar.tsx           # 顶部工具栏：运行 / 导入导出 / 撤销重做 / 统计
│   │   ├── Sidebar.tsx           # 左侧：节点类型面板（HTML5 DnD 源）
│   │   ├── FlowCanvas.tsx        # 中间：@xyflow/react 画布 + 拖拽/连线/删除
│   │   └── ConfigPanel.tsx       # 右侧：节点参数配置面板
│   ├── nodes/
│   │   └── CustomNodes.tsx       # 3 种自定义节点（LLM / Condition / Code）
│   ├── schemas/
│   │   └── workflow.ts           # Zod 数据契约（导入/导出 JSON 运行时校验）
│   ├── services/
│   │   ├── httpClient.ts         # HTTP Client 抽象层（超时/重试/统一错误，fetch 可注入）
│   │   └── __tests__/
│   │       └── httpClient.test.ts     # Vitest 单元测试（14 例）
│   ├── store/
│   │   ├── workflowStore.ts      # Zustand 全局状态 + DAG 算法 + Mock 运行引擎
│   │   └── __tests__/
│   │       └── workflowStore.test.ts  # Vitest 单元测试（25 例）
│   ├── App.tsx                   # 三栏布局 + AntD ConfigProvider
│   ├── main.tsx                  # 入口
│   ├── vite-env.d.ts             # Vite 客户端类型
│   └── index.css                 # 全局样式 + ReactFlow handle 覆盖
├── CHANGELOG.md                  # 版本更新日志（Keep a Changelog 规范）
├── eslint.config.js              # ESLint 9 flat config
├── README.md
├── package.json
├── tsconfig.json                 # TS strict 配置
├── vercel.json
└── vite.config.ts                # Vite + Vitest 配置
```

---

## 本地启动

```bash
# 1. 安装依赖（Node >= 18，推荐 20+）
npm install

# 2. 启动开发服务器
npm run dev
# 默认地址：http://localhost:5173

# 3. 生产构建（tsc 类型检查 + vite 构建，双重卡点）
npm run build

# 4. 预览构建产物
npm run preview

# 5. 代码质量检查（ESLint，0 error 0 warning）
npm run lint

# 6. 单元测试（Vitest，39 个用例）
npm run test
```

> 启动后页面自带**一组演示示例节点**（LLM → 条件 → 代码/追问），开箱即可演示；不喜欢可以点「清空」。

---

## 面试现场演示脚本（1~2 分钟）

1. **拖节点、连线**：从左边拖 `LLM`、`条件`、`代码` 三个节点到画布，把 LLM 右边圆点拖到条件左边，条件 true 口（绿）拖到代码，false 口（红）拖到另一个 LLM
2. **改参数**：点 LLM 节点，右侧把提示词改成 `你是一个资深前端，请解释 {{topic}}`，实时看到节点文字变化
3. **运行**：点「运行工作流」，观察节点依次 **黄色（运行中）→ 绿色（成功）**，出边出现流动动画
4. **导出 JSON**：点「导出」下载 JSON，打开给面试官看 `nodes[] / edges[]` 数据结构
5. **环检测（加分）**：尝试把最后一个节点反连回第一个，弹窗提示禁止创建环路
6. **撤销重做（加分）**：点「撤销」回到上一步，「重做」还原

---

## 面试官可能会问

### 1. 节点 / 连线的数据结构长什么样？

**节点 Node**：
```jsonc
{
  "id": "n_llm_1",                // 唯一 ID
  "type": "llmNode",              // llmNode | conditionNode | codeNode
  "position": { "x": 60, "y": 120 },
  "data": {
    "label": "大模型节点",
    "status": "idle",             // idle | running | success | failed
    // 以下随 type 不同
    "model": "GPT-4o",
    "prompt": "你是一个有用的AI助手...",
    "temperature": 0.7,
    "maxTokens": 2048
  }
}
```

**连线 Edge**：
```jsonc
{
  "id": "e_abc12345",
  "source": "n_cond_1",           // 源节点 ID
  "target": "n_code_1",           // 目标节点 ID
  "sourceHandle": "true",         // 条件节点输出口标识：true / false / null
  "targetHandle": null,
  "label": "满足",                 // 可选
  "animated": true                // 运行时数据流动画
}
```

### 2. 状态怎么管理？

全部用 **Zustand** 一个 store：
```
nodes ──────┐
edges ──────┤→ 所有增删改查、选中、运行、撤销重做、导入导出 全在这里
selectedNodeId ─┘
isRunning ──────┘
past[] / future[]  →  撤销重做历史栈（快照数组，每步深拷贝）
```
组件里**不存任何节点数据的 useState**，全部通过 `useWorkflowStore(s => s.xxx)` 读取。

### 3. 环检测的实现？

**Kahn 拓扑排序**：
```js
const wouldCreateCycle = (nodes, edges, newEdge) => {
  const tempEdges = [...edges, newEdge];
  const { hasCycle } = topologicalSort(nodes, tempEdges);
  return hasCycle;
};
```
入度为 0 的先进队列，BFS 消边；如果结果长度 < 节点数 → 有环。
**双重防护**：① `isValidConnection` 在拖拽连线时实时校验，拖到会成环的目标上直接禁止松手；② `onConnect` 再次校验 + 弹窗。

### 4. 运行怎么模拟的？

```
runWorkflow()
  ├─ 拓扑排序拿到执行顺序 order[]
  ├─ for (nodeId in order):
  │     ├─ set status=running（黄）
  │     ├─ await setTimeout(0.8~1.5s)  ← 模拟网络/推理耗时
  │     ├─ 85% 概率 set status=success（绿），边 animated=true
  │     └─ 15% 概率 set status=failed（红），break 停止
  └─ set isRunning=false
```

---

## 说明

本项目仅作为**前端能力演示 Demo**，工作流执行逻辑完全由前端模拟，无后端服务、无真实大模型调用。
