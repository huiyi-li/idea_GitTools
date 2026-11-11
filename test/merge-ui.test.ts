import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { DEFAULT_MERGE_SETTINGS, type MergeInit } from '../src/shared/mergeProtocol';
import type { MergeChange } from '../src/shared/mergeModel';

const window = new Window();
for (const name of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Text',
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

const { MergeController } = await import('../src/merge/controller');
after(() => window.happyDOM.close());

function editor(
  patch: Partial<MergeInit> = {},
  background?: ConstructorParameters<typeof MergeController>[3],
  changes?: MergeChange[],
) {
  const root = document.createElement('div');
  root.className = 'mg-panes';
  const hosts = {} as Record<'left' | 'result' | 'right', HTMLElement>;
  for (const pane of ['left', 'result', 'right'] as const) {
    const container = root.appendChild(document.createElement('div'));
    hosts[pane] = container.appendChild(document.createElement('div'));
  }
  const dividers = [0, 1].map(() =>
    root.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
  ) as [SVGSVGElement, SVGSVGElement];
  document.body.appendChild(root);
  const init: MergeInit = {
    path: 'example.txt',
    fileName: 'example.txt',
    base: 'start\nbase\nend\n',
    left: 'start\nlocal\nend\n',
    right: 'start\nincoming\nend\n',
    titles: { left: [], result: [], right: [] },
    settings: { ...DEFAULT_MERGE_SETTINGS },
    contextLines: 1,
    iterative: true,
    ...patch,
  };
  const controller = new MergeController(init, init.settings, true, background);
  controller.mount(hosts, dividers, undefined, changes);
  return {
    controller,
    hosts,
    root,
    operation(side: 'left' | 'right', action = 'apply') {
      const element = hosts[side].querySelector<HTMLElement>(`.mg-op[data-action="${action}"]`);
      assert.ok(element, `${side} ${action} gutter operation is rendered`);
      return element;
    },
    close() {
      controller.destroy();
      root.remove();
    },
  };
}

function press(element: Element, options: MouseEventInit = {}) {
  element.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...options }),
  );
}

test('right gutter arrow accepts incoming text and left ignore resolves the conflict', () => {
  const e = editor();
  try {
    press(e.operation('right').querySelector('img')!);
    assert.equal(e.controller.resultLines().join('\n'), 'start\nincoming\nend\n');
    assert.equal(e.controller.stats.conflicts, 1);
    press(e.operation('left', 'ignore'));
    assert.equal(e.controller.stats.conflicts, 0);
  } finally {
    e.close();
  }
});

test('large merge decorations remain viewport bounded and arrows preserve a hundred thousand lines', () => {
  const base = 'base line\n'.repeat(99_999);
  const right = 'incoming line\n'.repeat(99_999);
  const changes: MergeChange[] = [{ index: 0, base: [0, 99_999], left: [0, 99_999], right: [0, 99_999],
    kind: 'conflict', leftChange: true, rightChange: true, canResolve: false }];
  const e = editor({ large: true, base, left: 'local line\n'.repeat(99_999), right }, undefined, changes);
  try {
    assert.equal(e.controller.views.result.state.doc.lines, 100_000);
    assert.ok(e.root.querySelectorAll('.mg-line').length < 1000);
    e.controller.setMinimap(true);
    assert.equal(e.root.querySelector('.code-minimap'), null);
    e.controller.apply(0, 'right', true);
    assert.equal(e.controller.resultLines().join('\n'), right);
    assert.equal(e.controller.stats.conflicts, 0);
    assert.ok(e.root.querySelectorAll('.mg-line').length < 1000);
    e.controller.undo();
    assert.equal(e.controller.resultLines().join('\n'), base);
  } finally { e.close(); }
});

test('Ctrl and Meta arrows resolve a whole conflict and support undo and redo', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const e = editor();
    try {
      press(e.operation('left'), { [modifier]: true });
      assert.equal(e.controller.resultLines().join('\n'), 'start\nlocal\nend\n');
      assert.equal(e.controller.stats.conflicts, 0);
      e.controller.undo();
      assert.equal(e.controller.resultLines().join('\n'), 'start\nbase\nend\n');
      assert.equal(e.controller.stats.conflicts, 1);
      e.controller.redo();
      assert.equal(e.controller.resultLines().join('\n'), 'start\nlocal\nend\n');
      assert.equal(e.controller.stats.conflicts, 0);
    } finally {
      e.close();
    }
  }
});

test('accepting left and right arrows keeps both sides in order', () => {
  const e = editor();
  try {
    press(e.operation('left'));
    press(e.operation('right'));
    assert.equal(e.controller.resultLines().join('\n'), 'start\nlocal\nincoming\nend\n');
    assert.equal(e.controller.stats.conflicts, 0);
  } finally {
    e.close();
  }
});

test('right mouse button does not accept a side and Ctrl ignore keeps the base', () => {
  const e = editor();
  try {
    press(e.operation('right'), { button: 2 });
    assert.equal(e.controller.resultLines().join('\n'), 'start\nbase\nend\n');
    assert.equal(e.controller.stats.conflicts, 1);
    press(e.operation('right', 'ignore'), { ctrlKey: true });
    assert.equal(e.controller.resultLines().join('\n'), 'start\nbase\nend\n');
    assert.equal(e.controller.stats.conflicts, 0);
  } finally {
    e.close();
  }
});

test('saving lock blocks arrows and keyboard activation works after unlocking', () => {
  const e = editor();
  try {
    e.controller.setLocked(true);
    press(e.operation('right'), { ctrlKey: true });
    assert.equal(e.controller.resultLines().join('\n'), 'start\nbase\nend\n');
    e.operation('right').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(e.controller.resultLines().join('\n'), 'start\nbase\nend\n');
    e.controller.setLocked(false);
    e.operation('right').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(e.controller.resultLines().join('\n'), 'start\nincoming\nend\n');
    e.operation('left', 'ignore').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert.equal(e.controller.stats.conflicts, 0);
  } finally {
    e.close();
  }
});

test('restart binds arrows once and destroy removes the event delegation', () => {
  const e = editor();
  let closed = false;
  try {
    e.controller.restart({ ...DEFAULT_MERGE_SETTINGS });
    const apply = e.controller.apply.bind(e.controller);
    let calls = 0;
    e.controller.apply = (...args) => {
      calls++;
      apply(...args);
    };
    press(e.operation('right'));
    assert.equal(calls, 1);
    const stale = e.operation('left');
    e.close();
    closed = true;
    e.hosts.left.appendChild(stale);
    press(stale);
    assert.equal(calls, 1);
  } finally {
    if (!closed) e.close();
  }
});

test('fold control expands unchanged fragments in all three panes', () => {
  const prefix = Array.from({ length: 12 }, (_, i) => `unchanged ${i}`).join('\n') + '\n';
  const e = editor({
    base: prefix + 'base\n',
    left: prefix + 'local\n',
    right: prefix + 'incoming\n',
    settings: { ...DEFAULT_MERGE_SETTINGS, collapseUnchanged: true },
  });
  try {
    const fold = e.hosts.result.querySelector('.mg-fold');
    assert.ok(fold);
    const group = (fold as HTMLElement).dataset.group;
    press(fold.querySelector('span')!);
    assert.equal(e.root.querySelectorAll(`.mg-fold[data-group="${group}"]`).length, 0);
  } finally {
    e.close();
  }
});

test('minimap navigation expands the target fold in all panes and keeps the merge result intact', () => {
  const prefix = Array.from({ length: 12 }, (_, i) => 'unchanged ' + i).join('\n') + '\n';
  const e = editor({
    base: prefix + 'base\n',
    left: prefix + 'local\n',
    right: prefix + 'incoming\n',
    settings: { ...DEFAULT_MERGE_SETTINGS, collapseUnchanged: true },
  });
  try {
    e.controller.setMinimap(true);
    const result = e.controller.views.result.state.doc.toString();
    assert.ok(e.root.querySelector('.mg-fold'));
    const map = e.hosts.result.querySelector<HTMLElement>('.code-minimap')!;
    map.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(e.root.querySelector('.mg-fold'), null);
    assert.equal(e.controller.views.result.state.doc.toString(), result);
    e.controller.setMinimap(false);
    assert.equal(e.root.querySelector('.code-minimap'), null);
  } finally {
    e.close();
  }
});

test('scrolling a file with 500 conflicts measures only the visible ranges once per frame', async (context) => {
  const base = Array.from(
    { length: 500 },
    (_, index) => `context ${index}\nbase ${index}\nunchanged ${index}\n`,
  ).join('');
  const e = editor({
    base,
    left: base.replaceAll('base ', 'left '),
    right: base.replaceAll('base ', 'right '),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    let hostReads = 0,
      blockReads = 0,
      measurements = 0;
    for (const pane of ['left', 'result', 'right'] as const) {
      const view = e.controller.views[pane];
      const rectangle = e.hosts[pane].getBoundingClientRect.bind(e.hosts[pane]);
      e.hosts[pane].getBoundingClientRect = () => {
        hostReads++;
        return rectangle();
      };
      const block = view.lineBlockAt.bind(view);
      view.lineBlockAt = (position) => {
        blockReads++;
        return block(position);
      };
      Object.defineProperty(view, 'viewport', {
        configurable: true,
        get: () => ({ from: 0, to: view.state.doc.line(31).to }),
      });
    }
    const result = e.controller.views.result;
    const measure = result.requestMeasure.bind(result);
    const queued = new Map<unknown, any>();
    result.requestMeasure = (request) => {
      if (request?.key === e.controller) {
        // Happy DOM has no layout frame. Preserve CodeMirror's keyed scheduling contract.
        queued.set(request.key, request);
        return;
      }
      return measure(request);
    };
    for (let i = 0; i < 120; i++) e.controller.views.left.scrollDOM.dispatchEvent(new window.Event('scroll'));
    assert.equal(queued.size, 1);
    const pass = queued.get(e.controller)!;
    measurements++;
    pass.write(pass.read(result), result);
    assert.equal(hostReads, measurements * 3);
    assert.ok(blockReads < 200, `visible changes use ${blockReads} block lookups`);
    context.diagnostic(
      `500 conflicts, 120 scroll events: ${measurements} measurement pass(es), ${hostReads} host layout reads, ${blockReads} block lookups`,
    );
  } finally {
    e.close();
  }
});

test('a late word-diff response cannot highlight an edited result or create an undo step', async () => {
  const requests: { inputs: any[]; resolve: (result: any[]) => void }[] = [];
  const analysis = {
    highlight: (inputs: any[]) => new Promise<any[]>((resolve) => requests.push({ inputs, resolve })),
  };
  const e = editor({}, { analysis: analysis as any });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(requests.length, 1);
    const view = e.controller.views.result;
    const line = view.state.doc.line(2);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: 'edited' }, userEvent: 'input.type' });
    requests[0].resolve([{ index: 0, inner: { left: [[0, 5]], base: [[0, 4]], right: [[0, 8]] } }]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].inputs[0].base, 'edited');
    assert.equal(e.hosts.result.querySelector('.mg-inner-conflict'), null);
    requests[1].resolve([{ index: 0, inner: { left: [], base: [[0, 6]], right: [] } }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(e.hosts.result.querySelector('.mg-inner-conflict')?.textContent, 'edited');
    e.controller.undo();
    assert.equal(e.controller.resultLines().join('\n'), 'start\nbase\nend\n');
    assert.equal(e.controller.stats.conflicts, 1);
  } finally {
    e.close();
  }
});

test('cached scroll mappings preserve insertion and deletion boundaries after accept and undo', () => {
  const e = editor({
    base: 'start\nbase\nend\n',
    left: 'prefix\nstart\nlocal\nend\nextra\n',
    right: 'start\nincoming\n',
  });
  const reference = (line: number, from: string, to: string): number => {
    if (from === to) return line;
    if (from !== 'result' && to !== 'result') return reference(reference(line, from, 'result'), 'result', to);
    const side = (from === 'result' ? to : from) as 'left' | 'right';
    const pairs: number[][] = [[0, 0]];
    for (const change of e.controller.changes) {
      const state = e.controller.states[change.index];
      pairs.push([change[side][0], state.start], [change[side][1], state.end]);
    }
    pairs.push([e.controller.views[side].state.doc.lines, e.controller.views.result.state.doc.lines]);
    const anchors = from === 'result' ? pairs.map(([side, result]) => [result, side]) : pairs;
    for (let i = 1; i < anchors.length; i++) {
      const [a0, b0] = anchors[i - 1],
        [a1, b1] = anchors[i];
      if (line <= a1) return a1 === a0 ? b1 : b0 + ((line - a0) * (b1 - b0)) / (a1 - a0);
    }
    const [a, b] = anchors[anchors.length - 1];
    return b + line - a;
  };
  const verify = () => {
    for (const from of ['left', 'result', 'right'])
      for (const to of ['left', 'result', 'right']) {
        for (let line = -1; line < 8; line += 0.25) {
          assert.equal((e.controller as any).mapLine(line, from, to), reference(line, from, to));
        }
      }
  };
  try {
    verify();
    const conflict = e.controller.changes.find((change) => change.kind === 'conflict')!;
    e.controller.apply(conflict.index, 'left', true);
    verify();
    e.controller.undo();
    verify();
  } finally {
    e.close();
  }
});
