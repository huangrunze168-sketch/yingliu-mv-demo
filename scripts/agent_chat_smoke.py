"""工作台 Agent 浏览器回归；只模拟对话 API，不调用付费/外部 CLI。"""
import base64
import hashlib
import json
from urllib.request import urlopen
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:5173'
projects = json.load(urlopen('http://127.0.0.1:43121/api/v1/projects'))
assert projects, '需要至少一个项目用于打开工作台'
project_id = projects[0]['id']
sessions = {}
sent = []
video_submissions = []
selected_frames = []
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==')
image_artifact_id = 'sha256:' + hashlib.sha256(png).hexdigest()
flags = {'bulk': False, 'poll_failures': 0, 'lost_response': False, 'get_failures': 0, 'active_run': False}


def response(route, data, status=200):
    route.fulfill(status=status, content_type='application/json', body=json.dumps(data, ensure_ascii=False))


def agent_route(route):
    request = route.request
    path = urlsplit(request.url).path.split('/sessions', 1)[1]
    method = request.method
    if path == '' and method == 'GET':
        response(route, [{'id': id, 'title': item['title'], 'messageCount': len(item['messages']), 'updatedAt': 1} for id, item in reversed(list(sessions.items()))])
    elif path == '' and method == 'POST':
        id = f'session-{len(sessions) + 1}'
        sessions[id] = {'id': id, 'title': '新对话', 'messages': [], 'session_revision': 0}
        response(route, sessions[id], 201)
    else:
        parts = path.strip('/').split('/')
        id = parts[0]
        if id not in sessions:
            response(route, {'error': {'message': '会话不存在'}}, 404)
            return
        item = sessions[id]
        if len(parts) == 1:
            if flags['get_failures']:
                flags['get_failures'] -= 1
                response(route, {'error': {'message': '暂时无法读取历史'}}, 503)
                return
            if flags['bulk']:
                flags['bulk'] = False
                response(route, dict(item, messages=list(item['messages'])))
                item['messages'].extend({'id': f'bulk-{i}', 'role': 'agent', 'text': f'批量消息 {i}'} for i in range(120))
                item['session_revision'] += 120
            else:
                response(route, item)
        elif parts[1] == 'messages' and method == 'POST':
            body = json.loads(request.post_data)
            if body['text'] == '故障测试':
                response(route, {'error': {'message': 'Agent 服务暂不可用'}}, 503)
                return
            if any(message['id'] == body['message_id'] for message in item['messages']):
                response(route, {'run_id': None, 'session_revision': item['session_revision'], 'duplicate': True}, 202)
                return
            sent.append(body['text'])
            user_revision = item['session_revision'] + 1
            item['messages'].append({'id': body['message_id'], 'role': 'user', 'text': body['text']})
            if body['text'] == '创作测试':
                plan = {'kind': 'plan', 'title': '海边纪事', 'direction': '温暖纪实', 'aspectRatio': '9:16', 'shots': [{'id': 'shot-01', 'title': '抵达海边', 'visual': '金色沙滩，远景', 'narration': '', 'durationSeconds': 5}]}
                item['messages'].append({'id': 'plan-first', 'role': 'plan', 'text': json.dumps(plan, ensure_ascii=False)})
            elif body['text'] == '模型失败':
                failure = json.dumps({'type': 'error', 'status': 400, 'error': {'message': "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}, ensure_ascii=False)
                item['messages'].extend([
                    {'id': 'cli-start', 'role': 'note', 'text': 'Codex CLI 已启动'},
                    {'id': 'cli-warning', 'role': 'error', 'text': 'Exceeded skills context budget of 2%.'},
                    {'id': 'cli-failure', 'role': 'error', 'text': json.dumps({'type': 'turn.failed', 'error': {'message': failure}}, ensure_ascii=False)},
                    {'id': 'cli-done', 'role': 'note', 'text': '进程退出，退出码 1'},
                ])
            else:
                item['messages'].append({'id': f'reply-{len(sent)}', 'role': 'agent', 'text': f'真实接口返回：{body["text"]}'})
            item['title'] = body['text']
            item['session_revision'] = len(item['messages'])
            if flags['lost_response']:
                flags['lost_response'] = False
                route.abort('failed')
            else:
                response(route, {'run_id': 'run-1', 'session_revision': user_revision, 'duplicate': False}, 202)
        elif parts[1] == 'plan' and method == 'PUT':
            body = json.loads(request.post_data)
            latest = next((message for message in reversed(item['messages']) if message['role'] == 'plan'), None)
            if not latest or latest['id'] != body['plan_id'] or body['expected_session_revision'] != item['session_revision']:
                response(route, {'error': {'message': '方案已更新，请刷新后重试'}}, 409)
                return
            edited = {'id': f'plan-edit-{len(item["messages"])}', 'role': 'plan', 'text': json.dumps(body['plan'], ensure_ascii=False)}
            item['messages'].append(edited)
            item['session_revision'] += 1
            response(route, {'plan': edited, 'session_revision': item['session_revision']})
        elif parts[1] == 'plan' and len(parts) > 2 and parts[2] == 'approve' and method == 'POST':
            body = json.loads(request.post_data)
            latest = next((message for message in reversed(item['messages']) if message['role'] == 'plan'), None)
            if not latest or latest['id'] != body['plan_id'] or body['expected_session_revision'] != item['session_revision']:
                response(route, {'error': {'message': '方案已更新，请刷新后重试'}}, 409)
                return
            item['messages'].append({'id': 'approval-first', 'role': 'approval', 'text': latest['id']})
            item['session_revision'] += 1
            response(route, {'approved': True, 'generation_ready': False, 'session_revision': item['session_revision']})
        elif parts[1] == 'frames' and len(parts) > 2 and parts[2] == 'select' and method == 'POST':
            body = json.loads(request.post_data)
            selected_frames.append(body)
            item['messages'].append({'id': 'selected-frame', 'role': 'selection', 'text': json.dumps({'shotId': body['shot_id'], 'artifactId': body['artifact_id']})})
            item['session_revision'] = len(item['messages'])
            response(route, {'selected': True, 'session_revision': item['session_revision']})
        elif parts[1] == 'generate' and len(parts) > 2 and parts[2] == 'videos' and method == 'POST':
            body = json.loads(request.post_data)
            video_submissions.append(body)
            item['messages'].append({'id': 'video-start', 'role': 'progress', 'itemId': body['request_id'], 'text': json.dumps({'kind': 'video', 'phase': 'running', 'done': 0, 'total': 1})})
            item['messages'].append({'id': 'video-failed', 'role': 'progress', 'itemId': body['request_id'], 'text': json.dumps({'kind': 'video', 'phase': 'failed', 'done': 1, 'total': 1, 'failures': [{'shotId': 'shot-01', 'reason': '测试服务商拒绝'}]}, ensure_ascii=False)})
            item['session_revision'] = len(item['messages'])
            response(route, {'run_id': 'video-start', 'duplicate': False, 'session_revision': item['session_revision']}, 202)
        elif parts[1] == 'events':
            if flags['poll_failures']:
                flags['poll_failures'] -= 1
                response(route, {'error': {'message': '临时断线'}}, 503)
                return
            after = int(parse_qs(urlsplit(request.url).query).get('after', ['0'])[0])
            limit = int(parse_qs(urlsplit(request.url).query).get('limit', ['50'])[0])
            events = [{'cursor': i + 1, **msg} for i, msg in enumerate(item['messages']) if i + 1 > after][:limit]
            response(route, {'events': events, 'next_cursor': events[-1]['cursor'] if events else after, 'done': not flags['active_run'], 'run_id': 'run-restore' if flags['active_run'] else None, 'session_revision': item['session_revision']})
        elif parts[1] == 'runs' and method == 'POST':
            flags['active_run'] = False
            response(route, {'canceled': True})
        else:
            response(route, {'error': {'message': '未知路由'}}, 404)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("localStorage.setItem('qiyin.session.v2', JSON.stringify({email:'admin@qiyin.local',signedInAt:Date.now(),plan:'free',role:'admin'}))")
    page.route('**/api/v1/workspaces', lambda route: response(route, {'project': {'id': project_id}}, 201) if route.request.method == 'POST' else route.continue_())
    page.route('**/api/v1/agent/sessions**', agent_route)
    page.route('**/api/v1/agent/generation/backends', lambda route: response(route, [{'id': 'canvas', 'label': '小QTV 画布', 'installed': True, 'authenticated': None}, {'id': 'imagegen', 'label': '图像生成服务', 'installed': True, 'authenticated': None}]))
    page.route(f'**/api/v1/agent/projects/{project_id}/images/**', lambda route: route.fulfill(content_type='image/png', body=png))
    page.goto(f'{BASE}/workbench/{project_id}?section=agent', wait_until='networkidle')
    page.get_by_role('textbox', name='发送给 Agent 的消息').fill('你好，帮我规划镜头')
    page.get_by_role('button', name='发送 ↑').click()
    page.get_by_text('真实接口返回：你好，帮我规划镜头').wait_for(timeout=10000)
    assert sent == ['你好，帮我规划镜头']
    flags['bulk'] = True
    page.reload(wait_until='networkidle')
    page.get_by_text('批量消息 119').wait_for(timeout=10000)
    assert page.locator('.agent-chat-layout .chat-message').count() >= 122
    flags['poll_failures'] = 2
    page.get_by_role('textbox', name='发送给 Agent 的消息').fill('网络抖动')
    page.get_by_role('button', name='发送 ↑').click()
    page.get_by_text('真实接口返回：网络抖动').wait_for(timeout=12000)
    flags['lost_response'] = True
    page.get_by_role('textbox', name='发送给 Agent 的消息').fill('响应丢失')
    page.get_by_role('button', name='发送 ↑').click()
    page.get_by_text('真实接口返回：响应丢失').wait_for(timeout=10000)
    assert sent.count('响应丢失') == 1
    assert page.get_by_role('textbox', name='发送给 Agent 的消息').input_value() == ''
    flags['lost_response'] = True
    flags['get_failures'] = 1
    page.get_by_role('textbox', name='发送给 Agent 的消息').fill('幂等重试')
    page.get_by_role('button', name='发送 ↑').click()
    page.get_by_role('alert').wait_for()
    assert page.get_by_role('textbox', name='发送给 Agent 的消息').input_value() == '幂等重试'
    page.get_by_role('button', name='发送 ↑').click()
    page.get_by_text('真实接口返回：幂等重试').wait_for(timeout=10000)
    assert sent.count('幂等重试') == 1
    page.wait_for_function("!document.querySelector('.agent-progress')", timeout=10000)
    flags['poll_failures'] = 4
    page.get_by_role('textbox', name='发送给 Agent 的消息').fill('持续中断')
    page.get_by_role('button', name='发送 ↑').click()
    page.get_by_role('alert').get_by_text('临时断线').wait_for(timeout=12000)
    page.get_by_role('button', name='恢复对话').click()
    page.get_by_text('真实接口返回：持续中断').wait_for(timeout=10000)
    page.get_by_role('textbox', name='发送给 Agent 的消息').fill('故障测试')
    page.get_by_role('button', name='发送 ↑').click()
    page.get_by_role('alert').get_by_text('Agent 服务暂不可用').wait_for()
    assert page.get_by_role('textbox', name='发送给 Agent 的消息').input_value() == '故障测试'
    page.get_by_role('textbox', name='发送给 Agent 的消息').fill('生成视频')
    page.get_by_role('button', name='发送 ↑').click()
    page.get_by_role('alertdialog', name='确认高风险动作').wait_for()
    assert sent == ['你好，帮我规划镜头', '网络抖动', '响应丢失', '幂等重试', '持续中断']
    page.get_by_role('button', name='返回修改').click()
    page.get_by_role('button', name='＋ 新会话').click()
    page.get_by_text('还没有对话。输入问题即可开始。').wait_for(state='hidden')
    assert len(sessions) == 2
    flags['active_run'] = True
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name='停止').wait_for(timeout=10000)
    page.get_by_role('button', name='停止').click()
    page.wait_for_function("!document.querySelector('.agent-progress')", timeout=10000)
    page.goto(BASE + '/', wait_until='networkidle')
    page.wait_for_function("document.querySelector('.agent-hero-copy')?.getAttribute('data-ready') === 'true'", timeout=12000)
    page.get_by_role('textbox', name='创作描述').fill('首页直接对话')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    assert urlsplit(page.url).path == '/', '首页发送不应跳转工作台'
    page.get_by_text('真实接口返回：首页直接对话').wait_for(timeout=10000)
    page.get_by_role('textbox', name='创作描述').fill('生成视频')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    page.get_by_role('alertdialog', name='确认高风险动作').wait_for()
    assert sent.count('生成视频') == 0
    page.get_by_role('button', name='返回修改').click()
    page.get_by_role('textbox', name='创作描述').fill('故障测试')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    page.get_by_role('alert').get_by_text('Agent 服务暂不可用').wait_for(timeout=10000)
    assert page.get_by_role('textbox', name='创作描述').input_value() == '故障测试'
    page.reload(wait_until='networkidle')
    page.get_by_text('真实接口返回：首页直接对话').wait_for(timeout=10000)
    page.goto(BASE + '/workbench', wait_until='networkidle')
    page.wait_for_function("document.querySelector('.agent-hero-copy')?.getAttribute('data-ready') === 'true'", timeout=12000)
    page.get_by_role('textbox', name='创作描述').fill('项目首页直接对话')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    assert urlsplit(page.url).path == '/workbench', '项目首页发送不应跳转工作台详情'
    page.get_by_text('真实接口返回：项目首页直接对话').wait_for(timeout=10000)
    guest = browser.new_page()
    guest.goto(BASE + '/', wait_until='networkidle')
    guest.wait_for_function("document.querySelector('.agent-hero-copy')?.getAttribute('data-ready') === 'true'", timeout=12000)
    guest.get_by_role('textbox', name='创作描述').fill('登录后继续的创意')
    guest.get_by_role('textbox', name='创作描述').press('Enter')
    guest.wait_for_url('**/signup?next=%2F', timeout=10000)
    guest.get_by_label('邮箱').fill('admin@qiyin.local')
    guest.get_by_label('密码').fill('Admin@123456')
    guest.get_by_role('checkbox').check()
    guest.get_by_role('button', name='免费开始创作').click()
    guest.wait_for_url(BASE + '/', timeout=10000)
    assert guest.get_by_role('textbox', name='创作描述').input_value() == '登录后继续的创意'
    guest.close()
    page.goto(BASE + '/', wait_until='networkidle')
    page.wait_for_function("document.querySelector('.agent-hero-copy')?.getAttribute('data-ready') === 'true'", timeout=12000)
    page.get_by_role('button', name='＋ 新对话').click()
    page.get_by_role('textbox', name='创作描述').fill('创作测试')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    page.get_by_role('region', name='可编辑创作方案').wait_for(timeout=10000)
    assert page.get_by_role('textbox', name='方案片名').input_value() == '海边纪事'
    assert page.get_by_role('button', name='确认方案').is_enabled()
    page.get_by_role('textbox', name='镜头 1 画面').fill('有海鸥飞过的金色沙滩')
    assert page.get_by_role('button', name='确认方案').is_disabled(), '未保存的修改不得被确认'
    page.get_by_role('button', name='保存修改').click()
    page.get_by_role('textbox', name='镜头 1 画面').wait_for(timeout=10000)
    assert page.get_by_role('textbox', name='镜头 1 画面').input_value() == '有海鸥飞过的金色沙滩'
    page.get_by_role('button', name='确认方案').click()
    page.get_by_text('方案已确认并绑定项目分镜', exact=False).wait_for(timeout=10000)
    panel = page.get_by_role('region', name='真实生成任务')
    panel.wait_for(timeout=10000)
    assert panel.get_by_role('button', name='确认并生成 1 镜首帧').is_disabled(), '未选择后端及确认费用时不得调用真实生成'
    video_panel = page.get_by_role('region', name='真实视频生成任务')
    assert video_panel.get_by_role('button', name='确认并生成 1 镜视频').is_disabled(), '首帧未选定时不得批准 G2 视频生成'
    current = list(sessions.values())[-1]
    current['messages'].append({'id': 'image-produced', 'role': 'asset', 'text': json.dumps({'kind': 'image', 'shotId': 'shot-01', 'artifactId': image_artifact_id,
        'url': f'/api/v1/agent/projects/{project_id}/images/{image_artifact_id}'})})
    current['session_revision'] = len(current['messages'])
    page.reload(wait_until='networkidle')
    panel = page.get_by_role('region', name='真实生成任务')
    panel.get_by_role('button', name='选为视频首帧').click()
    assert len(selected_frames) == 1 and selected_frames[0]['artifact_id'] == image_artifact_id
    video_panel = page.get_by_role('region', name='真实视频生成任务')
    video_panel.get_by_text('1/1 镜已选首帧').wait_for(timeout=10000)
    assert video_panel.get_by_role('button', name='确认并生成 1 镜视频').is_disabled(), '选帧不代表视频费用获批'
    video_panel.get_by_label('真实视频生成后端').select_option('canvas')
    page.wait_for_timeout(400)
    video_panel.get_by_label('视频项目预算上限').fill('100')
    video_panel.get_by_label('独立视频预算').fill('30')
    video_panel.get_by_label('每镜视频预估费用').fill('20')
    video_panel.get_by_label('真实视频模型').fill('model-video-test')
    video_panel.get_by_role('checkbox').nth(0).check()
    assert video_panel.get_by_role('button', name='确认并生成 1 镜视频').is_disabled(), '未单独确认视频费用不得请求后端'
    video_panel.get_by_role('checkbox').nth(1).check()
    assert video_panel.get_by_role('button', name='确认并生成 1 镜视频').is_enabled(), str(video_panel.locator('input, select').evaluate_all('(els) => els.map(e => ({label:e.getAttribute("aria-label"),value:e.value,checked:e.checked,disabled:e.disabled}))'))
    video_panel.get_by_role('button', name='确认并生成 1 镜视频').click()
    video_panel.get_by_text('测试服务商拒绝', exact=False).wait_for(timeout=10000)
    assert len(video_submissions) == 1 and video_submissions[0]['video_budget_cents'] == 3000
    assert video_submissions[0]['rights_confirmed'] and video_submissions[0]['confirm_costs']
    assert video_panel.locator('video').count() == 0, '服务商失败不能出现假视频预览'
    current['messages'].append({'id': 'historical-video', 'role': 'asset', 'text': json.dumps({'kind': 'video', 'shotId': 'shot-01', 'artifactId': 'sha256:' + 'b' * 64,
        'firstFrameArtifactId': image_artifact_id, 'url': f'/api/v1/agent/projects/{project_id}/videos/sha256:' + 'b' * 64})})
    current['messages'].append({'id': 'new-frame', 'role': 'selection', 'text': json.dumps({'shotId': 'shot-01', 'artifactId': 'sha256:' + 'c' * 64})})
    current['session_revision'] = len(current['messages'])
    page.reload(wait_until='networkidle')
    page.get_by_role('region', name='真实视频生成任务').get_by_text('历史片段：当前首帧不同', exact=False).wait_for(timeout=10000)
    page.get_by_text('方案已确认并绑定项目分镜', exact=False).wait_for(timeout=10000)
    page.get_by_role('button', name='＋ 新对话').click()
    page.get_by_role('textbox', name='创作描述').fill('模型失败')
    page.get_by_role('textbox', name='创作描述').press('Enter')
    page.get_by_role('alert').get_by_text('Codex CLI 版本过旧', exact=False).wait_for(timeout=10000)
    assert page.locator('.agent-thread .agent-msg.agent').count() == 0, '失败不能伪装成助手回复'
    assert page.get_by_role('alert').count() == 1, '同一失败不能刷屏'
    assert page.get_by_text('Codex CLI 已启动').count() == 0
    assert page.get_by_text('skills context budget', exact=False).count() == 0
    page.reload(wait_until='networkidle')
    page.get_by_role('alert').get_by_text('Codex CLI 版本过旧', exact=False).wait_for(timeout=10000)
    interrupted = list(sessions.values())[-1]
    interrupted['messages'].append({'id': 'interrupted-user', 'role': 'user', 'text': '一条发送后服务重启的请求'})
    interrupted['session_revision'] = len(interrupted['messages'])
    page.reload(wait_until='networkidle')
    page.get_by_role('alert').get_by_text('上轮规划没有收到核实后的答复', exact=False).wait_for(timeout=10000)
    assert page.locator('.agent-thread .agent-msg.agent').count() == 0, '中断不能伪装成助手答复'
    assert not errors, errors
    print('Agent 创作对话通过：方案编辑/确认、失败去重与历史兼容、首屏原位、登录草稿、断线重试；无 JS 异常')
    browser.close()
