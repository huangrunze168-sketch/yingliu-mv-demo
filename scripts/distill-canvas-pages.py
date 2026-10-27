# ============================================================
# 把整页 HTML 快照蒸馏成「结构 + 文案」的可读文档。
#
# 为什么要这步：
#   想知道「顶部导航有哪几项、按什么顺序」「功能格是 2×3 还是 3×2」，
#   词条表答不了，得看**渲染后的 DOM**。
#   三份整页快照是 SSR 出来的真 DOM（可见文本 120–206 字），是**甲级证据**。
#
# 产物：
#
# ============================================================

import io
import os
import re
from html.parser import HTMLParser

PAGES = [
    ('_page-home.html', '首页 /'),
    ('_page-project.html', '项目 /project'),
    ('_page-assets.html', '资产 /assets'),
    ('_page-canvas.html', '画布 /canvas'),
]
# 这些标签的内容不体现结构，直接丢弃
DROP = {'script', 'style', 'noscript', 'svg', 'path', 'defs', 'symbol', 'meta', 'link'}
# 这些标签算「结构节点」，进大纲
STRUCT = {'header', 'nav', 'main', 'aside', 'footer', 'section', 'article', 'form', 'table', 'ul', 'ol', 'li', 'button', 'a', 'h1', 'h2', 'h3', 'h4', 'input', 'select', 'textarea'}


class Outline(HTMLParser):
    """输出：结构大纲（缩进 + 标签 + 关键属性）+ 可见文本块。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.out = []
        self.visible = []
        self.skip = 0
        self.tagstack = []

    def handle_starttag(self, tag, attrs):
        if tag in DROP:
            self.skip += 1
            return
        if self.skip:
            return
        d = dict(attrs)
        if tag in STRUCT:
            cls = (d.get('class') or '')[:110]
            bits = [tag]
            if cls:
                bits.append(f'.{cls}')
            if d.get('aria-label'):
                bits.append(f"[aria-label={d['aria-label']}]")
            if d.get('placeholder'):
                bits.append(f"[placeholder={d['placeholder']}]")
            self.out.append('  ' * self.depth + ' '.join(bits))
            self.depth += 1
            self.tagstack.append(tag)

    def handle_endtag(self, tag):
        if tag in DROP:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if self.tagstack and tag == self.tagstack[-1]:
            self.tagstack.pop()
            self.depth = max(0, self.depth - 1)

    def handle_data(self, data):
        if self.skip:
            return
        t = re.sub(r'\s+', ' ', data).strip()
        if t:
            self.visible.append(t)


def distill(path, label):
    html = io.open(path, encoding='utf-8', errors='replace').read()
    body = re.search(r'<body[^>]*>(.*)</body>', html, re.S)
    fragment = body.group(1) if body else html

    o = Outline()
    o.feed(fragment)
    # 大纲里连续重复的整行压掉（列表项会重复几十次）
    lines = []
    seen_run = None
    for line in o.out:
        key = re.sub(r'\s+', ' ', line).strip()
        if key == seen_run:
            continue
        seen_run = key
        lines.append(line)

    # 可见文本里把促销倒计时那种噪声摘掉
    txt = [t for t in o.visible if not re.fullmatch(r'\d{2}:\d{2}:\d{2}:\d{2}', t)]
    joined = ' / '.join(txt)

    return {
        'label': label,
        'file': os.path.basename(path),
        'bytes': len(html),
        'outline': lines,
        'text': joined,
    }


def main():
    docs = []
    for name, label in PAGES:
        p = os.path.join(DIR, name)
        if not os.path.exists(p):
            print(f'跳过（不存在）：{p}')
            continue
        d = distill(p, label)
        docs.append(d)
        print(f'{name}: {d["bytes"]} 字节 · 结构行 {len(d["outline"])} · 可见文本 {len(d["text"])} 字')

    md = [
        '',
        '',
        '## 这份文档补什么',
        '',
        '想知道「顶部导航有哪几项、什么顺序」「功能格几个格子」得看渲染后的 DOM。',
        '',
        '## 口径',
        '',
        '- 只保留结构标签（`header`/`nav`/`main`/`section`/`button`/`a`/`ul`/`li`…），丢弃 `script`/`style`/`svg`；',
        '- 连续重复的整行压成一行（列表项会重复几十次，压掉才读得动）；',
        '- 促销倒计时（`HH:MM:SS:FF`）不进可见文本；',
        '- 这是**抓取当时的页面**，营销位与活动名会随时间变，别把活动文案当产品结构。',
        '',
    ]
    for d in docs:
        md += [
            f'## {d["label"]}　`{d["file"]}`（{d["bytes"]} 字节）',
            '',
            '### 可见文本（按文档顺序）',
            '',
            '```',
            d['text'],
            '```',
            '',
            '### 结构大纲',
            '',
            '```',
            *d['outline'],
            '```',
            '',
        ]

    out = os.path.join(DIR, '_pages.md')
    io.open(out, 'w', encoding='utf-8', newline='\n').write('\n'.join(md) + '\n')
    print(f'\n→ {out}')


if __name__ == '__main__':
    main()
