import { describe, expect, it } from 'vitest';
import {
  canvasHref,
  matchRoute,
  newCanvasHref,
  projectHref,
  resolveLinkDecision,
} from '../apps/web/src/app/router.js';

/**
 * 网页端路由骨架的纯逻辑。
 *
 * 守两件事，都属于「错了不会报错、只会表现得像正常」的那类：
 *
 *   1. 路径 → 路由的映射。未知路径必须回落落地页，而不是白屏或抛错。
 *      这四条脸（/ · /signup · /create · /workbench）是整个网页端的骨架，
 *      一条链接写错就整页空白，所以边界要钉死。
 *
 *   2. 站内 <a> 点击的拦截判定。落地页里的裸 <a> 全靠这段分支决定是走前端路由、
 *      交给浏览器滚动，还是原样放行。判断错了表现很隐蔽：要么锚点失效，
 *      要么每次点击都退化成整页重载。
 */

const ORIGIN = 'https://studio.example.com';
const HERE = `${ORIGIN}/`;

describe('matchRoute', () => {
  it('根路径与空路径都落到落地页', () => {
    expect(matchRoute('/')).toEqual({ name: 'landing' });
    expect(matchRoute('')).toEqual({ name: 'landing' });
  });

  it('/signup 落到注册引导页', () => {
    expect(matchRoute('/signup')).toEqual({ name: 'signup' });
    expect(matchRoute('/signup/extra')).toEqual({ name: 'signup' });
  });

  it('/create 落到消费级四步动线', () => {
    expect(matchRoute('/create')).toEqual({ name: 'create' });
  });

  it('/workbench 无项目段时进入项目列表', () => {
    expect(matchRoute('/workbench')).toEqual({ name: 'workbenchHome' });
    expect(matchRoute('/workbench/')).toEqual({ name: 'workbenchHome' });
  });

  it('/workbench/:projectId 只保留旧链接兼容', () => {
    expect(matchRoute('/workbench/p-42')).toEqual({ name: 'workbench', projectId: 'p-42' });
    expect(matchRoute('/workbench/a%2Fb')).toEqual({ name: 'workbench', projectId: 'a/b' });
  });

  it('/canvas 分别读取 spaceId、projectId 与 newProject', () => {
    expect(matchRoute('/canvas', '?spaceId=space-1&projectId=canvas-1')).toEqual({ name: 'canvas', workspaceId: 'space-1', projectId: 'canvas-1', newProject: false });
    expect(matchRoute('/canvas', '?newProject=true&source=sidebar_create_new')).toEqual({ name: 'canvas', workspaceId: null, projectId: null, newProject: true });
    expect(canvasHref('space/1', 'canvas 1')).toBe('/canvas?spaceId=space%2F1&projectId=canvas%201');
    expect(newCanvasHref()).toBe('/canvas?newProject=true&source=sidebar_create_new&itemKey=create_new');
  });

  it('未知路径落到 404 页，而不是白屏或冒充落地页', () => {
    expect(matchRoute('/nope')).toEqual({ name: 'not-found' });
    expect(matchRoute('/assets/logo.svg')).toEqual({ name: 'not-found' });
    expect(matchRoute('/detail/abc123')).toEqual({ name: 'not-found' });
  });

  it('子路径不吞掉父级语义', () => {
    expect(matchRoute('/create/extra')).toEqual({ name: 'create' });
    expect(matchRoute('/workbench/p-42/canvas')).toEqual({ name: 'workbench', projectId: 'p-42' });
  });

  it('同一路径返回同一个对象引用（可安全放进 deps）', () => {
    expect(matchRoute('/create')).toBe(matchRoute('/create'));
  });
});

describe('projectHref', () => {
  it('与 matchRoute 往返一致（含需要转义的 id）', () => {
    for (const id of ['p-demo', 'p-42', 'a/b', '带中文的 id']) {
      expect(matchRoute(projectHref(id))).toEqual({ name: 'workbench', projectId: id });
    }
  });
});

describe('resolveLinkDecision', () => {
  it('站内四条脸的裸 <a> 走前端跳转', () => {
    expect(resolveLinkDecision(`${ORIGIN}/signup`, HERE)).toEqual({ kind: 'navigate', to: '/signup' });
    expect(resolveLinkDecision(`${ORIGIN}/create`, HERE)).toEqual({ kind: 'navigate', to: '/create' });
    expect(resolveLinkDecision(`${ORIGIN}/workbench`, HERE)).toEqual({ kind: 'navigate', to: '/workbench' });
    expect(resolveLinkDecision(`${ORIGIN}/workbench/p-42`, HERE)).toEqual({
      kind: 'navigate',
      to: '/workbench/p-42',
    });
  });

  it('带查询串的站内链接保留查询串', () => {
    expect(resolveLinkDecision(`${ORIGIN}/create?from=hero`, HERE)).toEqual({
      kind: 'navigate',
      to: '/create?from=hero',
    });
  });

  it('相对链接按当前地址解析', () => {
    expect(resolveLinkDecision('create', HERE)).toEqual({ kind: 'navigate', to: '/create' });
  });

  it('纯锚点交给浏览器滚动，不当成路由跳转', () => {
    expect(resolveLinkDecision(`${ORIGIN}/#demo`, HERE)).toEqual({ kind: 'browser' });
    expect(resolveLinkDecision(`${ORIGIN}/#method`, HERE)).toEqual({ kind: 'browser' });
  });

  it('同路径且无 hash 变化时吞掉点击，避免整页重载', () => {
    expect(resolveLinkDecision(`${ORIGIN}/create`, `${ORIGIN}/create`)).toEqual({ kind: 'swallow' });
    expect(resolveLinkDecision(`${ORIGIN}/#demo`, `${ORIGIN}/#demo`)).toEqual({ kind: 'swallow' });
  });

  it('外部域名一律放行给浏览器', () => {
    expect(resolveLinkDecision('https://example.org/create', HERE)).toEqual({ kind: 'browser' });
  });

  it('非路由前缀的站内地址放行，不劫持静态资源', () => {
    expect(resolveLinkDecision(`${ORIGIN}/assets/logo.svg`, HERE)).toEqual({ kind: 'browser' });
    expect(resolveLinkDecision(`${ORIGIN}/docs/readme.md`, HERE)).toEqual({ kind: 'browser' });
  });
});
