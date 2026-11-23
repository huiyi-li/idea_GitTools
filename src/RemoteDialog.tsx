import { useEffect, useRef, useState } from 'preact/hooks';
import { call, type Commit } from './api';
import { Modal } from './ui/controls';
import { TransportProgress } from './TransportDialog';

interface Remote {
  name: string;
  fetchUrls: string[];
  pushUrls: string[];
}
interface Overview {
  remotes: Remote[];
  branch: string | null;
  head: string | null;
  upstream: string;
}

export function RemoteDialog({
  root,
  onClose,
  onChanged,
}: {
  root: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [selected, setSelected] = useState<Remote | null>(null);
  const [name, setName] = useState('origin');
  const [url, setUrl] = useState('');
  const [pushUrl, setPushUrl] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    const overview = await call<Overview>('transfer_overview', { root });
    setRemotes(overview.remotes);
  }
  useEffect(() => {
    void load().catch((error) => setError(String(error)));
  }, [root]);
  function select(remote: Remote | null) {
    setSelected(remote);
    setName(remote?.name ?? 'origin');
    setUrl(remote?.fetchUrls[0] ?? '');
    setPushUrl(
      remote && remote.pushUrls.join('\0') !== remote.fetchUrls.join('\0')
        ? (remote.pushUrls[0] ?? '')
        : '',
    );
    setConfirm(false);
  }
  async function edit(action: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await call('edit_remote', {
        root,
        request: { action, name, url, pushUrl, expected: selected },
      });
      await load();
      select(null);
      await onChanged();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="管理远程仓库" busy={busy} onClose={onClose} class="transport-dialog">
      <h2>管理远程仓库</h2>
      <div class="modal-actions">
        {remotes.map((remote) => (
          <button disabled={busy} key={remote.name} onClick={() => select(remote)}>
            {remote.name}
          </button>
        ))}
        <button disabled={busy} onClick={() => select(null)}>
          新增远程
        </button>
      </div>
      <form
        class="transport-form"
        onSubmit={(event) => {
          event.preventDefault();
          void edit(selected ? 'edit' : 'add');
        }}
      >
        <label>
          远程名称
          <input
            aria-label="远程名称"
            value={name}
            required
            disabled={busy || !!selected}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          Fetch 地址
          <input
            aria-label="远程 Fetch 地址"
            value={url}
            required
            disabled={busy}
            onInput={(event) => setUrl(event.currentTarget.value)}
          />
        </label>
        <label>
          Push 地址（留空沿用 Fetch）
          <input
            aria-label="远程 Push 地址"
            value={pushUrl}
            disabled={busy}
            onInput={(event) => setPushUrl(event.currentTarget.value)}
          />
        </label>
        {selected && (selected.fetchUrls.length > 1 || selected.pushUrls.length > 1) && (
          <p>此远程配置了多个地址，保存后将替换为上方填写的地址。</p>
        )}
        {error && (
          <p role="alert" class="error-text">
            {error}
          </p>
        )}
        <div class="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            关闭
          </button>
          <button disabled={busy || !name || !url}>保存远程配置</button>
        </div>
      </form>
      {selected && (
        <div>
          <label>
            <input
              type="checkbox"
              checked={confirm}
              disabled={busy}
              onChange={(event) => setConfirm(event.currentTarget.checked)}
            />
            确认移除 {selected.name} 及其远程跟踪分支
          </label>
          <button disabled={busy || !confirm} onClick={() => void edit('remove')}>
            移除远程
          </button>
        </div>
      )}
    </Modal>
  );
}

export function TransferDialog({
  root,
  action,
  onClose,
  onChanged,
}: {
  root: string;
  action: 'fetch' | 'pull' | 'push';
  onClose: () => void;
  onChanged: (openConflicts?: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState<'fetch' | 'pull' | 'push'>(action);
  const [overview, setOverview] = useState<Overview>();
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('');
  const [setUpstream, setSetUpstream] = useState(true);
  const [prune, setPrune] = useState(true);
  const [rebase, setRebase] = useState(false);
  const [pullStrategy, setPullStrategy] = useState<'ff-only' | 'merge' | 'rebase'>('ff-only');
  const [autoClean, setAutoClean] = useState<'shelf' | 'stash' | 'none'>('shelf');
  const [force, setForce] = useState(false);
  const [pushTags, setPushTags] = useState(false);
  const [noVerify, setNoVerify] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [remoteHash, setRemoteHash] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pushFailed, setPushFailed] = useState(false);
  const modeRef = useRef<'fetch' | 'pull' | 'push'>(action);
  const retryPushRef = useRef(false);
  const suppressNextDoneCloseRef = useRef(false);

  async function loadOverview() {
    const value = await call<Overview>('transfer_overview', { root });
    setOverview(value);
    const upstreamRemote = value.remotes
      .filter((entry) => value.upstream.startsWith(entry.name + '/'))
      .sort((left, right) => right.name.length - left.name.length)[0];
    setRemote((prev) => prev || upstreamRemote?.name || value.remotes[0]?.name || '');
    setBranch((prev) =>
      prev ||
      (upstreamRemote
        ? value.upstream.slice(upstreamRemote.name.length + 1)
        : (value.branch ?? '')),
    );
    return value;
  }

  useEffect(() => {
    let current = true;
    void loadOverview().catch((error) => {
      if (current) setError(String(error));
    });
    return () => {
      current = false;
    };
  }, [root]);

  useEffect(() => {
    if (mode !== 'push' || !remote || !branch) return;
    let current = true;
    setConfirm(false);
    void Promise.all([
      call<Commit[]>('outgoing_commits', { root, remote, branch }),
      call<{ branches: { full: string; hash: string }[] }>('repository_status', { root }),
    ])
      .then(([commits, status]) => {
        if (!current) return;
        setCommits(commits);
        setRemoteHash(
          status.branches.find((entry) => entry.full === `refs/remotes/${remote}/${branch}`)
            ?.hash ?? null,
        );
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [root, remote, branch, mode]);

  async function start(
    overrideAction?: 'fetch' | 'pull' | 'push',
    overrideStrategy?: 'ff-only' | 'merge' | 'rebase',
    overrideClean?: 'shelf' | 'stash' | 'none',
    chainPush = false,
  ) {
    if (!overview || (busy && !overrideAction)) return;
    const currentAction = overrideAction ?? mode;
    const currentStrategy = overrideStrategy ?? pullStrategy;
    const currentClean = overrideClean ?? autoClean;
    setBusy(true);
    setError('');
    setNotice('');
    setPushFailed(false);
    retryPushRef.current = chainPush;
    modeRef.current = currentAction;
    if (overrideAction) setMode(overrideAction);
    if (overrideStrategy) {
      setPullStrategy(overrideStrategy);
      setRebase(overrideStrategy === 'rebase');
    }
    if (overrideClean) setAutoClean(overrideClean);
    try {
      const latestOverview = overrideAction ? await loadOverview() : overview;
      setId(
        await call<string>('start_transfer', {
          root,
          request: {
            action: currentAction,
            remote,
            branch,
            expectedHead: latestOverview.head ?? '',
            expectedBranch: latestOverview.branch ?? '',
            setUpstream,
            prune,
            rebase: currentStrategy === 'rebase' || rebase,
            force,
            pushTags,
            noVerify,
            expectedRemote: remoteHash,
            expectedRemoteConfig: latestOverview.remotes.find((entry) => entry.name === remote),
            ...(currentAction === 'pull'
              ? {
                  pullStrategy: currentStrategy,
                  autoClean: currentClean,
                }
              : {}),
          },
        }),
      );
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }
  return (
    <Modal title={mode} busy={busy} onClose={onClose} class="transport-dialog">
      <h2>{mode === 'push' ? '推送提交' : mode === 'pull' ? '更新项目 · 拉取更新 (Ctrl+T)' : '获取远程更新'}</h2>
      <form
        class="transport-form"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <p>
          {overview?.branch ?? '尚未签出分支'} → {remote}/{branch}
        </p>
        <label>
          远程
          <select
            aria-label="传输远程"
            value={remote}
            disabled={busy}
            onChange={(event) => setRemote(event.currentTarget.value)}
          >
            {overview?.remotes.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        {!overview?.remotes.length && overview && <p>请先从主工具栏“管理远程仓库”添加 Remote。</p>}
        {mode === 'fetch' && (
          <label>
            <input
              type="checkbox"
              checked={prune}
              disabled={busy}
              onChange={(event) => setPrune(event.currentTarget.checked)}
            />
            清理远程已删除的分支引用
          </label>
        )}
        {mode !== 'fetch' && (
          <label>
            目标分支
            <input
              aria-label="传输目标分支"
              required
              value={branch}
              disabled={busy}
              onInput={(event) => setBranch(event.currentTarget.value)}
            />
          </label>
        )}
        {mode === 'push' && (
          <>
            <label>
              <input
                type="checkbox"
                checked={setUpstream}
                disabled={busy}
                onChange={(event) => setSetUpstream(event.currentTarget.checked)}
              />
              设置 upstream
            </label>
            <label>
              <input type="checkbox" checked={pushTags} disabled={busy} onChange={(event) => setPushTags(event.currentTarget.checked)} />
              同时推送所有标签
            </label>
            <label>
              <input type="checkbox" checked={noVerify} disabled={busy} onChange={(event) => setNoVerify(event.currentTarget.checked)} />
              跳过本地 pre-push hook
            </label>
            <label>
              <input
                type="checkbox"
                checked={force}
                disabled={busy}
                onChange={(event) => {
                  setForce(event.currentTarget.checked);
                  setConfirm(false);
                }}
              />
              Force with lease
            </label>
            {force && (
              <label>
                <input
                  type="checkbox"
                  checked={confirm}
                  disabled={busy}
                  onChange={(event) => setConfirm(event.currentTarget.checked)}
                />
                确认覆盖远程分支，预期远程提交 {remoteHash?.slice(0, 12) ?? '未知，请先 Fetch'}
              </label>
            )}
            <h3>待推送提交（最多显示 100 条）</h3>
            <ul class="navigation-files">
              {commits.map((commit) => (
                <li key={commit.hash}>
                  <code>{commit.hash.slice(0, 8)}</code> {commit.subject}
                </li>
              ))}
            </ul>
          </>
        )}
        {mode === 'pull' && (
          <>
            <label>
              拉取整合策略
              <select
                aria-label="拉取整合策略"
                value={pullStrategy}
                disabled={busy}
                onChange={(event) => {
                  const next = event.currentTarget.value as 'ff-only' | 'merge' | 'rebase';
                  setPullStrategy(next);
                  setRebase(next === 'rebase');
                }}
              >
                <option value="ff-only">仅快进 (--ff-only)</option>
                <option value="rebase">变基整合 (--rebase)</option>
                <option value="merge">合并远程分支 (--no-rebase / Merge)</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={rebase}
                disabled={busy}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setRebase(checked);
                  setPullStrategy(checked ? 'rebase' : 'ff-only');
                }}
              />
              通过 Rebase 拉取（默认仅快进）
            </label>
            <label>
              脏工作区自动暂存与恢复
              <select
                aria-label="脏工作区自动暂存方式"
                value={autoClean}
                disabled={busy}
                onChange={(event) =>
                  setAutoClean(event.currentTarget.value as 'shelf' | 'stash' | 'none')
                }
              >
                <option value="shelf">自动 Shelve 并在更新后恢复（推荐 · 独立 Patch + Local History 打标）</option>
                <option value="stash">自动 Git Stash 并在更新后弹出（+ Local History 打标）</option>
                <option value="none">不自动暂存（要求工作区干净）</option>
              </select>
            </label>
          </>
        )}
        {notice && (
          <p role="status" class="muted">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" class="error-text">
            {error}
          </p>
        )}
        {pushFailed && !force && (
          <div class="modal-actions" aria-label="推送被拒绝快捷处理">
            <span>推送失败（远程可能包含新提交），可一键更新并自动重推：</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void start('pull', 'rebase', 'shelf', true)}
            >
              拉取并重新推送 (Rebase + Auto-Shelf)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void start('pull', 'merge', 'shelf', true)}
            >
              拉取并重新推送 (Merge + Auto-Shelf)
            </button>
          </div>
        )}
        <div class="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            关闭
          </button>
          <button
            disabled={
              busy ||
              !remote ||
              (mode !== 'fetch' && !branch) ||
              (force && (!confirm || !remoteHash))
            }
          >
            {mode}
          </button>
        </div>
      </form>
      {id && (
        <TransportProgress
          id={id}
          onIdle={(idle) => setBusy(!idle)}
          onFinished={async (state) => {
            const finishedMode = modeRef.current;
            let hasConflicts = false;
            if (finishedMode === 'pull') {
              try {
                const finish = await call<{
                  restored: boolean;
                  conflicts: boolean;
                  message: string;
                }>('finish_update_project', { root });
                if (finish?.message) setNotice(finish.message);
                hasConflicts = !!finish?.conflicts;
              } catch {
                // Backend or mock without finish_update_project
              }
            }
            if (finishedMode === 'push' && state === 'error') {
              setPushFailed(true);
            }
            await onChanged(hasConflicts);
            if (finishedMode === 'pull' && retryPushRef.current && state === 'done' && !hasConflicts) {
              retryPushRef.current = false;
              suppressNextDoneCloseRef.current = true;
              setBusy(false);
              await start('push');
            }
          }}
          onDone={() => {
            if (suppressNextDoneCloseRef.current) {
              suppressNextDoneCloseRef.current = false;
              return;
            }
            onClose();
          }}
        />
      )}
    </Modal>
  );
}
