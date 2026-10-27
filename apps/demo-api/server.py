#!/usr/bin/env python3
"""映流 MV 公开 Demo 的轻量生成服务。

仅依赖 Python 标准库和 FFmpeg。用户素材按任务隔离保存，生成完成后由
Nginx 提供 MP4 下载；过期任务会在后续请求到来时自动清理。
"""

from __future__ import annotations

import cgi
import base64
import functools
import hashlib
import json
import math
import mimetypes
import os
import pathlib
import re
import shutil
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

from film_corpus import public_corpus_catalog, retrieve_film_corpus


HOST = os.environ.get("YINGLIU_DEMO_HOST", "127.0.0.1")
PORT = int(os.environ.get("YINGLIU_DEMO_PORT", "8791"))
DATA_ROOT = pathlib.Path(os.environ.get("YINGLIU_DEMO_DATA", "/var/lib/yingliu-demo/jobs"))
PROJECTS_FILE = pathlib.Path(os.environ.get("YINGLIU_DEMO_PROJECTS_FILE", str(DATA_ROOT.parent / "projects.json")))
PUBLIC_PREFIX = os.environ.get("YINGLIU_DEMO_PUBLIC_PREFIX", "/yingliu-demo-results").rstrip("/")
PUBLIC_API_BASE = os.environ.get("YINGLIU_DEMO_PUBLIC_API_BASE", "").rstrip("/")
MAX_UPLOAD_BYTES = int(os.environ.get("YINGLIU_DEMO_MAX_UPLOAD", str(300 * 1024 * 1024)))
MAX_DURATION_SECONDS = float(os.environ.get("YINGLIU_DEMO_MAX_DURATION", "60"))
JOB_TTL_SECONDS = int(os.environ.get("YINGLIU_DEMO_JOB_TTL", str(24 * 60 * 60)))
MODELSNEXUS_BASE = os.environ.get("MODELSNEXUS_BASE", "https://modelsnexus.org").rstrip("/")
MODELSNEXUS_API_KEY = os.environ.get("MODELSNEXUS_API_KEY", "")
MINIMAX_API_KEY = os.environ.get("MINIMAX_API_KEY", "")
IMAGE_API_KEY = os.environ.get("IMAGE_API_KEY", "")
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE = os.environ.get("DEEPSEEK_BASE", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")

DATA_ROOT.mkdir(parents=True, exist_ok=True)
PROJECTS_FILE.parent.mkdir(parents=True, exist_ok=True)
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="yingliu-demo")
JOBS_LOCK = threading.Lock()
PROJECTS_LOCK = threading.Lock()

ALLOWED_EXTENSIONS = {
    "song": {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"},
    "lyrics": {".txt", ".lrc"},
    "portrait": {".jpg", ".jpeg", ".png", ".webp"},
    "portrait_2": {".jpg", ".jpeg", ".png", ".webp"},
    "portrait_3": {".jpg", ".jpeg", ".png", ".webp"},
    "portrait_4": {".jpg", ".jpeg", ".png", ".webp"},
    "portrait_5": {".jpg", ".jpeg", ".png", ".webp"},
    "portrait_6": {".jpg", ".jpeg", ".png", ".webp"},
    "portrait_7": {".jpg", ".jpeg", ".png", ".webp"},
    "portrait_8": {".jpg", ".jpeg", ".png", ".webp"},
    "reference": {".mp4", ".mov", ".webm", ".mkv"},
    "voice": {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"},
}

OUTPUT_SIZES = {
    "480p": {
        "16:9": (854, 480),
        "9:16": (480, 854),
        "1:1": (480, 480),
    },
    "720p": {
        "16:9": (1280, 720),
        "9:16": (720, 1280),
        "1:1": (720, 720),
    },
    "768P": {
        "16:9": (1366, 768),
        "9:16": (768, 1366),
        "1:1": (768, 768),
    },
    "1080p": {
        "16:9": (1920, 1080),
        "9:16": (1080, 1920),
        "1:1": (1080, 1080),
    },
    "2K": {
        "16:9": (2560, 1440),
        "9:16": (1440, 2560),
        "1:1": (1440, 1440),
    },
}

VIDEO_BITRATES = {
    "480p": ("1600k", "2200k", "4400k"),
    "720p": ("2800k", "3600k", "7200k"),
    "768P": ("3200k", "4200k", "8400k"),
    "1080p": ("5000k", "6500k", "13000k"),
    "2K": ("9000k", "12000k", "24000k"),
}

DIRECTOR_FILTERS = {
    "智能推荐": "eq=contrast=1.06:saturation=1.08:brightness=-0.015,vignette=PI/6,noise=alls=2:allf=t",
    "王家卫": "eq=contrast=1.12:saturation=1.30:brightness=-0.035,colorbalance=rs=.08:gs=-.02:bs=.05,vignette=PI/5,noise=alls=5:allf=t",
    "张艺谋": "eq=contrast=1.13:saturation=1.42:brightness=-0.01,colorbalance=rs=.08:gs=.015:bs=-.04,vignette=PI/7",
    "毕赣": "eq=contrast=1.02:saturation=.88:brightness=-0.04,colorbalance=rs=-.02:gs=.035:bs=.07,vignette=PI/5,noise=alls=4:allf=t",
    "丹尼斯·维伦纽瓦": "eq=contrast=1.16:saturation=.72:brightness=-0.035,colorbalance=rs=.03:gs=.01:bs=.025,vignette=PI/4",
    "奉俊昊": "eq=contrast=1.10:saturation=.96:brightness=-0.02,colorbalance=rs=.015:gs=.025:bs=-.015,vignette=PI/6",
    "是枝裕和": "eq=contrast=.96:saturation=.82:brightness=.025,colorbalance=rs=.025:gs=.018:bs=-.02,vignette=PI/8",
}

DIRECTOR_METHODS: dict[str, dict[str, str]] = {
    "张艺谋": {
        "composition": "中轴对称与队列式构图，人物按前中后景形成仪式化层级，关键动作使用大色块留白",
        "camera": "24–35mm 广角建立空间，关键表演切换 50mm 中近景；运镜克制，以正面推进、横向队列移动为主",
        "lighting": "硬朗轮廓光配方向明确的主光，让烟尘、织物和环境元素形成可见层次",
        "color": "限定两种主色和一种点睛色，以红黑、金黑或土黄等高纯度色块建立视觉秩序",
        "blocking": "群体调度服从几何队形，主角通过逆向运动、位置中心或色彩反差被识别",
        "rhythm": "静态仪式段与爆发动作段形成强反差，重拍处用整齐动作或构图突变响应",
        "avoid": "避免无目的手持、杂乱综合色、随意站位和只靠滤镜营造东方感",
    },
    "贾樟柯": {
        "composition": "真实公共空间中的中远景观察，保留环境招牌、道路、建筑和旁观者作为时代信息",
        "camera": "35–50mm 接近人眼，固定机位或缓慢平移，不主动追逐情绪",
        "lighting": "优先现场自然光与实际灯源，允许亮度不均和环境色污染",
        "color": "低修饰、轻褪色，保留水泥、尘土、旧墙和廉价霓虹的真实质感",
        "blocking": "人物在真实空间内自然进出，允许路人和环境事件与主体并存",
        "rhythm": "长停留、少切镜，让动作在镜头内部完成，歌词间隙保留空镜和等待",
        "avoid": "避免广告式精致布光、夸张摆拍、过度浅景深和无来由的炫技运镜",
    },
    "毕赣": {
        "composition": "利用门框、镜面、隧道和多层空间制造时间折叠，前景遮挡与深景人物同时存在",
        "camera": "24–35mm 连续长镜头语言，缓慢跟随、环绕或穿越空间，转场藏在遮挡和光暗变化中",
        "lighting": "潮湿低照度环境，实景点光源与雾气形成纵深，亮区作为人物行进目标",
        "color": "青绿、深蓝与局部暖光并置，水面和湿地反光承担空间连接",
        "blocking": "人物动作带动摄影机探索，前一动作在新空间继续，现实与记忆通过运动连接",
        "rhythm": "慢速沉浸，镜内调度替代频繁剪辑，音乐节点用空间揭示而非硬切",
        "avoid": "避免碎片化快剪、每镜独立不衔接、平面棚拍和单纯添加雨雾滤镜",
    },
    "娄烨": {
        "composition": "近距离不稳定构图，主体可短暂出框或被遮挡，以现场感保留人物关系张力",
        "camera": "28–50mm 手持贴近，跟随人物呼吸和身体移动，允许轻微失焦后重新捕捉",
        "lighting": "混合城市实景光源，保留高反差、过曝窗和色温冲突",
        "color": "偏冷环境与脏暖肤色交错，颗粒和低照度噪点作为情绪质感",
        "blocking": "人物互相遮挡、擦肩和追随，摄影机处在关系内部而非安全观察点",
        "rhythm": "动作与情绪推动剪辑，亲密段长停留，冲突段用突然位移和断裂切点",
        "avoid": "避免稳定器式绝对平滑、工整对称、无人物关系依据的手持晃动",
    },
    "王家卫": {
        "composition": "利用镜面、门框、玻璃和前景遮挡切割人物，负空间表达关系距离",
        "camera": "35–85mm 中近景与特写为主，侧向跟移、慢快门拖影和停格式动作只用于情绪节点",
        "lighting": "低调光、实景霓虹、轮廓光与局部面光并置，让肤色从环境色中分离",
        "color": "绿、红、琥珀等互补色分区，不同时间和关系使用稳定的色彩母题",
        "blocking": "人物错位、背对、擦肩或隔物对话，用空间阻隔替代直白表演",
        "rhythm": "重复动作、跳切与短暂凝视组成记忆感，副歌重拍可加速，句尾保留停顿",
        "avoid": "避免全片滥用拖影、只加霓虹滤镜、无动机慢动作和人物始终正对镜头",
    },
    "侯孝贤": {
        "composition": "固定中远景和多层室内空间，门窗分隔前中后景，让事件同时发生",
        "camera": "35–50mm 稳定观察，极少主动推拉，必要移动保持缓慢且不抢表演",
        "lighting": "自然窗光和室内实际光源，明暗过渡柔和，保留环境本来的时间感",
        "color": "低饱和生活色，木色、灰绿和自然肤色稳定连续",
        "blocking": "人物在完整空间中生活化活动，重要动作可发生在画面边缘或被部分遮挡",
        "rhythm": "镜头晚进入、早离开较少，保留动作前后余韵和环境声空间",
        "avoid": "避免频繁正反打、强调式推近、夸张情绪特写和过度解释人物心理",
    },
    "杨德昌": {
        "composition": "城市建筑线条组织画面，用玻璃、走廊和房间距离呈现关系结构",
        "camera": "35–50mm 冷静固定机位或精确平移，全景建立关系后再进入中景信息",
        "lighting": "均衡自然光与办公室实际光，控制反差，确保空间信息清晰",
        "color": "克制中性色，少量高纯度物件作为叙事标记",
        "blocking": "多人调度强调彼此距离与视线，人物位置变化代表关系变化",
        "rhythm": "以信息揭示和关系变化决定切点，不追随每个动作剪辑",
        "avoid": "避免空洞城市夜景、过度情绪滤镜、无空间逻辑的特写堆叠",
    },
    "岩井俊二": {
        "composition": "大量自然留白、逆光边缘和轻微高机位，人物常置于画面一侧并与季节环境呼应",
        "camera": "50–85mm 柔和中近景，轻手持或缓慢漂移；奔跑和回忆段可用短促跟拍与轻微升格",
        "lighting": "窗边散射光、阴天柔光或金色逆光，允许高光轻微溢出但保留肤色",
        "color": "奶白、浅青、淡绿和暖肤色，整体低对比，按段落用季节色温区分记忆层次",
        "blocking": "人物动作自然、略带羞涩和迟疑，利用风、头发、衣角、纸张等细小运动承载情绪",
        "rhythm": "主歌以呼吸式长镜和细节插镜铺陈，副歌用奔跑、抬头、回望等动作形成轻盈释放",
        "avoid": "避免影楼柔焦、全程过曝、刻意青春摆拍、无季节依据的唯美空镜",
    },
    "黑泽明": {
        "composition": "三角形群像、强方向线与深景调度，天气和地形成为动作力量",
        "camera": "35–75mm 多机位动作覆盖，长焦压缩运动方向，横移和快速摇摄服务动作轴线",
        "lighting": "高反差光线突出雨、风、雾和尘土，轮廓必须清楚可读",
        "color": "以明度和材质对比组织画面，即使彩色也保持黑白关系清晰",
        "blocking": "人物运动方向、速度和队形清楚，动作按准备、爆发、结果三个阶段展开",
        "rhythm": "静止蓄势后快速爆发，剪辑遵守视线和动作轴线，结果镜头充分停留",
        "avoid": "避免轴线混乱、动作无遮挡堆叠、天气只作背景和无蓄势的连续快剪",
    },
    "小津安二郎": {
        "composition": "低机位、正面稳定构图与房间几何，人物在固定空间位置中建立关系",
        "camera": "40–50mm 固定机位，机位高度接近席地坐姿，极少推拉摇移",
        "lighting": "均匀柔和室内光，控制反差，让家具、墙面和人物处在同一视觉秩序",
        "color": "自然中性色中设置少量红色或蓝色日常物件形成画面节拍",
        "blocking": "人物进入预设位置完成动作，对话可采用近正面单人镜头而非传统过肩",
        "rhythm": "人物段落之间插入建筑、走廊、器物等枕镜，情绪后留出安静余拍",
        "avoid": "避免高机位俯拍、连续运动镜头、夸张表演和过度景深虚化",
    },
    "是枝裕和": {
        "composition": "生活空间中的自然多人物构图，以门口、餐桌和走廊形成家庭关系层次",
        "camera": "35–85mm 观察式固定或轻微跟随，保持与人物适度距离，不侵入表演",
        "lighting": "自然窗光、阴天光和实际灯源，肤色温和，保留日常环境明暗",
        "color": "低饱和暖灰、木色与自然绿色，避免强人工色彩支配人物",
        "blocking": "允许人物重叠说话、忙碌和停顿，用微小照料动作展现关系",
        "rhythm": "按生活动作和对白呼吸剪辑，情绪高潮不急于切特写，留给观众观察",
        "avoid": "避免煽情慢动作、强制泪点特写、过分整洁场景和成人化儿童表演",
    },
    "奉俊昊": {
        "composition": "用楼层、门、走廊和高低差表达权力关系，场景几何为类型转折预留路径",
        "camera": "24–50mm 精确推移和横移，镜头运动跟随信息揭示，关键反转用机位或方向突变",
        "lighting": "空间分区照明清楚，暖冷区域对应安全与威胁，转折时改变主光方向",
        "color": "控制综合色，用重复道具色和空间色建立叙事线索",
        "blocking": "群像移动具有因果链，前景动作可遮蔽后景信息，再通过调度完成揭示",
        "rhythm": "喜剧节拍、悬疑停顿和突然暴力形成类型切换，切点由信息差驱动",
        "avoid": "避免只有怪诞美术没有空间因果、无铺垫反转和随意打破调度方向",
    },
    "朴赞郁": {
        "composition": "精确对称、框中框和物件特写，利用形状与材质建立欲望和危险关联",
        "camera": "25–85mm 精密轨道、俯拍和微距细节，运动路径必须对应角色意图或线索揭示",
        "lighting": "雕塑式侧光和轮廓光，控制高光质感，让皮肤、金属、织物区分明确",
        "color": "宝石色、深红、墨绿与黑色形成高密度但受控的色彩系统",
        "blocking": "人物动作与道具位置严密配合，手、眼神和物件的动作链构成叙事",
        "rhythm": "优雅缓慢的准备与突然精确的动作形成反差，转场通过形状或动作匹配",
        "avoid": "避免无叙事功能的华丽构图、滥用血色、随意微距和只有表面精致",
    },
    "安德烈·塔可夫斯基": {
        "composition": "深景空间、人物与水火风土等自然元素共存，镜面和废墟承载时间痕迹",
        "camera": "24–50mm 极缓慢推移、横移或长时间固定，运动像观察而非展示技巧",
        "lighting": "自然低对比光与局部高亮元素，利用雾、水面和颗粒显现空气质感",
        "color": "克制土色、灰绿和冷蓝，现实与记忆可通过综合色密度而非滤镜标签区分",
        "blocking": "人物在环境中停留、聆听和触碰，动作具有仪式感但不戏剧化夸张",
        "rhythm": "长镜头让时间本身成为内容，音乐高潮也避免机械快剪，以元素变化回应",
        "avoid": "避免空洞慢镜、无意义水火意象、玄学字幕和仅靠废墟制造深沉",
    },
    "大卫·芬奇": {
        "composition": "严谨中心构图、水平垂直线稳定，信息物件位置可被快速辨认",
        "camera": "27–50mm 精确滑轨与锁定式跟随，摄影机像机械观察者，速度与人物动作同步",
        "lighting": "低调柔光、受控实景光和清晰眼神光，暗部有细节且色温统一",
        "color": "低饱和青绿、烟灰和钠灯暖色，小范围肤色与关键信息保持分离",
        "blocking": "人物走位和视线严格匹配空间逻辑，动作重复保持连续性和程序感",
        "rhythm": "剪辑精确、信息密度高，切点落在认知变化而非单纯重拍",
        "avoid": "避免无控制手持、浮夸镜头晃动、死黑暗部和只套青绿色调",
    },
    "丹尼斯·维伦纽瓦": {
        "composition": "极端尺度对比、强负空间与单一主体，建筑和地景压迫人物",
        "camera": "24–50mm 缓慢推进、稳定横移和宏观建立镜头，近景保持克制正面压迫感",
        "lighting": "方向单一的大面积光源、逆光轮廓与雾尘体积光，暗部保持简洁",
        "color": "沙土、冷灰、深蓝等单色体系，关键情绪用有限暖色突破",
        "blocking": "人物移动缓慢明确，群体与巨型空间形成比例，重要动作在静默中完成",
        "rhythm": "长时间蓄势、低频压迫和少量巨大视觉事件，高潮后保留静止余震",
        "avoid": "避免镜头持续炫技、杂乱综合色、无尺度参照的大场景和密集无效剪辑",
    },
}

DEMO_PROJECTS: list[dict[str, Any]] = []


def _read_projects_unlocked() -> list[dict[str, Any]]:
    if not PROJECTS_FILE.exists():
        now = int(time.time())
        seeded = [{**item, "created_at": now, "updated_at": now} for item in DEMO_PROJECTS]
        _write_projects_unlocked(seeded)
        return seeded
    payload = json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
    return payload if isinstance(payload, list) else []


def _write_projects_unlocked(projects: list[dict[str, Any]]) -> None:
    temporary = PROJECTS_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(projects, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(PROJECTS_FILE)


def read_projects() -> list[dict[str, Any]]:
    with PROJECTS_LOCK:
        return _read_projects_unlocked()


def sanitize_project(payload: dict[str, Any], existing: dict[str, Any] | None = None) -> dict[str, Any]:
    now = int(time.time())
    base = dict(existing or {})
    allowed = {
        "name", "ratio", "model", "resolution", "director", "requirements", "status", "progress",
        "shots", "assets", "active_step", "agent_analysis", "job_id", "result_url",
    }
    for key in allowed:
        if key in payload:
            base[key] = payload[key]
    base["name"] = str(base.get("name") or "未命名 MV")[:100]
    base["ratio"] = str(base.get("ratio") or "16:9")[:10]
    base["model"] = str(base.get("model") or "Seedance 2.5 · 海外版")[:80]
    base["resolution"] = str(base.get("resolution") or "720p")[:20]
    base["director"] = str(base.get("director") or "王家卫")[:60]
    base["requirements"] = str(base.get("requirements") or "")[:20000]
    base["status"] = str(base.get("status") or "草稿")[:40]
    base["progress"] = max(0, min(100, int(base.get("progress") or 0)))
    base["shots"] = max(0, int(base.get("shots") or 0))
    base["assets"] = max(0, int(base.get("assets") or 0))
    base["active_step"] = max(0, min(2, int(base.get("active_step") or 0)))
    base["updated_at"] = now
    base.setdefault("created_at", now)
    return base


def create_project_record(payload: dict[str, Any]) -> dict[str, Any]:
    with PROJECTS_LOCK:
        projects = _read_projects_unlocked()
        project = sanitize_project(payload)
        project["id"] = uuid.uuid4().hex
        projects.insert(0, project)
        _write_projects_unlocked(projects)
        return project


def update_project_record(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with PROJECTS_LOCK:
        projects = _read_projects_unlocked()
        for index, current in enumerate(projects):
            if str(current.get("id")) == project_id:
                updated = sanitize_project(payload, current)
                updated["id"] = project_id
                projects[index] = updated
                _write_projects_unlocked(projects)
                return updated
    raise FileNotFoundError(project_id)


def delete_project_record(project_id: str) -> None:
    with PROJECTS_LOCK:
        projects = _read_projects_unlocked()
        remaining = [item for item in projects if str(item.get("id")) != project_id]
        if len(remaining) == len(projects):
            raise FileNotFoundError(project_id)
        _write_projects_unlocked(remaining)


def job_dir(job_id: str) -> pathlib.Path:
    if len(job_id) != 32 or any(ch not in "0123456789abcdef" for ch in job_id):
        raise ValueError("invalid job id")
    return DATA_ROOT / job_id


def state_path(job_id: str) -> pathlib.Path:
    return job_dir(job_id) / "job.json"


def write_state(job_id: str, **updates: Any) -> dict[str, Any]:
    with JOBS_LOCK:
        path = state_path(job_id)
        current: dict[str, Any] = {}
        if path.exists():
            current = json.loads(path.read_text(encoding="utf-8"))
        current.update(updates)
        current["updated_at"] = int(time.time())
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)
        return current


def read_state(job_id: str) -> dict[str, Any]:
    path = state_path(job_id)
    if not path.is_file():
        raise FileNotFoundError(job_id)
    return json.loads(path.read_text(encoding="utf-8"))


def cleanup_expired_jobs() -> None:
    cutoff = time.time() - JOB_TTL_SECONDS
    for candidate in DATA_ROOT.iterdir():
        try:
            if candidate.is_dir() and candidate.stat().st_mtime < cutoff:
                shutil.rmtree(candidate)
        except OSError:
            continue


def probe_duration(path: pathlib.Path, limit: float | None = MAX_DURATION_SECONDS) -> float:
    completed = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=45,
    )
    duration = float(completed.stdout.strip())
    if duration <= 0:
        raise ValueError("无法读取有效音频时长")
    return min(duration, limit) if limit is not None else duration


def upstream_model_name(state: dict[str, Any]) -> str:
    model = str(state.get("model", ""))
    if model.startswith("sd2.5海外版-") or model.startswith("sd2.0海外版-"):
        return model
    if model in {"minimax-h3-768p", "minimax-h3-2k"}:
        return model
    raise ValueError(f"当前视频 API 未配置模型：{model}")


SEEDANCE_MODEL_SPECS = {
    "sd2.0海外版-480p": {"resolution": "480p", "min_duration": 5, "max_duration": 15},
    "sd2.0海外版-720p": {"resolution": "720p", "min_duration": 5, "max_duration": 15},
    "sd2.5海外版-480p": {"resolution": "480p", "min_duration": 5, "max_duration": 30},
    "sd2.5海外版-720p": {"resolution": "720p", "min_duration": 5, "max_duration": 30},
}

MINIMAX_MODEL_SPECS = {
    "minimax-h3-768p": {"resolution": "768P", "min_duration": 4, "max_duration": 15},
    "minimax-h3-2k": {"resolution": "2K", "min_duration": 4, "max_duration": 15},
}


def build_generation_prompt(state: dict[str, Any]) -> str:
    plan = state.get("generation_plan")
    shots = plan.get("shots") if isinstance(plan, dict) else None
    if isinstance(shots, list) and shots:
        parts = []
        for shot in shots:
            if not isinstance(shot, dict):
                continue
            prompt = str(shot.get("prompt", "")).strip()
            negative = str(shot.get("negative_prompt", "")).strip()
            if prompt:
                parts.append(f"{shot.get('id', '')} {prompt}" + (f"\n负面约束：{negative}" if negative else ""))
        if parts:
            return ("生成一支连续音乐 MV，严格按以下时间轴逐镜执行，保持人物身份、服装、场景和动作连续；"
                    "画面不得出现字幕、水印或歌词文字。\n\n" + "\n\n".join(parts))[:32000]
    return str(state.get("requirements", "")).strip()[:32000]


def create_equal_reference_sheet(paths: list[pathlib.Path], output: pathlib.Path, width: int, height: int) -> None:
    paths = paths[:8]
    if not paths:
        raise ValueError("缺少人物参考图")
    columns = min(4, math.ceil(math.sqrt(len(paths))))
    rows = math.ceil(len(paths) / columns)
    tile_width = max(2, width // columns)
    tile_height = max(2, height // rows)
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for path in paths:
        command.extend(["-i", str(path)])
    filters = []
    labels = []
    layout = []
    for index in range(len(paths)):
        label = f"p{index}"
        labels.append(f"[{label}]")
        filters.append(
            f"[{index}:v]scale={tile_width}:{tile_height}:force_original_aspect_ratio=decrease,"
            f"pad={tile_width}:{tile_height}:(ow-iw)/2:(oh-ih)/2:color=black[{label}]"
        )
        layout.append(f"{(index % columns) * tile_width}_{(index // columns) * tile_height}")
    filters.append(
        "".join(labels) + f"xstack=inputs={len(paths)}:layout={'|'.join(layout)}:fill=black,"
        f"scale={width}:{height}[out]"
    )
    command.extend(["-filter_complex", ";".join(filters), "-map", "[out]", "-frames:v", "1", "-q:v", "3", str(output)])
    subprocess.run(command, check=True, capture_output=True, timeout=120)


def encode_multipart(fields: dict[str, str], file_field: tuple[str, pathlib.Path]) -> tuple[bytes, str]:
    boundary = f"----Yingliu{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8")
        ])
    field_name, path = file_field
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    chunks.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field_name}\"; filename=\"{path.name}\"\r\n"
        f"Content-Type: {mime}\r\n\r\n".encode("utf-8")
    )
    chunks.append(path.read_bytes())
    chunks.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class UpstreamHTTPError(RuntimeError):
    """已收到 ModelsNexus HTTP 响应，确认本次请求已结束。"""


class UpstreamTransportError(Exception):
    """网络结果未知；不能据此自动重试提交，避免重复扣费。"""


def api_json(request: urllib.request.Request, timeout: int = 120) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(body)
            except json.JSONDecodeError as exc:
                raise UpstreamTransportError(f"上游返回了非 JSON 响应（HTTP {response.status}）") from exc
            if not isinstance(payload, dict):
                raise UpstreamTransportError("上游返回的 JSON 不是对象")
            return payload
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1200]
        request_id = str(exc.headers.get("X-Oneapi-Request-Id", "")).strip()
        suffix = f"；请求 ID：{request_id}" if request_id else ""
        raise UpstreamHTTPError(f"上游视频 API 请求失败（HTTP {exc.code}）：{detail}{suffix}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise UpstreamTransportError(f"ModelsNexus 网络结果未知：{exc}") from exc


def modelsnexus_headers(api_key: str, content_type: str | None = None, idempotency_key: str | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {api_key}", "User-Agent": "YingliuDemo/3.0"}
    if content_type:
        headers["Content-Type"] = content_type
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    return headers


def seedance_media_type(key: str) -> str:
    if key.startswith("portrait"):
        return "image"
    if key == "reference":
        return "video"
    if key in {"song", "voice", "reference_audio"}:
        return "audio"
    raise ValueError(f"不支持的 Seedance 素材类型：{key}")


def upload_seedance_asset(job_id: str, key: str, path: pathlib.Path, model: str) -> str:
    state = read_state(job_id)
    assets = state.get("media_assets") if isinstance(state.get("media_assets"), dict) else {}
    existing = assets.get(key) if isinstance(assets, dict) else None
    if isinstance(existing, dict) and existing.get("uri"):
        return str(existing["uri"])
    if isinstance(existing, dict) and existing.get("submission_state") == "uploading" and not existing.get("id"):
        raise RuntimeError(f"素材 {key} 上传结果未知；为避免重复上传，系统不会自动重试")

    media_type = seedance_media_type(key)
    body, content_type = encode_multipart({}, ("file", path))
    assets[key] = {"submission_state": "uploading", "type": media_type, "filename": path.name}
    write_state(job_id, media_assets=assets, stage=f"正在上传 ModelsNexus 私有素材 · {key}")
    request = urllib.request.Request(
        f"{MODELSNEXUS_BASE}/v1/media/assets/upload?type={quote(media_type)}&model={quote(model)}",
        data=body,
        headers=modelsnexus_headers(MODELSNEXUS_API_KEY, content_type, f"yingliu-{job_id}-asset-{key}"),
        method="POST",
    )
    response = api_json(request, timeout=300)
    asset_id = str(response.get("id") or "")
    if not asset_id:
        raise RuntimeError(f"ModelsNexus 素材上传未返回 ID：{json.dumps(response, ensure_ascii=False)[:600]}")
    assets[key] = {
        "submission_state": "submitted",
        "type": media_type,
        "filename": path.name,
        "id": asset_id,
        "status": str(response.get("status", "processing")),
        "uri": str(response.get("uri") or ""),
    }
    write_state(job_id, media_assets=assets)

    deadline = time.time() + 900
    while not assets[key].get("uri"):
        if time.time() >= deadline:
            raise RuntimeError(f"ModelsNexus 素材 {key} 处理超时；保留任务 ID，禁止重复上传")
        query = urllib.request.Request(
            f"{MODELSNEXUS_BASE}/v1/media/assets/{quote(asset_id)}",
            headers=modelsnexus_headers(MODELSNEXUS_API_KEY),
        )
        result = api_json(query, timeout=60)
        status = str(result.get("status", "")).lower()
        uri = str(result.get("uri") or "")
        assets[key].update({"status": status, "uri": uri})
        write_state(job_id, media_assets=assets)
        if status in {"failed", "error", "cancelled", "canceled"}:
            raise RuntimeError(f"ModelsNexus 素材 {key} 处理失败：{result.get('error') or result.get('message') or status}")
        if uri and status == "ready":
            break
        time.sleep(3)
    return str(assets[key]["uri"])


def create_signed_asset_url(job_id: str, key: str, path: pathlib.Path) -> str:
    if not PUBLIC_API_BASE:
        raise RuntimeError("短时素材链接需要配置 YINGLIU_DEMO_PUBLIC_API_BASE")
    state = read_state(job_id)
    signed_assets = state.get("signed_assets") if isinstance(state.get("signed_assets"), dict) else {}
    for token, item in signed_assets.items():
        if isinstance(item, dict) and item.get("key") == key and int(item.get("expires_at", 0)) > int(time.time()) + 300:
            return f"{PUBLIC_API_BASE}/assets/{job_id}/{token}"
    token = uuid.uuid4().hex + uuid.uuid4().hex
    # 上游可能排队较久；链接只允许读取单个任务目录中的指定文件，延长有效期不会扩大访问范围。
    signed_assets[token] = {"key": key, "filename": path.name, "expires_at": int(time.time()) + 21600}
    write_state(job_id, signed_assets=signed_assets)
    return f"{PUBLIC_API_BASE}/assets/{job_id}/{token}"


def build_models_nexus_content(job_id: str, directory: pathlib.Path, files: dict[str, str],
                               prompt: str, include_song: bool = True) -> list[dict[str, Any]]:
    """按 ModelsNexus 多模态内容结构组装全部同级参考素材。"""
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    portrait_keys = sorted(
        (key for key in files if key.startswith("portrait")),
        key=lambda key: (0 if key == "portrait" else int(key.rsplit("_", 1)[-1])),
    )[:8]
    for key in portrait_keys:
        uri = create_signed_asset_url(job_id, key, directory / files[key])
        content.append({"type": "image_url", "image_url": {"url": uri}, "role": "reference_image"})
    if "reference" in files:
        uri = create_signed_asset_url(job_id, "reference", directory / files["reference"])
        content.append({"type": "video_url", "video_url": {"url": uri}, "role": "reference_video"})
    audio_keys = [key for key in ("voice", "reference_audio", "song") if key in files]
    if not include_song:
        audio_keys = [key for key in audio_keys if key != "song"]
    for key in audio_keys[:3]:
        uri = create_signed_asset_url(job_id, key, directory / files[key])
        content.append({"type": "audio_url", "audio_url": {"url": uri}, "role": "reference_audio"})
    return content


def seedance_payload(model: str, spec: dict[str, Any], ratio: str, duration: int,
                     content: list[dict[str, Any]]) -> dict[str, Any]:
    # ModelsNexus 的 OpenAI Video 兼容层直接接收 content。模型 ID 已固定清晰度，
    # 不能再发送 prompt/output_format/resolution，否则会被严格参数校验拒绝。
    return {
        "model": model,
        "content": content,
        "duration": duration,
        "ratio": ratio,
        "generate_audio": True,
    }


def minimax_payload(model: str, spec: dict[str, Any], ratio: str, duration: int,
                    content: list[dict[str, Any]]) -> dict[str, Any]:
    """MiniMax H3 原生多模态结构经 ModelsNexus `/v1/videos` 转发。"""
    # minimax-h3-768p / minimax-h3-2k 已在模型 ID 中区分输出档位；
    # 不再添加兼容端点不认识的 prompt、metadata、images 或 input_reference。
    return {
        "model": model,
        "content": content,
        "duration": duration,
        "ratio": ratio,
    }


def submit_video_task(job_id: str, task_key: str, payload: dict[str, Any], api_key: str,
                      protocol: str = "openai_video") -> str:
    state = read_state(job_id)
    tasks = state.get("upstream_tasks") if isinstance(state.get("upstream_tasks"), dict) else {}
    current = tasks.get(task_key) if isinstance(tasks, dict) else None
    if isinstance(current, dict) and current.get("id"):
        return str(current["id"])
    if isinstance(current, dict) and current.get("submission_state") == "submitting":
        # 收到 HTTP 4xx 代表上一次请求已被网关明确拒绝，没有创建付费任务，可以安全重试。
        rejected = state.get("status") == "failed" and "HTTP 4" in str(state.get("error", ""))
        if not rejected:
            raise RuntimeError(f"上游任务 {task_key} 提交结果未知；为避免重复扣费，系统不会再次提交")
    tasks[task_key] = {"submission_state": "submitting", "model": payload["model"], "protocol": protocol}
    write_state(job_id, upstream_tasks=tasks, stage=f"正在提交唯一生成任务 · {task_key}")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    submit_path = "/doubao/api/v3/contents/generations/tasks" if protocol == "doubao_native" else "/v1/videos"
    request = urllib.request.Request(
        f"{MODELSNEXUS_BASE}{submit_path}",
        data=body,
        headers=modelsnexus_headers(api_key, "application/json", f"yingliu-{job_id}-{task_key}"),
        method="POST",
    )
    try:
        response = api_json(request, timeout=180)
    except UpstreamHTTPError as exc:
        # api_json 的 RuntimeError 只对应已收到的 HTTP 错误响应，因此确定没有未知的在途任务。
        tasks[task_key].update({"submission_state": "rejected", "error": str(exc)[:1200]})
        write_state(job_id, upstream_tasks=tasks)
        raise
    upstream_id = str(response.get("id") or response.get("task_id") or "")
    if not upstream_id:
        raise RuntimeError(f"上游未返回任务 ID：{json.dumps(response, ensure_ascii=False)[:800]}")
    tasks[task_key] = {
        "submission_state": "submitted", "model": payload["model"], "protocol": protocol, "id": upstream_id,
        "status": str(response.get("status", "queued")),
    }
    write_state(job_id, upstream_tasks=tasks)
    return upstream_id


def wait_and_download_video(job_id: str, task_key: str, upstream_id: str, api_key: str, output: pathlib.Path,
                            base_progress: int, progress_span: int, protocol: str = "openai_video") -> None:
    final_response: dict[str, Any] = {}
    while True:
        query_path = (f"/doubao/api/v3/contents/generations/tasks/{quote(upstream_id)}"
                      if protocol == "doubao_native" else f"/v1/videos/{quote(upstream_id)}")
        request = urllib.request.Request(
            f"{MODELSNEXUS_BASE}{query_path}", headers=modelsnexus_headers(api_key),
        )
        response = api_json(request, timeout=60)
        status = str(response.get("status", "")).lower()
        default_progress = 10 if status in {"pending", "queued"} else 50 if status in {"processing", "running"} else 100
        raw_progress = response.get("progress", default_progress)
        if isinstance(raw_progress, str):
            raw_progress = raw_progress.rstrip("%")
        try:
            upstream_progress = max(0, min(100, int(float(raw_progress or default_progress))))
        except (TypeError, ValueError):
            upstream_progress = default_progress
        state = read_state(job_id)
        tasks = state.get("upstream_tasks") if isinstance(state.get("upstream_tasks"), dict) else {}
        if isinstance(tasks.get(task_key), dict):
            tasks[task_key].update({"status": status, "progress": upstream_progress})
        write_state(job_id, upstream_tasks=tasks, stage=f"ModelsNexus 生成中 · {task_key} · {upstream_progress}%",
                    progress=min(94, base_progress + round(upstream_progress * progress_span / 100)))
        if status in {"completed", "succeeded", "success"}:
            final_response = response
            break
        if status in {"failed", "cancelled", "canceled", "error"}:
            raise RuntimeError(f"上游视频生成失败：{response.get('error') or response.get('message') or status}")
        time.sleep(5)
    content = final_response.get("content") if isinstance(final_response.get("content"), dict) else {}
    metadata = final_response.get("metadata") if isinstance(final_response.get("metadata"), dict) else {}
    output_data = final_response.get("output") if isinstance(final_response.get("output"), dict) else {}
    video_url = str(
        content.get("video_url") or content.get("url") or metadata.get("url") or
        output_data.get("video_url") or output_data.get("url") or final_response.get("url") or ""
    )
    if protocol == "doubao_native" and video_url:
        request = urllib.request.Request(video_url, headers={"User-Agent": "YingliuDemo/3.0"})
    elif protocol == "doubao_native":
        request = urllib.request.Request(
            f"{MODELSNEXUS_BASE}/v1/tasks/{quote(upstream_id)}/artifacts/video/content",
            headers=modelsnexus_headers(api_key),
        )
    else:
        request = urllib.request.Request(
            f"{MODELSNEXUS_BASE}/v1/videos/{quote(upstream_id)}/content",
            headers=modelsnexus_headers(api_key),
        )
    with urllib.request.urlopen(request, timeout=600) as response, output.open("wb") as handle:
        shutil.copyfileobj(response, handle, length=1024 * 1024)
    if output.stat().st_size < 1024:
        raise RuntimeError(f"上游任务 {task_key} 返回的成片无效")
    try:
        probe_duration(output, limit=None)
    except (subprocess.SubprocessError, OSError, ValueError) as exc:
        output.unlink(missing_ok=True)
        raise RuntimeError(f"上游任务 {task_key} 返回的内容不是有效视频") from exc


def prompt_for_window(state: dict[str, Any], start: float, end: float) -> str:
    def parse_time(value: Any) -> float | None:
        match = re.search(r"(\d{1,3}):(\d{2}(?:\.\d{1,3})?)", str(value))
        return int(match.group(1)) * 60 + float(match.group(2)) if match else None

    plan = state.get("generation_plan")
    shots = plan.get("shots") if isinstance(plan, dict) else None
    selected: list[str] = []
    if isinstance(shots, list):
        for shot in shots:
            if not isinstance(shot, dict):
                continue
            sync = shot.get("lyrics_sync") if isinstance(shot.get("lyrics_sync"), dict) else {}
            shot_start = parse_time(sync.get("start"))
            shot_end = parse_time(sync.get("end"))
            if shot_start is None or shot_end is None or (shot_start < end and shot_end > start):
                prompt = str(shot.get("prompt", "")).strip()
                negative = str(shot.get("negative_prompt", "")).strip()
                if prompt:
                    selected.append(prompt + (f"\n负面约束：{negative}" if negative else ""))
    segment_prompt = "\n\n".join(selected) or build_generation_prompt(state)
    return (f"本段生成时间窗 {format_timestamp(start)}–{format_timestamp(end)}。"
            "严格保持人物身份、服装、场景和前后段连续；不得出现字幕、水印或歌词文字。\n"
            f"{segment_prompt}")[:32000]


def generate_upstream_job(job_id: str) -> None:
    directory = job_dir(job_id)
    state = read_state(job_id)
    files = state.get("files") if isinstance(state.get("files"), dict) else {}
    audio = directory / files["song"] if "song" in files else None
    output = directory / "result.mp4"

    try:
        model = upstream_model_name(state)
        spec = SEEDANCE_MODEL_SPECS.get(model) or MINIMAX_MODEL_SPECS[model]
        if audio is not None:
            duration = probe_duration(audio, limit=None)
        else:
            duration = float(state.get("planned_duration") or spec["max_duration"])
            plan = state.get("generation_plan")
            shots = plan.get("shots") if isinstance(plan, dict) else None
            ends: list[float] = []
            for shot in shots if isinstance(shots, list) else []:
                sync = shot.get("lyrics_sync") if isinstance(shot, dict) and isinstance(shot.get("lyrics_sync"), dict) else {}
                match = re.search(r"(\d{1,3}):(\d{2}(?:\.\d{1,3})?)", str(sync.get("end", "")))
                if match:
                    ends.append(int(match.group(1)) * 60 + float(match.group(2)))
            if ends:
                duration = max(ends)
        ratio = str(state.get("ratio", "16:9"))
        if ratio not in {"16:9", "9:16", "1:1"}:
            raise ValueError(f"{model} 不支持画幅 {ratio}")
        prompt = build_generation_prompt(state)
        if not prompt:
            raise ValueError("缺少 Agent 生成提示词")
        write_state(job_id, status="processing", stage="准备 ModelsNexus 固定参数", progress=12,
                    upstream_model=model, submission_state="preparing")

        if model in SEEDANCE_MODEL_SPECS:
            if not MODELSNEXUS_API_KEY:
                raise RuntimeError("ModelsNexus Seedance API 未配置")
            spec = SEEDANCE_MODEL_SPECS[model]
            requested_duration = round(duration)
            if requested_duration < spec["min_duration"] or requested_duration > spec["max_duration"]:
                raise ValueError(f"{model} 官方时长范围是 {spec['min_duration']}–{spec['max_duration']} 秒，当前音频 {duration:.2f} 秒")
            write_state(job_id, stage="正在创建 ModelsNexus 可拉取的短时素材链接", progress=16)
            content = build_models_nexus_content(job_id, directory, files, prompt)
            payload = seedance_payload(model, spec, ratio, requested_duration, content)
            upstream_id = submit_video_task(job_id, "seedance", payload, MODELSNEXUS_API_KEY)
            upstream_output = directory / "upstream.mp4"
            wait_and_download_video(
                job_id, "seedance", upstream_id, MODELSNEXUS_API_KEY, upstream_output, 22, 70,
            )
            # Seedance 保持模型原始输出，服务器不做 FFmpeg 二次渲染或换音轨。
            upstream_output.replace(output)
        else:
            if not MINIMAX_API_KEY:
                raise RuntimeError("ModelsNexus MiniMax API 未配置")
            spec = MINIMAX_MODEL_SPECS[model]
            requested_total = max(spec["min_duration"], round(duration))
            segment_count = max(1, math.ceil(requested_total / spec["max_duration"]))
            base = requested_total // segment_count
            remainder = requested_total % segment_count
            durations = [base + (1 if index < remainder else 0) for index in range(segment_count)]
            if any(value < spec["min_duration"] or value > spec["max_duration"] for value in durations):
                raise ValueError(f"无法按 MiniMax 官方 {spec['min_duration']}–{spec['max_duration']} 秒范围拆分当前音频")
            clips: list[pathlib.Path] = []
            cursor = 0.0
            for index, segment_duration in enumerate(durations):
                task_key = f"minimax-{index + 1:02d}"
                segment_prompt = prompt_for_window(state, cursor, min(duration, cursor + segment_duration))
                content = build_models_nexus_content(job_id, directory, files, segment_prompt)
                payload = minimax_payload(model, spec, ratio, segment_duration, content)
                upstream_id = submit_video_task(job_id, task_key, payload, MINIMAX_API_KEY)
                clip = directory / f"upstream-{index + 1:02d}.mp4"
                wait_and_download_video(job_id, task_key, upstream_id, MINIMAX_API_KEY, clip,
                                        18 + round(index * 70 / segment_count), max(1, round(70 / segment_count)))
                clips.append(clip)
                cursor += segment_duration
            write_state(job_id, stage="MiniMax 分段合成与原始音轨封装", progress=94)
            concat_file = directory / "minimax-concat.txt"
            concat_file.write_text("".join(f"file '{path.as_posix()}'\n" for path in clips), encoding="utf-8")
            joined = directory / "minimax-joined.mp4"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                "-i", str(concat_file), "-c", "copy", str(joined),
            ], check=True, capture_output=True, timeout=600)
            if audio is not None:
                subprocess.run([
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(joined), "-i", str(audio),
                    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", "-movflags", "+faststart", str(output),
                ], check=True, capture_output=True, timeout=600)
            else:
                joined.replace(output)
        final_duration = probe_duration(output, limit=None)
        write_state(job_id, status="completed", stage="上游 AI 成片已就绪", progress=100,
                    duration=round(final_duration, 2), result_url=f"{PUBLIC_PREFIX}/{job_id}/result.mp4",
                    file_size=output.stat().st_size, submission_state="completed")
    except Exception as exc:  # noqa: BLE001
        write_state(job_id, status="failed", stage="生成失败", error=str(exc)[:1200],
                    debug=traceback.format_exc()[-2400:])


def render_job(job_id: str) -> None:
    """兼容旧调用名；实际只走上游视频 API，不再生成本地占位片。"""
    generate_upstream_job(job_id)


def legacy_render_job(job_id: str) -> None:
    """旧版 FFmpeg 演示渲染保留作代码参考，不再被任务入口调用。"""
    directory = job_dir(job_id)
    state = read_state(job_id)
    audio = directory / state["files"]["song"]
    portrait = directory / state["files"]["portrait"]
    output = directory / "result.mp4"

    try:
        write_state(job_id, status="processing", stage="读取音频与素材", progress=12)
        duration = probe_duration(audio)
        resolution = state.get("resolution", "720p")
        if resolution not in OUTPUT_SIZES:
            resolution = "720p"
        sizes = OUTPUT_SIZES[resolution]
        width, height = sizes.get(state.get("ratio"), sizes["16:9"])
        bitrate, maxrate, bufsize = VIDEO_BITRATES[resolution]
        director = state.get("director", "王家卫")
        color_filter = DIRECTOR_FILTERS.get(director, DIRECTOR_FILTERS["智能推荐"])
        zoom_speed = ".0009" if director in {"王家卫", "张艺谋", "奉俊昊"} else ".00055"
        pan = "sin(on/42)*16" if director in {"王家卫", "毕赣"} else "sin(on/68)*9"
        video_filter = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},"
            f"zoompan=z='min(max(zoom,pzoom)+{zoom_speed},1.16)':"
            f"x='iw/2-(iw/zoom/2)+{pan}':y='ih/2-(ih/zoom/2)':"
            f"d=1:s={width}x{height}:fps=24,"
            f"{color_filter},format=yuv420p"
        )
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-loop", "1", "-framerate", "24", "-i", str(portrait),
            "-i", str(audio), "-t", f"{duration:.3f}",
            "-vf", video_filter,
            "-c:v", "libopenh264", "-b:v", bitrate, "-maxrate", maxrate, "-bufsize", bufsize,
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            "-shortest", "-progress", "pipe:1", "-nostats", str(output),
        ]

        write_state(job_id, stage=f"应用 {director} 风格并渲染视频", progress=30, duration=round(duration, 2))
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert process.stdout is not None
        for line in process.stdout:
            key, _, value = line.strip().partition("=")
            if key in {"out_time_us", "out_time_ms"}:
                try:
                    elapsed = int(value) / 1_000_000
                    progress = min(91, 30 + int((elapsed / duration) * 61))
                    write_state(job_id, progress=progress)
                except (ValueError, ZeroDivisionError):
                    pass
        stderr = process.stderr.read() if process.stderr else ""
        code = process.wait(timeout=max(120, int(duration * 8)))
        if code != 0:
            raise RuntimeError(stderr.strip()[-1200:] or f"FFmpeg exited with {code}")

        write_state(job_id, stage="校验成片文件", progress=96)
        if not output.is_file() or output.stat().st_size < 1024:
            raise RuntimeError("成片文件生成失败")
        final_duration = probe_duration(output)
        write_state(
            job_id,
            status="completed",
            stage="成片已就绪",
            progress=100,
            duration=round(final_duration, 2),
            result_url=f"{PUBLIC_PREFIX}/{job_id}/result.mp4",
            file_size=output.stat().st_size,
        )
    except Exception as exc:  # noqa: BLE001
        write_state(
            job_id,
            status="failed",
            stage="生成失败",
            error=str(exc)[:1200],
            debug=traceback.format_exc()[-2400:],
        )


def save_upload(field: cgi.FieldStorage, directory: pathlib.Path, key: str) -> str:
    original_name = pathlib.Path(field.filename or "upload").name
    extension = pathlib.Path(original_name).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS[key] and key not in {"song", "voice", "reference"}:
        raise ValueError(f"{key} 文件格式不支持：{original_name}")
    if key in {"song", "voice", "reference"} and not re.fullmatch(r"\.[a-z0-9]{1,10}", extension):
        extension = ".media"
    filename = f"{key}{extension}"
    target = directory / filename
    with target.open("wb") as handle:
        shutil.copyfileobj(field.file, handle, length=1024 * 1024)
    if target.stat().st_size == 0:
        raise ValueError(f"{key} 文件为空")
    return filename


def normalize_audio_upload(directory: pathlib.Path, files: dict[str, str], key: str) -> None:
    """不依赖上传后缀，交给 FFmpeg 验证并转成 ModelsNexus 可读取的 WAV。"""
    filename = files.get(key)
    if not filename:
        return
    source = directory / filename
    output = directory / f"{key}-normalized.wav"
    try:
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", str(output),
        ], check=True, capture_output=True, timeout=600)
        probe_duration(output, limit=None)
    except (subprocess.SubprocessError, OSError, ValueError) as exc:
        output.unlink(missing_ok=True)
        raise ValueError(f"{key} 不是 FFmpeg 可读取的音频文件") from exc
    final_output = directory / f"{key}.wav"
    source.unlink(missing_ok=True)
    output.replace(final_output)
    files[key] = final_output.name


@functools.lru_cache(maxsize=1)
def ffmpeg_h264_options() -> tuple[str, ...]:
    """根据当前服务器 FFmpeg 实际能力选择 H.264 编码器。"""
    try:
        completed = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            check=True, capture_output=True, text=True, timeout=30,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        raise RuntimeError("无法读取服务器 FFmpeg 编码器列表") from exc
    encoders = completed.stdout
    if re.search(r"\blibx264\b", encoders):
        return ("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p")
    if re.search(r"\blibopenh264\b", encoders):
        return (
            "-c:v", "libopenh264", "-b:v", "5M", "-maxrate", "8M", "-bufsize", "10M",
            "-pix_fmt", "yuv420p",
        )
    raise RuntimeError("服务器 FFmpeg 缺少可用的 H.264 编码器（libx264/libopenh264）")


def normalize_reference_video(directory: pathlib.Path, files: dict[str, str]) -> None:
    """把 FFmpeg 可解码的视频统一为 ModelsNexus 可拉取的 MP4/H.264/AAC。"""
    filename = files.get("reference")
    if not filename:
        return
    source = directory / filename
    output = directory / "reference-normalized.mp4"
    # 偶数尺寸、恒定帧率、方形像素和时间戳重建可覆盖手机 MOV、屏幕录制、MKV、
    # WEBM 以及带旋转元数据的视频。音轨异常时再退回无音轨版本，画面仍可用于拆解和参考。
    video_filter = "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,setsar=1"
    encoder_options = list(ffmpeg_h264_options())
    video_options = [
        "-map", "0:v:0", "-map", "0:a:0?", "-vf",
        video_filter,
        *encoder_options,
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    ]
    video_only_options = [
        "-map", "0:v:0", "-vf", video_filter,
        *encoder_options, "-an",
    ]
    attempts = [video_options, video_only_options]
    errors: list[str] = []
    for options in attempts:
        output.unlink(missing_ok=True)
        try:
            completed = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-fflags", "+genpts",
                "-i", str(source), *options, "-map_metadata", "-1", "-sn", "-dn",
                "-movflags", "+faststart", str(output),
            ], check=True, capture_output=True, text=True, timeout=1800)
            probe_duration(output, limit=None)
            break
        except subprocess.CalledProcessError as exc:
            errors.append((exc.stderr or exc.stdout or str(exc)).strip()[-600:])
        except (subprocess.SubprocessError, OSError, ValueError) as exc:
            errors.append(str(exc)[-600:])
    else:
        output.unlink(missing_ok=True)
        detail = next((item for item in reversed(errors) if item), "FFmpeg 无法解码该文件的视频流")
        raise ValueError(f"对标视频无法读取；请确认文件未损坏并包含真实视频画面。FFmpeg：{detail}")
    source.unlink(missing_ok=True)
    final_output = directory / "reference.mp4"
    output.replace(final_output)
    files["reference"] = final_output.name


def classify_reference_upload(directory: pathlib.Path, files: dict[str, str]) -> None:
    """参考入口允许音频或视频，并以 FFprobe 的真实媒体流为准。"""
    filename = files.get("reference")
    if not filename:
        return
    source = directory / filename
    try:
        completed = subprocess.run([
            "ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(source),
        ], check=True, capture_output=True, text=True, timeout=120)
        payload = json.loads(completed.stdout or "{}")
        stream_types = {str(item.get("codec_type")) for item in payload.get("streams", []) if isinstance(item, dict)}
    except (subprocess.SubprocessError, OSError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("reference 不是 FFmpeg 可读取的音频或视频文件") from exc
    if "video" in stream_types:
        return
    if "audio" in stream_types:
        files.pop("reference", None)
        files["reference_audio"] = filename
        return
    raise ValueError("reference 文件中没有可读取的音频或视频流")


def read_lyrics(path: pathlib.Path) -> str:
    raw = path.read_bytes()[:128 * 1024]
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)[:16000]
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")[:16000]


def format_timestamp(seconds: float) -> str:
    minutes = int(max(0, seconds) // 60)
    remainder = max(0, seconds) - minutes * 60
    return f"{minutes:02d}:{remainder:06.3f}"


def build_lyric_timeline(lyrics: str, duration: float) -> list[dict[str, str]]:
    timed_lines: list[tuple[float, str]] = []
    for raw_line in lyrics.splitlines():
        timestamps = re.findall(r"\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]", raw_line)
        text = re.sub(r"\[[^\]]+\]", "", raw_line).strip()
        if not text:
            continue
        for minute, second in timestamps:
            timed_lines.append((int(minute) * 60 + float(second), text))
    if timed_lines:
        timed_lines.sort(key=lambda item: item[0])
        return [
            {
                "start": format_timestamp(start),
                "end": format_timestamp(timed_lines[index + 1][0] if index + 1 < len(timed_lines) else duration),
                "text": text,
            }
            for index, (start, text) in enumerate(timed_lines)
        ]
    plain_lines = [re.sub(r"\[[^\]]+\]", "", line).strip() for line in lyrics.splitlines()]
    plain_lines = [line for line in plain_lines if line]
    if not plain_lines:
        return [{"start": "00:00.000", "end": format_timestamp(duration), "text": "纯音乐"}]
    window = duration / len(plain_lines)
    return [
        {"start": format_timestamp(index * window), "end": format_timestamp((index + 1) * window), "text": text}
        for index, text in enumerate(plain_lines)
    ]


def image_data_url(path: pathlib.Path, output: pathlib.Path) -> str:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
            "-vf", "scale='min(1024,iw)':-2", "-frames:v", "1", "-q:v", "4", str(output),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    encoded = base64.b64encode(output.read_bytes()).decode("ascii")
    mime = mimetypes.guess_type(output.name)[0] or "image/jpeg"
    return f"data:{mime};base64,{encoded}"


def reference_frame_data_url(path: pathlib.Path, output: pathlib.Path, timestamp: float) -> str:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{timestamp:.3f}", "-i", str(path),
            "-vf", "scale='min(1024,iw)':-2", "-frames:v", "1", "-q:v", "4", str(output),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )
    encoded = base64.b64encode(output.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def detect_reference_scene_cuts(path: pathlib.Path, duration: float) -> list[float]:
    """用 FFmpeg 场景差异检测取得候选切点；失败时退回均匀采样。"""
    try:
        completed = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "info", "-i", str(path),
                "-vf", "select='gt(scene,0.28)',showinfo", "-an", "-f", "null", "-",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        cuts = [float(value) for value in re.findall(r"pts_time:([0-9.]+)", completed.stderr)]
    except (subprocess.SubprocessError, OSError, ValueError):
        cuts = []
    return sorted({round(value, 3) for value in cuts if 0.25 < value < duration - 0.25})[:40]


def reference_sample_times(duration: float, cuts: list[float], limit: int = 10) -> list[float]:
    boundaries = [0.0, *cuts, duration]
    candidates = [max(0.0, min(duration - 0.05, (start + end) / 2)) for start, end in zip(boundaries, boundaries[1:])]
    if len(candidates) < min(limit, 6):
        candidates.extend(duration * ratio for ratio in (0.08, 0.22, 0.38, 0.55, 0.72, 0.9))
    unique = sorted({round(value, 3) for value in candidates if 0 <= value < duration})
    if len(unique) <= limit:
        return unique
    indexes = [round(index * (len(unique) - 1) / (limit - 1)) for index in range(limit)]
    return [unique[index] for index in indexes]


def call_deepseek_agent(context: dict[str, Any], image_inputs: list[dict[str, str]]) -> dict[str, Any]:
    if not DEEPSEEK_API_KEY:
        raise RuntimeError("DeepSeek Agent 未配置")
    system_prompt = """你是专业音乐 MV 制作 Agent。所有上传物料均为可选项。你必须先识别本次实际提供了哪些物料，只分析真实存在的用户需求、歌曲、歌词、同级人物参考图、对标视频和参考音色；未提供的物料必须明确标记为未提供，并依靠制作需求、导演库与电影语料补全创作方案，绝不能假装已经读取。若提供对标视频，它是本次生成的权威画面骨架：按时间顺序拆解并尽量复刻每段的具体画面布局、主体数量与位置、前中后景关系、动作顺序和节拍、景别、机位、镜头运动方向以及切镜时间；只按照用户上传物料替换人物身份、服装、场景语义、文字和品牌元素。导演库与电影语料是第二层修辞增强，只用于把这个画面骨架润色为可执行的光线、色彩、质感、摄影和叙事表达，不得擅自改掉对标画面的关键几何关系、动作节奏和镜头时序。导演姓名只是方法库索引，绝不能用“某某风格”“采用某导演方法”或在提示词里附加导演姓名来代替执行。不要输出分析过程。只输出合法 JSON，结构严格为：
{
  "project_summary": "一句话项目判断",
  "creative_brief": "完整创作策略",
  "analysis_cards": [{"title":"需求理解","value":"短结论","copy":"具体依据"}],
  "timeline": [{"time":"00:00","label":"段落或情绪"}],
  "material_observations": ["从参考物料得到的具体观察"],
  "reference_breakdown": {"summary":"对标视频画面骨架概述，无参考视频时写未提供","shot_scale_pattern":"景别变化规律","composition":"构图与空间规律","lighting_color":"光线与色彩规律","blocking_performance":"人物调度与表演规律","editing_rhythm":"切镜密度、节奏与关键切点","reference_shots":[{"source_time":"00:00.000–00:03.000","visual_blueprint":"该段具体可见画面","subject_layout":"主体数量、位置、朝向、前中后景与相互关系","action_timing":"逐拍动作顺序与发生时点","shot_size_camera":"景别、焦段感、机位、视角与运镜方向","lighting_color":"具体光源、明暗和色彩","transition":"入镜、出镜与切换方式","target_mapping":"保留画面骨架，并用本项目人物与场景替换的方式"}],"rhetorical_enhancement":["导演库与电影语料对光色、质感、摄影和叙事的增强"]},
  "director_application": "如何将检索命中的电影语料转译为本项目的摄影、构图、光线和调度",
  "shots": [{
    "id":"SH01","time":"00:00–00:06","title":"镜头标题",
    "lyrics_window":"00:00.000–00:06.000 · 对应歌词原文",
    "lyrics_sync":{"start":"00:00.000","end":"00:06.000","text":"该时间段歌词原文或纯音乐","section":"主歌/副歌/间奏等","cut_on":"具体节拍、字词或动作切点"},
    "corpus_refs":["本镜实际使用的语料 ID，至少 3 项"],
    "reference_match":{"source_time":"对应对标视频时间段","visual_blueprint":"必须复刻的具体画面","subject_layout":"主体数量、位置、朝向和空间关系","action_timing":"动作顺序与节拍","camera_motion":"景别、机位与运镜方向","transition":"切镜与衔接方式"},
    "director_method":{"composition":"本镜构图落地","camera":"焦段、机位和运镜落地","lighting_color":"光线和色彩落地","blocking":"人物调度落地","rhythm":"节奏与切点落地"},
    "prompt":"必须以【时间轴 00:00.000–00:06.000｜歌词：该时间段歌词原文】开头；提供对标视频时紧接【对标画面 00:00.000–00:03.000】并完整写出要复刻的画面布局、人物位置、动作节拍、景别、机位、运镜和切镜，再写导演库与电影语料润色后的光色、质感和叙事表达；不得出现导演姓名、某某风格字样或电影语料内部编号",
    "negative_prompt":"字幕、水印、畸形肢体、面部漂移等具体负面约束"
  }]
}
analysis_cards 必须正好 4 项，分别覆盖需求、歌曲歌词、人物参考图、对标视频与镜头策略。提供对标视频时，必须结合全部抽帧时间和 FFmpeg 切点生成逐段 reference_shots，不能只概括风格或只描述第一帧；每个生成镜头都必须用 reference_match 指向具体对标时间段，并把画面布局、人物位置、动作节拍、景别、机位、运镜与切镜写进 prompt。对标视频优先决定“画面怎么摆、人物怎么动、镜头怎么走、何时切”，导演库和电影语料在不改变这些关键约束的前提下负责修辞与质感增强。shots 数量必须根据本次真实音频时长、歌词结构、对标视频切点和节奏动态决定并覆盖完整音频，不得固定为 6 项。必须严格依据输入的结构化歌词时间轴划分镜头，不得改写、遗漏或编造歌词；跨越多句歌词的镜头要把该时间窗内所有歌词写入 lyrics_sync.text 和 prompt。纯音乐段必须明确写“纯音乐”。每条 prompt 必须独立完整，不得写“同上”。每个 director_method 的五项都必须是针对该镜头的具体执行方案，不能复述语料原文。每镜的 corpus_refs 必须从检索结果的 id 中选择，至少引用 3 项，且引用必须与本镜实际执行内容一致；corpus_refs 只允许出现在 JSON 元数据字段，prompt 和 negative_prompt 正文严禁出现任何语料 ID。参考图没有主次之分。"""
    user_text = (
        "请根据以下真实项目上下文输出 JSON：\n"
        f"项目名称：{context['title']}\n"
        f"制作需求：{context['requirements']}\n"
        f"画幅：{context['ratio']}\n"
        f"目标模型：{context['model']}\n"
        f"输出清晰度：{context['resolution']}\n"
        f"导演方法库索引：{context['director']}\n"
        f"电影语料检索版本：{context['corpus_retrieval']['version']}\n"
        f"电影语料检索查询：{context['corpus_retrieval']['query']}\n"
        f"电影语料检索结果（必须按 id 引用并实际执行）：{json.dumps(context['corpus_retrieval']['items'], ensure_ascii=False)}\n"
        f"原始音频：{'已提供' if context['has_song'] else '未提供，时长由目标模型与现有物料推定'}\n"
        f"歌词文件：{'已提供' if context['has_lyrics'] else '未提供，按纯音乐规划且不得编造歌词'}\n"
        f"本次规划时长：{context['duration']:.2f} 秒\n"
        f"人物参考图数量：{context['portrait_count']}，已提供的参考图全部同级；为 0 时不得编造人物外貌\n"
        f"参考视频：{'已提供，附带抽帧' if context['has_reference'] else '未提供'}\n"
        f"参考音频：{'已提供并统一转为 WAV' if context['has_reference_audio'] else '未提供'}\n"
        f"对标视频技术拆解上下文：{json.dumps(context['reference_video'], ensure_ascii=False)}\n"
        f"结构化歌词时间轴（镜头必须与此对齐）：{json.dumps(context['lyric_timeline'], ensure_ascii=False)}\n"
        f"歌词原文：\n{context['lyrics']}"
    )
    user_content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    for image_input in image_inputs:
        user_content.append({"type": "text", "text": image_input["label"]})
        user_content.append({"type": "image_url", "image_url": {"url": image_input["url"], "detail": "low"}})
    payload = json.dumps({
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
        "max_tokens": 16000,
        "stream": False,
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{DEEPSEEK_BASE}/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "YingliuDemo/1.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=360) as response:
            api_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        raise RuntimeError(f"DeepSeek 请求失败（HTTP {exc.code}）：{detail}") from exc
    content = api_payload.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("DeepSeek 返回了空结果")
    result = json.loads(content)
    cards = result.get("analysis_cards")
    shots = result.get("shots")
    if not isinstance(cards, list) or len(cards) != 4 or not isinstance(shots, list) or len(shots) < 1:
        raise RuntimeError("DeepSeek 返回结构不完整，请重试")
    required_method_fields = {"composition", "camera", "lighting_color", "blocking", "rhythm"}
    corpus_ids = {str(item.get("id")) for item in context["corpus_retrieval"]["items"]}
    if context["has_reference"]:
        breakdown = result.get("reference_breakdown")
        required_breakdown_fields = {"summary", "shot_scale_pattern", "composition", "lighting_color", "blocking_performance", "editing_rhythm", "reference_shots", "rhetorical_enhancement"}
        if not isinstance(breakdown, dict) or not required_breakdown_fields.issubset(breakdown):
            raise RuntimeError("Agent 未完整拆解对标视频，请重新分析")
        reference_shots = breakdown.get("reference_shots")
        required_reference_shot_fields = {"source_time", "visual_blueprint", "subject_layout", "action_timing", "shot_size_camera", "lighting_color", "transition", "target_mapping"}
        if not isinstance(reference_shots, list) or not reference_shots or any(not isinstance(item, dict) or not required_reference_shot_fields.issubset(item) or any(not str(item[key]).strip() for key in required_reference_shot_fields) for item in reference_shots):
            raise RuntimeError("Agent 未逐段输出对标视频画面骨架，请重新分析")
    for shot in shots:
        method = shot.get("director_method") if isinstance(shot, dict) else None
        if not isinstance(method, dict) or not required_method_fields.issubset(method) or any(not str(method[key]).strip() for key in required_method_fields):
            raise RuntimeError("DeepSeek 未完整执行导演方法库，请重新分析")
        lyrics_sync = shot.get("lyrics_sync") if isinstance(shot, dict) else None
        required_sync_fields = {"start", "end", "text", "section", "cut_on"}
        if not isinstance(lyrics_sync, dict) or not required_sync_fields.issubset(lyrics_sync) or any(not str(lyrics_sync[key]).strip() for key in required_sync_fields):
            raise RuntimeError("DeepSeek 未完整输出歌词时间轴，请重新分析")
        prompt = str(shot.get("prompt", ""))
        if str(lyrics_sync["text"]).strip() not in prompt or str(lyrics_sync["start"]).strip() not in prompt or str(lyrics_sync["end"]).strip() not in prompt:
            raise RuntimeError("分镜提示词未写入对应歌词和起止时间，请重新分析")
        corpus_refs = shot.get("corpus_refs") if isinstance(shot, dict) else None
        if not isinstance(corpus_refs, list) or len(corpus_refs) < 3 or any(str(item) not in corpus_ids for item in corpus_refs):
            raise RuntimeError("分镜未引用有效的电影语料检索结果，请重新分析")
        if any(corpus_id in prompt or corpus_id in str(shot.get("negative_prompt", "")) for corpus_id in corpus_ids):
            raise RuntimeError("分镜提示词正文不得出现电影语料内部编号，请重新分析")
        if context["has_reference"]:
            reference_match = shot.get("reference_match") if isinstance(shot, dict) else None
            required_match_fields = {"source_time", "visual_blueprint", "subject_layout", "action_timing", "camera_motion", "transition"}
            if not isinstance(reference_match, dict) or not required_match_fields.issubset(reference_match) or any(not str(reference_match[key]).strip() for key in required_match_fields):
                raise RuntimeError("分镜未写明对标视频画面复刻约束，请重新分析")
            if str(reference_match["source_time"]).strip() not in prompt:
                raise RuntimeError("分镜提示词未写入对应的对标视频时间段，请重新分析")
    result["corpus_retrieval"] = context["corpus_retrieval"]
    result["material_manifest"] = {
        "song": context["has_song"],
        "lyrics": context["has_lyrics"],
        "portrait_count": context["portrait_count"],
        "reference_video": context["has_reference"],
        "reference_audio": context["has_reference_audio"],
    }
    result["provider"] = "DeepSeek"
    result["model"] = api_payload.get("model", DEEPSEEK_MODEL)
    result["usage"] = api_payload.get("usage", {})
    return result


def analyze_form(form: cgi.FieldStorage) -> dict[str, Any]:
    analysis_id = uuid.uuid4().hex
    directory = DATA_ROOT / f"analysis-{analysis_id}"
    directory.mkdir(mode=0o750)
    try:
        files: dict[str, str] = {}
        for key in ALLOWED_EXTENSIONS:
            if key in form and getattr(form[key], "filename", None):
                files[key] = save_upload(form[key], directory, key)
        classify_reference_upload(directory, files)
        # Agent 分析只需要从原文件抽帧和识别切点，不应先要求文件满足生成模型的交付编码。
        # 真正提交 ModelsNexus 时才执行兼容转码。
        normalize_audio_upload(directory, files, "song")
        normalize_audio_upload(directory, files, "voice")
        normalize_audio_upload(directory, files, "reference_audio")
        model_name = str(form.getfirst("model", "sd2.5海外版-720p"))[:100]
        model_spec = SEEDANCE_MODEL_SPECS.get(model_name) or MINIMAX_MODEL_SPECS.get(model_name) or {"max_duration": 15}
        if "song" in files:
            duration = probe_duration(directory / files["song"], limit=None)
        elif "reference" in files:
            duration = min(probe_duration(directory / files["reference"], limit=None), float(model_spec["max_duration"]))
        else:
            duration = float(model_spec["max_duration"])
        image_inputs: list[dict[str, str]] = []
        portrait_keys = [key for key in ALLOWED_EXTENSIONS if key.startswith("portrait") and key in files]
        for index, key in enumerate(portrait_keys):
            image_inputs.append({
                "label": f"人物参考图 {index + 1}/{len(portrait_keys)}（全部参考图同级）",
                "url": image_data_url(directory / files[key], directory / f"agent-portrait-{index + 1}.jpg"),
            })
        reference_video: dict[str, Any] = {"provided": False}
        if "reference" in files:
            try:
                reference_path = directory / files["reference"]
                reference_duration = probe_duration(reference_path, limit=None)
                scene_cuts = detect_reference_scene_cuts(reference_path, reference_duration)
                sample_times = reference_sample_times(reference_duration, scene_cuts)
                reference_video = {
                    "provided": True,
                    "duration_seconds": round(reference_duration, 3),
                    "scene_cut_times": [format_timestamp(value) for value in scene_cuts],
                    "estimated_shots": len(scene_cuts) + 1,
                    "sample_times": [format_timestamp(value) for value in sample_times],
                    "instruction": "把对标视频作为权威画面骨架，按时间顺序比较全部抽帧与切点；逐段记录具体画面、主体数量和位置、前中后景、动作节拍、景别、机位、运镜方向与切镜。生成方案尽量复刻这些结构，只替换用户人物、服装、场景语义、文字和品牌元素；导演库与电影语料仅负责修辞增强。",
                }
                for index, timestamp in enumerate(sample_times):
                    image_inputs.append({
                        "label": f"对标视频抽帧 {index + 1}/{len(sample_times)}，时间点 {format_timestamp(timestamp)}",
                        "url": reference_frame_data_url(reference_path, directory / f"agent-reference-{index + 1}.jpg", timestamp),
                    })
            except (subprocess.SubprocessError, OSError, ValueError) as exc:
                raise RuntimeError(f"对标视频拆解失败：{exc}") from exc
        director = str(form.getfirst("director", "王家卫"))[:60]
        lyrics = read_lyrics(directory / files["lyrics"]) if "lyrics" in files else ""
        corpus_query = "\n".join([
            str(form.getfirst("title", "未命名 MV")),
            str(form.getfirst("requirements", "")),
            lyrics,
            f"画幅 {form.getfirst('ratio', '16:9')}，模型 {form.getfirst('model', 'Seedance 2.5')}，清晰度 {form.getfirst('resolution', '720p')}",
            f"人物参考图 {len(portrait_keys)} 张，参考视频 {'有' if 'reference' in files else '无'}",
        ])
        director_methods = DIRECTOR_METHODS.get(director, DIRECTOR_METHODS["王家卫"])
        context = {
            "title": str(form.getfirst("title", "未命名 MV"))[:100],
            "requirements": str(form.getfirst("requirements", ""))[:4000],
            "ratio": str(form.getfirst("ratio", "16:9")),
            "model": model_name,
            "resolution": str(form.getfirst("resolution", "720p")),
            "director": director,
            "corpus_retrieval": retrieve_film_corpus(director, director_methods, corpus_query),
            "duration": duration,
            "portrait_count": len(portrait_keys),
            "has_song": "song" in files,
            "has_lyrics": "lyrics" in files,
            "has_reference_audio": "reference_audio" in files or "voice" in files,
            "has_reference": "reference" in files,
            "reference_video": reference_video,
            "lyrics": lyrics,
            "lyric_timeline": build_lyric_timeline(lyrics, duration),
        }
        return call_deepseek_agent(context, image_inputs)
    finally:
        shutil.rmtree(directory, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "YingliuDemo/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def serve_signed_asset(self, path: str, include_body: bool = True) -> bool:
        """向上游提供带 Range/HEAD 的短时素材地址；返回是否命中素材路由。"""
        if not path.startswith("/assets/"):
            return False
        try:
            _, _, job_id, token = path.split("/", 3)
            state = read_state(job_id)
            signed_assets = state.get("signed_assets") if isinstance(state.get("signed_assets"), dict) else {}
            item = signed_assets.get(token) if isinstance(signed_assets, dict) else None
            if not isinstance(item, dict) or int(item.get("expires_at", 0)) < int(time.time()):
                raise FileNotFoundError(token)
            filename = pathlib.Path(str(item.get("filename", ""))).name
            source = job_dir(job_id) / filename
            if not source.is_file() or source.parent != job_dir(job_id):
                raise FileNotFoundError(filename)
            content_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
            file_size = source.stat().st_size
            range_header = self.headers.get("Range", "")
            start, end = 0, file_size - 1
            status = HTTPStatus.OK
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip()) if range_header else None
            if match:
                if match.group(1):
                    start = int(match.group(1))
                    end = min(file_size - 1, int(match.group(2))) if match.group(2) else file_size - 1
                elif match.group(2):
                    suffix_size = min(file_size, int(match.group(2)))
                    start = file_size - suffix_size
                if start < 0 or start > end or start >= file_size:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.end_headers()
                    return True
                status = HTTPStatus.PARTIAL_CONTENT
            content_length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(content_length))
            self.send_header("Accept-Ranges", "bytes")
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Cache-Control", "private, no-store, max-age=0")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if include_body:
                with source.open("rb") as handle:
                    handle.seek(start)
                    remaining = content_length
                    while remaining > 0:
                        chunk = handle.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
        except (ValueError, FileNotFoundError, IndexError):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "素材链接不存在或已过期"})
        return True

    def do_HEAD(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/")
        if self.serve_signed_asset(path, include_body=False):
            return
        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed_url = urlparse(self.path)
        path = parsed_url.path.rstrip("/")
        if path == "/projects":
            projects = sorted(read_projects(), key=lambda item: int(item.get("updated_at", 0)), reverse=True)
            self.send_json(HTTPStatus.OK, {"projects": projects, "server_time": int(time.time())})
            return
        if path == "/health":
            self.send_json(HTTPStatus.OK, {
                "ok": True,
                "renderer": "ModelsNexus；仅 MiniMax 使用 FFmpeg 分段合成",
                "max_duration": MAX_DURATION_SECONDS,
                "providers": {
                    "modelsnexus": bool(MODELSNEXUS_API_KEY),
                    "minimax": bool(MINIMAX_API_KEY),
                    "image": bool(IMAGE_API_KEY),
                    "deepseek": bool(DEEPSEEK_API_KEY),
                },
            })
            return
        if path == "/corpus/directors":
            self.send_json(HTTPStatus.OK, public_corpus_catalog(DIRECTOR_METHODS))
            return
        if path == "/corpus/search":
            parameters = parse_qs(parsed_url.query)
            director = str(parameters.get("director", ["王家卫"])[0])[:60]
            query = str(parameters.get("q", [""])[0])[:4000]
            methods = DIRECTOR_METHODS.get(director, DIRECTOR_METHODS["王家卫"])
            self.send_json(HTTPStatus.OK, retrieve_film_corpus(director, methods, query))
            return
        if self.serve_signed_asset(path):
            return
        if path.startswith("/jobs/"):
            try:
                job_id = path.split("/")[2]
                state = read_state(job_id)
                state.pop("files", None)
                state.pop("debug", None)
                state.pop("signed_assets", None)
                state.pop("media_assets", None)
                self.send_json(HTTPStatus.OK, state)
            except (ValueError, FileNotFoundError, IndexError):
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "任务不存在或已过期"})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        request_path = urlparse(self.path).path.rstrip("/")
        if request_path == "/projects":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 2 * 1024 * 1024:
                    raise ValueError("项目数据为空或过大")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("项目数据格式无效")
                self.send_json(HTTPStatus.CREATED, create_project_record(payload))
            except (ValueError, json.JSONDecodeError) as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        if request_path not in {"/jobs", "/analyze"}:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            cleanup_expired_jobs()
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or (request_path == "/jobs" and length > MAX_UPLOAD_BYTES):
                raise ValueError("上传内容为空或超过允许大小")
            if "multipart/form-data" not in self.headers.get("Content-Type", ""):
                raise ValueError("请求必须使用 multipart/form-data")

            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    "CONTENT_LENGTH": str(length),
                },
                keep_blank_values=True,
            )
            if request_path == "/analyze":
                self.send_json(HTTPStatus.OK, analyze_form(form))
                return

            client_request_id = str(form.getfirst("client_request_id", "")).strip()[:200] or uuid.uuid4().hex
            request_digest = hashlib.sha256(client_request_id.encode("utf-8")).hexdigest()
            request_index_dir = DATA_ROOT / ".request-index"
            request_index_dir.mkdir(mode=0o750, exist_ok=True)
            request_index = request_index_dir / request_digest
            with JOBS_LOCK:
                if request_index.is_file():
                    existing_job_id = request_index.read_text(encoding="utf-8").strip()
                    existing_state = read_state(existing_job_id)
                    self.send_json(HTTPStatus.OK, {
                        "id": existing_job_id,
                        "status": existing_state.get("status", "queued"),
                        "progress": existing_state.get("progress", 5),
                        "deduplicated": True,
                    })
                    return
                job_id = uuid.uuid4().hex
                request_index.write_text(job_id, encoding="utf-8")
            directory = job_dir(job_id)
            directory.mkdir(mode=0o750)
            files: dict[str, str] = {}
            try:
                for key in ALLOWED_EXTENSIONS:
                    if key in form and getattr(form[key], "filename", None):
                        files[key] = save_upload(form[key], directory, key)
                classify_reference_upload(directory, files)
                normalize_reference_video(directory, files)
                normalize_audio_upload(directory, files, "song")
                normalize_audio_upload(directory, files, "voice")
                normalize_audio_upload(directory, files, "reference_audio")
                now = int(time.time())
                generation_plan_raw = str(form.getfirst("generation_plan", "")).strip()
                generation_plan = json.loads(generation_plan_raw) if generation_plan_raw else None
                if generation_plan is not None and not isinstance(generation_plan, dict):
                    raise ValueError("Agent 生成方案格式无效")
                state = {
                    "id": job_id,
                    "status": "queued",
                    "stage": "任务已进入生成队列",
                    "progress": 5,
                    "created_at": now,
                    "updated_at": now,
                    "title": str(form.getfirst("title", "未命名 MV"))[:100],
                    "ratio": str(form.getfirst("ratio", "16:9")),
                    "model": str(form.getfirst("model", "Seedance 2.5"))[:80],
                    "resolution": str(form.getfirst("resolution", "720p")),
                    "director": str(form.getfirst("director", "王家卫"))[:40],
                    "requirements": str(form.getfirst("requirements", ""))[:20000],
                    "generation_plan": generation_plan,
                    "client_request_id": client_request_id,
                    "submission_state": "not_started",
                    "files": files,
                }
                write_state(job_id, **state)
                EXECUTOR.submit(render_job, job_id)
            except Exception:
                shutil.rmtree(directory, ignore_errors=True)
                request_index.unlink(missing_ok=True)
                raise
            self.send_json(HTTPStatus.ACCEPTED, {"id": job_id, "status": "queued", "progress": 5})
        except ValueError as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"服务器处理失败：{exc}"})

    def do_PATCH(self) -> None:  # noqa: N802
        request_path = urlparse(self.path).path.rstrip("/")
        if not request_path.startswith("/projects/"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            project_id = request_path.split("/")[2]
            if not project_id:
                raise FileNotFoundError(project_id)
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 2 * 1024 * 1024:
                raise ValueError("项目数据为空或过大")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("项目数据格式无效")
            self.send_json(HTTPStatus.OK, update_project_record(project_id, payload))
        except FileNotFoundError:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "项目不存在"})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})

    def do_DELETE(self) -> None:  # noqa: N802
        request_path = urlparse(self.path).path.rstrip("/")
        if not request_path.startswith("/projects/"):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            project_id = request_path.split("/")[2]
            if not project_id:
                raise FileNotFoundError(project_id)
            delete_project_record(project_id)
            self.send_json(HTTPStatus.OK, {"deleted": True, "id": project_id})
        except (FileNotFoundError, IndexError):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "项目不存在"})


if __name__ == "__main__":
    print(f"Yingliu demo API listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
