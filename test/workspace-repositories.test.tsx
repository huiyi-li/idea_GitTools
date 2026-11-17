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
afterEach(() => { render(null, host); localStorage.clear(); delete (globalThis as any).testDialog; });
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
  const options: { rejectB?: boolean; beforeCommit?: Promise<void>; oldDiff?: Promise<any>; truncated?: boolean; missingA?: boolean; history?: Promise<boolean> } = {};
  (globalThis as any).testBackend = async (command: string, args: any) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === 'initial_repository') return null;
    if (command === 'discover_workspace') return {
      root: 'C:/workspace', repositories: [
        { root: a, name: 'api', relativePath: 'apps/api' },
        { root: b, name: 'api', relativePath: 'libs/api' },
      ].filter(repository => !options.missingA || repository.root !== a), truncated: !!options.truncated, warnings: options.truncated ? ['Depth limit reached'] : [],
    };
    if (command === 'open_repository') {
      if (options.rejectB && args.path === b) throw Error('selected repository no longer exists');
      assert.ok(states[args.path], `explicit repository root: ${args.path}`);
      active = args.path;
      return structuredClone(states[active]);
    }
    if (command === 'workspace_repository_summary') {
      assert.ok(states[args.root]);
      return { root: args.root, branch: states[args.root].repository.branch, changedFiles: 1, stagedFiles: 1, conflicts: 0 };
    }
    if (command === 'close_repository') { assert.equal(args.root, active); active = ''; return; }
    if (command === 'local_history_capture_background') return options.history ?? (args.root === active);
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
  await waitFor(() => host.querySelector('.repository-tablist'));
}
async function changes() {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')].find(element => element.textContent?.startsWith('提交'))!;
  tab.click(); await waitFor(() => host.querySelector('#commit-message'));
}
function setMessage(value: string) {
  const element = host.querySelector<HTMLTextAreaElement>('#commit-message')!;
  element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function repositoryTab(root: string) {
  const tab = host.querySelector<HTMLButtonElement>(`[role="tab"][data-repository-root="${root}"]`);
  assert.ok(tab, `tab for ${root}`); return tab;
}
function selectRepository(root: string) { repositoryTab(root).click(); }
function selectFile() { host.querySelector<HTMLButtonElement>('.changes-panel .file-select')!.click(); }

test('opening a folder creates visible repository tabs without a scan dialog', async () => {
  const { calls } = fixture();
  (globalThis as any).testDialog = async () => 'C:/workspace';
  button('打开包含多个仓库的文件夹').click();
  await waitFor(() => host.querySelectorAll('[role="tab"]').length === 2);
  assert.equal(host.querySelector('[aria-label="工作区仓库"]'), null);
  assert.equal(repositoryTab(a).getAttribute('aria-selected'), 'true');
  assert.ok(host.textContent?.includes('仓库 (2)'));
  assert.deepEqual(calls.filter(call => call.command === 'open_repository').map(call => call.args), [{ path: a, exactRoot: true }]);
});

test('an unavailable remembered repository is not silently replaced by another tab', async () => {
  const { calls, options } = fixture();
  options.missingA = true;
  localStorage.setItem('workspace.lastFolder', JSON.stringify('C:/workspace'));
  localStorage.setItem('workspace.active.C:/workspace', JSON.stringify(a));
  await waitFor(() => host.querySelectorAll('[role="tab"]').length === 1);
  assert.ok(host.textContent?.includes('上次使用的仓库不可用'));
  assert.equal(repositoryTab(b).getAttribute('aria-selected'), 'false');
  assert.ok(!calls.some(call => call.command === 'open_repository'));
  selectRepository(b);
  await waitFor(() => repositoryTab(b).getAttribute('aria-selected') === 'true');
  assert.equal(calls.find(call => call.command === 'open_repository')!.args.path, b);
});

test('tabs show unique change counts, use manual keyboard activation and offer searchable overflow', async () => {
  const { calls } = fixture();
  await openFirst();
  await waitFor(() => repositoryTab(b).textContent?.includes('B-main'));
  assert.ok(repositoryTab(a).textContent?.includes('1 个变更'));
  assert.ok(!repositoryTab(a).textContent?.includes('2 个变更'));
  assert.ok(repositoryTab(a).title.includes(a));
  repositoryTab(a).focus();
  const count = calls.filter(call => call.command === 'open_repository').length;
  repositoryTab(a).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, repositoryTab(b));
  assert.equal(repositoryTab(a).getAttribute('aria-selected'), 'true');
  assert.equal(calls.filter(call => call.command === 'open_repository').length, count);
  repositoryTab(b).click();
  await waitFor(() => repositoryTab(b).getAttribute('aria-selected') === 'true');
  button('全部仓库 (2)').click();
  await waitFor(() => document.querySelector('[aria-label="搜索全部仓库"]'));
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索全部仓库"]')!;
  search.value = 'apps/api'; search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => document.querySelectorAll('.repository-search-item').length === 1);
  (document.querySelector('.repository-search-item') as HTMLButtonElement).click();
  await waitFor(() => repositoryTab(a).getAttribute('aria-selected') === 'true');
});

test('staging one of many files does not flood history requests or block the next stage', async () => {
  const { calls, states, options } = fixture();
  const history = deferred<boolean>(); options.history = history.promise;
  states[a].changes = Array.from({ length: 600 }, (_, index) => ({ path: `file-${index}.txt`, oldPath: null, index: ' ', workTree: 'M', conflict: false }));
  try {
    await openFirst(); await changes();
    button('暂存 file-0.txt').click();
    await waitFor(() => calls.some(call => call.command === 'local_history_capture_background'));
    assert.equal(calls.filter(call => call.command === 'local_history_capture_background').length, 1);
    assert.ok(!calls.some(call => call.command === 'local_history_capture'));
    assert.equal(button('暂存 file-1.txt').disabled, false);
    button('暂存 file-1.txt').click();
    await waitFor(() => calls.filter(call => call.command === 'stage_paths').length === 2);
    assert.equal(calls.filter(call => call.command === 'local_history_capture_background').length, 1);
  } finally { history.resolve(true); }
});

test('workspace management scan does not open or merge repositories before an explicit choice', async () => {
  const { calls, options } = fixture();
  options.truncated = true;
  await scanWorkspace();
  assert.ok(host.textContent?.includes('apps/api'));
  assert.ok(host.textContent?.includes('libs/api'));
  assert.ok(host.textContent?.includes('扫描未覆盖全部目录'));
  assert.ok(!calls.some(call => call.command === 'open_repository'));
  button('管理仓库 libs/api').click();
  await waitFor(() => host.querySelector('.repository-tablist'));
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
  await waitFor(() => host.querySelector('.repository-tablist'));
  assert.equal(repositoryTab(a).getAttribute('aria-selected'), 'true');
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
  assert.equal(repositoryTab(a).getAttribute('aria-selected'), 'true');
  assert.equal(host.querySelector<HTMLTextAreaElement>('#commit-message')!.value, 'A pending');
  const pending = deferred<void>(); options.beforeCommit = pending.promise;
  button('提交暂存内容').click();
  await waitFor(() => calls.some(call => call.command === 'create_commit'));
  assert.equal(repositoryTab(b).getAttribute('aria-disabled'), 'true');
  const before = calls.filter(call => call.command === 'open_repository').length;
  selectRepository(b);
  await tick();
  assert.equal(calls.filter(call => call.command === 'open_repository').length, before);
  pending.resolve();
  await waitFor(() => repositoryTab(b).getAttribute('aria-disabled') === 'false');
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
