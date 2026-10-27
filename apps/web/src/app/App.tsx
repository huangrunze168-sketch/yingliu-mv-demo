import { lazy, Suspense, useEffect } from 'react';
import { hasSession } from '../features/auth/session';
import { navigate, useRoute } from './router';

const LandingPage = lazy(() => import('../features/create/CreateFlowDemo').then(module => ({ default: module.CreateFlowDemo })));
const NotFoundPage = lazy(() => import('../features/marketing/NotFoundPage').then(module => ({ default: module.NotFoundPage })));
const SignupPage = lazy(() => import('../features/marketing/SignupPage').then(module => ({ default: module.SignupPage })));
const CreateFlow = lazy(() => import('../features/create/CreateFlowDemo').then(module => ({ default: module.CreateFlowDemo })));
const SkillPage = lazy(() => import('../features/skills/SkillPage').then(module => ({ default: module.SkillPage })));
const ProjectListPage = lazy(() => import('../features/workbench/ProjectListPage').then(module => ({ default: module.ProjectListPage })));
const CanvasRoute = lazy(() => import('./WorkbenchRoutes').then(module => ({ default: module.CanvasRoute })));
const WorkbenchApp = lazy(() => import('./WorkbenchRoutes').then(module => ({ default: module.WorkbenchApp })));

function RouteLoading() {
  return <main className="page"><div className="empty-state" role="status" aria-live="polite"><div className="empty-icon">✦</div><h2>正在打开小QTV…</h2><p>正在载入当前创作模块。</p></div></main>;
}

export function App() {
  const route = useRoute();
  const legacyAgentRoute = route.name === 'agentHome';
  const needsSession = ['workbenchHome', 'workbench', 'canvas'].includes(route.name) && !hasSession();

  useEffect(() => {
    if (legacyAgentRoute) {
      navigate('/skill', { replace: true });
      return;
    }
    if (!needsSession) return;
    const next = window.location.pathname + window.location.search;
    navigate(`/signup?next=${encodeURIComponent(next)}`, { replace: true });
  }, [legacyAgentRoute, needsSession]);

  let page;
  if (route.name === 'landing') page = <LandingPage />;
  else if (route.name === 'not-found') page = <NotFoundPage />;
  else if (route.name === 'signup' || needsSession) page = <SignupPage />;
  else if (route.name === 'create') page = <CreateFlow />;
  else if (route.name === 'skill') page = <SkillPage />;
  else if (route.name === 'workbenchHome') page = <ProjectListPage />;
  else if (route.name === 'agentHome') page = <SkillPage />;
  else if (route.name === 'canvas') page = <CanvasRoute workspaceId={route.workspaceId} projectId={route.projectId} newProject={route.newProject} />;
  else page = <WorkbenchApp projectId={route.projectId} />;

  return <Suspense fallback={<RouteLoading />}>{page}</Suspense>;
}
