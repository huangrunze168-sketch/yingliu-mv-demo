"""只读画布浏览器回归：模拟项目快照与产物响应，不调用付费生成。"""
import base64
import hashlib
import json
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:5173'
projects = json.load(urlopen('http://127.0.0.1:43121/api/v1/projects'))
assert projects, '需要已有项目验证画布路由'
project = projects[0]
project_id = project['id']
workspace_id = project['workspace_id']
png = __import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==')
artifact_id = 'sha256:' + hashlib.sha256(png).hexdigest()
image_url = f'{BASE}/api/v1/agent/projects/{project_id}/images/sha256%3A{artifact_id.split(":", 1)[1]}'
webm = base64.b64decode('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHpEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggHT7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYhZOr5m86IUbJyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhDuaygDgkLCBELqBEJqBAlW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAwc3PWY8CLY8WIWTq+ZvOiFGxnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1qOeBAKOjgQAAgBACAJ0BKhAAEAAARwiFhYiZhIgCAgAMDWAA/v+rUIAcU7trkbuPs4EAt4r3gQHxggGm8IED')
video_id = 'sha256:' + hashlib.sha256(webm).hexdigest()
snapshot = dict(project, shot_fields={'shots': [{'shot_id': 'shot-01', 'author': 'agent:test', 'replacement': '夕阳海面，逆光远景', 'duration_ms': 5000}]},
                candidates=[{'candidate_id': 'mock-first-frame', 'shot_id': 'shot-01', 'artifact_id': artifact_id, 'status': 'ACTIVE'}], image_generations=[],
                 selections=[{'shot_id': 'shot-01', 'candidate_id': 'mock-first-frame'}],
                 video_generations=[{'shot_id': 'shot-01', 'status': 'COMPLETED', 'clip_artifact_id': video_id}])

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1500, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("localStorage.setItem('qiyin.session.v2', JSON.stringify({email:'admin@qiyin.local',signedInAt:Date.now(),plan:'free',role:'admin'}))")
    page.route(f'**/api/v1/projects/{project_id}', lambda route: route.fulfill(content_type='application/json', body=json.dumps(snapshot, ensure_ascii=False)))
    page.route(f'**/api/v1/agent/projects/{project_id}/images/**', lambda route: route.fulfill(content_type='image/png', body=png))
    page.route(f'**/api/v1/agent/projects/{project_id}/videos/**', lambda route: route.fulfill(content_type='video/webm', body=webm, headers={'accept-ranges': 'bytes'}))
    page.goto(f'{BASE}/canvas?spaceId={workspace_id}&projectId={project_id}', wait_until='networkidle')
    page.locator('[data-node-id="project-plan-shot-01"]').wait_for(state='attached', timeout=12000)
    image = page.locator('[data-node-id="project-frame-shot-01"] img')
    video = page.locator('[data-node-id="project-video-shot-01"] video[controls]')
    image.wait_for(state='attached', timeout=12000)
    assert page.locator('[data-node-id="project-plan-shot-01"]').is_visible(), '分镜节点必须真正出现在画布中'
    assert image.is_visible(), '首帧必须真正可见，而不只是挂在隐藏节点的 DOM 中'
    assert image.evaluate('(node) => node.complete && node.naturalWidth > 0'), '项目图像节点必须展示实际文件'
    video.wait_for(state='attached', timeout=12000)
    assert video.is_visible(), '视频节点必须连到同一项目画布并呈现真实预览控件'
    page.wait_for_function("document.querySelector('[data-node-id=\"project-video-shot-01\"] video')?.readyState >= 1", timeout=12000)
    assert video.evaluate('(node) => node.duration > 0 && !node.error'), '浏览器必须加载可播放视频元数据'
    assert page.locator('[data-node-id="project-video-shot-01"] button[aria-label="开始生成"]').count() == 0, '视频事实节点不得暴露假生成按钮'
    assert page.get_by_text('夕阳海面，逆光远景', exact=False).count() >= 1, '分镜画面描述必须来自项目事实'
    assert page.locator('[data-node-id="project-frame-shot-01"] button[aria-label="开始生成"]').count() == 0, '只读事实节点不得暴露伪生成按钮'
    assert not errors, errors
    print('画布 Agent 项目分镜、真实文件预览及只读节点通过')
    browser.close()
