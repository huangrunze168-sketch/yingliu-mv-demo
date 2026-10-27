# 映流 MV · AI 音乐视频工作流

一个可运行的 Web Demo：用户创建项目并上传歌曲、歌词、人物参考图和可选参考视频；DeepSeek Agent 分析物料，结合 ZY 导演库生成逐镜全能提示词；用户确认后，通过 ModelsNexus 调用 Seedance 或 MiniMax，最后在线播放或下载成片。

## 当前工作流

1. 项目与物料：创建真实项目，上传歌曲、歌词、多张人物参考图，以及可选参考视频和参考音色。
2. Agent 分析与生成确认：DeepSeek 读取需求与物料，应用所选导演的方法，输出含歌词时间轴、人物一致性、场景动作、景别、摄影运镜、负面提示词和镜头衔接的逐镜提示词。
3. 成片合成与交付：人工确认模型与清晰度后提交生成；Seedance 直接使用模型结果，MiniMax 超过 15 秒时由服务器 FFmpeg 分段合成；完成后支持在线播放和 MP4 下载。

## 本地运行

要求：Node.js 22.15+、Corepack、pnpm 10.33+、Python 3.11+、FFmpeg/ffprobe。

```powershell
git clone https://github.com/huangrunze168-sketch/yingliu-mv-demo.git
cd yingliu-mv-demo
corepack enable
corepack pnpm install

# 终端 1：启动 API
$env:YINGLIU_DEMO_DATA="$PWD/.data/yingliu-demo/jobs"
$env:YINGLIU_DEMO_PROJECTS_FILE="$PWD/.data/yingliu-demo/projects.json"
python apps/demo-api/server.py

# 终端 2：启动前端
corepack pnpm --filter @qiyin/web dev
```

打开 <http://127.0.0.1:5173/yingliu-demo/>。前端开发服务器需要把 `/yingliu-demo-api/` 代理到 `127.0.0.1:8791`；仓库中的 Vite 配置已包含该代理。

只看 UI 时无需配置第三方密钥；真实 Agent/视频生成需要参考 [`apps/demo-api/.env.example`](apps/demo-api/.env.example) 配置服务端环境变量。密钥只能放在服务端，不能写入前端或提交到 Git。

## 校验与构建

```powershell
corepack pnpm --filter @qiyin/web check
corepack pnpm --filter @qiyin/web build
```

静态产物位于 `apps/web/dist/`。Linux + Nginx + systemd 的参考配置位于：

- [`apps/demo-api/xiaoyou.conf`](apps/demo-api/xiaoyou.conf)
- [`apps/demo-api/yingliu-demo-api.service`](apps/demo-api/yingliu-demo-api.service)
- [`apps/demo-api/README.md`](apps/demo-api/README.md)

## 安全与版权

- 项目、上传素材和任务状态由服务端保存；生产环境请自行增加认证、访问控制和备份。
- `/jobs` 使用 `client_request_id` 实现幂等提交，避免重复创建上游任务。
- 上传素材会按用户确认通过受信任 HTTPS 短时链接发送给 ModelsNexus；签名链接默认六小时过期。
- 工作台交互层包含基于 Velorn 的 GPL-3.0 移植，来源与许可证见 [`apps/web/public/third-party/velorn/NOTICE.md`](apps/web/public/third-party/velorn/NOTICE.md)。

---

## 原始 Replica Studio 工程说明

# 小QTV

> 网页端工程名为 `@qiyin/web`；数据目录仍是 `%APPDATA%\qiyin-replica-studio`（旧名「期音复刻流水线」，改名不动数据）。

小QTV 是**懂镜头语言的创作搭档**——帮助独立视频创作者参考一条视频，快速做出属于自己的新作品。
核心差异：**提取镜头语言与制作方法，不复制参考作品的具体内容**。

## 三条路径

| 路径 | 职责 |
| --- | --- |
| / | 解释产品价值、展示前后对比、引导注册 |
| /signup | 轻量注册引导，完成后进入 /create |
| `/skill` | 小QTV Skill 商店：发现、收藏、从 GitHub 导入并交给 Agent 使用 |
| `/create` | 四步轻量创作流程：上传参考 → 风格分析 → 分镜与低清生成 → 锁定与导出 |
| `/workbench` | 项目列表与创建入口，登录后进入 |
| `/workbench/:projectId` | 专业项目工作台，登录后进入 |

动线顺序：`/` → `/signup` → `/create` → `/workbench`。四条路径不混用同一套视觉语言：`/` 轻盈友好、`/create` 克制强调确认、`/workbench` 深色强调状态与控制。

## 工程沿革

桌面端与本地内核是依据《复刻流水线·产品与系统架构设计 v2.3》起步的——那是**桌面载体与生成内核**的由来，**不是产品定位**。
产品定位已于 2026-09-24 收敛为「参考驱动的创作搭档」。

架构：**TypeScript 领域内核 + 前置内核 前置 agent + 内置 本地能力后端 + 网页端（`apps/web`）**。
（历史沿革里曾有 Electron 桌面壳，已从仓库移除；网页端是产品定位的直接落点。）

## 网页端（`apps/web`）

产品定位的直接落点。页面层**不依赖** Electron、IPC、本地路径或 Python 进程。

```powershell
corepack pnpm --filter @qiyin/web dev      # 打开 http://127.0.0.1:5173/
corepack pnpm check:web                    # tsc --noEmit
corepack pnpm --filter @qiyin/web build
corepack pnpm --filter @qiyin/web test
```

分层：

```text
页面组件 → Feature / Hook → Port → Web Adapter
```

`src/ports` 定义项目、分镜、媒体、生成、参考片与 Agent 的业务接口；`src/adapters/web/memoryAdapter.ts` 提供演示数据。
接真实后端时只需实现同一组 `AppPorts`，页面不感知传输方式。详见 `apps/web/README.md`。

## 快速开始（网页端）

```powershell
# 1. 安装依赖
corepack pnpm install

# 2. 启动网页端（http://127.0.0.1:5173/）
corepack pnpm dev:web

# 3. 校验（类型 + 网页端 + 测试）
corepack pnpm verify
```

网页端页面层**不依赖** Electron、IPC、本地路径或 Python 进程，`src/adapters/web/memoryAdapter.ts` 提供演示数据；接真实后端时实现同一组 `AppPorts` 即可。

需要真实内核链路时，获取运行时资产（不入库）：

```powershell
# 本地能力后端 源码（约 75 MB，含嵌入式 Python）
pwsh -File scripts/fetch-local-backend.ps1

# 前置内核 发行版（约需 Network；版本锁定到 commit）
pwsh -File scripts/fetch-frontkernel.ps1
```

前置内核 也可以放在任意位置，用 `QIYIN_前置内核_ROOT` 指向它；
找不到发行版时前置内核显示「未接入」，项目与画布功能不受影响。

真实链路测试（会启动嵌入式 Python 后端，约 15 秒）：

```powershell
$env:QIYIN_LOCAL_BACKEND_INTEGRATION='1'
corepack pnpm test
```

## 运行环境要求

- Windows x64
- Node.js ≥ 22.15.0
- 系统 `ffmpeg`（视频缩略图需要；缺失时仅视频预览不可用）

## 命令行与本地 API

CLI：

```powershell
corepack pnpm cli project:create --name "首个项目" --budget-cents 2000 --rights-confirmed
corepack pnpm cli project:list

# 前置内核：校验一个 Source（真实调用 前置内核 CLI）
corepack pnpm cli kernel:check --project-id <UUID> --revision 1 `
  --source "examples/interview/reference.svml" --workspace <frontkernel 发行版目录>

# 前置内核：规划一个 Run（同样真实调用，不花钱、不需要账号）
corepack pnpm cli kernel:plan --project-id <UUID> --revision 1 `
  --source "examples/semantic-composition/chat.svrun" --workspace <frontkernel 发行版目录> `
  --package-root <该示例的包根目录>

# 前置内核：提交真实构建并取回成片（本地 Provider，不需要生成账号）
corepack pnpm cli kernel:build --project-id <UUID> --revision 1 `
  --source "examples/semantic-composition/chat.svrun" --workspace <frontkernel 发行版目录> `
  --package-root <该示例的包根目录> --runtime-profile "examples/semantic-composition/frontkernel.runtime.json"
corepack pnpm cli kernel:status  --build-id <BUILD_ID> --workspace <frontkernel 发行版目录>
corepack pnpm cli kernel:inspect --build-id <BUILD_ID> --workspace <frontkernel 发行版目录>
corepack pnpm cli kernel:get     --build-id <BUILD_ID> --output final.video --to <目标路径> --workspace <frontkernel 发行版目录>
corepack pnpm cli kernel:tasks --project-id <UUID>

# 参考视频：登记 → 分析 → 自动生成拆解草稿（全程本地、不花钱）
corepack pnpm cli source:register --project-id <UUID> --revision 1 `
  --workspace <项目目录> --file <本地视频>
corepack pnpm cli kernel:analyze --project-id <UUID> --revision 2 `
  --workspace <项目目录> --media sources/<文件名>.mp4
corepack pnpm cli source:list --project-id <UUID>

# 选帧：从参考视频抽出每个镜头的首帧候选，再逐个选定
corepack pnpm cli kernel:candidates --project-id <UUID> --revision N `
  --workspace <项目目录> --media sources/<文件名>.mp4
corepack pnpm cli candidate:list --project-id <UUID>
corepack pnpm cli candidate:select --project-id <UUID> --revision N `
  --shot shot-01 --candidate <候选 id>
corepack pnpm cli gate:approve --project-id <UUID> --revision N --gate G2 --budget-cents 500

# 成片：把已选首帧按各镜时长写成 Source，交给内核渲染（本地，不花钱）
corepack pnpm cli film:produce --project-id <UUID> --revision N `
  --workspace <项目目录> --media sources/<文件名>.mp4
corepack pnpm cli kernel:status --build-id <BUILD_ID> --workspace <项目目录> --runtime-profile frontkernel.runtime.json
corepack pnpm cli kernel:get --build-id <BUILD_ID> --output final.video --to <目标路径> --workspace <项目目录>

# 偏差评估：把成片与参考片比对，给出带归因的结论（本地，不花钱）
corepack pnpm cli film:evaluate --project-id <UUID> --revision N `
  --workspace <项目目录> --result exports/<导出的成片>.mp4

# 真实生成：用 小QTV 为每个镜头出图并登记为首帧候选（会消耗账户额度）
corepack pnpm cli shot-fields:set --project-id <UUID> --revision N --shot shot-01 `
  --values "shot_size=中景;camera_position=平视;lighting=午后柔和自然光;replacement=一只橘猫坐在窗台上"
corepack pnpm cli image:generate --project-id <UUID> --revision N `
  --workspace <项目目录> --canvas-cwd <小QTV 画布目录> `
  --model "Z-image Turbo" --ratio 1:1 --quality 1K

# 图生视频：把已选首帧生成成视频片段（需 G2 已批准 + 该镜已选帧）
corepack pnpm cli video:generate --project-id <UUID> --revision N `
  --workspace <项目目录> --canvas-cwd <小QTV 画布目录> `
  --model "Seedance 2.0 Mini" --resolution 480p --ratio 9:16
```

本地 API（仅绑定 `127.0.0.1`）：

- `GET /health`
- `POST /api/v1/commands`
- `POST /api/v1/kernel/check`
- `GET /api/v1/skills` / `GET /api/v1/skills/:skillId`
- `POST /api/v1/skills/imports/github/inspect` / `POST /api/v1/skills/imports/github`
- `GET /api/v1/projects`
- `GET /api/v1/projects/:projectId`
- `GET /api/v1/projects/:projectId/events?after=0`

所有写操作都必须提供 `command_id`；修改已有项目还必须提供 `expected_revision`。重复提交相同 `command_id` 返回首次结果，不重复执行。

## 安全默认值

- 本地 API 仅监听 `127.0.0.1`；
- 本地能力后端 后端由 `apps/local-backend-host/launcher.py` 强制绑定 `127.0.0.1` 与随机空闲端口；
- Provider Manifest 只描述凭据字段，不接受凭据值；
- 项目数据库中不存储 API Key；
- `G2` 未批准前，视频请求必定被领域层拒绝。
