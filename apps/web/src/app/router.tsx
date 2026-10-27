import { useSyncExternalStore } from 'react';

/**
 * 极简路径路由（0 新增依赖）。
 *
 * 为什么不用 react-router：
 * 本项目只需要 4 条路由、1 个动态段，且已有手写 store 的先例
 * （src/state/uiStore.ts 用 useSyncExternalStore）。再引一个 ~30KB 的
 * 路由框架，换来的是嵌套布局 / loader / 预取这些当前用不到的能力。
 *
 * 逃生舱：路由的外部契约是 navigate() / useRoute() / canvasHref()；
 * projectHref() 只保留旧链接兼容。
 * 将来若要换 react-router，只要改这一个文件，消费方代码不用动。
 */

export type Route =
  | { name: 'landing' }
  | { name: 'signup' }
  | { name: 'create' }
  | { name: 'skill' }
  | { name: 'workbenchHome' }
  | { name: 'agentHome' }
  | { name: 'canvas'; workspaceId: string | null; projectId: string | null; newProject: boolean }
  | { name: 'workbench'; projectId: string }
  | { name: 'not-found' };

const listeners = new Set<() => void>();

let currentPath = typeof window === 'undefined' ? '/' : window.location.pathname;
let currentSearch = typeof window === 'undefined' ? '' : window.location.search;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 把 query 纳入订阅快照：同一路径的状态入口（如 ?create=1）也必须触发页面重渲染。
const getSnapshot = () => `${currentPath}${currentSearch}`;

/** 匹配结果按 pathname 缓存：同路径下返回同一个对象引用，
 * 这样 useRoute() 的返回值可以安全放进 useEffect / useMemo 依赖。
 * 导出供 tests/web-router.test.ts 直接验证。 */
let cachedPath = '';
let cachedRoute: Route = { name: 'landing' };

export function matchRoute(pathname: string, search = ''): Route {
  const cacheKey = pathname + search;
  if (cacheKey === cachedPath) return cachedRoute;

  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] === 'yingliu-demo') segments.shift();
  let next: Route;

  if (segments.length === 0) {
    next = { name: 'landing' };
  } else if (segments[0] === 'signup') {
    next = { name: 'signup' };
  } else if (segments[0] === 'create') {
    next = { name: 'create' };
  } else if (segments[0] === 'skill') {
    next = { name: 'skill' };
  } else if (segments[0] === 'canvas') {
    const query = new URLSearchParams(search);
    next = { name: 'canvas', workspaceId: query.get('spaceId'), projectId: query.get('projectId'), newProject: query.get('newProject') === 'true' };
  } else if (segments[0] === 'workbench') {
    const query = new URLSearchParams(search);
    next = segments[1]
      ? { name: 'workbench', projectId: decodeURIComponent(segments[1]) }
      : query.get('agent') === '1'
        ? { name: 'agentHome' }
        : { name: 'workbenchHome' };
  } else {
    // 未知路径落到 404 页，而不是白屏或冒充落地页。
    next = { name: 'not-found' };
  }

  cachedPath = cacheKey;
  cachedRoute = next;
  return next;
}

/** 当前路由。订阅 popstate，因此浏览器前进 / 后退可用。 */
export function useRoute(): Route {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [pathname, query = ''] = snapshot.split('?');
  return matchRoute(pathname || '/', query ? `?${query}` : '');
}

export function canvasHref(workspaceId: string, projectId: string) {
  return `/canvas?spaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(projectId)}`;
}

export function newCanvasHref(source = 'sidebar_create_new', itemKey = 'create_new') {
  return `/canvas?newProject=true&source=${encodeURIComponent(source)}&itemKey=${encodeURIComponent(itemKey)}`;
}

/** 旧链接只作为历史兼容；新代码必须同时携带 spaceId 与 projectId。 */
export function projectHref(projectId: string) {
  return `/workbench/${encodeURIComponent(projectId)}`;
}

/**
 * 跳转。
 * - 默认 pushState（进历史栈，后退键可回）
 * - replace: true 用于「切换当前视图但不想留历史」的场景，例如切换项目
 * - 只有 push 才滚回顶部；replace 保持当前滚动位置（切项目不该跳页）
 */
export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (typeof window === 'undefined') return;

  const url = new URL(to, window.location.origin);
  if (url.pathname === currentPath && url.search === window.location.search) return;

  if (options.replace) {
    window.history.replaceState(null, '', url);
  } else {
    window.history.pushState(null, '', url);
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }

  currentPath = url.pathname;
  currentSearch = url.search;
  emit();
}

/** 本应用真正拥有的路径前缀。不在其中的链接交给浏览器正常处理。 */
const INTERNAL_ROOTS = new Set(['', 'signup', 'create', 'skill', 'workbench', 'canvas']);

export type LinkDecision =
  /** 站内路由跳转 */
  | { kind: 'navigate'; to: string }
  /** 交给浏览器：外部域名、纯锚点、无法解析 */
  | { kind: 'browser' }
  /** 吞掉：同路径且无 hash 变化，避免一次无意义的整页重载 */
  | { kind: 'swallow' };

/**
 * 判断一个 <a> 该怎么处理 —— 纯函数，便于单测。
 * 这是本模块最容易被写错的一段分支逻辑（hash 锚点 / 同路径 / 外部域名 / 未知前缀），
 * 因此从点击处理器里拆出来单独验证。
 */
export function resolveLinkDecision(anchorHref: string, currentHref: string): LinkDecision {
  let url: URL;
  let current: URL;
  try {
    url = new URL(anchorHref, currentHref);
    current = new URL(currentHref);
  } catch {
    return { kind: 'browser' };
  }

  if (url.origin !== current.origin) return { kind: 'browser' };

  if (url.pathname === current.pathname) {
    // 同一路径但 query 变化（例如 /workbench?create=1）仍然是一次站内跳转，
    // 不能被当作无意义点击吞掉；页面会据此打开对应的面板或预设状态。
    if (url.search !== current.search) return { kind: 'navigate', to: url.pathname + url.search };
    // 只变 hash（#demo / #method）→ 交给浏览器滚动
    if (url.hash && url.hash !== current.hash) return { kind: 'browser' };
    return { kind: 'swallow' };
  }

  // 也挡住 mailto: / tel: 之类：它们的 pathname 可能是空的，取不到内部根
  const root = url.pathname.split('/').filter(Boolean)[0] ?? '';
  if (!INTERNAL_ROOTS.has(root)) return { kind: 'browser' };

  return { kind: 'navigate', to: url.pathname + url.search };
}

function findAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a');
  return anchor instanceof HTMLAnchorElement ? anchor : null;
}

/**
 * 全局接管站内 <a> 点击。
 * 目的：让落地页里已存在的 href="/create" 直接生效，
 * 不必把 6 处 <a> 逐个改写成组件 —— 少碰 UI 代码，少一次回归风险。
 */
function interceptClicks(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const anchor = findAnchor(event.target);
  if (!anchor) return;
  if (anchor.target && anchor.target !== '_self') return;
  if (anchor.hasAttribute('download')) return;
  if ((anchor.getAttribute('rel') ?? '').includes('external')) return;

  const decision = resolveLinkDecision(anchor.href, window.location.href);
  if (decision.kind === 'browser') return;

  event.preventDefault();
  if (decision.kind === 'navigate') navigate(decision.to);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    currentPath = window.location.pathname;
    currentSearch = window.location.search;
    emit();
  });
  document.addEventListener('click', interceptClicks);
}
