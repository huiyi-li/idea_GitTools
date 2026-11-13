import { useEffect, useRef, useState } from 'preact/hooks';
import { call, type Change } from './api';
import { Modal } from './ui/controls';
import { HunkLineEditor, changedLine } from './HunkLineEditor';

interface Preview {
  path: string;
  area: string;
  fingerprint: string;
  header: string;
  hunks: string[];
}

export function HunkDialog({
  root,
  path,
  area,
  onClose,
  onChanged,
}: {
  root: string;
  path: string;
  area: 'staged' | 'unstaged';
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [discardLines, setDiscardLines] = useState(false);
  const loadGeneration = useRef(0);
  async function load() {
    const generation = ++loadGeneration.current;
    try {
      const next = await call<Preview>('preview_hunks', { root, path, area });
      if (generation !== loadGeneration.current) return;
      setPreview(next);
      setError('');
      setDiscard(null);
      setSelected({});
      setIndex(0);
      setDiscardLines(false);
    } catch (error) {
      if (generation === loadGeneration.current) setError(String(error));
    }
  }
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [root, path, area]);
  async function apply(index: number, discard: boolean) {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      await call('apply_hunk', { root, preview, index, discard });
      await onChanged();
      await load();
    } catch (error) {
      setPreview(undefined);
      setError(String(error));
      await onChanged();
    } finally {
      setBusy(false);
    }
  }
  async function applyLines(discard: boolean) {
    if (!preview || busy) return;
    const selections = Object.entries(selected).filter(([, lines]) => lines.length).map(([hunk, lines]) => ({ hunk: Number(hunk), lines }));
    if (!selections.length) return;
    setBusy(true);
    setError('');
    try {
      await call('apply_hunk_lines', { root, preview, selections, discard });
      await onChanged();
      await load();
    } catch (error) {
      setPreview(undefined);
      setError(String(error));
      await onChanged().catch(error => setError(String(error)));
    } finally { setBusy(false); }
  }
  const count = Object.values(selected).reduce((sum, lines) => sum + lines.length, 0);
  return (
    <Modal
      title="按块与按行处理更改"
      busy={busy}
      onClose={onClose}
      class="history-dialog workflow-dialog"
    >
      <h2>
        {area === 'staged' ? '按块／按行取消暂存' : '按块／按行暂存'} · {path}
      </h2>
      <div class="hunk-list">
        {!!preview?.hunks.length && (
          <section class="hunk-item">
            <label>变化块<select aria-label="选择变化块" disabled={busy} value={index} onChange={event => { setIndex(Number(event.currentTarget.value)); setDiscard(null); setDiscardLines(false); }}>
              {preview.hunks.map((hunk, index) => <option key={index} value={index}>{index + 1} / {preview.hunks.length} · {hunk.split('\n')[0]}</option>)}
            </select></label>
            <HunkLineEditor text={preview.hunks[index]} selected={selected[index] ?? []} disabled={busy}
              onToggle={line => { setDiscardLines(false); setSelected(previous => {
                const lines = previous[index] ?? [];
                return { ...previous, [index]: lines.includes(line) ? lines.filter(value => value !== line) : [...lines, line] };
              }); }}
              onSelect={lines => { setDiscardLines(false); setSelected(previous => ({ ...previous, [index]: [...new Set([...(previous[index] ?? []), ...lines])] })); }} />
            <div class="modal-actions">
              <button disabled={busy} onClick={() => { setDiscardLines(false); setSelected(previous => ({ ...previous, [index]: preview.hunks[index].split('\n').flatMap((line, index) => changedLine(line) ? [index] : []) })); }}>选择此块全部变化行</button>
              <button disabled={busy} onClick={() => void apply(index, false)}>
                {area === 'staged' ? '取消暂存此块' : '暂存此块'}
              </button>
              {area === 'unstaged' && (
                <button disabled={busy} onClick={() => setDiscard(index)}>
                  放弃此块…
                </button>
              )}
              {discard === index && (
                <>
                  <span>确认恢复此块到暂存区版本？</span>
                  <button disabled={busy} onClick={() => void apply(index, true)}>
                    确认放弃此块
                  </button>
                  <button disabled={busy} onClick={() => setDiscard(null)}>
                    取消
                  </button>
                </>
              )}
            </div>
          </section>
        )}
        {preview && !preview.hunks.length && <p>没有可处理的文本变化块，可使用整文件操作。</p>}
      </div>
      {!!preview?.hunks.length && <>
        <p>已选 {count} 个变化行。新增行与删除行可分别选择，替换一行时可同时勾选对应的 − 和 + 行。</p>
        <div class="modal-actions">
          <button disabled={busy || !count} onClick={() => void applyLines(false)}>{area === 'staged' ? '取消暂存选中行' : '暂存选中行'}</button>
          <button disabled={busy || !count} onClick={() => { setSelected({}); setDiscardLines(false); }}>清除行选择</button>
          {area === 'unstaged' && <button disabled={busy || !count} onClick={() => { setDiscard(null); setDiscardLines(true); }}>放弃选中行…</button>}
        </div>
        {discardLines && <div class="confirmation">
          <p>确认将选中的 {count} 个变化行恢复到暂存区版本？选中新增文件的全部行会删除该文件。</p>
          <button disabled={busy || !count} onClick={() => void applyLines(true)}>确认放弃选中行</button>
          <button disabled={busy} onClick={() => setDiscardLines(false)}>取消</button>
        </div>}
      </>}
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      <div class="modal-actions">
        <button
          disabled={busy}
          onClick={() => void load().catch((error) => setError(String(error)))}
        >
          重新读取变化块
        </button>
        <button disabled={busy} onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}

export function AmendDialog({
  root,
  onClose,
  onChanged,
}: {
  root: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<{
    head: string;
    message: string;
    changes: Change[];
    fingerprint: string;
  }>();
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void call<{
      head: string;
      message: string;
      changes: Change[];
      fingerprint: string;
    }>('preview_amend', { root })
      .then((preview) => {
        if (current) {
          setPreview(preview);
          setMessage(preview.message);
        }
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [root]);
  return (
    <Modal title="Amend 最近提交" busy={busy} onClose={onClose} class="transport-dialog">
      <h2>Amend 最近提交</h2>
      <form
        class="transport-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!preview || busy) return;
          setBusy(true);
          setError('');
          void call('amend_commit', {
            root,
            expectedHead: preview.head,
            fingerprint: preview.fingerprint,
            message,
          })
            .then(async () => {
              await onChanged();
              onClose();
            })
            .catch((error) => setError(String(error)))
            .finally(() => setBusy(false));
        }}
      >
        <p>将替换提交 {preview?.head.slice(0, 12)}，提交 SHA 会改变。</p>
        <label>
          提交说明
          <textarea
            aria-label="Amend 提交说明"
            value={message}
            disabled={busy}
            onInput={(event) => setMessage(event.currentTarget.value)}
          />
        </label>
        <ul>
          {preview?.changes.map((change) => (
            <li key={change.path}>包含已暂存更改 · {change.path}</li>
          ))}
        </ul>
        <label>
          <input
            type="checkbox"
            checked={confirm}
            disabled={busy}
            onChange={(event) => setConfirm(event.currentTarget.checked)}
          />
          确认修改最近一次提交
        </label>
        {error && (
          <p class="error-text" role="alert">
            {error}
          </p>
        )}
        <div class="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button disabled={busy || !preview || !confirm || !message.trim()}>执行 Amend</button>
        </div>
      </form>
    </Modal>
  );
}
