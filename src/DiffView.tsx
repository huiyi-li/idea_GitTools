import { useEffect, useRef, useState } from 'preact/hooks';
import { Compartment, EditorState, Text, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { call, readSaved, save, type BlameLine, type DiffTarget, type FileDiff } from './api';
import { MergeAnalysis } from './merge/analysis-client';
import type { PreparedDiff } from './merge/analysis';
import { syntaxTheme } from './merge/theme';
import { buildChanges } from './shared/intellijDiff';
import { ToolButton } from './ui/controls';
import { useMinimapPreference } from './ui/editor-preferences';
import { useSetting } from './state/settings';
import { codeMinimap, minimapRanges, setMinimapRanges, type MinimapRange } from './ui/minimap';
import {
  diffLineHighlights,
  jumpToEditorLine,
  previewCursorSupport,
  type CursorPositionInfo,
} from './ui/diff-highlights';

class BlameWidget extends WidgetType {
  constructor(private readonly line: BlameLine) { super(); }
  eq(other: BlameWidget) {
    return (
      this.line.hash === other.line.hash &&
      this.line.line === other.line.line &&
      this.line.author === other.line.author &&
      this.line.time === other.line.time &&
      this.line.summary === other.line.summary
    );
  }
  toDOM() {
    const element = document.createElement('span');
    element.className = 'cm-inline-blame';
    element.textContent = `${this.line.author} · ${new Date(this.line.time * 1000).toLocaleDateString('zh-CN')} · ${this.line.summary}`;
    element.title = `${this.line.hash} · ${this.line.path}`;
    return element;
  }
  ignoreEvent() { return true; }
}

function buildBlameDecorations(doc: Text, lines: BlameLine[]) {
  return Decoration.set(
    lines.flatMap((line) => {
      const number = line.line;
      if (number < 1 || number > doc.lines) return [];
      if (doc.line(number).text.replace(/\r$/, '') !== line.text) return [];
      return [Decoration.widget({ widget: new BlameWidget(line), side: 1 }).range(doc.line(number).to)] as const;
    }),
    true,
  );
}

function buildRanges(
  side: 'before' | 'after',
  changes: PreparedDiff['changes'],
  beforeLines: string[],
  afterLines: string[],
  large?: boolean,
): MinimapRange[] {
  return changes.map((change) => {
    const modified =
      !large &&
      change.deleted > 0 &&
      change.inserted > 0 &&
      change.deleted <= 40 &&
      change.inserted <= 40;
    return {
      from: side === 'before' ? change.line0 : change.line1,
      to: side === 'before' ? change.line0 + change.deleted : change.line1 + change.inserted,
      kind: side === 'before' ? 'deleted' : 'inserted',
      pairLines: modified
        ? side === 'before'
          ? afterLines.slice(change.line1, change.line1 + change.inserted)
          : beforeLines.slice(change.line0, change.line0 + change.deleted)
        : undefined,
    };
  });
}

export function DiffEditors({
  data,
  path,
  labels,
  onLineSelect,
  blame,
  showBlame,
  onToggleBlame,
  canEdit,
  onSave,
  onDirtyChange,
}: {
  data: PreparedDiff;
  path?: string;
  labels?: [string, string];
  onLineSelect?: (line: number, side: 'LEFT' | 'RIGHT') => void;
  blame?: BlameLine[];
  showBlame?: boolean;
  onToggleBlame?: (enabled: boolean) => void;
  canEdit?: boolean;
  onSave?: (content: string) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const selection = useRef(onLineSelect);
  const inlineBlame = showBlame === true;
  selection.current = onLineSelect;
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const [sync, setSync] = useSetting('diffSyncScroll');
  const [minimap, setMinimap] = useMinimapPreference();
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cursorInfo, setCursorInfo] = useState<CursorPositionInfo>({
    line: 1,
    col: 1,
    selectedChars: 0,
    selectedLines: 0,
    pos: 0,
  });
  const [jumpLineInput, setJumpLineInput] = useState('1');
  const [currentChange, setCurrentChange] = useState(0);
  const [changeCount, setChangeCount] = useState(data.changes.length);
  const liveChanges = useRef(data.changes);
  const changeIndexRef = useRef(0);
  const draftRef = useRef(data.after);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const savingRef = useRef(false);
  savingRef.current = saving;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  const minimapEnabled = useRef(minimap);
  minimapEnabled.current = minimap;
  const minimapMode = useRef(new Compartment());
  const blameMode = useRef(new Compartment());
  const languageMode = useRef(new Compartment());
  const syntaxMode = useRef(new Compartment());
  const editMode = useRef(new Compartment());
  const languageSupport = useRef<Extension>([]);
  const blameLines = useRef(blame ?? []);
  blameLines.current = inlineBlame && !editing ? (blame ?? []) : [];
  const views = useRef<EditorView[]>([]);

  async function saveEdit() {
    if (!onSaveRef.current || !dirtyRef.current || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const ok = await onSaveRef.current(draftRef.current);
      if (ok) {
        dirtyRef.current = false;
        setDirty(false);
        onDirtyRef.current?.(false);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function revertEdit() {
    const rightView = views.current[1];
    if (!rightView || savingRef.current) return;
    rightView.dispatch({
      changes: { from: 0, to: rightView.state.doc.length, insert: data.after },
    });
  }

  function navigateChange(direction: -1 | 1) {
    const list = liveChanges.current;
    if (!list.length || views.current.length < 2) return;
    const next = (changeIndexRef.current + direction + list.length) % list.length;
    changeIndexRef.current = next;
    setCurrentChange(next);
    const change = list[next];
    const [a, b] = views.current;
    const lineA = Math.max(1, Math.min(a.state.doc.lines, change.line0 + 1));
    const lineB = Math.max(1, Math.min(b.state.doc.lines, change.line1 + 1));
    a.dispatch({
      effects: EditorView.scrollIntoView(a.state.doc.line(lineA).from, { y: 'center' }),
    });
    b.dispatch({
      effects: EditorView.scrollIntoView(b.state.doc.line(lineB).from, { y: 'center' }),
    });
  }

  useEffect(() => {
    for (const view of views.current) {
      view.dispatch({ effects: minimapMode.current.reconfigure(minimap && !data.large ? codeMinimap() : []) });
    }
  }, [minimap, data.large]);

  useEffect(() => {
    let active = true;
    languageSupport.current = [];
    if (!path || data.large) {
      for (const view of views.current) {
        view.dispatch({ effects: languageMode.current.reconfigure([]) });
      }
      return;
    }
    const desc = LanguageDescription.matchFilename(languages, path);
    if (!desc) return;
    void desc
      .load()
      .then((support) => {
        if (!active) return;
        languageSupport.current = support;
        for (const view of views.current) {
          view.dispatch({ effects: languageMode.current.reconfigure(data.large ? [] : support) });
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [path, data.large]);

  useEffect(() => {
    if (!canEdit && editing) setEditing(false);
  }, [canEdit, editing]);

  useEffect(() => {
    const rightView = views.current[1];
    if (!rightView) return;
    const allowEdit = Boolean(canEdit && editing);
    const savedSelection = rightView.state.selection;
    rightView.dispatch({
      effects: editMode.current.reconfigure(
        allowEdit
          ? [
              EditorState.readOnly.of(false),
              EditorView.editable.of(true),
              EditorView.contentAttributes.of({
                tabindex: '0',
                'aria-label': '工作区代码编辑器',
                'aria-readonly': 'false',
              }),
              history(),
              keymap.of([
                ...historyKeymap,
                {
                  key: 'Mod-s',
                  run: () => {
                    void saveEdit();
                    return true;
                  },
                },
              ]),
            ]
          : [
              EditorState.readOnly.of(true),
              EditorView.editable.of(false),
              EditorView.contentAttributes.of({
                tabindex: '0',
                'aria-label': '工作区代码预览',
                'aria-readonly': 'true',
              }),
            ],
      ),
    });
    if (allowEdit) {
      if (savedSelection.main.head === 0 && savedSelection.main.empty && liveChanges.current.length > 0) {
        const targetChange =
          liveChanges.current[changeIndexRef.current] ?? liveChanges.current[0];
        const targetLine = Math.max(
          1,
          Math.min(rightView.state.doc.lines, (targetChange?.line1 ?? 0) + 1),
        );
        const linePos = rightView.state.doc.line(targetLine).from;
        rightView.dispatch({
          selection: { anchor: linePos, head: linePos },
          effects: EditorView.scrollIntoView(linePos, { y: 'center' }),
        });
      } else {
        rightView.dispatch({
          selection: savedSelection,
          effects: EditorView.scrollIntoView(savedSelection.main.head),
        });
      }
      rightView.contentDOM.focus({ preventScroll: true });
    }
  }, [canEdit, editing]);

  useEffect(() => {
    const rightView = views.current[1];
    if (!rightView) return;
    const activeLines = inlineBlame && !editing ? (blame ?? []) : [];
    rightView.dispatch({
      effects: blameMode.current.reconfigure(
        activeLines.length ? EditorView.decorations.of(buildBlameDecorations(rightView.state.doc, activeLines)) : [],
      ),
    });
  }, [inlineBlame, blame, editing]);
  const synchronized = useRef(sync);
  synchronized.current = sync;

  useEffect(() => {
    if (!left.current || !right.current) return;
    const beforeLines = data.before.split('\n');
    const afterLines = data.after.split('\n');
    const before = Text.of(beforeLines);
    const after = Text.of(afterLines);
    const changes = data.changes;
    liveChanges.current = changes;
    changeIndexRef.current = 0;
    setCurrentChange(0);
    setChangeCount(changes.length);
    draftRef.current = data.after;
    dirtyRef.current = false;
    setDirty(false);
    const dark = document.body.classList.contains('ij-dark');
    const theme = EditorView.theme(
      {
        '&': {
          height: '100%',
          fontSize: 'var(--editor-font-size, 12px)',
          backgroundColor: 'var(--bg-editor)',
          color: 'var(--fg)',
        },
        '.cm-scroller': {
          fontFamily: 'Consolas, monospace',
          lineHeight: 'var(--editor-line-height, 20px)',
          overflow: 'auto',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--bg)',
          color: 'var(--fg-secondary)',
          borderRight: '1px solid var(--border-subtle)',
        },
        '.cm-content': { padding: '8px 0' },
        '.cm-line': { padding: '0 12px' },
        '&.cm-focused': { outline: 'none' },
      },
      { dark },
    );
    const navKeymap = keymap.of([
      {
        key: 'F7',
        run: () => {
          navigateChange(1);
          return true;
        },
      },
      {
        key: 'Shift-F7',
        run: () => {
          navigateChange(-1);
          return true;
        },
      },
    ]);
    const extensions = [
      lineNumbers(),
      keymap.of(defaultKeymap),
      navKeymap,
      theme,
      minimapMode.current.of(minimapEnabled.current && !data.large ? codeMinimap() : []),
      languageMode.current.of(data.large ? [] : languageSupport.current),
      syntaxMode.current.of(syntaxTheme(dark)),
      diffLineHighlights,
    ];
    const allowEdit = Boolean(canEdit && editing);
    const a = new EditorView({
      parent: left.current,
      doc: before,
      extensions: [
        ...extensions,
        previewCursorSupport(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({
          tabindex: '0',
          'aria-label': '左侧对比代码预览',
          'aria-readonly': 'true',
        }),
        minimapRanges.init(() => buildRanges('before', changes, beforeLines, afterLines, data.large)),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            selection.current?.(update.state.doc.lineAt(update.state.selection.main.head).number, 'LEFT');
          }
        }),
      ],
    });
    const b = new EditorView({
      parent: right.current,
      doc: after,
      extensions: [
        ...extensions,
        EditorState.transactionFilter.of((transaction) =>
          transaction.docChanged && savingRef.current ? [] : transaction,
        ),
        previewCursorSupport((info) => {
          setCursorInfo(info);
          setJumpLineInput(String(info.line));
        }),
        editMode.current.of(
          allowEdit
            ? [
                EditorState.readOnly.of(false),
                EditorView.editable.of(true),
                EditorView.contentAttributes.of({
                  tabindex: '0',
                  'aria-label': '工作区代码编辑器',
                  'aria-readonly': 'false',
                }),
                history(),
                keymap.of([
                  ...historyKeymap,
                  {
                    key: 'Mod-s',
                    run: () => {
                      void saveEdit();
                      return true;
                    },
                  },
                ]),
              ]
            : [
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
                EditorView.contentAttributes.of({
                  tabindex: '0',
                  'aria-label': '工作区代码预览',
                  'aria-readonly': 'true',
                }),
              ],
        ),
        blameMode.current.of(
          blameLines.current.length ? EditorView.decorations.of(buildBlameDecorations(after, blameLines.current)) : [],
        ),
        minimapRanges.init(() => buildRanges('after', changes, beforeLines, afterLines, data.large)),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            selection.current?.(update.state.doc.lineAt(update.state.selection.main.head).number, 'RIGHT');
          }
          if (update.docChanged) {
            const text = update.state.doc.toString();
            draftRef.current = text;
            const isDirty = text !== data.after;
            dirtyRef.current = isDirty;
            setDirty(isDirty);
            onDirtyRef.current?.(isDirty);
            if (!data.large) {
              const currentBefore = data.before.split('\n');
              const currentAfter = text.split('\n');
              const nextChanges = buildChanges(currentBefore, currentAfter);
              liveChanges.current = nextChanges;
              setChangeCount(nextChanges.length);
              a.dispatch({
                effects: setMinimapRanges.of(
                  buildRanges('before', nextChanges, currentBefore, currentAfter, data.large),
                ),
              });
              update.view.dispatch({
                effects: setMinimapRanges.of(
                  buildRanges('after', nextChanges, currentBefore, currentAfter, data.large),
                ),
              });
            }
          }
        }),
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
        <div class="diff-nav-tools">
          <ToolButton
            icon="general/up"
            label="上一处差异 · Shift+F7"
            disabled={!changeCount}
            onClick={() => navigateChange(-1)}
          />
          <ToolButton
            icon="general/down"
            label="下一处差异 · F7"
            disabled={!changeCount}
            onClick={() => navigateChange(1)}
          />
          <span class="diff-change-count muted">
            {changeCount ? `${Math.min(currentChange + 1, changeCount)}/${changeCount} 处差异` : '无差异'}
          </span>
        </div>
        <label>
          <input type="checkbox" checked={sync} onChange={(e) => setSync(e.currentTarget.checked)} />
          同步滚动
        </label>
        {onToggleBlame && <label title="只读取当前文件的前 200 行 blame，编辑期间隐藏，自动保存设置">
          <input type="checkbox" checked={inlineBlame} onChange={(event) => onToggleBlame?.(event.currentTarget.checked)} />
          Inline Blame
        </label>}
        <label title="同时应用于文件 diff 和三栏合并，自动保存设置">
          <input
            type="checkbox"
            checked={minimap && !data.large}
            disabled={data.large}
            onChange={(event) => setMinimap(event.currentTarget.checked)}
          />
          代码缩略图
        </label>
        {canEdit && (
          <div class="diff-edit-tools">
            <span
              class="diff-cursor-badge"
              aria-label="工作区光标位置"
              title="点击代码区或行号即可在预览/编辑模式下定位光标与选区"
            >
              行 {cursorInfo.line}, 列 {cursorInfo.col}
              {cursorInfo.selectedChars > 0
                ? ` · 已选 ${cursorInfo.selectedChars} 字符`
                : ''}
            </span>
            <input
              type="number"
              class="diff-jump-input"
              aria-label="跳转到工作区行号"
              min={1}
              value={jumpLineInput}
              placeholder="跳至行"
              title="输入行号并回车定位工作区光标"
              onInput={(event) => setJumpLineInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const rightView = views.current[1];
                  if (rightView) {
                    jumpToEditorLine(
                      rightView,
                      Number(event.currentTarget.value) || Number(jumpLineInput) || 1,
                    );
                  }
                }
              }}
            />
            <label title="保留当前预览光标位置，直接在右侧工作区视图中微调代码并按 Ctrl+S 保存">
              <input
                type="checkbox"
                checked={editing}
                disabled={saving}
                onChange={(event) => setEditing(event.currentTarget.checked)}
              />
              轻量编辑
            </label>
            {editing && (
              <>
                <button
                  type="button"
                  class="diff-save-btn"
                  disabled={!dirty || saving}
                  title="保存工作区修改 · Ctrl+S"
                  onClick={() => void saveEdit()}
                >
                  {saving ? '保存中…' : '保存修改'}
                </button>
                <button
                  type="button"
                  class="diff-revert-btn"
                  disabled={!dirty || saving}
                  title="放弃当前编辑器中的未保存修改"
                  onClick={() => revertEdit()}
                >
                  还原修改
                </button>
              </>
            )}
          </div>
        )}
        <span>{labels?.[1] ?? '修改后'}{editing ? (dirty ? ' · 未保存' : ' · 可编辑') : ''}</span>
      </div>
      {(data.large || data.simplified) && (
        <div class="message notice-message" role="status">
          {data.simplified ? '差异计算超时，当前显示整块变化' : '大文件模式 · 行级比较'}
        </div>
      )}
      <div class="diff-editors">
        <div ref={left} />
        <div ref={right} class={editing && canEdit ? 'is-editing-pane' : ''} />
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
  onSaved,
}: {
  root: string;
  target: DiffTarget | null;
  version: number;
  labels?: [string, string];
  onSaved?: () => void;
}) {
  const key = target
    ? JSON.stringify([root, target.path, target.oldPath, target.revision, target.beforeRevision, target.area])
    : '';
  const saveContext = useRef({ key });
  const draftKey = useRef('');
  if (saveContext.current.key !== key) {
    saveContext.current = { key };
    draftKey.current = '';
  }
  const fileContext = saveContext.current;
  useEffect(() => () => { saveContext.current = { key: '' }; }, []);
  const [loaded, setLoaded] = useState<LoadedDiff | null>(null);
  const latest = useRef(loaded);
  latest.current = loaded;
  const cache = useRef(new Map<string, LoadedDiff>());
  const worker = useRef<MergeAnalysis>();
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [saveError, setSaveError] = useState<{ key: string; message: string } | null>(null);
  const [phase, setPhase] = useState('');
  const [allowedKey, setAllowedKey] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [showBlame, setShowBlame] = useSetting('inlineBlame');
  const [blame, setBlame] = useState<BlameLine[]>([]);
  const selectedLine = useRef<number>(1);
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
    setBlame([]);
    if (!showBlame || !target || !target.path || target.area === 'staged') return;
    void call<{ lines: BlameLine[] }>('file_blame', { root, path: target.path, revision: target.revision, offset: 0 })
      .then((value) => { if (current) setBlame(value.lines); })
      .catch(() => { if (current) setBlame([]); });
    return () => { current = false; };
  }, [root, key, showBlame, target?.path, target?.revision, target?.revision ? 0 : version]);

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
    if (draftKey.current === key) {
      setPhase('有未保存的编辑，保存或还原后刷新');
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
      if (draftKey.current === key) {
        setPhase('有未保存的编辑，保存或还原后刷新');
        return;
      }
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
            if (draftKey.current === key) setSaveError({ key, message: String(error) });
            else setError({ key, message: String(error) });
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
  const canEdit = Boolean(
    target &&
      !target.revision &&
      !target.beforeRevision &&
      target.area !== 'staged' &&
      data &&
      !data.file.binary &&
      !data.file.tooLarge,
  );
  async function handleSaveWorktree(nextContent: string): Promise<boolean> {
    if (!target || !data) return false;
    const context = saveContext.current;
    setSaveError(null);
    try {
      await call('save_worktree_file', {
        root,
        path: target.path,
        content: nextContent,
        expected: data.file.after,
      });
      if (saveContext.current !== context) return true;
      const updatedFile: FileDiff = { ...data.file, after: nextContent };
      const updatedPrepared: PreparedDiff | undefined = data.prepared
        ? {
            ...data.prepared,
            after: nextContent,
            changes: data.file.large
              ? data.prepared.changes
              : buildChanges(data.prepared.before.split('\n'), nextContent.split('\n')),
          }
        : undefined;
      const nextLoaded: LoadedDiff = { ...data, file: updatedFile, prepared: updatedPrepared };
      latest.current = nextLoaded;
      setLoaded(nextLoaded);
      onSaved?.();
      return true;
    } catch (e) {
      if (saveContext.current === context) setSaveError({ key, message: String(e) });
      return false;
    }
  }
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
        path={target.path}
        labels={labels ?? (
          target?.area === 'staged' ? ['HEAD', '暂存区'] :
          target?.area === 'unstaged' ? ['暂存区', '工作区'] : undefined
        )}
        onLineSelect={(line) => {
          selectedLine.current = line;
        }}
        blame={blame}
        showBlame={showBlame && target.area !== 'staged'}
        onToggleBlame={target.area === 'staged' ? undefined : setShowBlame}
        canEdit={canEdit}
        onSave={handleSaveWorktree}
        onDirtyChange={(dirty) => {
          if (saveContext.current !== fileContext) return;
          const wasDirty = draftKey.current === key;
          draftKey.current = dirty ? key : '';
          if (wasDirty && !dirty) setAttempt(value => value + 1);
        }}
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
        <span class="spacer" />
        {target && (
          <div class="diff-external-tools">
            <button
              type="button"
              title="在外部编辑器中打开工作区文件（如已安装 VS Code 则定位到当前选中行）"
              onClick={() =>
                void call('open_in_editor', {
                  root,
                  path: target.path,
                  line: selectedLine.current,
                }).catch((e) => setError({ key, message: String(e) }))
              }
            >
              外部编辑器
            </button>
            <button
              type="button"
              title="在系统资源管理器中定位该文件"
              onClick={() =>
                void call('reveal_in_explorer', { root, path: target.path }).catch((e) =>
                  setError({ key, message: String(e) }),
                )
              }
            >
              打开所在目录
            </button>
          </div>
        )}
        <span class="muted">
          {target?.beforeRevision
            ? target.beforeRevision.slice(0, 8) + ' ↔ ' + (target.revision?.slice(0, 8) ?? '工作区')
            : target?.revision
              ? target.revision.slice(0, 8)
              : target?.area === 'staged'
                ? 'HEAD ↔ 暂存区'
                : target?.area === 'unstaged'
                  ? '暂存区 ↔ 工作区'
                  : 'HEAD ↔ 工作区'}
        </span>
      </div>
      {saveError?.key === key && <div class="error-text" role="alert">{saveError.message}</div>}
      {content}
    </section>
  );
}
