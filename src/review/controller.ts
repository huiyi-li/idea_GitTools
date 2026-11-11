import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { syntaxTheme } from '../merge/theme';
import { codeMinimap, minimapRanges, setMinimapRanges, type MinimapRange } from '../ui/minimap';
import { lineAnchors, mapLine, type LineAnchors } from './line-map';
import { diffLineHighlights } from '../ui/diff-highlights';
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

  private create(pane: Pane, snapshot: FileSnapshot) {
    if (!readable(snapshot)) return;
    const view = new EditorView({
      parent: this.hosts[pane],
      doc: snapshot.text.replace(/\r\n/g, '\n'),
      extensions: [
        lineNumbers(),
        drawSelection(),
        keymap.of(defaultKeymap),
        theme,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({
          tabindex: '0',
          'aria-label': { before: '修改前代码', after: '修改后代码', current: '当前工作区代码' }[
            pane
          ],
          'aria-readonly': 'true',
        }),
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
    for (const pane of panes) {
      const view = this.views[pane];
      if (!view) continue;
      const ranges: MinimapRange[] = [];
      const side = pair.indexOf(pane);
      if (data && side >= 0) {
        for (const change of data.changes) {
          const start = side === 0 ? change.line0 : change.line1;
          const count = side === 0 ? change.deleted : change.inserted;
          ranges.push({
            from: start,
            to: start + count,
            kind: side === 0 ? 'deleted' : 'inserted',
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
