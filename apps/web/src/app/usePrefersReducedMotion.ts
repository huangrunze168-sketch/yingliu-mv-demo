import { useSyncExternalStore } from 'react';

/**
 * `prefers-reduced-motion: reduce` 的响应式读取。
 *
 * 对标出处：对标站 首页 chunk 里 hero 组件用的是
 *   `import{t as xt}from"./Dfwm1__g.js"` → `xt.current`
 * 而 `Dfwm1__g.js` 末尾是
 *   `var v=new u("(prefers-reduced-motion: reduce)"); export{... v as t}`
 * 即一个**媒体查询对象**，`.current` 是它的当前命中值。对标把它用在两处：
 *   · `data-animate = !xt.current`   —— 非 reduced-motion 时**从首帧起就为 true**，
 *     这样等 `data-ready` 稍后翻上来时 transition 已经挂在元素上，过渡必然播；
 *   · `data-ready  = arrived || xt.current` —— reduced-motion 下直接落在终态，不做开场。
 * 所以这里也做成一个可持续订阅的布尔值，而不是挂载时读一次。
 */
const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
