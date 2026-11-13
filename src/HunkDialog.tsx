import { useEffect, useState } from 'preact/hooks';
import { call, type Change } from './api';
import { Modal } from './ui/controls';

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
  async function load() {
    setPreview(await call<Preview>('preview_hunks', { root, path, area }));
    setError('');
    setDiscard(null);
  }
  useEffect(() => {
    void load().catch((error) => setError(String(error)));
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
  return (
    <Modal
      title="按块处理更改"
      busy={busy}
      onClose={onClose}
      class="history-dialog workflow-dialog"
    >
      <h2>
        {area === 'staged' ? '按块取消暂存' : '按块暂存'} · {path}
      </h2>
      <div class="hunk-list">
        {preview?.hunks.map((hunk, index) => (
          <section key={index} class="hunk-item">
            <pre>{hunk}</pre>
            <div class="modal-actions">
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
        ))}
        {preview && !preview.hunks.length && <p>没有可处理的文本变化块，可使用整文件操作。</p>}
      </div>
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
