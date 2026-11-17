import { useEffect, useRef, useState } from 'preact/hooks';
import { call, readSaved, save, type Commit } from './api';
import { Modal } from './ui/controls';

interface MultiCommit { root: string; name: string; commit: Commit }

export function MultiRepositoryDialog({ currentRoot, onClose, onChanged }: { currentRoot: string; onClose: () => void; onChanged?: () => Promise<void> }) {
  const [roots, setRoots] = useState<string[]>(() => {
    const saved = readSaved<unknown>('multi.repositories', []);
    const paths = Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string' && !!value.trim()) : [];
    return [...new Set([currentRoot, ...paths].filter(Boolean))];
  });
  const [tab, setTab] = useState<'sync' | 'log'>('sync');
  const [action, setAction] = useState<'fetch' | 'pull' | 'push'>('fetch');
  const [result, setResult] = useState<string[]>([]);
  const [commits, setCommits] = useState<MultiCommit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<MultiCommit>();
  const [confirmation, setConfirmation] = useState<'drop' | 'extract' | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [newRoot, setNewRoot] = useState('');
  const gate = useRef(false);
  const generation = useRef(0);
  const active = useRef(true);
  const rootsKey = JSON.stringify(roots);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);

  function updateRoots(next: string[]) {
    if (gate.current) return;
    generation.current++;
    setRoots(next); setCommits([]); setSelectedCommit(undefined); setConfirmation(null); setResult([]);
    try { save('multi.repositories', next); } catch (e) { setError(String(e)); }
  }
  function addRoot() {
    const value = newRoot.trim();
    if (!value || roots.includes(value)) return;
    updateRoots([...roots, value]); setNewRoot('');
  }
  async function loadLog() {
    const request = ++generation.current;
    setSelectedCommit(undefined); setConfirmation(null); setCommits([]); setError('');
    if (!roots.length) { setLoading(false); return; }
    setLoading(true);
    try {
      const query = { offset: 0, search: '', branch: '' };
      const value = await call<MultiCommit[]>('multi_repository_log', { roots, query });
      if (active.current && request === generation.current) setCommits(value);
    } catch (e) {
      if (active.current && request === generation.current) setError(String(e));
    } finally {
      if (active.current && request === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (tab === 'log') void loadLog();
    else { generation.current++; setLoading(false); }
    return () => { generation.current++; };
  }, [tab, rootsKey]);

  async function applySelected() {
    if (!selectedCommit || !confirmation || gate.current || loading || selectedCommit.root !== currentRoot || !roots.includes(selectedCommit.root)) return;
    const selected = selectedCommit;
    const action = confirmation;
    gate.current = true; setBusy(true); setError(''); setConfirmation(null);
    let failure = '';
    try {
      try { await call('multi_repository_history_action', { root: selected.root, revision: selected.commit.hash, action }); }
      catch (e) { failure = String(e); }
      await loadLog();
      try { await onChanged?.(); } catch (e) { failure = [failure, `刷新仓库失败：${String(e)}`].filter(Boolean).join('\n'); }
      if (active.current && failure) setError(failure);
    } finally { gate.current = false; if (active.current) setBusy(false); }
  }
  async function sync() {
    if (!roots.length || gate.current) return;
    gate.current = true; setBusy(true); setError(''); setResult([]);
    try {
      const value = await call<string[]>('multi_repository_sync', { roots, action });
      if (active.current) setResult(value);
      await onChanged?.();
    } catch (e) { if (active.current) setError(String(e)); }
    finally { gate.current = false; if (active.current) setBusy(false); }
  }
  const canEdit = !!selectedCommit && selectedCommit.root === currentRoot && roots.includes(selectedCommit.root);
  return (
    <Modal title="多仓库" onClose={onClose} busy={busy} class="history-dialog workflow-dialog">
      <h2>多仓库同步与提交记录</h2>
      <div class="bisect-results">
        <button disabled={busy} aria-pressed={tab === 'sync'} onClick={() => setTab('sync')}>同步</button>
        <button disabled={busy} aria-pressed={tab === 'log'} onClick={() => setTab('log')}>提交记录</button>
      </div>
      <form class="modal-actions" onSubmit={event => { event.preventDefault(); addRoot(); }}>
        <input aria-label="添加仓库路径" value={newRoot} disabled={busy} onInput={event => setNewRoot(event.currentTarget.value)} placeholder="添加仓库绝对路径" />
        <button type="submit" disabled={busy || !newRoot.trim()}>添加仓库</button>
      </form>
      <p class="muted">列表中的 {roots.length} 个仓库参与同步和查询。移除只修改本窗口列表，不删除磁盘文件。</p>
      <div class="multi-repository-list">
        {roots.map(path => <div class="multi-repository-row" key={path}>
          <span class="mono selectable" title={path}>{path}</span>
          <button aria-label={`移除仓库 ${path}`} disabled={busy} onClick={() => updateRoots(roots.filter(item => item !== path))}>移除</button>
        </div>)}
      </div>
      {tab === 'sync' && <div class="transport-form">
        <label>操作<select value={action} disabled={busy} onChange={event => setAction(event.currentTarget.value as typeof action)}><option value="fetch">Fetch</option><option value="pull">Pull</option><option value="push">Push</option></select></label>
        <button disabled={busy || !roots.length} onClick={() => void sync()}>执行到列表中的仓库</button>
        <div class="hunk-list">{result.map((line, index) => <pre key={index}>{line}</pre>)}</div>
      </div>}
      {tab === 'log' && <>
        {loading && <p role="status">正在读取提交记录…</p>}
        <div class="hunk-list">{commits.map(item => <section class="hunk-item" key={`${item.root}-${item.commit.hash}`}>
          <button class="multi-commit-row" disabled={busy || loading} aria-pressed={selectedCommit?.root === item.root && selectedCommit.commit.hash === item.commit.hash} onClick={() => { setSelectedCommit(item); setConfirmation(null); }}>
            <div><code>{item.commit.hash.slice(0, 8)}</code> {item.commit.subject}</div>
            <small>{item.name} · {item.commit.author} · {new Date(item.commit.time * 1000).toLocaleString('zh-CN')}</small>
          </button>
        </section>)}</div>
        {!loading && !error && !commits.length && <p class="muted">暂无提交记录。</p>}
        {selectedCommit && <section class="confirmation">
          <p class="mono selectable">已选择 {selectedCommit.commit.hash.slice(0, 8)} · {selectedCommit.root}</p>
          {!canEdit && <p>此仓库不是当前打开的仓库。请先在主窗口打开它，再操作提交历史。</p>}
          <div class="modal-actions"><button disabled={busy || loading || !canEdit} onClick={() => setConfirmation('extract')}>提取选中修改…</button><button class="navigation-danger" disabled={busy || loading || !canEdit} onClick={() => setConfirmation('drop')}>删除选中提交…</button></div>
          {confirmation && <div aria-label="确认多仓库历史操作"><p>{confirmation === 'drop' ? '这会重写当前仓库的提交历史。确认删除所选提交？' : '确认把所选提交的修改提取到当前仓库的工作区？'}</p>
            <div class="modal-actions"><button disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button disabled={busy || loading || !canEdit} onClick={() => void applySelected()}>确认执行</button></div>
          </div>}
        </section>}
      </>}
      {error && <p class="error-text" role="alert">{error}</p>}
      <div class="modal-actions"><button disabled={busy} onClick={onClose}>关闭</button></div>
    </Modal>
  );
}
