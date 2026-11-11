import { useEffect, useState } from 'preact/hooks';
import { call } from '../api';
import { Modal } from '../ui/controls';
import type { RecoveryOverview, ReflogEntry } from './types';

const phases: Record<string, string> = { preparing: '准备中', saving: '临时保存中', saved: '已保存', executing: '执行中', restoring: '恢复本地修改中', 'restore-blocked': '恢复本地修改受阻', 'backup-ready': '本地修改备份可恢复', interrupted: '操作中断，请核对状态', completed: '完成', failed: '失败', 'failed-restored': '操作失败，本地修改已恢复' };

export function RecoveryDialog({ root, overview, busy, error, onClose, onRestore, onResolve, onConflicts, onBranch, onCheckout }: {
  root: string;
  overview: RecoveryOverview | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onRestore: (id: string) => void;
  onResolve: (id: string) => void;
  onConflicts: () => void;
  onBranch: (hash: string, name: string) => Promise<boolean>;
  onCheckout: (hash: string) => void;
}) {
  const [entries, setEntries] = useState<ReflogEntry[]>([]);
  const [loadError, setLoadError] = useState('');
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {
    let current = true;
    void call<ReflogEntry[]>('read_reflog', { root }).then((value) => { if (current) setEntries(value); }).catch((e) => { if (current) setLoadError(String(e)); });
    return () => { current = false; };
  }, [root, overview]);
  const choose = (hash: string) => { setChosen(hash); setName(`recovery/${hash.slice(0, 8)}`); };
  return <Modal title="操作恢复与 Reflog" busy={busy} onClose={onClose} class="history-dialog recovery-dialog">
    <h2>操作恢复与 Reflog</h2>
    {overview?.operation !== 'none' && overview?.operation && <div class="navigation-warning"><p>{overview.operation} · {overview.progress} · {overview.reason}</p><button disabled={busy} onClick={onConflicts}>处理暂停或冲突</button>{overview.originalHead && <button disabled={busy} onClick={() => choose(overview.originalHead!)}>从原 HEAD 创建恢复分支</button>}</div>}
    <div class="recovery-scroll">
      {overview?.records.map((record) => <article class="recovery-record" key={record.id}>
        <strong>{record.action === 'checkout' ? '签出' : 'Reset'} · {phases[record.phase] ?? record.phase}</strong>
        <p>{record.originalBranch ?? 'Detached HEAD'} <span class="mono">{record.originalHead?.slice(0, 8)} → {record.targetHash.slice(0, 8)}</span></p>
        {record.stashSha && <p class="muted">备份 Stash · <span class="mono">{record.stashSha}</span>（完成后仍保留存档）</p>}
        {record.error && <p class="error-text navigation-error">{record.failureKind && `${record.failureKind} · `}{record.error}</p>}
        {!!record.blockedFiles.length && <ul class="navigation-files">{record.blockedFiles.map((p) => <li key={p}>{p}</li>)}</ul>}
        <div class="recovery-actions">
          {record.originalHead && <button disabled={busy} onClick={() => choose(record.originalHead!)}>从原 HEAD 创建恢复分支</button>}
          {record.stashSha && !['completed', 'failed-restored'].includes(record.phase) && <button disabled={busy || overview.operation !== 'none'} onClick={() => onRestore(record.id)}>恢复本地修改及暂存布局</button>}
          {record.phase !== 'completed' && <button disabled={busy} onClick={() => onResolve(record.id)}>已核对或手动恢复，标记完成</button>}
        </div>
      </article>)}
      {!overview?.records.length && <p class="muted">暂无应用操作记录。可通过下方 Reflog 找回历史提交。</p>}
      <h3>HEAD Reflog · 最近 200 条</h3>
      <p class="muted">恢复分支保留提交历史；未提交内容使用关联的 Stash 备份恢复。</p>
      {entries.map((entry, index) => <div class="reflog-entry" key={`${entry.reference}-${index}`}>
        <span class="mono">{entry.reference} · {entry.hash.slice(0, 8)}</span><span>{entry.subject}</span>
        <button disabled={busy} onClick={() => choose(entry.hash)}>创建恢复分支</button><button disabled={busy} onClick={() => onCheckout(entry.hash)}>签出</button>
      </div>)}
    </div>
    {chosen && <form class="recovery-create" onSubmit={(e) => { e.preventDefault(); void onBranch(chosen, name.trim()).then((success) => { if (success) setChosen(''); }); }}>
      <label>恢复分支名称 · {chosen.slice(0, 8)}<input aria-label="恢复分支名称" required value={name} disabled={busy} onInput={(e) => setName(e.currentTarget.value)} /></label><button class="primary" disabled={busy || !name.trim()}>创建恢复分支</button>
    </form>}
    {(error || loadError) && <p class="error-text" role="alert">{error || loadError}</p>}
    <div class="modal-actions"><button disabled={busy} onClick={onClose}>关闭</button></div>
  </Modal>;
}
