import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { call, readSaved, save, type Commit } from './api';
import { Modal } from './ui/controls';

interface MultiCommit { root: string; name: string; commit: Commit }
interface MultiBranchInfo {
  root: string;
  name: string;
  currentBranch: string | null;
  head: string | null;
  dirty: boolean;
  branches: string[];
}

function repoColor(root: string) {
  let hash = 2166136261;
  for (let index = 0; index < root.length; index++) {
    hash = Math.imul(hash ^ root.charCodeAt(index), 16777619);
  }
  return `hsl(${(hash >>> 0) % 360} 58% 56%)`;
}

export function MultiRepositoryDialog({
  currentRoot,
  workspaceRoots = [],
  onClose,
  onChanged,
  onOpenCommit,
}: {
  currentRoot: string;
  workspaceRoots?: string[];
  onClose: () => void;
  onChanged?: () => Promise<void>;
  onOpenCommit?: (root: string, commitHash: string) => void;
}) {
  const [roots, setRoots] = useState<string[]>(() => {
    const saved = readSaved<unknown>('multi.repositories', []);
    const paths = Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string' && !!value.trim()) : [];
    return [...new Set([currentRoot, ...paths].filter(Boolean))];
  });
  const [tab, setTab] = useState<'sync' | 'branches' | 'log'>('sync');
  const [action, setAction] = useState<'fetch' | 'pull' | 'push'>('fetch');
  const [result, setResult] = useState<string[]>([]);
  const [commits, setCommits] = useState<MultiCommit[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [logBranch, setLogBranch] = useState('');
  const [selectedCommit, setSelectedCommit] = useState<MultiCommit>();
  const [confirmation, setConfirmation] = useState<'drop' | 'extract' | null>(null);
  const [branchInfos, setBranchInfos] = useState<MultiBranchInfo[]>([]);
  const [branchAction, setBranchAction] = useState<'checkout' | 'create' | 'delete'>('checkout');
  const [targetBranchName, setTargetBranchName] = useState('');
  const targetBranchRef = useRef('');
  const [branchResults, setBranchResults] = useState<string[]>([]);
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
    setRoots(next); setCommits([]); setSelectedCommit(undefined); setConfirmation(null); setResult([]); setBranchResults([]);
    try { save('multi.repositories', next); } catch (e) { setError(String(e)); }
  }
  function addRoot() {
    const value = newRoot.trim();
    if (!value || roots.includes(value)) return;
    updateRoots([...roots, value]); setNewRoot('');
  }
  async function loadLog(searchText = logSearch, branchText = logBranch) {
    const request = ++generation.current;
    setSelectedCommit(undefined); setConfirmation(null); setCommits([]); setError('');
    if (!roots.length) { setLoading(false); return; }
    setLoading(true);
    try {
      const query = { offset: 0, search: searchText.trim(), branch: branchText.trim() };
      const value = await call<MultiCommit[]>('multi_repository_log', { roots, query });
      if (active.current && request === generation.current) setCommits(value);
    } catch (e) {
      if (active.current && request === generation.current) setError(String(e));
    } finally {
      if (active.current && request === generation.current) setLoading(false);
    }
  }
  async function loadBranches() {
    const request = ++generation.current;
    setBranchInfos([]); setError('');
    if (!roots.length) { setLoading(false); return; }
    setLoading(true);
    try {
      const value = await call<MultiBranchInfo[]>('multi_repository_branches', { roots });
      if (active.current && request === generation.current) {
        setBranchInfos(value);
        if (!targetBranchRef.current && value[0]?.currentBranch) {
          targetBranchRef.current = value[0].currentBranch;
          setTargetBranchName(value[0].currentBranch);
        }
      }
    } catch (e) {
      if (active.current && request === generation.current) setError(String(e));
    } finally {
      if (active.current && request === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (tab === 'log') void loadLog();
    else if (tab === 'branches') void loadBranches();
    else { generation.current++; setLoading(false); }
    return () => { generation.current++; };
  }, [tab, rootsKey]);

  const sharedBranches = useMemo(() => {
    const counts = new Map<string, number>();
    for (const info of branchInfos) {
      for (const b of info.branches) {
        counts.set(b, (counts.get(b) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [branchInfos]);

  async function runBranchAction() {
    const branchToRun = (targetBranchRef.current || targetBranchName).trim();
    if (!roots.length || !branchToRun || gate.current) return;
    gate.current = true; setBusy(true); setError(''); setBranchResults([]);
    try {
      const res = await call<string[]>('multi_repository_branch_action', {
        roots,
        action: branchAction,
        branch: branchToRun,
      });
      if (active.current) setBranchResults(res);
      await loadBranches();
      await onChanged?.();
    } catch (e) {
      if (active.current) setError(String(e));
    } finally {
      gate.current = false;
      if (active.current) setBusy(false);
    }
  }

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
  const missingWorkspaceRoots = workspaceRoots.filter((r) => !roots.includes(r));
  return (
    <Modal title="多仓库" onClose={onClose} busy={busy} class="history-dialog workflow-dialog">
      <h2>多仓库同步、跨仓分支控制与聚合提交记录</h2>
      <div class="bisect-results">
        <button disabled={busy} aria-pressed={tab === 'sync'} onClick={() => setTab('sync')}>同步</button>
        <button disabled={busy} aria-pressed={tab === 'branches'} onClick={() => setTab('branches')}>跨仓库同步分支</button>
        <button disabled={busy} aria-pressed={tab === 'log'} onClick={() => setTab('log')}>提交记录</button>
      </div>
      <form class="modal-actions" onSubmit={event => { event.preventDefault(); addRoot(); }}>
        <input aria-label="添加仓库路径" value={newRoot} disabled={busy} onInput={event => setNewRoot(event.currentTarget.value)} placeholder="添加仓库绝对路径" />
        <button type="submit" disabled={busy || !newRoot.trim()}>添加仓库</button>
        {missingWorkspaceRoots.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => updateRoots([...new Set([...roots, ...workspaceRoots])])}
          >
            导入工作区全部仓库 (+{missingWorkspaceRoots.length})
          </button>
        )}
      </form>
      <p class="muted">列表中的 {roots.length} 个仓库参与同步和查询。移除只修改本窗口列表，不删除磁盘文件。</p>
      <div class="multi-repository-list">
        {roots.map(path => <div class="multi-repository-row" key={path}>
          <span class="repository-color" style={{ background: repoColor(path), display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginRight: 6 }} aria-hidden="true" />
          <span class="mono selectable" title={path}>{path}</span>
          <button aria-label={`移除仓库 ${path}`} disabled={busy} onClick={() => updateRoots(roots.filter(item => item !== path))}>移除</button>
        </div>)}
      </div>
      {tab === 'sync' && <div class="transport-form">
        <label>操作<select value={action} disabled={busy} onChange={event => setAction(event.currentTarget.value as typeof action)}><option value="fetch">Fetch</option><option value="pull">Pull</option><option value="push">Push</option></select></label>
        <button disabled={busy || !roots.length} onClick={() => void sync()}>执行到列表中的仓库</button>
        <div class="hunk-list">{result.map((line, index) => <pre key={index}>{line}</pre>)}</div>
      </div>}
      {tab === 'branches' && (
        <div class="transport-form">
          {loading && <p role="status">正在读取各仓库分支状态…</p>}
          <div class="hunk-list" aria-label="各仓库当前分支状态">
            {branchInfos.map((info) => (
              <section class="hunk-item" key={info.root} style={{ borderLeft: `4px solid ${repoColor(info.root)}` }}>
                <div>
                  <strong>{info.name}</strong> · 当前分支：<code>{info.currentBranch ?? 'Detached HEAD'}</code>{' '}
                  {info.dirty ? <span class="error-text">（有未提交更改）</span> : <span class="muted">（干净）</span>}
                </div>
                <small class="mono muted">{info.root}</small>
              </section>
            ))}
          </div>
          {sharedBranches.length > 0 && (
            <div class="modal-actions" aria-label="共有分支快捷选择">
              <span class="muted">点击选择分支：</span>
              {sharedBranches.slice(0, 16).map(([b, count]) => (
                <button
                  type="button"
                  key={b}
                  disabled={busy}
                  aria-pressed={targetBranchName === b}
                  onClick={() => {
                    targetBranchRef.current = b;
                    setTargetBranchName(b);
                  }}
                >
                  {b} ({count}/{branchInfos.length})
                </button>
              ))}
            </div>
          )}
          <div class="modal-actions">
            <label>
              批量分支操作
              <select
                aria-label="跨仓库分支操作类型"
                value={branchAction}
                disabled={busy}
                onChange={(event) =>
                  setBranchAction(event.currentTarget.value as 'checkout' | 'create' | 'delete')
                }
              >
                <option value="checkout">同步切换到同名分支 (Sync Checkout)</option>
                <option value="create">同步新建并切换分支 (Sync Create & Checkout)</option>
                <option value="delete">同步删除已合并本地分支 (Sync Delete -d)</option>
              </select>
            </label>
            <label>
              目标分支名称
              <input
                aria-label="跨仓库目标分支名"
                value={targetBranchName}
                disabled={busy}
                placeholder="例如 main 或 feature/release"
                onInput={(event) => {
                  targetBranchRef.current = event.currentTarget.value;
                  setTargetBranchName(event.currentTarget.value);
                }}
              />
            </label>
            <button
              type="button"
              class="primary"
              disabled={busy || !roots.length || !targetBranchName.trim()}
              onClick={() => void runBranchAction()}
            >
              批量执行分支操作
            </button>
          </div>
          {branchResults.length > 0 && (
            <div class="hunk-list" aria-label="跨仓库分支操作结果">
              {branchResults.map((line, index) => (
                <pre key={index}>{line}</pre>
              ))}
            </div>
          )}
        </div>
      )}
      {tab === 'log' && <>
        <form
          class="modal-actions"
          onSubmit={(event) => {
            event.preventDefault();
            void loadLog(logSearch, logBranch);
          }}
        >
          <input
            aria-label="搜索多仓库提交"
            value={logSearch}
            disabled={busy || loading}
            placeholder="搜索跨仓库提交说明…"
            onInput={(event) => setLogSearch(event.currentTarget.value)}
          />
          <input
            aria-label="筛选多仓库分支"
            value={logBranch}
            disabled={busy || loading}
            placeholder="限定分支或引用（留空全部）"
            onInput={(event) => setLogBranch(event.currentTarget.value)}
          />
          <button type="submit" disabled={busy || loading}>筛选日志</button>
        </form>
        {loading && <p role="status">正在读取提交记录…</p>}
        <div class="hunk-list">{commits.map(item => <section class="hunk-item" key={`${item.root}-${item.commit.hash}`} style={{ borderLeft: `4px solid ${repoColor(item.root)}` }}>
          <button class="multi-commit-row" disabled={busy || loading} aria-pressed={selectedCommit?.root === item.root && selectedCommit.commit.hash === item.commit.hash} onClick={() => { setSelectedCommit(item); setConfirmation(null); }}>
            <div>
              <span class="filter-chip" style={{ marginRight: 6 }}>
                <span class="repository-color" style={{ background: repoColor(item.root), display: 'inline-block', width: 8, height: 8, borderRadius: '50%' }} aria-hidden="true" />
                <strong>{item.name}</strong>
              </span>
              <code>{item.commit.hash.slice(0, 8)}</code> {item.commit.subject}
            </div>
            <small>{item.name} · {item.commit.author} · {new Date(item.commit.time * 1000).toLocaleString('zh-CN')}</small>
          </button>
        </section>)}</div>
        {!loading && !error && !commits.length && <p class="muted">暂无提交记录。</p>}
        {selectedCommit && <section class="confirmation">
          <p class="mono selectable">已选择 {selectedCommit.commit.hash.slice(0, 8)} · {selectedCommit.root}</p>
          {!canEdit && <p>此仓库不是当前打开的仓库。请先在主窗口打开它，再操作提交历史。</p>}
          <div class="modal-actions">
            {onOpenCommit && (
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => onOpenCommit(selectedCommit.root, selectedCommit.commit.hash)}
              >
                在主窗口打开并定位此提交
              </button>
            )}
            <button disabled={busy || loading || !canEdit} onClick={() => setConfirmation('extract')}>提取选中修改…</button>
            <button class="navigation-danger" disabled={busy || loading || !canEdit} onClick={() => setConfirmation('drop')}>删除选中提交…</button>
          </div>
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
