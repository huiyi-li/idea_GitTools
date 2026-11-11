import { useState } from 'preact/hooks';
import { Modal } from '../ui/controls';
import type { NavigationPreview, NavigationRequest, NavigationResult, ResetMode } from './types';

export const resetModes: Record<ResetMode, string> = {
  soft: 'Soft · 移动分支指针，保留暂存区和工作区内容。',
  mixed: 'Mixed · 移动分支指针，按目标提交重建暂存区，保留工作区内容。',
  hard: 'Hard · 用目标提交覆盖暂存区和工作区，可能删除阻挡目标文件的未跟踪路径。',
  keep: 'Keep · 更新到目标提交；会覆盖本地修改时终止。',
};

export function NavigationDialog({ preview, creating = false, busy, result, error, onClose, onRun, onRetarget, onOpen }: {
  preview: NavigationPreview;
  creating?: boolean;
  busy: boolean;
  result: NavigationResult | null;
  error: string;
  onClose: () => void;
  onRun: (request: NavigationRequest) => void;
  onRetarget: (target: string) => void;
  onOpen: (path: string) => void;
}) {
  const [mode, setMode] = useState<ResetMode>('mixed');
  const [newBranch, setNewBranch] = useState(preview.remote ? preview.suggestedBranch : '');
  const [backup, setBackup] = useState(false);
  const [confirmHard, setConfirmHard] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  const reset = preview.action === 'reset';
  const create = creating || preview.remote;
  const blocked = result?.kind === 'overwrite';
  const disabled = busy || !!preview.worktreePath || (create && !newBranch.trim()) || (reset && mode === 'hard' && !confirmHard);
  const title = reset ? '重置当前分支到此提交' : creating ? '从此提交创建分支' : '签出';
  const request = (strategy: NavigationRequest['strategy']): NavigationRequest => ({ preview, mode, strategy, newBranch: create ? newBranch.trim() : null });
  return <Modal title={title} busy={busy} onClose={onClose} class="history-dialog navigation-dialog">
    <form onSubmit={(e) => { e.preventDefault(); onRun(request(backup ? 'backup' : 'normal')); }}>
      <h2>{title}</h2>
      <div class="operation-summary">
        <span class="muted">当前分支</span><span>{preview.expectedBranch ?? 'Detached HEAD'} <small class="mono">{preview.expectedHead?.slice(0, 8) ?? '尚无提交'}</small></span>
        <span class="muted">目标</span><span class="navigation-target">{preview.target} <small class="mono">{preview.targetHash.slice(0, 8)}</small></span>
      </div>
      {!reset && !create && !preview.local && <p class="muted">签出标签或提交后进入 Detached HEAD；可从该提交创建分支保存后续提交。</p>}
      {preview.remote && !!preview.localBranches.length && <label>已有对应本地分支
        <select aria-label="已有对应本地分支" disabled={busy} value="" onChange={(e) => { if (e.currentTarget.value) onRetarget(e.currentTarget.value); }}>
          <option value="">创建新的跟踪分支（见下方名称）</option>
          {preview.localBranches.map((branch) => <option value={branch} key={branch}>{branch.replace('refs/heads/', '')} → {preview.target.replace('refs/remotes/', '')}</option>)}
        </select>
      </label>}
      {create && <label>{preview.remote ? '新建本地跟踪分支' : '新分支名称'}<input aria-label="新分支名称" value={newBranch} disabled={busy} required onInput={(e) => setNewBranch(e.currentTarget.value)} /></label>}
      {preview.worktreePath && <div class="navigation-warning">该分支正在其他 worktree 使用：<p class="mono">{preview.worktreePath}</p><button type="button" disabled={busy} onClick={() => onOpen(preview.worktreePath!)}>打开此 worktree</button></div>}
      {reset && <>
        <label>Reset 模式<select aria-label="Reset 模式" value={mode} disabled={busy} onChange={(e) => { setMode(e.currentTarget.value as ResetMode); setConfirmHard(false); }}>
          {Object.keys(resetModes).map((m) => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}
        </select></label><p>{resetModes[mode]}</p>
      </>}
      {!!preview.localChanges.length && <details open={reset && mode === 'hard'}><summary>本地修改 · {preview.localChanges.length} 个路径</summary><ul class="navigation-files">{preview.localChanges.map((p) => <li class="mono" key={p}>{p}</li>)}</ul></details>}
      {!!preview.changes.length && <details><summary>{reset && mode === 'soft' ? '起点与目标之间的文件差异（Soft 不改文件）' : '起点与目标之间的文件差异'} · {preview.changes.length}</summary><ul class="navigation-files">{preview.changes.map((p) => <li class="mono" key={p.path}>{p.status} {p.path}</li>)}</ul></details>}
      {reset && <details><summary>将离开当前分支的提交 · {preview.leavingCount}</summary><ul class="navigation-files">{preview.leaving.map((c) => <li key={c.hash}><span class="mono">{c.hash.slice(0, 8)}</span> {c.subject}</li>)}</ul>{preview.leavingCount > preview.leaving.length && <p class="muted">显示前 {preview.leaving.length} 个提交，原 HEAD 可在操作恢复或 Reflog 中找回。</p>}</details>}
      {((reset && mode === 'hard') || blocked) && <div class="navigation-warning">
        <strong>{reset ? 'Hard 覆盖范围' : '签出受阻'}</strong>
        {!!preview.untrackedOverwrites.length && <><p>可能被覆盖的未跟踪路径（包括忽略文件）：</p><ul class="navigation-files">{preview.untrackedOverwrites.map((p) => <li class="mono" key={p}>{p}</li>)}</ul></>}
        {reset && <label class="navigation-check"><input type="checkbox" checked={confirmHard} disabled={busy} onChange={(e) => setConfirmHard(e.currentTarget.checked)} />确认用目标提交覆盖暂存区与工作区</label>}
      </div>}
      {reset && mode === 'hard' && <label class="navigation-check"><input type="checkbox" checked={backup} disabled={busy} onChange={(e) => setBackup(e.currentTarget.checked)} />备份本地改动后重置（包含未跟踪及可能覆盖的忽略文件）</label>}
      {!reset && !blocked && !!preview.localChanges.length && <p class="muted">先尝试普通签出。Git 允许携带不会被覆盖的本地修改，受阻后可临时保存或选择强制签出。</p>}
      {result && <div class="error-text" role="alert"><p class="navigation-error">{result.message}</p>{!!result.blockedFiles.length && <ul class="navigation-files">{result.blockedFiles.map((p) => <li class="mono" key={p}>{p}</li>)}</ul>}</div>}
      {error && <p class="error-text" role="alert">{error}</p>}
      {(error || result && !blocked) && <button type="button" disabled={busy} onClick={() => onRetarget(preview.target)}>重新获取操作预览</button>}
      {blocked && <>
        <p class="muted">临时保存包含暂存区、工作区及未跟踪文件。签出后尝试恢复暂存区布局；恢复冲突会保留备份并提供独立恢复入口。</p>
        <label class="navigation-check"><input type="checkbox" checked={confirmForce} disabled={busy} onChange={(e) => setConfirmForce(e.currentTarget.checked)} />确认强制签出将丢弃本地修改，并可能覆盖未跟踪文件</label>
      </>}
      <div class="modal-actions">
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        {blocked ? <>
          <button type="button" class="navigation-danger" disabled={disabled || !confirmForce} onClick={() => onRun(request('force'))}>强制签出</button>
          <button type="button" class="primary" disabled={disabled} onClick={() => onRun(request('backup'))}>临时保存修改后签出</button>
        </> : <button type="submit" class={reset && mode === 'hard' ? 'navigation-danger' : 'primary'} disabled={disabled}>{busy ? '处理中…' : reset ? `执行 Reset · ${mode}` : create ? '创建并签出分支' : '签出'}</button>}
      </div>
    </form>
  </Modal>;
}
