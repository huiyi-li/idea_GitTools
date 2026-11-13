import { useEffect, useRef, useState } from 'preact/hooks';
import { call, type FileDiff } from '../api';
import { DiffEditors } from '../DiffView';
import { MergeAnalysis } from '../merge/analysis-client';
import type { PreparedDiff } from '../merge/analysis';
import { FileIcon, Modal, Split, ToolButton } from '../ui/controls';
import { Pagination, RemoteMessage } from './HostingView';
import { useRemote, useRemotePage } from './hooks';
import { ReviewActions, ReviewThreads, InlineReview } from './ReviewActions';
import {
  reviewName,
  stateLabel,
  type Account,
  type HostedRepository,
  type ReviewRequest,
  type ReviewFile,
  type ReviewCommit,
  type Comment,
  type Check,
} from './types';

export function ReviewList({
  account,
  repository,
  localRoot = '',
  onOpen = async () => {},
}: {
  account: Account;
  repository: HostedRepository;
  localRoot?: string;
  onOpen?: (path: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const reviews = useRemotePage<ReviewRequest>('hosting_reviews', {
    accountId: account.id,
    repository: repository.path,
    filter,
  });
  const number = selected ?? reviews.value?.items[0]?.number;
  return (
    <div class="hosting-review-workspace">
      <header class="hosting-toolbar">
        <strong>{account.provider === 'github' ? 'Pull Requests' : 'Merge Requests'}</strong>
        <select
          aria-label="请求状态"
          value={filter}
          onChange={(event) => {
            setFilter(event.currentTarget.value);
            setSelected(null);
          }}
        >
          <option value="open">待合并</option>
          <option value="closed">已关闭</option>
          <option value="all">全部</option>
        </select>
        <input
          aria-label="筛选本页请求"
          placeholder="筛选本页请求"
          value={search}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
        <span class="spacer" />
        <ToolButton
          icon="general/refresh"
          label="刷新请求列表"
          disabled={reviews.loading}
          onClick={reviews.reload}
        />
        <button onClick={() => setCreating(true)}>创建 {reviewName(account.provider)}</button>
      </header>
      <Split storageKey="hosting-reviews" initial={280} min={190} label="调整请求列表宽度">
        <section class="hosting-review-list">
          <RemoteMessage loading={reviews.loading} error={reviews.error} onRetry={reviews.reload} />
          <div class="hosting-list" role="listbox" aria-label="PR / MR 列表">
            {reviews.value?.items
              .filter((item) =>
                `${item.number} ${item.title} ${item.author}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((item) => (
                <button
                  class={'hosting-review-row ' + (number === item.number ? 'selected' : '')}
                  key={item.number}
                  role="option"
                  aria-selected={number === item.number}
                  onClick={() => setSelected(item.number)}
                >
                  <strong>{item.title}</strong>
                  <small>
                    #{item.number} · {item.author} · {stateLabel(item)}
                  </small>
                  <small>
                    {item.sourceBranch} → {item.targetBranch}
                  </small>
                </button>
              ))}
            {reviews.value?.items.length === 0 && <div class="empty">暂无请求</div>}
          </div>
          <Pagination {...reviews} hasMore={reviews.value?.hasMore} />
        </section>
        {number ? (
          <ReviewDetails
            key={number}
            account={account}
            repository={repository}
            number={number}
            onChanged={reviews.reload}
            localRoot={localRoot}
            onOpen={onOpen}
          />
        ) : (
          <div class="empty">选择请求查看详情</div>
        )}
      </Split>
      {creating && (
        <CreateDialog
          account={account}
          repository={repository}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            setCreating(false);
            setSelected(item.number);
            reviews.reload();
          }}
        />
      )}
    </div>
  );
}

function ReviewDetails({
  account,
  repository,
  number,
  onChanged,
  localRoot,
  onOpen,
}: {
  account: Account;
  repository: HostedRepository;
  number: number;
  onChanged: () => void;
  localRoot: string;
  onOpen: (path: string) => Promise<void>;
}) {
  const args = { accountId: account.id, repository: repository.path, number };
  const details = useRemote<ReviewRequest>('hosting_review', args);
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const gate = useRef(false);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const review = details.value;
  async function changeState(action: string) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError('');
    setConfirmation('');
    try {
      await call('hosting_change_state', { ...args, action });
      if (active.current) {
        details.reload();
        onChanged();
      }
    } catch (error) {
      if (active.current) setError(String(error));
    } finally {
      gate.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section class="hosting-review-details">
      <RemoteMessage loading={details.loading} error={details.error} onRetry={details.reload} />
      {review && (
        <>
          <header class="hosting-review-heading">
            <h2>{review.title}</h2>
            <div class="hosting-toolbar">
              <span class={'hosting-state ' + review.state}>{stateLabel(review)}</span>
              <span>
                #{number} · {review.author}
              </span>
              <span class="spacer" />
              <ReviewActions args={args} review={review} provider={account.provider} localRoot={localRoot} onChanged={() => { details.reload(); onChanged(); }} onOpen={onOpen} />
              <ToolButton
                icon="general/refresh"
                label="刷新请求详情"
                disabled={busy || details.loading}
                onClick={details.reload}
              />
              <button
                onClick={() =>
                  void call('hosting_open_url', {
                    accountId: account.id,
                    url: review.webUrl,
                  }).catch((error) => setError(String(error)))
                }
              >
                浏览器
              </button>
              {review.state !== 'merged' && (
                <button
                  disabled={busy}
                  onClick={() => setConfirmation(review.state === 'open' ? 'close' : 'reopen')}
                >
                  {review.state === 'open' ? '关闭请求' : '重新打开'}
                </button>
              )}
            </div>
            <div class="muted selectable">
              {review.sourceBranch} → {review.targetBranch} · {review.headSha.slice(0, 8)}
            </div>
            {review.mergeStatus && <div class="muted">平台合并状态 · {review.mergeStatus}</div>}
          </header>
          <nav class="hosting-tabs" aria-label="请求详情">
            {[
              ['overview', '概览与讨论'],
              ['commits', '提交'],
              ['files', '变更文件'],
              ['checks', 'CI 状态'],
              ['threads', '审查讨论'],
            ].map(([id, label]) => (
              <button
                key={id}
                class={tab === id ? 'active' : ''}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          {error && (
            <div class="hosting-error" role="alert">
              {error}
            </div>
          )}
          {confirmation && (
            <div class="hosting-confirm" role="alertdialog" aria-label="确认远程请求操作">
              <span>
                确认{confirmation === 'close' ? '关闭' : '重新打开'} {repository.path} #{number}？
              </span>
              <button onClick={() => setConfirmation('')}>取消</button>
              <button onClick={() => void changeState(confirmation)}>
                确认{confirmation === 'close' ? '关闭' : '重新打开'}
              </button>
            </div>
          )}
          {tab === 'overview' && (
            <div class="hosting-scroll">
              <pre class="hosting-description">{review.body || '暂无说明'}</pre>
              <Comments key={review.updatedAt} args={args} />
            </div>
          )}
          {tab === 'commits' && <Commits args={args} />}
          {tab === 'files' && <Files args={args} review={review} />}
          {tab === 'checks' && <Checks args={args} />}
          {tab === 'threads' && <ReviewThreads args={args} review={review} />}
        </>
      )}
    </section>
  );
}

function Comments({ args }: { args: Record<string, unknown> }) {
  const comments = useRemotePage<Comment>('hosting_comments', args);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const gate = useRef(false);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  return (
    <section class="hosting-comments">
      <h3>讨论</h3>
      <RemoteMessage loading={comments.loading} error={comments.error} onRetry={comments.reload} />
      {comments.value?.items.map((item) => (
        <article key={item.id}>
          <div class="muted">
            {item.author} · {item.createdAt}
          </div>
          <pre>{item.body}</pre>
        </article>
      ))}
      {comments.value?.items.length === 0 && <p class="muted">暂无评论</p>}
      <Pagination {...comments} hasMore={comments.value?.hasMore} />
      <form
        class="hosting-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (gate.current || !body.trim()) return;
          gate.current = true;
          setBusy(true);
          setError('');
          setNotice('');
          void call('hosting_comment', { ...args, body })
            .then(() => {
              if (active.current) {
                setBody('');
                setNotice('评论已发布');
                comments.reload();
              }
            })
            .catch((error) => {
              if (active.current) setError(String(error));
            })
            .finally(() => {
              gate.current = false;
              if (active.current) setBusy(false);
            });
        }}
      >
        <label>
          新评论
          <textarea
            required
            rows={4}
            maxLength={65536}
            value={body}
            disabled={busy}
            onInput={(event) => setBody(event.currentTarget.value)}
          />
        </label>
        {error && (
          <p class="error-text" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div class="modal-actions">
          <button class="primary" disabled={busy || !body.trim()}>
            {busy ? '正在发布…' : '发布评论'}
          </button>
        </div>
      </form>
    </section>
  );
}

function Commits({ args }: { args: Record<string, unknown> }) {
  const commits = useRemotePage<ReviewCommit>('hosting_commits', args);
  return (
    <div class="hosting-scroll">
      <RemoteMessage loading={commits.loading} error={commits.error} onRetry={commits.reload} />
      {commits.value?.items.map((item) => (
        <article class="hosting-commit" key={item.sha}>
          <code>{item.sha.slice(0, 8)}</code>
          <span>{item.title}</span>
          <small class="muted">{item.author}</small>
        </article>
      ))}
      <Pagination {...commits} hasMore={commits.value?.hasMore} />
    </div>
  );
}

function Checks({ args }: { args: Record<string, unknown> }) {
  const checks = useRemote<Check[]>('hosting_checks', args);
  return (
    <div class="hosting-scroll">
      <div class="hosting-toolbar">
        <h3>CI 状态</h3>
        <span class="spacer" />
        <button disabled={checks.loading} onClick={checks.reload}>
          刷新 CI
        </button>
      </div>
      <RemoteMessage loading={checks.loading} error={checks.error} onRetry={checks.reload} />
      {checks.value?.map((item, index) => (
        <article class="hosting-check" key={index}>
          <strong>{item.name}</strong>
          <code>{item.state || '未知'}</code>
        </article>
      ))}
      {checks.value?.length === 0 && <p class="muted">暂无 CI 记录</p>}
    </div>
  );
}

function Files({ args, review }: { args: Record<string, unknown>; review: ReviewRequest }) {
  const files = useRemotePage<ReviewFile>('hosting_files', args);
  const [path, setPath] = useState('');
  const selected = files.value?.items.find((item) => item.path === path) ?? files.value?.items[0];
  return (
    <div class="hosting-files">
      <div class="hosting-file-selector">
        <RemoteMessage loading={files.loading} error={files.error} onRetry={files.reload} />
        <select
          aria-label="请求变更文件"
          value={selected?.path ?? ''}
          onChange={(event) => setPath(event.currentTarget.value)}
        >
          {!selected && <option value="">选择文件</option>}
          {files.value?.items.map((item) => (
            <option key={item.path} value={item.path}>
              {item.status} · {item.path}
            </option>
          ))}
        </select>
        <Pagination {...files} hasMore={files.value?.hasMore} />
      </div>
      {selected && (
        <RemoteDiff
          key={JSON.stringify([selected.path, review.headSha, review.baseSha])}
          args={args}
          file={selected}
          review={review}
        />
      )}
    </div>
  );
}

function RemoteDiff({
  args,
  file,
  review,
}: {
  args: Record<string, unknown>;
  file: ReviewFile;
  review: ReviewRequest;
}) {
  const diff = useRemote<FileDiff>('hosting_file_diff', {
    accountId: args.accountId,
    repository: args.repository,
    request: {
      number: review.number,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      headSha: review.headSha,
      baseSha: review.baseSha,
    },
  });
  const [prepared, setPrepared] = useState<PreparedDiff>();
  const [line, setLine] = useState<{ line: number; side: 'LEFT' | 'RIGHT' } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setPrepared(undefined);
    setError('');
    if (!diff.value || diff.value.binary || diff.value.tooLarge) return;
    let active = true;
    const analysis = new MergeAnalysis();
    void analysis
      .diff(diff.value.before, diff.value.after)
      .then((value) => {
        if (active) setPrepared(value);
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
      analysis.close();
    };
  }, [diff.value]);
  return (
    <section class="diff-panel hosting-diff">
      <div class="panel-heading">
        <FileIcon path={file.path} />
        <span class="ellipsis">{file.path}</span>
        <InlineReview args={args} review={review} path={file.path} oldPath={file.oldPath} selected={line} />
        <span class="muted">
          {file.additions != null ? `+${file.additions} −${file.deletions ?? 0}` : file.status}
        </span>
      </div>
      <RemoteMessage loading={diff.loading} error={diff.error || error} onRetry={diff.reload} />
      {diff.value?.tooLarge ? (
        <div class="empty">文件超过 1 MiB 或 20,000 行，请在平台查看。</div>
      ) : diff.value?.binary ? (
        <div class="empty">二进制文件</div>
      ) : prepared ? (
        <DiffEditors data={prepared} labels={['合并基准', review.sourceBranch]} onLineSelect={(line, side) => setLine({ line, side })} />
      ) : (
        diff.value && !error && <div class="empty">正在计算差异…</div>
      )}
    </section>
  );
}

function CreateDialog({
  account,
  repository,
  onClose,
  onCreated,
}: {
  account: Account;
  repository: HostedRepository;
  onClose: () => void;
  onCreated: (review: ReviewRequest) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState(repository.defaultBranch);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const gate = useRef(false);
  return (
    <Modal title={`创建 ${reviewName(account.provider)}`} busy={busy} onClose={onClose}>
      <form
        class="hosting-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (gate.current) return;
          gate.current = true;
          setBusy(true);
          setError('');
          void call<ReviewRequest>('hosting_create_review', {
            accountId: account.id,
            repository: repository.path,
            request: {
              title,
              body,
              sourceBranch: source,
              targetBranch: target,
              draft,
            },
          })
            .then(onCreated)
            .catch((error) => setError(String(error)))
            .finally(() => {
              gate.current = false;
              setBusy(false);
            });
        }}
      >
        <h2>创建 {reviewName(account.provider)}</h2>
        <p class="muted">{repository.path} · 请先将源分支推送到远程。</p>
        <label>
          标题
          <input
            required
            maxLength={512}
            value={title}
            disabled={busy}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label>
          源分支
          <input
            required
            value={source}
            disabled={busy}
            placeholder="feature/name"
            onInput={(event) => setSource(event.currentTarget.value)}
          />
        </label>
        <label>
          目标分支
          <input
            required
            value={target}
            disabled={busy}
            onInput={(event) => setTarget(event.currentTarget.value)}
          />
        </label>
        <label>
          说明
          <textarea
            rows={6}
            maxLength={65536}
            value={body}
            disabled={busy}
            onInput={(event) => setBody(event.currentTarget.value)}
          />
        </label>
        <label class="hosting-checkbox">
          <input
            type="checkbox"
            checked={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.checked)}
          />
          创建为草稿
        </label>
        {error && (
          <p class="error-text" role="alert">
            {error}
            <br />
            提交结果不明确时请先刷新列表，确认远程结果。
          </p>
        )}
        <div class="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            class="primary"
            disabled={busy || !title.trim() || !source.trim() || !target.trim()}
          >
            {busy ? '正在创建…' : '创建请求'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
