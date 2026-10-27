"""映流电影语言语料检索。

语料只描述可执行的摄影与调度方法，不收录电影台词、剧本、分镜截图或受版权保护的
作品内容。检索结果带稳定 ID，供 Agent 在逐镜结果中引用和审计。
"""

from __future__ import annotations

import math
import re
import hashlib
from collections import Counter
from typing import Any


CORPUS_VERSION = "zy-film-language-2026.10-v1"

CATEGORY_META: dict[str, tuple[str, tuple[str, ...]]] = {
    "composition": ("构图", ("构图", "空间", "前景", "背景", "对称", "留白", "景深", "层次")),
    "camera": ("摄影机", ("镜头", "焦段", "机位", "运镜", "跟拍", "推进", "横移", "手持")),
    "lighting": ("光线", ("光线", "主光", "轮廓光", "自然光", "逆光", "低照度", "明暗")),
    "color": ("色彩", ("色彩", "色温", "饱和", "冷暖", "肤色", "综合色", "主色")),
    "blocking": ("人物调度", ("人物", "动作", "表演", "走位", "调度", "视线", "群像", "关系")),
    "rhythm": ("节奏剪辑", ("节奏", "剪辑", "切点", "重拍", "长镜头", "快剪", "停顿", "副歌")),
    "avoid": ("禁用规则", ("避免", "禁止", "不要", "字幕", "水印", "漂移", "畸形", "滥用")),
}

GENERAL_CORPUS: tuple[dict[str, Any], ...] = (
    {
        "id": "general.mv.lip-sync",
        "category": "blocking",
        "title": "演唱口型与身体表演",
        "tags": ["演唱", "口型", "歌词", "粤语", "表情", "动作", "节拍"],
        "text": "演唱镜头必须锁定歌词时间窗；口型、呼吸、下颌和面部肌肉随发音连续变化，身体动作落在节拍上，不能只让嘴部机械开合。",
    },
    {
        "id": "general.mv.continuity",
        "category": "rhythm",
        "title": "跨镜动作与视线连续",
        "tags": ["衔接", "连续性", "动作", "视线", "切镜", "首尾状态"],
        "text": "每镜明确开场状态、结束动作、运动方向和视线目标；下一镜承接上一镜的姿态或动作结果，避免人物位置、朝向和道具状态跳变。",
    },
    {
        "id": "general.mv.identity",
        "category": "composition",
        "title": "人物身份一致性",
        "tags": ["人物", "参考图", "身份", "五官", "服装", "发型", "一致性"],
        "text": "全部人物参考图同级构成一个身份约束；每镜保持五官、发型、年龄、体态和服装连续，不把不同角度误判成不同人物。",
    },
    {
        "id": "general.stage.crowd",
        "category": "blocking",
        "title": "舞台与群像调度",
        "tags": ["舞台", "DJ", "观众", "村民", "群像", "人群", "表演"],
        "text": "舞台主体、设备和观众分为前中后景；人群动作存在节奏差异和个体区分，关键关系人物通过视线、逆向动作或短暂静止被识别。",
    },
    {
        "id": "general.reference.method-only",
        "category": "avoid",
        "title": "参考片只提取方法",
        "tags": ["参考视频", "同款", "镜头语言", "版权", "复制", "方法"],
        "text": "参考片只用于提取景别变化、运镜、节奏和调度方法，不复制具体角色、场景、标志性构图、台词或可识别作品元素。",
    },
    {
        "id": "general.video.negative",
        "category": "avoid",
        "title": "视频生成负面约束",
        "tags": ["字幕", "水印", "畸形", "漂移", "闪烁", "多手", "画质"],
        "text": "排除字幕、水印、品牌标记、额外人物、肢体畸形、手指粘连、面部漂移、服装跳变、背景闪烁、时间倒流和无动机镜头抖动。",
    },
)


def _tokens(value: str) -> list[str]:
    normalized = re.sub(r"\s+", "", value.lower())
    chinese_runs = re.findall(r"[\u3400-\u9fff]+", normalized)
    ascii_words = re.findall(r"[a-z0-9]+", normalized)
    result = list(ascii_words)
    for run in chinese_runs:
        result.extend(run)
        result.extend(run[index:index + 2] for index in range(max(0, len(run) - 1)))
    return result


def _score(query: Counter[str], document: Counter[str], tags: list[str]) -> float:
    if not query:
        return 0.0
    overlap = sum(min(count, document.get(token, 0)) for token, count in query.items())
    cosine_denominator = math.sqrt(sum(value * value for value in query.values())) * math.sqrt(
        sum(value * value for value in document.values())
    )
    cosine = overlap / cosine_denominator if cosine_denominator else 0.0
    tag_bonus = sum(1.4 for tag in tags if tag and tag.lower() in "".join(query.keys()))
    return round(cosine * 10 + overlap * 0.35 + tag_bonus, 4)


def build_director_records(director: str, methods: dict[str, str]) -> list[dict[str, Any]]:
    """把一位导演的七维方法拆为可独立召回、可引用的语料记录。"""
    records: list[dict[str, Any]] = []
    slug = hashlib.sha1(director.encode("utf-8")).hexdigest()[:10]
    for category, text in methods.items():
        label, keywords = CATEGORY_META.get(category, (category, (category,)))
        records.append({
            "id": f"director.{slug}.{category}",
            "director": director,
            "category": category,
            "title": f"{director} · {label}",
            "tags": list(keywords),
            "text": text,
            "source": "ZY 导演电影语言库",
        })
    return records


def retrieve_film_corpus(
    director: str,
    director_methods: dict[str, str],
    query: str,
    *,
    general_limit: int = 4,
) -> dict[str, Any]:
    """检索所选导演的完整七维方法，并按项目语义召回通用电影语言条目。"""
    query_counter = Counter(_tokens(query))
    director_records = build_director_records(director, director_methods)
    general_records = [dict(item, director="通用") for item in GENERAL_CORPUS]
    for record in director_records + general_records:
        searchable = " ".join([
            record.get("title", ""), record.get("text", ""), " ".join(record.get("tags", [])),
        ])
        record["score"] = _score(query_counter, Counter(_tokens(searchable)), record.get("tags", []))

    # 导演方法按得分排序，但七个类别必须全部进入上下文，避免只召回表面相似的一两项。
    director_records.sort(key=lambda item: (-float(item["score"]), item["category"]))
    general_records.sort(key=lambda item: (-float(item["score"]), item["id"]))
    selected = director_records + general_records[:max(0, general_limit)]
    return {
        "version": CORPUS_VERSION,
        "query": query[:4000],
        "director": director,
        "coverage": sorted({item["category"] for item in director_records}),
        "items": selected,
        "stats": {
            "director_entries": len(director_records),
            "general_entries": len(general_records),
            "returned": len(selected),
        },
    }


def public_corpus_catalog(director_methods: dict[str, dict[str, str]]) -> dict[str, Any]:
    return {
        "version": CORPUS_VERSION,
        "directors": [
            {
                "name": name,
                "categories": [CATEGORY_META.get(category, (category, ()))[0] for category in methods],
                "entries": len(methods),
            }
            for name, methods in director_methods.items()
        ],
        "general_entries": len(GENERAL_CORPUS),
        "copyright_scope": "仅含原创的电影语言方法描述，不含电影台词、剧本、截图或影片素材。",
    }
