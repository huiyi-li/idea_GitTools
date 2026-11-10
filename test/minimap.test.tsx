import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { Text, EditorState, Compartment } from '@codemirror/state';
import { BrowserWorker } from './browser-worker';
import type { MergeDocument } from '../src/merge/protocol';

const window = new Window({ url: 'http://localhost' });
for (const name of [
  'window',
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'ResizeObserver',
  'DOMRect',
  'Range',
  'MouseEvent',
  'KeyboardEvent',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'window' ? window : window[name],
  });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window) as typeof getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: BrowserWorker });
const { EditorView } = await import('@codemirror/view');
const { codeMinimap, minimapRanges, setMinimapRanges, sampleMinimap } = await import('../src/ui/minimap');
const { setMinimapEnabled } = await import('../src/ui/editor-preferences');
const { DiffView } = await import('../src/DiffView');
const { MergeEditor } = await import('../src/merge/MergeEditor');
const { undo, redo } = await import('@codemirror/commands');
after(() => window.happyDOM.close());

async function waitFor(predicate: () => unknown) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Minimap did not reach the expected state');
}

const merge: MergeDocument = {
  id: 'minimap',
  path: 'example.txt',
  base: 'start\nbase\nend\n',
  left: 'start\nlocal\nend\n',
  right: 'start\nincoming\nend\n',
  working: null,
  leftTitle: '本地',
  rightTitle: '传入',
  leftStage: 2,
  leftPresent: true,
  rightPresent: true,
  editable: true,
  reason: '',
  markerSize: 7,
  progress: null,
};

test('the shared toggle persists and switches both diff and merge without replacing editors or losing edits', async () => {
  const root = document.body.appendChild(document.createElement('div'));
  globalThis.testBackend = async () => ({
    before: 'base\n',
    after: 'changed\n',
    binary: false,
    tooLarge: false,
  });
  let changed = 0;
  const show = () =>
    render(
      <>
        <DiffView root="C:/fixture" target={{ path: 'example.txt', revision: 'a'.repeat(40) }} version={0} />
        <MergeEditor document={merge} busy={false} onChange={() => changed++} onStats={() => {}} />
      </>,
      root,
    );
  try {
    setMinimapEnabled(false);
    show();
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 5);
    assert.equal(root.querySelectorAll('.code-minimap').length, 0);
    const resultHost = root.querySelector<HTMLElement>('.mg-result .cm-editor')!;
    const result = EditorView.findFromDOM(resultHost)!;
    result.dispatch({ changes: { from: 0, insert: 'manual\n' } });
    const manual = result.state.doc.toString();
    const editors = [...root.querySelectorAll('.cm-editor')];
    const toggle = [...root.querySelectorAll<HTMLLabelElement>('.diff-labels label')]
      .find((label) => label.textContent?.includes('代码缩略图'))!
      .querySelector('input')!;
    toggle.click();
    await waitFor(() => root.querySelectorAll('.code-minimap').length === 5);
    assert.equal(localStorage.getItem('editor.minimap.enabled'), 'true');
    assert.deepEqual([...root.querySelectorAll('.cm-editor')], editors);
    assert.equal(result.state.doc.toString(), manual);
    const maps = root.querySelectorAll<HTMLElement>('.code-minimap');
    assert.equal(maps[0].getAttribute('role'), 'slider');
    const right = EditorView.findFromDOM(root.querySelector<HTMLElement>('.mg-right .cm-editor')!)!;
    assert.equal(right.state.field(minimapRanges)[0].resolved, false);
    root
      .querySelector<HTMLElement>('.mg-right .mg-op[data-action="apply"]')!
      .dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    assert.ok(result.state.doc.toString().includes('incoming'));
    assert.equal(right.state.field(minimapRanges)[0].resolved, true);
    assert.ok(undo(result));
    assert.equal(result.state.doc.toString(), manual);
    assert.equal(right.state.field(minimapRanges)[0].resolved, false);
    assert.ok(redo(result));
    const modified = changed;
    setMinimapEnabled(false);
    await waitFor(() => !root.querySelector('.code-minimap'));
    assert.equal(changed, modified);
    assert.deepEqual([...root.querySelectorAll('.cm-editor')], editors);
    setMinimapEnabled(true);
    render(null, root);
    show();
    await waitFor(() => root.querySelectorAll('.code-minimap').length === 5);
    localStorage.setItem('editor.minimap.enabled', 'false');
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'editor.minimap.enabled' }));
    await waitFor(() => !root.querySelector('.code-minimap'));
  } finally {
    render(null, root);
    root.remove();
    setMinimapEnabled(false);
  }
});

test('sampling is bounded for large documents and supports empty text and tabs', () => {
  assert.equal(sampleMinimap(Text.of(Array.from({ length: 20001 }, (_, i) => '  line ' + i))).length, 1000);
  assert.deepEqual(sampleMinimap(Text.of([''])), [{ line: 1, indent: 0, length: 0 }]);
  assert.equal(sampleMinimap(Text.of(['\tvalue']))[0].indent, 1);
});

test('canvas drawing is cached while scrolling and pointer and keyboard navigation preserve selection', () => {
  const host = document.body.appendChild(document.createElement('div'));
  const mode = new Compartment();
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: Array.from({ length: 2000 }, (_, i) => 'line ' + i).join('\n'),
      extensions: [minimapRanges, mode.of(codeMinimap())],
    }),
  });
  const map = host.querySelector<HTMLElement>('.code-minimap')!;
  const canvas = map.querySelector('canvas')!;
  const calls: unknown[][] = [];
  const context = {
    scale() {},
    fillRect(...args: unknown[]) {
      calls.push(args);
    },
    fillStyle: '',
    globalAlpha: 1,
  };
  Object.defineProperty(canvas, 'getContext', { value: () => context });
  Object.defineProperty(map, 'clientHeight', { value: 400 });
  Object.defineProperty(map, 'getBoundingClientRect', { value: () => ({ top: 0, height: 400 }) });
  const captures = new Set<number>();
  Object.defineProperty(map, 'setPointerCapture', { value: (id: number) => captures.add(id) });
  Object.defineProperty(map, 'hasPointerCapture', { value: (id: number) => captures.has(id) });
  Object.defineProperty(map, 'releasePointerCapture', { value: (id: number) => captures.delete(id) });
  const measures = new Map<unknown, any>();
  const originalMeasure = view.requestMeasure.bind(view);
  view.requestMeasure = (request: any) => {
    if (request) measures.set(request.key, request);
  };
  const flush = () => {
    const requests = [...measures.values()];
    measures.clear();
    for (const request of requests) request.write(request.read());
  };
  const dispatch = view.dispatch.bind(view);
  const scrollEffects: any[] = [];
  view.dispatch = (spec: any) => {
    if (spec.effects) scrollEffects.push(spec.effects);
    dispatch(spec);
  };
  try {
    view.dispatch({ effects: setMinimapRanges.of([{ from: 100, to: 110, kind: 'conflict' }]) });
    flush();
    assert.equal(canvas.width, 64);
    assert.ok(calls.length > 1000);
    const drawn = calls.length;
    for (let i = 0; i < 120; i++) view.scrollDOM.dispatchEvent(new window.Event('scroll'));
    assert.equal(measures.size, 1);
    flush();
    assert.equal(calls.length, drawn, 'scrolling only moves the viewport box');
    const selection = view.state.selection;
    const pointer = (type: string, y: number, button = 0) =>
      map.dispatchEvent(new window.PointerEvent(type, { button, pointerId: 1, clientY: y, bubbles: true }));
    pointer('pointerdown', 200, 2);
    assert.equal(captures.size, 0);
    pointer('pointerdown', 200);
    assert.equal(captures.size, 1);
    assert.equal(map.getAttribute('aria-valuenow'), '1001');
    pointer('pointermove', 400);
    assert.equal(map.getAttribute('aria-valuenow'), '2000');
    pointer('pointerup', 400);
    assert.equal(captures.size, 0);
    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(map.getAttribute('aria-valuenow'), '1');
    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(map.getAttribute('aria-valuenow'), '2');
    assert.ok(scrollEffects.length >= 4);
    assert.equal(view.state.selection, selection);
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nnew' } });
    flush();
    assert.equal(map.getAttribute('aria-valuemax'), '2001');
    view.dispatch({ effects: mode.reconfigure([]) });
    measures.clear();
    assert.equal(host.querySelector('.code-minimap'), null);
    view.scrollDOM.dispatchEvent(new window.Event('scroll'));
    assert.equal(measures.size, 0);
  } finally {
    view.requestMeasure = originalMeasure;
    view.destroy();
    host.remove();
  }
});
