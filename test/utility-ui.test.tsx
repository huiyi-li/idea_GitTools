import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';

const window = new Window({ url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window) as typeof getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const { SubmoduleDialog } = await import('../src/SubmoduleDialog');
const { BisectDialog } = await import('../src/BisectDialog');
const { DiagnosticsDialog } = await import('../src/DiagnosticsDialog');
const { Modal } = await import('../src/ui/controls');
const { LocalHistoryDialog } = await import('../src/LocalHistoryDialog');
const { MultiRepositoryDialog } = await import('../src/MultiRepositoryDialog');
const { SettingsModal } = await import('../src/SettingsModal');
const { CommandPalette } = await import('../src/CommandPalette');
const { getSetting, resetAllSettings } = await import('../src/state/settings');
const host = document.body.appendChild(document.createElement('div'));
afterEach(() => render(null, host));
after(() => window.happyDOM.close());
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function waitFor(predicate: () => unknown) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await tick(); }
  assert.fail(`UI did not settle: ${host.textContent}`);
}
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label);
  assert.ok(result, `button ${label}`);
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const module = (path = 'libs/core') => ({ path, commit: 'a'.repeat(40), state: '正常', detail: '(heads/main)' });
const noChange = async () => {};
const noClose = () => {};

test('submodule loading and failed reads never pretend the repository is empty', async () => {
  const pending = deferred<unknown[]>();
  let started = false;
  (globalThis as any).testBackend = () => { started = true; return pending.promise; };
  render(<SubmoduleDialog root="C:/repo" onClose={noClose} onChanged={noChange} />, host);
  await waitFor(() => host.textContent?.includes('正在读取子模块'));
  assert.ok(!host.textContent?.includes('当前仓库没有'));
  assert.equal(button('更新全部…').disabled, true);
  await waitFor(() => started);
  pending.reject(Error('read failed'));
  await waitFor(() => host.textContent?.includes('read failed'));
  assert.ok(!host.textContent?.includes('当前仓库没有'));
  assert.equal(button('更新全部…').disabled, true);
  (globalThis as any).testBackend = async () => [];
  button('重新读取').click();
  await waitFor(() => host.textContent?.includes('当前仓库没有'));
});

test('all-submodule updates require explicit confirmation and do not double submit', async () => {
  let writes = 0;
  let refreshed = 0;
  const completion = deferred<void>();
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'submodules') return [module()];
    assert.equal(command, 'update_submodules');
    assert.deepEqual(args.paths, []);
    writes++;
    return completion.promise;
  };
  render(<SubmoduleDialog root="C:/repo" onClose={noClose} onChanged={async () => { refreshed++; }} />, host);
  await waitFor(() => host.querySelector('.submodule-row'));
  assert.equal(button('更新选中 (0)…').disabled, true);
  button('更新全部…').click();
  await waitFor(() => host.querySelector('[aria-label="确认更新子模块"]'));
  assert.equal(writes, 0);
  button('取消').click();
  await waitFor(() => !host.querySelector('[aria-label="确认更新子模块"]'));
  assert.equal(writes, 0);
  button('更新全部…').click();
  await waitFor(() => host.querySelector('[aria-label="确认更新子模块"]'));
  const confirm = button('确认更新');
  confirm.click(); confirm.click();
  assert.equal(writes, 1);
  completion.resolve();
  await waitFor(() => host.textContent?.includes('子模块更新完成'));
  assert.equal(refreshed, 1);
});

test('submodule failure refreshes partial changes and invalidates old selections', async () => {
  let reads = 0;
  let refreshed = 0;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'submodules') return ++reads === 1 ? [module('libs/old')] : [module('libs/new')];
    assert.deepEqual(args.paths, ['libs/old']);
    throw Error('partial update failed');
  };
  render(<SubmoduleDialog root="C:/repo" onClose={noClose} onChanged={async () => { refreshed++; }} />, host);
  await waitFor(() => host.querySelector('.submodule-row'));
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await waitFor(() => [...host.querySelectorAll<HTMLButtonElement>('button')].some(item => item.textContent === '更新选中 (1)…' && !item.disabled));
  button('更新选中 (1)…').click();
  await waitFor(() => host.querySelector('[aria-label="确认更新子模块"]'));
  button('确认更新').click();
  await waitFor(() => host.textContent?.includes('partial update failed'));
  assert.ok(host.textContent?.includes('libs/new'));
  assert.ok(!host.textContent?.includes('libs/old'));
  assert.equal(refreshed, 1);
  assert.equal(button('更新选中 (0)…').disabled, true);
});

test('diagnostics ignores old repository results and distinguishes detached HEAD', async () => {
  const old = deferred<any>();
  const current = { gitVersion: 'git version fixture', root: 'C:/new', gitDir: 'C:/new/.git', branch: null, head: 'a'.repeat(40), operation: 'none', changedFiles: 0, stagedFiles: 0, unstagedFiles: 0, remoteNames: [], worktreeCount: 1, autocrlf: 'false', commitGpgsign: 'false', lfsAvailable: false, lfsFiles: 0 };
  (globalThis as any).testBackend = async (_: string, args: any) => args.root === 'C:/old' ? old.promise : current;
  render(<DiagnosticsDialog root="C:/old" onClose={noClose} />, host);
  await tick();
  render(<DiagnosticsDialog root="C:/new" onClose={noClose} />, host);
  await waitFor(() => host.textContent?.includes('Detached HEAD'));
  old.resolve({ ...current, root: 'C:/old', branch: 'stale-branch' });
  await tick();
  assert.ok(!host.textContent?.includes('stale-branch'));
  assert.ok(!host.textContent?.includes('C:/old'));
});

test('Bisect does not offer start until status is known and retries failed reads', async () => {
  (globalThis as any).testBackend = async () => { throw Error('unreadable'); };
  render(<BisectDialog root="C:/repo" onClose={noClose} onChanged={noChange} />, host);
  assert.equal(host.querySelector('form'), null);
  await waitFor(() => host.textContent?.includes('unreadable'));
  assert.equal(host.querySelector('form'), null);
  (globalThis as any).testBackend = async () => ({ active: false, start: null, current: null, log: [] });
  button('重新读取').click();
  await waitFor(() => host.querySelector('form'));
  assert.equal(button('开始定位').disabled, true);
});

test('Bisect reset is confirmed and failed operations refresh actual state', async () => {
  let active = true;
  let reset = 0;
  let refreshed = 0;
  (globalThis as any).testBackend = async (command: string) => {
    if (command === 'bisect_status') return { active, start: 'main', current: 'a'.repeat(40), log: [] };
    assert.equal(command, 'bisect_reset');
    reset++; active = false;
    throw Error('hook failed after reset');
  };
  render(<BisectDialog root="C:/repo" onClose={noClose} onChanged={async () => { refreshed++; }} />, host);
  await waitFor(() => host.textContent?.includes('正在定位'));
  button('结束定位并返回…').click();
  await waitFor(() => host.querySelector('[aria-label="确认结束 Bisect"]'));
  assert.equal(reset, 0);
  button('确认结束并返回').click();
  await waitFor(() => host.textContent?.includes('hook failed after reset'));
  assert.equal(reset, 1);
  assert.equal(refreshed, 1);
  assert.ok(host.querySelector('form'));
});

test('multi-repository history disables foreign writes and reloads after removing a repository', async () => {
  localStorage.setItem('multi.repositories', JSON.stringify(['C:/a', 'C:/b']));
  const rows = ['a', 'b'].map(name => ({ root: `C:/${name}`, name, commit: { hash: name.repeat(40), subject: `commit-${name}`, author: 'Test', time: 1, parents: [], email: '', refs: [] } }));
  let writes = 0;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'multi_repository_log') return rows.filter(row => args.roots.includes(row.root));
    writes++; return '';
  };
  render(<MultiRepositoryDialog currentRoot="C:/a" onClose={noClose} />, host);
  button('提交记录').click();
  await waitFor(() => host.querySelectorAll('.multi-commit-row').length === 2);
  (host.querySelectorAll('.multi-commit-row')[1] as HTMLButtonElement).click();
  await waitFor(() => host.textContent?.includes('不是当前打开的仓库'));
  assert.equal(button('删除选中提交…').disabled, true);
  button('移除仓库 C:/b').click();
  await waitFor(() => host.querySelectorAll('.multi-commit-row').length === 1);
  assert.ok(!host.textContent?.includes('commit-b'));
  assert.ok(!host.textContent?.includes('已选择'));
  assert.equal(writes, 0);
});

test('late multi-repository log results cannot restore a removed repository', async () => {
  localStorage.setItem('multi.repositories', JSON.stringify(['C:/a', 'C:/b']));
  const stale = deferred<any[]>();
  let reads = 0;
  (globalThis as any).testBackend = async (_: string, args: any) => {
    reads++;
    return args.roots.includes('C:/b') ? stale.promise : [];
  };
  render(<MultiRepositoryDialog currentRoot="C:/a" onClose={noClose} />, host);
  button('提交记录').click();
  await waitFor(() => reads === 1);
  button('移除仓库 C:/b').click();
  await waitFor(() => reads === 2 && host.textContent?.includes('暂无提交记录'));
  stale.resolve([{ root: 'C:/b', name: 'b', commit: { hash: 'b'.repeat(40), subject: 'stale-commit', author: 'Test', time: 1 } }]);
  await tick();
  assert.ok(!host.textContent?.includes('stale-commit'));
});

test('multi-repository synchronous branch control lists shared branches and executes batch checkout', async () => {
  localStorage.setItem('multi.repositories', JSON.stringify(['C:/a', 'C:/b']));
  let executed: any;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'multi_repository_branches') {
      return [
        { root: 'C:/a', name: 'repo-a', currentBranch: 'main', head: 'a'.repeat(40), dirty: false, branches: ['main', 'feature/sync'] },
        { root: 'C:/b', name: 'repo-b', currentBranch: 'main', head: 'b'.repeat(40), dirty: true, branches: ['main', 'feature/sync'] },
      ];
    }
    if (command === 'multi_repository_branch_action') {
      executed = args;
      return ['C:/a: 已切换到分支 feature/sync', 'C:/b: 已切换到分支 feature/sync'];
    }
    throw Error(command);
  };
  render(<MultiRepositoryDialog currentRoot="C:/a" onClose={noClose} />, host);
  button('跨仓库同步分支').click();
  await waitFor(() => host.textContent?.includes('feature/sync (2/2)'));
  button('feature/sync (2/2)').click();
  button('批量执行分支操作').click();
  await waitFor(() => executed);
  assert.deepEqual(executed, {
    roots: ['C:/a', 'C:/b'],
    action: 'checkout',
    branch: 'feature/sync',
  });
  await waitFor(() => host.textContent?.includes('C:/a: 已切换到分支 feature/sync'));
});

test('local history restore requires confirmation and sends the reviewed worktree stamp', async () => {
  const entry = { id: 'snapshot', path: 'file.txt', timestamp: 1700000000000, reason: 'saved', size: 3, binary: false };
  let restored: any;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'local_history_list') return [entry];
    if (command === 'local_history_preview_restore') { assert.equal(args.id, 'snapshot'); return { stamp: 'reviewed-worktree' }; }
    if (command === 'local_history_restore') { restored = args; return; }
    throw Error(command);
  };
  render(<LocalHistoryDialog root="C:/repo" initialPath="file.txt" onClose={noClose} onChanged={noChange} />, host);
  await waitFor(() => host.textContent?.includes('saved'));
  button('恢复到工作区').click();
  await waitFor(() => host.querySelector('[aria-label="确认恢复本地历史"]'));
  assert.equal(restored, undefined);
  button('取消恢复').click();
  await waitFor(() => !host.querySelector('[aria-label="确认恢复本地历史"]'));
  assert.equal(restored, undefined);
  button('恢复到工作区').click();
  await waitFor(() => host.querySelector('[aria-label="确认恢复本地历史"]'));
  button('确认恢复到工作区').click();
  await waitFor(() => restored);
  assert.deepEqual(restored, { root: 'C:/repo', path: 'file.txt', id: 'snapshot', expectedStamp: 'reviewed-worktree' });
});

test('modal skips disabled and hidden controls and traps keyboard focus', async () => {
  const trigger = document.body.appendChild(document.createElement('button'));
  trigger.focus();
  let closed = 0;
  render(<Modal title="Focus test" onClose={() => { closed++; }}>
    <input disabled aria-label="Disabled" />
    <div hidden><button>Hidden</button></div>
    <div style={{ display: 'none' }}><button>CSS hidden</button></div>
    <button>First</button><button>Last</button>
  </Modal>, host);
  await waitFor(() => document.activeElement === button('First'));
  const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
  button('First').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, button('Last'));
  button('Last').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, button('First'));
  button('First').disabled = true;
  button('Last').disabled = true;
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, panel);
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(closed, 1);
  render(null, host);
  assert.equal(document.activeElement, trigger);
  trigger.remove();
});

test('SettingsModal persists theme, editor, workflow preferences, supports search filtering and reset', async () => {
  localStorage.clear();
  resetAllSettings();
  render(<SettingsModal onClose={noClose} />, host);
  await waitFor(() => host.textContent?.includes('界面主题'));
  button('浅色').click();
  await waitFor(() => getSetting('theme') === 'light');
  assert.equal(localStorage.getItem('theme'), '"light"');

  // Switch to Git Workflow section and update pull strategy
  button('Git 工作流').click();
  await waitFor(() => host.textContent?.includes('Update Project (Ctrl+T) 默认整合策略'));
  button('Rebase').click();
  await waitFor(() => getSetting('updateStrategy') === 'rebase');

  // Search across sections for "Blame"
  const search = host.querySelector<HTMLInputElement>('[aria-label="搜索设置项"]')!;
  search.value = 'Blame';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => host.textContent?.includes('默认显示 Inline Blame'));
  const blameSwitch = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="默认显示 Inline Blame"]')!;
  blameSwitch.click();
  await waitFor(() => getSetting('inlineBlame') === true);

  // Reset all settings to defaults
  button('恢复默认设置').click();
  await waitFor(() => [...host.querySelectorAll('button')].some((b) => b.textContent?.trim() === '确认重置'));
  button('确认重置').click();
  await waitFor(() => getSetting('theme') === 'dark' && getSetting('updateStrategy') === 'ff-only' && getSetting('inlineBlame') === false);
});

test('CommandPalette filters commands by keyword and executes selection with Enter', async () => {
  const ran: string[] = [];
  let closed = 0;
  render(
    <CommandPalette
      commands={[
        { id: 'shelf', label: 'Shelf 管理', category: '储藏', keywords: 'patch unshelve', run: () => ran.push('shelf') },
        { id: 'settings', label: '打开设置中心', category: '设置', keywords: 'theme', run: () => ran.push('settings') },
      ]}
      onClose={() => {
        closed++;
      }}
    />,
    host,
  );
  await waitFor(() => host.querySelector('[aria-label="搜索命令、工具或分支"]'));
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索命令、工具或分支"]')!;
  input.value = 'theme';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => host.querySelectorAll('.command-palette-item').length === 1);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(ran, ['settings']);
  assert.equal(closed, 1);
});
