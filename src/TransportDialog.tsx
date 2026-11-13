import { useEffect, useRef, useState } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-dialog';
import { call, readSaved, save } from './api';
import { Modal } from './ui/controls';

interface Progress {
  id: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  directory: string;
  lines: string[];
  error: string;
  prompt: {
    id: number;
    message: string;
    secret: boolean;
    confirmation: boolean;
  } | null;
}

export function TransportProgress({
  id,
  onDone,
  onIdle,
  onFinished,
}: {
  id: string;
  onDone: (directory: string) => void | Promise<void>;
  onIdle: (idle: boolean) => void;
  onFinished?: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<Progress>();
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [answering, setAnswering] = useState(false);
  const done = useRef(false);
  const callbacks = useRef({ onDone, onIdle, onFinished });
  callbacks.current = { onDone, onIdle, onFinished };
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    done.current = false;
    setProgress(undefined);
    callbacks.current.onIdle(false);
    async function poll() {
      try {
        const next = await call<Progress>('transport_progress', { id });
        if (disposed) return;
        setProgress(next);
        setError('');
        if (next.state === 'running') timer = setTimeout(poll, 350);
        else {
          callbacks.current.onIdle(true);
          if (!done.current) {
            done.current = true;
            await callbacks.current.onFinished?.();
            if (next.state === 'done') await callbacks.current.onDone(next.directory);
          }
        }
      } catch (error) {
        if (disposed) return;
        setError(String(error));
        timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [id]);
  useEffect(() => setAnswer(''), [progress?.prompt?.id]);
  async function respond(value: string) {
    if (!progress?.prompt || answering) return;
    setAnswering(true);
    try {
      await call('answer_transport', {
        id,
        promptId: progress.prompt.id,
        value,
      });
      setAnswer('');
    } catch (error) {
      setError(String(error));
    } finally {
      setAnswering(false);
    }
  }
  return (
    <section aria-label="Git 传输进度">
      <p role="status">
        {progress?.state === 'done'
          ? 'Git 操作完成'
          : progress?.state === 'cancelled'
            ? '已取消'
            : progress?.state === 'error'
              ? 'Git 操作失败'
              : '正在执行 Git 操作…'}
      </p>
      <pre class="transport-log" aria-label="传输日志">
        {progress?.lines.join('\n')}
      </pre>
      {progress?.prompt && (
        <form
          class="transport-auth"
          onSubmit={(event) => {
            event.preventDefault();
            void respond(answer);
          }}
        >
          <p class="mono">{progress.prompt.message}</p>
          {progress.prompt.confirmation ? (
            <div class="modal-actions">
              <button type="button" disabled={answering} onClick={() => void respond('no')}>
                拒绝连接
              </button>
              <button type="button" disabled={answering} onClick={() => void respond('yes')}>
                确认主机指纹
              </button>
            </div>
          ) : (
            <label>
              Git 认证
              <input
                autoFocus
                type={progress.prompt.secret ? 'password' : 'text'}
                autoComplete="off"
                value={answer}
                disabled={answering}
                onInput={(event) => setAnswer(event.currentTarget.value)}
              />
              <button disabled={answering || !answer}>继续认证</button>
            </label>
          )}
        </form>
      )}
      {(error || progress?.error) && (
        <p class="error-text" role="alert">
          {error || progress?.error}
        </p>
      )}
      {(!progress || progress.state === 'running') && (
        <button
          onClick={() =>
            void call('cancel_transport', { id }).catch((error) => setError(String(error)))
          }
        >
          取消 Git 操作
        </button>
      )}
    </section>
  );
}

export function CloneDialog({
  initialUrl = '',
  onOpen,
  onClose,
}: {
  initialUrl?: string;
  onOpen: (path: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [parent, setParent] = useState(() => readSaved<string>('clone.parent', ''));
  const [directory, setDirectory] = useState(() => directoryName(initialUrl));
  const [depth, setDepth] = useState('');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState('');
  const edited = useRef(false);
  const savedHistory = readSaved<unknown>('clone.history', []);
  const history = Array.isArray(savedHistory)
    ? savedHistory.filter((value): value is string => typeof value === 'string')
    : [];
  async function start() {
    if (busy) return;
    setBusy(true);
    setError('');
    setCompleted('');
    try {
      const id = await call<string>('start_clone', {
        request: {
          url: url.trim(),
          parent,
          directory,
          depth: depth ? Number(depth) : null,
        },
      });
      save('clone.parent', parent);
      save(
        'clone.history',
        [url.trim(), ...history.filter((value) => value !== url.trim())].slice(0, 12),
      );
      setId(id);
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }
  async function openCompleted(path: string) {
    setBusy(true);
    setCompleted(path);
    try {
      const result = await onOpen(path);
      if (result === false) throw Error('克隆成功，打开仓库失败，可点击下方按钮重新打开');
      onClose();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="克隆仓库" busy={busy} onClose={onClose} class="transport-dialog">
      <h2>克隆仓库</h2>
      <form
        class="transport-form"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <label>
          仓库地址
          <input
            aria-label="仓库地址"
            list="clone-history"
            required
            disabled={busy}
            placeholder="git@github_ming:owner/repo.git 或 https://host/repo.git"
            value={url}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setUrl(value);
              if (!edited.current) setDirectory(directoryName(value));
            }}
          />
          <datalist id="clone-history">
            {history.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label>
          父目录
          <input
            aria-label="克隆父目录"
            required
            disabled={busy}
            value={parent}
            onInput={(event) => setParent(event.currentTarget.value)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void open({
                directory: true,
                multiple: false,
                title: '选择克隆父目录',
              })
                .then((path) => {
                  if (typeof path === 'string') setParent(path);
                })
                .catch((error) => setError(String(error)))
            }
          >
            选择目录
          </button>
        </label>
        <label>
          目录名称
          <input
            aria-label="克隆目录名称"
            required
            disabled={busy}
            value={directory}
            onInput={(event) => {
              edited.current = true;
              setDirectory(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          浅克隆深度（留空为完整历史）
          <input
            type="number"
            min="1"
            step="1"
            disabled={busy}
            value={depth}
            onInput={(event) => setDepth(event.currentTarget.value)}
          />
        </label>
        {error && (
          <p class="error-text" role="alert">
            {error}
          </p>
        )}
        <div class="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            关闭
          </button>
          {completed ? (
            <button type="button" onClick={() => void openCompleted(completed)}>
              打开已克隆仓库
            </button>
          ) : (
            <button class="primary" disabled={busy || !url.trim() || !parent || !directory.trim()}>
              {id ? '重新克隆' : '开始克隆'}
            </button>
          )}
        </div>
      </form>
      {id && <TransportProgress id={id} onIdle={(idle) => setBusy(!idle)} onDone={openCompleted} />}
    </Modal>
  );
}

function directoryName(value: string) {
  return (
    value
      .trim()
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, '') ?? ''
  );
}
