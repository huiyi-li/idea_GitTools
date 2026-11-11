import { useEffect, useRef, useState } from 'preact/hooks';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { call } from '../api';
import { MergeEditor, type MergeEditorHandle } from './MergeEditor';
import type { MergeDocument, MergeOverview } from './protocol';
import './manager.css';
import { FileIcon, Icon, Split, ToolButton } from '../ui/controls';

type Confirmation = { kind: 'leave'; action: () => void } | { kind: 'abort' | 'skip' } | null;

export default function MergeManager({
  root,
  initialPath,
  onClose,
}: {
  root: string;
  initialPath: string;
  onClose: () => void;
}) {
  const [overview, setOverview] = useState<MergeOverview | null>(null);
  const [document, setDocument] = useState<MergeDocument | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [completed, setCompleted] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const editor = useRef<MergeEditorHandle>(null);
  const container = useRef<HTMLElement>(null);
  const confirmationRef = useRef(confirmation);
  confirmationRef.current = confirmation;
  const gate = useRef(false);
  const dirtyRef = useRef(false);
  const leave = useRef<(action: () => void) => void>();
  const saveCurrent = useRef<(finish: boolean) => Promise<boolean>>();

  function markDirty(value: boolean) {
    dirtyRef.current = value;
    setDirty(value);
  }

  async function run(label: string, job: () => Promise<void>) {
    if (gate.current) return false;
    gate.current = true;
    editor.current?.lock(true);
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await job();
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    } finally {
      editor.current?.lock(false);
      gate.current = false;
      setBusy('');
    }
  }

  async function refreshOverview() {
    const value = await call<MergeOverview>('merge_overview', { root });
    setOverview(value);
    return value;
  }

  async function load(path: string, allowLarge = false) {
    const value = await call<MergeDocument>('open_merge', { root, path, allowLarge });
    setDocument(value);
    setRemaining(Number.POSITIVE_INFINITY);
    markDirty(false);
  }

  function askLeave(action: () => void) {
    if (gate.current) return;
    if (dirtyRef.current) setConfirmation({ kind: 'leave', action });
    else action();
  }
  leave.current = askLeave;

  async function save(finish: boolean, choice = 'result') {
    if (!document || (choice === 'result' && (!editor.current || !Number.isFinite(remaining)))) return false;
    return run(finish ? '完成并暂存' : '保存进度', async () => {
      const progress = choice === 'result' ? editor.current!.progress() : null;
      await call('save_merge', { root, request: { id: document.id, finish, choice, progress } });
      markDirty(false);
      if (finish) {
        setCompleted((paths) => [...paths.filter((path) => path !== document.path), document.path]);
        const next = await refreshOverview();
        setDocument(null);
        if (next.files[0]) await load(next.files[0].path);
        else setNotice('所有冲突文件已暂存，可以继续 Git 操作或返回工作区检查。');
      } else setNotice('进度已写入工作区，冲突仍保留在 Git 暂存区。再次打开文件可恢复进度。');
    });
  }
  saveCurrent.current = save;

  async function operation(action: 'continue' | 'abort' | 'skip') {
    if (!overview) return;
    await run(
      action === 'continue' ? '继续 Git 操作' : action === 'skip' ? '跳过当前提交' : '中止 Git 操作',
      async () => {
        try {
          await call('merge_operation', { root, operationId: overview.operationId, action });
        } finally {
          setDocument(null);
          markDirty(false);
          const next = await refreshOverview();
          if (next.files[0]) await load(next.files[0].path);
        }
        setNotice(
          action === 'abort'
            ? 'Git 操作已中止。'
            : action === 'skip'
              ? '当前提交已跳过，状态已刷新。'
              : 'Git 操作已继续，状态已刷新。',
        );
      },
    );
  }

  useEffect(() => {
    let current = true;
    void run('读取冲突', async () => {
      const next = await refreshOverview();
      if (!current) return;
      const path = next.files.find((file) => file.path === initialPath)?.path ?? next.files[0]?.path;
      if (path) await load(path);
    });
    return () => {
      current = false;
    };
  }, [root]);

  useEffect(() => {
    const subscription = getCurrentWindow().onCloseRequested((event) => {
      if (gate.current) {
        event.preventDefault();
        return;
      }
      if (dirtyRef.current) {
        event.preventDefault();
        leave.current?.(() => void getCurrentWindow().close());
      }
    });
    void subscription.catch((error) => setError(String(error)));
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirmationRef.current) setConfirmation(null);
        else leave.current?.(onClose);
      }
      if (event.key === 'Tab') {
        const scope = container.current?.querySelector('.modal') ?? container.current;
        const controls = Array.from(
          scope?.querySelectorAll<HTMLElement>(
            'button, input, textarea, [tabindex="0"], [contenteditable="true"]',
          ) ?? [],
        ).filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null);
        const first = controls[0],
          last = controls[controls.length - 1];
        const focused = window.document.activeElement;
        if (first && (!scope?.contains(focused) || (!event.shiftKey && focused === last))) {
          event.preventDefault();
          first.focus();
        } else if (last && event.shiftKey && focused === first) {
          event.preventDefault();
          last.focus();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveCurrent.current?.(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      void subscription.then((unlisten) => unlisten()).catch(() => {});
      window.removeEventListener('keydown', key);
    };
  }, [root]);

  const hasOperation =
    !!overview && ['merge', 'rebase', 'cherry-pick', 'revert'].includes(overview.operation);
  return (
    <section ref={container} class="merge-manager" role="dialog" aria-modal="true" aria-label="合并管理器">
      <header class="merge-header">
        <Icon name="vcs/merge" />
        <strong>解决冲突</strong>
        <span class="muted">{overview?.operation === 'none' ? '工作区冲突' : overview?.operation}</span>
        <span>{overview?.files.length ?? 0} 个待处理文件</span>
        <span class="spacer" />
        <button
          disabled={!!busy}
          onClick={() =>
            askLeave(
              () =>
                void run('重新读取', async () => {
                  const next = await refreshOverview();
                  const path =
                    next.files.find((file) => file.path === document?.path)?.path ?? next.files[0]?.path;
                  setDocument(null);
                  if (path) await load(path);
                }),
            )
          }
        >
          重新读取
        </button>
        <button
          disabled={!!busy || !hasOperation || !!overview?.files.length}
          onClick={() => void operation('continue')}
        >
          继续 {overview?.operation === 'none' ? 'Git 操作' : overview?.operation}
        </button>
        <button
          disabled={!!busy || !hasOperation}
          onClick={() => askLeave(() => setConfirmation({ kind: 'abort' }))}
        >
          中止操作
        </button>
        {overview && ['rebase', 'cherry-pick', 'revert'].includes(overview.operation) && (
          <button disabled={!!busy} onClick={() => askLeave(() => setConfirmation({ kind: 'skip' }))}>
            跳过当前提交
          </button>
        )}
        <ToolButton
          icon="general/close"
          label="关闭合并管理器"
          disabled={!!busy}
          onClick={() => askLeave(onClose)}
        />
      </header>
      {error && (
        <div class="message error-message" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div class="message notice-message" role="status">
          {notice}
        </div>
      )}
      <div class="merge-layout">
        <Split storageKey="merge-files" initial={210} min={160} label="调整冲突文件栏宽度">
          <aside class="merge-files">
            <div class="panel-heading">
              <Icon name="general/chevronDown" />
              <span>未解决</span>
              <span class="count">{overview?.files.length ?? 0}</span>
            </div>
            {overview?.files.map((file) => (
              <button
                key={file.path}
                class={`merge-file ${document?.path === file.path ? 'selected' : ''}`}
                disabled={!!busy}
                onClick={() => {
                  if (file.path !== document?.path)
                    askLeave(() => void run('打开冲突', () => load(file.path)));
                }}
                title={file.path}
              >
                <FileIcon path={file.path} />
                <span class="merge-file-label">
                  <span class="ellipsis">{file.path.split('/').pop()}</span>
                  <small class="ellipsis">
                    {file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : file.kind}
                  </small>
                </span>
              </button>
            ))}
            {!!completed.length && (
              <>
                <div class="panel-heading">
                  <Icon name="general/greenCheckmark" />
                  已解决
                </div>
                {completed
                  .filter((path) => !overview?.files.some((file) => file.path === path))
                  .map((path) => (
                    <div class="merge-completed ellipsis" key={path} title={path}>
                      <Icon name="general/greenCheckmark" />
                      <span class="ellipsis">{path}</span>
                    </div>
                  ))}
              </>
            )}
          </aside>
          <div class="merge-content">
            {document ? (
              <>
                <div class="panel-heading">
                  <FileIcon path={document.path} />
                  <span class="mono ellipsis" title={document.path}>
                    {document.path}
                  </span>
                  <span class="muted">
                    {dirty ? '有未保存编辑' : document.progress ? '已恢复保存的进度' : '逐块处理后完成并暂存'}
                  </span>
                </div>
                {document.editable ? (
                  <MergeEditor
                    key={document.id}
                    ref={editor}
                    document={document}
                    busy={!!busy}
                    onStats={setRemaining}
                    onChange={() => {
                      if (!gate.current) markDirty(true);
                    }}
                  />
                ) : (
                  <div class="empty">
                    <p>{document.reason}</p>
                    {document.canLoad && (
                      <button
                        disabled={!!busy}
                        onClick={() => void run('加载大文件', () => load(document.path, true))}
                      >
                        加载大文件
                      </button>
                    )}
                  </div>
                )}
                <div class="merge-footer">
                  <button
                    disabled={!!busy}
                    title="使用整个左侧版本并暂存文件"
                    onClick={() => askLeave(() => void save(true, 'left'))}
                  >
                    {document.leftPresent ? '接受左侧' : '按左侧删除'}
                  </button>
                  <button
                    disabled={!!busy}
                    title="使用整个右侧版本并暂存文件"
                    onClick={() => askLeave(() => void save(true, 'right'))}
                  >
                    {document.rightPresent ? '接受右侧' : '按右侧删除'}
                  </button>
                  <span class="spacer" />
                  <button
                    class="save-progress"
                    title="保存到工作区并保留冲突处理进度 · Ctrl+S"
                    disabled={!!busy || !document.editable || !Number.isFinite(remaining)}
                    onClick={() => void save(false)}
                  >
                    <Icon name="general/save" />
                    保存进度
                  </button>
                  <button
                    class="primary"
                    disabled={!!busy || !document.editable || remaining > 0}
                    onClick={() => void save(true)}
                  >
                    完成并暂存
                  </button>
                </div>
              </>
            ) : (
              <div class="empty">
                {busy
                  ? `${busy}…`
                  : overview?.files.length
                    ? '选择一个冲突文件'
                    : '冲突文件已全部处理。继续 Git 操作后可能出现下一批冲突。'}
              </div>
            )}
          </div>
        </Split>
      </div>
      {confirmation && (
        <div class="modal-backdrop">
          <div class="modal" role="alertdialog" aria-modal="true">
            <h2>
              {confirmation.kind === 'abort'
                ? '中止当前 Git 操作？'
                : confirmation.kind === 'skip'
                  ? '跳过当前提交？'
                  : '保存当前文件的编辑？'}
            </h2>
            <p>
              {confirmation.kind === 'abort'
                ? 'Git 将回退本次操作，已写入的合并结果可能被还原。'
                : confirmation.kind === 'skip'
                  ? 'Git 将放弃当前提交的应用结果，并继续处理后续提交。'
                  : '可以保存到工作区并保留处理进度，再切换文件或关闭。'}
            </p>
            <div class="modal-actions">
              <button disabled={!!busy} onClick={() => setConfirmation(null)}>
                取消
              </button>
              {confirmation.kind !== 'leave' ? (
                <button
                  disabled={!!busy}
                  onClick={() => {
                    const action = confirmation.kind;
                    setConfirmation(null);
                    void operation(action);
                  }}
                >
                  {confirmation.kind === 'skip' ? '确认跳过' : '确认中止'}
                </button>
              ) : (
                <>
                  <button
                    disabled={!!busy}
                    onClick={() => {
                      const action = confirmation.action;
                      setConfirmation(null);
                      markDirty(false);
                      action();
                    }}
                  >
                    放弃未保存编辑
                  </button>
                  <button
                    class="primary"
                    disabled={!!busy}
                    onClick={() => {
                      const action = confirmation.action;
                      void save(false).then((success) => {
                        if (success) {
                          setConfirmation(null);
                          action();
                        }
                      });
                    }}
                  >
                    保存并继续
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
