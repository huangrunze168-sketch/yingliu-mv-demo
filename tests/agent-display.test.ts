import { describe, expect, it } from 'vitest';
import { dialogue, isRealGenerationRunning, latestFailure, missingPlanningReply, toolActivities } from '../apps/web/src/features/agent/agentDisplay.js';
import type { AgentMessage } from '../apps/web/src/features/agent/agentClient.js';

const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text });

describe('Agent 对话与运行事件分层', () => {
  it('兼容截图的旧历史：日志不可见、无伪造回复，只展示最后一个可操作错误', () => {
    const nested = JSON.stringify({ type: 'error', status: 400, error: { message: "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } });
    const history = [
      message('u', 'user', '做一个短视频'),
      message('start', 'note', 'Codex CLI 已启动'),
      message('session', 'note', '会话已建立：sample-thread'),
      message('warning', 'error', 'Exceeded skills context budget of 2%.'),
      message('failure', 'error', JSON.stringify({ type: 'turn.failed', error: { message: nested } })),
      message('done', 'note', '进程退出，退出码 1'),
    ];
    expect(dialogue(history).map(item => item.text)).toEqual(['做一个短视频']);
    expect(latestFailure(history)).toContain('当前已改用本机 DSH');
    expect(latestFailure(history)).not.toContain('turn.failed');
  });

  it('重启后已结束却只有用户消息时标记规划结果未知，历史成功与失败不会误判', () => {
    expect(missingPlanningReply([])).toBe(false);
    expect(missingPlanningReply([message('u', 'user', '拍一段海边')])).toBe(true);
    expect(missingPlanningReply([message('u', 'user', '拍一段海边'), message('log', 'tool', '工具开始执行')])).toBe(true);
    expect(missingPlanningReply([message('u', 'user', '拍一段海边'), message('p', 'plan', '{}')])).toBe(false);
    expect(missingPlanningReply([message('u', 'user', '拍一段海边'), message('err', 'error', '模型失败')])).toBe(false);
    expect(missingPlanningReply([message('u1', 'user', '上一轮'), message('a', 'agent', '答复'), message('u2', 'user', '这一轮')])).toBe(true);
  });

  it('旧的生成进度不能把当前规划误标为真实生成', () => {
    const previous = [message('plan', 'plan', '{}'), message('old', 'progress', '{"kind":"image","phase":"running"}')];
    expect(isRealGenerationRunning(previous, true, 'planner-run-id')).toBe(false);
    expect(isRealGenerationRunning(previous, false, null)).toBe(false);
    expect(isRealGenerationRunning(previous, true, null)).toBe(true);
    expect(isRealGenerationRunning([message('bad', 'progress', '运行中')], true, null)).toBe(false);
  });

  it('只把当前轮工具状态放入可展开区域，新消息不延续旧失败', () => {
    const history = [message('u1', 'user', '第一个请求'), message('err', 'error', '服务失败'), message('u2', 'user', '重新尝试'),
      { ...message('tool-start', 'tool', '工具开始执行：web_search'), itemId: 'item-1' },
      { ...message('tool-done', 'tool', '工具执行完成：web_search'), itemId: 'item-1' }];
    expect(latestFailure(history)).toBe('');
    expect(toolActivities(history).map(item => item.text)).toEqual(['工具执行完成：web_search']);
  });
});
