import { useEffect, useRef, useState } from 'preact/hooks';
import { Compartment, EditorState, RangeSetBuilder, Text } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { call, type DiffTarget, type FileDiff } from './api';
import { MergeAnalysis } from './merge/analysis-client';
import type { PreparedDiff } from './merge/analysis';
import { useMinimapPreference } from './ui/editor-preferences';
import { codeMinimap, minimapRanges, type MinimapRange } from './ui/minimap';

function markedLines(doc: Text, ranges: { start: number; count: number }[], kind: string) {
  const builder = new RangeSetBuilder<Decoration>();
  const decoration = Decoration.line({ class: kind });
  for (const range of ranges) {
    for (let line = range.start + 1; line <= range.start + range.count && line <= doc.lines; line++) {
      builder.add(doc.line(line).from, doc.line(line).from, decoration);
    }
  }
  return builder.finish();
}

function Editors({ data, labels }: { data: PreparedDiff; labels?: [string, string] }) {
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
      view.dispatch({ effects: minimapMode.current.reconfigure(minimap ? codeMinimap() : []) });
    }
  }, [minimap]);
  const synchronized = useRef(sync);
  synchronized.current = sync;

  useEffect(() => {
    if (!left.current || !right.current) return;
    const before = Text.of(data.before.split('\n'));
    const after = Text.of(data.after.split('\n'));
    const changes = data.changes;
    const removed = markedLines(
      before,
      changes.map((c) => ({ start: c.line0, count: c.deleted })),
      'line-removed',
    );
    const added = markedLines(
      after,
      changes.map((c) => ({ start: c.line1, count: c.inserted })),
      'line-added',
    );
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
      theme,
      minimapMode.current.of(minimapEnabled.current ? codeMinimap() : []),
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
        EditorView.decorations.of(removed),
        minimapRanges.init(() => ranges('before')),
      ],
    });
    const b = new EditorView({
      parent: right.current,
      doc: after,
      extensions: [
        ...extensions,
        EditorView.decorations.of(added),
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
            checked={minimap}
            onChange={(event) => setMinimap(event.currentTarget.checked)}
          />
          代码缩略图
        </label>
        <span>{labels?.[1] ?? '修改后'}</span>
      </div>
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
    left.tooLarge === right.tooLarge
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
    ? JSON.stringify([root, target.path, target.oldPath, target.revision, target.beforeRevision])
    : '';
  const [loaded, setLoaded] = useState<LoadedDiff | null>(null);
  const latest = useRef(loaded);
  latest.current = loaded;
  const cache = useRef(new Map<string, LoadedDiff>());
  const worker = useRef<MergeAnalysis>();
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [phase, setPhase] = useState('');
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
    if (target.revision && cached?.version === version) {
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
          const file = await call<FileDiff>('read_diff', { root, request: target });
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
          analysis = worker.current ?? new MergeAnalysis();
          worker.current = analysis;
          analyzing = true;
          const prepared = await analysis.diff(file.before, file.after);
          analyzing = false;
          publish({ key, version, file, prepared });
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
  }, [root, key, version]);

  const cached = target?.revision ? cache.current.get(key) : undefined;
  const data = loaded?.key === key ? loaded : cached?.version === version ? cached : undefined;
  let content;
  if (!target) content = <div class="empty">选择文件查看差异</div>;
  else if (error?.key === key)
    content = (
      <div class="empty error-text" role="alert">
        {error.message}
      </div>
    );
  else if (!data) content = <div class="empty">{phase || '正在读取文件…'}</div>;
  else if (data.file.tooLarge)
    content = <div class="empty">文件超过 1 MiB 或 20,000 行，请使用外部编辑器查看。</div>;
  else if (data.file.binary) content = <div class="empty">二进制文件</div>;
  else if (data.prepared) content = <Editors key={key} data={data.prepared} labels={labels} />;

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
        <span class="muted">
          {target?.beforeRevision
            ? target.beforeRevision.slice(0, 8) + ' ↔ ' + target.revision?.slice(0, 8)
            : target?.revision
              ? target.revision.slice(0, 8)
              : 'HEAD ↔ 工作区'}
        </span>
      </div>
      {content}
    </section>
  );
}
