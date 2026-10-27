"""只读浏览器回归：拒绝逐节点授权，不得发起任何真实生成请求。"""
import base64
import hashlib
import json
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:5173'
API = 'http://127.0.0.1:43121'
projects = json.load(urlopen(f'{API}/api/v1/projects'))
assert projects, '需要一个已有本地项目验证画布路由'
project = projects[0]
project_id = project['id']
workspace_id = project['workspace_id']
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==')
artifact_id = 'sha256:' + hashlib.sha256(png).hexdigest()
fake_id = 'sha256:' + 'e' * 64

def saved_node(node_id, label, x, status, artifact=None, job=None, y=90):
    data = {'label': label, 'kind': 'imageNode', 'status': status, 'aspectRatio': '16:9',
            'prompt': '只用于验证取消按钮', 'model': '测试专用模型'}
    if artifact:
        data.update(artifactId=artifact, mediaKind='image', jobId=job)
    return {'id': node_id, 'type': 'qtv', 'position': {'x': x, 'y': y}, 'data': data}

doc = {'version': 2, 'nodes': [saved_node('consent-node', '授权验证镜头', 80, 'draft'),
                               saved_node('verified-node', '已登记镜头', 640, 'ready', artifact_id, 'request-1'),
                               saved_node('unverified-node', '假登记镜头', 1200, 'ready', fake_id, 'request-2'),
                               saved_node('interrupted-node', '中断镜头', 80, 'running', y=440)], 'edges': []}
snapshot = dict(project, canvas_document={'document': doc, 'document_revision': 1},
                derived_artifacts=[{'artifact_id': artifact_id, 'media_type': 'image/png', 'status': 'PUBLISHED', 'metadata': {'source': 'canvas-generation', 'project_id': project_id, 'node_id': 'web-request-1'}}],
                 image_generations=[{'intent_id': 'legacy-intent', 'status': 'COMPLETED', 'prompt': '只用于验证取消按钮'}])

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1500, 'height': 900})
    errors = []
    approvals = []
    generation_calls = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: (approvals.append(dialog.message), dialog.dismiss()))
    page.add_init_script("localStorage.setItem('qiyin.session.v2', JSON.stringify({email:'admin@qiyin.local',signedInAt:Date.now(),plan:'free',role:'admin'}))")
    page.route(f'**/api/v1/projects/{project_id}', lambda route: route.fulfill(content_type='application/json', body=json.dumps(snapshot, ensure_ascii=False)))
    page.route(f'**/api/v1/projects/{project_id}/assets/**', lambda route: route.fulfill(content_type='image/png', body=png))
    page.route('**/api/v1/canvas/projects/*/generations', lambda route: (generation_calls.append(route.request.url), route.fulfill(status=500, content_type='application/json', body='{}')))
    page.goto(f'{BASE}/canvas?spaceId={workspace_id}&projectId={project_id}', wait_until='networkidle')
    node = page.locator('[data-node-id="consent-node"]')
    node.wait_for(state='visible', timeout=12000)
    page.wait_for_timeout(3200)  # 覆盖旧实现的三秒历史任务轮询。
    assert node.locator('.qtv-node-state.is-draft').count() == 1, '同名旧任务不得冒充当前节点成功'
    assert node.locator('.qtv-project-preview').count() == 0, '没有产物时不能显示预览'
    registered = page.locator('[data-node-id="verified-node"]')
    unverified = page.locator('[data-node-id="unverified-node"]')
    assert registered.locator('.qtv-node-state.is-ready').count() == 1, '已发布且绑定任务的产物刷新后应恢复完成'
    assert registered.locator('img.qtv-project-preview').count() == 1
    assert unverified.locator('.qtv-node-state.is-draft').count() == 1, '缺少登记产物的假哈希不得恢复成功'
    assert unverified.locator('img.qtv-project-preview').count() == 0, '假资产不得当作可用产物预览'
    node.locator('.qtv-node-stage').click()
    node.get_by_role('button', name='开始生成').click()
    page.wait_for_function("document.querySelector('.qtv-canvas-message')?.textContent?.includes('未授权真实生成') || document.body.innerText.includes('未授权真实生成')", timeout=10000)
    assert len(approvals) == 1, approvals
    assert '授权验证镜头' in approvals[0] and '测试专用模型' in approvals[0] and '准确单价' in approvals[0], approvals
    interrupted = page.locator('[data-node-id="interrupted-node"]')
    assert interrupted.locator('.qtv-node-state.is-unknown').count() == 1, '页面离开时未结算的运行不得伪装成新草稿'
    interrupted.locator('.qtv-node-stage').click()
    interrupted.get_by_role('button', name='核查结果与费用后重试').click()
    assert len(approvals) == 2 and '可能重复计费' in approvals[1], approvals
    assert generation_calls == [], generation_calls
    assert errors == [], errors
    browser.close()
print('同名旧任务不伪装成功；拒绝逐节点授权不会调用服务商：通过')
