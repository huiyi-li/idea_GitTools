import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { minimapRanges } from './minimap';

// Line backgrounds are limited to the viewport even when an entire large file changed.
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
          const decoration = Decoration.line({
            class: range.kind === 'deleted' ? 'line-removed' : 'line-added',
          });
          for (let line = Math.max(first, range.from); line < Math.min(end, range.to); line++) {
            const position = view.state.doc.line(line + 1).from;
            if (position <= last) continue;
            builder.add(position, position, decoration);
            last = position;
          }
        }
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
