import { useEffect, useRef, useState } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import {
  call,
  readSaved,
  save,
  staged,
  unstaged,
  type Change,
  type Details,
  type DiffTarget,
  type LogPage,
  type Status,
} from './api';
import { DiffView } from './DiffView';
import { LogTable } from './LogTable';

const EMPTY_PAGE: LogPage = { commits: [], hasMore: false };
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
            <span class="ellipsis">{change.path}</span>
          </button>
          {onStage && (
            <button
              class="file-action"
              disabled={busy || change.conflict}
              title={unstage ? '取消暂存' : '暂存此文件'}
              aria-label={`${unstage ? '取消暂存' : '暂存'} ${change.path}`}
              onClick={() => onStage([change], !!unstage)}
            >
              {unstage ? '−' : '+'}
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
  const [showConsole, setShowConsole] = useState(false);
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

  async function refresh(path = activeRoot.current) {
    if (!path) return;
    const next = await call<Status>('repository_status', { root: path });
    if (activeRoot.current === path) {
      setStatus(next);
      setVersion((v) => v + 1);
    }
  }

  async function mutate(command: string, args: Record<string, unknown>, label: string) {
    const path = activeRoot.current;
    if (!path) return false;
    return perform(label, async () => {
      try {
        const result = await call<unknown>(command, { root: path, ...args });
        setNotice(typeof result === 'string' && result ? result : `${label}完成`);
      } finally {
        // A failed hook, pull or stash apply can still change repository state.
        await refresh(path).catch((e) => setError(String(e)));
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
      if (event.key === 'F5') {
        event.preventDefault();
        if (root) void perform('刷新', () => refresh());
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void chooseRepository();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && view === 'changes' && message.trim()) {
        event.preventDefault();
        void commit();
      }
      if (event.key === 'Escape' && !gate.current) setDialog(null);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [root, view, message]);

  function changeView(next: View) {
    setView(next);
    setTarget(null);
  }

  const stagedFiles = status?.changes.filter(staged) ?? [];
  const unstagedFiles = status?.changes.filter(unstaged) ?? [];
  const conflicts = status?.changes.filter((c) => c.conflict) ?? [];
  const showLocalDiff = (change: Change) =>
    setTarget({ path: change.path, oldPath: change.oldPath, revision: null });

  return (
    <div class="desktop-app">
      <header class="app-header">
        <div class="brand">
          <span class="brand-mark">⑂</span>
          <strong>IdeaGitTool</strong>
          <span class="build-label">Desktop</span>
        </div>
        <button onClick={() => void chooseRepository()} disabled={!!busy} title="打开仓库 · Ctrl+O">
          打开仓库
        </button>
        {status && (
          <span class="repo-title ellipsis" title={root}>
            {status.repository.name}
            <span class="branch-name">
              ⑂ {status.repository.branch ?? status.repository.head?.slice(0, 8) ?? '尚无提交'}
            </span>
          </span>
        )}
        <div class="header-actions">
          {(['fetch', 'pull', 'push'] as const).map((action) => (
            <button
              disabled={!root || !!busy}
              key={action}
              title={action === 'pull' ? '仅快进拉取（--ff-only）' : action}
              onClick={() => void mutate('remote_action', { action }, action)}
            >
              {action === 'fetch' ? 'Fetch' : action === 'pull' ? '↓ Pull' : '↑ Push'}
            </button>
          ))}
          <button
            disabled={!root || !!busy}
            onClick={() => void perform('刷新', () => refresh())}
            title="刷新 · F5"
          >
            ↻
          </button>
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="切换深浅色">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      {error && (
        <div class="message error-message" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')} aria-label="关闭错误">
            ×
          </button>
        </div>
      )}
      {notice && (
        <div class="message notice-message" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} aria-label="关闭通知">
            ×
          </button>
        </div>
      )}

      {!status ? (
        <main class="welcome">
          <span class="welcome-mark">⑂</span>
          <h1>IdeaGitTool</h1>
          <p>打开本地 Git 仓库，查看历史、比较修改和提交代码。</p>
          <button class="primary" disabled={!!busy} onClick={() => void chooseRepository()}>
            打开 Git 仓库
          </button>
          {!!recent.length && (
            <section class="recent">
              <h2>最近打开</h2>
              {recent.map((path) => (
                <button disabled={!!busy} key={path} title={path} onClick={() => void openPath(path)}>
                  <span>⑂</span>
                  <span class="ellipsis">{path}</span>
                </button>
              ))}
            </section>
          )}
          <small>快捷键 Ctrl+O 打开仓库 · F5 刷新</small>
        </main>
      ) : (
        <div class="workspace">
          <aside class="sidebar">
            <div class="panel-heading">
              <span>分支</span>
              <button
                disabled={!!busy}
                title="新建并切换分支"
                onClick={() => setDialog({ kind: 'branch', value: '' })}
              >
                ＋
              </button>
            </div>
            <button
              class={`branch-item ${branch === '' ? 'active' : ''}`}
              onClick={() => {
                setBranch('');
                setOffset(0);
                changeView('log');
              }}
            >
              所有分支
            </button>
            <div class="sidebar-scroll">
              {status.branches.map((item) => (
                <div class={`branch-line ${item.current ? 'current-branch' : ''}`} key={item.full}>
                  <button
                    class={`branch-item ellipsis ${branch === item.full ? 'active' : ''}`}
                    title={`${item.name}${item.upstream ? ` → ${item.upstream}` : ''}`}
                    onClick={() => {
                      setBranch(item.full);
                      setOffset(0);
                      changeView('log');
                    }}
                  >
                    <span class="branch-symbol">{item.remote ? '☁' : '⑂'}</span>
                    {item.name}
                    {item.current && ' ●'}
                  </button>
                  {!item.current && (
                    <button
                      class="checkout"
                      title={`签出 ${item.name}`}
                      disabled={!!busy}
                      onClick={() => void mutate('checkout_branch', { branch: item.full }, '切换分支')}
                    >
                      ↪
                    </button>
                  )}
                </div>
              ))}
              <div class="panel-heading sidebar-section">
                <span>Stash</span>
                <button
                  disabled={!!busy || !status.changes.length || !status.repository.head || !!conflicts.length}
                  title="暂存工作区到 Stash"
                  onClick={() => setDialog({ kind: 'stash', value: 'Work in progress' })}
                >
                  ＋
                </button>
              </div>
              {status.stashes.map((stash) => (
                <div class="stash-item" key={stash.hash}>
                  <div class="ellipsis" title={stash.message}>
                    {stash.message}
                  </div>
                  <button
                    disabled={!!busy}
                    onClick={() => void mutate('apply_stash', { hash: stash.hash }, '应用 Stash')}
                  >
                    应用并保留
                  </button>
                </div>
              ))}
              {!status.stashes.length && <div class="sidebar-hint">暂无 Stash</div>}
              {!!recent.filter((path) => path !== root).length && (
                <>
                  <div class="panel-heading sidebar-section">最近的仓库</div>
                  {recent
                    .filter((path) => path !== root)
                    .map((path) => (
                      <button
                        class="branch-item ellipsis"
                        key={path}
                        title={path}
                        disabled={!!busy}
                        onClick={() => void openPath(path)}
                      >
                        {path.split('/').pop()}
                      </button>
                    ))}
                </>
              )}
            </div>
          </aside>

          <main class="main-area">
            <nav class="tabs">
              <button class={view === 'log' ? 'active' : ''} onClick={() => changeView('log')}>
                Git 日志
              </button>
              <button class={view === 'changes' ? 'active' : ''} onClick={() => changeView('changes')}>
                工作区 <span class="badge">{status.changes.length}</span>
              </button>
              <span class="spacer" />
              {status.repository.operation !== 'none' && (
                <span class="operation">{status.repository.operation} 进行中</span>
              )}
            </nav>
            <div class="top-content">
              {view === 'log' ? (
                <>
                  <section class="history-panel">
                    <div class="log-toolbar">
                      <input
                        aria-label="搜索提交"
                        placeholder="搜索提交说明…"
                        value={searchInput}
                        onInput={(e) => setSearchInput(e.currentTarget.value)}
                      />
                      <span class="muted ellipsis">
                        {branch ? branch.replace(/^refs\/(heads|remotes)\//, '') : '所有分支'}
                      </span>
                    </div>
                    {loadingLog ? (
                      <div class="empty">正在加载提交…</div>
                    ) : (
                      <LogTable
                        commits={page.commits}
                        selected={selected}
                        onSelect={(c) => setSelected(c.hash)}
                      />
                    )}
                    <div class="pagination">
                      <button
                        disabled={!!busy || loadingLog || offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 200))}
                      >
                        上一页
                      </button>
                      <span>
                        {page.commits.length ? `${offset + 1}–${offset + page.commits.length}` : '0'} 条提交
                      </span>
                      <button
                        disabled={!!busy || loadingLog || !page.hasMore}
                        onClick={() => setOffset(offset + 200)}
                      >
                        下一页
                      </button>
                    </div>
                  </section>
                  <aside class="details-panel">
                    <div class="panel-heading">提交详情</div>
                    {loadingDetails ? (
                      <div class="empty">正在读取…</div>
                    ) : details ? (
                      <>
                        <div class="commit-details">
                          <strong>{details.commit.subject}</strong>
                          <span>
                            {details.commit.author} &lt;{details.commit.email}&gt;
                          </span>
                          <span class="mono selectable">{details.commit.hash}</span>
                          <p class="selectable">{details.body}</p>
                        </div>
                        <div class="panel-heading">
                          变更文件 <span class="muted">{details.changes.length}</span>
                        </div>
                        <ChangeList
                          changes={details.changes}
                          selected={target?.path}
                          busy={!!busy}
                          onSelect={(c) =>
                            setTarget({ path: c.path, oldPath: c.oldPath, revision: details.commit.hash })
                          }
                        />
                      </>
                    ) : (
                      <div class="empty">选择一条提交</div>
                    )}
                  </aside>
                </>
              ) : (
                <>
                  <section class="changes-panel">
                    <div class="panel-heading">
                      <span>未暂存</span>
                      <span class="muted">{unstagedFiles.length}</span>
                      <button
                        disabled={!!busy || !unstagedFiles.length || !!conflicts.length}
                        onClick={() => void stageChanges(unstagedFiles, false)}
                      >
                        全部暂存
                      </button>
                    </div>
                    {!!conflicts.length && (
                      <div class="conflict-hint">
                        存在 {conflicts.length} 个冲突文件。请在外部编辑器解决后，用下方按钮暂存。
                      </div>
                    )}
                    <ChangeList
                      changes={unstagedFiles}
                      selected={target?.path}
                      onSelect={showLocalDiff}
                      onStage={(changes, unstage) => void stageChanges(changes, unstage)}
                      busy={!!busy}
                    />
                    {!!conflicts.length && (
                      <button
                        class="resolve-stage"
                        disabled={!!busy}
                        onClick={() => void stageChanges(conflicts, false)}
                      >
                        暂存已手动解决的冲突文件
                      </button>
                    )}
                    <div class="panel-heading">
                      <span>已暂存</span>
                      <span class="muted">{stagedFiles.length}</span>
                      <button
                        disabled={!!busy || !stagedFiles.length}
                        onClick={() => void stageChanges(stagedFiles, true)}
                      >
                        全部取消暂存
                      </button>
                    </div>
                    <ChangeList
                      changes={stagedFiles}
                      selected={target?.path}
                      onSelect={showLocalDiff}
                      onStage={(changes, unstage) => void stageChanges(changes, unstage)}
                      unstage
                      busy={!!busy}
                    />
                  </section>
                  <aside class="commit-panel">
                    <div class="panel-heading">提交</div>
                    <label for="commit-message">提交说明</label>
                    <textarea
                      id="commit-message"
                      placeholder="描述本次修改…"
                      value={message}
                      disabled={!!busy}
                      onInput={(e) => setMessage(e.currentTarget.value)}
                    />
                    <div class="commit-summary">
                      {stagedFiles.length} 个暂存文件 · {status.repository.branch ?? 'Detached HEAD'}
                    </div>
                    <button
                      class="primary"
                      disabled={!!busy || !stagedFiles.length || !message.trim() || !!conflicts.length}
                      onClick={() => void commit()}
                    >
                      提交暂存内容
                    </button>
                    <small class="muted">Ctrl+Enter 提交 · Git hooks 与签名设置跟随仓库配置</small>
                  </aside>
                </>
              )}
            </div>
            <DiffView root={root} target={target} version={version} />
          </main>
        </div>
      )}

      {showConsole && (
        <section class="console">
          <div class="panel-heading">
            <span>Git Console</span>
            <button onClick={() => setConsoleLines([])}>清空</button>
            <button onClick={() => setShowConsole(false)}>×</button>
          </div>
          <pre class="selectable">{consoleLines.join('\n')}</pre>
        </section>
      )}
      <footer class="statusbar">
        <span class={busy ? 'busy' : ''}>{busy ? `${busy}…` : '就绪'}</span>
        <span class="ellipsis" title={root}>
          {root || 'Tauri + Rust'}
        </span>
        <button onClick={() => setShowConsole(!showConsole)}>Git Console</button>
        <span>0.1.0</span>
      </footer>

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
