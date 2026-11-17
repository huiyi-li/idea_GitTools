import { useEffect, useRef, useState } from 'preact/hooks';
import { call, staged, type Status } from '../api';
import type { WorkspaceRepositories, WorkspaceRepositorySummary } from '../RepositoryWorkspace';

function fromStatus(status: Status): WorkspaceRepositorySummary {
  const unique = (predicate: (change: Status['changes'][number]) => boolean) => new Set(status.changes.filter(predicate).map(change => change.path)).size;
  return { branch: status.repository.branch, changedFiles: unique(() => true), stagedFiles: unique(staged), conflicts: unique(change => change.conflict) };
}

export function useWorkspaceSummaries(workspace: WorkspaceRepositories | null, status: Status | null) {
  const [summaries, setSummaries] = useState<Record<string, WorkspaceRepositorySummary>>({});
  const activeRoot = useRef(status?.repository.root ?? '');
  activeRoot.current = status?.repository.root ?? '';
  const roots = workspace?.repositories.map(repository => repository.root) ?? [];
  const key = JSON.stringify(roots);
  useEffect(() => {
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSummaries(previous => Object.fromEntries(roots.filter(root => previous[root]).map(root => [root, previous[root]])));
    const schedule = () => { if (!disposed && roots.length) timer = setTimeout(() => void refresh(), 20000); };
    async function refresh() {
      if (disposed || running || !roots.length) return;
      if (timer) clearTimeout(timer);
      if (document.visibilityState === 'hidden') { schedule(); return; }
      running = true;
      let cursor = 0;
      const read = async () => {
        while (!disposed && cursor < roots.length) {
          const root = roots[cursor++];
          if (root === activeRoot.current) continue;
          setSummaries(previous => ({ ...previous, [root]: { ...(previous[root] ?? { branch: null, changedFiles: 0, stagedFiles: 0, conflicts: 0 }), error: undefined, loading: true } }));
          try {
            const result = await call<WorkspaceRepositorySummary & { root: string }>('workspace_repository_summary', { root });
            if (result.root !== root) throw Error('仓库路径已改变，请重新扫描');
            if (!disposed && root !== activeRoot.current) setSummaries(previous => ({ ...previous, [root]: { ...result, loading: false, error: undefined } }));
          } catch (error) {
            if (!disposed && root !== activeRoot.current) setSummaries(previous => ({ ...previous, [root]: { ...previous[root], loading: false, error: String(error) } }));
          }
        }
      };
      await Promise.all([read(), read()]);
      running = false;
      schedule();
    }
    const resume = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    void refresh();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [key]);
  useEffect(() => {
    if (status) setSummaries(previous => ({ ...previous, [status.repository.root]: fromStatus(status) }));
  }, [status]);
  return status ? { ...summaries, [status.repository.root]: fromStatus(status) } : summaries;
}
