# 小QTV 网页端

这是小QTV 的独立网页端骨架，页面层不直接依赖 Electron、IPC、本地路径或 Python 进程。

## 开发

```bash
npm install
npm run dev
```

启动后打开 `http://127.0.0.1:5173/`。

## 分层

```text
页面组件 → Feature / Hook → Port → Web Adapter
```

`src/ports` 定义项目、分镜、媒体、生成和 Agent 的业务接口；`src/adapters/web/memoryAdapter.ts` 提供本地演示数据。接入真实后端时，只需实现同一组 `AppPorts`，页面不需要感知传输方式。Electron 过渡期可以在 `src/adapters/electron` 实现同样的接口。

当前演示页包含项目上下文壳层、工作台总览、分镜、素材库、生成队列、Agent 对话和命令面板。服务端状态通过 `useAppData` 读取，UI 状态集中在 `src/state/uiStore.ts`。

## 已复用的旧项目能力

网页端的画布节点类型、生成节点判定、画面比例、生成任务状态和连接规则沉淀在 `src/domain/canvas.ts` 与 `src/domain/canvasConnections.ts`。`src/features/canvas/Canvas.tsx` 是网页版画布，使用 React Flow 承载拖拽、连线、缩放、MiniMap、删除和节点工具栏，不引用 Tauri、Electron 或桌面 Store。

## 构建

```bash
npm run build
```
