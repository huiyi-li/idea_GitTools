import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { BrowserWorker } from './browser-worker';
import {
  OPEN_TABS_KEY,
  formatRepositoryTabLabel,
  hasPersistedTabsState,
  mergeRepositoryTabs,
  readPersistedTabsState,
  removeOtherTabs,
  removeRepositoryTab,
  removeTabsToRight,
  reorderRepositoryTabs,
  savePersistedTabsState,
  upsertRepositoryTab,
  type RepositoryTab,
} from '../src/state/repositoryTabs';

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
afterEach(() => {
  render(null, host);
  localStorage.clear();
  delete (globalThis as any).testDialog;
});
after(() => window.happyDOM.close());

const repoA = 'C:/work/frontend/web';
const repoB = 'D:/personal/web';
const repoC = 'E:/tools/cli';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function waitFor(predicate: () => unknown) {
  for (let count = 0; count < 160; count++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`UI did not settle: ${host.textContent}`);
}

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(found, `button ${label}`);
  return found;
}

function repositoryTab(root: string) {
  const tab = host.querySelector<HTMLButtonElement>(`[role="tab"][data-repository-root="${root}"]`);
  assert.ok(tab, `tab for ${root}`);
  return tab;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('repositoryTabs pure operations handle upsert, merge, close, reorder, disambiguation, and persistence', () => {
  localStorage.clear();
  assert.equal(hasPersistedTabsState(), false);

  const tabA: RepositoryTab = { root: repoA, name: 'web' };
  const tabB: RepositoryTab = { root: repoB, name: 'web' };
  const tabC: RepositoryTab = { root: repoC, name: 'cli' };

  let tabs = upsertRepositoryTab([], tabA);
  tabs = upsertRepositoryTab(tabs, tabB);
  tabs = upsertRepositoryTab(tabs, tabA); // duplicate should not add twice
  assert.equal(tabs.length, 2);

  tabs = mergeRepositoryTabs(tabs, [tabB, tabC]);
  assert.deepEqual(tabs.map((t) => t.root), [repoA, repoB, repoC]);

  assert.equal(formatRepositoryTabLabel(tabA, tabs), 'web · frontend/web');
  assert.equal(formatRepositoryTabLabel(tabB, tabs), 'web · personal/web');
  assert.equal(formatRepositoryTabLabel(tabC, tabs), 'cli');

  tabs = reorderRepositoryTabs(tabs, repoC, repoA);
  assert.deepEqual(tabs.map((t) => t.root), [repoC, repoA, repoB]);

  const closeInactive = removeRepositoryTab(tabs, repoB, repoA);
  assert.deepEqual(closeInactive.tabs.map((t) => t.root), [repoC, repoA]);
  assert.equal(closeInactive.nextActiveRoot, repoA);

  const closeActiveMiddle = removeRepositoryTab(tabs, repoA, repoA);
  assert.deepEqual(closeActiveMiddle.tabs.map((t) => t.root), [repoC, repoB]);
  assert.equal(closeActiveMiddle.nextActiveRoot, repoB);

  const closeActiveLast = removeRepositoryTab([tabC, tabA], repoA, repoA);
  assert.deepEqual(closeActiveLast.tabs.map((t) => t.root), [repoC]);
  assert.equal(closeActiveLast.nextActiveRoot, repoC);

  const closeLast = removeRepositoryTab([tabC], repoC, repoC);
  assert.deepEqual(closeLast.tabs, []);
  assert.equal(closeLast.nextActiveRoot, '');

  const right = removeTabsToRight(tabs, repoC, repoB);
  assert.deepEqual(right.tabs.map((t) => t.root), [repoC]);
  assert.equal(right.nextActiveRoot, repoC);

  const others = removeOtherTabs(tabs, repoB);
  assert.deepEqual(others.tabs.map((t) => t.root), [repoB]);
  assert.equal(others.nextActiveRoot, repoB);

  savePersistedTabsState({ version: 1, tabs, activeRoot: repoA, workspaceMeta: null });
  assert.equal(hasPersistedTabsState(), true);
  const restored = readPersistedTabsState();
  assert.ok(restored);
  assert.deepEqual(restored.tabs.map((t) => t.root), [repoC, repoA, repoB]);
  assert.equal(restored.activeRoot, repoA);

  savePersistedTabsState({ version: 1, tabs: [], activeRoot: '', workspaceMeta: null });
  assert.equal(hasPersistedTabsState(), true);
  assert.deepEqual(readPersistedTabsState()?.tabs, []);
});

function multiRepoFixture() {
  localStorage.clear();
  const calls: { command: string; args: any }[] = [];
  const states: Record<string, any> = {
    [repoA]: {
      repository: { root: repoA, name: 'web', branch: 'main', head: 'a'.repeat(40), operation: 'none' },
      branches: [],
      stashes: [],
      changes: [{ path: 'a.ts', oldPath: null, index: 'M', workTree: ' ', conflict: false }],
    },
    [repoB]: {
      repository: { root: repoB, name: 'web', branch: 'feat', head: 'b'.repeat(40), operation: 'none' },
      branches: [],
      stashes: [],
      changes: [{ path: 'b.ts', oldPath: null, index: ' ', workTree: 'M', conflict: false }],
    },
    [repoC]: {
      repository: { root: repoC, name: 'cli', branch: 'dev', head: 'c'.repeat(40), operation: 'none' },
      branches: [],
      stashes: [],
      changes: [],
    },
  };
  let active = '';
  const options: { rejectRoot?: string; beforeCommit?: Promise<void> } = {};

  (globalThis as any).testBackend = async (command: string, args: any) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === 'initial_repository') return null;
    if (command === 'discover_workspace') {
      return {
        root: 'C:/legacy-workspace',
        repositories: [
          { root: repoA, name: 'web', relativePath: 'frontend/web' },
          { root: repoC, name: 'cli', relativePath: 'tools/cli' },
        ],
        truncated: false,
        warnings: [],
      };
    }
    if (command === 'open_repository') {
      if (options.rejectRoot && args.path === options.rejectRoot) {
        throw Error(`Repository unavailable: ${args.path}`);
      }
      assert.ok(states[args.path], `unexpected open_repository ${args.path}`);
      active = args.path;
      return structuredClone(states[active]);
    }
    if (command === 'close_repository') {
      assert.equal(args.root, active);
      active = '';
      return;
    }
    if (command === 'workspace_repository_summary') {
      const s = states[args.root];
      assert.ok(s);
      return {
        root: args.root,
        branch: s.repository.branch,
        changedFiles: s.changes.length,
        stagedFiles: s.changes.filter((c: any) => c.index !== ' ' && c.index !== '?').length,
        conflicts: 0,
      };
    }
    if (command === 'local_history_capture_background') return true;
    assert.equal(args.root, active, `${command} must target active root`);
    if (command === 'repository_status') return structuredClone(states[active]);
    if (command === 'read_log') return { commits: [], hasMore: false };
    if (command === 'recovery_overview') return { records: [], operation: 'none', originalHead: null, current: null, progress: null, reason: '' };
    if (command === 'read_worktrees') return { head: states[active].repository.head, branches: [], entries: [] };
    if (command === 'create_commit') {
      await options.beforeCommit;
      states[args.root].changes = [];
      return 'committed';
    }
    throw Error(`Unexpected command: ${command}`);
  };

  render(<App />, host);
  return { calls, options };
}

test('opens multiple independent repositories in tabs, closes on demand, and persists without resetting', async () => {
  const { calls, options } = multiRepoFixture();

  // Open repoA from welcome screen (discover_workspace returns repoA only for this path)
  (globalThis as any).testDialog = async () => repoA;
  button('打开 Git 仓库').click();
  await waitFor(() => host.querySelector(`[role="tab"][data-repository-root="${repoA}"]`));
  // Close repoC if discover_workspace returned it, or better yet, let's test adding repoB directly
  await waitFor(() => repositoryTab(repoA).getAttribute('aria-selected') === 'true');

  // Add repoB from different directory via "+" button -> repoA, repoC, repoB are open with disambiguated labels
  (globalThis as any).testDialog = async () => repoB;
  button('新增仓库标签').click();
  await waitFor(() => host.querySelector(`[role="tab"][data-repository-root="${repoB}"]`));
  assert.ok(repositoryTab(repoA).textContent?.includes('web · frontend/web'));
  assert.ok(repositoryTab(repoB).textContent?.includes('web · personal/web'));
  assert.equal(repositoryTab(repoB).getAttribute('aria-selected'), 'true');
  assert.equal(host.querySelectorAll('[role="tab"]').length, 3);

  // Switch to repoC and verify
  repositoryTab(repoC).click();
  await waitFor(() => repositoryTab(repoC).getAttribute('aria-selected') === 'true');

  // Closing inactive tab repoA should NOT call open_repository or change active repoC
  const openCountBeforeCloseA = calls.filter((c) => c.command === 'open_repository').length;
  button('关闭仓库标签 web · frontend/web').click();
  await waitFor(() => host.querySelectorAll('[role="tab"]').length === 2);
  assert.equal(calls.filter((c) => c.command === 'open_repository').length, openCountBeforeCloseA);
  assert.equal(repositoryTab(repoC).getAttribute('aria-selected'), 'true');

  // Closing active tab repoC should switch to adjacent tab repoB
  button('关闭仓库标签 cli').click();
  await waitFor(() => host.querySelectorAll('[role="tab"]').length === 1);
  await waitFor(() => repositoryTab(repoB).getAttribute('aria-selected') === 'true');

  // Set legacy workspace.lastFolder to prove restart does NOT reset tabs back to legacy workspace
  localStorage.setItem('workspace.lastFolder', JSON.stringify('C:/legacy-workspace'));

  // Simulate app restart (unmount & remount)
  calls.length = 0;
  render(null, host);
  render(<App />, host);
  await waitFor(() => host.querySelectorAll('[role="tab"]').length === 1);
  assert.equal(repositoryTab(repoB).getAttribute('aria-selected'), 'true');
  assert.equal(calls.some((c) => c.command === 'discover_workspace'), false);

  // Add repoA back, verify busy lock prevents closing during commit, then close all tabs
  (globalThis as any).testDialog = async () => repoA;
  button('新增仓库标签').click();
  await waitFor(() => host.querySelectorAll('[role="tab"]').length === 2);
  const pendingCommit = deferred<void>();
  options.beforeCommit = pendingCommit.promise;

  // Switch to Changes view & commit to test busy lock
  const changesTab = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')].find((e) => e.textContent?.startsWith('提交'))!;
  changesTab.click();
  await waitFor(() => host.querySelector('#commit-message'));
  const textarea = host.querySelector<HTMLTextAreaElement>('#commit-message')!;
  textarea.value = 'Lock test';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => !button('提交暂存内容').disabled);
  button('提交暂存内容').click();
  await waitFor(() => calls.some((c) => c.command === 'create_commit'));
  assert.equal(button('关闭仓库标签 web · personal/web').disabled, true);
  pendingCommit.resolve();
  await waitFor(() => button('关闭仓库标签 web · personal/web').disabled === false);

  // Close remaining tabs down to 0 -> calls close_repository and returns to welcome screen
  button('关闭仓库标签 web · personal/web').click();
  await waitFor(() => host.querySelectorAll('[role="tab"]').length === 1);
  button('关闭仓库标签 web').click();
  await waitFor(() => host.querySelector('.welcome'));
  assert.ok(calls.some((c) => c.command === 'close_repository'));

  // Remount after closing all tabs -> stays on welcome screen, does NOT reopen legacy workspace
  const persisted = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || '{}');
  assert.deepEqual(persisted.tabs, []);
  render(null, host);
  render(<App />, host);
  await tick();
  await tick();
  assert.ok(host.querySelector('.welcome'));
  assert.equal(host.querySelectorAll('[role="tab"]').length, 0);
});

test('unavailable persisted active tab on restart stays visible without silently switching', async () => {
  const { calls, options } = multiRepoFixture();
  options.rejectRoot = repoA;

  savePersistedTabsState({
    version: 1,
    tabs: [
      { root: repoA, name: 'web' },
      { root: repoB, name: 'web' },
    ],
    activeRoot: repoA,
    workspaceMeta: null,
  });

  render(null, host);
  render(<App />, host);
  await waitFor(() => host.querySelectorAll('[role="tab"]').length === 2);
  await waitFor(() => host.textContent?.includes('上次使用的仓库不可用'));
  assert.equal(repositoryTab(repoB).getAttribute('aria-selected'), 'false');
  assert.equal(calls.filter((c) => c.command === 'open_repository').length, 1);

  // User can manually switch to repoB
  repositoryTab(repoB).click();
  await waitFor(() => repositoryTab(repoB).getAttribute('aria-selected') === 'true');
});
