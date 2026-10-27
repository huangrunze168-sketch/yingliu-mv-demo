import { describe, expect, it } from 'vitest';
import { canvasAgentHandoffKey, createCanvasAgentHandoff, parseCanvasAgentHandoff } from '../apps/web/src/features/agent/canvasAgentHandoff.js';

describe('Skill 到画布的 Agent 任务交接', () => {
  it('保留创作要求和所选 Skill，并使用项目隔离键', () => {
    const handoff = createCanvasAgentHandoff('  分析一条武侠短片  ', { id: 'classical-wuxia-director', version: '1.0.0', name: '古典武侠全流程导演' }, [{ id: 'sha256:image', kind: 'asset', label: '人物参考.png' }]);
    expect(canvasAgentHandoffKey('project-1')).toBe('qiyin.canvas.agent-handoff.project-1');
    expect(parseCanvasAgentHandoff(JSON.stringify(handoff), Date.parse(handoff.createdAt))).toMatchObject({
      text: '分析一条武侠短片',
      skill: { id: 'classical-wuxia-director', version: '1.0.0', name: '古典武侠全流程导演' },
      references: [{ id: 'sha256:image', kind: 'asset', label: '人物参考.png' }],
    });
  });

  it('拒绝过期、空内容和损坏的交接数据', () => {
    const old = createCanvasAgentHandoff('过期任务');
    expect(parseCanvasAgentHandoff(JSON.stringify(old), Date.parse(old.createdAt) + 11 * 60 * 1000)).toBeNull();
    expect(parseCanvasAgentHandoff('{bad json')).toBeNull();
    expect(parseCanvasAgentHandoff(JSON.stringify({ schema: 'xiaoqtv.canvas-agent-handoff.v1', text: ' ', createdAt: new Date().toISOString() }))).toBeNull();
  });
});
