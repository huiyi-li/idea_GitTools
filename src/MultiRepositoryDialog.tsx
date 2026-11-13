import { useEffect, useState } from 'preact/hooks';
import { call, readSaved, save, type Commit } from './api';
import { Modal } from './ui/controls';

interface MultiCommit { root: string; name: string; commit: Commit }

export function MultiRepositoryDialog({ currentRoot, onClose }: { currentRoot: string; onClose: () => void }) {
  const [roots, setRoots] = useState<string[]>(() => {
    const saved = readSaved<unknown>('multi.repositories', []);
    return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : [];
  });
  const [tab, setTab] = useState<'sync' | 'log'>('sync');
  const [action, setAction] = useState<'fetch' | 'pull' | 'push'>('fetch');
  const [result, setResult] = useState<string[]>([]);
  const [commits, setCommits] = useState<MultiCommit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<MultiCommit>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newRoot, setNewRoot] = useState('');

  async function applySelected(action: 'drop' | 'extract') {
    if (!selectedCommit || busy) return;
    const question = action === 'drop'
      ? `确认从 ${selectedCommit.name} 删除提交 ${selectedCommit.commit.hash.slice(0, 8)}？这会重写该仓库的提交历史。`
      : `确认把 ${selectedCommit.commit.hash.slice(0, 8)} 的修改提取到 ${selectedCommit.name} 当前分支？`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError('');
    try {
      await call<string>('multi_repository_history_action', {
        root: selectedCommit.root,
        revision: selectedCommit.commit.hash,
        action,
      });
      setSelectedCommit(undefined);
      await loadLog();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (currentRoot && !roots.includes(currentRoot)) {
      const next = [currentRoot, ...roots];
      setRoots(next);
      save('multi.repositories', next);
    }
  }, [currentRoot]);

  function toggle(root: string) {
    const next = roots.includes(root) ? roots.filter((item) => item !== root) : [...roots, root];
    setRoots(next);
    save('multi.repositories', next);
  }

  function addRoot() {
    const value = newRoot.trim();
    if (!value || roots.includes(value)) return;
    const next = [...roots, value];
    setRoots(next);
    save('multi.repositories', next);
    setNewRoot('');
  }

  async function sync() {
    if (!roots.length) return;
    setBusy(true);
    setError('');
    try {
      setResult(await call<string[]>('multi_repository_sync', { roots, action }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadLog() {
    if (!roots.length) return;
    setBusy(true);
    setError('');
    try {
      const query = { offset: 0, search: '', branch: '', author: '', since: '', until: '', path: '', revision: '', merge: 'all', firstParent: false };
      setCommits(await call<MultiCommit[]>('multi_repository_log', { roots, query }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="多仓库" onClose={onClose} busy={busy} class="history-dialog workflow-dialog">
      <h2>多仓库同步与提交图</h2>
      <div class="modal-actions">
        <button aria-pressed={tab === 'sync'} onClick={() => setTab('sync')}>同步</button>
        <button aria-pressed={tab === 'log'} onClick={() => { setTab('log'); void loadLog(); }}>提交图</button>
      </div>
      <form class="modal-actions" onSubmit={(event) => { event.preventDefault(); addRoot(); }}>
        <input aria-label="添加仓库路径" value={newRoot} disabled={busy} onInput={(event) => setNewRoot(event.currentTarget.value)} placeholder="添加仓库绝对路径" />
        <button type="submit" disabled={busy || !newRoot.trim()}>添加仓库</button>
      </form>
      <div class="navigation-files">
        {roots.map((root) => (
          <label key={root} title={root}>
            <input type="checkbox" checked={roots.includes(root)} disabled={busy} onChange={() => toggle(root)} />
            <span class="ellipsis">{root}</span>
          </label>
        ))}
      </div>
      {tab === 'sync' && <>
        <label>操作<select value={action} disabled={busy} onChange={(event) => setAction(event.currentTarget.value as typeof action)}><option value="fetch">Fetch</option><option value="pull">Pull</option><option value="push">Push</option></select></label>
        <button disabled={busy || !roots.length} onClick={() => void sync()}>执行到所有仓库</button>
        <div class="hunk-list">{result.map((line) => <pre key={line}>{line}</pre>)}</div>
      </>}
      {tab === 'log' && <>
        <div class="hunk-list">
        {commits.map((item) => <section class="hunk-item" key={`${item.root}-${item.commit.hash}`}>
          <button class="multi-commit-row" disabled={busy} aria-pressed={selectedCommit?.root === item.root && selectedCommit.commit.hash === item.commit.hash} onClick={() => setSelectedCommit(item)}>
            <div><code>{item.commit.hash.slice(0, 8)}</code> {item.commit.subject}</div>
            <small>{item.name} · {item.commit.author} · {new Date(item.commit.time * 1000).toLocaleString('zh-CN')}</small>
          </button>
        </section>)}
        {!busy && !commits.length && <p class="muted">暂无提交记录。</p>}
        </div>
        {selectedCommit && <div class="multi-commit-actions">
          <span class="muted">已选择 {selectedCommit.commit.hash.slice(0, 8)} · {selectedCommit.name}</span>
          <button disabled={busy} onClick={() => void applySelected('extract')}>提取选中修改</button>
          <button class="navigation-danger" disabled={busy} onClick={() => void applySelected('drop')}>删除选中提交</button>
        </div>}
      </>}
      {error && <p class="error-text" role="alert">{error}</p>}
      <div class="modal-actions"><button disabled={busy} onClick={onClose}>关闭</button></div>
    </Modal>
  );
}

