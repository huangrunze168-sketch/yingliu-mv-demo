#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""网页端 UI 缺口扫描 —— 给「重做」系列每轮交付自检用。

扫三件事，都要求可复跑、可对比：

  A/B  有 DOM 没样式：tsx 里用到的静态类名，在线上样式里找不到定义
  C    组件层字面量：tsx 里的 hex 色值 / inline linear-gradient / style={{ }}
  D    演示假数据：应收进示例资产包、却散落在 JSX 里的数字

用法：
    python scripts/scan-web-ui-gaps.py            # 全量报告
    python scripts/scan-web-ui-gaps.py --strict   # 有缺口则退出码 1（给 CI / 自检用）

只读脚本，不修改任何文件。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "apps" / "web" / "src"

# 线上真正被 main.tsx 引入的样式。刻意用白名单：新增样式文件必须显式加进来，
# 否则"定义了但没引入"会被误判成"已实现"。
LIVE_CSS = [
    "design-system/tokens.workbench.css",
    "design-system/tokens.marketing.css",
    "design-system/base.css",
    "design-system/components.css",
    "marketing.css",
    "features/create/create.css",
]

# 演示假数据：出现即提示"应收进示例资产包"
FAKE_DATA = [
    (r"revision\s*42", "revision 42"),
    (r"¥\s*128\.40", "本月用量 ¥128.40"),
    (r"38 次生成", "38 次生成"),
    (r"预算\s*¥\s*500", "预算 ¥500"),
    (r"\d+\s*SHOTS", "N SHOTS"),
    (r"\d+\s*ASSETS", "N ASSETS"),
    (r"\d+\s*RUNNING", "N RUNNING"),
    (r"本周\s*\+\d+%", "本周 +N%"),
]


def load_live_css() -> str:
    chunks = []
    for rel in LIVE_CSS:
        p = SRC / rel
        if p.exists():
            chunks.append(p.read_text(encoding="utf-8", errors="replace"))
        else:
            print(f"  [警告] 白名单里的样式文件不存在: {rel}", file=sys.stderr)
    return "\n".join(chunks)


def main() -> int:
    strict = "--strict" in sys.argv

    if not SRC.exists():
        print(f"找不到源码目录: {SRC}", file=sys.stderr)
        return 2

    css = load_live_css()
    defined = set(re.findall(r"\.([a-zA-Z][\w-]*)", css))
    tsx_files = sorted(SRC.rglob("*.tsx"))

    used: dict[str, set[str]] = {}
    for f in tsx_files:
        text = f.read_text(encoding="utf-8", errors="replace")
        rel = f.relative_to(SRC).as_posix()
        for m in re.finditer(r"className=[\"`]([^\"`]+)[\"`]", text):
            for tok in m.group(1).split():
                if tok.startswith("{"):
                    continue
                used.setdefault(tok, set()).add(rel)

    missing = {k: v for k, v in used.items() if k not in defined}
    literals, fake = [], []
    for f in tsx_files:
        text = f.read_text(encoding="utf-8", errors="replace")
        rel = f.relative_to(SRC).as_posix()
        hexes = sorted(set(re.findall(r"#[0-9a-fA-F]{3,8}\b", text)))
        grad = len(re.findall(r"linear-gradient", text))
        inline = len(re.findall(r"style=\{\{", text))
        if hexes or grad or inline:
            literals.append((rel, hexes, grad, inline))
        hits = [name for pat, name in FAKE_DATA if re.search(pat, text)]
        if hits:
            fake.append((rel, hits))

    print("=" * 72)
    print(f"A/B  有 DOM 没样式：用到的类名 {len(used)} 个，其中未定义 {len(missing)} 个")
    print("=" * 72)
    for k in sorted(missing):
        print(f"  {k:<28} {', '.join(sorted(missing[k]))}")

    print()
    print("=" * 72)
    print(f"C    组件层字面量：{len(literals)} 个文件有残留")
    print("=" * 72)
    for rel, hexes, grad, inline in literals:
        print(f"  {rel:<36} hex={len(hexes):<3} linear-gradient={grad:<3} style={{{{}}}}={inline}")
        if hexes:
            print(f"       {' '.join(hexes)}")

    print()
    print("=" * 72)
    print(f"D    演示假数据：{len(fake)} 个文件有残留")
    print("=" * 72)
    for rel, hits in fake:
        print(f"  {rel:<36} {', '.join(hits)}")

    total = len(missing) + len(literals) + len(fake)
    print()
    print(f"合计待处理项：{total}")
    return 1 if (strict and total) else 0


if __name__ == "__main__":
    sys.exit(main())
