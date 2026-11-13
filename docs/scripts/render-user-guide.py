from pathlib import Path
from html import escape
import json
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree
from markdown_it import MarkdownIt

root = Path(__file__).resolve().parents[2]
docs = root / 'docs'
source = docs / 'FUNCTION-USER-GUIDE.md'
text = source.read_text(encoding='utf-8')
parser = MarkdownIt('commonmark', {'html': False}).enable('table')
tokens = parser.parse(text)
missing = []
images = []
for token in tokens:
    for child in token.children or []:
        target = child.attrGet('src') if child.type == 'image' else child.attrGet('href') if child.type == 'link_open' else None
        if not target or urlsplit(target).scheme or target.startswith('#'):
            continue
        local = (docs / unquote(urlsplit(target).path)).resolve()
        if not local.exists():
            missing.append(target)
        if child.type == 'image':
            images.append(local)
for image in images:
    if image.suffix == '.svg' and image.exists():
        ElementTree.parse(image)
if missing and missing != ['./FUNCTION-USER-GUIDE.html']:
    raise SystemExit('Missing document links: ' + ', '.join(missing))

headings = []
heading_count = 0
for i, token in enumerate(tokens):
    if token.type == 'heading_open':
        label = tokens[i + 1].content
        heading_count += 1
        identity = 'section-' + str(heading_count)
        token.attrSet('id', identity)
        if token.tag in ('h1', 'h2'):
            headings.append((identity, label))
body = parser.renderer.render(tokens, parser.options, {})
toc = ''.join(f'<a href="#{identity}">{escape(label)}</a>' for identity, label in headings)
style = '''
:root{color-scheme:light;font-family:system-ui,-apple-system,"Noto Sans CJK SC",sans-serif;color:#203b52;background:#edf3f8;line-height:1.8}
*{box-sizing:border-box}body{margin:0}a{color:#2266a0;text-decoration:none}a:hover{text-decoration:underline}
header{background:#173952;color:white;padding:30px 40px}header strong{display:block;font-size:26px}header span{font-size:14px;opacity:.85}
.layout{max-width:1560px;margin:auto;display:grid;grid-template-columns:260px minmax(0,1fr);gap:24px;padding:24px}
nav{position:sticky;top:20px;align-self:start;background:white;border-radius:12px;padding:20px;max-height:calc(100vh - 40px);overflow:auto;font-size:14px}
nav a{display:block;padding:7px 0;border-bottom:1px solid #eef2f5}main{min-width:0;background:white;padding:35px 48px;border-radius:12px}
h1,h2,h3,h4{line-height:1.5;scroll-margin-top:25px}h1{font-size:30px}h2{font-size:25px;margin-top:48px;padding-bottom:10px;border-bottom:2px solid #dcebf5}h3{font-size:20px;margin-top:30px}
p,li{font-size:16px}blockquote{margin:24px 0;padding:10px 22px;border-left:5px solid #d5a642;background:#fff8e8}blockquote p{font-size:15px}
img{display:block;width:100%;height:auto;margin:22px auto;border:1px solid #dce4ec;border-radius:8px}table{width:100%;border-collapse:collapse;font-size:14px;display:block;overflow-x:auto;margin:20px 0}th,td{border:1px solid #d9e4ec;padding:10px 14px;vertical-align:top;min-width:110px}th{background:#eaf3fa;text-align:left}tr:nth-child(even){background:#fafcfe}
pre{background:#152f43;color:#e7f0f7;padding:20px;border-radius:10px;overflow:auto;font-size:13px;line-height:1.6}code{font-family:ui-monospace,monospace}p code,td code,li code{background:#edf3f8;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}hr{border:0;border-top:1px solid #e3ebf1;margin:35px 0}
@media(max-width:900px){.layout{display:block;padding:12px}nav{position:static;max-height:none;margin-bottom:14px}main{padding:22px}header{padding:22px}h1{font-size:25px}h2{font-size:22px}}
@media print{header,nav{display:none}.layout{display:block;padding:0}main{padding:0}h2{break-before:page}img,pre{break-inside:avoid}a{color:inherit}}
'''
html = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>SysAgent 管家功能与使用指南</title><style>{style}</style></head><body><header><strong>SysAgent 管家 · 功能与使用指南</strong><span>当前界面图解 / 操作与输出 / 第三方对接 / 完成状态 · 本地离线阅读</span></header><div class="layout"><nav aria-label="文档目录">{toc}<a href="FUNCTION-USER-GUIDE.md">Markdown 源文档</a></nav><main>{body}</main></div></body></html>
'''
(docs / 'FUNCTION-USER-GUIDE.html').write_text(html, encoding='utf-8')
print(json.dumps({'links': 'ok', 'images': len(images), 'svg': sum(image.suffix == '.svg' for image in images), 'output': str(docs / 'FUNCTION-USER-GUIDE.html')}, ensure_ascii=False))
