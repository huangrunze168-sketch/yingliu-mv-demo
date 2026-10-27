import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildEvalReport, quantizeToFrames, scoreFromError, worstDimension } from '@qiyin/kernel-service';
import type { FrontkernelMediaProbe } from '@qiyin/frontkernel-adapter';

/**
 * 偏差评估。
 *
 * 第一版只做可计算指标——它们必须确定性、可复现，并且**每条结论都能归因到具体镜头**。
 * 这是「成片不像时能定位到某一镜」的前提；一个笼统的像不像分数帮不上任何忙。
 */

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

const DEFAULT_SHOTS = [
  { shot_id: 'shot-01', duration_ms: 2100 },
  { shot_id: 'shot-02', duration_ms: 2100 },
];

function probe(overrides: Partial<FrontkernelMediaProbe> = {}): FrontkernelMediaProbe {
  return { path: 'x.mp4', duration: 4.2, hasVideo: true, hasAudio: true, width: 540, height: 960, frameRate: 30, ...overrides };
}

function build(
  reference: FrontkernelMediaProbe,
  result: FrontkernelMediaProbe,
  shots: Array<{ shot_id: string; duration_ms: number }> = DEFAULT_SHOTS,
) {
  return buildEvalReport({
    referenceArtifact: HASH_A, resultArtifact: HASH_B,
    reference, result, shots, frameRate: 30,
  });
}

describe('帧量化', () => {
  it('整数帧的时长原样保留', () => {
    expect(quantizeToFrames(2100, 30)).toBeCloseTo(2100, 6);
    expect(quantizeToFrames(1000, 30)).toBeCloseTo(1000, 6);
  });

  it('非整数帧的时长被量化，误差如实保留', () => {
    // 1234ms @30fps = 37.02 帧 → 37 帧 = 1233.33ms
    expect(quantizeToFrames(1234, 30)).toBeCloseTo(1233.3333, 3);
  });

  it('帧率非法时不做量化，避免除以零', () => {
    expect(quantizeToFrames(1234, 0)).toBe(1234);
  });
});

describe('误差评分', () => {
  it('完全一致得 1', () => {
    expect(scoreFromError(100, 100)).toBe(1);
  });

  it('偏差一成则得 0.9', () => {
    expect(scoreFromError(100, 110)).toBeCloseTo(0.9, 6);
    expect(scoreFromError(100, 90)).toBeCloseTo(0.9, 6);
  });

  it('偏差达到参考本身时归零，且不为负', () => {
    expect(scoreFromError(100, 300)).toBe(0);
  });
});

describe('报告构造', () => {
  it('四个可计算维度齐全', () => {
    const report = build(probe(), probe());
    expect(report.schema).toBe('replica.eval-report@1');
    expect(report.dimensions.map((dimension) => dimension.name)).toEqual([
      'total_duration', 'shot_timing', 'canvas_match', 'audio_presence',
    ]);
  });

  /**
   * 置信度取决于**这个结论是怎么得来的**，而不是「看起来对不对」。
   *
   * 时长、画幅这些是直接读出来的事实，置信度 1；
   * 但「有没有声音」在没做响度测量时只是「容器里有没有音轨」——
   * 所以那个结论要降置信度，不能让用户以为量过。
   */
  it('量过响度的维度置信度为 1，其余可计算维度同样是 1', () => {
    const report = buildEvalReport({
      referenceArtifact: HASH_A, resultArtifact: HASH_B,
      reference: probe(), result: probe(),
      referenceLoudness: { max_db: -8.8, mean_db: -23.3 },
      resultLoudness: { max_db: -12.1, mean_db: -25.0 },
      shots: DEFAULT_SHOTS, frameRate: 30,
    });
    expect(report.dimensions.every((dimension) => dimension.confidence === 1)).toBe(true);
    expect(report.dimensions.find((dimension) => dimension.name === 'audio_presence')?.delta)
      .toMatchObject({ measurement: 'loudness', expected: true, actual: true });
  });

  it('没做响度测量时退回音轨存在性，并如实把置信度降到 0.5', () => {
    const report = build(probe(), probe());
    const dimension = report.dimensions.find((item) => item.name === 'audio_presence');
    expect(dimension?.confidence).toBe(0.5);
    expect(dimension?.delta).toMatchObject({ measurement: 'stream-presence' });
  });

  it('完全一致的成片得满分，且没有责任镜头', () => {
    const report = build(probe(), probe());
    expect(report.dimensions.every((dimension) => dimension.score === 1)).toBe(true);
    expect(worstDimension(report)).toBeNull();
    expect(report.dimensions.find((dimension) => dimension.name === 'shot_timing')?.attribution).toEqual([]);
  });

  it('总时长偏差被算进 delta', () => {
    const report = build(probe({ duration: 4.2 }), probe({ duration: 3.0 }));
    const dimension = report.dimensions.find((item) => item.name === 'total_duration');
    expect(dimension?.delta).toMatchObject({ expected_ms: 4200, actual_ms: 3000 });
    expect(dimension?.score).toBeCloseTo(1 - 1200 / 4200, 4);
  });

  it('画幅不一致直接判 0，并写明两侧尺寸', () => {
    const report = build(probe({ width: 540, height: 960 }), probe({ width: 1080, height: 1920 }));
    const dimension = report.dimensions.find((item) => item.name === 'canvas_match');
    expect(dimension?.score).toBe(0);
    expect(dimension?.delta).toMatchObject({ expected: '540x960', actual: '1080x1920' });
  });

  it('参考有声音而成片没有时如实报 0 —— 这是真实差距，不该被粉饰', () => {
    const report = build(probe({ hasAudio: true }), probe({ hasAudio: false }));
    const dimension = report.dimensions.find((item) => item.name === 'audio_presence');
    expect(dimension?.score).toBe(0);
    expect(dimension?.delta).toMatchObject({ expected: true, actual: false });
  });

  /**
   * 这一条是响度测量存在的全部理由。
   *
   * 于是 `hasAudio` 对三者都返回 true（实测：参考片 -91 dB、生成片段 -8.8 dB、
   * 我们的成片 -91 dB）。只看 `hasAudio`，「声音被丢了」这件事永远发现不了。
   */
  it('两侧都有音轨但成片是数字静音时判 0 —— 光看 hasAudio 永远发现不了这件事', () => {
    const report = buildEvalReport({
      referenceArtifact: HASH_A, resultArtifact: HASH_B,
      reference: probe({ hasAudio: true }), result: probe({ hasAudio: true }),
      referenceLoudness: { max_db: -8.8, mean_db: -23.3 },
      resultLoudness: { max_db: -91, mean_db: -91 },
      shots: DEFAULT_SHOTS, frameRate: 30,
    });
    const dimension = report.dimensions.find((item) => item.name === 'audio_presence');
    expect(dimension?.score).toBe(0);
    expect(dimension?.confidence).toBe(1);
    expect(dimension?.delta).toMatchObject({ measurement: 'loudness', expected: true, actual: false });
  });

  it('参考片本身就是静音时，静音的成片判 1 —— 不能把「都没声音」也算成差距', () => {
    const report = buildEvalReport({
      referenceArtifact: HASH_A, resultArtifact: HASH_B,
      reference: probe({ hasAudio: true }), result: probe({ hasAudio: true }),
      referenceLoudness: { max_db: -91, mean_db: -91 },
      resultLoudness: { max_db: -91, mean_db: -91 },
      shots: DEFAULT_SHOTS, frameRate: 30,
    });
    expect(report.dimensions.find((item) => item.name === 'audio_presence')?.score).toBe(1);
  });

  it('一侧测不出来就整体退回音轨存在性，不拿半个测量当结论', () => {
    const report = buildEvalReport({
      referenceArtifact: HASH_A, resultArtifact: HASH_B,
      reference: probe({ hasAudio: true }), result: probe({ hasAudio: true }),
      referenceLoudness: { max_db: -8.8, mean_db: -23.3 },
      resultLoudness: null,
      shots: DEFAULT_SHOTS, frameRate: 30,
    });
    const dimension = report.dimensions.find((item) => item.name === 'audio_presence');
    expect(dimension?.delta).toMatchObject({ measurement: 'stream-presence' });
    expect(dimension?.confidence).toBe(0.5);
  });

  it('只有真的出现漂移的镜头才被列为责任镜头', () => {
    const report = build(probe(), probe(), [
      { shot_id: 'shot-01', duration_ms: 2100 },   // 整数帧，无漂移
      { shot_id: 'shot-02', duration_ms: 1234 },   // 非整数帧，有漂移
    ]);
    const dimension = report.dimensions.find((item) => item.name === 'shot_timing');
    expect(dimension?.attribution.map((item) => item.entity_id)).toEqual(['shot-02']);
    expect(dimension?.attribution[0]?.path).toBe('duration_ms');
    expect(typeof (dimension?.delta as { worst_drift_ms?: unknown } | undefined)?.worst_drift_ms).toBe('number');
  });

  it('最差维度能直接指出问题所在', () => {
    const report = build(probe(), probe({ width: 1080, height: 1920, hasAudio: false }));
    expect(worstDimension(report)?.name).toBe('canvas_match');
  });
});

describe('报告落库', () => {
  function command(type: string, payload: unknown, extras: Record<string, unknown> = {}) {
    return { command_id: randomUUID(), actor: 'user:test', type, payload, ...extras };
  }

  it('记录报告、推进 revision、并在事件里带上被归因的实体', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = service.execute(command('project.create', { name: '评估项目', max_budget_cents: 1000, rights_confirmed: true }));
    const projectId = created.project_id!;

    // 成片由静帧铺成，本来就没有音轨；参考片有——这是当前最真实的落差
    const report = build(probe({ hasAudio: true }), probe({ hasAudio: false }), [
      { shot_id: 'shot-01', duration_ms: 2100 },
      { shot_id: 'shot-02', duration_ms: 1234 },
    ]);
    const recorded = service.execute(command('eval.record', { report }, { project_id: projectId, expected_revision: 1 }));
    const payload = recorded.payload as {
      report_id: string; dimension_count: number;
      worst_dimension: { name: string } | null; attributed_entities: string[];
    };

    expect(payload.dimension_count).toBe(4);
    // 音轨缺失是 0 分，比时长漂移严重 → 最差维度是它
    expect(payload.worst_dimension?.name).toBe('audio_presence');
    expect(payload.attributed_entities).toEqual(['shot-02']);

    const project = service.getProject(projectId) as { eval_reports: Array<{ report_id: string; report: { dimensions: unknown[] } }> };
    expect(project.eval_reports).toHaveLength(1);
    expect(project.eval_reports[0]?.report.dimensions).toHaveLength(4);
    expect(service.listEvents(projectId).map((event) => event.type)).toEqual(['project.created', 'eval.recorded']);
  });

  it('空维度列表被契约拒绝', () => {
    const service = new ProjectService(openDatabase(':memory:'));
    const created = service.execute(command('project.create', { name: '评估项目', max_budget_cents: 1000, rights_confirmed: true }));
    expect(() => service.execute(command('eval.record', {
      report: {
        schema: 'replica.eval-report@1', reference_artifact: HASH_A, result_artifact: HASH_B,
        evaluator: { id: 'x', version: '1' }, dimensions: [],
      },
    }, { project_id: created.project_id!, expected_revision: 1 }))).toThrow();
  });
});
