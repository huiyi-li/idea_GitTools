import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { buildChanges } from '../shared/intellijDiff';
import { minimapRanges } from './minimap';

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
