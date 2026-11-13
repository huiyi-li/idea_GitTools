import { useEffect, useState } from 'preact/hooks';
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
  onChanged: () => Promise<void>;
}) {
  const [overview, setOverview] = useState<Overview>();
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('');
  const [setUpstream, setSetUpstream] = useState(true);
  const [prune, setPrune] = useState(true);
  const [rebase, setRebase] = useState(false);
  const [force, setForce] = useState(false);
  const [pushTags, setPushTags] = useState(false);
  const [noVerify, setNoVerify] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [remoteHash, setRemoteHash] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void call<Overview>('transfer_overview', { root })
      .then((value) => {
        if (!current) return;
        setOverview(value);
        const upstreamRemote = value.remotes
          .filter((entry) => value.upstream.startsWith(entry.name + '/'))
          .sort((left, right) => right.name.length - left.name.length)[0];
        setRemote(upstreamRemote?.name ?? value.remotes[0]?.name ?? '');
        setBranch(
          upstreamRemote
            ? value.upstream.slice(upstreamRemote.name.length + 1)
            : (value.branch ?? ''),
        );
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [root]);
  useEffect(() => {
    if (action !== 'push' || !remote || !branch) return;
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
  }, [root, remote, branch, action]);
  async function start() {
    if (!overview || busy) return;
    setBusy(true);
    setError('');
    try {
      setId(
        await call<string>('start_transfer', {
          root,
          request: {
            action,
            remote,
            branch,
            expectedHead: overview.head ?? '',
            expectedBranch: overview.branch ?? '',
            setUpstream,
            prune,
            rebase,
            force,
            pushTags,
            noVerify,
            expectedRemote: remoteHash,
            expectedRemoteConfig: overview.remotes.find((entry) => entry.name === remote),
          },
        }),
      );
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }
  return (
    <Modal title={action} busy={busy} onClose={onClose} class="transport-dialog">
      <h2>{action === 'push' ? '推送提交' : action === 'pull' ? '拉取更新' : '获取远程更新'}</h2>
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
        {action === 'fetch' && (
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
        {action !== 'fetch' && (
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
        {action === 'push' && (
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
        {action === 'pull' && (
          <label>
            <input
              type="checkbox"
              checked={rebase}
              disabled={busy}
              onChange={(event) => setRebase(event.currentTarget.checked)}
            />
            通过 Rebase 拉取（默认仅快进）
          </label>
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
          <button
            disabled={
              busy ||
              !remote ||
              (action !== 'fetch' && !branch) ||
              (force && (!confirm || !remoteHash))
            }
          >
            {action}
          </button>
        </div>
      </form>
      {id && (
        <TransportProgress
          id={id}
          onIdle={(idle) => setBusy(!idle)}
          onFinished={onChanged}
          onDone={onClose}
        />
      )}
    </Modal>
  );
}
