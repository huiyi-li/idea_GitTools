import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { BrowserWorker } from './browser-worker';

const window = new Window({ url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'Range', 'MouseEvent', 'KeyboardEvent', 'PointerEvent'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: BrowserWorker });
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.getComputedStyle = window.getComputedStyle.bind(window) as typeof getComputedStyle;
const { App } = await import('../src/App');
const host = document.body.appendChild(document.createElement('div'));
afterEach(() => { render(null, host); localStorage.clear(); });
after(() => window.happyDOM.close());
const a = 'C:/workspace/apps/api';
const b = 'C:/workspace/libs/api';
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
async function waitFor(predicate: () => unknown) {
  for (let count = 0; count < 160; count++) { if (predicate()) return; await tick(); }
  assert.fail(`UI did not settle: ${host.textContent}`);
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label || element.getAttribute('aria-label') === label);
  assert.ok(found, label); return found;
}
function input(label: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  localStorage.clear();
  const calls: { command: string; args: any }[] = [];
  const states: Record<string, any> = {};
  for (const [root, name] of [[a, 'A'], [b, 'B']]) {
    states[root] = {
      repository: { root, name: 'api', branch: `${name}-main`, head: name.toLowerCase().repeat(40), operation: 'none' },
      branches: [], stashes: [], changes: [{ path: 'shared.txt', oldPath: null, index: 'M', workTree: 'M', conflict: false }],
    };
    localStorage.setItem(`commit.messages.${root}`, JSON.stringify([`${name} previous message`]));
  }
  let active = '';
  const options: { rejectB?: boolean; beforeCommit?: Promise<void>; oldDiff?: Promise<any>; truncated?: boolean } = {};
  (globalThis as any).testBackend = async (command: string, args: any) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === 'initial_repository') return null;
    if (command === 'discover_workspace') return {
      root: 'C:/workspace', repositories: [
        { root: a, name: 'api', relativePath: 'apps/api' },
        { root: b, name: 'api', relativePath: 'libs/api' },
      ], truncated: !!options.truncated, warnings: options.truncated ? ['Depth limit reached'] : [],
    };
    if (command === 'open_repository') {
      if (options.rejectB && args.path === b) throw Error('selected repository no longer exists');
      assert.ok(states[args.path], `explicit repository root: ${args.path}`);
      active = args.path;
      return structuredClone(states[active]);
    }
    assert.equal(args.root, active, `${command} must address the selected repository`);
    if (command === 'repository_status') return structuredClone(states[active]);
    if (command === 'read_log') return { commits: [], hasMore: false };
    if (command === 'recovery_overview') return { records: [], operation: 'none', originalHead: null, current: null, progress: null, reason: '' };
    if (command === 'read_worktrees') return { head: states[active].repository.head, branches: [], entries: [] };
    if (command === 'local_history_capture') return;
    if (command === 'read_diff') {
      if (active === a && options.oldDiff) return options.oldDiff;
      const name = active === a ? 'A' : 'B';
      return { before: `${name} staged\n`, after: `${name} worktree\n`, binary: false, tooLarge: false };
    }
    if (command === 'stage_paths') {
      const state = states[args.root];
      state.changes[0].index = args.unstage ? ' ' : 'M';
      return;
    }
    if (command === 'create_commit') {
      await options.beforeCommit;
      states[args.root].changes[0].index = ' ';
      return 'committed';
    }
    throw Error(command);
  };
  render(<App />, host);
  return { calls, states, options };
}
async function scanWorkspace() {
  button('打开工作区文件夹').click();
  await waitFor(() => host.querySelector('[aria-label="工作区文件夹"]'));
  input('工作区文件夹', 'C:/workspace');
  await tick();
  button('扫描仓库').click();
  await waitFor(() => host.querySelector('[aria-label="管理仓库 apps/api"]'));
}
async function openFirst() {
  await scanWorkspace();
  button('管理仓库 apps/api').click();
  await waitFor(() => host.querySelector('[aria-label="选择工作区仓库"]'));
}
async function changes() {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')].find(element => element.textContent?.startsWith('提交'))!;
  tab.click(); await waitFor(() => host.querySelector('#commit-message'));
}
function setMessage(value: string) {
  const element = host.querySelector<HTMLTextAreaElement>('#commit-message')!;
  element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function selectRepository(root: string) {
  const select = host.querySelector<HTMLSelectElement>('[aria-label="选择工作区仓库"]')!;
  select.value = root; select.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function selectFile() { host.querySelector<HTMLButtonElement>('.changes-panel .file-select')!.click(); }

 test('workspace scan does not open or merge repositories before an explicit choice', async () => {
  const { calls, options } = fixture();
  options.truncated = true;
  await scanWorkspace();
  assert.ok(host.textContent?.includes('apps/api'));
  assert.ok(host.textContent?.includes('libs/api'));
  assert.ok(host.textContent?.includes('扫描未覆盖全部目录'));
  assert.ok(!calls.some(call => call.command === 'open_repository'));
  button('管理仓库 libs/api').click();
  await waitFor(() => host.querySelector('[aria-label="选择工作区仓库"]'));
  const opened = calls.find(call => call.command === 'open_repository')!;
  assert.deepEqual(opened.args, { path: b, exactRoot: true });
  assert.ok(!calls.some(call => ['create_commit', 'stage_paths', 'multi_repository_sync'].includes(call.command)));
});

test('same-name repositories keep commit drafts, staged state and diff selections independent', async () => {
  const { calls, states } = fixture();
  await openFirst(); await changes();
  setMessage('A draft'); selectFile();
  await waitFor(() => host.querySelector('.cm-content')?.textContent?.includes('A staged'));
  assert.ok(host.querySelector('[aria-label="本次提交仓库"]')?.textContent?.includes(a));
  selectRepository(b);
  await waitFor(() => host.querySelector('[aria-label="本次提交仓库"]')?.textContent?.includes(b));
  assert.equal(host.querySelector<HTMLTextAreaElement>('#commit-message')!.value, '');
  assert.equal(host.querySelector('.diff-editors'), null);
  assert.ok(!host.querySelector('[aria-label="提交说明历史"]')?.textContent?.includes('A previous message'));
  setMessage('B draft'); selectFile();
  await waitFor(() => host.querySelector('.diff-editors')?.textContent?.includes('B worktree'));
  assert.ok(!host.querySelector('.diff-editors')?.textContent?.includes('A worktree'));
  selectRepository(a);
  await waitFor(() => host.querySelector<HTMLTextAreaElement>('#commit-message')?.value === 'A draft');
  await waitFor(() => host.querySelector('.diff-editors')?.textContent?.includes('A worktree'));
  selectRepository(b);
  await waitFor(() => host.querySelector<HTMLTextAreaElement>('#commit-message')?.value === 'B draft');
  button('提交暂存内容').click();
  await waitFor(() => calls.some(call => call.command === 'create_commit'));
  await waitFor(() => host.querySelector<HTMLTextAreaElement>('#commit-message')?.value === '');
  assert.deepEqual(calls.filter(call => call.command === 'create_commit').map(call => call.args), [{ root: b, message: 'B draft' }]);
  assert.equal(states[a].changes[0].index, 'M');
  assert.equal(states[b].changes[0].index, ' ');
  selectRepository(a);
  await waitFor(() => host.querySelector<HTMLTextAreaElement>('#commit-message')?.value === 'A draft');
  assert.equal(localStorage.getItem(`commit.draft.${a}`), '"A draft"');
  assert.equal(localStorage.getItem(`commit.draft.${b}`), '""');
  render(null, host); render(<App />, host);
  await waitFor(() => host.querySelector<HTMLButtonElement>(`.recent button[title="${a}"]`));
  host.querySelector<HTMLButtonElement>(`.recent button[title="${a}"]`)!.click();
  await waitFor(() => host.querySelector('.workspace-tabs')); await changes();
  assert.equal(host.querySelector<HTMLTextAreaElement>('#commit-message')!.value, 'A draft');
});

test('commit locks repository switching and a failed switch preserves the original draft', async () => {
  const { calls, options } = fixture();
  await openFirst(); await changes();
  setMessage('A pending'); await tick();
  options.rejectB = true;
  selectRepository(b);
  await waitFor(() => host.textContent?.includes('selected repository no longer exists'));
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="选择工作区仓库"]')!.value, a);
  assert.equal(host.querySelector<HTMLTextAreaElement>('#commit-message')!.value, 'A pending');
  const pending = deferred<void>(); options.beforeCommit = pending.promise;
  button('提交暂存内容').click();
  await waitFor(() => calls.some(call => call.command === 'create_commit'));
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="选择工作区仓库"]')!.disabled, true);
  const before = calls.filter(call => call.command === 'open_repository').length;
  selectRepository(b);
  await tick();
  assert.equal(calls.filter(call => call.command === 'open_repository').length, before);
  pending.resolve();
  await waitFor(() => !host.querySelector<HTMLSelectElement>('[aria-label="选择工作区仓库"]')!.disabled);
  assert.equal(calls.find(call => call.command === 'create_commit')!.args.root, a);
});

test('late diff reads from a previous repository cannot overwrite the selected repository', async () => {
  const { calls, options } = fixture();
  const pending = deferred<any>(); options.oldDiff = pending.promise;
  await openFirst(); await changes(); selectFile();
  await waitFor(() => calls.some(call => call.command === 'read_diff' && call.args.root === a));
  selectRepository(b);
  await waitFor(() => host.querySelector('[aria-label="本次提交仓库"]')?.textContent?.includes(b));
  selectFile();
  await waitFor(() => host.querySelector('.diff-editors')?.textContent?.includes('B worktree'));
  pending.resolve({ before: 'A late before', after: 'A late after', binary: false, tooLarge: false });
  await tick();
  assert.ok(host.querySelector('.diff-editors')?.textContent?.includes('B worktree'));
  assert.ok(!host.querySelector('.diff-editors')?.textContent?.includes('A late'));
});
