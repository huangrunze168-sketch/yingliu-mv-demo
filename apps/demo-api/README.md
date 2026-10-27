# 映流 MV 可运行 Demo API

公开 Demo 的生成与项目后端。接收音频、歌词、多张人物参考图和可选参考素材，调用
DeepSeek 完成 Agent 分析，并按 ModelsNexus 文档提交 Seedance 或 MiniMax 视频任务。
Seedance 直接交付模型结果；MiniMax 单段上限 15 秒，长视频由 FFmpeg 分段合成并封装原音轨。
任务文件默认保留 24 小时。

接口：

- `GET /health`
- `GET/POST /projects`
- `PATCH/DELETE /projects/{id}`
- `POST /analyze`：DeepSeek Agent 分析与逐镜提示词
- `POST /jobs`：`multipart/form-data`
- `GET /jobs/{id}`

`POST /jobs` 接受 `client_request_id`，同一请求标识只会创建一次服务端任务和上游任务。
前端进入交付页不会自动调用付费模型，必须由用户主动点击生成。

运行环境需要 Python 3.11+、FFmpeg 7+、`ffprobe`，以及可用的
`libopenh264` 编码器和运行库。生产服务默认监听 `127.0.0.1:8791`，通过
`xiaoyou.conf` 暴露 `/yingliu-demo-api/` 和 `/yingliu-demo-results/`。

外部模型凭证通过 `/etc/yingliu-demo-api.env` 注入，严禁写入前端产物。完整配置见
`.env.example`。`YINGLIU_DEMO_PUBLIC_API_BASE` 必须是 ModelsNexus 可以访问、使用受信任
证书的 HTTPS 公网 API 地址，用于生成六小时有效的素材签名链接。不要使用纯 HTTP IP：
虽然浏览器可以正常下载，Seedance 上游仍可能在抓取阶段返回 `fail_to_fetch_task / 502`。

Seedance 状态按 ModelsNexus 文档每 30 秒轮询。ModelsNexus 媒体库上传只有在
`status=ready` 且返回 URI 时才可用于生成；`processing` 阶段提前返回的 URI 不能使用。
