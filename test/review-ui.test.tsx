import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { EditorView } from '@codemirror/view';
import { BrowserWorker } from './browser-worker';
import { buildChanges } from '../src/shared/intellijDiff';
import { lineAnchors, mapLine } from '../src/review/line-map';
import type { CommitReview, FileSnapshot, Pane } from '../src/review/types';
import type { Details } from '../src/api';

const window = new Window({ url: 'http://localhost' });
for (const name of [
  'window',
  'document',
  'navigator',
  'localStorage',
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
  'PointerEvent',
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'window' ? window : window[name],
  });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window) as typeof getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const jobs: any[] = [];
let terminations = 0;
class TestWorker extends BrowserWorker {
  override postMessage(data: any) {
    jobs.push(data);
    super.postMessage(data);
  }
  override terminate() {
    terminations++;
    super.terminate();
  }
}
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
const { default: Viewer } = await import('../src/review/CommitReviewViewer');
const { ReviewController } = await import('../src/review/controller');
const { setMinimapEnabled } = await import('../src/ui/editor-preferences');
const root = document.body.appendChild(document.createElement('div'));
after(() => window.happyDOM.close());

async function waitFor(predicate: () => unknown) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Viewer did not reach expected state. ${root.textContent}`);
}

function button(label: string) {
  const value = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
  );
  assert.ok(value, label);
  return value;
}

function snapshot(path: string, text: string, state: FileSnapshot['state'] = 'text'): FileSnapshot {
  return { path, text, state, revision: null, fingerprint: `${state}:${text}` };
}

const details: Details = {
  commit: {
    hash: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    author: 'Dev',
    email: 'dev@example.test',
    time: 0,
    subject: 'Selected commit',
    refs: [],
  },
  body: '',
  changes: ['first.ts', 'second.ts'].map((path) => ({
    path,
    oldPath: null,
    index: 'M',
    workTree: ' ',
    conflict: false,
  })),
};

function fixture() {
  const calls: { command: string; args: any }[] = [];
  let working = 'current\n';
  let failure = '';
  globalThis.testBackend = async (command: string, args: any) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === 'read_commit_review') {
      return {
        revision: args.revision,
        parent: 'b'.repeat(40),
        before: snapshot(args.path, 'before\n'),
        after: snapshot(args.path, 'after\n'),
        current: { file: snapshot(args.path, working), branch: 'main', head: 'c'.repeat(40) },
      } satisfies CommitReview;
    }
    if (command === 'read_review_worktree') {
      if (failure) throw new Error(failure);
      return { file: snapshot(args.path, working), branch: 'main', head: 'c'.repeat(40) };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  localStorage.clear();
  setMinimapEnabled(false);
  jobs.length = 0;
  terminations = 0;
  return {
    calls,
    working: (value: string) => {
      working = value;
    },
    failure: (value: string) => {
      failure = value;
    },
  };
}

function show(version = 1) {
  render(
    <Viewer
      root="C:/fixture"
      details={details}
      initialPath="first.ts"
      version={version}
      onClose={() => render(null, root)}
    />,
    root,
  );
}

test('line mappings preserve unchanged regions across insertions, deletions and reverse traversal', () => {
  const before = ['a', 'b', 'c', 'd', 'e'];
  const after = ['a', 'b', 'inserted', 'c', 'e'];
  const anchors = lineAnchors(buildChanges(before, after), before.length, after.length);
  assert.equal(mapLine(anchors, 1), 1);
  assert.equal(mapLine(anchors, 3), 4);
  assert.equal(mapLine(anchors, 4), 4);
  assert.equal(mapLine(anchors, 1, true), 1);
  assert.equal(mapLine(anchors, 5, true), 5);
  assert.equal(mapLine([], 12), 12);
});

test('large review opt-in loads all three snapshots and preserves the mode when refreshing current content', async () => {
  fixture();
  const calls: { command: string; args: any }[] = [];
  const text = 'source line\n'.repeat(30_000);
  globalThis.testBackend = async (command: string, args: any) => {
    calls.push({ command, args });
    const file = args.allowLarge
      ? { ...snapshot(args.path, text), large: true }
      : { ...snapshot(args.path, '', 'too-large'), canLoad: true, large: true };
    if (command === 'read_review_worktree') return { file, branch: 'main', head: 'c'.repeat(40) };
    return { revision: args.revision, parent: 'b'.repeat(40), before: file, after: file,
      current: { file, branch: 'main', head: 'c'.repeat(40) } };
  };
  try {
    show();
    await waitFor(() => root.textContent?.includes('加载大文件'));
    assert.equal(root.querySelectorAll('.cm-editor').length, 0);
    button('加载大文件').click();
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 3);
    assert.equal(calls[1].args.allowLarge, true);
    const historical = root.querySelector('.review-after .cm-editor');
    assert.equal(EditorView.findFromDOM(historical as HTMLElement)!.state.doc.lines, 30_001);
    button('刷新当前内容').click();
    await waitFor(() => calls.some(call => call.command === 'read_review_worktree'));
    assert.equal(calls.at(-1)!.args.allowLarge, true);
    assert.equal(root.querySelector('.review-after .cm-editor'), historical);
  } finally { render(null, root); }
});

test('working-tree refresh reads only current content and preserves historical editors and selection', async () => {
  const state = fixture();
  show();
  try {
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 3);
    const before = root.querySelector('.review-before .cm-editor');
    const after = root.querySelector('.review-after .cm-editor');
    const view = EditorView.findFromDOM(after as HTMLElement)!;
    view.dispatch({ selection: { anchor: 2 } });
    assert.equal(jobs.length, 2);
    state.working('refreshed current\n');
    show(2);
    await waitFor(() => root.querySelector('.review-update-notice'));
    button('刷新当前内容').click();
    await waitFor(() =>
      root.querySelector('.review-current .cm-content')?.textContent?.includes('refreshed current'),
    );
    assert.equal(root.querySelector('.review-before .cm-editor'), before);
    assert.equal(root.querySelector('.review-after .cm-editor'), after);
    assert.equal(view.state.selection.main.anchor, 2);
    assert.equal(state.calls.filter((call) => call.command === 'read_commit_review').length, 1);
    assert.equal(state.calls.filter((call) => call.command === 'read_review_worktree').length, 1);
    assert.equal(jobs.length, 3);
    assert.equal(root.querySelector('.review-update-notice'), null);
    button('刷新当前内容').click();
    await waitFor(
      () =>
        state.calls.filter((call) => call.command === 'read_review_worktree').length === 2 &&
        !root.querySelector('.review-loading'),
    );
    assert.equal(jobs.length, 3, 'unchanged current content reuses the prepared diff');
    assert.equal(root.querySelector('.review-after .cm-editor'), after);
  } finally {
    render(null, root);
  }
});

test('comparison scope, navigation and minimap controls reuse the same three read-only editors', async () => {
  fixture();
  show();
  try {
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 3);
    const editors = [...root.querySelectorAll('.cm-editor')];
    const select = root.querySelector<HTMLSelectElement>('[aria-label="三栏比较范围"]')!;
    select.value = 'current';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => root.querySelector('.review-current .line-added'));
    assert.equal(root.querySelector('.review-before .line-removed'), null);
    button('下一处变化').click();
    const minimap = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.parentElement?.textContent?.includes('代码缩略图'),
    )!;
    minimap.checked = true;
    minimap.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => root.querySelectorAll('.code-minimap').length === 3);
    assert.equal(localStorage.getItem('editor.minimap.enabled'), 'true');
    assert.deepEqual([...root.querySelectorAll('.cm-editor')], editors);
    assert.equal(root.querySelectorAll('[role="separator"]').length, 3);
    for (const content of root.querySelectorAll('.cm-content'))
      assert.equal(content.getAttribute('contenteditable'), 'false');
  } finally {
    render(null, root);
  }
});

test('file switching pins commit identity and reuses immutable snapshots while rereading the worktree', async () => {
  const state = fixture();
  show();
  try {
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 3);
    button('下一个变更文件').click();
    await waitFor(
      () =>
        root.querySelector('.review-after header')?.textContent?.includes('second.ts') &&
        root.querySelectorAll('.cm-editor').length === 3,
    );
    button('上一个变更文件').click();
    await waitFor(
      () =>
        root.querySelector('.review-after header')?.textContent?.includes('first.ts') &&
        root.querySelectorAll('.cm-editor').length === 3,
    );
    assert.equal(state.calls.filter((call) => call.command === 'read_commit_review').length, 2);
    assert.equal(state.calls.filter((call) => call.command === 'read_review_worktree').length, 1);
    for (const call of state.calls.filter((call) => call.command === 'read_commit_review'))
      assert.equal(call.args.revision, details.commit.hash);
  } finally {
    render(null, root);
  }
});

test('failed current-file association preserves displayed snapshots and reports the failure', async () => {
  const state = fixture();
  show();
  (globalThis as any).testDialog = async () => 'C:/outside/file.ts';
  try {
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 3);
    const after = root.querySelector('.review-after .cm-editor');
    state.failure('请选择当前仓库内的文件');
    button('关联当前文件').click();
    await waitFor(() => root.querySelector('[role="alert"]')?.textContent?.includes('当前仓库内'));
    assert.equal(root.querySelector('.review-after .cm-editor'), after);
    assert.equal(root.querySelector('.review-current .cm-content')?.textContent, 'current');
    assert.equal(state.calls.at(-1)?.args.path, 'C:/outside/file.ts');
  } finally {
    render(null, root);
    delete (globalThis as any).testDialog;
  }
});

test('unsupported current snapshots keep historical text visible and pending reads are discarded on close', async () => {
  fixture();
  const backend = globalThis.testBackend;
  globalThis.testBackend = async (command: string, args: any) => {
    const result = await backend(command, args);
    if (command === 'read_commit_review') result.current.file = snapshot(args.path, '', 'binary');
    return result;
  };
  show();
  try {
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 2);
    assert.ok(root.querySelector('.review-current')?.textContent?.includes('二进制文件'));
    assert.equal(root.querySelector('.review-after .cm-content')?.textContent, 'after');
    const before = terminations;
    let finish: ((value: any) => void) | undefined;
    globalThis.testBackend = async () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    button('刷新当前内容').click();
    await waitFor(() => finish);
    button('关闭三栏查看器').click();
    assert.equal(
      terminations,
      before,
      'pending reads do not start a worker before content arrives',
    );
    finish!({ file: snapshot('first.ts', 'late content'), branch: 'main', head: null });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(root.querySelector('.cm-editor'), null);
    assert.ok(!root.textContent?.includes('late content'));
  } finally {
    render(null, root);
  }
});

test('three-pane scrolling coalesces events and uses line anchors without feedback loops', async () => {
  localStorage.clear();
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  const beforeText = lines.join('\n');
  const afterText = [...lines.slice(0, 100), 'inserted', ...lines.slice(100)].join('\n');
  const currentText = [...lines.slice(0, 100), 'inserted', 'working', ...lines.slice(100)].join(
    '\n',
  );
  const document: CommitReview = {
    revision: details.commit.hash,
    parent: 'b'.repeat(40),
    before: snapshot('file.ts', beforeText),
    after: snapshot('file.ts', afterText),
    current: { file: snapshot('file.ts', currentText), branch: 'main', head: null },
  };
  const hosts = Object.fromEntries(
    (['before', 'after', 'current'] as Pane[]).map((pane) => [
      pane,
      root.appendChild(window.document.createElement('div')),
    ]),
  ) as Record<Pane, HTMLElement>;
  const data = (before: string, after: string) => ({
    before,
    after,
    changes: buildChanges(before.split('\n'), after.split('\n')),
  });
  const controller = new ReviewController(
    hosts,
    document,
    { commit: data(beforeText, afterText), current: data(afterText, currentText) },
    'commit',
    false,
    () => {},
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    let measurements = 0;
    const measures: any[] = [];
    for (const view of Object.values(controller.views)) {
      Object.defineProperty(view.scrollDOM, 'clientHeight', { configurable: true, value: 100 });
      Object.defineProperty(view.scrollDOM, 'scrollHeight', { configurable: true, value: 12000 });
      view.lineBlockAtHeight = (height: number) => {
        measurements++;
        const line = Math.min(view.state.doc.lines, Math.floor(height / 20) + 1);
        return {
          from: view.state.doc.line(line).from,
          to: view.state.doc.line(line).to,
          top: (line - 1) * 20,
          bottom: line * 20,
          height: 20,
        } as any;
      };
      view.lineBlockAt = (position: number) => {
        measurements++;
        const line = view.state.doc.lineAt(position).number;
        return {
          from: position,
          to: position,
          top: (line - 1) * 20,
          bottom: line * 20,
          height: 20,
        } as any;
      };
      view.requestMeasure = (request) => {
        const previous = measures.findIndex((item) => item.key === request.key);
        if (previous >= 0) measures[previous] = request;
        else measures.push(request);
      };
    }
    const source = controller.views.before!;
    source.scrollDOM.scrollTop = 4000;
    for (let i = 0; i < 100; i++) source.scrollDOM.dispatchEvent(new window.Event('scroll'));
    assert.equal(measures.length, 1);
    const request = measures.pop();
    request.write(request.read());
    assert.equal(measurements, 3);
    assert.equal(controller.views.after!.scrollDOM.scrollTop, 4020);
    assert.equal(controller.views.current!.scrollDOM.scrollTop, 4040);
    controller.views.after!.scrollDOM.dispatchEvent(new window.Event('scroll'));
    controller.views.current!.scrollDOM.dispatchEvent(new window.Event('scroll'));
    assert.equal(measures.length, 0);
    controller.setSync(false);
    source.scrollDOM.scrollTop = 1000;
    source.scrollDOM.dispatchEvent(new window.Event('scroll'));
    assert.equal(measures.length, 0);
  } finally {
    controller.destroy();
    root.replaceChildren();
  }
});

test('closing during background diff calculation terminates its worker and discards the result', async () => {
  class DelayedWorker extends TestWorker {
    private timer: ReturnType<typeof setTimeout> | undefined;
    override postMessage(data: any) { this.timer = setTimeout(() => super.postMessage(data), 200); }
    override terminate() { clearTimeout(this.timer); super.terminate(); }
  }
  fixture();
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: DelayedWorker });
  show();
  try {
    await waitFor(() => root.querySelector('.review-loading'));
    await new Promise(resolve => setTimeout(resolve, 100));
    button('关闭三栏查看器').click();
    assert.equal(terminations, 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(root.querySelector('.cm-editor'), null);
    assert.equal(jobs.length, 0);
  } finally { render(null, root); Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker }); }
});
