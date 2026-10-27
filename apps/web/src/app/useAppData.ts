import { useEffect, useState } from 'react';
import { apiAdapter } from '../adapters/web/apiAdapter';
import type { Asset, GenerationJob, ProjectSummary, ReferenceSource, Shot } from '../ports';

export const ports = apiAdapter;

export function useAppData(projectId: string) {
  const [project, setProject] = useState<ProjectSummary>();
  const [shots, setShots] = useState<Shot[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [sources, setSources] = useState<ReferenceSource[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);

  const refreshJobs = () => ports.generation.listJobs(projectId).then(next => {
    setJobs(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    return undefined;
  });
  const refreshSources = () => ports.source.list(projectId).then(setSources);
  const refreshAssets = () => ports.media.listAssets(projectId).then(setAssets);

  useEffect(() => {
    let active = true;
    void Promise.all([
      ports.canvases.get(projectId),
      ports.shots.list(projectId),
      ports.media.listAssets(projectId),
      ports.source.list(projectId),
      ports.generation.listJobs(projectId),
    ]).then(([nextProject, nextShots, nextAssets, nextSources, nextJobs]) => {
      if (!active) return;
      setProject(nextProject);
      setShots(nextShots);
      setAssets(nextAssets);
      setSources(nextSources);
      setJobs(nextJobs);
    });

    // 生成队列轮询：服务端失败、重试或恢复后，工作台无需手动刷新即可看到新状态。
    const timer = window.setInterval(() => {
      void ports.generation.listJobs(projectId).then(nextJobs => {
        if (!active) return;
        setJobs(current => JSON.stringify(current) === JSON.stringify(nextJobs) ? current : nextJobs);
      }).catch(() => undefined);
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [projectId]);

  return { project, shots, assets, sources, jobs, refreshJobs, refreshSources, refreshAssets };
}
