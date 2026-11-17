import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { call, type SubmoduleStatus } from './api';
import { Modal, ToolButton } from './ui/controls';
import { useRepositoryRead } from './ui/useRepositoryRead';

export function SubmoduleDialog({ root, onClose, onChanged }: { root: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const { data: items, loading, error: readError, reload, isCurrent } = useRepositoryRead<SubmoduleStatus[]>('submodules', root);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const gate = useRef(false);
  useLayoutEffect(() => { setSelected([]); setConfirmation(null); setError(''); setNotice(''); }, [root]);
  useLayoutEffect(() => {
    if (items) setSelected(previous => previous.filter(path => items.some(item => item.path === path)));
    setConfirmation(null);
  }, [items]);

  async function update() {
    if (gate.current || loading || !items || confirmation === null) return;
    const paths = confirmation;
    gate.current = true;
    setBusy(true); setError(''); setNotice(''); setConfirmation(null);
    const errors: string[] = [];
    try {
      try { await call('update_submodules', { root, paths }); }
      catch (error) { errors.push(String(error)); }
      const refreshed = await reload();
      try { await onChanged(); }
      catch (error) { errors.push(`刷新仓库失败：${String(error)}`); }
      if (isCurrent()) {
        setSelected([]);
        setError(errors.join('\n'));
        if (!errors.length && refreshed) setNotice('子模块更新完成。');
      }
    } finally {
      gate.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  const locked = busy || loading;
  return (
    <Modal title="Submodule 管理" onClose={onClose} busy={busy} class="utility-dialog submodule-dialog">
      <header class="utility-heading">
        <div><h2>Submodule 管理</h2><p class="muted">查看子模块，并更新到父仓库记录的提交。</p></div>
        <ToolButton icon="general/close" label="关闭 Submodule 管理" disabled={busy} onClick={onClose} />
      </header>
      <p class="utility-root mono selectable" title={root}>{root}</p>
      {loading && <p class="utility-state" role="status">正在读取子模块…</p>}
      {readError && <p class="error-text utility-state" role="alert">读取子模块失败。请重新读取后再操作。{readError}</p>}
      {!loading && items?.length === 0 && <p class="utility-state">当前仓库没有 Submodule。</p>}
      {!!items?.length && <>
        <div class="utility-selection"><span>共 {items.length} 个，已选 {selected.length} 个</span>
          <button disabled={locked} onClick={() => { setSelected(items.map(item => item.path)); setConfirmation(null); }}>全选</button>
          <button disabled={locked || !selected.length} onClick={() => { setSelected([]); setConfirmation(null); }}>清除选择</button>
        </div>
        <div class="submodule-list" aria-label="子模块列表">
          {items.map(item => (
            <label class="submodule-row" key={item.path}>
              <input type="checkbox" aria-label={`选择子模块 ${item.path}`} checked={selected.includes(item.path)} disabled={locked}
                onChange={event => { const checked = event.currentTarget.checked; setConfirmation(null); setSelected(previous => checked ? [...new Set([...previous, item.path])] : previous.filter(path => path !== item.path)); }} />
              <span class="submodule-entry"><span class="mono selectable">{item.path}</span><small class="mono muted">{item.commit.slice(0, 12)} {item.detail}</small></span>
              <span class="submodule-state">{item.state}</span>
            </label>
          ))}
        </div>
      </>}
      {confirmation !== null && <section class="confirmation" aria-label="确认更新子模块">
        <p>将初始化并更新{confirmation.length ? `选中的 ${confirmation.length} 个子模块` : '全部子模块'}，包括其嵌套子模块。此操作可能访问网络，不使用强制覆盖。</p>
        {!!confirmation.length && <ul class="utility-paths mono">{confirmation.map(path => <li key={path}>{path}</li>)}</ul>}
        <div class="modal-actions"><button disabled={locked} onClick={() => setConfirmation(null)}>取消</button><button class="primary" disabled={locked} onClick={() => void update()}>确认更新</button></div>
      </section>}
      {error && <p class="error-text" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <footer class="modal-actions utility-actions">
        <button disabled={locked} onClick={() => { setNotice(''); setError(''); void reload(); }}>重新读取</button>
        <span class="spacer" />
        <button disabled={locked || !items?.length} onClick={() => setConfirmation([])}>更新全部…</button>
        <button class="primary" disabled={locked || !items?.length || !selected.length} onClick={() => setConfirmation([...selected])}>更新选中 ({selected.length})…</button>
        <button type="button" disabled={busy} onClick={onClose}>关闭</button>
      </footer>
    </Modal>
  );
}
