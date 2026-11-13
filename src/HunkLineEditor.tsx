import { useEffect, useRef } from 'preact/hooks';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, lineNumbers, type DecorationSet } from '@codemirror/view';

export function changedLine(text: string) {
  return text.startsWith('+') || text.startsWith('-');
}

class LineCheckbox extends GutterMarker {
  constructor(readonly offset: number, readonly checked: boolean, readonly disabled: boolean, readonly toggle: (offset: number) => void) { super(); }
  eq(other: LineCheckbox) { return this.offset === other.offset && this.checked === other.checked && this.disabled === other.disabled; }
  toDOM() {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.disabled = this.disabled;
    input.setAttribute('aria-label', `选择变化行 ${this.offset + 1}`);
    input.addEventListener('change', () => this.toggle(this.offset));
    return input;
  }
}

const patchHighlights = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: { view: EditorView; docChanged: boolean; viewportChanged: boolean }) {
    if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
  }
  build(view: EditorView) {
    const ranges = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      let position = from;
      while (position <= to) {
        const line = view.state.doc.lineAt(position);
        if (changedLine(line.text)) ranges.add(line.from, line.from, Decoration.line({ class: line.text[0] === '+' ? 'hunk-addition' : 'hunk-deletion' }));
        position = line.to + 1;
      }
    }
    return ranges.finish();
  }
}, { decorations: plugin => plugin.decorations });

export function HunkLineEditor({ text, selected, disabled, onToggle, onSelect }: {
  text: string;
  selected: number[];
  disabled: boolean;
  onToggle: (offset: number) => void;
  onSelect: (offsets: number[]) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>();
  const mode = useRef(new Compartment());
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  function choices() {
    const chosen = new Set(selected);
    return gutter({ class: 'hunk-checkboxes', lineMarker(view, block) {
      const line = view.state.doc.lineAt(block.from);
      return changedLine(line.text) ? new LineCheckbox(line.number - 1, chosen.has(line.number - 1), disabled, offset => toggle.current(offset)) : null;
    } });
  }
  useEffect(() => {
    const view = new EditorView({ parent: parent.current!, doc: text, extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), mode.current.of(choices()), patchHighlights,
      EditorView.theme({
        '&': { height: '320px', fontSize: '12px', backgroundColor: 'var(--bg-editor)', color: 'var(--fg)' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, monospace' },
        '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--fg-secondary)', borderRight: '1px solid var(--border)' },
        '.hunk-checkboxes .cm-gutterElement': { padding: '0 5px' },
        '.cm-line': { padding: '0 8px' },
      }),
    ] });
    editor.current = view;
    return () => { editor.current = undefined; view.destroy(); };
  }, [text]);
  useEffect(() => { editor.current?.dispatch({ effects: mode.current.reconfigure(choices()) }); }, [selected, disabled, text]);
  return <>
    <div class="hunk-line-editor" ref={parent} />
    <button disabled={disabled} onClick={() => {
      const view = editor.current;
      if (!view) return;
      const offsets = new Set<number>();
      for (const range of view.state.selection.ranges) {
        const first = view.state.doc.lineAt(range.from).number;
        const last = view.state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number;
        for (let number = first; number <= last; number++) {
          if (changedLine(view.state.doc.line(number).text)) offsets.add(number - 1);
        }
      }
      onSelect([...offsets]);
    }}>选择文本范围内变化行</button>
  </>;
}
