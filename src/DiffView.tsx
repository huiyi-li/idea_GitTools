import { useEffect, useRef, useState } from 'preact/hooks';
import { Compartment, EditorState, Text } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { call, type DiffTarget, type FileDiff } from './api';
import { MergeAnalysis } from './merge/analysis-client';
import type { PreparedDiff } from './merge/analysis';
import { useMinimapPreference } from './ui/editor-preferences';
import { codeMinimap, minimapRanges, type MinimapRange } from './ui/minimap';
import { diffLineHighlights } from './ui/diff-highlights';

export function DiffEditors({ data, labels }: { data: PreparedDiff; labels?: [string, string] }) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const [sync, setSync] = useState(true);
  const [minimap, setMinimap] = useMinimapPreference();
  const minimapEnabled = useRef(minimap);
  minimapEnabled.current = minimap;
  const minimapMode = useRef(new Compartment());
  const views = useRef<EditorView[]>([]);
  useEffect(() => {
    for (const view of views.current) {
      view.dispatch({ effects: minimapMode.current.reconfigure(minimap && !data.large ? codeMinimap() : []) });
    }
  }, [minimap, data.large]);
  const synchronized = useRef(sync);
  synchronized.current = sync;

  useEffect(() => {
    if (!left.current || !right.current) return;
    const before = Text.of(data.before.split('\n'));
    const after = Text.of(data.after.split('\n'));
    const changes = data.changes;
    const theme = EditorView.theme(
      {
        '&': { height: '100%', fontSize: '12px', backgroundColor: 'var(--bg-editor)', color: 'var(--fg)' },
        '.cm-scroller': { fontFamily: 'Consolas, monospace', overflow: 'auto' },
        '.cm-gutters': {
          backgroundColor: 'var(--bg)',
          color: 'var(--fg-secondary)',
          borderRight: '1px solid var(--border-subtle)',
        },
        '.cm-content': { padding: '8px 0' },
        '.cm-line': { padding: '0 12px' },
        '&.cm-focused': { outline: 'none' },
      },
      { dark: document.body.classList.contains('ij-dark') },
    );
    const extensions = [
      lineNumbers(),
      keymap.of(defaultKeymap),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      theme,
      minimapMode.current.of(minimapEnabled.current && !data.large ? codeMinimap() : []),
      diffLineHighlights,
    ];
    const ranges = (side: 'before' | 'after'): MinimapRange[] =>
      changes.map((change) => ({
        from: side === 'before' ? change.line0 : change.line1,
        to: side === 'before' ? change.line0 + change.deleted : change.line1 + change.inserted,
        kind: side === 'before' ? 'deleted' : 'inserted',
      }));
    const a = new EditorView({
      parent: left.current,
      doc: before,
      extensions: [
        ...extensions,
        minimapRanges.init(() => ranges('before')),
      ],
    });
    const b = new EditorView({
      parent: right.current,
      doc: after,
      extensions: [
        ...extensions,
        minimapRanges.init(() => ranges('after')),
      ],
    });
    views.current = [a, b];
    let disposed = false;
    let master = a;
    const expected = new Map<EditorView, { top: number; left: number }>();
    const scrollKey = {};
    const mirror = (source: EditorView) => {
      const position = expected.get(source);
      expected.delete(source);
      if (
        !synchronized.current ||
        (position &&
          Math.abs(source.scrollDOM.scrollTop - position.top) < 1 &&
          Math.abs(source.scrollDOM.scrollLeft - position.left) < 1)
      )
        return;
      master = source;
      a.requestMeasure({
        key: scrollKey,
        read: () => {
          if (disposed || !synchronized.current) return undefined;
          const target = master === a ? b : a;
          const ratio =
            master.scrollDOM.scrollTop /
            Math.max(1, master.scrollDOM.scrollHeight - master.scrollDOM.clientHeight);
          const top = Math.max(0, ratio * (target.scrollDOM.scrollHeight - target.scrollDOM.clientHeight));
          const left = Math.max(
            0,
            Math.min(
              master.scrollDOM.scrollLeft,
              target.scrollDOM.scrollWidth - target.scrollDOM.clientWidth,
            ),
          );
          return { target, top, left };
        },
        write: (position) => {
          if (disposed || !synchronized.current || !position) return;
          expected.set(position.target, { top: position.top, left: position.left });
          position.target.scrollDOM.scrollTop = position.top;
          position.target.scrollDOM.scrollLeft = position.left;
        },
      });
    };
    const scrollA = () => mirror(a);
    const scrollB = () => mirror(b);
    a.scrollDOM.addEventListener('scroll', scrollA);
    b.scrollDOM.addEventListener('scroll', scrollB);
    if (changes[0]) {
      a.dispatch({
        effects: EditorView.scrollIntoView(
          a.state.doc.line(Math.min(a.state.doc.lines, changes[0].line0 + 1)).from,
          { y: 'center' },
        ),
      });
      b.dispatch({
        effects: EditorView.scrollIntoView(
          b.state.doc.line(Math.min(b.state.doc.lines, changes[0].line1 + 1)).from,
          { y: 'center' },
        ),
      });
    }
    return () => {
      disposed = true;
      views.current = [];
      a.scrollDOM.removeEventListener('scroll', scrollA);
      b.scrollDOM.removeEventListener('scroll', scrollB);
      a.destroy();
      b.destroy();
    };
  }, [data]);

  return (
    <>
      <div class="diff-labels">
        <span>{labels?.[0] ?? '修改前'}</span>
        <label>
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.currentTarget.checked)} />
          同步滚动
        </label>
        <label title="同时应用于文件 diff 和三栏合并，自动保存设置">
          <input
            type="checkbox"
            checked={minimap && !data.large}
            disabled={data.large}
            onChange={(event) => setMinimap(event.currentTarget.checked)}
          />
          代码缩略图
        </label>
        <span>{labels?.[1] ?? '修改后'}</span>
      </div>
      {(data.large || data.simplified) && (
        <div class="message notice-message" role="status">
          {data.simplified ? '差异计算超时，当前显示整块变化' : '大文件模式 · 行级比较'}
        </div>
      )}
      <div class="diff-editors">
        <div ref={left} />
        <div ref={right} />
      </div>
    </>
  );
}

interface LoadedDiff {
  key: string;
  version: number;
  file: FileDiff;
  prepared?: PreparedDiff;
}

function sameContents(left: FileDiff, right: FileDiff) {
  return (
    left.before === right.before &&
    left.after === right.after &&
    left.binary === right.binary &&
    left.tooLarge === right.tooLarge &&
    left.canLoad === right.canLoad &&
    left.large === right.large
  );
}

function cacheBytes(entry: LoadedDiff) {
  return (
    2 *
    (entry.file.before.length +
      entry.file.after.length +
      (entry.prepared?.before.length ?? 0) +
      (entry.prepared?.after.length ?? 0))
  );
}

export function DiffView({
  root,
  target,
  version,
  labels,
}: {
  root: string;
  target: DiffTarget | null;
  version: number;
  labels?: [string, string];
}) {
  const key = target
    ? JSON.stringify([root, target.path, target.oldPath, target.revision, target.beforeRevision, target.area])
    : '';
  const [loaded, setLoaded] = useState<LoadedDiff | null>(null);
  const latest = useRef(loaded);
  latest.current = loaded;
  const cache = useRef(new Map<string, LoadedDiff>());
  const worker = useRef<MergeAnalysis>();
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [phase, setPhase] = useState('');
  const [allowedKey, setAllowedKey] = useState('');
  const [attempt, setAttempt] = useState(0);
  const allowLarge = allowedKey === key;
  useEffect(
    () => () => {
      worker.current?.close();
      worker.current = undefined;
      cache.current.clear();
    },
    [root],
  );

  useEffect(() => {
    let current = true;
    let analysis: MergeAnalysis | undefined;
    let analyzing = false;
    setError(null);
    if (!target) {
      setLoaded(null);
      setPhase('');
      return;
    }
    const cached = cache.current.get(key);
    if (target.revision && cached?.version === version && !(allowLarge && cached.file.canLoad)) {
      cache.current.delete(key);
      cache.current.set(key, cached);
      latest.current = cached;
      setLoaded(cached);
      setPhase('');
      return;
    }
    setPhase('正在读取文件…');
    const publish = (entry: LoadedDiff) => {
      if (!current) return;
      latest.current = entry;
      setLoaded(entry);
      setPhase('');
      if (!target.revision) return;
      cache.current.delete(key);
      cache.current.set(key, entry);
      // Keep recent historical files within a small memory budget.
      while (
        cache.current.size > 4 ||
        [...cache.current.values()].reduce((total, value) => total + cacheBytes(value), 0) > 6 * 1024 * 1024
      ) {
        cache.current.delete(cache.current.keys().next().value!);
      }
    };
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const file = await call<FileDiff>('read_diff', { root, request: target, allowLarge });
          if (!current) return;
          const previous = latest.current?.key === key ? latest.current : cache.current.get(key);
          if (previous && sameContents(previous.file, file)) {
            publish({ ...previous, version });
            return;
          }
          if (file.binary || file.tooLarge) {
            publish({ key, version, file });
            return;
          }
          setPhase('正在计算差异…');
          analysis = worker.current && !worker.current.isClosed ? worker.current : new MergeAnalysis();
          worker.current = analysis;
          analyzing = true;
          const prepared = await analysis.diff(file.before, file.after);
          analyzing = false;
          if (file.large || analysis.isClosed) {
            analysis.close();
            if (worker.current === analysis) worker.current = undefined;
          }
          publish({ key, version, file, prepared: { ...prepared, large: file.large } });
        } catch (error) {
          analyzing = false;
          analysis?.close();
          if (worker.current === analysis) worker.current = undefined;
          if (current) {
            setError({ key, message: String(error) });
            setPhase('');
          }
        }
      })();
    }, 40);
    return () => {
      current = false;
      clearTimeout(timer);
      if (analyzing) {
        analysis?.close();
        if (worker.current === analysis) worker.current = undefined;
      }
    };
  }, [root, key, version, allowLarge, attempt]);

  const cached = target?.revision ? cache.current.get(key) : undefined;
  const data = loaded?.key === key ? loaded : cached?.version === version ? cached : undefined;
  let content;
  if (!target) content = <div class="empty">选择文件查看差异</div>;
  else if (error?.key === key)
    content = (
      <div class="empty error-text" role="alert">
        {error.message}
        <button onClick={() => setAttempt((value) => value + 1)}>重试</button>
      </div>
    );
  else if (!data) content = <div class="empty">{phase || '正在读取文件…'}</div>;
  else if (data.file.tooLarge)
    content = (
      <div class="empty">
        <p>{data.file.reason || '文件超过自动加载阈值'}</p>
        {data.file.canLoad && (
          <button disabled={!!phase} onClick={() => setAllowedKey(key)}>加载大文件</button>
        )}
      </div>
    );
  else if (data.file.binary) content = <div class="empty">二进制文件</div>;
  else if (data.prepared)
    content = (
      <DiffEditors
        key={key}
        data={data.prepared}
        labels={labels ?? (
          target?.area === 'staged' ? ['HEAD', '暂存区'] :
          target?.area === 'unstaged' ? ['暂存区', '工作区'] : undefined
        )}
      />
    );

  return (
    <section class="diff-panel">
      <div class="panel-heading">
        <span>文件差异</span>
        <span class="mono ellipsis" title={target?.path}>
          {target?.path}
        </span>
        {target && phase && (
          <span class="muted" role="status">
            {phase}
          </span>
        )}
        {phase === '正在计算差异…' && (
          <button onClick={() => worker.current?.close()}>取消计算</button>
        )}
        <span class="muted">
          {target?.beforeRevision
            ? target.beforeRevision.slice(0, 8) + ' ↔ ' + target.revision?.slice(0, 8)
            : target?.revision
              ? target.revision.slice(0, 8)
              : target?.area === 'staged'
                ? 'HEAD ↔ 暂存区'
                : target?.area === 'unstaged'
                  ? '暂存区 ↔ 工作区'
                  : 'HEAD ↔ 工作区'}
        </span>
      </div>
      {content}
    </section>
  );
}
