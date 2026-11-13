import { useEffect, useState } from 'preact/hooks';
import { call } from './api';
import { Modal } from './ui/controls';

interface BisectStatus {
  active: boolean;
  start: string | null;
  current: string | null;
  log: string[];
}

export function BisectDialog({ root, onClose, onChanged }: { root: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<BisectStatus>();
  const [bad, setBad] = useState('');
  const [good, setGood] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    try { setStatus(await call<BisectStatus>('bisect_status', { root })); }
    catch (error) { setError(String(error)); }
  }
  useEffect(() => { void load(); }, [root]);
  async function run(action: string, args: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    try { await call(action, { root, ...args }); await load(); await onChanged(); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Git Bisect" onClose={onClose} busy={busy} class="history-dialog">
      <h2>Git Bisect</h2>
      {!status?.active ? (
        <form onSubmit={event => { event.preventDefault(); void run('bisect_start', { bad, good }); }}>
          <p>Use the bad commit and a known good commit to find the first bad commit.</p>
          <label>Bad commit<input aria-label="Bisect bad commit" value={bad} required disabled={busy} onInput={event => setBad(event.currentTarget.value)} /></label>
          <label>Good commit<input aria-label="Bisect good commit" value={good} required disabled={busy} onInput={event => setGood(event.currentTarget.value)} /></label>
          <div class="modal-actions"><button disabled={busy}>Start Bisect</button></div>
        </form>
      ) : (
        <>
          <p>Bisect is active. Test the current commit, then mark the result.</p>
          <p class="mono selectable">Current: {status.current ?? 'unknown'}</p>
          <div class="modal-actions">
            <button disabled={busy} onClick={() => void run('bisect_step', { action: 'good' })}>Good</button>
            <button disabled={busy} onClick={() => void run('bisect_step', { action: 'bad' })}>Bad</button>
            <button disabled={busy} onClick={() => void run('bisect_step', { action: 'skip' })}>Skip</button>
            <button disabled={busy} onClick={() => void run('bisect_reset')}>Reset</button>
          </div>
          {!!status.log.length && <pre class="transport-log selectable">{status.log.join('\n')}</pre>}
        </>
      )}
      {error && <p class="error-text" role="alert">{error}</p>}
      <div class="modal-actions"><button type="button" disabled={busy} onClick={onClose}>Close</button></div>
    </Modal>
  );
}
