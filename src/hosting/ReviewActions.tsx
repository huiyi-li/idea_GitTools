import { useState } from 'preact/hooks';
import { call } from '../api';
import { Modal } from '../ui/controls';
import { TransportProgress } from '../TransportDialog';
import { NavigationDialog } from '../navigation/NavigationDialog';
import type { NavigationPreview, NavigationRequest, NavigationResult } from '../navigation/types';
import { useRemote } from './hooks';
import { RemoteMessage } from './HostingView';
import type { Comment, ReviewRequest } from './types';

interface Context {
  accountId: string;
  repository: string;
  number: number;
}
interface Thread {
  id: string;
  path: string;
  line: number | null;
  side: string;
  resolved: boolean;
  resolvable: boolean;
  outdated: boolean;
  truncated: boolean;
  notes: Comment[];
}

export function ReviewActions({
  args,
  review,
  provider,
  localRoot,
  onChanged,
  onOpen,
}: {
  args: Context;
  review: ReviewRequest;
  provider: 'github' | 'gitlab';
  localRoot: string;
  onChanged: () => void;
  onOpen: (path: string) => Promise<void>;
}) {
  const [opened, setOpened] = useState(false);
  const [body, setBody] = useState('');
  const [method, setMethod] = useState('merge');
  const [action, setAction] = useState('approve');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [protocol, setProtocol] = useState('https');
  const [alias, setAlias] = useState('');
  const [job, setJob] = useState<{ id: string; reference: string }>();
  const [navigation, setNavigation] = useState<NavigationPreview>();
  const [result, setResult] = useState<NavigationResult | null>(null);
  async function submit() {
    if (busy || !confirm) return;
    setBusy(true);
    setError('');
    try {
      await call('hosting_review_mutation', {
        accountId: args.accountId,
        repository: args.repository,
        request: {
          action,
          number: args.number,
          headSha: review.headSha,
          body,
          method,
        },
      });
      onChanged();
      setOpened(false);
      setConfirm(false);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function fetchBranch() {
    setBusy(true);
    setError('');
    try {
      setJob(
        await call<{ id: string; reference: string }>('fetch_review_branch', {
          root: localRoot,
          request: {
            ...args,
            headSha: review.headSha,
            protocol,
            sshAlias: alias,
          },
        }),
      );
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }
  async function previewCheckout(reference: string) {
    const preview = await call<NavigationPreview>('preview_navigation', {
      root: localRoot,
      target: reference,
      action: 'checkout',
    });
    if (preview.targetHash !== review.headSha) throw Error('远程请求已更新，请刷新详情后重试');
    setNavigation(preview);
    setResult(null);
  }
  async function checkout(request: NavigationRequest) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await call<NavigationResult>('execute_navigation', {
        root: localRoot,
        request,
      });
      setResult(result);
      if (result.completed) {
        await onOpen(localRoot);
        setNavigation(undefined);
        setOpened(false);
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button disabled={review.state !== 'open'} onClick={() => setOpened(true)}>
        审查、合并与签出
      </button>
      {opened && (
        <Modal
          title="审查、合并与签出"
          class="transport-dialog"
          busy={busy}
          onClose={() => setOpened(false)}
        >
          <h2>
            {args.repository} #{args.number}
          </h2>
          <p>当前请求提交 · {review.headSha.slice(0, 12)}</p>
          <form
            class="transport-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label>
              操作
              <select
                aria-label="审查操作"
                disabled={busy}
                value={action}
                onChange={(event) => {
                  setAction(event.currentTarget.value);
                  setConfirm(false);
                }}
              >
                <option value="approve">Approve · 批准</option>
                {provider === 'github' ? (
                  <option value="request-changes">Request changes · 请求修改</option>
                ) : (
                  <option value="unapprove">撤销批准</option>
                )}
                <option value="merge">合并请求</option>
              </select>
            </label>
            {provider === 'github' && action !== 'merge' && (
              <label>
                审查意见
                <textarea
                  aria-label="审查意见"
                  disabled={busy}
                  value={body}
                  onInput={(event) => setBody(event.currentTarget.value)}
                />
              </label>
            )}
            {action === 'merge' && (
              <label>
                合并方式
                <select
                  aria-label="请求合并方式"
                  disabled={busy}
                  value={method}
                  onChange={(event) => {
                    setMethod(event.currentTarget.value);
                    setConfirm(false);
                  }}
                >
                  <option value="merge">Merge</option>
                  <option value="squash">Squash</option>
                  {provider === 'github' && <option value="rebase">Rebase</option>}
                </select>
              </label>
            )}
            <label>
              <input
                type="checkbox"
                checked={confirm}
                disabled={busy}
                onChange={(event) => setConfirm(event.currentTarget.checked)}
              />
              确认对当前提交执行所选操作
            </label>
            <button
              disabled={
                busy ||
                !confirm ||
                (action === 'merge' && review.draft) ||
                (action === 'request-changes' && !body.trim())
              }
            >
              提交审查操作
            </button>
          </form>
          <h3>签出请求分支</h3>
          {!localRoot && <p>请先关联并打开本地仓库。</p>}
          <div class="transport-form">
            <label>
              传输方式
              <select
                disabled={busy}
                value={protocol}
                onChange={(event) => setProtocol(event.currentTarget.value)}
              >
                <option value="https">HTTPS</option>
                <option value="ssh">SSH</option>
              </select>
            </label>
            {protocol === 'ssh' && (
              <label>
                SSH Host 别名
                <input
                  disabled={busy}
                  value={alias}
                  onInput={(event) => setAlias(event.currentTarget.value)}
                />
              </label>
            )}
            <button disabled={busy || !localRoot} onClick={() => void fetchBranch()}>
              获取请求分支并预览签出
            </button>
          </div>
          {job && (
            <TransportProgress
              id={job.id}
              onIdle={(idle) => setBusy(!idle)}
              onDone={() => previewCheckout(job.reference)}
            />
          )}
          {error && (
            <p class="error-text" role="alert">
              {error}
            </p>
          )}
          <div class="modal-actions">
            <button disabled={busy} onClick={() => setOpened(false)}>
              关闭
            </button>
          </div>
        </Modal>
      )}
      {navigation && (
        <NavigationDialog
          preview={navigation}
          creating
          busy={busy}
          result={result}
          error={error}
          onClose={() => setNavigation(undefined)}
          onRun={(request) => void checkout(request)}
          onRetarget={(target) =>
            void previewCheckout(target).catch((error) => setError(String(error)))
          }
          onOpen={(path) => void onOpen(path)}
        />
      )}
    </>
  );
}

export function ReviewThreads({ args, review }: { args: Context; review: ReviewRequest }) {
  const [cursors, setCursors] = useState(['']);
  const cursor = cursors[cursors.length - 1];
  const threads = useRemote<{ items: Thread[]; nextCursor: string | null }>('hosting_threads', {
    ...args,
    cursor,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function mutate(thread: Thread, action: 'reply' | 'resolve') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await call('hosting_review_mutation', {
        accountId: args.accountId,
        repository: args.repository,
        request: {
          action,
          number: args.number,
          headSha: review.headSha,
          threadId: thread.id,
          body,
          resolved: !thread.resolved,
        },
      });
      setBody('');
      setSelected(null);
      threads.reload();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="hosting-scroll">
      <RemoteMessage loading={threads.loading} error={threads.error} onRetry={threads.reload} />
      {threads.value?.items.length === 0 && <p>暂无审查讨论。</p>}
      {threads.value?.items.map((thread) => (
        <section key={thread.id} class="hunk-item">
          <p>
            {thread.path} {thread.line ? `${thread.side} · ${thread.line}` : ''} ·{' '}
            {thread.resolved ? '已解决' : '未解决'} {thread.outdated ? '· 已过期' : ''}
          </p>
          {thread.notes.map((note) => (
            <article key={note.id}>
              <strong>{note.author}</strong> <small>{note.createdAt}</small>
              <pre class="hosting-description">{note.body}</pre>
            </article>
          ))}
          {thread.truncated && <p>此讨论显示前 100 条回复，完整讨论可在平台查看。</p>}
          <div class="modal-actions">
            <button
              disabled={busy}
              onClick={() => {
                setSelected(thread.id);
                setBody('');
              }}
            >
              回复讨论
            </button>
            {thread.resolvable && (
              <button disabled={busy} onClick={() => void mutate(thread, 'resolve')}>
                {thread.resolved ? '重新打开讨论' : '标记讨论已解决'}
              </button>
            )}
          </div>
          {selected === thread.id && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(thread, 'reply');
              }}
            >
              <textarea
                aria-label="讨论回复"
                value={body}
                disabled={busy}
                onInput={(event) => setBody(event.currentTarget.value)}
              />
              <button disabled={busy || !body.trim()}>发送回复</button>
            </form>
          )}
        </section>
      ))}
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      <div class="modal-actions">
        <button
          disabled={threads.loading || cursors.length === 1}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          上一页讨论
        </button>
        <button
          disabled={threads.loading || !threads.value?.nextCursor}
          onClick={() => setCursors([...cursors, threads.value!.nextCursor!])}
        >
          下一页讨论
        </button>
      </div>
    </section>
  );
}

export function InlineReview({
  args,
  review,
  path,
  oldPath,
  selected,
}: {
  args: Record<string, unknown>;
  review: ReviewRequest;
  path: string;
  oldPath: string;
  selected: { line: number; side: 'LEFT' | 'RIGHT' } | null;
}) {
  const [opened, setOpened] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <>
      <button
        disabled={!selected}
        onClick={() => {
          setOpened(true);
          setSent(false);
        }}
      >
        评论所选行
      </button>
      {opened && selected && (
        <Modal
          title="添加行内评论"
          class="transport-dialog"
          busy={busy}
          onClose={() => setOpened(false)}
        >
          <h2>
            {path} · {selected.side} · {selected.line}
          </h2>
          <form
            class="transport-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              void call('hosting_review_mutation', {
                accountId: args.accountId,
                repository: args.repository,
                request: {
                  action: 'inline',
                  number: review.number,
                  headSha: review.headSha,
                  baseSha: review.baseSha,
                  body,
                  path,
                  oldPath,
                  ...selected,
                },
              })
                .then(() => {
                  setBody('');
                  setSent(true);
                })
                .catch((error) => setError(String(error)))
                .finally(() => setBusy(false));
            }}
          >
            <textarea
              aria-label="行内评论"
              disabled={busy || sent}
              value={body}
              onInput={(event) => setBody(event.currentTarget.value)}
            />
            {sent && <p role="status">行内评论已发布，可在“审查讨论”中查看和回复。</p>}
            {error && (
              <p class="error-text" role="alert">
                {error}
              </p>
            )}
            <div class="modal-actions">
              <button type="button" disabled={busy} onClick={() => setOpened(false)}>
                关闭
              </button>
              <button disabled={busy || sent || !body.trim()}>发布行内评论</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
