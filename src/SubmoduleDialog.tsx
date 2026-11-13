import { useEffect, useState } from 'preact/hooks';
import { call, type SubmoduleStatus } from './api';
import { Modal } from './ui/controls';

export function SubmoduleDialog({ root, onClose, onChanged }: { root: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [items, setItems] = useState<SubmoduleStatus[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try { setItems(await call<SubmoduleStatus[]>('submodules', { root })); }
    catch (error) { setError(String(error)); }
  }
  useEffect(() => { void load(); }, [root]);
  async function update() {
    setBusy(true); setError('');
    try { await call('update_submodules', { root, paths: selected }); setSelected([]); await load(); await onChanged(); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Submodule 管理" onClose={onClose} busy={busy} class="history-dialog">
      <h2>Submodule 管理</h2>
      {!items.length && <p>当前仓库没有 Submodule。</p>}
      {!!items.length && <div class="submodule-list">
        {items.map(item => (
          <label class="submodule-row" key={item.path}>
            <input type="checkbox" checked={selected.includes(item.path)} disabled={busy} onChange={event => setSelected(previous => event.currentTarget.checked ? [...previous, item.path] : previous.filter(path => path !== item.path))} />
            <span class="submodule-state">{item.state}</span>
            <span class="mono ellipsis" title={item.path}>{item.path}</span>
            <small class="mono ellipsis" title={item.detail}>{item.commit.slice(0, 12)} {item.detail}</small>
          </label>
        ))}
      </div>}
      {error && <p class="error-text" role="alert">{error}</p>}
      <div class="modal-actions">
        <button disabled={busy} onClick={() => void load()}>重新读取</button>
        <button class="primary" disabled={busy || !items.length} onClick={() => void update()}>{selected.length ? `更新选中 (${selected.length})` : '初始化并更新全部'}</button>
        <button type="button" disabled={busy} onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}
