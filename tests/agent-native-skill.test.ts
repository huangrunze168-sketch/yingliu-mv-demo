import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('小QTV 原生 Skill 无需安装即可按固定版本安全注入真实 Agent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xqtv-native-skill-')); roots.push(root);
  const service = new ProjectService(openDatabase(':memory:'));
  const projectId = service.execute({ command_id: randomUUID(), actor: 'user:test', type: 'project.create', payload: { name: '武侠短片', max_budget_cents: 0, rights_confirmed: true } }).project_id!;
  let received = '';
  const app = buildServer(service, undefined, { workspaceRoot: join(root, 'workspaces'), startAgent: ({ prompt, onEvent }) => {
    received = prompt;
    const runId = randomUUID();
    onEvent({ runId, kind: 'message', text: '请补充目标时长。', at: Date.now() });
    onEvent({ runId, kind: 'done', text: 'done', at: Date.now() });
    return { runId, cancel: () => {} };
  } });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/agent/sessions', payload: { project_id: projectId } });
    const sessionId = created.json().id as string;
    const sent = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/messages`, payload: {
      project_id: projectId,
      message_id: randomUUID(),
      text: '两名侠客在竹林交手',
      expected_session_revision: 0,
      mode: 'creative',
      skill_ref: { id: 'classical-wuxia-director', version: '1.0.0' },
    } });
    expect(sent.statusCode).toBe(202);
    expect(received).toContain('<third_party_skill>');
    expect(received).toContain('绘制场景轴线和攻防路线');
    expect(received).toContain('<user_request>\n两名侠客在竹林交手\n</user_request>');
    const snapshot = (await app.inject({ method: 'GET', url: `/api/v1/agent/sessions/${sessionId}?project_id=${projectId}` })).json();
    expect(snapshot.messages[0].skillRef).toEqual({ id: 'classical-wuxia-director', version: '1.0.0', name: '古典武侠全流程导演' });
  } finally { await app.close(); }
});
