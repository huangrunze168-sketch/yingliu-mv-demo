import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, GATE_NAMES, commandSchema } from '@qiyin/contracts';
import { openDatabase, ProjectService } from '@qiyin/domain';

/**
 * 契约层与领域层的一致性。
 *
 * 这里守的是两件容易悄悄漂移的事：
 *   1. `COMMAND_TYPES` 清单必须与 `commandSchema` 真正支持的 type 一一对应——
 *      清单多一条，界面会把「没通电的按钮」当成能用；少一条，已实现的命令会被
 *      误报成 501。
 *   2. 系统回写字段（`probe`）与未接入闸门（G3–G5）必须表现成明确的领域错误，
 *      而不是静默接受。
 */

/** 从 discriminatedUnion 里取出所有 type 字面量；取不到时返回空数组，由断言失败暴露。 */
function declaredCommandTypes(): string[] {
  const options = (commandSchema as unknown as { options?: unknown[] }).options ?? [];
  return options.flatMap((option) => {
    const shape = (option as { shape?: Record<string, unknown> }).shape;
    const literal = shape?.['type'] as { value?: unknown } | undefined;
    return typeof literal?.value === 'string' ? [literal.value] : [];
  });
}

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

describe('契约一致性', () => {
  it('COMMAND_TYPES 与 commandSchema 的 type 集合完全一致', () => {
    const declared = declaredCommandTypes();
    // 若反射失效，这里会先失败——比默默跳过断言更诚实
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...COMMAND_TYPES].sort());
  });

  it('闸门契约包含 G0–G5 全序', () => {
    expect([...GATE_NAMES]).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5']);
  });

  it('未实现的命令返回 501 COMMAND_NOT_IMPLEMENTED，而不是「输入不符合契约」', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    let caught: unknown;
    try {
      service.execute(command('node.generate', { node_id: 't-1' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('COMMAND_NOT_IMPLEMENTED');
    expect((caught as { statusCode?: number }).statusCode).toBe(501);
    expect((caught as Error).message).toContain('node.generate');
  });

  it('未接入的闸门回报尚未接入；已接入的按自身前置条件拒绝', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = service.execute(command('project.create', { name: '闸门项目', max_budget_cents: 1000, rights_confirmed: true }));
    const projectId = created.project_id!;
    service.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));

    for (const gate of ['G3', 'G5']) {
      let caught: unknown;
      try {
        service.execute(command('gate.approve', { gate }, { project_id: projectId, expected_revision: 2 }));
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe('GATE_NOT_IMPLEMENTED');
      expect((caught as { statusCode?: number }).statusCode).toBe(501);
    }

    /**
     * G4（修复前批准）已经接入。它不会报「尚未接入」，
     * 而是按自己的前置条件拒绝——必须先有一份修复方案，
     * 否则「批准修复」这四个字没有指向任何具体动作。
     */
    let caught: unknown;
    try {
      service.execute(command('gate.approve', { gate: 'G4' }, { project_id: projectId, expected_revision: 2 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('REPAIR_PLAN_REQUIRED');
  });

  it('适配器自报的 probe 会被系统重置为 unknown，不得伪造 clean', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const manifest = {
      schema: 'replica.provider-manifest@1',
      provider_id: 'sneaky-provider',
      adapter_version: '1.0.0',
      adapter_hash: `sha256:${'c'.repeat(64)}`,
      declarations: {
        auth: { methods: ['bearer'], credential_fields: [{ key: 'api_key', label: 'API Key', secret: true }], refresh: 'none', test_endpoint: { method: 'GET', path: '/v1/models' } },
        endpoints: { base_url_required: true, protocol_version: 'v1', operations: [{ name: 'submit', method: 'POST', path: '/v1/images', required_params: ['prompt'] }] },
        capabilities: { modalities: ['image'], params: {}, features: {} },
        rate_limits: { quota_source: 'account', rps: 1, concurrency: 1, backoff: 'fixed' },
      },
      pricing_source: { kind: 'manual', checked_at: new Date().toISOString() },
      data_handling: { region: 'user_declared', retention: 'user_declared', deletion: 'vendor_policy' },
      // 适配器谎称自己「没有漂移」
      probe: { last_probed_at: new Date().toISOString(), drift_status: 'clean', drift_details: [] },
    };
    service.execute(command('provider.register', { manifest }));
    const stored = service.listProviders()[0] as { manifest: { probe: { drift_status: string; last_probed_at: string | null } } };
    expect(stored.manifest.probe.drift_status).toBe('unknown');
    expect(stored.manifest.probe.last_probed_at).toBeNull();
  });
});
