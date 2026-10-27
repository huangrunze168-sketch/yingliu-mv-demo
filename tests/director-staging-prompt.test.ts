import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { createCanvasBackend, CanvasAdapter, type CanvasRunRequest, type CanvasRunner } from '@qiyin/canvas-adapter';
import { GenerationService, stagingCameraFrom, stagingSubjectsFrom } from '@qiyin/generation-service';
import {
  buildDirectorStagingPrompt,
  DIRECTOR_STAGING_TEMPLATE_ZH,
} from '../packages/generation-service/src/directorStagingPrompt.js';

/* ============================================================
  导演台摆位 → 生成提示词。

  promptTemplates.ts 里 `directorStudio.layout` 的默认文案。

  这份测试盯两件事：
    ② 它**真的发到了后端**——拼好了却没人用，是这一层最容易出现、
       也最难从界面上看出来的失败。
   ============================================================ */

/** 导演台默认机位：站在原点后方 9 米、高 0.8 米，看向 (0, 0.6, 0) */
const CAMERA = { position: [0, 0.8, 9] as const, target: [0, 0.6, 0] as const };

function person(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    subject_ref: 'character:hero',
    proxy: 'mannequin' as const,
    position: [0, 0, 0] as const,
    ...overrides,
  };
}

describe('导演台摆位·这段描述怎么算', () => {
  it('没有站位时一个字都不加：导演台没摆东西，就没有"布局"可指导', () => {
    const prompt = buildDirectorStagingPrompt({
      basePrompt: '中景，平视，柔和光',
      subjects: [],
      camera: CAMERA,
      hasBlueprintScreenshot: true,
    });
    expect(prompt).toBe('中景，平视，柔和光');
  });

  it('位置按**相机**算，不是照抄世界坐标', () => {
    /*
      机位在 z=9、看向原点。角色摆在世界原点：离镜头 9 米、画面正中。
      站在镜头前 9 米的人被描述成"贴着镜头"，模型照着画必然错。
    */
    const prompt = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [person()],
      camera: CAMERA,
      hasBlueprintScreenshot: false,
    });
    expect(prompt).toContain('depth-from-camera 9.0m');
    expect(prompt).toContain('screen-center');
  });

  it('画面左边的人写 screen-left、右边写 screen-right，远的那个数字更大', () => {
    const prompt = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [
        /* 世界 x = -1.5：在镜头左前方 */
        person({ position: [-1.5, 0, 0] }),
        { subject_ref: 'character:two', proxy: 'mannequin', position: [1.5, 0, -3] },
      ],
      camera: CAMERA,
      hasBlueprintScreenshot: false,
    });
    expect(prompt).toContain('screen-left');
    expect(prompt).toContain('screen-right');
    /* 第一个人在 x=-1.5，离镜头约 9 米；第二个人在 z=-3，离镜头约 12 米 */
    expect(prompt).toContain('depth-from-camera 9.0m');
    expect(prompt).toContain('depth-from-camera 12.0m');
  });

  it('站在机位背后的人要说明白：否则模型会把"深度为负"当成在镜头前面', () => {
    const prompt = buildDirectorStagingPrompt({
      basePrompt: '中景',
      /* z=10 已经比机位的 z=9 更靠后 */
      subjects: [person({ position: [0, 0, 10] })],
      camera: CAMERA,
      hasBlueprintScreenshot: false,
    });
    expect(prompt).toContain('behind the camera');
  });

  it('没有机位就不写画面左右——说不出的事不编', () => {
    const prompt = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [person({ position: [-1.5, 0, 0] })],
      camera: null,
      hasBlueprintScreenshot: false,
    });
    expect(prompt).toContain('at world position');
    expect(prompt).not.toContain('screen-left');
    expect(prompt).not.toContain('screen-right');
    expect(prompt).toContain('no camera pose');
  });

  it('机位与目标点重合（退化）时也按"没有机位"处理，不吐 NaN', () => {
    const prompt = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [person()],
      camera: { position: [1, 1, 1], target: [1, 1, 1] },
      hasBlueprintScreenshot: false,
    });
    expect(prompt).not.toContain('NaN');
    expect(prompt).toContain('at world position');
  });

  it('角色与道具分开编号，道具不说体型', () => {
    const prompt = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [
        person({ body_preset: 'person-adult-male-strong' }),
        { subject_ref: 'prop:box', proxy: 'box', position: [1, 0, 1] },
      ],
      camera: CAMERA,
      hasBlueprintScreenshot: false,
    });
    expect(prompt).toContain('person "角色 1", body preset person-adult-male-strong');
    expect(prompt).toContain('object "道具 1"');
    /* 道具那一行里不该出现体型 */
    const objectLine = prompt.split('; ').find((line) => line.includes('道具 1'))!;
    expect(objectLine).not.toContain('body preset');
  });

  it('细粒度姿态优先于粗粒度：选过 pose_preset 就用它', () => {
    const withPreset = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [person({ pose: 'sitting', pose_preset: 'hands-on-hips' })],
      camera: CAMERA,
      hasBlueprintScreenshot: false,
    });
    expect(withPreset).toContain('pose preset hands-on-hips');
    expect(withPreset).not.toContain(', seated');

    const coarseOnly = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [person({ pose: 'sitting', pose_preset: null })],
      camera: CAMERA,
      hasBlueprintScreenshot: false,
    });
    expect(coarseOnly).toContain(', seated');
  });

  it('旋转与缩放只在不是默认值时才写（默认值写一遍等于噪声）', () => {
    const plain = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [person({ rotation_deg: [0, 0, 0], scale: 1 })],
      camera: CAMERA,
      hasBlueprintScreenshot: false,
    });
    expect(plain).not.toContain('transform:');

    const moved = buildDirectorStagingPrompt({
      basePrompt: '中景',
      subjects: [person({ rotation_deg: [0, 90, 0], scale: 1.5 })],
      camera: CAMERA,
      hasBlueprintScreenshot: false,
    });
    expect(moved).toContain('rotation xyz (0°, 90°, 0°)');
    expect(moved).toContain('scale 1.50x');
  });

  it('发蓝图截图时才说"第 1 张参考图是导演台截图"', () => {
    const withShot = buildDirectorStagingPrompt({
      basePrompt: '中景', subjects: [person()], camera: CAMERA, hasBlueprintScreenshot: true,
    });
    expect(withShot).toContain('第 1 张参考图是导演台截图');

    const withoutShot = buildDirectorStagingPrompt({
      basePrompt: '中景', subjects: [person()], camera: CAMERA, hasBlueprintScreenshot: false,
    });
    expect(withoutShot).not.toContain('导演台截图');
  });

  it('拼完之后没有残留占位符、也没有连续逗号', () => {
    const prompt = buildDirectorStagingPrompt({
      basePrompt: '中景，平视，柔和光',
      subjects: [person()],
      camera: CAMERA,
      hasBlueprintScreenshot: true,
    });
    expect(prompt).not.toContain('{{');
    expect(prompt).not.toContain(',,');
    expect(prompt).not.toContain(', ,');
    /**/
    expect(DIRECTOR_STAGING_TEMPLATE_ZH).toContain('将导演台布局视为不可见的制作指导');
    expect(prompt).toContain('将导演台布局视为不可见的制作指导');
    /* 七字段那句原样落在最后 */
    expect(prompt.endsWith('中景，平视，柔和光')).toBe(true);
  });
});

describe('导演台摆位·宽容解析', () => {
  it('认不出来的条目跳过，而不是把整次生成挡下来', () => {
    expect(stagingSubjectsFrom([
      { proxy: 'mannequin', position: [-1, 0, 0] },
      { proxy: '什么鬼', position: [0, 0, 0] },
      { proxy: 'box' },
      { proxy: 'box', position: [0, 0] },
      { proxy: 'box', position: [0, 'x', 0] },
      null,
      'x',
    ]).length).toBe(1);
  });

  it('相机缺一个端点就当没有机位（半个机位说不出任何方位）', () => {
    expect(stagingCameraFrom({ position: [0, 1, 2] })).toBeNull();
    expect(stagingCameraFrom({ position: [0, 1, 2], target: [0, 1, 0] }))
      .toEqual({ position: [0, 1, 2], target: [0, 1, 0] });
  });
});

/* ---------------- 真正的验收：这段话有没有发出去 ---------------- */

function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
  return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
}

function shot(id: string, t0: number, t1: number) {
  return {
    shot_id: id, t0_ms: t0, t1_ms: t1, duration_ms: t1 - t0,
    shot_size: 'medium_close_up', camera_position: 'eye_level', camera_move: 'slow_push_in',
    lighting: 'soft_key_from_left', sound: 'dialogue', replacement: '替换人物，保留窗光方向',
    confidence: 0.9, source: 'human', author: 'user:test',
  };
}

/**/
function canvasRunner() {
  const calls: CanvasRunRequest[] = [];
  const runner: CanvasRunner = {
    async run(request: CanvasRunRequest) {
      calls.push(request);
      const [commandName, second] = request.args;
      if (commandName === 'upload') {
        return { code: 0, stdout: JSON.stringify({ nodeKey: `ref-${request.args[1]}` }), stderr: '' };
      }
      if (commandName === 'node' && second === 'create') {
        return { code: 0, stdout: JSON.stringify({ nodeKey: 'n1', nodeType: 'image' }), stderr: '' };
      }
      if (commandName === 'node') {
        return {
          code: 0, stderr: '',
          stdout: `[run] task=t1 status=2 progress=100%\n${JSON.stringify({ nodeKey: 'n1', status: 2, data: { url: ['https://example.test/a.png'] } })}`,
        };
      }
      if (commandName === 'download') {
        const outIndex = request.args.indexOf('--out');
        const dir = (outIndex >= 0 ? request.args[outIndex + 1] : undefined) ?? request.cwd ?? tmpdir();
        const nodeName = request.args[2] ?? 'node';
        const file = join(dir, `${nodeName}.png`);
        writeFileSync(file, Buffer.from(`PNG:${nodeName}`), 'utf8');
        return { code: 0, stdout: `${file}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'error: unexpected\n' };
    },
  };
  return { runner, calls };
}

describe('导演台摆位·真的发到了后端', () => {
  it('摆过站位的项目，出图时提示词里带着摆位描述', async () => {
    const projects = new ProjectService(openDatabase(':memory:'));
    const created = projects.execute(command('project.create', {
      name: '摆位项目', max_budget_cents: 1000, rights_confirmed: true,
    }));
    const projectId = created.project_id!;
    /*
      每次写之前现读一次 revision：这个项目上的写命令有 5 条，
      每条各加多少版是领域层的规矩，测试里不复刻它——复刻一遍就等于
      把领域层的版本规则抄到测试里，抄错了只会得到一个难懂的"revision 冲突"。
    */
    const write = (type: string, payload: unknown) => projects.execute(command(type, payload, {
      project_id: projectId,
      expected_revision: (projects.getProject(projectId) as { revision: number }).revision,
    }));
    write('gate.approve', { gate: 'G0' });
    write('shot-fields.replace', { breakdown_revision: 1, shots: [shot('shot-01', 0, 2100)] });
    write('gate.approve', { gate: 'G1' });
    /*
      主体登记是**全局**的（`subject.register` 不带项目），所以照既有测试那样直接发；
      不登记的话，空间方案会因为"引用了不存在的主体"被校验器拒绝。
    */
    projects.execute(command('subject.register', { subject_ref: 'character:hero', display_name: '主角' }));
    write('spatial-plan.set', {
      shot_id: 'shot-01',
      expected_spatial_revision: 0,
      plan: {
        schema: 'replica.spatial-plan@1',
        shot_id: 'shot-01',
        enabled: true,
        subjects: [{
          subject_ref: 'character:hero',
          proxy: 'mannequin',
          position: [-1.5, 0, 0],
          rotation_deg: [0, 0, 0],
          pose: 'standing',
          body_preset: 'person-adult-male-strong',
          pose_preset: 'hands-on-hips',
          scale: 1,
        }],
        camera: { position: [0, 0.8, 9], target: [0, 0.6, 0], lens_mm: 50, pitch_deg: 0 },
      },
    });

    const { runner, calls } = canvasRunner();
    const service = new GenerationService(projects, createCanvasBackend(new CanvasAdapter(runner)));
    const workspace = mkdtempSync(join(tmpdir(), 'qiyin-staging-'));
    mkdirSync(workspace, { recursive: true });
    try {
      await service.generateShotImages({
        projectId,
        expectedRevision: (projects.getProject(projectId) as { revision: number }).revision,
        canvasCwd: workspace,
        workspaceDir: workspace,
        shots: [{ shot_id: 'shot-01', prompt: '中景，平视，柔和光' }],
        model: 'Z-image Turbo',
      });

      const create = calls.find((call) => call.args[0] === 'node' && call.args[1] === 'create');
      expect(create).toBeDefined();
      const promptIndex = create!.args.indexOf('--prompt');
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      const prompt = create!.args[promptIndex + 1]!;
      expect(prompt).toContain('subjects to place');
      expect(prompt).toContain('角色 1');
      expect(prompt).toContain('body preset person-adult-male-strong');
      expect(prompt).toContain('pose preset hands-on-hips');
      expect(prompt).toContain('screen-left');
      expect(prompt).toContain('depth-from-camera 9.0m');
      /* 七字段那句没有被丢掉，只是被包进了模板 */
      expect(prompt).toContain('中景，平视，柔和光');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
