import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { GenerationService } from '@qiyin/generation-service';
import type {
  BackendImageRequest,
  BackendMedia,
  GenerationBackend,
} from '@qiyin/generation-backend';

/* ============================================================
   账本：一笔生成到底花了多少、是谁说的。

   这里盯的是一句**以前说错的话**：
   写进 `actual_cost_cents` —— 于是账本里那条"实际花费"是谁也没报过的数字，
   单位也不对（3 积分 ≠ 3 分钱）。

   现在的口径：
     · 供应商原样报了什么 → `provider_cost_unit` / `provider_cost_amount`；
     · `actual_cost_cents` 只在真拿到人民币金额时才写；
     · 实际花费未知 → 预留**不释放**（能证明省了钱才退，证不了就继续占着）。
   ============================================================ */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

/** 一个只会报"积分"的后端，别的能力都不支持。 */
function creditBackend(credits: number): GenerationBackend {
  return {
    id: 'fake-credit',
    label: '假积分后端',
    capabilities: {
      image: true, videoFromImage: false, videoEdit: false,
      imageShortcut: false, imageUpscale: false,
      audioSpeech: false, audioMusic: false,
    },
    async generateAudio(): Promise<BackendMedia> { throw new Error('用不到'); },
    async generateImage(request: BackendImageRequest): Promise<BackendMedia> {
      const file = join(request.outputDir, 'out.png');
      writeFileSync(file, Buffer.from(`PNG:${request.prompt}`), 'utf8');
      return {
        files: [file], source_url: null, task_ref: 'fake-1',
        cost: { unit: 'credit', amount: credits }, notes: [],
      };
    },
    async generateVideoFromImage(): Promise<BackendMedia> {
      throw new Error('不支持');
    },
    async editVideo(): Promise<BackendMedia> {
      throw new Error('不支持');
    },
    async applyImageShortcut(): Promise<BackendMedia> {
      throw new Error('不支持');
    },
    async upscaleImage(): Promise<BackendMedia> {
      throw new Error('不支持');
    },
  };
}

/**/
function silentBackend(): GenerationBackend {
  const base = creditBackend(0);
  return {
    ...base,
    id: 'fake-silent',
    label: '假静默后端',
    async generateImage(request: BackendImageRequest): Promise<BackendMedia> {
      const file = join(request.outputDir, 'out.png');
      writeFileSync(file, Buffer.from(`PNG:${request.prompt}`), 'utf8');
      return { files: [file], source_url: null, task_ref: 'fake-2', cost: null, notes: [] };
    },
  };
}

/** 一个**已经受理之后才失败**的后端：这类失败不能断言"没花钱"。 */
function failingBackend(): GenerationBackend {
  const base = creditBackend(0);
  return {
    ...base,
    id: 'fake-failing',
    label: '假失败后端',
    async generateImage(): Promise<BackendMedia> {
      throw new Error('供应商返回 500：任务已受理但没出图');
    },
  };
}

function setup(backend: GenerationBackend) {
  const projects = new ProjectService(openDatabase(':memory:'));
  const created = projects.execute(command('project.create', {
    name: '账本项目', max_budget_cents: 1000, rights_confirmed: true,
  }));
  const projectId = created.project_id!;
  projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  projects.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }],
  }, { project_id: projectId, expected_revision: 2 }));
  projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  const service = new GenerationService(projects, backend);
  const workspace = mkdtempSync(join(tmpdir(), 'qiyin-ledger-'));
  const revision = () => (projects.getProject(projectId) as { revision: number }).revision;
  return { projects, projectId, service, workspace, revision };
}

type IntentRow = {
  status: string;
  estimated_cost_cents: number;
  actual_cost_cents: number | null;
  provider_cost_unit: string | null;
  provider_cost_amount: number | null;
  reservation_released_reason: string | null;
};

describe('生成账本', () => {
  it('供应商报积分：原样记积分，且**不**写"实际花费"', async () => {
    const { projects, projectId, service, workspace, revision } = setup(creditBackend(8));
    await service.generateShotImages({
      projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', prompt: '一张图' }],
      model: 'Z-image Turbo', quality: '1K', ratio: '1:1',
      estimatedCostCents: 10,
    });

    const intents = projects.listImageGenerationIntents(projectId) as IntentRow[];
    const intent = intents[0]!;
    expect(intent.status).toBe('COMPLETED');
    expect(intent.provider_cost_unit).toBe('credit');
    expect(intent.provider_cost_amount).toBe(8);
    /* 关键：没拿到人民币金额，就不能写"实际花费" */
    expect(intent.actual_cost_cents).toBeNull();
  });

  it('供应商什么都不报：两个字段都留空，也不拿预估顶替', async () => {
    const { projects, projectId, service, workspace, revision } = setup(silentBackend());
    await service.generateShotImages({
      projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', prompt: '一张图' }],
      model: 'Z-image Turbo', quality: '1K', ratio: '1:1',
      estimatedCostCents: 10,
    });

    const intents = projects.listImageGenerationIntents(projectId) as IntentRow[];
    const intent = intents[0]!;
    expect(intent.provider_cost_unit).toBeNull();
    expect(intent.provider_cost_amount).toBeNull();
    /* 以前这里是 10（把预估写成实际），现在必须是"不知道" */
    expect(intent.actual_cost_cents).toBeNull();
  });

  it('实际花费未知时预留不释放：能证明省了钱才退，证不了就继续占着', async () => {
    const { projects, projectId, service, workspace, revision } = setup(silentBackend());
    await service.generateShotImages({
      projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', prompt: '一张图' }],
      model: 'Z-image Turbo', quality: '1K', ratio: '1:1',
      estimatedCostCents: 10,
    });

    const project = projects.getProject(projectId) as { reserved_budget_cents: number };
    expect(project.reserved_budget_cents).toBe(10);
  });

  it('调用方明确给了金额（按定价源算的）：照写，并保留供应商原样报数', async () => {
    const { projects, projectId, service, workspace, revision } = setup(creditBackend(8));
    await service.generateShotImages({
      projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', prompt: '一张图' }],
      model: 'Z-image Turbo', quality: '1K', ratio: '1:1',
      estimatedCostCents: 10,
      actualCostCents: 6,
    });

    const intents = projects.listImageGenerationIntents(projectId) as IntentRow[];
    const intent = intents[0]!;
    expect(intent.actual_cost_cents).toBe(6);
    /* 两个来源并存：一个是调用方算的价，一个是供应商报的积分，谁也没被顶掉 */
    expect(intent.provider_cost_unit).toBe('credit');
    expect(intent.provider_cost_amount).toBe(8);
    const project = projects.getProject(projectId) as { reserved_budget_cents: number };
    expect(project.reserved_budget_cents).toBe(6);
  });
});

/* ============================================================
   失败之后那笔预留怎么办。

   以前失败结清写的是 `actual_cost_cents: 0`，好把预留退回预算。
   那是个**假设**：请求已经发出去、供应商也回了 500，它完全可能已经计费。
   把假设写成事实，账本上就多了一笔"确定花了 0 元"。
   ============================================================ */
/**
 * 建到「G1 已批准、一个镜头」为止，再登记一次图片生成意图。
 *
 * 三条失败账目的用例都要走到这一步，重复四遍会把真正的断言埋掉。
 * 返回的 `nextRevision` 是结清那一步该用的 expected_revision。
 */
function admitImageIntent(estimatedCostCents = 25) {
  const projects = new ProjectService(openDatabase(':memory:'));
  const created = projects.execute(command('project.create', {
    name: '失败结清项目', max_budget_cents: 1000, rights_confirmed: true,
  }));
  const projectId = created.project_id!;
  projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
  projects.execute(command('shot-fields.seed', {
    breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }],
  }, { project_id: projectId, expected_revision: 2 }));
  projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
  const admitted = projects.execute(command('image-generation.request', {
    shot_id: 'shot-01', model: 'M', prompt: 'p', estimated_cost_cents: estimatedCostCents,
    digest: `sha256:${'a'.repeat(64)}`,
  }, { project_id: projectId, expected_revision: 4 }));
  return {
    projects,
    projectId,
    intentId: (admitted.payload as { intent_id: string }).intent_id,
    nextRevision: 5,
  };
}

describe('失败之后的预留', () => {
  it('提交给后端之后才失败：预留不动，也不写"花了 0 元"', async () => {
    const { projects, projectId, service, workspace, revision } = setup(failingBackend());
    const outcome = await service.generateShotImages({
      projectId, expectedRevision: revision(), canvasCwd: workspace, workspaceDir: workspace,
      shots: [{ shot_id: 'shot-01', prompt: '一张图' }],
      model: 'Z-image Turbo', quality: '1K', ratio: '1:1',
      estimatedCostCents: 10,
    });
    expect(outcome.failures).toHaveLength(1);

    const intent = (projects.listImageGenerationIntents(projectId) as IntentRow[])[0]!;
    expect(intent.status).toBe('FAILED');
    /* 关键三条：没有实际花费、没有释放理由、预留还在 */
    expect(intent.actual_cost_cents).toBeNull();
    expect(intent.reservation_released_reason).toBeNull();
    const project = projects.getProject(projectId) as { reserved_budget_cents: number };
    expect(project.reserved_budget_cents).toBe(10);
  });

  it('领域层：不给凭据的失败结清不会动预留', () => {
    const { projects, projectId, intentId, nextRevision } = admitImageIntent();
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(25);

    const settled = projects.execute(command('image-generation.settle', {
      intent_id: intentId, status: 'FAILED', failure: '供应商超时',
    }, { project_id: projectId, expected_revision: nextRevision }));

    expect((settled.payload as { released_cents: number }).released_cents).toBe(0);
    expect((settled.payload as { reservation_released_reason: string | null }).reservation_released_reason).toBeNull();
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(25);
  });

  it('领域层：给出理由才释放，释放理由要落到账上', () => {
    const { projects, projectId, intentId, nextRevision } = admitImageIntent();

    const settled = projects.execute(command('image-generation.settle', {
      intent_id: intentId, status: 'FAILED', failure: '连后端都没连上',
      release_reservation: { reason: '还没提交给生成后端：这次调用不可能产生费用' },
    }, { project_id: projectId, expected_revision: nextRevision }));

    const payload = settled.payload as { released_cents: number; reservation_released_reason: string };
    expect(payload.released_cents).toBe(25);
    expect(payload.reservation_released_reason).toContain('还没提交给生成后端');
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(0);
    /* 释放了预留也不等于"花了 0 元"：实际花费仍是"不知道" */
    expect((projects.listImageGenerationIntents(projectId) as IntentRow[])[0]?.actual_cost_cents).toBeNull();
  });

  it('拿到真实金额时按实际花费退差额（与释放是两回事）', () => {
    const { projects, projectId, intentId, nextRevision } = admitImageIntent();

    const settled = projects.execute(command('image-generation.settle', {
      intent_id: intentId, status: 'FAILED', failure: '供应商报错', actual_cost_cents: 4,
    }, { project_id: projectId, expected_revision: nextRevision }));

    expect((settled.payload as { released_cents: number }).released_cents).toBe(21);
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(4);
  });
});

/**
 * 事后释放：失败的当时不知道花没花，后来查清了。
 *
 * 没有这条路径的话，那笔预留就**再也放不出去**——`settle` 只能结清一次，
 * 第二次会被拒，于是用户的可用预算被永久扣着，界面上还没有任何入口能解开。
 */
describe('事后释放预留', () => {
  /** 结清成"是否计费未知"的失败（预留留着）。 */
  function failWithoutReleasing() {
    const ctx = admitImageIntent();
    ctx.projects.execute(command('image-generation.settle', {
      intent_id: ctx.intentId, status: 'FAILED', failure: '供应商 500',
    }, { project_id: ctx.projectId, expected_revision: ctx.nextRevision }));
    return { ...ctx, afterSettle: ctx.nextRevision + 1 };
  }

  it('查清之后释放：额度回到可用，理由落到账上', () => {
    const { projects, projectId, intentId, afterSettle } = failWithoutReleasing();
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(25);

    const released = projects.execute(command('image-generation.release-reservation', {
      intent_id: intentId, reason: '对过供应商账单：这一笔没有扣费',
    }, { project_id: projectId, expected_revision: afterSettle }));

    const payload = released.payload as { released_cents: number; reservation_released_reason: string };
    expect(payload.released_cents).toBe(25);
    expect(payload.reservation_released_reason).toBe('对过供应商账单：这一笔没有扣费');
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(0);

    const intent = (projects.listImageGenerationIntents(projectId) as IntentRow[])[0]!;
    expect(intent.reservation_released_reason).toBe('对过供应商账单：这一笔没有扣费');
    /* 释放预留**不改**实际花费：它仍然是"不知道" */
    expect(intent.actual_cost_cents).toBeNull();
  });

  it('还没结清就释放：拒绝（该由结清那一步决定）', () => {
    const { projects, projectId, intentId, nextRevision } = admitImageIntent();
    let caught: unknown;
    try {
      projects.execute(command('image-generation.release-reservation', {
        intent_id: intentId, reason: '看着像没花',
      }, { project_id: projectId, expected_revision: nextRevision }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('RESERVATION_ONLY_AFTER_FAILURE');
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(25);
  });

  it('重复释放：拒绝（不能把同一笔钱退两次）', () => {
    const { projects, projectId, intentId, afterSettle } = failWithoutReleasing();
    projects.execute(command('image-generation.release-reservation', {
      intent_id: intentId, reason: '第一次释放',
    }, { project_id: projectId, expected_revision: afterSettle }));

    let caught: unknown;
    try {
      projects.execute(command('image-generation.release-reservation', {
        intent_id: intentId, reason: '再来一次',
      }, { project_id: projectId, expected_revision: afterSettle + 1 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('RESERVATION_ALREADY_RELEASED');
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(0);
  });

  it('已经按实际花费结清：拒绝，没有预留可释放', () => {
    const { projects, projectId, intentId, nextRevision } = admitImageIntent();
    projects.execute(command('image-generation.settle', {
      intent_id: intentId, status: 'FAILED', failure: '供应商报错', actual_cost_cents: 4,
    }, { project_id: projectId, expected_revision: nextRevision }));

    let caught: unknown;
    try {
      projects.execute(command('image-generation.release-reservation', {
        intent_id: intentId, reason: '想再退一点',
      }, { project_id: projectId, expected_revision: nextRevision + 1 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('RESERVATION_ALREADY_SETTLED');
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(4);
  });
});

/* ============================================================
   结果复用（FLOW-006）：领域层这一侧。
   ------------------------------------------------------------
   服务层负责"算摘要、找可复用的那一笔"，但**"这到底算不算同一次请求"必须在这里再判一次**。
   只信调用方的话，任何一个摘要计算的 bug 都会让一张不相干的图被登记成"命中"，
   而且账上还写着省了钱——那种错比直接花钱难查得多。
   ============================================================ */
function completedGeneration(projects: ProjectService, projectId: string, revision: number, digest: string) {
  const admitted = projects.execute(command('image-generation.request', {
    shot_id: 'shot-01', model: 'M', prompt: 'p', estimated_cost_cents: 25, digest,
  }, { project_id: projectId, expected_revision: revision }));
  const intentId = (admitted.payload as { intent_id: string }).intent_id;

  const artifactId = `sha256:${'f'.repeat(64)}`;
  projects.execute(command('artifact.publish', {
    artifact_id: artifactId, media_type: 'image/png', bytes: 10,
  }));
  const candidateId = `cand-source-${intentId.slice(0, 8)}`;
  projects.execute(command('image-candidate.add', {
    shot_id: 'shot-01', candidate_id: candidateId, artifact_id: artifactId,
  }, { project_id: projectId, expected_revision: revision + 1 }));
  projects.execute(command('image-generation.settle', {
    intent_id: intentId, status: 'COMPLETED', candidate_id: candidateId, actual_cost_cents: 5,
  }, { project_id: projectId, expected_revision: revision + 2 }));
  return { intentId, candidateId, artifactId, nextRevision: revision + 3 };
}

describe('复用已有结果', () => {
  it('摘要逐字相同：登记新候选，不预留预算，账上写 0', () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute(command('project.create', {
      name: '复用项目', max_budget_cents: 1000, rights_confirmed: true,
    }));
    const projectId = created.project_id!;
    projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
    projects.execute(command('shot-fields.seed', {
      breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }],
    }, { project_id: projectId, expected_revision: 2 }));
    projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));

    const digest = `sha256:${'b'.repeat(64)}`;
    const source = completedGeneration(projects, projectId, 4, digest);
    const reservedBefore = (projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents;

    const reused = projects.execute(command('image-generation.reuse', {
      shot_id: 'shot-01', candidate_id: 'cand-reuse-1', source_intent_id: source.intentId, digest,
    }, { project_id: projectId, expected_revision: source.nextRevision }));

    const payload = reused.payload as { artifact_id: string; actual_cost_cents: number };
    expect(payload.artifact_id).toBe(source.artifactId);
    expect(payload.actual_cost_cents).toBe(0);
    /* 复用不预留预算：预留数与复用前一样 */
    expect((projects.getProject(projectId) as { reserved_budget_cents: number }).reserved_budget_cents).toBe(reservedBefore);
    const candidates = projects.listImageCandidates(projectId) as Array<{ candidate_id: string }>;
    expect(candidates.map((item) => item.candidate_id)).toContain('cand-reuse-1');
  });

  it('摘要对不上：拒绝，不能拿别的输入的结果冒充命中', () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute(command('project.create', {
      name: '复用项目', max_budget_cents: 1000, rights_confirmed: true,
    }));
    const projectId = created.project_id!;
    projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
    projects.execute(command('shot-fields.seed', {
      breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }],
    }, { project_id: projectId, expected_revision: 2 }));
    projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
    const source = completedGeneration(projects, projectId, 4, `sha256:${'b'.repeat(64)}`);

    let caught: unknown;
    try {
      projects.execute(command('image-generation.reuse', {
        shot_id: 'shot-01', candidate_id: 'cand-reuse-2',
        source_intent_id: source.intentId, digest: `sha256:${'c'.repeat(64)}`,
      }, { project_id: projectId, expected_revision: source.nextRevision }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('REUSE_DIGEST_MISMATCH');
  });

  it('来源那次还没成功：拒绝（失败的那条没有产物可复用）', () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute(command('project.create', {
      name: '复用项目', max_budget_cents: 1000, rights_confirmed: true,
    }));
    const projectId = created.project_id!;
    projects.execute(command('gate.approve', { gate: 'G0' }, { project_id: projectId, expected_revision: 1 }));
    projects.execute(command('shot-fields.seed', {
      breakdown_revision: 1, boundaries: [{ t0_ms: 0, t1_ms: 2100 }],
    }, { project_id: projectId, expected_revision: 2 }));
    projects.execute(command('gate.approve', { gate: 'G1' }, { project_id: projectId, expected_revision: 3 }));
    const digest = `sha256:${'b'.repeat(64)}`;
    const admitted = projects.execute(command('image-generation.request', {
      shot_id: 'shot-01', model: 'M', prompt: 'p', estimated_cost_cents: 25, digest,
    }, { project_id: projectId, expected_revision: 4 }));
    const intentId = (admitted.payload as { intent_id: string }).intent_id;

    let caught: unknown;
    try {
      projects.execute(command('image-generation.reuse', {
        shot_id: 'shot-01', candidate_id: 'cand-reuse-3', source_intent_id: intentId, digest,
      }, { project_id: projectId, expected_revision: 5 }));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('REUSE_SOURCE_NOT_COMPLETED');
  });
});
