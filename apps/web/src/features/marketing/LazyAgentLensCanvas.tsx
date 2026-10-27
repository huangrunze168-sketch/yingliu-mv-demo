import { lazy, Suspense } from 'react';
import type { AgentLensCanvasProps } from './AgentLensCanvas';

/* Three.js 与完整 WebGL 着色器只在首屏真正渲染透镜时下载、解析。 */
const AgentLensCanvas = lazy(() => import('./AgentLensCanvas').then(module => ({ default: module.AgentLensCanvas })));

export function LazyAgentLensCanvas(props: AgentLensCanvasProps) {
  return <Suspense fallback={null}><AgentLensCanvas {...props} /></Suspense>;
}
