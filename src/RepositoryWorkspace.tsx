import { useEffect, useRef, useState } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-dialog';
import { call, readSaved } from './api';
import { ActionMenu, Modal, ToolButton } from './ui/controls';
import './workspace-tabs.css';

export interface WorkspaceRepository { root: string; name: string; relativePath: string }
export interface WorkspaceRepositories { root: string; repositories: WorkspaceRepository[]; truncated: boolean; warnings: string[] }

export function RepositoryWorkspaceDialog({ initialPath = '', autoScan = false, currentRoot, onClose, onOpen }: {
  initialPath?: string;
  autoScan?: boolean;
  currentRoot: string;
  onClose: () => void;
  onOpen: (workspace: WorkspaceRepositories, repository: WorkspaceRepository, depth: number) => Promise<boolean>;
}) {
  const savedPath = readSaved<unknown>('workspace.lastFolder', '');
  const savedDepth = readSaved<unknown>('workspace.scanDepth', 4);
  const [path, setPath] = useState(initialPath || (typeof savedPath === 'string' ? savedPath : ''));
  const [depth, setDepth] = useState(typeof savedDepth === 'number' && Number.isInteger(savedDepth) && savedDepth >= 0 && savedDepth <= 8 ? savedDepth : 4);
  const [result, setResult] = useState<WorkspaceRepositories>();
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const gate = useRef(false);
  const requestId = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; requestId.current++; }; }, []);
  const autoScanned = useRef(false);
  useEffect(() => {
    if (!autoScan || autoScanned.current || !initialPath.trim()) return;
    autoScanned.current = true;
    setPath(initialPath);
    void scan(initialPath);
  }, [autoScan, initialPath]);

  async function scan(folder = path) {
    if (gate.current || !folder.trim()) return;
    const request = ++requestId.current;
    gate.current = true; setLoading(true); setResult(undefined); setError('');
    try {
      const next = await call<WorkspaceRepositories>('discover_workspace', { path: folder.trim(), maxDepth: depth });
      if (active.current && request === requestId.current) setResult(next);
    } catch (error) { if (active.current && request === requestId.current) setError(String(error)); }
    finally { gate.current = false; if (active.current && request === requestId.current) setLoading(false); }
  }
  async function browse() {
    if (gate.current) return;
    gate.current = true; setLoading(true); setError('');
    try {
      const folder = await open({ directory: true, multiple: false, title: '选择包含多个 Git 仓库的工作区文件夹' });
      if (!active.current || typeof folder !== 'string') return;
      setPath(folder); gate.current = false;
      await scan(folder);
    } catch (error) { if (active.current) setError(String(error)); }
    finally { gate.current = false; if (active.current) setLoading(false); }
  }
  async function choose(repository: WorkspaceRepository) {
    if (!result || gate.current) return;
    gate.current = true; setOpening(true); setError('');
    try {
      const success = await onOpen(result, repository, depth);
      if (success) onClose();
      else if (active.current) setError('无法打开所选仓库。请检查路径并重新扫描，不会改为打开父仓库。');
    } catch (error) { if (active.current) setError(String(error)); }
    finally { gate.current = false; if (active.current) setOpening(false); }
  }
  const busy = loading || opening;
  return <Modal title="工作区仓库" class="utility-dialog repository-workspace-dialog" busy={opening} onClose={onClose}>
    <header class="utility-heading"><div><h2>工作区仓库</h2><p class="muted">发现文件夹中的独立仓库，选择一个仓库进行管理。</p></div><ToolButton icon="general/close" label="关闭工作区仓库" disabled={opening} onClick={onClose} /></header>
    <form class="transport-form workspace-scan-form" onSubmit={event => { event.preventDefault(); void scan(); }}>
      <label>工作区文件夹<input aria-label="工作区文件夹" value={path} disabled={busy} placeholder="例如 C:/projects" onInput={event => { setPath(event.currentTarget.value); setResult(undefined); }} /></label>
      <div class="workspace-scan-options"><label>扫描层级<select aria-label="工作区扫描层级" value={depth} disabled={busy} onChange={event => { setDepth(Number(event.currentTarget.value)); setResult(undefined); }}>{Array.from({ length: 9 }, (_, value) => <option key={value} value={value}>{value === 0 ? '仅当前目录' : `向下 ${value} 层`}</option>)}</select></label>
        <button type="button" disabled={busy} onClick={() => void browse()}>选择文件夹…</button><button type="submit" class="primary" disabled={busy || !path.trim()}>扫描仓库</button>
      </div>
    </form>
    <p class="muted">提交、暂存、Diff 和提交草稿按仓库隔离。扫描不会暂存、提交或修改任何仓库；不会跟随目录链接。</p>
    {loading && <p role="status">正在扫描工作区…</p>}
    {opening && <p role="status">正在打开所选仓库…</p>}
    {error && <p class="error-text" role="alert">{error}</p>}
    {result && <>
      <p class="utility-root mono selectable">{result.root}</p>
      <p>发现 {result.repositories.length} 个仓库，请明确选择一个。{result.truncated && '扫描未覆盖全部目录，请提高层级或选择更小的文件夹。'}</p>
      {!!result.warnings.length && <details class="utility-details"><summary>扫描提示 ({result.warnings.length})</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      {!result.repositories.length && <p class="utility-state">没有发现 Git 仓库。可调整扫描层级，或直接选择仓库根目录。</p>}
      <div class="workspace-repository-list" aria-label="发现的仓库">{result.repositories.map(repository => <button type="button" class="workspace-repository-item" key={repository.root} disabled={busy} aria-label={`管理仓库 ${repository.relativePath}`} onClick={() => void choose(repository)}>
        <span><strong>{repository.relativePath === '.' ? repository.name : repository.relativePath}</strong><small class="mono">{repository.root}</small></span><span>{repository.root === currentRoot ? '当前仓库' : '单独管理 →'}</span>
      </button>)}</div>
    </>}
    <footer class="modal-actions utility-actions"><button disabled={opening} onClick={onClose}>关闭</button></footer>
  </Modal>;
}

export interface WorkspaceRepositorySummary {
  branch: string | null;
  /** Unique changed paths, including staged paths; never add stagedFiles to this count. */
  changedFiles: number;
  stagedFiles: number;
  conflicts: number;
  error?: string;
  loading?: boolean;
}

type RepositorySummaries = Record<string, WorkspaceRepositorySummary>;

// Roots are canonical identities supplied by discovery. Do not reduce them to names,
// relative paths, or case-folded strings (case-sensitive filesystems must stay distinct).
function repositoryColor(root: string) {
  let hash = 2166136261;
  for (let index = 0; index < root.length; index++) hash = Math.imul(hash ^ root.charCodeAt(index), 16777619);
  return `hsl(${(hash >>> 0) % 360} 58% 56%)`;
}

function repositoryLabel(repository: WorkspaceRepository, duplicate: boolean) {
  if (repository.relativePath === '.') return `${repository.name}（根仓库）`;
  return duplicate ? `${repository.name} · ${repository.relativePath}` : repository.name;
}

function summaryText(summary?: WorkspaceRepositorySummary) {
  if (!summary) return '待读取';
  if (summary.loading) return '读取中…';
  if (summary.error) return '读取失败';
  return `${summary.branch ?? '游离 HEAD'} · ${summary.changedFiles === 0 ? '干净' : `${summary.changedFiles} 个变更`}${summary.conflicts > 0 ? ` · ${summary.conflicts} 个冲突` : ''}`;
}

function repositoryTooltip(repository: WorkspaceRepository, summary?: WorkspaceRepositorySummary) {
  return `${repository.root}\n相对路径：${repository.relativePath}\n${summaryText(summary)}${summary && !summary.loading && !summary.error ? `\n已暂存：${summary.stagedFiles} 个文件（包含在变更总数中）` : ''}${summary?.error ? `\n${summary.error}` : ''}`;
}

function RepositorySearch({ repositories, root, busy, summaries, onSelect }: {
  repositories: WorkspaceRepository[];
  root: string;
  busy: boolean;
  summaries?: RepositorySummaries;
  onSelect: (root: string) => void;
}) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const filtered = repositories.filter(repository => `${repository.name}\n${repository.relativePath}\n${repository.root}`.toLocaleLowerCase().includes(search));
  return <div class="repository-search" onKeyDown={event => {
    if ((event.target as HTMLElement).tagName === 'INPUT' || (event.key !== 'Home' && event.key !== 'End')) return;
    const items = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    event.preventDefault();
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
  }}>
    <input type="search" aria-label="搜索全部仓库" placeholder="搜索仓库名称或路径…" value={query} onInput={event => setQuery(event.currentTarget.value)} />
    <div class="repository-search-results" role="group" aria-label="匹配的仓库">
      {filtered.map(repository => <button type="button" key={repository.root} class="repository-search-item" aria-pressed={repository.root === root} disabled={busy}
        title={repositoryTooltip(repository, summaries?.[repository.root])} onClick={() => { if (!busy) onSelect(repository.root); }}>
        <span class="repository-color" style={{ background: repositoryColor(repository.root) }} aria-hidden="true" />
        <span class="repository-search-text"><strong>{repository.name}{repository.root === root ? ' · 当前' : ''}</strong><small>{repository.relativePath === '.' ? '根仓库' : repository.relativePath}</small><small>{summaryText(summaries?.[repository.root])}</small></span>
      </button>)}
      {!filtered.length && <p class="repository-search-empty" role="status">没有匹配的仓库</p>}
    </div>
  </div>;
}

export function WorkspaceRepositoryBar({ workspace, root, busy, summaries, onSelect, onManage, onClose }: {
  workspace: WorkspaceRepositories;
  root: string;
  busy: boolean;
  summaries?: RepositorySummaries;
  onSelect: (root: string) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedRoot, setFocusedRoot] = useState(root);
  const repositories = workspace.repositories;
  const selected = repositories.some(repository => repository.root === root);
  const names = new Map<string, number>();
  for (const repository of repositories) names.set(repository.name, (names.get(repository.name) ?? 0) + 1);
  const tabStop = repositories.some(repository => repository.root === focusedRoot)
    ? focusedRoot : selected ? root : repositories[0]?.root;
  useEffect(() => {
    setFocusedRoot(root);
    tabs.current.get(root)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [root, workspace]);

  function select(nextRoot: string) {
    if (!busy && nextRoot !== root) onSelect(nextRoot);
  }

  return <section class="workspace-repository-bar repository-tabs-bar" aria-label="工作区仓库切换" aria-busy={busy}>
    <div class="repository-tabs-heading">
      <strong class="repository-count">仓库 ({repositories.length})</strong>
      <span class="repository-workspace-path" title={workspace.root}>工作区：{workspace.root}</span>
      {workspace.truncated && <span class="repository-scan-warning" title="扫描未覆盖全部目录，可在管理中调整层级后重新扫描。">扫描未完整</span>}
      {!!workspace.warnings.length && <span class="repository-scan-warning" title={workspace.warnings.join('\n')}>扫描提示 ({workspace.warnings.length})</span>}
      <span class="repository-tabs-actions">
        <ActionMenu label={`全部仓库 (${repositories.length})`} text={`全部仓库 (${repositories.length})`} icon="nodes/folder" disabled={busy}>
          <RepositorySearch repositories={repositories} root={root} busy={busy} summaries={summaries} onSelect={select} />
        </ActionMenu>
        <button type="button" disabled={busy} onClick={() => { if (!busy) onManage(); }}>管理 / 重新扫描…</button>
        <ToolButton icon="general/close" label="关闭工作区列表（不删除仓库）" disabled={busy} onClick={() => { if (!busy) onClose(); }} />
      </span>
    </div>
    <div class="repository-tablist" role="tablist" aria-label={`工作区仓库，共 ${repositories.length} 个`} aria-orientation="horizontal">
      {repositories.map((repository, index) => {
        const summary = summaries?.[repository.root];
        const label = repositoryLabel(repository, (names.get(repository.name) ?? 0) > 1);
        return <button type="button" role="tab" key={repository.root} data-repository-root={repository.root} class="repository-tab" style={{ '--repository-color': repositoryColor(repository.root) }}
          ref={element => { if (element) tabs.current.set(repository.root, element); else tabs.current.delete(repository.root); }}
          aria-selected={repository.root === root} aria-disabled={busy} tabIndex={tabStop === repository.root ? 0 : -1}
          aria-label={`${label}，${summaryText(summary)}`} title={repositoryTooltip(repository, summary)}
          onFocus={() => setFocusedRoot(repository.root)} onClick={() => select(repository.root)} onKeyDown={event => {
            let next = index;
            if (event.key === 'ArrowRight') next = (index + 1) % repositories.length;
            else if (event.key === 'ArrowLeft') next = (index + repositories.length - 1) % repositories.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = repositories.length - 1;
            else return; // Native Enter / Space clicks activate; arrows only move focus.
            event.preventDefault();
            const button = tabs.current.get(repositories[next].root);
            button?.focus();
            button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
          }}>
          <span class="repository-tab-title"><span class="repository-color" aria-hidden="true" /><strong>{label}</strong></span>
          <span class={`repository-tab-summary${summary?.error ? ' has-error' : summary && !summary.loading && summary.conflicts > 0 ? ' has-conflicts' : ''}`}>{summaryText(summary)}</span>
        </button>;
      })}
    </div>
    {!selected && <p class="repository-unavailable" role="status" title={root}>{root ? `当前仓库不可用：${root}（不在此工作区列表中）。请选择仓库或重新扫描；不会自动切换。` : '尚未选择仓库。请明确选择一个仓库；不会自动切换。'}</p>}
    {!repositories.length && <p class="repository-empty">工作区没有可用仓库，请在管理中重新扫描。</p>}
  </section>;
}
