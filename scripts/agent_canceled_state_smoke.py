"""模拟本地 API：取消后的事实标记刷新后仍可见，新会话不继承旧状态。"""
import json
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:5173'
project_id = 'canceled-project'
sessions = {
    'canceled-session': {'id': 'canceled-session', 'title': '已取消的方案', 'messages': [{'id': 'user-1', 'role': 'user', 'text': '设计一段动画'}], 'session_revision': 1},
}


def answer(route, payload, status=200):
    route.fulfill(status=status, content_type='application/json', body=json.dumps(payload, ensure_ascii=False))


def api(route):
    path = urlsplit(route.request.url).path
    method = route.request.method
    if path == '/api/v1/workspaces':
        if method == 'POST':
            return answer(route, {'project': {'id': 'new-project'}}, 201)
        return answer(route, [{'name': 'Agent 创作', 'primary_project_id': project_id}] + ([{'name': 'Agent 创作 2', 'primary_project_id': 'new-project'}] if 'new-session' in sessions else []))
    if path == '/api/v1/agent/sessions':
        if method == 'GET':
            selected = 'new-session' if parse_qs(urlsplit(route.request.url).query).get('project_id') == ['new-project'] else 'canceled-session'
            return answer(route, [{'id': item['id'], 'title': item['title'], 'updatedAt': index, 'messageCount': len(item['messages'])} for index, item in enumerate([sessions[selected]], 1)])
        if method == 'POST':
            created = {'id': 'new-session', 'title': '新对话', 'messages': [], 'session_revision': 0}
            sessions[created['id']] = created
            return answer(route, created, 201)
    if path.startswith('/api/v1/agent/sessions/'):
        parts = path.split('/sessions/', 1)[1].split('/')
        item = sessions.get(parts[0])
        if not item:
            return answer(route, {'error': {'message': '找不到会话'}}, 404)
        if len(parts) == 1 and method == 'GET':
            return answer(route, item)
        if len(parts) == 2 and parts[1] == 'events' and method == 'GET':
            return answer(route, {'events': [], 'next_cursor': item['session_revision'], 'session_revision': item['session_revision'], 'done': True, 'run_id': None,
                                  **({'run_state': 'canceled', 'needs_review': False} if item['id'] == 'canceled-session' else {})})
    return answer(route, {'error': {'message': '未预期路由'}}, 404)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("localStorage.setItem('qiyin.session.v2', JSON.stringify({email:'admin@qiyin.local',signedInAt:Date.now(),plan:'free',role:'admin'}))")
    page.route('**/api/v1/workspaces', api)
    page.route('**/api/v1/agent/sessions**', api)
    page.goto(BASE + '/', wait_until='networkidle')
    canceled = page.get_by_role('status').get_by_text('本轮规划已取消', exact=False)
    canceled.wait_for(timeout=10000)
    page.reload(wait_until='networkidle')
    canceled.wait_for(timeout=10000)
    page.get_by_role('button', name='＋ 新对话').click()
    canceled.wait_for(state='hidden', timeout=10000)
    page.reload(wait_until='networkidle')
    assert page.get_by_text('本轮规划已取消', exact=False).count() == 0
    assert errors == [], errors
    browser.close()
print('取消状态在刷新后保留、新对话清除旧状态：通过')
