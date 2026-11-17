import { useRef, useState } from 'preact/hooks';
import { call } from './api';
import { Modal, ToolButton } from './ui/controls';
import { useRepositoryRead } from './ui/useRepositoryRead';

interface BisectStatus {
  active: boolean;
  start: string | null;
  current: string | null;
  log: string[];
}

export function BisectDialog({ root, onClose, onChanged }: { root: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const { data: status, loading, error: readError, reload, isCurrent } = useRepositoryRead<BisectStatus>('bisect_status', root);
  const [bad, setBad] = useState('');
  const [good, setGood] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const gate = useRef(false);
  async function run(action: string, args: Record<string, unknown> = {}) {
    if (gate.current || loading || !status) return;
    gate.current = true;
    setBusy(true); setError(''); setConfirmReset(false);
    const errors: string[] = [];
    try {
      try { await call(action, { root, ...args }); }
      catch (error) { errors.push(String(error)); }
      await reload();
      try { await onChanged(); }
      catch (error) { errors.push(`刷新仓库失败：${String(error)}`); }
      if (isCurrent()) setError(errors.join('\n'));
    } finally {
      gate.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  const locked = busy || loading;
  return (
    <Modal title="Git Bisect" onClose={onClose} busy={busy} class="utility-dialog bisect-dialog">
      <header class="utility-heading"><div><h2>Bisect · 定位问题提交</h2><p class="muted">通过测试中间版本，缩小引入问题的提交范围。</p></div>
        <ToolButton icon="general/close" label="关闭 Git Bisect" disabled={busy} onClick={onClose} /></header>
      <p class="utility-root mono selectable" title={root}>{root}</p>
      {loading && <p class="utility-state" role="status">正在读取 Bisect 状态…</p>}
      {readError && <p class="error-text utility-state" role="alert">读取 Bisect 状态失败。请重新读取后再操作。{readError}</p>}
      {status && !status.active && (
        <form class="transport-form" onSubmit={event => { event.preventDefault(); void run('bisect_start', { bad: bad.trim(), good: good.trim() }); }}>
          <p>填写已知有问题和正常版本的完整提交 SHA。开始后会切换工作区版本，请先提交或保存本地修改。</p>
          <label>有问题的提交（Bad）<input aria-label="Bisect bad commit" class="mono" placeholder="完整提交 SHA" value={bad} required maxLength={64} pattern="[0-9a-fA-F]{40}|[0-9a-fA-F]{64}" disabled={locked} onInput={event => setBad(event.currentTarget.value)} /></label>
          <label>正常的提交（Good）<input aria-label="Bisect good commit" class="mono" placeholder="完整提交 SHA" value={good} required maxLength={64} pattern="[0-9a-fA-F]{40}|[0-9a-fA-F]{64}" disabled={locked} onInput={event => setGood(event.currentTarget.value)} /></label>
          <div class="modal-actions"><button class="primary" disabled={locked || !bad.trim() || !good.trim() || bad.trim() === good.trim()}>开始定位</button></div>
        </form>
      )}
      {status?.active && <>
        <section class="utility-state"><strong>正在定位</strong><p>请测试当前提交，再标记结果。无法测试时可跳过。</p>
          <p>当前提交：<span class="mono selectable">{status.current ?? '无法读取'}</span></p>
          <p>返回位置：<span class="mono selectable">{status.start ?? '原始位置'}</span></p>
        </section>
        <div class="bisect-results">
          <button disabled={locked || confirmReset} onClick={() => void run('bisect_step', { action: 'good' })}>正常 · Good</button>
          <button disabled={locked || confirmReset} onClick={() => void run('bisect_step', { action: 'bad' })}>有问题 · Bad</button>
          <button disabled={locked || confirmReset} onClick={() => void run('bisect_step', { action: 'skip' })}>无法测试 · Skip</button>
        </div>
        <details class="utility-details"><summary>查看定位记录</summary><pre class="transport-log selectable">{status.log.join('\n') || '暂无记录'}</pre></details>
        {confirmReset && <section class="confirmation" aria-label="确认结束 Bisect"><p>结束本次定位并返回 {status.start ?? '原始位置'}？这会切换当前工作区版本，不会强制丢弃本地修改。</p>
          <div class="modal-actions"><button disabled={locked} onClick={() => setConfirmReset(false)}>取消</button><button disabled={locked} onClick={() => void run('bisect_reset')}>确认结束并返回</button></div>
        </section>}
      </>}
      {error && <p class="error-text" role="alert">{error}</p>}
      <footer class="modal-actions utility-actions">
        <button disabled={locked} onClick={() => { setError(''); setConfirmReset(false); void reload(); }}>重新读取</button><span class="spacer" />
        {status?.active && <button disabled={locked || confirmReset} onClick={() => setConfirmReset(true)}>结束定位并返回…</button>}
        <button type="button" disabled={busy} onClick={onClose}>关闭</button>
      </footer>
    </Modal>
  );
}
