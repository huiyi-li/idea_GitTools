import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import type { NavigationPreview, NavigationRequest, RecoveryOverview } from '../src/navigation/types';

const window = new Window({ url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'Range', 'MouseEvent', 'KeyboardEvent', 'PointerEvent'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window) as typeof getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
after(() => window.happyDOM.close());
const { NavigationDialog } = await import('../src/navigation/NavigationDialog');
const { RecoveryDialog } = await import('../src/navigation/RecoveryDialog');
const { App } = await import('../src/App');
const host = document.body.appendChild(document.createElement('div'));

const preview: NavigationPreview = {
  root: 'C:/fixture', action: 'reset', target: 'b'.repeat(40), targetHash: 'b'.repeat(40),
  expectedHead: 'a'.repeat(40), expectedBranch: 'main', fingerprint: 'snapshot',
  localBranches: [], remote: false, local: false, suggestedBranch: '', worktreePath: null,
  changes: [{ path: 'shared.txt', status: 'M' }], localChanges: ['shared.txt'], untrackedOverwrites: ['空 格.txt'],
  leaving: [{ hash: 'a'.repeat(40), subject: 'Old commit' }], leavingCount: 1,
};
const overview: RecoveryOverview = { records: [], operation: 'none', originalHead: null, current: null, progress: null, reason: '' };
const props = { preview, busy: false, result: null, error: '', onClose: () => {}, onRun: (_request: NavigationRequest) => {}, onRetarget: (_target: string) => {}, onOpen: (_path: string) => {} };
async function waitFor(predicate: () => unknown) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail('UI did not reach expected state');
}
function button(text: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
  assert.ok(node, `button ${text} exists`); return node;
}
function changeSelect(value: string) {
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Reset 模式"]')!;
  select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('Reset defaults to Mixed and Hard requires explicit confirmation with optional backup', async () => {
  const requests: NavigationRequest[] = [];
  render(<NavigationDialog {...props} onRun={(r) => requests.push(r)} />, host);
  try {
    button('执行 Reset · mixed').click();
    assert.equal(requests[0].mode, 'mixed');
    assert.equal(requests[0].preview.fingerprint, 'snapshot');
    changeSelect('hard');
    await waitFor(() => document.body.textContent?.includes('Hard 覆盖范围'));
    assert.equal(button('执行 Reset · hard').disabled, true);
    assert.ok(document.body.textContent?.includes('空 格.txt'));
    const checks = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    checks[0].click(); checks[1].click();
    await waitFor(() => !button('执行 Reset · hard').disabled);
    button('执行 Reset · hard').click();
    assert.equal(requests[1].mode, 'hard'); assert.equal(requests[1].strategy, 'backup');
  } finally { render(null, host); }
});

test('blocked checkout lists paths and forces only after explicit confirmation', async () => {
  const requests: NavigationRequest[] = [];
  render(<NavigationDialog {...props} preview={{ ...preview, action: 'checkout' }} result={{ completed: false, kind: 'overwrite', message: 'would be overwritten', blockedFiles: ['shared.txt', '空 格.txt'], record: null }} onRun={(r) => requests.push(r)} />, host);
  try {
    assert.ok(document.body.textContent?.includes('shared.txt'));
    assert.equal(button('强制签出').disabled, true);
    button('临时保存修改后签出').click();
    assert.equal(requests[0].strategy, 'backup');
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await waitFor(() => !button('强制签出').disabled);
    button('强制签出').click(); assert.equal(requests[1].strategy, 'force');
  } finally { render(null, host); }
});

test('remote checkout shows local mapping and worktree occupancy opens the reported path', async () => {
  const targets: string[] = []; const opened: string[] = [];
  render(<NavigationDialog {...props} preview={{ ...preview, action: 'checkout', target: 'refs/remotes/origin/feature', remote: true, localBranches: ['refs/heads/feature'], suggestedBranch: 'feature' }} onRetarget={(t) => targets.push(t)} />, host);
  try {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="已有对应本地分支"]')!;
    assert.ok(select.textContent?.includes('feature → origin/feature'));
    select.value = 'refs/heads/feature'; select.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.deepEqual(targets, ['refs/heads/feature']);
  } finally { render(null, host); }
  render(<NavigationDialog {...props} preview={{ ...preview, action: 'checkout', local: true, worktreePath: 'C:/occupied' }} onOpen={(p) => opened.push(p)} />, host);
  try { assert.equal(button('签出').disabled, true); button('打开此 worktree').click(); assert.deepEqual(opened, ['C:/occupied']); }
  finally { render(null, host); }
});

test('recovery displays restore conflicts independently and creates a branch at immutable Reflog SHA', async () => {
  const writes: unknown[] = [];
  globalThis.testBackend = async (command: string) => { assert.equal(command, 'read_reflog'); return [{ hash: 'c'.repeat(40), reference: 'HEAD@{1}', subject: 'reset: moving to base' }]; };
  render(<RecoveryDialog root="C:/fixture" overview={{ ...overview, records: [{ id: 'restore-op', action: 'checkout', originalHead: 'a'.repeat(40), originalBranch: 'main', targetHash: 'b'.repeat(40), phase: 'restore-blocked', stashSha: 'd'.repeat(40), error: 'index conflict', failureKind: 'restore', blockedFiles: ['shared.txt'] }] }} busy={false} error="" onClose={() => {}} onRestore={(id) => writes.push(id)} onResolve={() => {}} onConflicts={() => {}} onBranch={async (hash, name) => { writes.push({ hash, name }); return true; }} onCheckout={() => {}} />, host);
  try {
    await waitFor(() => document.body.textContent?.includes('HEAD@{1}'));
    assert.ok(document.body.textContent?.includes('恢复本地修改受阻'));
    button('恢复本地修改及暂存布局').click(); assert.equal(writes[0], 'restore-op');
    button('创建恢复分支').click();
    await waitFor(() => document.querySelector('[aria-label="恢复分支名称"]'));
    host.querySelector<HTMLFormElement>('.recovery-create')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.deepEqual(writes[1], { hash: 'c'.repeat(40), name: 'recovery/cccccccc' });
  } finally { render(null, host); }
});

test('commit right click opens Reset through the main app and submits the reviewed snapshot', async () => {
  const calls: { command: string; args: any }[] = [];
  const commit = { hash: 'b'.repeat(40), parents: [], author: 'Dev', email: 'dev@example.test', time: 1700000000, subject: 'Target', refs: [] };
  globalThis.testBackend = async (command: string, args: any) => {
    calls.push({ command, args });
    switch (command) {
      case 'initial_repository': return 'C:/fixture';
      case 'open_repository': case 'repository_status': return { repository: { root: 'C:/fixture', name: 'fixture', branch: 'main', head: 'a'.repeat(40), operation: 'none' }, branches: [], changes: [], stashes: [] };
      case 'recovery_overview': return overview;
      case 'read_log': return { commits: [commit], hasMore: false };
      case 'commit_details': return { commit, body: '', changes: [] };
      case 'preview_navigation': return { ...preview, action: args.action };
      case 'execute_navigation': return { completed: true, kind: 'completed', message: 'Reset done', blockedFiles: [], record: null };
      default: throw new Error(`Unexpected command ${command}`);
    }
  };
  localStorage.clear(); render(<App />, host);
  try {
    await waitFor(() => host.querySelector('.commit-row'));
    host.querySelector('.commit-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 140 }));
    await waitFor(() => host.querySelector('.commit-context-menu'));
    const menu = host.querySelector('.commit-context-menu')!;
    [...menu.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('重置'))!.click();
    await waitFor(() => document.body.textContent?.includes('执行 Reset · mixed'));
    button('执行 Reset · mixed').click();
    await waitFor(() => calls.some((c) => c.command === 'execute_navigation'));
    const request = calls.find((c) => c.command === 'execute_navigation')!.args.request;
    assert.equal(request.mode, 'mixed'); assert.equal(request.preview.targetHash, commit.hash); assert.equal(request.preview.expectedHead, 'a'.repeat(40)); assert.equal(request.preview.fingerprint, 'snapshot');
  } finally { render(null, host); }
});
