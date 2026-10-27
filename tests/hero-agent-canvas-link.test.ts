import { expect, it } from 'vitest';
import { libtvCanvasLink } from '../apps/web/src/features/agent/agentDisplay.js';

it('只识别 LibTV 官方画布地址，不把任意 Agent 文本变成外链', () => {
  const url = 'https://www.liblib.tv/canvas?projectId=abc-123';
  expect(libtvCanvasLink(`已新建并绑定 LibTV 画布：${url}`)).toBe(url);
  expect(libtvCanvasLink('https://evil.example/canvas?projectId=abc-123')).toBeNull();
  expect(libtvCanvasLink('https://www.liblib.tv/skill')).toBeNull();
});
