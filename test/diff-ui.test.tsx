import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { BrowserWorker } from './browser-worker';
import type { DiffTarget, FileDiff } from '../src/api';

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
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: name === 'window' ? window : window[name],
  });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window) as typeof getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const jobs: unknown[] = [];
class TestWorker extends BrowserWorker {
  override postMessage(data: unknown) {
    jobs.push(data);
    super.postMessage(data);
  }
}
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
const { DiffView } = await import('../src/DiffView');
const { EditorView } = await import('@codemirror/view');
const root = document.body.appendChild(document.createElement('div'));
after(() => window.happyDOM.close());

async function waitFor(predicate: () => unknown) {
  for (let i = 0; i < 120; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('The file diff did not reach the expected state');
}

function target(path = 'example.txt', revision: string | null = 'a'.repeat(40)): DiffTarget {
  return { path, oldPath: null, revision };
}

function show(request: DiffTarget, version = 0) {
  render(<DiffView root="C:/fixture" target={request} version={version} />, root);
}

function textAfter() {
  return root.querySelector('.diff-editors > div:last-child .cm-content')?.textContent ?? '';
}

test('unchanged refreshes preserve editors and a historical file is reused from the bounded cache', async () => {
  const calls: string[] = [];
  jobs.length = 0;
  globalThis.testBackend = async (_command: string, args: any) => {
    calls.push(args.request.path);
    return { before: 'before\r\n', after: args.request.path + '\r\n', binary: false, tooLarge: false };
  };
  try {
    show(target('first.txt'));
    await waitFor(() => textAfter().includes('first.txt'));
    const editor = root.querySelector('.cm-editor');
    show(target('first.txt'), 1);
    await waitFor(() => calls.length === 2 && !root.querySelector('[role="status"]'));
    assert.equal(root.querySelector('.cm-editor'), editor);
    assert.equal(jobs.length, 1, 'unchanged CRLF content avoids another worker calculation');
    show(target('second.txt'), 1);
    await waitFor(() => textAfter().includes('second.txt'));
    show(target('first.txt'), 1);
    await waitFor(() => textAfter().includes('first.txt'));
    assert.deepEqual(calls, ['first.txt', 'first.txt', 'second.txt']);
    assert.equal(jobs.length, 2);
  } finally {
    render(null, root);
  }
});

test('worktree refreshes reread changed content and still report binary, large-file and read errors', async () => {
  let file: FileDiff = { before: 'base\n', after: 'working one\n', binary: false, tooLarge: false };
  let failure = '';
  globalThis.testBackend = async () => {
    if (failure) throw new Error(failure);
    return file;
  };
  const request = target('working.txt', null);
  try {
    show(request);
    await waitFor(() => textAfter().includes('working one'));
    file = { ...file, after: 'working two\n' };
    show(request, 1);
    await waitFor(() => textAfter().includes('working two'));
    file = { before: '', after: '', binary: true, tooLarge: false };
    show(request, 2);
    await waitFor(() => root.textContent?.includes('二进制文件'));
    assert.equal(root.querySelector('.cm-editor'), null);
    file = { ...file, binary: false, tooLarge: true };
    show(request, 3);
    await waitFor(() => root.textContent?.includes('超过自动加载阈值'));
    failure = 'read failed';
    show(request, 4);
    await waitFor(() => root.querySelector('[role="alert"]')?.textContent?.includes(failure));
  } finally {
    render(null, root);
  }
});

test('large file loading is explicit and renders two hundred thousand changed lines with viewport highlights', async () => {
  const calls: any[] = [];
  const after = 'changed source line\n'.repeat(199_999);
  globalThis.testBackend = async (_command: string, args: any) => {
    calls.push(args);
    return args.allowLarge
      ? { before: '', after, binary: false, tooLarge: false, large: true }
      : { before: '', after: '', binary: false, tooLarge: true, canLoad: true };
  };
  try {
    show(target('large.txt'));
    await waitFor(() => root.textContent?.includes('加载大文件'));
    assert.equal(root.querySelector('.cm-editor'), null);
    assert.equal(calls[0].allowLarge, false);
    const load = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '加载大文件')!;
    load.click();
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 2);
    const view = EditorView.findFromDOM(root.querySelector('.diff-editors > div:last-child .cm-editor') as HTMLElement)!;
    assert.equal(view.state.doc.lines, 200_000);
    assert.equal(calls[1].allowLarge, true);
    assert.ok(root.textContent?.includes('大文件模式'));
    assert.ok(root.querySelectorAll('.line-added').length < 1000);
    const minimap = [...root.querySelectorAll<HTMLInputElement>('input')].find(input => input.parentElement?.textContent?.includes('代码缩略图'))!;
    assert.equal(minimap.disabled, true);
  } finally { render(null, root); }
});

test('out-of-order file reads discard the old result before starting expensive analysis', async () => {
  const pending = new Map<string, (file: FileDiff) => void>();
  jobs.length = 0;
  globalThis.testBackend = async (_command: string, args: any) =>
    new Promise<FileDiff>((resolve) => pending.set(args.request.path, resolve));
  try {
    show(target('slow.txt'));
    await waitFor(() => pending.has('slow.txt'));
    show(target('latest.txt'));
    await waitFor(() => pending.has('latest.txt'));
    pending.get('latest.txt')!({ before: '', after: 'latest result\n', binary: false, tooLarge: false });
    await waitFor(() => textAfter().includes('latest result'));
    pending.get('slow.txt')!({ before: '', after: 'obsolete result\n', binary: false, tooLarge: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(textAfter().includes('latest result'));
    assert.equal(jobs.length, 1);
  } finally {
    render(null, root);
  }
});

test('historical caching evicts old files after four entries', async () => {
  const calls: string[] = [];
  globalThis.testBackend = async (_command: string, args: any) => {
    calls.push(args.request.path);
    return { before: '', after: args.request.path, binary: false, tooLarge: false };
  };
  try {
    for (let i = 0; i < 5; i++) {
      show(target(`file-${i}.txt`));
      await waitFor(() => textAfter().includes(`file-${i}.txt`));
    }
    show(target('file-0.txt'));
    await waitFor(() => textAfter().includes('file-0.txt'));
    assert.equal(calls.filter((path) => path === 'file-0.txt').length, 2);
  } finally {
    render(null, root);
  }
});

test('file scrolling batches geometry reads and ignores feedback from synchronized panes', async () => {
  globalThis.testBackend = async () => ({
    before: 'before\n',
    after: 'after\n',
    binary: false,
    tooLarge: false,
  });
  try {
    show(target());
    await waitFor(() => root.querySelectorAll('.cm-editor').length === 2);
    const [left, right] = [...root.querySelectorAll<HTMLElement>('.cm-editor')].map((element) =>
      EditorView.findFromDOM(element)!,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const queued = new Map<unknown, any>();
    left.requestMeasure = (request) => {
      if (request) queued.set(request.key, request);
    };
    for (const [view, height] of [
      [left, 1000],
      [right, 2000],
    ] as const) {
      Object.defineProperty(view.scrollDOM, 'scrollHeight', { configurable: true, value: height });
      Object.defineProperty(view.scrollDOM, 'clientHeight', { configurable: true, value: 100 });
    }
    left.scrollDOM.scrollTop = 90;
    for (let i = 0; i < 120; i++) left.scrollDOM.dispatchEvent(new window.Event('scroll'));
    assert.equal(queued.size, 1);
    const pass = [...queued.values()][0];
    pass.write(pass.read(left), left);
    assert.equal(right.scrollDOM.scrollTop, 190);
    queued.clear();
    right.scrollDOM.dispatchEvent(new window.Event('scroll'));
    assert.equal(queued.size, 0);
    right.scrollDOM.scrollTop = 380;
    right.scrollDOM.dispatchEvent(new window.Event('scroll'));
    const reverse = [...queued.values()][0];
    reverse.write(reverse.read(left), left);
    assert.equal(left.scrollDOM.scrollTop, 180);
  } finally {
    render(null, root);
  }
});
