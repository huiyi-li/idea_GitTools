import { useEffect, useState } from 'preact/hooks';
import { call, type Branch, type Status } from './api';
import { Modal } from './ui/controls';
import { TransportProgress } from './TransportDialog';

export function BranchDialog({ root, initialBranch, action, onClose, onChanged, onOpen }: {
  root: string;
  initialBranch: Branch;
  action: 'rename' | 'delete';
  onClose: () => void;
  onChanged: (renamed?: string) => Promise<void>;
  onOpen: (path: string) => Promise<unknown>;
}) {
  const [branch, setBranch] = useState<Branch>();
  const [name, setName] = useState(initialBranch.name);
  const [force, setForce] = useState(false);
  const [worktree, setWorktree] = useState('');
  const [remote, setRemote] = useState('');
  const [job, setJob] = useState('');
  const [transportIdle, setTransportIdle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function load() {
    setLoading(true);
    try {
      const status = await call<Status>('repository_status', { root });
      const selected = status.branches.find(item => item.full === initialBranch.full);
      setBranch(selected);
      if (!selected) throw Error('分支已不存在，请刷新分支列表');
      if (selected.remote) {
        const overview = await call<{ remotes: { name: string }[] }>('transfer_overview', { root });
        const remote = overview.remotes.filter(item => selected.name.startsWith(item.name + '/')).sort((a, b) => b.name.length - a.name.length)[0];
        if (!remote) throw Error('找不到此分支对应的 Remote');
        setRemote(remote.name);
      } else {
        const overview = await call<{ entries: { branch: string | null; path: string; current: boolean }[] }>('read_worktrees', { root });
        setWorktree(overview.entries.find(item => item.branch === selected.full && !item.current)?.path ?? '');
      }
    } finally { setLoading(false); }
  }
  useEffect(() => { void load().catch(error => setError(String(error))); }, [root, initialBranch.full]);
  async function run() {
    if (!branch || busy || loading) return;
    setBusy(true);
    setError('');
    try {
      if (branch.remote) {
        const id = await call<string>('delete_remote_ref', { root, remote, name: branch.name.slice(remote.length + 1), kind: 'heads', hash: branch.hash });
        setJob(id);
        return;
      }
      await call('edit_ref', { root, request: { action: `branch-${action}`, name: branch.name, newName: name.trim(), hash: branch.hash, message: '', force } });
      await onChanged(action === 'rename' ? `refs/heads/${name.trim()}` : undefined);
      onClose();
    } catch (error) { setError(String(error)); await onChanged(branch.full).catch(() => {}); }
    finally { setBusy(false); }
  }
  const title = action === 'rename' ? '重命名分支' : initialBranch.remote ? '删除远程分支' : '删除本地分支';
  if (job) return <Modal title="删除远程分支" busy={!transportIdle} onClose={onClose} class="transport-dialog">
    <h2>删除远程分支 · {initialBranch.name}</h2>
    <TransportProgress id={job} onIdle={setTransportIdle}
      onFinished={async state => { if (state !== 'done') await onChanged(initialBranch.full); }}
      onDone={async () => { await onChanged(); onClose(); }} />
    <div class="modal-actions"><button disabled={!transportIdle} onClick={onClose}>关闭</button></div>
  </Modal>;
  return <Modal title={title} busy={busy} onClose={onClose} class="transport-dialog">
    <h2>{title}</h2>
    <p>{branch?.name ?? initialBranch.name} · <span class="mono">{(branch?.hash ?? initialBranch.hash).slice(0, 12)}</span></p>
    <form class="transport-form" onSubmit={event => { event.preventDefault(); void run(); }}>
      {action === 'rename' ? <label>新名称<input aria-label="分支新名称" value={name} disabled={busy || loading} required onInput={event => setName(event.currentTarget.value)} /></label> : <>
        {branch?.remote ? <p>将删除 {remote} 上的远程分支。执行时校验预览中的远程提交。</p> : <>
          <p>将删除此本地分支引用。请核对分支名称和提交。</p>
          <label><input type="checkbox" checked={force} disabled={busy || loading} onChange={event => setForce(event.currentTarget.checked)} />允许删除未合并分支</label>
        </>}
      </>}
      {worktree && <p>分支正在 Worktree 使用 · {worktree}
        <button type="button" disabled={busy} onClick={() => { void onOpen(worktree).then(result => { if (result !== false) onClose(); }).catch(error => setError(String(error))); }}>打开该工作区</button>
      </p>}
      {branch?.current && action === 'delete' && <p>请先签出其他分支，再删除此分支。</p>}
      {error && <p class="error-text" role="alert">{error}</p>}
      <div class="modal-actions">
        <button type="button" disabled={busy || loading} onClick={() => { setError(''); void load().catch(error => setError(String(error))); }}>刷新分支状态</button>
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button disabled={busy || loading || !branch || (action === 'delete' ? !!worktree || branch.current || branch.remote && !remote : !name.trim() || name.trim() === branch.name)}>{action === 'rename' ? '保存分支名称' : '确认删除分支'}</button>
      </div>
    </form>
  </Modal>;
}
