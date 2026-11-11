import { useEffect, useRef, useState } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-dialog';
import { call, type Details } from '../api';
import { MergeAnalysis } from '../merge/analysis-client';
import { FileIcon, Modal, Split, ToolButton } from '../ui/controls';
import { ReviewEditors } from './ReviewEditors';
import { readable, type CommitReview, type ReviewDiffs, type WorktreeSnapshot } from './types';
import './review.css';

interface Loaded {
  key: string;
  document: CommitReview;
  diffs: ReviewDiffs;
  version: number;
}

function cacheBytes(entry: Loaded) {
  const { before, after, current } = entry.document;
  return (
    2 *
    [
      before.text,
      after.text,
      current.file.text,
      entry.diffs.commit?.before ?? '',
      entry.diffs.commit?.after ?? '',
      entry.diffs.current?.before ?? '',
      entry.diffs.current?.after ?? '',
    ].reduce((total, text) => total + text.length, 0)
  );
}

export default function CommitReviewViewer({
  root,
  details,
  initialPath,
  version,
  onClose,
}: {
  root: string;
  details: Details;
  initialPath: string;
  version: number;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [loaded, setLoaded] = useState<Loaded>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [refreshPath, setRefreshPath] = useState<string>();
  const [allowLarge, setAllowLarge] = useState(false);
  const latest = useRef(loaded);
  latest.current = loaded;
  const cache = useRef(new Map<string, Loaded>());
  const latestVersion = useRef(version);
  latestVersion.current = version;
  const key = JSON.stringify([root, details.commit.hash, path, allowLarge]);
  const index = details.changes.findIndex((change) => change.path === path);
  const value = loaded?.key === key ? loaded : undefined;

  useEffect(() => {
    let active = true;
    let analysis: MergeAnalysis | undefined;
    const compare = (before: string, after: string) => {
      if (!analysis || analysis.isClosed) analysis = new MergeAnalysis();
      return analysis.diff(before, after);
    };
    setBusy(true);
    setError('');
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const readVersion = latestVersion.current;
          const cached = latest.current?.key === key ? latest.current : cache.current.get(key);
          const document = cached
            ? {
                ...cached.document,
                current: await call<WorktreeSnapshot>('read_review_worktree', {
                  root,
                  path: refreshPath ?? cached.document.current.file.path,
                  allowLarge,
                }),
              }
            : await call<CommitReview>('read_commit_review', {
                root,
                revision: details.commit.hash,
                path,
                allowLarge,
              });
          if (!active) return;
          const commit =
            cached?.diffs.commit ??
            (readable(document.before) && readable(document.after)
              ? await compare(document.before.text, document.after.text)
              : undefined);
          const unchanged =
            cached &&
            cached.document.current.file.fingerprint === document.current.file.fingerprint;
          const current = unchanged
            ? cached.diffs.current
            : readable(document.after) && readable(document.current.file)
              ? await compare(document.after.text, document.current.file.text)
              : undefined;
          if (!active) return;
          const entry: Loaded = { key, document, diffs: { commit, current }, version: readVersion };
          cache.current.delete(key);
          cache.current.set(key, entry);
          while (
            cache.current.size > 4 ||
            [...cache.current.values()].reduce((sum, item) => sum + cacheBytes(item), 0) >
              6 * 1024 * 1024
          ) {
            cache.current.delete(cache.current.keys().next().value!);
          }
          setLoaded(entry);
        } catch (error) {
          if (active) setError(String(error));
        } finally {
          if (active) setBusy(false);
          analysis?.close();
        }
      })();
    }, 60);
    return () => {
      active = false;
      clearTimeout(timer);
      analysis?.close();
    };
  }, [key, revision]);

  function refreshCurrent() {
    setRevision((value) => value + 1);
  }
  function selectFile(next: string) {
    if (next === path) return;
    setAllowLarge(false);
    setRefreshPath(undefined);
    setPath(next);
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'F5') {
        event.preventDefault();
        event.stopPropagation();
        refreshCurrent();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  return (
    <Modal title="提交三栏查看器" class="commit-review-viewer" onClose={onClose}>
      <header class="review-toolbar review-heading">
        <strong>提交三栏查看器</strong>
        <span class="ellipsis" title={root}>
          {root.replaceAll('\\', '/').split('/').pop()}
        </span>
        <span class="mono">{details.commit.hash.slice(0, 8)}</span>
        <span class="ellipsis" title={details.commit.subject}>
          {details.commit.subject}
        </span>
        <span class="spacer" />
        <ToolButton
          icon="general/up"
          label="上一个变更文件"
          disabled={index <= 0}
          onClick={() => selectFile(details.changes[index - 1].path)}
        />
        <ToolButton
          icon="general/down"
          label="下一个变更文件"
          disabled={index < 0 || index >= details.changes.length - 1}
          onClick={() => selectFile(details.changes[index + 1].path)}
        />
        <button disabled={busy || !value} onClick={refreshCurrent}>
          刷新当前内容
        </button>
        <button
          disabled={busy || !value}
          onClick={() =>
            void (async () => {
              try {
                const selected = await open({
                  directory: false,
                  multiple: false,
                  defaultPath: root,
                  title: '关联当前仓库内的文件',
                });
                if (typeof selected === 'string') {
                  setRefreshPath(selected);
                  refreshCurrent();
                }
              } catch (error) {
                setError(String(error));
              }
            })()
          }
        >
          关联当前文件
        </button>
        <ToolButton icon="general/close" label="关闭三栏查看器" onClick={onClose} />
      </header>
      {value && value.version !== version && (
        <div class="review-update-notice">工作区状态有更新，可刷新当前内容。历史版本已固定。</div>
      )}
      {error && (
        <div class="review-error" role="alert">
          {error}
          <button onClick={refreshCurrent}>重试</button>
        </div>
      )}
      {value &&
        [value.document.before, value.document.after, value.document.current.file].some(
          (file) => file.canLoad,
        ) && (
          <div class="review-update-notice">
            文件超过自动加载阈值，大文件模式支持 10 MiB / 200,000 行以内的文本。
            <button disabled={busy} onClick={() => setAllowLarge(true)}>
              加载大文件
            </button>
          </div>
        )}
      <Split storageKey="review-files" initial={210} min={160} label="调整查看器文件栏宽度">
        <aside class="review-files" role="listbox" aria-label="本次提交的变更文件">
          {details.changes.map((change) => (
            <button
              key={change.path}
              role="option"
              aria-selected={change.path === path}
              class={change.path === path ? 'selected' : ''}
              title={change.path}
              onClick={() => selectFile(change.path)}
            >
              <FileIcon path={change.path} />
              <span class="file-status">{change.index}</span>
              <span class="ellipsis">{change.path}</span>
            </button>
          ))}
        </aside>
        <section class="review-content">
          {busy && (
            <div class="review-loading" role="status">
              正在读取快照和计算差异…
            </div>
          )}
          {value && <ReviewEditors document={value.document} diffs={value.diffs} />}
        </section>
      </Split>
    </Modal>
  );
}
