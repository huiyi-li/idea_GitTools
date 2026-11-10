import { StateEffect, StateField, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import './minimap.css';

export interface MinimapRange {
  from: number;
  to: number;
  kind: 'inserted' | 'deleted' | 'modified' | 'conflict';
  resolved?: boolean;
}

export const setMinimapRanges = StateEffect.define<readonly MinimapRange[]>();
export const minimapRanges = StateField.define<readonly MinimapRange[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMinimapRanges)) value = effect.value;
    }
    return value;
  },
});

// Sampling bounds drawing work independently of file length. Scroll updates only move the viewport box.
export function sampleMinimap(doc: Text) {
  const count = Math.min(doc.lines, 1000);
  return Array.from({ length: count }, (_, index) => {
    const line = Math.min(doc.lines, Math.floor((index * doc.lines) / count) + 1);
    const text = doc.line(line).text.slice(0, 160);
    const indent = text.search(/\S/);
    return { line, indent: Math.max(0, indent), length: indent < 0 ? 0 : text.trimEnd().length - indent };
  });
}

class CodeMinimap {
  readonly dom = document.createElement('div');
  readonly canvas = document.createElement('canvas');
  readonly viewport = document.createElement('div');
  private samples: ReturnType<typeof sampleMinimap>;
  private dirty = true;
  private disposed = false;
  private height = 0;
  private pointer: number | undefined;
  private readonly observer: ResizeObserver;
  private readonly themeObserver: MutationObserver;

  constructor(readonly view: EditorView, private readonly beforeNavigate?: (line: number) => void) {
    this.samples = sampleMinimap(view.state.doc);
    this.dom.className = 'code-minimap';
    this.dom.tabIndex = 0;
    this.dom.setAttribute('role', 'slider');
    this.dom.setAttribute('aria-label', '代码缩略图');
    this.dom.setAttribute('aria-orientation', 'vertical');
    this.dom.setAttribute('aria-valuemin', '1');
    this.dom.title = '代码缩略图 · 点击或拖动定位，方向键滚动';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.viewport.className = 'code-minimap-viewport';
    this.dom.append(this.canvas, this.viewport);
    view.dom.classList.add('has-code-minimap');
    view.dom.append(this.dom);
    view.scrollDOM.addEventListener('scroll', this.schedule);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.endDrag);
    this.dom.addEventListener('pointercancel', this.endDrag);
    this.dom.addEventListener('lostpointercapture', this.endDrag);
    this.dom.addEventListener('keydown', this.onKeyDown);
    this.observer = new ResizeObserver(() => {
      this.dirty = true;
      this.schedule();
    });
    this.observer.observe(this.dom);
    this.themeObserver = new MutationObserver(() => {
      this.dirty = true;
      this.schedule();
    });
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.schedule();
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.samples = sampleMinimap(update.state.doc);
    if (
      update.docChanged ||
      update.geometryChanged ||
      update.transactions.some(
        (transaction) =>
          transaction.reconfigured || transaction.effects.some((effect) => effect.is(setMinimapRanges)),
      )
    ) {
      this.dirty = true;
    }
    if (update.docChanged || update.geometryChanged || update.viewportChanged || this.dirty) this.schedule();
  }

  private schedule = () => {
    if (this.disposed) return;
    this.view.requestMeasure({
      key: this,
      read: () => {
        if (this.disposed) return undefined;
        const height = this.dom.clientHeight;
        const scroller = this.view.scrollDOM;
        const first = this.view.lineBlockAtHeight(scroller.scrollTop);
        const last = this.view.lineBlockAtHeight(scroller.scrollTop + scroller.clientHeight);
        const doc = this.view.state.doc;
        const from = doc.lineAt(first.from).number;
        const to = doc.lineAt(last.to).number;
        const style = this.dirty ? getComputedStyle(this.dom) : undefined;
        const colors = style
          ? ['text', 'inserted', 'deleted', 'modified', 'conflict', 'resolved'].map((name) =>
              style.getPropertyValue('--minimap-' + name).trim(),
            )
          : undefined;
        return { height, from, to, colors, ratio: Math.min(2, window.devicePixelRatio || 1) };
      },
      write: (measurement) => {
        if (this.disposed || !measurement) return;
        this.height = measurement.height;
        const lines = this.view.state.doc.lines;
        this.dom.setAttribute('aria-valuemax', String(lines));
        this.dom.setAttribute('aria-valuenow', String(measurement.from));
        this.dom.setAttribute('aria-valuetext', '第 ' + measurement.from + ' 行，共 ' + lines + ' 行');
        const boxHeight = Math.min(
          this.height,
          Math.max(12, ((measurement.to - measurement.from + 1) / lines) * this.height),
        );
        const top = Math.min(
          Math.max(0, this.height - boxHeight),
          ((measurement.from - 1) / lines) * this.height,
        );
        this.viewport.style.height = boxHeight + 'px';
        this.viewport.style.transform = 'translateY(' + top + 'px)';
        if (this.dirty && measurement.colors && this.height > 0) {
          this.draw(measurement.colors, measurement.ratio);
          this.dirty = false;
        }
      },
    });
  };

  private draw(colors: string[], ratio: number) {
    const width = 64;
    this.canvas.width = width * ratio;
    this.canvas.height = this.height * ratio;
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    const lines = this.view.state.doc.lines;
    const palette = { inserted: colors[1], deleted: colors[2], modified: colors[3], conflict: colors[4] };
    for (const range of this.view.state.field(minimapRanges)) {
      const from = Math.max(0, Math.min(lines - 1, range.from));
      const to = Math.min(lines, Math.max(from + 1, range.to));
      const y = (from / lines) * this.height;
      const height = Math.max(2, ((to - from) / lines) * this.height);
      context.fillStyle = range.resolved ? colors[5] : palette[range.kind];
      context.globalAlpha = 0.3;
      context.fillRect(0, y, width, height);
      context.globalAlpha = 1;
      context.fillRect(width - 4, y, 4, height);
    }
    context.globalAlpha = 0.65;
    context.fillStyle = colors[0];
    const stroke = Math.max(1, Math.min(2, (this.height / this.samples.length) * 0.65));
    for (const sample of this.samples) {
      if (!sample.length) continue;
      const x = Math.min(48, sample.indent * 0.65) + 3;
      context.fillRect(
        x,
        ((sample.line - 1) / lines) * this.height,
        Math.min(57 - x, sample.length * 0.65),
        stroke,
      );
    }
    context.globalAlpha = 1;
  }

  private seek(line: number) {
    const doc = this.view.state.doc;
    const number = Math.max(1, Math.min(doc.lines, Math.round(line)));
    this.beforeNavigate?.(number);
    this.view.dispatch({ effects: EditorView.scrollIntoView(doc.line(number).from, { y: 'center' }) });
    this.dom.setAttribute('aria-valuenow', String(number));
  }

  private seekPointer(event: PointerEvent) {
    const rect = this.dom.getBoundingClientRect();
    if (rect.height > 0)
      this.seek(((event.clientY - rect.top) / rect.height) * this.view.state.doc.lines + 1);
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.dom.focus();
    this.pointer = event.pointerId;
    this.dom.setPointerCapture(event.pointerId);
    this.seekPointer(event);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.pointer === event.pointerId) this.seekPointer(event);
  };

  private endDrag = (event: PointerEvent) => {
    if (this.pointer !== event.pointerId) return;
    this.pointer = undefined;
    if (this.dom.hasPointerCapture(event.pointerId)) this.dom.releasePointerCapture(event.pointerId);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    const current = Number(this.dom.getAttribute('aria-valuenow')) || 1;
    const page = Math.max(1, Math.floor(this.view.scrollDOM.clientHeight / this.view.defaultLineHeight));
    const targets: Record<string, number> = {
      ArrowUp: current - 1,
      ArrowDown: current + 1,
      PageUp: current - page,
      PageDown: current + page,
      Home: 1,
      End: this.view.state.doc.lines,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    event.stopPropagation();
    this.seek(targets[event.key]);
  };

  destroy() {
    this.disposed = true;
    this.observer.disconnect();
    this.themeObserver.disconnect();
    this.view.scrollDOM.removeEventListener('scroll', this.schedule);
    this.dom.remove();
    this.view.dom.classList.remove('has-code-minimap');
  }
}

export function codeMinimap(beforeNavigate?: (line: number) => void) {
  return ViewPlugin.define(view => new CodeMinimap(view, beforeNavigate));
}
