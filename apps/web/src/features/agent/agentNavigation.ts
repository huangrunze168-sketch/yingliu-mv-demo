import { ports } from '../../app/useAppData';
import { canvasHref, navigate } from '../../app/router';
import { agentClient } from './agentClient';

/** 只有消息已由服务端接受，才把同一项目的会话带进对应画布。 */
export async function openAgentCanvas(activeProjectId?: string | null): Promise<boolean> {
  // 优先使用本次对话已绑定的项目，避免服务端有多个工作区时误跳到旧画布。
  const projectId = activeProjectId ?? await agentClient.homeProject();
  if (!projectId) return false;
  const workspace = (await ports.workspaces.list()).find(item => item.primaryProjectId === projectId);
  if (!workspace) return false;
  window.localStorage.setItem('qiyin.hero.agent.project', projectId);
  navigate(canvasHref(workspace.id, projectId));
  return true;
}
