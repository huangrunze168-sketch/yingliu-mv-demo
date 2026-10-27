"""小QTV · 本地能力后端 后端启动器。


1. 把工作目录和 sys.path 指向 本地能力后端 源码根，使 main.py 能按原样导入；
2. 覆盖原 `__main__` 的绑定地址：原 main.py 使用 host="0.0.0.0"，
   会把无鉴权的本地 API 暴露到局域网；这里改为仅监听回环地址；
3. 用环境变量接收端口，便于上层分配空闲端口，避免与已有实例冲突。

用法：
    python launcher.py
环境变量：
    QIYIN_本地能力后端_ROOT    本地能力后端 源码根目录（默认取本文件的上两级）
    QIYIN_本地能力后端_PORT    监听端口（默认 3000）
    QIYIN_本地能力后端_HOST    绑定地址（默认 127.0.0.1）
"""

import os
import sys
from pathlib import Path


if not (root / "main.py").is_file():
    sys.stderr.write(f"[qiyin] 未找到 本地能力后端 源码主文件: {root / 'main.py'}\n")
    raise SystemExit(2)

os.chdir(root)
sys.path.insert(0, str(root))
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import main  # noqa: E402

app = main.app

import uvicorn  # noqa: E402


if __name__ == "__main__":
    sys.stderr.write(f"[qiyin] 本地能力后端 后端启动于 http://{host}:{port}\n")
    sys.stderr.flush()
    uvicorn.run(
        app,
        host=host,
        port=port,
        ws_ping_interval=None,
        ws_ping_timeout=None,
    )
