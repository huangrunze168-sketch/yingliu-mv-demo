import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiAdapter } from '../apps/web/src/adapters/web/apiAdapter.js';

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('API Adapter·写操作完全走 Local API', () => {
  it('创建参考素材提交 source.register，不回落演示适配器', async () => {
    let detailCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/commands')) return json({ project_id: 'p1', revision: 2 });
      detailCalls += 1;
      return json({
        id: 'p1', name: '项目', revision: detailCalls === 1 ? 1 : 2, state: 'INGESTED',
        max_budget_cents: 0, rights_confirmed: true, deleted_at: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        shot_fields: null,
        sources: detailCalls === 1 ? [] : [{ asset_id: 'a1', relative_path: 'references/reference.mp4', bytes: 1024, media_type: 'video/mp4' }],
        image_generations: [], video_generations: [], derived_artifacts: [],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createApiAdapter();
    await adapter.source.create('p1', '参考片', '知识类口播');

    const commands = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/commands'))
      .map(call => JSON.parse(String(call[1]?.body ?? '{}')) as { type: string });
    expect(commands).toEqual([expect.objectContaining({ type: 'source.register' })]);
  });

  it('未选模型不会请求服务；显式授权后仅根据 Local API 的产物响应构建预览', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/canvas/projects/p1/generations');
      return json({ request_id: 'request-1', status: 'completed', assets: [{ artifact_id: 'sha256:test', media_type: 'image/png', bytes: 68, file_name: 'verified.png', url: '/api/v1/projects/p1/assets/sha256:test' }, { artifact_id: 'sha256:test2', media_type: 'image/png', bytes: 72, file_name: 'verified-2.png', url: '/api/v1/projects/p1/assets/sha256:test2' }], notes: [], cost: { amount: 5, unit: 'credit' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createApiAdapter();
    await expect(adapter.generation.create('p1', '候选首帧', '图像生成')).rejects.toThrow('请选择一个真实模型');
    expect(fetchMock).not.toHaveBeenCalled();
    const job = await adapter.generation.create('p1', '候选首帧', '图像生成', { nodeId: 'shot-node-1', model: '测试图像模型', ratio: '16:9', rightsConfirmed: true, confirmCosts: true });
    expect(job).toMatchObject({ title: '候选首帧', status: 'succeeded', asset: { previewUrl: '/api/v1/projects/p1/assets/sha256:test' }, assets: [{ id: 'sha256:test' }, { id: 'sha256:test2' }], cost: { amount: 5, unit: 'credit' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(call[1].body))).toMatchObject({ node_id: 'shot-node-1', model: '测试图像模型', kind: 'image', rights_confirmed: true, confirm_costs: true });
  });

  it('生产项目画布载入与保存失败时不回落内存假成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('API 已离线'); }));
    const adapter = createApiAdapter();
    await expect(adapter.canvasDocuments.load('project-real')).rejects.toThrow('API 已离线');
    await expect(adapter.canvasDocuments.save('project-real', 1, { version: 2, nodes: [], edges: [] })).rejects.toThrow('API 已离线');
  });

  it('刷新恢复时完整映射真实多候选，而非只恢复首张', async () => {
    const fetchMock = vi.fn(async () => json({ request_id: 'request-1', phase: 'completed', result: { assets: [{ artifact_id: 'sha256:one', media_type: 'image/png', bytes: 68, file_name: 'one.png', url: '/one' }, { artifact_id: 'sha256:two', media_type: 'image/png', bytes: 72, file_name: 'two.png', url: '/two' }] } }));
    vi.stubGlobal('fetch', fetchMock);
    const restored = await createApiAdapter().generation.status('p1', 'request-1');
    expect(restored.job).toMatchObject({ asset: { id: 'sha256:one' }, assets: [{ id: 'sha256:one' }, { id: 'sha256:two' }] });
  });

  it('将 DSH 创作规划事件转换成画布可读方案', async () => {
    const plan = { kind: 'plan', title: '雨夜客栈', direction: '先静后快，以灯灭作为反转。', shots: [{ title: '雨幕定场', visual: '客栈檐角与雨帘。', narration: '雨夜将至。', durationSeconds: 5 }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.includes('/agent/sessions?')) return json([]); if (url.endsWith('/agent/sessions') && init?.method === 'POST') return json({ id: 's-plan', messages: [], session_revision: 0 }); if (url.endsWith('/messages')) return json({ run_id: 'run-plan' }); if (url.includes('/events?')) return json({ events: [{ id: 'p1', role: 'plan', text: JSON.stringify(plan) }], next_cursor: 2, done: true }); throw new Error(`unexpected ${url}`); });
    vi.stubGlobal('fetch', fetchMock);
    const reply = await createApiAdapter().agent.send('p-plan', '分析节奏');
    expect(reply.content).toContain('创作方案：雨夜客栈');
    expect(reply.content).toContain('1. 雨幕定场（5秒）');
    expect(reply.content).not.toContain('"kind":"plan"');
  });

  it('Agent 事件轮询将真实增量正文逐段回调，并在完成后合并结果', async () => {
    let polls = 0; const deltas: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); if (url.includes('/agent/sessions?')) return json([]); if (url.endsWith('/agent/sessions') && init?.method === 'POST') return json({ id: 's1', messages: [], session_revision: 0 }); if (url.endsWith('/messages')) return json({ run_id: 'run-1' }); if (url.includes('/events?')) { polls++; return polls === 1 ? json({ events: [{ id: 'a1', role: 'agent', text: '第一段' }], next_cursor: 1, done: false }) : json({ events: [{ id: 'a2', role: 'agent', text: '第二段' }], next_cursor: 2, done: true }); } throw new Error(`unexpected ${url}`); });
    vi.stubGlobal('fetch', fetchMock); const adapter = createApiAdapter(); const reply = await adapter.agent.send('p-stream', '继续', { skillRef: { id: 'classical-wuxia-director', version: '1.0.0' }, onDelta: message => deltas.push(message.content) });
    expect(deltas).toEqual(['第一段', '第二段']); expect(reply.content).toBe('第一段\n\n第二段');
    const messageCall = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/messages')) as unknown as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(messageCall[1].body))).toMatchObject({ mode: 'creative', skill_ref: { id: 'classical-wuxia-director', version: '1.0.0' } });
  });
});
