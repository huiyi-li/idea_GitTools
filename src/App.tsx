import { useEffect, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import {
  call,
  readSaved,
  save,
  staged,
  unstaged,
  type Change,
  type Branch,
  type HistoryAction,
  type Details,
  type DiffTarget,
  type LogPage,
  type Status,
} from './api';
import { DiffView } from './DiffView';
import { LogTable } from './LogTable';
import { RepositorySidebar } from './RepositorySidebar';
import { ActionMenu, FileIcon, Icon, Split, ToolButton } from './ui/controls';
import { HistoryDialog, historyLabels, type OperationPreview } from './HistoryDialog';
import { CompareView } from './CompareView';

const EMPTY_PAGE: LogPage = { commits: [], hasMore: false };
const MergeManager = lazy(() => import('./merge/MergeManager'));
type View = 'log' | 'changes';
type Dialog = { kind: 'branch' | 'stash'; value: string };

function ChangeList({
  changes,
  selected,
  onSelect,
  onStage,
  unstage,
  busy,
}: {
  changes: Change[];
  selected: string | undefined;
  onSelect: (change: Change) => void;
  onStage?: (changes: Change[], unstage: boolean) => void;
  unstage?: boolean;
  busy: boolean;
}) {
  return (
    <div class="file-list" role="list" aria-label="文件列表">
      {changes.map((change) => (
        <div
          class={`file-row ${selected === change.path ? 'selected' : ''}`}
          key={change.path}
          role="listitem"
        >
          <button
            class="file-select"
            onClick={() => onSelect(change)}
            title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
          >
            <span class={`file-status ${change.conflict ? 'conflict' : ''}`}>
              {change.conflict ? 'U' : change.index === ' ' ? change.workTree : change.index}
            </span>
            <FileIcon path={change.path} />
            <span class="file-name ellipsis">{change.path.split('/').pop()}</span>
            <span class="file-directory ellipsis">
              {change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''}
            </span>
          </button>
          {onStage && (
            <button
              class="file-action"
              disabled={busy || change.conflict}
              title={unstage ? '取消暂存' : '暂存此文件'}
              aria-label={`${unstage ? '取消暂存' : '暂存'} ${change.path}`}
              onClick={() => onStage([change], !!unstage)}
            >
              <Icon name={unstage ? 'general/remove' : 'general/add'} />
            </button>
          )}
        </div>
      ))}
      {!changes.length && <div class="empty small">暂无文件</div>}
    </div>
  );
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [recent, setRecent] = useState<string[]>(() => {
    const paths = readSaved<unknown>('recent', []);
    return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string').slice(0, 8) : [];
  });
  const [theme, setTheme] = useState(() => readSaved('theme', 'dark'));
  const [view, setView] = useState<View>('log');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0);
  const [page, setPage] = useState<LogPage>(EMPTY_PAGE);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [branch, setBranch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [operationDialog, setOperationDialog] = useState<OperationPreview | null>(null);
  const [comparisonBranch, setComparisonBranch] = useState<string | null>(null);
  const [showConsole, setShowConsole] = useState(false);
  const [mergePath, setMergePath] = useState<string | null>(null);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const gate = useRef(false);
  const pendingRefresh = useRef(false);
  const activeRoot = useRef('');
  const root = status?.repository.root ?? '';

  useEffect(() => {
    document.body.className = theme === 'light' ? 'ij-light' : 'ij-dark';
    save('theme', theme);
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    const subscription = listen<string>('git-console', (event) => {
      if (!disposed) setConsoleLines((lines) => [...lines, event.payload.slice(0, 4096)].slice(-120));
    });
    void subscription.catch((e) => {
      if (!disposed) setError(String(e));
    });
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  async function perform(label: string, job: () => Promise<void>) {
    if (gate.current) return false;
    gate.current = true;
    setBusy(label);
    if (label !== '刷新') {
      setError('');
      setNotice('');
    }
    try {
      await job();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      gate.current = false;
      setBusy('');
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        void perform('刷新', () => refresh());
      }
    }
  }

  async function openPath(path: string) {
    await perform('打开仓库', async () => {
      const next = await call<Status>('open_repository', { path });
      activeRoot.current = next.repository.root;
      setStatus(next);
      setPage(EMPTY_PAGE);
      setSelected(null);
      setDetails(null);
      setTarget(null);
      setMessage('');
      setOffset(0);
      setBranch('');
      setSearch('');
      setSearchInput('');
      setVersion((v) => v + 1);
      const paths = [next.repository.root, ...recent.filter((p) => p !== next.repository.root)].slice(0, 8);
      setRecent(paths);
      save('recent', paths);
    });
  }

  async function chooseRepository() {
    if (gate.current) return;
    try {
      const path = await open({ directory: true, multiple: false, title: '选择 Git 仓库' });
      if (typeof path === 'string') await openPath(path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function refresh(path = activeRoot.current, openConflicts = false) {
    if (!path) return;
    const next = await call<Status>('repository_status', { root: path });
    if (activeRoot.current === path) {
      setStatus(next);
      setVersion((v) => v + 1);
      if (openConflicts && next.changes.some((change) => change.conflict)) setMergePath('');
    }
  }

  async function mutate(
    command: string,
    args: Record<string, unknown>,
    label: string,
    openConflicts = false,
  ) {
    const path = activeRoot.current;
    if (!path) return false;
    return perform(label, async () => {
      try {
        const result = await call<unknown>(command, { root: path, ...args });
        setNotice(typeof result === 'string' && result ? result : `${label}完成`);
      } finally {
        // A failed hook, pull or stash apply can still change repository state.
        await refresh(path, openConflicts).catch((e) => setError(String(e)));
      }
    });
  }

  async function stageChanges(changes: Change[], unstage: boolean) {
    const paths = [
      ...new Set(
        changes.flatMap((change) => (change.oldPath ? [change.path, change.oldPath] : [change.path])),
      ),
    ];
    await mutate('stage_paths', { paths, unstage }, unstage ? '取消暂存' : '暂存');
  }

  async function commit() {
    const success = await mutate('create_commit', { message }, '提交');
    if (success) setMessage('');
  }

  function previewHistory(
    action: HistoryAction,
    target: { target: string; hash: string; label: string; parents?: string[] },
  ) {
    const repository = status?.repository;
    if (!repository?.head || !repository.branch || gate.current) return;
    setOperationDialog({
      request: {
        action,
        target: target.target,
        targetHash: target.hash,
        expectedHead: repository.head,
        expectedBranch: repository.branch,
        mergeMode: 'auto',
        mainline: null,
      },
      label: target.label,
      parents: target.parents ?? [],
    });
  }

  function branchAction(item: Branch, action: 'compare' | 'merge' | 'rebase') {
    if (action === 'compare') setComparisonBranch(item.full);
    else previewHistory(action, { target: item.full, hash: item.hash, label: item.name });
  }

  useEffect(() => {
    void call<string | null>('initial_repository')
      .then((path) => {
        if (path) return openPath(path);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let current = true;
    if (!root || view !== 'log') return;
    setLoadingLog(true);
    void call<LogPage>('read_log', { root, query: { offset, search, branch } })
      .then((next) => {
        if (!current) return;
        setPage(next);
        setSelected((hash) =>
          next.commits.some((c) => c.hash === hash) ? hash : (next.commits[0]?.hash ?? null),
        );
      })
      .catch((e) => {
        if (current) {
          setPage(EMPTY_PAGE);
          setSelected(null);
          setError(String(e));
        }
      })
      .finally(() => {
        if (current) setLoadingLog(false);
      });
    return () => {
      current = false;
    };
  }, [root, offset, search, branch, version, view]);

  useEffect(() => {
    let current = true;
    setDetails(null);
    if (view !== 'log') return;
    setTarget((value) => (value?.revision === selected ? value : null));
    if (!root || !selected) {
      setLoadingDetails(false);
      return;
    }
    setLoadingDetails(true);
    // Debounce keyboard navigation so that only the settled selection loads files.
    const timer = setTimeout(() => {
      void call<Details>('commit_details', { root, revision: selected })
        .then((next) => {
          if (!current) return;
          setDetails(next);
          setTarget((previous) => {
            const change =
              next.changes.find((c) => previous?.revision === selected && c.path === previous.path) ??
              next.changes[0];
            return change ? { path: change.path, oldPath: change.oldPath, revision: selected } : null;
          });
        })
        .catch((e) => {
          if (current) setError(String(e));
        })
        .finally(() => {
          if (current) setLoadingDetails(false);
        });
    }, 100);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [root, selected, version, view]);

  useEffect(() => {
    if (!root) return;
    let disposed = false;
    const subscription = listen<string>('repository-changed', (event) => {
      if (disposed || event.payload !== activeRoot.current) return;
      if (gate.current) pendingRefresh.current = true;
      else void perform('刷新', () => refresh());
    });
    void subscription.catch((e) => {
      if (!disposed) setError(String(e));
    });
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [root]);

  useEffect(() => {
    if (!root) return;
    let lastRefresh = 0;
    const focus = () => {
      if (gate.current || Date.now() - lastRefresh < 2000) return;
      lastRefresh = Date.now();
      void perform('刷新', () => refresh());
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [root]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (mergePath !== null || operationDialog || comparisonBranch !== null) return;
      if (event.key === 'F5') {
        event.preventDefault();
        if (root) void perform('刷新', () => refresh());
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void chooseRepository();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l' && view === 'log') {
        event.preventDefault();
        document.getElementById('text-filter')?.focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && view === 'changes' && message.trim()) {
        event.preventDefault();
        void commit();
      }
      if (event.key === 'Escape' && !gate.current) setDialog(null);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [root, view, message, mergePath, operationDialog, comparisonBranch]);

  function changeView(next: View) {
    setView(next);
    setTarget(null);
  }

  const stagedFiles = status?.changes.filter(staged) ?? [];
  const unstagedFiles = status?.changes.filter(unstaged) ?? [];
  const conflicts = status?.changes.filter((c) => c.conflict) ?? [];
  const selectedCommit = page.commits.find((commit) => commit.hash === selected);
  const historyDisabled =
    !!busy || !status?.repository.branch || status.repository.operation !== 'none' || !!status.changes.length;
  const showLocalDiff = (change: Change) =>
    setTarget({ path: change.path, oldPath: change.oldPath, revision: null });

  return (
    <div class="desktop-app">
      <header class="app-header">
        <div class="brand">
          <Icon name="toolwindows/vcs" />
          <strong>IdeaGitTool</strong>
        </div>
        <span class="header-divider" />
        <button
          class="repository-picker"
          onClick={() => void chooseRepository()}
          disabled={!!busy}
          title={root || '打开仓库 · Ctrl+O'}
        >
          <Icon name="nodes/folder" />
          <span class="ellipsis">{status?.repository.name ?? '打开仓库'}</span>
          <Icon name="general/chevronDown" />
        </button>
        {status && (
          <span class="current-branch-chip">
            <Icon name="dvcs/branchLabel" />
            <span class="ellipsis">
              {status.repository.branch ?? status.repository.head?.slice(0, 8) ?? '尚无提交'}
            </span>
          </span>
        )}
        <div class="header-actions">
          {(['fetch', 'pull', 'push'] as const).map((action) => (
            <ToolButton
              icon={action === 'fetch' ? 'vcs/fetch' : action === 'pull' ? 'vcs/update' : 'vcs/push'}
              label={action === 'fetch' ? 'Fetch' : action === 'pull' ? 'Pull · 仅快进拉取' : 'Push'}
              disabled={!root || !!busy}
              key={action}
              onClick={() => void mutate('remote_action', { action }, action)}
            >
              <span>{action === 'fetch' ? 'Fetch' : action === 'pull' ? 'Pull' : 'Push'}</span>
            </ToolButton>
          ))}
          <span class="toolbar-separator" />
          <ToolButton
            icon="general/refresh"
            label="刷新 · F5"
            disabled={!root || !!busy}
            onClick={() => void perform('刷新', () => refresh())}
          />
          <ToolButton
            icon="general/open"
            label="打开仓库 · Ctrl+O"
            disabled={!!busy}
            onClick={() => void chooseRepository()}
          />
          <ToolButton
            icon="general/settings"
            label="切换深浅色"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          />
        </div>
      </header>

      {error && (
        <div class="message error-message" role="alert">
          <span>{error}</span>
          <ToolButton icon="general/close" label="关闭错误" onClick={() => setError('')} />
        </div>
      )}
      {notice && (
        <div class="message notice-message" role="status">
          <span>{notice}</span>
          <ToolButton icon="general/close" label="关闭通知" onClick={() => setNotice('')} />
        </div>
      )}

      {!status ? (
        <main class="welcome">
          <div class="welcome-heading">
            <Icon name="toolwindows/vcs" />
            <h1>IdeaGitTool</h1>
          </div>
          <p>Git 工作区</p>
          <button class="primary" disabled={!!busy} onClick={() => void chooseRepository()}>
            <Icon name="general/open" />
            打开 Git 仓库
          </button>
          {!!recent.length && (
            <section class="recent">
              <h2>最近项目</h2>
              {recent.map((path) => (
                <button disabled={!!busy} key={path} title={path} onClick={() => void openPath(path)}>
                  <Icon name="nodes/folder" />
                  <span class="recent-path">
                    <strong>{path.replaceAll('\\', '/').split('/').pop()}</strong>
                    <span class="ellipsis muted">{path}</span>
                  </span>
                </button>
              ))}
            </section>
          )}
          <small>Ctrl+O 打开仓库</small>
        </main>
      ) : (
        <>
          <nav class="workspace-tabs" aria-label="Git 工作区">
            <span class="tool-window-title">Git</span>
            <button
              class={view === 'log' ? 'active' : ''}
              aria-pressed={view === 'log'}
              onClick={() => changeView('log')}
            >
              <Icon name="toolwindows/vcs" />
              日志
            </button>
            <button
              class={view === 'changes' ? 'active' : ''}
              aria-pressed={view === 'changes'}
              onClick={() => changeView('changes')}
            >
              <Icon name="toolwindows/commit" />
              提交<span class="count">{status.changes.length}</span>
            </button>
            <span class="spacer" />
            {(conflicts.length > 0 || status.repository.operation !== 'none') && (
              <button class="operation" disabled={!!busy} onClick={() => setMergePath('')}>
                <Icon name="vcs/merge" />
                {status.repository.operation === 'none' ? '处理冲突' : status.repository.operation}
                <span class="count">{conflicts.length}</span>
              </button>
            )}
          </nav>
          <div class="workspace">
            {view === 'log' ? (
              <Split key="log" storageKey="branches" initial={228} min={170} label="调整分支栏宽度">
                <RepositorySidebar
                  status={status}
                  branch={branch}
                  busy={!!busy}
                  recent={recent.filter((path) => path !== root)}
                  onFilter={(value) => {
                    setBranch(value);
                    setOffset(0);
                  }}
                  onCheckout={(value) => void mutate('checkout_branch', { branch: value }, '切换分支')}
                  onCreate={() => setDialog({ kind: 'branch', value: '' })}
                  onFetch={() => void mutate('remote_action', { action: 'fetch' }, 'Fetch')}
                  onStash={() => setDialog({ kind: 'stash', value: 'Work in progress' })}
                  onApplyStash={(hash) => void mutate('apply_stash', { hash }, '应用 Stash')}
                  onOpen={(path) => void openPath(path)}
                  onAction={branchAction}
                />
                <Split storageKey="details" initial={300} min={240} second label="调整提交详情宽度">
                  <Split
                    storageKey="log-diff"
                    initial={270}
                    min={130}
                    vertical
                    second
                    label="调整差异预览高度"
                  >
                    <section class="history-panel">
                      <div class="log-toolbar">
                        <label class="search-field">
                          <Icon name="general/search" />
                          <input
                            id="text-filter"
                            aria-label="搜索提交"
                            placeholder="搜索提交说明"
                            value={searchInput}
                            onInput={(event) => setSearchInput(event.currentTarget.value)}
                          />
                        </label>
                        <span class="filter-chip">
                          <Icon name="dvcs/branchLabel" />
                          <span class="ellipsis">
                            {branch ? branch.replace(/^refs\/(heads|remotes)\//, '') : '所有分支'}
                          </span>
                          {branch && (
                            <ToolButton
                              icon="general/close"
                              label="清除分支筛选"
                              onClick={() => {
                                setBranch('');
                                setOffset(0);
                              }}
                            />
                          )}
                        </span>
                      </div>
                      {loadingLog ? (
                        <div class="empty">正在加载提交…</div>
                      ) : (
                        <LogTable
                          commits={page.commits}
                          selected={selected}
                          onSelect={(commit) => setSelected(commit.hash)}
                        />
                      )}
                      <div class="pagination">
                        <span class="muted">
                          {page.commits.length ? offset + 1 + '–' + (offset + page.commits.length) : '0'}{' '}
                          条提交
                        </span>
                        <span class="spacer" />
                        <ToolButton
                          icon="general/up"
                          label="上一页提交"
                          disabled={!!busy || loadingLog || offset === 0}
                          onClick={() => setOffset(Math.max(0, offset - 200))}
                        />
                        <ToolButton
                          icon="general/down"
                          label="下一页提交"
                          disabled={!!busy || loadingLog || !page.hasMore}
                          onClick={() => setOffset(offset + 200)}
                        />
                      </div>
                    </section>
                    {mergePath === null ? (
                      <DiffView root={root} target={target} version={version} />
                    ) : (
                      <div />
                    )}
                  </Split>
                  <aside class="details-panel">
                    <div class="panel-heading">
                      <Icon name="vcs/changelist" />
                      <span>变更文件</span>
                      <span class="tree-hint">{details?.changes.length ?? 0}</span>
                      <span class="spacer" />
                      <ActionMenu label="提交操作" text="操作" disabled={!selectedCommit || !!busy}>
                        <button
                          disabled={historyDisabled}
                          title={status.changes.length ? '先提交或保存到 Stash' : ''}
                          onClick={() => {
                            if (selectedCommit)
                              previewHistory('cherry-pick', {
                                target: selectedCommit.hash,
                                hash: selectedCommit.hash,
                                label: selectedCommit.subject,
                                parents: selectedCommit.parents,
                              });
                          }}
                        >
                          Cherry-pick…
                        </button>
                        <button
                          disabled={historyDisabled}
                          title={status.changes.length ? '先提交或保存到 Stash' : ''}
                          onClick={() => {
                            if (selectedCommit)
                              previewHistory('revert', {
                                target: selectedCommit.hash,
                                hash: selectedCommit.hash,
                                label: selectedCommit.subject,
                                parents: selectedCommit.parents,
                              });
                          }}
                        >
                          Revert…
                        </button>
                      </ActionMenu>
                    </div>
                    {loadingDetails ? (
                      <div class="empty">正在读取…</div>
                    ) : details ? (
                      <>
                        <ChangeList
                          changes={details.changes}
                          selected={target?.path}
                          busy={!!busy}
                          onSelect={(change) =>
                            setTarget({
                              path: change.path,
                              oldPath: change.oldPath,
                              revision: details.commit.hash,
                            })
                          }
                        />
                        <section class="commit-details">
                          <div class="commit-detail-heading">
                            <Icon name="vcs/commit" />
                            <span class="mono">{details.commit.hash.slice(0, 8)}</span>
                          </div>
                          <strong>{details.commit.subject}</strong>
                          <p class="commit-body">{details.body}</p>
                          <div class="commit-author">
                            <span class="avatar">{details.commit.author.charAt(0).toUpperCase()}</span>
                            <span>
                              <span>{details.commit.author}</span>
                              <small>{details.commit.email}</small>
                            </span>
                          </div>
                          <span class="muted">
                            {new Date(details.commit.time * 1000).toLocaleString('zh-CN')}
                          </span>
                          <span class="mono commit-hash">{details.commit.hash}</span>
                        </section>
                      </>
                    ) : (
                      <div class="empty">选择一条提交查看文件</div>
                    )}
                  </aside>
                </Split>
              </Split>
            ) : (
              <Split key="commit" storageKey="commit" initial={340} min={270} label="调整提交面板宽度">
                <section class="changes-panel">
                  <div class="panel-heading">
                    <span>本地更改</span>
                    <span class="spacer" />
                    <ToolButton
                      icon="vcsimpl/stash"
                      label="保存到 Stash"
                      disabled={
                        !!busy || !status.changes.length || !status.repository.head || !!conflicts.length
                      }
                      onClick={() => setDialog({ kind: 'stash', value: 'Work in progress' })}
                    />
                  </div>
                  {!!conflicts.length && (
                    <div class="conflict-hint">
                      <Icon name="vcs/merge" />
                      <span>{conflicts.length} 个文件存在冲突</span>
                      <button disabled={!!busy} onClick={() => setMergePath('')}>
                        解决冲突…
                      </button>
                    </div>
                  )}
                  <div class="changes-files">
                    <details class="change-group" open>
                      <summary class="file-group-heading">
                        <Icon name="general/chevronRight" class="tree-chevron" />
                        <span>未暂存</span>
                        <span class="tree-hint">{unstagedFiles.length}</span>
                        <span class="spacer" />
                        <ToolButton
                          icon="general/add"
                          label="全部暂存"
                          disabled={!!busy || !unstagedFiles.length || !!conflicts.length}
                          onClick={(event) => {
                            event.preventDefault();
                            void stageChanges(unstagedFiles, false);
                          }}
                        />
                      </summary>
                      <ChangeList
                        changes={unstagedFiles}
                        selected={target?.path}
                        onSelect={(change) => {
                          if (change.conflict) setMergePath(change.path);
                          else showLocalDiff(change);
                        }}
                        onStage={(changes, unstage) => void stageChanges(changes, unstage)}
                        busy={!!busy}
                      />
                    </details>
                    <details class="change-group" open>
                      <summary class="file-group-heading">
                        <Icon name="general/chevronRight" class="tree-chevron" />
                        <span>已暂存</span>
                        <span class="tree-hint">{stagedFiles.length}</span>
                        <span class="spacer" />
                        <ToolButton
                          icon="general/remove"
                          label="全部取消暂存"
                          disabled={!!busy || !stagedFiles.length}
                          onClick={(event) => {
                            event.preventDefault();
                            void stageChanges(stagedFiles, true);
                          }}
                        />
                      </summary>
                      <ChangeList
                        changes={stagedFiles}
                        selected={target?.path}
                        onSelect={showLocalDiff}
                        onStage={(changes, unstage) => void stageChanges(changes, unstage)}
                        unstage
                        busy={!!busy}
                      />
                    </details>
                  </div>
                  <div class="commit-panel">
                    <label for="commit-message">提交说明</label>
                    <textarea
                      id="commit-message"
                      placeholder="提交说明"
                      value={message}
                      disabled={!!busy}
                      onInput={(event) => setMessage(event.currentTarget.value)}
                    />
                    <div class="commit-summary">
                      {stagedFiles.length} 个暂存文件
                      <span class="spacer" />
                      <span>Ctrl+Enter</span>
                    </div>
                    <button
                      class="primary"
                      disabled={!!busy || !stagedFiles.length || !message.trim() || !!conflicts.length}
                      onClick={() => void commit()}
                    >
                      <Icon name="vcs/commit" />
                      提交暂存内容
                    </button>
                  </div>
                </section>
                {mergePath === null ? <DiffView root={root} target={target} version={version} /> : <div />}
              </Split>
            )}
          </div>
        </>
      )}

      {showConsole && (
        <section class="console">
          <div class="panel-heading">
            <span>Console</span>
            <span class="spacer" />
            <button onClick={() => setConsoleLines([])}>清空</button>
            <ToolButton icon="general/close" label="关闭 Console" onClick={() => setShowConsole(false)} />
          </div>
          <pre class="selectable">{consoleLines.join('\n')}</pre>
        </section>
      )}
      <footer class="statusbar">
        <span class={busy ? 'busy' : ''}>
          <span class={'status-dot ' + (busy ? 'working' : '')} />
          {busy ? busy + '…' : '就绪'}
        </span>
        <span class="ellipsis" title={root}>
          {root || 'IdeaGitTool'}
        </span>
        <button class={showConsole ? 'active' : ''} onClick={() => setShowConsole(!showConsole)}>
          Console
        </button>
        <span>0.4.0</span>
      </footer>

      {mergePath !== null && (
        <Suspense fallback={<div class="merge-manager empty">正在加载合并编辑器…</div>}>
          <MergeManager
            root={root}
            initialPath={mergePath}
            onClose={() => {
              setMergePath(null);
              void perform('刷新', () => refresh());
            }}
          />
        </Suspense>
      )}

      {operationDialog && (
        <HistoryDialog
          preview={operationDialog}
          onClose={() => setOperationDialog(null)}
          onRun={(request) => {
            setOperationDialog(null);
            void mutate('start_history', { request }, historyLabels[request.action], true);
          }}
        />
      )}
      {comparisonBranch !== null && (
        <CompareView root={root} branch={comparisonBranch} onClose={() => setComparisonBranch(null)} />
      )}

      {dialog && (
        <div
          class="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setDialog(null);
          }}
        >
          <form
            class="modal"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                dialog.kind === 'branch' ? 'create_branch' : 'save_stash',
                dialog.kind === 'branch' ? { name: dialog.value } : { message: dialog.value },
                dialog.kind === 'branch' ? '创建分支' : '保存 Stash',
              ).then((success) => {
                if (success) setDialog(null);
              });
            }}
            role="dialog"
            aria-modal="true"
            aria-label={dialog.kind === 'branch' ? '新建分支' : '保存 Stash'}
          >
            <h2>{dialog.kind === 'branch' ? '新建并切换分支' : '保存到 Stash'}</h2>
            <label>
              {dialog.kind === 'branch' ? '分支名称' : '说明'}
              <input
                autoFocus
                value={dialog.value}
                disabled={!!busy}
                onInput={(e) => setDialog({ ...dialog, value: e.currentTarget.value })}
              />
            </label>
            {dialog.kind === 'stash' && <p class="muted">包含未跟踪文件，保存后清理工作区。</p>}
            {error && <p class="error-text">{error}</p>}
            <div class="modal-actions">
              <button type="button" disabled={!!busy} onClick={() => setDialog(null)}>
                取消
              </button>
              <button type="submit" class="primary" disabled={!!busy || !dialog.value.trim()}>
                {busy ? '处理中…' : '确定'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
