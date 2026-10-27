"""模拟 Agent 会话，不调用模型或服务商；验证首屏提交后进入同一画布继续对话。"""
import json
from urllib.request import urlopen
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:5173'
workspaces = json.load(urlopen('http://127.0.0.1:43121/api/v1/workspaces'))
space = next((item for item in workspaces if item.get('primary_project_id')), None)
assert space, '需要已有画布才能验证首屏至画布导航'
project_id = space['primary_project_id']
space_id = space['id']
messages = []
sends = []

def response(route, value, status=200):
    route.fulfill(status=status, content_type='application/json', body=json.dumps(value, ensure_ascii=False))

def agent_route(route):
    path = urlsplit(route.request.url).path.removeprefix('/api/v1/agent/sessions')
    method = route.request.method
    if path == '' and method == 'GET':
        response(route, [{'id': 'handoff-session', 'title': '继续创作', 'updatedAt': 1, 'messageCount': len(messages)}] if messages else [])
    elif path == '' and method == 'POST':
        response(route, {'id': 'handoff-session', 'title': '继续创作', 'messages': [], 'session_revision': 0}, 201)
    elif path == '/handoff-session' and method == 'GET':
        response(route, {'id': 'handoff-session', 'title': '继续创作', 'messages': messages, 'session_revision': len(messages)})
    elif path == '/handoff-session/messages' and method == 'POST':
        body = json.loads(route.request.post_data)
        sends.append(body['text'])
        messages.extend([{'id': body['message_id'], 'role': 'user', 'text': body['text']},
                         {'id': 'reply-1', 'role': 'agent', 'text': '已在画布中继续'}])
        response(route, {'run_id': 'run-handoff', 'session_revision': 1, 'duplicate': False}, 202)
    elif path == '/handoff-session/events' and method == 'GET':
        response(route, {'events': [], 'next_cursor': len(messages), 'done': True,
                         'run_id': None, 'run_state': 'completed', 'session_revision': len(messages)})
    else:
        response(route, {'error': {'message': '此测试未模拟该 Agent 动作'}}, 404)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1400, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(f"localStorage.setItem('qiyin.session.v2', JSON.stringify({{email:'admin@qiyin.local',signedInAt:Date.now(),plan:'free',role:'admin'}})); localStorage.setItem('qiyin.hero.agent.project', '{project_id}');")
    page.route('**/api/v1/agent/sessions**', agent_route)
    page.goto(BASE + '/', wait_until='networkidle')
    page.wait_for_function("document.querySelector('.agent-hero-copy')?.getAttribute('data-ready') === 'true'", timeout=12000)
    page.get_by_role('textbox', name='创作描述').fill('请规划镜头，进入画布')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    page.wait_for_url(f'**/canvas?spaceId={space_id}&projectId={project_id}', timeout=12000)
    thread = page.get_by_role('log', name='Agent 对话')
    thread.get_by_text('请规划镜头，进入画布').wait_for(timeout=12000)
    assert sends == ['请规划镜头，进入画布'], sends
    page.reload(wait_until='networkidle')
    page.get_by_role('log', name='Agent 对话').get_by_text('请规划镜头，进入画布').wait_for(timeout=12000)
    assert sends == ['请规划镜头，进入画布'], '页面刷新不得重发消息'
    assert errors == [], errors
    browser.close()
print('首屏消息提交后进入原项目画布，同一会话刷新恢复且无重复发送：通过')
