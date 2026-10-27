import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../apps/local-api/src/server.js';

const shot = {
  shot_id: 'shot-01', t0_ms: 0, t1_ms: 2100, duration_ms: 2100,
  shot_size: 'medium_close_up', camera_position: 'eye_level', camera_move: 'slow_push_in',
  lighting: 'soft_key_from_left', sound: 'dialogue', replacement: '替换人物，保留窗光方向',
  confidence: 0.9, source: 'human', author: 'user:test',
} as const;

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

function createProject(service: ProjectService) {
  return service.execute(command('project.create', { name: '测试项目', max_budget_cents: 1000, rights_confirmed: true }));
}

/*
  成片的播放策略（片段与镜头不等长时）。

  它存的是**项目事实**而不是界面状态：换台机器打开、或者从 CLI/Agent 走，
  成片得按同一个策略渲染。所以这里盯三件事——默认值、写进去能读回、事件留痕。
*/
describe('成片播放策略', () => {
  it('没设过时对外给 hold（消费方不必自己判 NULL 该当什么）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createProject(service);
    const project = service.getProject(created.project_id!) as { film_playback: string };
    expect(project.film_playback).toBe('hold');
  });

  it('设成 stretch 之后读回是 stretch，revision 前进，事件里留着上一个值', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createProject(service);
    const projectId = created.project_id!;

    const result = service.execute(command('film.settings.set', { playback: 'stretch' }, {
      project_id: projectId, expected_revision: 1,
    }));
    expect((result.payload as { playback: string }).playback).toBe('stretch');
    expect((service.getProject(projectId) as { film_playback: string }).film_playback).toBe('stretch');

    const changed = service.listEvents(projectId).find((event) => event.type === 'film.settings.changed');
    expect(changed).toBeTruthy();
    /* 事件里两项各自留旧值：`previous_playback` / `previous_transition` */
    expect((changed?.payload as { previous_playback?: string })?.previous_playback).toBe('hold');
  });

  it('设成与现在一样的值也接受（来回切换是正常操作，不该报"没有改动"）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createProject(service);
    const projectId = created.project_id!;
    service.execute(command('film.settings.set', { playback: 'hold' }, { project_id: projectId, expected_revision: 1 }));
    const again = service.execute(command('film.settings.set', { playback: 'hold' }, { project_id: projectId, expected_revision: 2 }));
    expect(again.project_revision).toBe(3);
  });

  /*
    两个设置是**独立的下拉**，各改各的。

    不这么做的话，改转场会顺手把播放策略打回默认值——
    而用户并没有碰过那一项。这类"改 A 顺手重置 B"是部分更新的经典坑。
  */
  it('只改转场不会带着把播放策略重置', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createProject(service);
    const projectId = created.project_id!;
    service.execute(command('film.settings.set', { playback: 'stretch' }, { project_id: projectId, expected_revision: 1 }));
    const changed = service.execute(command('film.settings.set', { transition: 'crossfade' }, { project_id: projectId, expected_revision: 2 }));

    const project = service.getProject(projectId) as { film_playback: string; film_transition: string };
    expect(project.film_playback).toBe('stretch');
    expect(project.film_transition).toBe('crossfade');
    /* 响应里把三项都如实给回来，调用方不必再读一次项目 */
    expect(changed.payload).toEqual({ playback: 'stretch', transition: 'crossfade', direction: 'left' });
  });

  it('没设过转场时对外给 cut', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createProject(service);
    expect((service.getProject(created.project_id!) as { film_transition: string }).film_transition).toBe('cut');
  });

  /*
    逐镜覆盖：项目级之外再按镜微调。

    它存在的理由很具体：对话那几镜想停格（保住口型）、空镜想慢放填满（保住节奏），
    只给项目级的话用户只能二选一，然后把不合意的那几镜手工重做一遍。
  */
  it('逐镜覆盖：设了才出现，"撤掉"是把那一行删掉', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createProject(service);
    const projectId = created.project_id!;
    service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
    service.execute(command('shot-fields.replace', { breakdown_revision: 1, shots: [shot, { ...shot, shot_id: 'shot-02' }] }, {
      project_id: projectId, expected_revision: 2,
    }));
    const read = () => (service.getProject(projectId) as { shot_playbacks: Array<{ shot_id: string; playback: string }> }).shot_playbacks;

    /* 一个都没设过：列表是空的，而不是两行 'inherit' */
    expect(read()).toEqual([]);

    service.execute(command('shot.playback.set', { shot_id: 'shot-01', playback: 'stretch' }, {
      project_id: projectId, expected_revision: 3,
    }));
    expect(read()).toEqual([{ shot_id: 'shot-01', playback: 'stretch' }]);

    /* 再设另一镜：两镜各自独立 */
    service.execute(command('shot.playback.set', { shot_id: 'shot-02', playback: 'hold' }, {
      project_id: projectId, expected_revision: 4,
    }));
    expect(read()).toEqual([
      { shot_id: 'shot-01', playback: 'stretch' },
      { shot_id: 'shot-02', playback: 'hold' },
    ]);

    /* 撤掉 shot-01 的覆盖：那一行消失，"跟随项目设置"就是没有这一行 */
    const reverted = service.execute(command('shot.playback.set', { shot_id: 'shot-01', playback: 'inherit' }, {
      project_id: projectId, expected_revision: 5,
    }));
    expect(read()).toEqual([{ shot_id: 'shot-02', playback: 'hold' }]);
    /* 事件里留旧值，便于回答"这一镜以前设成什么" */
    const event = service.listEvents(projectId).filter((item) => item.type === 'shot.playback.changed').pop();
    expect((event?.payload as { previous?: string | null })?.previous).toBe('stretch');
    expect(reverted.project_revision).toBe(6);
  });

  it('给不存在的镜头设覆盖会被拒（否则留下一条永远不生效的记录）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createProject(service);
    const projectId = created.project_id!;
    service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
    service.execute(command('shot-fields.replace', { breakdown_revision: 1, shots: [shot] }, {
      project_id: projectId, expected_revision: 2,
    }));
    let caught: unknown;
    try {
      service.execute(command('shot.playback.set', { shot_id: 'shot-99', playback: 'stretch' }, {
        project_id: projectId, expected_revision: 3,
      }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('SHOT_NOT_FOUND');
  });

  it('方向：默认 left、只改方向不会带着把别的设置重置', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = createProject(service);
    const projectId = created.project_id!;
    const read = () => service.getProject(projectId) as {
      film_playback: string; film_transition: string; film_transition_direction: string;
    };
    expect(read().film_transition_direction).toBe('left');

    service.execute(command('film.settings.set', { playback: 'stretch', transition: 'push' }, {
      project_id: projectId, expected_revision: 1,
    }));
    service.execute(command('film.settings.set', { direction: 'up' }, {
      project_id: projectId, expected_revision: 2,
    }));
    const project = read();
    expect(project.film_transition_direction).toBe('up');
    /* 改了方向，前面那两项一个都不能被带着动 */
    expect(project.film_playback).toBe('stretch');
    expect(project.film_transition).toBe('push');
  });
});

function setupThroughG1(service: ProjectService) {
  const created = createProject(service);
  const projectId = created.project_id!;
  service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  service.execute(command('shot-fields.replace', { breakdown_revision: 1, shots: [shot] }, { project_id: projectId, expected_revision: 2 }));
  service.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  return projectId;
}

describe('ProjectService', () => {
  it('对相同 command_id 幂等重放，且拒绝换内容复用', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const commandId = randomUUID();
    const input = { command_id: commandId, actor: 'user:test', type: 'project.create', payload: { name: 'A', max_budget_cents: 100, rights_confirmed: true } };
    const first = service.execute(input);
    const replay = service.execute(input);
    expect(replay.project_id).toBe(first.project_id);
    expect(replay.replayed).toBe(true);
    expect(() => service.execute({ ...input, payload: { ...input.payload, name: 'B' } })).toThrow(/command_id/);
    expect(service.listProjects()).toHaveLength(1);
  });

  it('执行 G0/G1、字段表单向确定性派生和 revision/CAS', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = setupThroughG1(service);
    const first = service.execute(command('prompt.derive', { kit_version: 'kit@1', model_id: 'image.mock' }, { project_id: projectId, expected_revision: 4 }));
    const second = service.execute(command('prompt.derive', { kit_version: 'kit@1', model_id: 'image.mock' }, { project_id: projectId, expected_revision: 5 }));
    expect((second.payload as any).content_hash).toBe((first.payload as any).content_hash);
    expect((second.payload as any).reused).toBe(true);
    expect(() => service.execute(command('shot-fields.replace', { breakdown_revision: 2, shots: [shot] }, { project_id: projectId, expected_revision: 4 }))).toThrow(/revision/);
    expect(service.listEvents(projectId).map((event) => event.type)).toEqual([
      'project.created', 'gate.approved', 'shot-fields.replaced', 'gate.approved', 'prompt.derived', 'prompt.derived',
    ]);
  });

  it('在 G2 前物理阻断视频请求，并执行选帧 CAS 与预算保留', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = setupThroughG1(service);
    expect(() => service.execute(command('video.request', { shot_id: 'shot-01', estimated_cost_cents: 100 }, { project_id: projectId, expected_revision: 4 }))).toThrow(/G2/);
    service.execute(command('image-candidate.add', { shot_id: 'shot-01', candidate_id: 'candidate-01', artifact_id: `sha256:${'a'.repeat(64)}` }, { project_id: projectId, expected_revision: 4 }));
    service.execute(command('image-candidate.select', { shot_id: 'shot-01', candidate_id: 'candidate-01', expected_selection_revision: 0 }, { project_id: projectId, expected_revision: 5 }));
    expect(() => service.execute(command('image-candidate.select', { shot_id: 'shot-01', candidate_id: 'candidate-01', expected_selection_revision: 0 }, { project_id: projectId, expected_revision: 6 }))).toThrow(/选帧 revision/);
    service.execute(command('gate.approve', { gate: 'G2', approved_budget_cents: 300 }, { project_id: projectId, expected_revision: 6 }));
    const admitted = service.execute(command('video.request', { shot_id: 'shot-01', estimated_cost_cents: 200 }, { project_id: projectId, expected_revision: 7 }));
    expect((admitted.payload as any).provider_started).toBe(false);
    expect(() => service.execute(command('video.request', { shot_id: 'shot-01', estimated_cost_cents: 200 }, { project_id: projectId, expected_revision: 8 }))).toThrow(/批准预算/);
  });

  it('ProviderManifest 缺任一四项声明即注册失败', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const base = {
      schema: 'replica.provider-manifest@1', provider_id: 'fake-image', adapter_version: '1.0.0', adapter_hash: `sha256:${'b'.repeat(64)}`,
      declarations: {
        auth: { methods: ['bearer'], credential_fields: [{ key: 'api_key', label: 'API Key', secret: true }], refresh: 'none', test_endpoint: { method: 'GET', path: '/v1/models' } },
        endpoints: { base_url_required: true, protocol_version: 'v1', operations: [{ name: 'submit', method: 'POST', path: '/v1/images', required_params: ['prompt'] }] },
        capabilities: { modalities: ['image'], params: {}, features: { negative_prompt: true } },
        rate_limits: { quota_source: 'account', rps: 2, concurrency: 1, backoff: 'exponential_jitter' },
      },
      pricing_source: { kind: 'manual', checked_at: new Date().toISOString() },
      data_handling: { region: 'user_declared', retention: 'user_declared', deletion: 'vendor_policy' },
      testOnly: true,
    };
    for (const key of ['auth', 'endpoints', 'capabilities', 'rate_limits']) {
      const manifest = structuredClone(base) as any;
      delete manifest.declarations[key];
      expect(() => service.execute(command('provider.register', { manifest }))).toThrow();
    }
    const registered = service.execute(command('provider.register', { manifest: base }));
    expect((registered.payload as any).registered).toBe(true);
    expect((service.listProviders()[0] as any).test_only).toBe(true);
  });

  it('Local API 与直接调用返回同一 Result Envelope 语义', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const app = buildServer(service);
    const input = command('project.create', { name: 'API 项目', max_budget_cents: 50, rights_confirmed: true });
    const response = await app.inject({ method: 'POST', url: '/api/v1/commands', payload: input });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.schema).toBe('replica.command-result@1');
    const replay = service.execute(input);
    expect(replay.project_id).toBe(result.project_id);
    expect(replay.replayed).toBe(true);
    await app.close();
  });
});
