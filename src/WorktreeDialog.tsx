import { useEffect, useState } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-dialog';
import { call, type Branch } from './api';
import { Modal } from './ui/controls';

interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  locked: string | null;
  prunable: string | null;
  bare: boolean;
  main: boolean;
  current: boolean;
  dirty: boolean | null;
  error: string;
  fingerprint: string;
}
interface Overview { entries: Worktree[]; branches: Branch[]; head: string | null }

export function WorktreeDialog({ root, onClose, onChanged, onOpen }: {
  root: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpen: (path: string) => Promise<unknown>;
}) {
  const [data, setData] = useState<Overview>();
  const [selected, setSelected] = useState('');
  const [path, setPath] = useState('');
  const [mode, setMode] = useState('new');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function load() {
    const next = await call<Overview>('read_worktrees', { root });
    setData(next);
    setBase(previous => previous || next.head || '');
    setConfirm('');
  }
  useEffect(() => { void load().catch(error => setError(String(error))); }, [root]);
  async function run(job: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try { await job(); }
    catch (error) { setError(String(error)); }
    finally {
      await load().catch(error => setError(String(error)));
      await onChanged().catch(error => setError(String(error)));
      setBusy(false);
    }
  }
  const entry = data?.entries.find(item => item.path === selected);
  const manageable = entry && !entry.main && !entry.bare;
  const branches = data?.branches.filter(item => !item.remote) ?? [];
  const selectedBranch = branches.find(item => item.name === branch);
  const missing = data?.entries.filter(item => item.prunable !== null && item.locked === null) ?? [];
  return <Modal title="Worktree 管理" onClose={onClose} busy={busy} class="workflow-dialog">
    <h2>Worktree 管理</h2>
    <div class="worktree-list" role="list" aria-label="Worktree 列表">
      {data?.entries.map(item => <button key={item.path} role="listitem" class={selected === item.path ? 'selected' : ''}
        disabled={busy} onClick={() => { setSelected(item.path); setConfirm(''); setReason(''); }}>
        <strong>{item.branch?.replace('refs/heads/', '') || (item.bare ? 'Bare' : `Detached · ${item.head.slice(0, 8)}`)}
          {item.main ? ' · 主工作区' : ''}{item.current ? ' · 当前' : ''}</strong>
        <span>{item.path}</span>
        <small>{item.locked !== null ? `已锁定 · ${item.locked}` : item.prunable !== null ? `可清理 · ${item.prunable}` : item.dirty ? '有本地更改' : item.dirty === false ? '干净' : '状态不可用'}</small>
      </button>)}
    </div>
    {entry && <section class="worktree-details">
      {entry.error && <p class="error-text">{entry.error}</p>}
      <div class="modal-actions">
        <button disabled={busy || entry.current || entry.bare || entry.dirty === null} onClick={() => {
          setBusy(true);
          void onOpen(entry.path).then(result => { if (result !== false) onClose(); })
            .catch(error => setError(String(error))).finally(() => setBusy(false));
        }}>打开此工作区</button>
        {manageable && <>
          {entry.locked === null ? <>
            <input aria-label="Worktree 锁定说明" value={reason} disabled={busy} placeholder="锁定说明（可选）" onInput={event => setReason(event.currentTarget.value)} />
            <button disabled={busy} onClick={() => void run(() => call('edit_worktree', { root, entry, action: 'lock', reason }))}>锁定</button>
          </> : <button disabled={busy} onClick={() => void run(() => call('edit_worktree', { root, entry, action: 'unlock', reason: '' }))}>解锁</button>}
          <button disabled={busy || entry.current || entry.locked !== null || entry.dirty !== false} onClick={() => setConfirm('remove')}>删除此工作区…</button>
        </>}
      </div>
      {confirm === 'remove' && <div class="confirmation" role="group" aria-label="确认删除 Worktree">
        <p>将删除工作区目录 {entry.path}，保留分支 {entry.branch?.replace('refs/heads/', '') || '（Detached）'}。</p>
        <button disabled={busy} onClick={() => void run(() => call('edit_worktree', { root, entry, action: 'remove', reason: '' }))}>确认删除工作区</button>
        <button disabled={busy} onClick={() => setConfirm('')}>取消删除</button>
      </div>}
    </section>}
    <details class="worktree-create">
      <summary>创建 Worktree</summary>
      <form class="transport-form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const result = await call<string>('create_worktree', { root, request: { path, mode, branch, base: mode === 'existing' ? selectedBranch?.hash ?? '' : base } });
          setSelected(result);
          setNotice(`已创建 ${result}`);
        });
      }}>
        <label>目标目录<input aria-label="Worktree 目标目录" value={path} disabled={busy} placeholder="绝对路径，可填写尚未创建的目录" onInput={event => setPath(event.currentTarget.value)} /></label>
        <button type="button" disabled={busy} onClick={() => {
          void open({ directory: true, multiple: false, title: '选择空目录作为 Worktree' })
            .then(path => { if (typeof path === 'string') setPath(path); }).catch(error => setError(String(error)));
        }}>选择空目录…</button>
        <label>创建方式<select aria-label="Worktree 创建方式" disabled={busy} value={mode} onChange={event => { setMode(event.currentTarget.value); setBranch(''); }}>
          <option value="new">新建分支</option><option value="existing">已有本地分支</option><option value="detached">Detached HEAD</option>
        </select></label>
        {mode === 'existing' ? <label>本地分支<select aria-label="Worktree 已有分支" disabled={busy} value={branch} onChange={event => setBranch(event.currentTarget.value)}>
          <option value="">选择分支</option>{branches.map(item => <option key={item.full} value={item.name} disabled={data?.entries.some(entry => entry.branch === item.full)}>{item.name}{data?.entries.some(entry => entry.branch === item.full) ? '（已占用）' : ''}</option>)}
        </select></label> : <>
          {mode === 'new' && <label>新分支名<input aria-label="Worktree 新分支名" value={branch} disabled={busy} onInput={event => setBranch(event.currentTarget.value)} /></label>}
          <label>起点提交<select aria-label="Worktree 起点提交" value={base} disabled={busy} onChange={event => setBase(event.currentTarget.value)}>
            {data?.head && <option value={data.head}>当前 HEAD · {data.head.slice(0, 8)}</option>}
            {data?.branches.map(item => <option key={item.full} value={item.hash}>{item.name} · {item.hash.slice(0, 8)}</option>)}
          </select></label>
        </>}
        <button disabled={busy || !path || (mode !== 'detached' && !branch) || (mode === 'existing' ? !selectedBranch : !base)}>创建工作区</button>
      </form>
    </details>
    {confirm === 'prune' && <div class="confirmation">
      <p>清理以下已失效工作区的 Git 管理记录</p>
      <ul>{missing.map(item => <li key={item.path}>{item.path}</li>)}</ul>
      <button disabled={busy} onClick={() => void run(async () => {
        const message = await call<string>('prune_worktrees', { root, entries: data?.entries });
        setNotice(message || '已清理失效工作区记录');
      })}>确认清理失效记录</button>
      <button disabled={busy} onClick={() => setConfirm('')}>取消清理</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p class="error-text" role="alert">{error}</p>}
    <div class="modal-actions">
      <button disabled={busy} onClick={() => void run(async () => {})}>刷新列表</button>
      <button disabled={busy || !missing.length} onClick={() => setConfirm('prune')}>清理失效记录…</button>
      <button disabled={busy} onClick={onClose}>关闭</button>
    </div>
  </Modal>;
}
