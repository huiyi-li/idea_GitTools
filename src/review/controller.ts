import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { syntaxTheme } from '../merge/theme';
import { buildChanges } from '../shared/intellijDiff';
import { codeMinimap, minimapRanges, setMinimapRanges, type MinimapRange } from '../ui/minimap';
import { lineAnchors, mapLine, type LineAnchors } from './line-map';
import {
  diffLineHighlights,
  jumpToEditorLine,
  previewCursorSupport,
  type CursorPositionInfo,
} from '../ui/diff-highlights';
import {
  readable,
  type CommitReview,
  type FileSnapshot,
  type Pane,
  type ReviewDiffs,
  type Scope,
} from './types';

const panes: Pane[] = ['before', 'after', 'current'];
const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    color: 'var(--fg)',
    backgroundColor: 'var(--bg-editor)',
  },
  '.cm-scroller': { fontFamily: 'Consolas, monospace', lineHeight: '20px', overflow: 'auto' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 10px' },
  '.cm-gutters': {
    color: 'var(--fg-secondary)',
    backgroundColor: 'var(--bg)',
    borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-selectionBackground': { backgroundColor: 'var(--bg-selection) !important' },
});

export class ReviewController {
  readonly views: Partial<Record<Pane, EditorView>> = {};
  private current: FileSnapshot;
  private diffs: ReviewDiffs;
  private anchors: Record<Scope, LineAnchors> = { commit: [], current: [] };
  private scope: Scope;
  private sync = true;
  private minimapEnabled: boolean;
  private readonly minimap = new Compartment();
  private readonly language = new Compartment();
  private readonly syntax = new Compartment();
  private readonly currentEdit = new Compartment();
  private currentEditable = false;
  private languageSupport: Extension = [];
  private disposed = false;
  private index = -1;
  private master: Pane = 'after';
  private readonly expected = new Map<Pane, { top: number; left: number }>();
  private readonly scrollKey = {};
  private readonly listeners = new Map<Pane, () => void>();
  private readonly themeObserver: MutationObserver;

  constructor(
    private readonly hosts: Record<Pane, HTMLElement>,
    private readonly document: CommitReview,
    diffs: ReviewDiffs,
    scope: Scope,
    minimapEnabled: boolean,
    private readonly onNavigate: (index: number) => void,
    private readonly onCurrentChange?: (text: string) => void,
    private readonly onSaveShortcut?: () => void,
    private readonly onCurrentCursor?: (info: CursorPositionInfo) => void,
  ) {
    this.current = document.current.file;
    this.diffs = diffs;
    this.scope = scope;
    this.minimapEnabled = minimapEnabled;
    for (const pane of panes) this.create(pane, this.snapshot(pane));
    this.updateDiffs(diffs);
    const language = LanguageDescription.matchFilename(languages, document.after.path);
    if (language && !this.large)
      void language
        .load()
        .then((support) => {
          if (this.disposed) return;
          this.languageSupport = support;
          for (const view of Object.values(this.views))
            view.dispatch({ effects: this.language.reconfigure(this.large ? [] : support) });
        })
        .catch(() => {});
    this.themeObserver = new MutationObserver(() => {
      for (const view of Object.values(this.views))
        view.dispatch({ effects: this.syntax.reconfigure(syntaxTheme(documentIsDark())) });
    });
    this.themeObserver.observe(window.document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
    this.navigate(1);
  }

  private snapshot(pane: Pane) {
    return pane === 'current' ? this.current : this.document[pane];
  }

  private get large() {
    return !!(this.document.before.large || this.document.after.large || this.current.large);
  }

  private currentEditExtensions(editable: boolean): Extension {
    return editable
      ? [
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
          EditorView.contentAttributes.of({
            tabindex: '0',
            'aria-label': '当前工作区代码',
            'aria-readonly': 'false',
          }),
          history(),
          keymap.of([
            ...historyKeymap,
            {
              key: 'Mod-s',
              run: () => {
                this.onSaveShortcut?.();
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
            'aria-label': '当前工作区代码',
            'aria-readonly': 'true',
          }),
        ];
  }

  private create(pane: Pane, snapshot: FileSnapshot) {
    if (!readable(snapshot)) return;
    const isCurrent = pane === 'current';
    const view = new EditorView({
      parent: this.hosts[pane],
      doc: snapshot.text.replace(/\r\n/g, '\n'),
      extensions: [
        lineNumbers(),
        previewCursorSupport(isCurrent ? this.onCurrentCursor : undefined),
        keymap.of(defaultKeymap),
        theme,
        ...(isCurrent
          ? [
              this.currentEdit.of(
                this.currentEditExtensions(this.currentEditable && snapshot.state === 'text'),
              ),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  const text = update.state.doc.toString();
                  this.onCurrentChange?.(text);
                  if (!this.large && readable(this.document.after)) {
                    const beforeText = this.document.after.text.replace(/\r\n/g, '\n');
                    const changes = buildChanges(beforeText.split('\n'), text.split('\n'));
                    this.diffs = {
                      ...this.diffs,
                      current: { before: beforeText, after: text, changes },
                    };
                    this.anchors.current = lineAnchors(
                      changes,
                      this.views.after?.state.doc.lines ?? 1,
                      update.state.doc.lines,
                    );
                    if (this.scope === 'current') this.highlight();
                  }
                }
              }),
            ]
          : [
              EditorState.readOnly.of(true),
              EditorView.editable.of(false),
              EditorView.contentAttributes.of({
                tabindex: '0',
                'aria-label': { before: '修改前代码', after: '修改后代码' }[pane],
                'aria-readonly': 'true',
              }),
            ]),
        diffLineHighlights,
        minimapRanges,
        this.minimap.of(this.minimapEnabled && !this.large ? codeMinimap() : []),
        this.language.of(this.large ? [] : this.languageSupport),
        this.syntax.of(syntaxTheme(documentIsDark())),
      ],
    });
    this.views[pane] = view;
    const listener = () => this.scroll(pane);
    this.listeners.set(pane, listener);
    view.scrollDOM.addEventListener('scroll', listener);
  }

  setCurrentEditable(editable: boolean) {
    this.currentEditable = editable;
    const view = this.views.current;
    if (!view) return;
    const allow = editable && this.current.state === 'text';
    const savedSelection = view.state.selection;
    view.dispatch({
      effects: this.currentEdit.reconfigure(this.currentEditExtensions(allow)),
    });
    if (allow) {
      const currentChanges = this.diffs.current?.changes ?? [];
      if (savedSelection.main.head === 0 && savedSelection.main.empty && currentChanges.length > 0) {
        const targetIdx = Math.max(0, Math.min(currentChanges.length - 1, this.index));
        const targetChange = currentChanges[targetIdx] ?? currentChanges[0];
        const targetLine = Math.max(
          1,
          Math.min(view.state.doc.lines, (targetChange?.line1 ?? 0) + 1),
        );
        const linePos = view.state.doc.line(targetLine).from;
        view.dispatch({
          selection: { anchor: linePos, head: linePos },
          effects: EditorView.scrollIntoView(linePos, { y: 'center' }),
        });
      } else {
        view.dispatch({
          selection: savedSelection,
          effects: EditorView.scrollIntoView(savedSelection.main.head),
        });
      }
      view.contentDOM.focus({ preventScroll: true });
    }
  }

  jumpToCurrentLine(lineNumber: number) {
    const view = this.views.current;
    if (view) jumpToEditorLine(view, lineNumber);
  }

  resetCurrentText() {
    const view = this.views.current;
    if (!view) return;
    const normalized = this.current.text.replace(/\r\n/g, '\n');
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: normalized },
    });
  }

  private remove(pane: Pane) {
    const view = this.views[pane];
    const listener = this.listeners.get(pane);
    if (view && listener) view.scrollDOM.removeEventListener('scroll', listener);
    view?.destroy();
    delete this.views[pane];
    this.listeners.delete(pane);
    this.expected.delete(pane);
  }

  updateCurrent(snapshot: FileSnapshot, diffs: ReviewDiffs) {
    if (snapshot === this.current && diffs === this.diffs) return;
    const previous = this.current;
    this.current = snapshot;
    for (const existing of Object.values(this.views)) {
      existing.dispatch({
        effects: this.language.reconfigure(this.large ? [] : this.languageSupport),
      });
    }
    this.setMinimap(this.minimapEnabled);
    const view = this.views.current;
    if (!readable(snapshot)) this.remove('current');
    else if (!view) this.create('current', snapshot);
    else if (snapshot.text !== previous.text)
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: snapshot.text.replace(/\r\n/g, '\n'),
        },
      });
    this.updateDiffs(diffs);
    if (this.scope === 'current' && snapshot.fingerprint !== previous.fingerprint) {
      this.index = -1;
      this.onNavigate(-1);
    }
  }

  private updateDiffs(diffs: ReviewDiffs) {
    this.diffs = diffs;
    for (const scope of ['commit', 'current'] as Scope[]) {
      const data = diffs[scope];
      const pair: [Pane, Pane] = scope === 'commit' ? ['before', 'after'] : ['after', 'current'];
      this.anchors[scope] = data
        ? lineAnchors(
            data.changes,
            this.views[pair[0]]?.state.doc.lines ?? 1,
            this.views[pair[1]]?.state.doc.lines ?? 1,
          )
        : [];
    }
    this.highlight();
  }

  setScope(scope: Scope) {
    this.scope = scope;
    this.index = -1;
    this.highlight();
    this.navigate(1);
  }

  setSync(value: boolean) {
    this.sync = value;
  }

  setMinimap(value: boolean) {
    this.minimapEnabled = value;
    for (const view of Object.values(this.views))
      view.dispatch({
        effects: this.minimap.reconfigure(value && !this.large ? codeMinimap() : []),
      });
  }

  private highlight() {
    const data = this.diffs[this.scope];
    const pair: [Pane, Pane] = this.scope === 'commit' ? ['before', 'after'] : ['after', 'current'];
    const beforeLines = data ? data.before.split('\n') : [];
    const afterLines = data ? data.after.split('\n') : [];
    for (const pane of panes) {
      const view = this.views[pane];
      if (!view) continue;
      const ranges: MinimapRange[] = [];
      const side = pair.indexOf(pane);
      if (data && side >= 0) {
        for (const change of data.changes) {
          const start = side === 0 ? change.line0 : change.line1;
          const count = side === 0 ? change.deleted : change.inserted;
          const modified =
            !this.large &&
            change.deleted > 0 &&
            change.inserted > 0 &&
            change.deleted <= 40 &&
            change.inserted <= 40;
          ranges.push({
            from: start,
            to: start + count,
            kind: side === 0 ? 'deleted' : 'inserted',
            pairLines: modified
              ? side === 0
                ? afterLines.slice(change.line1, change.line1 + change.inserted)
                : beforeLines.slice(change.line0, change.line0 + change.deleted)
              : undefined,
          });
        }
      }
      view.dispatch({
        effects: setMinimapRanges.of(ranges),
      });
    }
  }

  private mapped(line: number, source: Pane, target: Pane): number {
    if (source === target) return line;
    const middle =
      source === 'before'
        ? mapLine(this.anchors.commit, line)
        : source === 'current'
          ? mapLine(this.anchors.current, line, true)
          : line;
    return target === 'before'
      ? mapLine(this.anchors.commit, middle, true)
      : target === 'current'
        ? mapLine(this.anchors.current, middle)
        : middle;
  }

  private scroll(source: Pane) {
    const view = this.views[source];
    if (!view || this.disposed || !this.sync) return;
    const expected = this.expected.get(source);
    this.expected.delete(source);
    if (
      expected &&
      Math.abs(view.scrollDOM.scrollTop - expected.top) < 1 &&
      Math.abs(view.scrollDOM.scrollLeft - expected.left) < 1
    )
      return;
    this.master = source;
    view.requestMeasure({
      key: this.scrollKey,
      read: () => {
        if (this.disposed || !this.sync) return undefined;
        const source = this.master;
        const master = this.views[source];
        if (!master) return undefined;
        const middle = master.scrollDOM.scrollTop + master.scrollDOM.clientHeight / 2;
        const block = master.lineBlockAtHeight(middle);
        const line =
          master.state.doc.lineAt(block.from).number -
          1 +
          (middle - block.top) / Math.max(1, block.height);
        return panes
          .filter((pane) => pane !== source && this.views[pane])
          .map((pane) => {
            const target = this.views[pane]!;
            const mapped = Math.max(
              0,
              Math.min(target.state.doc.lines - 1, this.mapped(line, source, pane)),
            );
            const index = Math.floor(mapped);
            const block = target.lineBlockAt(target.state.doc.line(index + 1).from);
            return {
              pane,
              target,
              top: Math.max(
                0,
                block.top + (mapped - index) * block.height - target.scrollDOM.clientHeight / 2,
              ),
              left: Math.max(
                0,
                Math.min(
                  master.scrollDOM.scrollLeft,
                  target.scrollDOM.scrollWidth - target.scrollDOM.clientWidth,
                ),
              ),
            };
          });
      },
      write: (positions) => {
        if (this.disposed || !this.sync || !positions) return;
        for (const position of positions) {
          if (this.views[position.pane] !== position.target) continue;
          position.target.scrollDOM.scrollTop = position.top;
          position.target.scrollDOM.scrollLeft = position.left;
          this.expected.set(position.pane, {
            top: position.target.scrollDOM.scrollTop,
            left: position.target.scrollDOM.scrollLeft,
          });
        }
      },
    });
  }

  navigate(direction: -1 | 1) {
    const data = this.diffs[this.scope];
    if (!data?.changes.length) {
      this.onNavigate(-1);
      return;
    }
    this.index =
      this.index < 0
        ? direction === 1
          ? 0
          : data.changes.length - 1
        : (this.index + direction + data.changes.length) % data.changes.length;
    const change = data.changes[this.index];
    const source = this.scope === 'commit' ? 'before' : 'after';
    for (const pane of panes) {
      const view = this.views[pane];
      if (!view) continue;
      const line = Math.max(
        1,
        Math.min(view.state.doc.lines, Math.floor(this.mapped(change.line0, source, pane)) + 1),
      );
      const position = view.state.doc.line(line).from;
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: 'center' }),
      });
    }
    this.onNavigate(this.index);
  }

  destroy() {
    this.disposed = true;
    this.themeObserver.disconnect();
    for (const pane of panes) this.remove(pane);
  }
}

function documentIsDark() {
  return window.document.body.classList.contains('ij-dark');
}
