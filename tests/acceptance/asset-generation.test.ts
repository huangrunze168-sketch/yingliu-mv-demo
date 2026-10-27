/* ============================================================
  ASSET-004（主体智能补全）与它依赖的**项目级生成意图**的量化验收。

  智能补全要花真钱（出图），所以它必须走账本：先预留预算、结清按实际退回。
  这一组量三件事：

    ① 视角计划：上限 4 张、必须已有基图、到上限就明确拒绝（不是生成一堆塞不进去的图）；
    ② 预算闸门：超预算的申请被拒且不动账；失败结清后预留按语义处理（未知就是未知）；
    ③ 端到端：用插件后端真出一张"视角图" → 登记产物 → 结清 COMPLETED → **补进主体档案**。
   ============================================================ */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SUBJECT_COMPLETION_NOTICE, subjectAnglePlan, type SubjectKind,
} from '@qiyin/contracts';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { createGenerationBackend, registerPluginBackends } from '@qiyin/generation-backends';
import { recordAcceptance } from './_acceptance.js';

const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-asset-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  registerPluginBackends([]);
});

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:acceptance', type, payload, ...extras };
}

function profile(images: number, kind: SubjectKind = 'person') {
  return {
    display_name: '林医生',
    kind,
    description: '三十岁女性，白大褂',
    images: Array.from({ length: images }, (_unused, index) => ({ artifact_id: `sha256:${String(index).repeat(64)}`, frontal: index === 0 })),
  };
}

describe('[ASSET-004] 主体智能补全', () => {
  it('视角计划：上限 4 张、要先有基图、到上限明确拒绝', () => {
    const twoImages = subjectAnglePlan(profile(2), 3);
    const none = subjectAnglePlan(profile(0), 2);
    const full = subjectAnglePlan(profile(4), 2);
    const capped = subjectAnglePlan(profile(3), 3);

    recordAcceptance('ASSET-004.plan', {
      criterion: '补全受 4 张上限约束，且必须已有基图',
      viewsFromTwo: twoImages.views,
      remainingFromTwo: twoImages.remaining,
      prompts: twoImages.prompts,
      blockedWithoutBase: none.blocked,
      blockedAtCap: full.blocked,
      cappedToOne: capped.views,
      notice: SUBJECT_COMPLETION_NOTICE,
    });

    /* 已有 2 张、要 3 个视角 → 只剩 2 个位置 */
    expect(twoImages.views).toHaveLength(2);
    expect(twoImages.remaining).toBe(2);
    expect(twoImages.prompts[0]).toContain('林医生');
    expect(twoImages.prompts[0]).toContain('视角');
    /* 没有基图 / 已满 → 都有明确原因，且不给出视角 */
    expect(none.views).toEqual([]);
    expect(none.blocked).toContain('至少一张参考图');
    expect(full.views).toEqual([]);
    expect(full.blocked).toContain('补不下');
    expect(capped.views).toHaveLength(1);
  });

  it('预算闸门：超预算的申请被拒且预留不动；失败结清不会凭空退回', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = service.execute(command('project.create', {
      name: '补全预算', max_budget_cents: 100, rights_confirmed: true,
    })).project_id as string;
    const revision = () => (service.getProject(projectId) as { revision: number }).revision;
    const reserved = () => (service.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents;

    const first = service.execute(command('asset-generation.request', {
      kind: 'image', purpose: 'subject:character:lin:angles', model: 'm', prompt: '视角图',
      estimated_cost_cents: 60,
    }, { project_id: projectId, expected_revision: revision() }));
    const over = (() => {
      try {
        service.execute(command('asset-generation.request', {
          kind: 'image', purpose: 'subject:character:lin:angles', model: 'm', estimated_cost_cents: 60,
        }, { project_id: projectId, expected_revision: revision() }));
        return '(未被拒绝)';
      } catch (error) {
        return (error as { code?: string }).code ?? '(未知)';
      }
    })();
    const afterOver = reserved();

    /* 失败结清：不知道对方扣没扣钱 → 预留原地不动（这是既有口径） */
    service.execute(command('asset-generation.settle', {
      intent_id: (first.payload as { intent_id: string }).intent_id,
      status: 'FAILED', failure: '模型繁忙',
    }, { project_id: projectId, expected_revision: revision() }));
    const afterFailed = reserved();

    recordAcceptance('ASSET-004.budget', {
      criterion: '项目级生成同样受预算闸门约束，失败结清不伪造"退回"',
      reservedAfterFirst: 60,
      overBudgetCode: over,
      reservedAfterOverBudget: afterOver,
      reservedAfterFailedSettle: afterFailed,
      intents: (service.listAssetGenerationIntents(projectId) as unknown[]).length,
    });

    expect(afterOver).toBe(60);
    expect(over).toBe('PROJECT_BUDGET_EXCEEDED');
    /* 失败但花费未知：钱继续占着（证不了省了钱就不退） */
    expect(afterFailed).toBe(60);
  });

  it('成功结清按实际退回，成功却不给产物直接被拒（最贵的错误）', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = service.execute(command('project.create', {
      name: '结清语义', max_budget_cents: 1000, rights_confirmed: true,
    })).project_id as string;
    const revision = () => (service.getProject(projectId) as { revision: number }).revision;
    const reserved = () => (service.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents;

    const intent = service.execute(command('asset-generation.request', {
      kind: 'image', purpose: 'subject:character:lin:angles', model: 'm', estimated_cost_cents: 80,
    }, { project_id: projectId, expected_revision: revision() }));
    const intentId = (intent.payload as { intent_id: string }).intent_id;

    const noArtifact = (() => {
      try {
        service.execute(command('asset-generation.settle', {
          intent_id: intentId, status: 'COMPLETED', actual_cost_cents: 5,
        }, { project_id: projectId, expected_revision: revision() }));
        return '(未被拒绝)';
      } catch (error) {
        return (error as { code?: string }).code ?? '(未知)';
      }
    })();

    const artifactId = `sha256:${'a'.repeat(64)}`;
    const settled = service.execute(command('asset-generation.settle', {
      intent_id: intentId, status: 'COMPLETED', actual_cost_cents: 5, artifact_id: artifactId,
    }, { project_id: projectId, expected_revision: revision() }));

    recordAcceptance('ASSET-004.settle', {
      criterion: '成功必须带产物；实际花费已知时按差额退回',
      completedWithoutArtifact: noArtifact,
      releasedCents: (settled.payload as { released_cents: number }).released_cents,
      reservedAfterSettle: reserved(),
    });

    expect(noArtifact).toBe('ASSET_ARTIFACT_REQUIRED');
    expect((settled.payload as { released_cents: number }).released_cents).toBe(75);
    expect(reserved()).toBe(5);
  });

  it('端到端：插件后端真出一张视角图 → 产物登记 → 结清 → 补进主体档案', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    /* 用一个"真插件 Provider"当出图后端：这是最接近线上的一条路 */
    registerPluginBackends([{
      pluginId: 'com.acceptance.angles',
      providerId: 'angle-image',
      label: '验收插件 · 视角出图',
      capabilities: ['image.generate'],
      authMethods: ['none'],
      resolve: async () => ({
        provider_id: 'angle-image',
        label: '视角出图',
        capabilities: ['image.generate'],
        generate: async (request: unknown) => {
          const payload = request as { outputDir?: unknown; label?: unknown };
          const dir = String(payload.outputDir);
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${String(payload.label)}.png`);
          writeFileSync(file, `PNG:${String(payload.label)}`, 'utf8');
          return { files: [file], notes: [], cost: { unit: 'credit', amount: 2 } };
        },
      }),
    }]);
    const backend = createGenerationBackend('plugin:angle-image', { canvasCwd: workspace });

    const service = new ProjectService(openDatabase(':memory:'));
    const projectId = service.execute(command('project.create', {
      name: '补全链路', max_budget_cents: 500, rights_confirmed: true,
    })).project_id as string;
    const revision = () => (service.getProject(projectId) as { revision: number }).revision;

    const plan = subjectAnglePlan(profile(2), 2);
    /* 基图必须是**已发布的产物**：档案里的引用会被逐个回查（存在性 + 类型） */
    const base = profile(2);
    for (const image of base.images) {
      service.execute(command('artifact.publish', {
        artifact_id: image.artifact_id, media_type: 'image/png', bytes: 12,
        metadata: { artifact_path_relative: `subjects/base-${image.artifact_id.slice(-4)}.png`, project_id: projectId },
      }));
    }
    const added: string[] = [];
    for (const [index, view] of plan.views.entries()) {
      const requested = service.execute(command('asset-generation.request', {
        kind: 'image', purpose: 'subject:character:lin:angles', model: 'plugin-model',
        prompt: plan.prompts[index], estimated_cost_cents: 10,
      }, { project_id: projectId, expected_revision: revision() }));
      const media = await backend.generateImage({
        prompt: plan.prompts[index] ?? view, model: 'plugin-model',
        outputDir: join(workspace, 'subjects'), label: `lin-${index}`,
      });
      const file = media.files[0] as string;
      const bytes = (await import('node:fs')).readFileSync(file);
      const artifactId = `sha256:${(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')}`;
      service.execute(command('artifact.publish', {
        artifact_id: artifactId, media_type: 'image/png', bytes: bytes.length,
        metadata: { artifact_path_relative: `subjects/lin-${index}.png`, project_id: projectId, source: 'subject-completion' },
      }));
      service.execute(command('asset-generation.settle', {
        intent_id: (requested.payload as { intent_id: string }).intent_id,
        status: 'COMPLETED', artifact_id: artifactId, provider_cost: media.cost ?? undefined,
      }, { project_id: projectId, expected_revision: revision() }));
      added.push(artifactId);
    }

    service.execute(command('subject.profile.set', {
      subject_ref: 'character:lin', display_name: base.display_name, kind: base.kind,
      description: base.description, tags: [],
      images: [...base.images, ...added.map((artifactId) => ({ artifact_id: artifactId, frontal: false }))],
      video: null, voice: null,
      smart_completion: {
        status: 'DONE', requested_at: new Date().toISOString(), added_images: added.length,
      },
    }));

    const stored = (service.listSubjectProfiles() as Array<{ profile: { images: unknown[]; smart_completion: { added_images: number } | null } }>)[0];

    recordAcceptance('ASSET-004', {
      criterion: '智能补全：真出图 → 登记产物 → 结清 → 补进档案（含补全记录）',
      plannedViews: plan.views,
      addedImages: added.length,
      imagesInProfile: stored?.profile.images.length ?? 0,
      completionRecorded: stored?.profile.smart_completion?.added_images ?? 0,
      reservedAfterSettle: (service.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents,
    });

    expect(added).toHaveLength(2);
    expect(stored?.profile.images).toHaveLength(4);
    expect(stored?.profile.smart_completion?.added_images).toBe(2);
  }, 120_000);
});
