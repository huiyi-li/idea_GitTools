import { useEffect, useRef, useState } from 'preact/hooks';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { buildChanges } from './shared/intellijDiff';
import { call, type DiffTarget, type FileDiff } from './api';

function markedLines(text: string, ranges: { start: number; count: number }[], kind: string) {
  const state = EditorState.create({ doc: text });
  const builder = new RangeSetBuilder<Decoration>();
  const decoration = Decoration.line({ class: kind });
  for (const range of ranges) {
    for (let line = range.start + 1; line <= range.start + range.count && line <= state.doc.lines; line++) {
      builder.add(state.doc.line(line).from, state.doc.line(line).from, decoration);
    }
  }
  return builder.finish();
}

function Editors({ data }: { data: FileDiff }) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const [sync, setSync] = useState(true);
  const synchronized = useRef(sync);
  synchronized.current = sync;

  useEffect(() => {
    if (!left.current || !right.current) return;
    // Keep CodeMirror's line numbers consistent with a final empty document line.
    const before = data.before.replace(/\r\n/g, '\n');
    const after = data.after.replace(/\r\n/g, '\n');
    const changes = buildChanges(before.split('\n'), after.split('\n'));
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
    const extensions = [lineNumbers(), keymap.of(defaultKeymap), EditorState.readOnly.of(true), theme];
    const a = new EditorView({
      parent: left.current,
      doc: before,
      extensions: [...extensions, EditorView.decorations.of(removed)],
    });
    const b = new EditorView({
      parent: right.current,
      doc: after,
      extensions: [...extensions, EditorView.decorations.of(added)],
    });
    let scrolling = false;
    let frame = 0;
    const mirror = (source: EditorView, target: EditorView) => {
      if (!synchronized.current || scrolling) return;
      scrolling = true;
      const ratio =
        source.scrollDOM.scrollTop /
        Math.max(1, source.scrollDOM.scrollHeight - source.scrollDOM.clientHeight);
      target.scrollDOM.scrollTop = ratio * (target.scrollDOM.scrollHeight - target.scrollDOM.clientHeight);
      target.scrollDOM.scrollLeft = source.scrollDOM.scrollLeft;
      frame = requestAnimationFrame(() => {
        scrolling = false;
      });
    };
    const scrollA = () => mirror(a, b);
    const scrollB = () => mirror(b, a);
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
      cancelAnimationFrame(frame);
      a.scrollDOM.removeEventListener('scroll', scrollA);
      b.scrollDOM.removeEventListener('scroll', scrollB);
      a.destroy();
      b.destroy();
    };
  }, [data]);

  return (
    <>
      <div class="diff-labels">
        <span>修改前</span>
        <label>
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.currentTarget.checked)} />
          同步滚动
        </label>
        <span>修改后</span>
      </div>
      <div class="diff-editors">
        <div ref={left} />
        <div ref={right} />
      </div>
    </>
  );
}

export function DiffView({
  root,
  target,
  version,
}: {
  root: string;
  target: DiffTarget | null;
  version: number;
}) {
  const [data, setData] = useState<FileDiff | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setData(null);
    setError('');
    if (target) {
      call<FileDiff>('read_diff', { root, request: target })
        .then((value) => {
          if (current) setData(value);
        })
        .catch((e) => {
          if (current) setError(String(e));
        });
    }
    return () => {
      current = false;
    };
  }, [root, target?.path, target?.oldPath, target?.revision, version]);

  let content;
  if (!target) content = <div class="empty">选择文件查看差异</div>;
  else if (error) content = <div class="empty error-text">{error}</div>;
  else if (!data) content = <div class="empty">正在读取文件…</div>;
  else if (data.tooLarge)
    content = <div class="empty">文件超过 1 MiB 或 20,000 行，请使用外部编辑器查看。</div>;
  else if (data.binary) content = <div class="empty">二进制文件</div>;
  else content = <Editors data={data} />;

  return (
    <section class="diff-panel">
      <div class="panel-heading">
        <span>文件差异</span>
        <span class="mono ellipsis" title={target?.path}>
          {target?.path}
        </span>
        <span class="muted">{target?.revision ? target.revision.slice(0, 8) : 'HEAD ↔ 工作区'}</span>
      </div>
      {content}
    </section>
  );
}
