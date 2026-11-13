import { useEffect, useRef, useState } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { open, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { UpdateManager, UPDATE_SESSION, readUpdateSession } from './UpdateManager';
import {
  call,
  readSaved,
  save,
  staged,
  unstaged,
  type Change,
  type Commit,
  type Branch,
  type HistoryAction,
  type HistoryRequest,
  type Details,
  type DiffTarget,
  type LogPage,
  type Status,
} from './api';
import { changeListPath, readChangeLists, writeChangeLists, type ChangeListGroup } from './changelists';
import { DiffView } from './DiffView';
import { CloneDialog } from './TransportDialog';
import { RemoteDialog, TransferDialog } from './RemoteDialog';
import { RepositoryManager } from './RepositoryManager';
import { WorktreeDialog } from './WorktreeDialog';
import { IgnoreDialog } from './IgnoreDialog';
import { HunkDialog, AmendDialog } from './HunkDialog';
import { InteractiveRebase } from './InteractiveRebase';
import { FileHistoryDialog } from './FileHistoryDialog';
import { LocalHistoryDialog } from './LocalHistoryDialog';
import { MultiRepositoryDialog } from './MultiRepositoryDialog';
import { DiscardDialog, type DiscardMode, type DiscardPreview } from './DiscardDialog';
import { LogTable } from './LogTable';
import { LogFilterPanel, EMPTY_FILTERS, type LogFilters } from './LogFilters';
import { RepositorySidebar, type BranchAction } from './RepositorySidebar';
import { BranchDialog } from './BranchDialog';
import { ActionMenu, FileIcon, Icon, Modal, Split, ToolButton } from './ui/controls';
import { HistoryDialog, historyLabels, type OperationPreview } from './HistoryDialog';
import { CompareView } from './CompareView';
import { NavigationDialog } from './navigation/NavigationDialog';
import { RecoveryDialog } from './navigation/RecoveryDialog';
import { DiagnosticsDialog } from './DiagnosticsDialog';
import { BisectDialog } from './BisectDialog';
import { SubmoduleDialog } from './SubmoduleDialog';
import type { NavigationAction, NavigationPreview, NavigationRequest, NavigationResult, OperationRecord, RecoveryOverview } from './navigation/types';
import './navigation/style.css';

const EMPTY_PAGE: LogPage = { commits: [], hasMore: false };
const MergeManager = lazy(() => import('./merge/MergeManager'));
const HostingView = lazy(() => import('./hosting/HostingView'));
const CommitReviewViewer = lazy(() => import('./review/CommitReviewViewer'));
type View = 'log' | 'changes';
type Dialog = { kind: 'branch' | 'stash' | 'shelf'; value: string };

function ChangeList({
  changes,
  selected,
  onSelect,
  onOpen,
  onStage,
  onHunks,
  onDiscard,
  onIgnore,
  onAssign,
  changeLists,
  unstage,
  busy,
}: {
  changes: Change[];
  selected: string | undefined;
  onSelect: (change: Change) => void;
  onOpen?: (change: Change) => void;
  onStage?: (changes: Change[], unstage: boolean) => void;
  onHunks?: (change: Change, area: 'staged' | 'unstaged') => void;
  onDiscard?: (changes: Change[], mode: DiscardMode) => void;
  onIgnore?: (path: string) => void;
  onAssign?: (change: Change) => void;
  changeLists?: ChangeListGroup[];
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
            onDblClick={() => { if (!busy) onOpen?.(change); }}
            onKeyDown={(event) => {
              if (onOpen && !busy && event.key === 'Enter') {
                event.preventDefault();
                onSelect(change);
                onOpen(change);
              }
            }}
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
              <span>{unstage ? '取消暂存' : '暂存'}</span>
            </button>
          )}
          {onDiscard && (
            <ActionMenu label={`文件操作 ${change.path}`} text="操作" disabled={busy || change.conflict}>
              {!unstage && (
                <button onClick={() => onDiscard([change], 'unstaged')}>放弃未暂存更改…</button>
              )}
              {unstage && <button onClick={() => onStage?.([change], true)}>取消暂存</button>}
              {onHunks && (
                <button onClick={() => onHunks(change, unstage ? 'staged' : 'unstaged')}>
                  {unstage ? '按块／按行取消暂存…' : '按块／按行暂存…'}
                </button>
              )}
              {onAssign && changeLists && <button onClick={() => onAssign(change)}>移动到 Changelist…</button>}
              <button onClick={() => onDiscard([change], 'all')}>放弃此文件全部更改…</button>
              {onIgnore && <button onClick={() => onIgnore(change.path)}>忽略规则／停止跟踪…</button>}
            </ActionMenu>
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
  const [discard, setDiscard] = useState<DiscardPreview | null>(null);
  const [discardError, setDiscardError] = useState('');
  const [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0);
  const [page, setPage] = useState<LogPage>(EMPTY_PAGE);
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [branch, setBranch] = useState('');
  const [logFilters, setLogFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [showLogFilters, setShowLogFilters] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [message, setMessage] = useState('');
  const [messageHistory, setMessageHistory] = useState<string[]>([]);
  const [changeLists, setChangeLists] = useState<ChangeListGroup[]>([]);
  const [activeChangeList, setActiveChangeList] = useState('');
  const [changeListTarget, setChangeListTarget] = useState<Change | null>(null);
  const [newChangeListName, setNewChangeListName] = useState('');
  const [newChangeListDialog, setNewChangeListDialog] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [operationDialog, setOperationDialog] = useState<OperationPreview | null>(null);
  const [navigation, setNavigation] = useState<{ preview: NavigationPreview; creating: boolean } | null>(null);
  const [navigationResult, setNavigationResult] = useState<NavigationResult | null>(null);
  const [navigationError, setNavigationError] = useState('');
  const [revisionInput, setRevisionInput] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryOverview | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [showRecovery, setShowRecovery] = useState(false);
  const [liveOperation, setLiveOperation] = useState<OperationRecord | null>(null);
  const [commitContext, setCommitContext] = useState<{ commit: Commit; x: number; y: number } | null>(null);
  const [comparisonBranch, setComparisonBranch] = useState<string | null>(null);
  const [showConsole, setShowConsole] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showBisect, setShowBisect] = useState(false);
  const [showSubmodules, setShowSubmodules] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [showHosting, setShowHosting] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [showRemotes, setShowRemotes] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [managerTab, setManagerTab] = useState<'branches' | 'tags' | 'stashes' | 'shelves'>('branches');
  const [managerStash, setManagerStash] = useState<Status['stashes'][number]>();
  const [branchDialog, setBranchDialog] = useState<{ branch: Branch; action: 'rename' | 'delete' } | null>(null);
  const [showWorktrees, setShowWorktrees] = useState(false);
  const [ignorePath, setIgnorePath] = useState<string | null>(null);
  const [hunks, setHunks] = useState<{ path: string; area: 'staged' | 'unstaged' } | null>(null);
  const [showAmend, setShowAmend] = useState(false);
  const [showInteractive, setShowInteractive] = useState(false);
  const [fileHistory, setFileHistory] = useState(false);
  const [localHistoryPath, setLocalHistoryPath] = useState<string | null>(null);
  const [showMultiRepository, setShowMultiRepository] = useState(false);
  const [transfer, setTransfer] = useState<'fetch' | 'pull' | 'push' | null>(null);
  const [diffPreview, setDiffPreview] = useState(() => readSaved<boolean>('log.diffPreview', false) === true);
  const [review, setReview] = useState<{ root: string; details: Details; path: string } | null>(null);
  const [mergePath, setMergePath] = useState<string | null>(null);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const gate = useRef(false);
  const updateInstallation = useRef(false);
  const pendingRefresh = useRef(false);
  const activeRoot = useRef('');
  const startupOpen = useRef(true);
  const root = status?.repository.root ?? '';

  useEffect(() => {
    document.body.className = theme === 'light' ? 'ij-light' : 'ij-dark';
    save('theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!root) {
      setChangeLists([]);
      setActiveChangeList('');
      return;
    }
    const next = readChangeLists(root);
    setChangeLists(next);
    setActiveChangeList((current) => next.some((list) => list.id === current) ? current : '');
    const savedMessages = readSaved<unknown>(`commit.messages.${root}`, []);
    setMessageHistory(Array.isArray(savedMessages) ? savedMessages.filter((item): item is string => typeof item === 'string').slice(0, 30) : []);
  }, [root]);

  useEffect(() => {
    try { save('log.diffPreview', diffPreview); } catch { /* Keep the session preference. */ }
  }, [diffPreview]);

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

  useEffect(() => {
    let disposed = false;
    const subscription = listen<OperationRecord>('git-operation', (event) => {
      if (!disposed) setLiveOperation(event.payload);
    });
    void subscription.catch(() => {});
    return () => { disposed = true; void subscription.then((stop) => stop()).catch(() => {}); };
  }, []);

  useEffect(() => {
    let current = true;
    if (!root) return;
    void call<RecoveryOverview>('recovery_overview', { root }).then((value) => {
      if (current && activeRoot.current === root) { setRecovery(value); setLiveOperation(null); setRecoveryError(''); }
    }).catch((e) => { if (current && activeRoot.current === root) setRecoveryError(String(e)); });
    return () => { current = false; };
  }, [root, version]);

  useEffect(() => {
    if (!commitContext) return;
    const close = (e: Event) => { if (!(e.target as Element)?.closest('.commit-context-menu')) setCommitContext(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setCommitContext(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [commitContext]);

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

  async function openPath(path?: string, waitForRefresh = false, initial = false) {
    if (!initial) startupOpen.current = false;
    while (waitForRefresh && gate.current) {
      pendingRefresh.current = false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return perform('打开仓库', async () => {
      // Keep the operation lock while the native dialog restores window focus.
      const selectedPath = path ?? await open({ directory: true, multiple: false, title: '选择 Git 仓库' });
      if (typeof selectedPath !== 'string') return;
      const next = await call<Status>('open_repository', { path: selectedPath });
      if (initial && !startupOpen.current) return;
      activeRoot.current = next.repository.root;
      setStatus(next);
      setPage(EMPTY_PAGE);
      setSelected(null);
      setDetails(null);
      setTarget(null);
      setMessage('');
      setChangeListTarget(null);
      setNewChangeListDialog(false);
      setNewChangeListName('');
      setOffset(0);
      setBranch('');
      setSearch('');
      setSearchInput('');
      setLogFilters(EMPTY_FILTERS);
      setShowLogFilters(false);
      setDialog(null);
      setOperationDialog(null);
      setDiscard(null);
      setDiscardError('');
      setNavigation(null);
      setNavigationResult(null);
      setRevisionInput(null);
      setRecovery(null);
      setRecoveryError('');
      setShowRecovery(false);
      setLiveOperation(null);
      setCommitContext(null);
      setComparisonBranch(null);
      setMergePath(null);
      setShowHosting(false);
      setShowWorktrees(false);
      setIgnorePath(null);
      setBranchDialog(null);
      setReview(null);
      setLocalHistoryPath(null);
      setVersion((v) => v + 1);
      const paths = [next.repository.root, ...recent.filter((p) => p !== next.repository.root)].slice(0, 8);
      setRecent(paths);
      save('recent', paths);
    });
  }

  function chooseRepository() {
    return openPath();
  }

  async function refresh(path = activeRoot.current, openConflicts = false) {
    if (!path) return;
    const next = await call<Status>('repository_status', { root: path });
    if (activeRoot.current === path) {
      setStatus(next);
      void Promise.allSettled(
        next.changes
          .filter((change) => !change.conflict && change.index !== 'D' && change.workTree !== 'D')
          .map((change) => call('local_history_capture', { root: path, path: change.path, reason: 'Git 工作区刷新' })),
      );
      setVersion((v) => v + 1);
      setTarget(previous => {
        if (!previous || previous.revision !== null) return previous;
        const matching = next.changes.filter((change) => change.path === previous.path);
        const change = matching.find((change) =>
          previous.area === 'staged' ? staged(change) : unstaged(change),
        ) ?? matching[0];
        if (!change) return null;
        let area = previous.area;
        if (area === 'unstaged' && !unstaged(change)) area = staged(change) ? 'staged' : undefined;
        if (area === 'staged' && !staged(change)) area = unstaged(change) ? 'unstaged' : undefined;
        return { ...previous, oldPath: change.oldPath, area };
      });
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
        changes.flatMap((change) => {
          if (change.oldPath && (change.index === 'R' || change.workTree === 'R')) {
            return [change.path, change.oldPath];
          }
          return [change.path];
        }),
      ),
    ];
    await mutate('stage_paths', { paths, unstage }, unstage ? '取消暂存' : '暂存');
  }

  async function previewDiscard(paths: string[], mode: DiscardMode) {
    const path = activeRoot.current;
    if (!path) return;
    await perform('读取放弃更改预览', async () => {
      const preview = await call<DiscardPreview>('preview_discard', { root: path, paths, mode });
      if (activeRoot.current !== path) return;
      setDiscard(preview);
      setDiscardError('');
    });
  }

  async function discardChanges() {
    if (!discard) return;
    const request = discard;
    await perform('放弃本地更改', async () => {
      try {
        await call('discard_changes', { root: request.root, request });
        setDiscard(null);
        setDiscardError('');
        setNotice(`已放弃 ${request.files.length} 个文件的${request.mode === 'unstaged' ? '未暂存' : '全部'}更改`);
      } catch (error) {
        setDiscardError(String(error));
      } finally {
        await refresh(request.root).catch(error => setError(String(error)));
      }
    });
  }

  function pathMatchesList(change: Change, list: ChangeListGroup | undefined) {
    return !list || changeListPath(change).some((path) => list.paths.includes(path));
  }

  function updateChangeLists(next: ChangeListGroup[]) {
    if (!root) return;
    setChangeLists(next);
    writeChangeLists(root, next);
  }

  function assignToChangeList(change: Change, listId: string) {
    const paths = changeListPath(change);
    const next = changeLists.map((list) => ({ ...list, paths: list.paths.filter((path) => !paths.includes(path)) }));
    if (listId) {
      const target = next.find((list) => list.id === listId);
      if (target) target.paths = [...new Set([...target.paths, ...paths])];
    }
    updateChangeLists(next);
    setChangeListTarget(null);
  }

  function createAndAssignChangeList(change: Change) {
    const name = newChangeListName.trim();
    if (!name) return;
    const list = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, paths: [] };
    updateChangeLists([...changeLists, list]);
    setNewChangeListName('');
    assignToChangeList(change, list.id);
  }

  async function commit(list?: ChangeListGroup, pushAfter = false) {
    const path = activeRoot.current;
    if (!path) return;
    const allStaged = status?.changes.filter(staged) ?? [];
    const selectedFiles = allStaged.filter((change) => pathMatchesList(change, list));
    if (!selectedFiles.length) return;
    const success = await perform('提交', async () => {
      const excluded = allStaged.filter((change) => !pathMatchesList(change, list));
      const excludedPaths = [...new Set(excluded.flatMap(changeListPath))];
      try {
        if (excludedPaths.length) await call('stage_paths', { root: path, paths: excludedPaths, unstage: true });
        await call('create_commit', { root: path, message });
        const nextMessages = [message.trim(), ...messageHistory.filter((item) => item !== message.trim())].slice(0, 30);
        setMessageHistory(nextMessages);
        save(`commit.messages.${path}`, nextMessages);
        setMessage('');
      } finally {
        if (excludedPaths.length) await call('stage_paths', { root: path, paths: excludedPaths, unstage: false }).catch(() => {});
        await refresh(path).catch((e) => setError(String(e)));
      }
    });
    if (success && pushAfter) setTransfer('push');
  }

  async function generateCommitMessage() {
    const path = activeRoot.current;
    if (!path) return;
    await perform('生成提交说明', async () => {
      const suggestion = await call<string>('generate_commit_message', { root: path });
      setMessage(suggestion);
    });
  }

  async function copyCommitRevision() {
    if (!commitContext) return;
    try {
      await navigator.clipboard.writeText(commitContext.commit.hash);
      setNotice('已复制提交 Revision');
    } catch (error) {
      setError(`复制 Revision 失败。${String(error)}`);
    }
    setCommitContext(null);
  }

  async function saveCommitPatch() {
    if (!commitContext || !root) return;
    const commit = commitContext.commit;
    await perform('生成 Patch', async () => {
      const subject = commit.subject.trim().replace(/[\\/:*?"<>|\r\n]+/g, '-').slice(0, 80) || commit.hash.slice(0, 8);
      const destination = await saveDialog({
        title: '保存 Patch',
        defaultPath: `${subject}.patch`,
        filters: [{ name: 'Patch', extensions: ['patch'] }],
      });
      if (!destination) return;
      await call('write_patch_file', { root, revision: commit.hash, destination });
      setNotice(`已保存 ${commit.hash.slice(0, 8)} 的 Patch`);
      setCommitContext(null);
    });
  }

  function previewHistory(
    action: HistoryAction,
    target: { target: string; hash: string; label: string; parents?: string[] },
    mergeMode: HistoryRequest['mergeMode'] = 'auto',
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
        mergeMode,
        mainline: null,
      },
      label: target.label,
      parents: target.parents ?? [],
    });
  }

  function branchAction(item: Branch, action: BranchAction) {
    if (action === 'compare') setComparisonBranch(item.full);
    else {
      const mode = action.startsWith('merge-') ? action.slice(6) as 'ff-only' | 'no-ff' | 'squash' : 'auto';
      previewHistory(action === 'rebase' ? 'rebase' : 'merge', { target: item.full, hash: item.hash, label: item.name }, mode);
    }
  }

  function openManager(tab: 'branches' | 'tags' | 'stashes' | 'shelves', stash?: Status['stashes'][number]) {
    setManagerTab(tab);
    setManagerStash(stash);
    setShowManager(true);
  }

  async function previewNavigation(target: string, action: NavigationAction = 'checkout', creating = false) {
    const path = activeRoot.current;
    if (!path) return;
    await perform('预览 Git 操作', async () => {
      const preview = await call<NavigationPreview>('preview_navigation', { root: path, target, action });
      if (activeRoot.current !== path) return;
      setNavigationResult(null);
      setNavigationError('');
      setNavigation({ preview, creating });
      setRevisionInput(null);
      setShowRecovery(false);
      setCommitContext(null);
    });
  }

  async function runNavigation(request: NavigationRequest) {
    const path = activeRoot.current;
    await perform(request.preview.action === 'reset' ? 'Reset' : '签出', async () => {
      setNavigationError('');
      try {
        const result = await call<NavigationResult>('execute_navigation', { root: path, request });
        setNavigationResult(result);
        if (result.completed) { setNavigation(null); setNotice(result.message); }
        else if (result.kind === 'restore') { setNavigation(null); setShowRecovery(true); setError(result.message); }
      } catch (e) { setNavigationError(String(e)); }
      finally { await refresh(path).catch((e) => setNavigationError(String(e))); }
    });
  }

  useEffect(() => {
    void call<string | null>('initial_repository')
      .then(async (path) => {
        const session = readUpdateSession();
        const next = path || session?.root;
        if (!startupOpen.current) return;
        if (next && await openPath(next, false, true)) {
          if (session && (!path || path === session.root)) setMessage(session.message);
          if (session) save(UPDATE_SESSION, null);
        }
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
    void call<LogPage>('read_log', { root, query: { offset, search, branch, ...logFilters } })
      .then((next) => {
        if (!current || activeRoot.current !== root) return;
        setPage(next);
        setSelected((hash) =>
          next.commits.some((c) => c.hash === hash) ? hash : (next.commits[0]?.hash ?? null),
        );
      })
      .catch((e) => {
        if (current && activeRoot.current === root) {
          setPage(EMPTY_PAGE);
          setSelected(null);
          setError(String(e));
        }
      })
      .finally(() => {
        if (current && activeRoot.current === root) setLoadingLog(false);
      });
    return () => {
      current = false;
    };
  }, [root, offset, search, branch, logFilters, version, view]);

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
          if (!current || activeRoot.current !== root) return;
          setDetails(next);
          setTarget((previous) => {
            const change =
              next.changes.find((c) => previous?.revision === selected && c.path === previous.path) ??
              next.changes[0];
            return change ? { path: change.path, oldPath: change.oldPath, revision: selected } : null;
          });
        })
        .catch((e) => {
          if (current && activeRoot.current === root) setError(String(e));
        })
        .finally(() => {
          if (current && activeRoot.current === root) setLoadingDetails(false);
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
      if (showUpdates) return;
      if (showHosting || showClone || showRemotes || showManager || showDiagnostics || showBisect || showSubmodules || branchDialog || showWorktrees || ignorePath !== null || transfer || hunks || showAmend || showInteractive || fileHistory || localHistoryPath !== null || showMultiRepository) return;
      if (mergePath !== null || operationDialog || discard || navigation || showRecovery || revisionInput !== null || comparisonBranch !== null || review) return;
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
  }, [root, view, message, mergePath, operationDialog, discard, navigation, showRecovery, revisionInput, comparisonBranch, showHosting, showClone, showRemotes, showManager, showDiagnostics, showBisect, showSubmodules, branchDialog, showWorktrees, ignorePath, transfer, hunks, showAmend, showInteractive, fileHistory, localHistoryPath, showMultiRepository, review, showUpdates]);

  function changeView(next: View) {
    setView(next);
    setTarget(null);
  }

  const activeList = changeLists.find((list) => list.id === activeChangeList);
  const stagedFiles = status?.changes.filter((change) => staged(change) && pathMatchesList(change, activeList)) ?? [];
  const unstagedFiles = status?.changes.filter((change) => unstaged(change) && pathMatchesList(change, activeList)) ?? [];
  const conflicts = status?.changes.filter((c) => c.conflict) ?? [];
  const selectedCommit = page.commits.find((commit) => commit.hash === selected);
  const historyDisabled =
    !!busy || !status?.repository.branch || status.repository.operation !== 'none' || !!status.changes.length;
  const showLocalDiff = (change: Change, area: 'staged' | 'unstaged' = 'unstaged') =>
    setTarget({ path: change.path, oldPath: change.oldPath, revision: null, area });

  return (
    <div class="desktop-app">
      <header class="app-header">
        <div class="brand">
          <Icon name="toolwindows/vcs" />
          <strong>IdeaGitTool</strong>
        </div>
        <span class="header-divider" />
        <div class="repository-switcher">
          <button
            class="repository-picker"
            aria-label="选择仓库文件夹"
            onClick={() => void chooseRepository()}
            disabled={!!busy}
            title={root || '打开仓库 · Ctrl+O'}
          >
            <Icon name="nodes/folder" />
            <span class="ellipsis">{status?.repository.name ?? '打开仓库'}</span>
          </button>
          <ActionMenu label="最近仓库" icon="general/chevronDown" disabled={!!busy}>
            <div class="menu-caption">最近仓库</div>
            {recent.map((path) => (
              <button
                key={path}
                aria-label={`打开最近仓库 ${path}`}
                disabled={path === root || !!busy}
                title={path}
                onClick={() => void openPath(path)}
              >
                <Icon name="nodes/folder" />
                <span class="recent-repository-label">
                  <strong class="ellipsis">{path.replaceAll('\\', '/').split('/').pop()}</strong>
                  <small class="ellipsis muted">{path}</small>
                </span>
                {path === root && <span class="muted">当前</span>}
              </button>
            ))}
            {!recent.length && <div class="menu-caption">暂无最近仓库</div>}
            <hr />
            <button disabled={!!busy} onClick={() => void chooseRepository()}>
              <Icon name="general/open" />
              打开其他仓库…
            </button>
          </ActionMenu>
        </div>
        {status && (
          <span class="current-branch-chip">
            <Icon name="dvcs/branchLabel" />
            <span class="ellipsis">
              {status.repository.branch ?? status.repository.head?.slice(0, 8) ?? '尚无提交'}
            </span>
          </span>
        )}
        <div class="header-actions">
          <ActionMenu label="仓库工具" text="仓库" disabled={!root || !!busy}>
            <button onClick={() => setShowRemotes(true)}>管理远程仓库</button>
            <button onClick={() => openManager('branches')}>分支、标签与 Stash</button>
            <button onClick={() => openManager('stashes')}>储藏管理</button>
            <button onClick={() => openManager('shelves')}>Shelf 管理</button>
            <button onClick={() => setShowWorktrees(true)}>Worktree 管理</button>
            <button onClick={() => setIgnorePath('')}>忽略规则管理</button>
            <button onClick={() => setShowInteractive(true)}>交互式 Rebase</button>
            <button onClick={() => setFileHistory(true)}>文件历史与 Blame</button>
            <button onClick={() => setLocalHistoryPath('')}>Local History</button>
            <button onClick={() => setShowMultiRepository(true)}>多仓库同步与提交图</button>
            <button onClick={() => setShowDiagnostics(true)}>Git 诊断</button>
            <button onClick={() => setShowBisect(true)}>Bisect</button>
            <button onClick={() => setShowSubmodules(true)}>Submodule 管理</button>
          </ActionMenu>
          <ToolButton
            icon="general/add"
            label="克隆仓库"
            disabled={!!busy}
            onClick={() => setShowClone(true)}
          >
            <span>克隆</span>
          </ToolButton>
          <ToolButton icon="vcs/update" label="签出标签或提交 SHA" disabled={!root || !!busy} onClick={() => setRevisionInput('')} />
          <ToolButton icon="toolwindows/vcs" label="操作恢复与 Reflog" disabled={!root || !!busy} onClick={() => setShowRecovery(true)}><span>Reflog</span></ToolButton>
          <ToolButton
            icon="toolwindows/vcs"
            label="托管平台 · GitHub / GitLab"
            active={showHosting}
            onClick={() => setShowHosting(!showHosting)}
          >
            <span>托管平台</span>
          </ToolButton>
          {(['fetch', 'pull', 'push'] as const).map((action) => (
            <ToolButton
              icon={action === 'fetch' ? 'vcs/fetch' : action === 'pull' ? 'vcs/update' : 'vcs/push'}
              label={action === 'fetch' ? 'Fetch' : action === 'pull' ? 'Pull · 仅快进或 Rebase' : 'Push'}
              disabled={!root || !!busy}
              key={action}
              onClick={() => setTransfer(action)}
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

      {showHosting ? (
        <Suspense fallback={<div class="empty">正在加载托管平台…</div>}>
          <HostingView
            localRoot={root}
            onClose={() => setShowHosting(false)}
            onOpen={async (path) => {
              if (await openPath(path, true)) setShowHosting(false);
            }}
          />
        </Suspense>
      ) : !status ? (
        <main class="welcome">
          <div class="welcome-heading">
            <Icon name="toolwindows/vcs" />
            <h1>IdeaGitTool</h1>
          </div>
          <p>Git 工作区</p>
          <button disabled={!!busy} onClick={() => setShowClone(true)}>克隆远程仓库</button>
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
          {(liveOperation || recovery?.operation !== 'none' && recovery?.operation || recovery?.records.some((r) => !['completed', 'failed-restored'].includes(r.phase) && (r.stashSha || r.phase === 'interrupted'))) && <div class="navigation-operation-bar" role="status">
            <span>{liveOperation ? `${liveOperation.action} · ${liveOperation.phase}` : recovery?.operation !== 'none' ? `${recovery?.operation} · ${recovery?.progress ?? ''} · ${recovery?.reason}` : '本地修改备份或中断操作可恢复'}</span>
            {recovery?.current && <span class="mono">{recovery.current.slice(0, 8)}</span>}
            <span class="spacer" /><button disabled={!!busy} onClick={() => setShowRecovery(true)}>查看操作恢复</button>
          </div>}
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
                  onCheckout={(value) => void previewNavigation(value)}
                  onCreate={(item) => {
                    if (status.repository.head) void previewNavigation(item?.full ?? 'HEAD', 'checkout', true);
                    else setDialog({ kind: 'branch', value: '' });
                  }}
                  onManage={() => openManager('branches')}
                  onEdit={(branch, action) => setBranchDialog({ branch, action })}
                  onFetch={() => setTransfer('fetch')}
                  onStash={() => setDialog({ kind: 'stash', value: 'Work in progress' })}
                  onApplyStash={(stash, pop) => void mutate('edit_stash', { expected: status.stashes, request: {
                    action: pop ? 'pop' : 'apply', hash: stash.hash, reference: stash.reference,
                    message: '', keepIndex: false, includeUntracked: false, paths: [],
                  } }, pop ? '弹出储藏' : '应用储藏', true)}
                  onManageStash={(stash) => openManager('stashes', stash)}
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
                    hideSecond={!diffPreview}
                  >
                    <section class="history-panel">
                      <div class="log-toolbar">
                        <label class="log-preview-toggle">
                          <input type="checkbox" checked={diffPreview} onChange={(event) => setDiffPreview(event.currentTarget.checked)} />
                          显示 diff 预览
                        </label>
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
                        <button aria-expanded={showLogFilters} onClick={() => setShowLogFilters(!showLogFilters)}>
                          高级筛选{Object.entries(logFilters).some(([key, value]) => key === 'merge' ? value !== 'all' : Boolean(value)) ? ' · 已启用' : ''}
                        </button>
                      </div>
                      {showLogFilters && <LogFilterPanel key={root} root={root} filters={logFilters} search={searchInput} branch={branch}
                        onApply={(filters, text, branch) => {
                          setLogFilters(filters);
                          setSearchInput(text);
                          setSearch(text);
                          setBranch(branch);
                          setOffset(0);
                        }} />}
                      {loadingLog ? (
                        <div class="empty">正在加载提交…</div>
                      ) : (
                        <LogTable
                          commits={page.commits}
                          selected={selected}
                          onSelect={(commit) => setSelected(commit.hash)}
                          onContextMenu={(commit, x, y) => { setSelected(commit.hash); setCommitContext({ commit, x, y }); }}
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
                    {diffPreview && mergePath === null && !review ? (
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
                        <button disabled={status.repository.operation !== 'none'} onClick={() => selectedCommit && void previewNavigation(selectedCommit.hash)}>签出此提交…</button>
                        <button disabled={status.repository.operation !== 'none'} onClick={() => selectedCommit && void previewNavigation(selectedCommit.hash, 'checkout', true)}>从此提交创建分支…</button>
                        <button disabled={!status.repository.branch || status.repository.operation !== 'none'} onClick={() => selectedCommit && void previewNavigation(selectedCommit.hash, 'reset')}>重置当前分支到此提交…</button>
                        <hr />
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
                          onOpen={(change) => setReview({ root, details, path: change.path })}
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
                    <label class="change-list-filter">
                      Changelist
                      <select
                        aria-label="选择 Changelist"
                        disabled={!!busy}
                        value={activeChangeList}
                        onChange={(event) => setActiveChangeList(event.currentTarget.value)}
                      >
                        <option value="">全部更改</option>
                        {changeLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
                      </select>
                    </label>
                    <button disabled={!!busy} onClick={() => { setNewChangeListName(''); setChangeListTarget(null); setNewChangeListDialog(true); }}>新建 Changelist</button>
                    <span class="spacer" />
                    <ActionMenu label="本地更改操作" text="操作" disabled={!!busy || !status.changes.length || !!conflicts.length}>
                      <button onClick={() => void previewDiscard(status.changes.map(change => change.path), 'all')}>放弃全部本地更改…</button>
                    </ActionMenu>
                    <ToolButton
                      icon="vcsimpl/stash"
                      label="保存到 Stash"
                      disabled={
                        !!busy || !status.changes.length || !status.repository.head || !!conflicts.length
                      }
                      onClick={() => setDialog({ kind: 'stash', value: 'Work in progress' })}
                    />
                    <ToolButton
                      icon="vcsimpl/stash"
                      label="保存到 Shelf"
                      disabled={!!busy || !status.changes.length || !status.repository.head || !!conflicts.length}
                      onClick={() => setDialog({ kind: 'shelf', value: 'Work in progress' })}
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
                        >暂存</ToolButton>
                        <button
                          disabled={!!busy || !unstagedFiles.length || !!conflicts.length}
                          onClick={(event) => {
                            event.preventDefault();
                            void previewDiscard(unstagedFiles.map(change => change.path), 'unstaged');
                          }}
                        >全部放弃…</button>
                      </summary>
                      <ChangeList
                        changes={unstagedFiles}
                        selected={target?.area === 'unstaged' ? target.path : undefined}
                        onSelect={(change) => {
                          if (change.conflict) setMergePath(change.path);
                          else showLocalDiff(change);
                        }}
                        onStage={(changes, unstage) => void stageChanges(changes, unstage)}
                        onDiscard={(changes, mode) => void previewDiscard(changes.map(change => change.path), mode)}
                        onHunks={(change, area) => setHunks({ path: change.path, area })}
                        onIgnore={setIgnorePath}
                        onAssign={(change) => setChangeListTarget(change)}
                        changeLists={changeLists}
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
                        >取消暂存</ToolButton>
                      </summary>
                      <ChangeList
                        changes={stagedFiles}
                        selected={target?.area === 'staged' ? target.path : undefined}
                        onSelect={(change) => showLocalDiff(change, 'staged')}
                        onStage={(changes, unstage) => void stageChanges(changes, unstage)}
                        onDiscard={(changes, mode) => void previewDiscard(changes.map(change => change.path), mode)}
                        onHunks={(change, area) => setHunks({ path: change.path, area })}
                        onIgnore={setIgnorePath}
                        onAssign={(change) => setChangeListTarget(change)}
                        changeLists={changeLists}
                        unstage
                        busy={!!busy}
                      />
                    </details>
                  </div>
                  <div class="commit-panel">
                    <label for="commit-message">提交说明</label>
                    <label class="commit-history-field">
                      提交说明历史
                      <select
                        aria-label="提交说明历史"
                        disabled={!!busy || !messageHistory.length}
                        value=""
                        onChange={(event) => {
                          if (event.currentTarget.value) setMessage(event.currentTarget.value);
                        }}
                      >
                        <option value="">选择历史说明</option>
                        {messageHistory.map((item, index) => <option key={`${item}-${index}`} value={item}>{item}</option>)}
                      </select>
                    </label>
                    <button type="button" disabled={!!busy || !stagedFiles.length} onClick={() => void generateCommitMessage()}>AI 提交说明</button>
                    <button disabled={!!busy || !status.repository.head || !['none', 'rebase'].includes(status.repository.operation)} onClick={() => setShowAmend(true)}>Amend 最近提交…</button>
                    <textarea
                      id="commit-message"
                      placeholder="提交说明"
                      value={message}
                      disabled={!!busy}
                      onInput={(event) => setMessage(event.currentTarget.value)}
                    />
                    <div class="commit-summary">
                      {stagedFiles.length} 个暂存文件{activeList ? ` · ${activeList.name}` : ''}
                      <span class="spacer" />
                      <span>Ctrl+Enter</span>
                    </div>
                    <button
                      class="primary"
                      disabled={!!busy || !stagedFiles.length || !message.trim() || !!conflicts.length}
                      onClick={() => void commit(activeList)}
                    >
                      <Icon name="vcs/commit" />
                      {activeList ? `提交 ${activeList.name}` : '提交暂存内容'}
                    </button>
                    <button
                      type="button"
                      disabled={!!busy || !stagedFiles.length || !message.trim() || !!conflicts.length}
                      onClick={() => void commit(activeList, true)}
                    >
                      提交并推送
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
        <UpdateManager open={showUpdates} onOpenChange={setShowUpdates}
          blocked={busy ? `正在${busy}，完成后可安装更新。` :
            (showHosting || showClone || showRemotes || showManager || showDiagnostics || showBisect || showSubmodules || branchDialog || showWorktrees || ignorePath !== null ||
              transfer || hunks || showAmend || showInteractive || fileHistory || localHistoryPath !== null || showMultiRepository || mergePath !== null || review ||
              dialog || operationDialog || discard || navigation || showRecovery || revisionInput !== null || comparisonBranch !== null)
              ? '请先完成并关闭当前操作窗口，再安装更新。' : ''}
          beforeInstall={() => {
            if (gate.current) throw new Error('Git 操作正在运行，请稍后重试。');
            save(UPDATE_SESSION, { root: activeRoot.current, message, savedAt: Date.now() });
            updateInstallation.current = true;
            gate.current = true;
            setBusy('安装更新');
          }}
          onInstallFailed={() => {
            if (!updateInstallation.current) return;
            updateInstallation.current = false;
            gate.current = false;
            setBusy('');
            save(UPDATE_SESSION, null);
            if (pendingRefresh.current) {
              pendingRefresh.current = false;
              void perform('刷新', () => refresh());
            }
          }} />
      </footer>
      {showClone && <CloneDialog onOpen={(path) => openPath(path, true)} onClose={() => setShowClone(false)} />}
      {showRemotes && root && <RemoteDialog key={root} root={root} onClose={() => setShowRemotes(false)} onChanged={() => refresh(root)} />}
      {showDiagnostics && root && <DiagnosticsDialog key={root} root={root} onClose={() => setShowDiagnostics(false)} />}
      {showBisect && root && <BisectDialog key={root} root={root} onClose={() => setShowBisect(false)} onChanged={() => refresh(root, true)} />}
      {showSubmodules && root && <SubmoduleDialog key={root} root={root} onClose={() => setShowSubmodules(false)} onChanged={() => refresh(root, true)} />}
      {showManager && root && <RepositoryManager key={`${root}-${managerTab}-${managerStash?.reference ?? ''}-${managerStash?.hash ?? ''}`} root={root}
        initialTab={managerTab} initialStash={managerStash} version={version} onClose={() => setShowManager(false)} onChanged={openConflicts => refresh(root, openConflicts)} />}
      {branchDialog && root && <BranchDialog key={`${root}-${branchDialog.branch.full}-${branchDialog.action}`} root={root} initialBranch={branchDialog.branch} action={branchDialog.action}
        onClose={() => setBranchDialog(null)} onOpen={path => openPath(path, true)} onChanged={async renamed => {
          if (branch === branchDialog.branch.full) { setBranch(renamed ?? ''); setOffset(0); }
          await refresh(root);
        }} />}
      {showWorktrees && root && <WorktreeDialog key={root} root={root} onClose={() => setShowWorktrees(false)} onChanged={() => refresh(root)} onOpen={path => openPath(path, true)} />}
      {ignorePath !== null && root && <IgnoreDialog key={root} root={root} initialPath={ignorePath} onClose={() => setIgnorePath(null)} onChanged={() => refresh(root)} />}
      {hunks && root && <HunkDialog key={`${root}-${hunks.path}-${hunks.area}`} root={root} {...hunks} onClose={() => setHunks(null)} onChanged={() => refresh(root)} />}
      {showAmend && root && <AmendDialog key={root} root={root} onClose={() => setShowAmend(false)} onChanged={() => refresh(root)} />}
      {showInteractive && root && <InteractiveRebase key={root} root={root} onClose={() => setShowInteractive(false)} onChanged={() => refresh(root, true)} />}
      {fileHistory && root && <FileHistoryDialog key={root} root={root} initialPath={target?.path ?? ''} initialRevision={target?.revision} onClose={() => setFileHistory(false)} />}
      {localHistoryPath !== null && root && <LocalHistoryDialog key={`${root}-${localHistoryPath}`} root={root} initialPath={localHistoryPath} onClose={() => setLocalHistoryPath(null)} onChanged={() => refresh(root)} />}
      {showMultiRepository && <MultiRepositoryDialog currentRoot={root} onClose={() => setShowMultiRepository(false)} />}
      {transfer && root && <TransferDialog key={`${root}-${transfer}`} root={root} action={transfer} onClose={() => setTransfer(null)} onChanged={() => refresh(root, true)} />}

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

      {review && (
        <Suspense fallback={<div class="commit-review-loading" role="status">正在加载三栏查看器…</div>}>
          <CommitReviewViewer
            key={JSON.stringify([review.root, review.details.commit.hash, review.path])}
            root={review.root}
            details={review.details}
            initialPath={review.path}
            version={version}
            onClose={() => setReview(null)}
          />
        </Suspense>
      )}

      {operationDialog && (
        <HistoryDialog
          preview={operationDialog}
          onClose={() => setOperationDialog(null)}
          onRun={(request) => {
            setOperationDialog(null);
            void mutate('start_history', { request }, historyLabels[request.action], true).then(success => {
              if (success && request.action === 'merge' && request.mergeMode === 'squash') {
                setView('changes');
                setMessage(previous => previous || `Squash merge ${request.target.replace(/^refs\/(heads|remotes)\//, '')} into ${request.expectedBranch}`);
              }
            });
          }}
        />
      )}
      {commitContext && <div class="action-popup commit-context-menu" role="menu" style={{ left: Math.max(8, Math.min(commitContext.x, window.innerWidth - 290)), top: Math.max(8, Math.min(commitContext.y, window.innerHeight - 150)) }}>
        <button role="menuitem" disabled={!!busy} onClick={() => void copyCommitRevision()}>复制 Revision Number</button>
        <button role="menuitem" disabled={!!busy} onClick={() => void saveCommitPatch()}>保存为 Patch…</button>
        <hr />
        <button role="menuitem" disabled={!!busy || status?.repository.operation !== 'none'} onClick={() => void previewNavigation(commitContext.commit.hash)}>签出此提交…</button>
        <button role="menuitem" disabled={!!busy || status?.repository.operation !== 'none'} onClick={() => void previewNavigation(commitContext.commit.hash, 'checkout', true)}>从此提交创建分支…</button>
        <button role="menuitem" disabled={!!busy || !status?.repository.branch || status.repository.operation !== 'none'} onClick={() => void previewNavigation(commitContext.commit.hash, 'reset')}>重置当前分支到此提交…</button>
        <hr />
        <button
          role="menuitem"
          disabled={historyDisabled}
          onClick={() => {
            const commit = commitContext.commit;
            setCommitContext(null);
            previewHistory('cherry-pick', {
              target: commit.hash,
              hash: commit.hash,
              label: commit.subject,
              parents: commit.parents,
            });
          }}
        >
          Cherry-pick…
        </button>
        <button
          role="menuitem"
          disabled={historyDisabled}
          onClick={() => {
            const commit = commitContext.commit;
            setCommitContext(null);
            previewHistory('revert', {
              target: commit.hash,
              hash: commit.hash,
              label: commit.subject,
              parents: commit.parents,
            });
          }}
        >
          Revert…
        </button>
      </div>}
      {discard && <DiscardDialog preview={discard} busy={!!busy} error={discardError}
        onClose={() => setDiscard(null)} onConfirm={() => void discardChanges()}
        onReload={() => void previewDiscard(discard.paths, discard.mode)} />}
      {navigation && <NavigationDialog key={`${navigation.preview.target}-${navigation.creating}`} preview={navigation.preview} creating={navigation.creating} busy={!!busy} result={navigationResult} error={navigationError}
        onClose={() => setNavigation(null)} onRun={(request) => void runNavigation(request)}
        onRetarget={(target) => void previewNavigation(target, navigation.preview.action)}
        onOpen={(path) => void openPath(path)} />}
      {revisionInput !== null && <Modal title="签出标签或提交 SHA" busy={!!busy} onClose={() => setRevisionInput(null)}>
        <form onSubmit={(e) => { e.preventDefault(); void previewNavigation(revisionInput.trim()); }}>
          <h2>签出标签或提交 SHA</h2><label>分支、标签或提交 SHA<input aria-label="签出目标" value={revisionInput} disabled={!!busy} required onInput={(e) => setRevisionInput(e.currentTarget.value)} /></label>
          {error && <p class="error-text">{error}</p>}<div class="modal-actions"><button type="button" disabled={!!busy} onClick={() => setRevisionInput(null)}>取消</button><button class="primary" disabled={!!busy || !revisionInput.trim()}>预览签出</button></div>
        </form>
      </Modal>}
      {showRecovery && <RecoveryDialog root={root} overview={recovery} busy={!!busy} error={error || recoveryError} onClose={() => setShowRecovery(false)}
        onRestore={(id) => void mutate('recover_navigation', { id, action: 'restore' }, '恢复本地修改', true)}
        onResolve={(id) => void mutate('recover_navigation', { id, action: 'finish' }, '确认操作恢复')}
        onConflicts={() => { setShowRecovery(false); setMergePath(''); }}
        onBranch={(hash, name) => mutate('create_recovery_branch', { hash, name }, '创建恢复分支')}
        onCheckout={(hash) => void previewNavigation(hash)} />}
      {comparisonBranch !== null && (
        <CompareView root={root} branch={comparisonBranch} onClose={() => setComparisonBranch(null)} />
      )}

      {(newChangeListDialog || changeListTarget) && (
        <div class="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setNewChangeListDialog(false); setChangeListTarget(null); } }}>
          <form
            class="modal"
            onSubmit={(event) => {
              event.preventDefault();
              if (changeListTarget) createAndAssignChangeList(changeListTarget);
              else {
                const name = newChangeListName.trim();
                if (name) {
                  const list = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, paths: [] };
                  updateChangeLists([...changeLists, list]);
                  setActiveChangeList(list.id);
                  setNewChangeListName('');
                  setNewChangeListDialog(false);
                }
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-label={changeListTarget ? '移动到 Changelist' : '新建 Changelist'}
          >
            <h2>{changeListTarget ? '移动到 Changelist' : '新建 Changelist'}</h2>
            {changeListTarget && (
              <label>
                目标 Changelist
                <select aria-label="目标 Changelist" value="" onChange={(event) => assignToChangeList(changeListTarget, event.currentTarget.value)}>
                  <option value="">从列表选择</option>
                  {changeLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
                </select>
              </label>
            )}
            <label>
              {changeListTarget ? '或新建名称' : '名称'}
              <input autoFocus value={newChangeListName} disabled={!!busy} onInput={(event) => setNewChangeListName(event.currentTarget.value)} />
            </label>
            {changeListTarget && <button type="button" disabled={!!busy || !changeListTarget} onClick={() => assignToChangeList(changeListTarget, '')}>移出 Changelist</button>}
            <div class="modal-actions">
              <button type="button" disabled={!!busy} onClick={() => { setNewChangeListDialog(false); setChangeListTarget(null); }}>取消</button>
              <button type="submit" class="primary" disabled={!!busy || !newChangeListName.trim()}>{changeListTarget ? '新建并移动' : '创建'}</button>
            </div>
          </form>
        </div>
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
                dialog.kind === 'branch' ? { name: dialog.value } : { message: dialog.kind === 'shelf' ? `Shelf: ${dialog.value}` : dialog.value },
                dialog.kind === 'branch' ? '创建分支' : dialog.kind === 'shelf' ? '保存 Shelf' : '保存 Stash',
              ).then((success) => {
                if (success) setDialog(null);
              });
            }}
            role="dialog"
            aria-modal="true"
            aria-label={dialog.kind === 'branch' ? '新建分支' : dialog.kind === 'shelf' ? '保存 Shelf' : '保存 Stash'}
          >
            <h2>{dialog.kind === 'branch' ? '新建并切换分支' : dialog.kind === 'shelf' ? '保存到 Shelf' : '保存到 Stash'}</h2>
            <label>
              {dialog.kind === 'branch' ? '分支名称' : '说明'}
              <input
                autoFocus
                value={dialog.value}
                disabled={!!busy}
                onInput={(e) => setDialog({ ...dialog, value: e.currentTarget.value })}
              />
            </label>
            {dialog.kind !== 'branch' && <p class="muted">包含未跟踪文件，保存后清理工作区。Shelf 使用 Git stash 后端保存。</p>}
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
