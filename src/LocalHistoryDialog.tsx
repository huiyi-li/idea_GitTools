import { useEffect, useState } from 'preact/hooks';
import { call, type LocalHistoryEntry, type LocalHistorySnapshot } from './api';
import { Modal } from './ui/controls';

export function LocalHistoryDialog({ root, initialPath = '', onClose, onChanged }: {
  root: string;
  initialPath?: string;
  onClose: () => void;
  onChanged?: () => Promise<void>;
}) {
  const [input, setInput] = useState(initialPath);
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<LocalHistoryEntry[]>([]);
  const [selected, setSelected] = useState<LocalHistorySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(nextPath = path) {
    if (!nextPath.trim()) return;
    setBusy(true);
    setError('');
    try {
      const value = await call<LocalHistoryEntry[]>('local_history_list', { root, path: nextPath.trim() });
      setPath(nextPath.trim());
      setEntries(value);
      setSelected(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialPath) void load(initialPath);
  }, [root, initialPath]);

  async function capture() {
    if (!path.trim()) return;
    setBusy(true);
    setError('');
    try {
      await call('local_history_capture', { root, path: path.trim(), reason: '手动保存快照' });
      await load(path);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function show(entry: LocalHistoryEntry) {
    setBusy(true);
    setError('');
    try {
      setSelected(await call<LocalHistorySnapshot>('local_history_read', { root, path: entry.path, id: entry.id }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restoreEntry(entry: LocalHistoryEntry) {
    setBusy(true);
    setError('');
    try {
      await call('local_history_restore', { root, path: entry.path, id: entry.id });
      await onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (selected) await restoreEntry(selected.entry);
  }

  return (
    <Modal title="Local History" onClose={onClose} busy={busy} class="history-dialog workflow-dialog">
      <h2>Local History</h2>
      <form class="modal-actions" onSubmit={(event) => { event.preventDefault(); void load(input); }}>
        <input aria-label="本地历史文件路径" value={input} disabled={busy} onInput={(event) => setInput(event.currentTarget.value)} placeholder="仓库相对路径" />
        <button type="submit" disabled={busy || !input.trim()}>读取历史</button>
        <button type="button" disabled={busy || !path.trim()} onClick={() => void capture()}>保存当前快照</button>
      </form>
      {error && <p class="error-text" role="alert">{error}</p>}
      {!busy && path && !entries.length && <p class="muted">此文件还没有 Local History 快照。</p>}
      <div class="hunk-list">
        {entries.map((entry) => (
          <section class="hunk-item" key={entry.id}>
            <div><code>{new Date(entry.timestamp).toLocaleString('zh-CN')}</code> · {entry.reason}</div>
            <small>{entry.path} · {entry.size} bytes{entry.binary ? ' · 二进制' : ''}</small>
            <div class="modal-actions">
              <button disabled={busy} onClick={() => void show(entry)}>查看快照</button>
              <button disabled={busy} onClick={() => void restoreEntry(entry)}>恢复到工作区</button>
            </div>
          </section>
        ))}
      </div>
      {selected && (
        <div class="local-history-preview">
          <div class="modal-actions"><strong>快照预览</strong><span class="spacer" /><button disabled={busy} onClick={() => void restore()}>恢复此快照</button></div>
          <pre>{selected.entry.binary ? '[二进制文件快照]' : selected.content}</pre>
        </div>
      )}
      <div class="modal-actions"><button disabled={busy} onClick={onClose}>关闭</button></div>
    </Modal>
  );
}

