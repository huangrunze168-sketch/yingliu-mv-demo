"""本地只读 API 替身：验证未知计费状态必须点击明确确认后才能续聊。"""
import json
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:5173'
project_id = 'review-project'
session_id = 'review-session'
messages = [
    {'id': 'user-unknown', 'role': 'user', 'text': '上一轮创作'},
    {'id': 'interrupted-user-unknown', 'role': 'error', 'text': '上轮规划中断，结果与计费状态未知。'},
]
state = {'reviewed': False, 'visible_unknown': False, 'blocked': 0, 'sent': []}


def json_reply(route, payload, code=200):
    route.fulfill(status=code, content_type='application/json', body=json.dumps(payload, ensure_ascii=False))


def route_api(route):
    path = urlsplit(route.request.url).path
    method = route.request.method
    if path == '/api/v1/workspaces':
        return json_reply(route, [{'name': 'Agent 创作', 'primary_project_id': project_id}])
    if path == '/api/v1/agent/sessions' and method == 'GET':
        return json_reply(route, [{'id': session_id, 'title': '上一轮创作', 'updatedAt': 1, 'messageCount': len(messages)}])
    base = f'/api/v1/agent/sessions/{session_id}'
    if path == base and method == 'GET':
        return json_reply(route, {'id': session_id, 'title': '上一轮创作', 'messages': messages, 'session_revision': len(messages)})
    if path == f'{base}/events' and method == 'GET':
        return json_reply(route, {'events': [], 'next_cursor': len(messages), 'done': True, 'run_id': None,
                                  'run_state': 'unknown' if state['visible_unknown'] else 'completed',
                                  'needs_review': state['visible_unknown'] and not state['reviewed'], 'session_revision': len(messages)})
    if path == f'{base}/runs/user-unknown/acknowledge' and method == 'POST':
        data = json.loads(route.request.post_data)
        assert data['confirm_unknown'] is True
        state['reviewed'] = True
        return json_reply(route, {'run_state': 'unknown', 'needs_review': False, 'session_revision': len(messages)})
    if path == f'{base}/messages' and method == 'POST':
        if not state['reviewed']:
            state['blocked'] += 1
            state['visible_unknown'] = True
            return json_reply(route, {'error': {'code': 'PREVIOUS_RUN_NEEDS_REVIEW', 'message': '上轮结果与费用未知，请先确认知晓风险'}}, 409)
        state['sent'].append(json.loads(route.request.post_data)['text'])
        return json_reply(route, {'run_id': 'safe-new-run', 'session_revision': len(messages) + 1, 'duplicate': False}, 202)
    return json_reply(route, {'error': {'message': f'未预期请求：{method} {path}'}}, 404)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("localStorage.setItem('qiyin.session.v2', JSON.stringify({email:'admin@qiyin.local',signedInAt:Date.now(),plan:'free',role:'admin'}))")
    page.route('**/api/v1/workspaces', route_api)
    page.route('**/api/v1/agent/sessions**', route_api)
    page.goto(BASE + '/', wait_until='networkidle')
    page.wait_for_function("document.querySelector('.agent-hero-copy')?.getAttribute('data-ready') === 'true'", timeout=12000)
    review = page.get_by_role('button', name='我已知晓，允许继续')
    assert review.count() == 0, '模拟另一标签页尚未同步的情况'
    page.get_by_role('textbox', name='创作描述').fill('跨页状态过期的请求')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    try:
        review.wait_for(timeout=10000)
    except Exception:
        print('诊断状态：', state, '提示：', page.get_by_role('alert').all_text_contents(), '确认窗：', page.get_by_role('alertdialog').count())
        raise
    assert state['blocked'] == 1 and state['sent'] == [], '冲突只应被拦截一次，不能自动重复模型调用'
    assert page.get_by_role('textbox', name='创作描述').input_value() == '跨页状态过期的请求'
    page.reload(wait_until='networkidle')
    review.wait_for(timeout=10000)
    assert state['sent'] == []
    review.click()
    review.wait_for(state='hidden', timeout=10000)
    page.get_by_role('textbox', name='创作描述').fill('续写一个新方案')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    page.wait_for_function("() => !!document.querySelector('.agent-thread')", timeout=10000)
    assert state['sent'] == ['续写一个新方案'], state['sent']
    assert errors == [], errors
    browser.close()
print('未知计费状态经明确知晓后才允许续聊：通过')
