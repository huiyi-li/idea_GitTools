import { useState } from 'preact/hooks';
import { call, type Commit } from './api';
import { Modal } from './ui/controls';
import { TransportProgress } from './TransportDialog';

interface Preview {
  head: string;
  branch: string;
  base: string | null;
  onto: string | null;
  commits: Commit[];
  mergeCount: number;
}
interface Entry {
  hash: string;
  action: string;
  message: string;
}

export function autosquash(entries: Entry[], commits: Commit[]) {
  const result = entries.map((entry) => ({ ...entry }));
  for (const commit of commits) {
    const match = /^(fixup|squash)! (.+)$/.exec(commit.subject);
    if (!match) continue;
    const targets = commits.filter(
      (candidate) =>
        candidate.hash !== commit.hash &&
        (candidate.subject === match[2] || candidate.hash.startsWith(match[2])),
    );
    if (targets.length !== 1) continue;
    const source = result.findIndex((entry) => entry.hash === commit.hash);
    const entry = result.splice(source, 1)[0];
    entry.action = match[1];
    let target = result.findIndex((entry) => entry.hash === targets[0].hash) + 1;
    while (target < result.length && ['fixup', 'squash'].includes(result[target].action)) target++;
    result.splice(target, 0, entry);
  }
  return result;
}

export function InteractiveRebase({
  root,
  initialBase = '',
  onClose,
  onChanged,
}: {
  root: string;
  initialBase?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [base, setBase] = useState(initialBase);
  const [onto, setOnto] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [id, setId] = useState('');
  async function load() {
    if (busy) return;
    setBusy(true);
    setError('');
    setConfirm(false);
    try {
      const preview = await call<Preview>('preview_interactive', {
        root,
        base,
        onto,
      });
      setPreview(preview);
      setEntries(
        preview.commits.map((commit) => ({
          hash: commit.hash,
          action: 'pick',
          message: '',
        })),
      );
    } catch (error) {
      setError(String(error));
      setPreview(undefined);
    } finally {
      setBusy(false);
    }
  }
  function update(index: number, values: Partial<Entry>) {
    setConfirm(false);
    setEntries(
      entries.map((entry, position) => (position === index ? { ...entry, ...values } : entry)),
    );
  }
  function move(index: number, destination: number) {
    const next = [...entries];
    next.splice(destination, 0, next.splice(index, 1)[0]);
    setEntries(next);
    setConfirm(false);
  }
  async function start() {
    if (!preview || busy || !confirm) return;
    setBusy(true);
    setError('');
    try {
      setId(await call<string>('start_interactive', { root, preview, entries }));
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="交互式 Rebase"
      busy={busy}
      onClose={onClose}
      class="history-dialog workflow-dialog"
    >
      <h2>交互式 Rebase</h2>
      <div class="transport-form">
        <label>
          保留至此提交（不参与重放，留空从根提交开始）
          <input
            aria-label="Rebase 起点"
            value={base}
            disabled={busy}
            placeholder="HEAD~3 或提交 SHA"
            onInput={(event) => {
              setBase(event.currentTarget.value);
              setPreview(undefined);
            }}
          />
        </label>
        <label>
          新的基底 --onto（可选）
          <input
            aria-label="Rebase onto"
            value={onto}
            disabled={busy}
            onInput={(event) => {
              setOnto(event.currentTarget.value);
              setPreview(undefined);
            }}
          />
        </label>
        <button disabled={busy} onClick={() => void load()}>
          读取提交计划
        </button>
      </div>
      {preview && (
        <>
          <p>
            {preview.branch} · {preview.head.slice(0, 12)} · {entries.length} 个提交
          </p>
          {!!preview.mergeCount && (
            <p>范围包含 {preview.mergeCount} 个合并提交，本次将按线性提交重放。</p>
          )}
          <button
            disabled={busy}
            onClick={() => {
              setEntries(autosquash(entries, preview.commits));
              setConfirm(false);
            }}
          >
            Autosquash
          </button>
          <div class="hunk-list">
            {entries.map((entry, index) => (
              <section class="hunk-item" key={entry.hash}>
                <div class="modal-actions">
                  <button
                    aria-label={`上移 ${entry.hash}`}
                    disabled={busy || index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`下移 ${entry.hash}`}
                    disabled={busy || index === entries.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    ↓
                  </button>
                  <select
                    aria-label={`Rebase 动作 ${entry.hash}`}
                    value={entry.action}
                    disabled={busy}
                    onChange={(event) => update(index, { action: event.currentTarget.value })}
                  >
                    {['pick', 'reword', 'squash', 'fixup', 'drop', 'edit'].map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </select>
                  <code>{entry.hash.slice(0, 8)}</code>
                  <span>
                    {preview.commits.find((commit) => commit.hash === entry.hash)?.subject}
                  </span>
                </div>
                {['reword', 'squash'].includes(entry.action) && (
                  <label>
                    {entry.action === 'reword'
                      ? '新的完整提交说明'
                      : '合并后的说明（留空沿用 Git 合并说明）'}
                    <textarea
                      disabled={busy}
                      value={entry.message}
                      onInput={(event) => update(index, { message: event.currentTarget.value })}
                    />
                  </label>
                )}
              </section>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              checked={confirm}
              disabled={busy}
              onChange={(event) => setConfirm(event.currentTarget.checked)}
            />
            确认按以上计划重写提交历史，原 HEAD 会保留恢复引用
          </label>
          <button disabled={busy || !confirm || !entries.length} onClick={() => void start()}>
            执行交互式 Rebase
          </button>
        </>
      )}
      {id && (
        <TransportProgress
          id={id}
          onIdle={(idle) => setBusy(!idle)}
          onFinished={onChanged}
          onDone={onClose}
        />
      )}
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      <div class="modal-actions">
        <button disabled={busy} onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
