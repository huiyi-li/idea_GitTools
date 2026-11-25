import { useEffect, useRef, useState } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-dialog';
import { call, readSaved } from './api';
import { formatRepositoryTabLabel, type RepositoryTab, type WorkspaceMeta } from './state/repositoryTabs';
import { ActionMenu, Icon, Modal, ToolButton } from './ui/controls';
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
    <header class="utility-heading"><div><h2>工作区仓库</h2><p class="muted">发现文件夹中的独立仓库，选择仓库加入标签栏并切换管理。</p></div><ToolButton icon="general/close" label="关闭工作区仓库" disabled={opening} onClick={onClose} /></header>
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
        <span><strong>{repository.relativePath === '.' ? repository.name : repository.relativePath}</strong><small class="mono">{repository.root}</small></span><span>{repository.root === currentRoot ? '当前仓库' : '加入标签并管理 →'}</span>
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

function summaryText(summary?: WorkspaceRepositorySummary) {
  if (!summary) return '待读取';
  if (summary.loading) return '读取中…';
  if (summary.error) return '读取失败';
  return `${summary.branch ?? '游离 HEAD'} · ${summary.changedFiles === 0 ? '干净' : `${summary.changedFiles} 个变更`}${summary.conflicts > 0 ? ` · ${summary.conflicts} 个冲突` : ''}`;
}

function repositoryTooltip(tab: RepositoryTab, summary?: WorkspaceRepositorySummary) {
  const rel = tab.relativePath ? `\n相对路径：${tab.relativePath}` : '';
  return `${tab.root}${rel}\n${summaryText(summary)}${summary && !summary.loading && !summary.error ? `\n已暂存：${summary.stagedFiles} 个文件（包含在变更总数中）` : ''}${summary?.error ? `\n${summary.error}` : ''}`;
}

function RepositorySearch({
  tabs,
  root,
  busy,
  summaries,
  recent,
  onSelect,
  onOpenRecent,
  onCloseAllTabs,
}: {
  tabs: RepositoryTab[];
  root: string;
  busy: boolean;
  summaries?: RepositorySummaries;
  recent: string[];
  onSelect: (root: string) => void;
  onOpenRecent: (path: string) => void;
  onCloseAllTabs: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const filtered = tabs.filter(tab => `${tab.name}\n${tab.relativePath ?? ''}\n${tab.root}`.toLocaleLowerCase().includes(search));
  const openSet = new Set(tabs.map(tab => tab.root));
  const unopenedRecent = recent.filter(path => !openSet.has(path) && path.toLocaleLowerCase().includes(search));

  return <div class="repository-search" onKeyDown={event => {
    if ((event.target as HTMLElement).tagName === 'INPUT' || (event.key !== 'Home' && event.key !== 'End')) return;
    const items = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    event.preventDefault();
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
  }}>
    <input type="search" aria-label="搜索全部仓库" placeholder="搜索已打开或最近仓库…" value={query} onInput={event => setQuery(event.currentTarget.value)} />
    <div class="repository-search-results" role="group" aria-label="匹配的仓库">
      {filtered.map(tab => {
        const label = formatRepositoryTabLabel(tab, tabs);
        return <button type="button" key={tab.root} class="repository-search-item" aria-pressed={tab.root === root} disabled={busy}
          title={repositoryTooltip(tab, summaries?.[tab.root])} onClick={() => { if (!busy) onSelect(tab.root); }}>
          <span class="repository-color" style={{ background: repositoryColor(tab.root) }} aria-hidden="true" />
          <span class="repository-search-text">
            <strong>{label}{tab.root === root ? ' · 当前' : ''}</strong>
            <small class="mono">{tab.root}</small>
            <small>{summaryText(summaries?.[tab.root])}</small>
          </span>
        </button>;
      })}
      {!filtered.length && !unopenedRecent.length && <p class="repository-search-empty" role="status">没有匹配的仓库</p>}
      {!!unopenedRecent.length && <>
        <div class="menu-caption">最近打开（点击新开标签）</div>
        {unopenedRecent.slice(0, 6).map(path => {
          const name = path.replaceAll('\\', '/').split('/').filter(Boolean).pop() || path;
          return <button type="button" key={path} class="repository-search-item" disabled={busy} title={path} onClick={() => { if (!busy) onOpenRecent(path); }}>
            <span class="repository-color" style={{ background: repositoryColor(path) }} aria-hidden="true" />
            <span class="repository-search-text">
              <strong>{name}</strong>
              <small class="mono">{path}</small>
            </span>
          </button>;
        })}
      </>}
    </div>
    {!!tabs.length && <div class="repository-search-footer">
      <button type="button" class="repository-search-close-all" disabled={busy} onClick={() => { if (!busy) onCloseAllTabs(); }}>
        关闭全部标签
      </button>
    </div>}
  </div>;
}

export function WorkspaceRepositoryBar({
  tabs,
  workspaceMeta,
  root,
  busy,
  summaries,
  recent = [],
  onSelect,
  onAdd,
  onOpenRecent,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onReorderTabs,
  onManage,
  onMultiRepo,
}: {
  tabs: RepositoryTab[];
  workspaceMeta: WorkspaceMeta | null;
  root: string;
  busy: boolean;
  summaries?: RepositorySummaries;
  recent?: string[];
  onSelect: (root: string) => void;
  onAdd: () => void;
  onOpenRecent?: (path: string) => void;
  onCloseTab: (root: string) => void;
  onCloseOtherTabs: (root: string) => void;
  onCloseTabsToRight: (root: string) => void;
  onCloseAllTabs: () => void;
  onReorderTabs: (fromRoot: string, toRoot: string) => void;
  onManage: () => void;
  onMultiRepo?: () => void;
}) {
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusedRoot, setFocusedRoot] = useState(root);
  const [dragRoot, setDragRoot] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ root: string; x: number; y: number } | null>(null);

  const selected = tabs.some(tab => tab.root === root);
  const tabStop = tabs.some(tab => tab.root === focusedRoot)
    ? focusedRoot : selected ? root : tabs[0]?.root;

  useEffect(() => {
    setFocusedRoot(root);
    tabButtons.current.get(root)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [root, tabs]);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (event: Event) => {
      if (!(event.target as Element)?.closest('.repository-tab-context-menu')) {
        setContextMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  function select(nextRoot: string) {
    if (!busy && nextRoot !== root) onSelect(nextRoot);
  }

  const contextIndex = contextMenu ? tabs.findIndex(tab => tab.root === contextMenu.root) : -1;

  return <section class="workspace-repository-bar repository-tabs-bar" aria-label="多仓库标签栏" aria-busy={busy}>
    <div class="repository-tabs-strip">
      <div class="repository-tablist" role="tablist" aria-label={`已打开仓库，共 ${tabs.length} 个`} aria-orientation="horizontal">
        {tabs.map((tab, index) => {
          const summary = summaries?.[tab.root];
          const label = formatRepositoryTabLabel(tab, tabs);
          const isSelected = tab.root === root;
          const isDragOver = dragOverRoot === tab.root && dragRoot !== tab.root;
          return <div
            key={tab.root}
            class={`repository-tab-item${isSelected ? ' is-selected' : ''}${isDragOver ? ' is-drag-over' : ''}`}
            style={{ '--repository-color': repositoryColor(tab.root) }}
            draggable={!busy}
            onDragStart={event => {
              if (busy) return;
              setDragRoot(tab.root);
              event.dataTransfer?.setData('text/plain', tab.root);
            }}
            onDragOver={event => {
              if (!dragRoot || dragRoot === tab.root || busy) return;
              event.preventDefault();
              setDragOverRoot(tab.root);
            }}
            onDragLeave={() => {
              if (dragOverRoot === tab.root) setDragOverRoot(null);
            }}
            onDrop={event => {
              event.preventDefault();
              const source = dragRoot || event.dataTransfer?.getData('text/plain') || '';
              setDragRoot(null);
              setDragOverRoot(null);
              if (!busy && source && source !== tab.root) onReorderTabs(source, tab.root);
            }}
            onDragEnd={() => { setDragRoot(null); setDragOverRoot(null); }}
            onContextMenu={event => {
              event.preventDefault();
              if (busy) return;
              const x = Math.min(event.clientX, (window.innerWidth || 1000) - 190);
              const y = Math.min(event.clientY, (window.innerHeight || 700) - 200);
              setContextMenu({ root: tab.root, x, y });
            }}
          >
            <button
              type="button"
              role="tab"
              data-repository-root={tab.root}
              class="repository-tab"
              ref={element => { if (element) tabButtons.current.set(tab.root, element); else tabButtons.current.delete(tab.root); }}
              aria-selected={isSelected}
              aria-disabled={busy}
              tabIndex={tabStop === tab.root ? 0 : -1}
              aria-label={`${label}，${summaryText(summary)}`}
              title={repositoryTooltip(tab, summary)}
              onFocus={() => setFocusedRoot(tab.root)}
              onClick={() => select(tab.root)}
              onAuxClick={event => {
                if (event.button === 1 && !busy) {
                  event.preventDefault();
                  onCloseTab(tab.root);
                }
              }}
              onKeyDown={event => {
                let next = index;
                if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
                else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = tabs.length - 1;
                else return;
                event.preventDefault();
                const button = tabButtons.current.get(tabs[next].root);
                button?.focus();
                button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
              }}
            >
              <span class="repository-tab-title"><span class="repository-color" aria-hidden="true" /><strong>{label}</strong></span>
              <span class={`repository-tab-summary${summary?.error ? ' has-error' : summary && !summary.loading && summary.conflicts > 0 ? ' has-conflicts' : ''}`}>{summaryText(summary)}</span>
            </button>
            <button
              type="button"
              class="repository-tab-close"
              aria-label={`关闭仓库标签 ${label}`}
              title="关闭标签（不会删除本地仓库）"
              disabled={busy}
              onClick={event => {
                event.stopPropagation();
                if (!busy) onCloseTab(tab.root);
              }}
            >
              <Icon name="general/close" />
            </button>
          </div>;
        })}
        <ToolButton
          icon="general/add"
          class="repository-tab-add"
          label="新增仓库标签"
          disabled={busy}
          onClick={() => { if (!busy) onAdd(); }}
        />
      </div>
      <div class="repository-tabs-actions">
        {workspaceMeta?.truncated && <span class="repository-scan-warning" title="工作区扫描未覆盖全部目录，可在工作区扫描中调整层级。">扫描未完整</span>}
        {!!workspaceMeta?.warnings.length && <span class="repository-scan-warning" title={workspaceMeta.warnings.join('\n')}>扫描提示 ({workspaceMeta.warnings.length})</span>}
        <ActionMenu label={`全部仓库 (${tabs.length})`} text={`全部仓库 (${tabs.length})`} icon="nodes/folder" disabled={busy}>
          <RepositorySearch
            tabs={tabs}
            root={root}
            busy={busy}
            summaries={summaries}
            recent={recent}
            onSelect={select}
            onOpenRecent={path => onOpenRecent?.(path)}
            onCloseAllTabs={onCloseAllTabs}
          />
        </ActionMenu>
        {onMultiRepo && tabs.length > 1 && (
          <button type="button" disabled={busy} onClick={() => { if (!busy) onMultiRepo(); }}>
            跨仓同步…
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => { if (!busy) onManage(); }}>工作区…</button>
      </div>
    </div>
    {!selected && tabs.length > 0 && (
      <p class="repository-unavailable" role="status" title={root}>
        {root ? `当前仓库不可用：${root}。请选择其他标签或关闭失效标签；不会自动切换。` : '尚未激活仓库。请明确选择一个标签；不会自动切换。'}
      </p>
    )}
    {contextMenu && (
      <div
        class="action-popup repository-tab-context-menu"
        role="menu"
        aria-label="仓库标签操作"
        style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
      >
        <button type="button" role="menuitem" disabled={busy} onClick={() => { const target = contextMenu.root; setContextMenu(null); onCloseTab(target); }}>
          关闭标签
        </button>
        <button type="button" role="menuitem" disabled={busy || tabs.length <= 1} onClick={() => { const target = contextMenu.root; setContextMenu(null); onCloseOtherTabs(target); }}>
          关闭其他标签
        </button>
        <button type="button" role="menuitem" disabled={busy || contextIndex === -1 || contextIndex >= tabs.length - 1} onClick={() => { const target = contextMenu.root; setContextMenu(null); onCloseTabsToRight(target); }}>
          关闭右侧标签
        </button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => { setContextMenu(null); onCloseAllTabs(); }}>
          关闭全部标签
        </button>
        <hr />
        <button type="button" role="menuitem" onClick={() => {
          const target = contextMenu.root;
          setContextMenu(null);
          void navigator.clipboard?.writeText(target).catch(() => {});
        }}>
          复制仓库路径
        </button>
      </div>
    )}
  </section>;
}
