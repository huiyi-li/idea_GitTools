import { EditorSelection, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { buildChanges } from '../shared/intellijDiff';
import { minimapRanges } from './minimap';

export interface CursorPositionInfo {
  line: number;
  col: number;
  selectedChars: number;
  selectedLines: number;
  pos: number;
}

export function jumpToEditorLine(view: EditorView, lineNumber: number, column = 1) {
  const safeLine = Math.max(1, Math.min(view.state.doc.lines, Math.floor(lineNumber) || 1));
  const lineObj = view.state.doc.line(safeLine);
  const safeCol = Math.max(1, Math.min(lineObj.length + 1, Math.floor(column) || 1));
  const pos = lineObj.from + safeCol - 1;
  view.dispatch({
    selection: { anchor: pos, head: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.contentDOM.focus({ preventScroll: true });
}

function resolveClickPos(view: EditorView, event: MouseEvent): number | null {
  const coordPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (coordPos !== null) return coordPos;
  if (event.target instanceof Node && view.contentDOM.contains(event.target)) {
    try {
      return view.posAtDOM(event.target, 0);
    } catch {
      return null;
    }
  }
  return null;
}

export function previewCursorSupport(
  onCursorChange?: (info: CursorPositionInfo) => void,
): Extension {
  return [
    drawSelection({ cursorBlinkRate: 1100, drawRangeCursor: true }),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false;
        // Clicking a gutter line number jumps the cursor directly to that line
        const targetEl = event.target instanceof HTMLElement ? event.target : null;
        const gutterEl = targetEl?.closest('.cm-lineNumbers .cm-gutterElement');
        if (gutterEl) {
          const lineNum = Number(gutterEl.textContent?.trim());
          if (Number.isInteger(lineNum) && lineNum >= 1 && lineNum <= view.state.doc.lines) {
            const lineObj = view.state.doc.line(lineNum);
            view.contentDOM.focus({ preventScroll: true });
            view.dispatch({
              selection: { anchor: lineObj.from, head: lineObj.to },
            });
            event.preventDefault();
            return true;
          }
        }
        // In read-only preview mode (contenteditable="false"), enable click-to-place-cursor and drag-to-select
        if (!view.state.facet(EditorView.editable)) {
          const pos = resolveClickPos(view, event);
          view.contentDOM.focus({ preventScroll: true });
          if (pos !== null) {
            const anchor = event.shiftKey ? view.state.selection.main.anchor : pos;
            view.dispatch({
              selection: EditorSelection.single(anchor, pos),
            });
            const onMove = (moveEvent: MouseEvent) => {
              if ((moveEvent.buttons & 1) === 0) {
                cleanup();
                return;
              }
              const nextPos = resolveClickPos(view, moveEvent);
              if (nextPos !== null) {
                view.dispatch({
                  selection: EditorSelection.single(anchor, nextPos),
                });
              }
            };
            const cleanup = () => {
              window.removeEventListener('mousemove', onMove);
              window.removeEventListener('mouseup', cleanup);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', cleanup);
          }
        }
        return false;
      },
      keydown(event, view) {
        if (view.state.facet(EditorView.editable)) return false;
        const sel = view.state.selection.main;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !sel.empty) {
          void navigator.clipboard?.writeText(view.state.sliceDoc(sel.from, sel.to)).catch(() => {});
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
          return true;
        }
        if (
          ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault();
          const line = view.state.doc.lineAt(sel.head);
          const colOffset = sel.head - line.from;
          let nextHead = sel.head;
          if (event.key === 'ArrowLeft') nextHead = Math.max(0, sel.head - 1);
          else if (event.key === 'ArrowRight') nextHead = Math.min(view.state.doc.length, sel.head + 1);
          else if (event.key === 'Home') nextHead = line.from;
          else if (event.key === 'End') nextHead = line.to;
          else if (event.key === 'ArrowUp' && line.number > 1) {
            const prev = view.state.doc.line(line.number - 1);
            nextHead = Math.min(prev.to, prev.from + colOffset);
          } else if (event.key === 'ArrowDown' && line.number < view.state.doc.lines) {
            const next = view.state.doc.line(line.number + 1);
            nextHead = Math.min(next.to, next.from + colOffset);
          }
          view.dispatch({
            selection: EditorSelection.single(event.shiftKey ? sel.anchor : nextHead, nextHead),
            effects: EditorView.scrollIntoView(nextHead),
          });
          return true;
        }
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (
        onCursorChange &&
        (update.selectionSet || update.docChanged || update.focusChanged)
      ) {
        const sel = update.state.selection.main;
        const headLine = update.state.doc.lineAt(sel.head);
        const startLine = update.state.doc.lineAt(sel.from).number;
        const endLine = update.state.doc.lineAt(sel.to).number;
        onCursorChange({
          line: headLine.number,
          col: sel.head - headLine.from + 1,
          selectedChars: sel.to - sel.from,
          selectedLines: sel.empty ? 0 : endLine - startLine + 1,
          pos: sel.head,
        });
      }
    }),
  ];
}

function tokenizeLine(text: string): string[] {
  return text.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

// Line backgrounds and word-level inner highlights are limited to the viewport even on large files.
export const diffLineHighlights = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(minimapRanges) !== update.state.field(minimapRanges)
      ) {
        this.decorations = this.build(update.view);
      }
    }
    private build(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      const ranges = view.state.field(minimapRanges);
      let last = -1;
      for (const visible of view.visibleRanges) {
        const first = view.state.doc.lineAt(visible.from).number - 1;
        const end = view.state.doc.lineAt(visible.to).number;
        let low = 0,
          high = ranges.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (ranges[middle].to <= first) low = middle + 1;
          else high = middle;
        }
        for (let index = low; index < ranges.length && ranges[index].from < end; index++) {
          const range = ranges[index];
          const removed = range.kind === 'deleted';
          const decoration = Decoration.line({
            class: removed ? 'line-removed' : 'line-added',
          });
          const wordMark = Decoration.mark({
            class: removed ? 'word-removed' : 'word-added',
          });
          for (let line = Math.max(first, range.from); line < Math.min(end, range.to); line++) {
            const lineObj = view.state.doc.line(line + 1);
            const position = lineObj.from;
            if (position <= last) continue;
            builder.add(position, position, decoration);
            last = position;
            const pairText = range.pairLines?.[line - range.from];
            if (
              pairText !== undefined &&
              pairText !== lineObj.text &&
              lineObj.text.length > 0 &&
              lineObj.text.length <= 1000 &&
              pairText.length <= 1000
            ) {
              const tokens = tokenizeLine(lineObj.text);
              const pairTokens = tokenizeLine(pairText);
              const offsets = new Int32Array(tokens.length + 1);
              for (let t = 0; t < tokens.length; t++) {
                offsets[t + 1] = offsets[t] + tokens[t].length;
              }
              for (const change of buildChanges(tokens, pairTokens)) {
                if (change.deleted > 0) {
                  const from = position + offsets[change.line0];
                  const to = position + offsets[change.line0 + change.deleted];
                  if (to > from && from >= last) {
                    builder.add(from, to, wordMark);
                    last = to;
                  }
                }
              }
            }
          }
        }
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
