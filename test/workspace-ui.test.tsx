import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { render } from 'preact';
import type { Status } from '../src/api';
import { BrowserWorker } from './browser-worker';

const window = new Window({ url: 'http://localhost' });
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: BrowserWorker });
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
after(() => window.happyDOM.close());

const { App } = await import('../src/App');
const { Split } = await import('../src/ui/controls');
const root = document.body.appendChild(document.createElement('div'));

test('every static workbench and merge toolbar icon has a bundled asset', () => {
  for (const file of [
    'src/App.tsx',
    'src/RepositorySidebar.tsx',
    'src/merge/MergeEditor.tsx',
    'src/merge/MergeManager.tsx',
    'src/HistoryDialog.tsx',
    'src/CompareView.tsx',
  ]) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:name|icon)="([^"]+)"/g)) {
      assert.ok(existsSync(`src/ui/icons/${match[1]}.svg`), `${file} references a bundled ${match[1]} icon`);
    }
  }
});

async function waitFor(predicate: () => unknown) {
  for (let i = 0; i < 120; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('UI did not reach the expected state');
}

function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
  );
  assert.ok(element, `button ${label} exists`);
  return element;
}

function fixture(
  conflict = false,
  options: {
    clean?: boolean;
    parents?: string[];
    historyError?: string;
    startConflict?: boolean;
    comparisonError?: string;
  } = {},
) {
  const calls: { command: string; args: any }[] = [];
  const commit = {
    hash: 'a'.repeat(40),
    parents: options.parents ?? [],
    author: 'Developer',
    email: 'dev@example.test',
    time: 1700000000,
    subject: 'Refine Git workspace',
    refs: ['HEAD -> refs/heads/main'],
  };
  const status: Status = {
    repository: {
      root: 'C:/fixture',
      name: 'fixture',
      branch: 'main',
      head: commit.hash,
      operation: conflict ? 'merge' : 'none',
    },
    branches: [
      {
        full: 'refs/heads/main',
        name: 'main',
        hash: commit.hash,
        current: true,
        remote: false,
        upstream: '',
      },
      {
        full: 'refs/heads/feature',
        name: 'feature',
        hash: 'b'.repeat(40),
        current: false,
        remote: false,
        upstream: '',
      },
    ],
    stashes: [],
    changes: [
      {
        path: 'src/example.ts',
        oldPath: null,
        index: conflict ? 'U' : ' ',
        workTree: conflict ? 'U' : 'M',
        conflict,
      },
    ],
  };
  if (options.clean) status.changes = [];
  let resolved = false;
  globalThis.testBackend = async (command: string, args: any) => {
    calls.push({ command, args: structuredClone(args) });
    switch (command) {
      case 'initial_repository':
        return status.repository.root;
      case 'open_repository':
      case 'repository_status':
        return structuredClone(status);
      case 'read_log':
        return { commits: [commit], hasMore: false };
      case 'commit_details':
        return {
          commit,
          body: 'Keep the workspace compact.',
          changes: [{ path: 'src/example.ts', oldPath: null, index: 'M', workTree: ' ', conflict: false }],
        };
      case 'read_diff':
        return { before: 'base\n', after: 'updated\n', binary: false, tooLarge: false };
      case 'stage_paths':
        status.changes[0].index = args.unstage ? ' ' : 'M';
        status.changes[0].workTree = args.unstage ? 'M' : ' ';
        return '';
      case 'create_commit':
        status.changes = [];
        return '';
      case 'compare_branch':
        if (options.comparisonError) throw new Error(options.comparisonError);
        return {
          base: 'a'.repeat(40),
          target: 'b'.repeat(40),
          baseName: 'main',
          targetName: 'feature',
          baseOnly: 1,
          targetOnly: 2,
          changes: [
            { path: 'src/example.ts', oldPath: 'src/old.ts', index: 'R', workTree: ' ', conflict: false },
          ],
        };
      case 'start_history':
        if (options.historyError) throw new Error(options.historyError);
        if (options.startConflict) {
          status.repository.operation = args.request.action;
          status.changes = [
            { path: 'src/example.ts', oldPath: null, index: 'U', workTree: 'U', conflict: true },
          ];
          throw new Error('CONFLICT');
        }
        status.repository.head = 'c'.repeat(40);
        return 'Operation completed';
      case 'merge_overview':
        return {
          operation: status.repository.operation,
          operationId: 'op',
          files: resolved ? [] : [{ path: 'src/example.ts', kind: 'both modified' }],
        };
      case 'open_merge':
        return {
          id: 'session',
          path: 'src/example.ts',
          base: 'start\nbase\nend\n',
          left: 'start\nlocal\nend\n',
          right: 'start\nincoming\nend\n',
          working: 'start\n<<<<<<< HEAD\nlocal\n=======\nincoming\n>>>>>>> feature\nend\n',
          leftTitle: '本地版本 · main',
          rightTitle: '合入版本 · feature',
          leftStage: 2,
          leftPresent: true,
          rightPresent: true,
          editable: true,
          reason: '',
          markerSize: 7,
          progress: null,
        };
      case 'save_merge':
        resolved = args.request.finish;
        return '';
      case 'merge_operation':
        resolved = true;
        status.repository.operation = 'none';
        status.changes = [];
        return '';
      case 'checkout_branch':
        return '';
      default:
        throw new Error(`Unexpected backend command ${command}`);
    }
  };
  localStorage.clear();
  render(<App />, root);
  return calls;
}

test('log layout loads the diff through its normal entry point and filters branches', async () => {
  const calls = fixture();
  try {
    await waitFor(() => root.querySelector('.commit-row'));
    await waitFor(() => root.querySelector('.diff-editors'));
    assert.ok(root.querySelector('.details-panel .file-name'));
    assert.equal(root.querySelectorAll('[role="separator"]').length, 3);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    assert.equal(document.activeElement?.id, 'text-filter');
    button('feature').click();
    await waitFor(() =>
      calls.some((call) => call.command === 'read_log' && call.args.query.branch === 'refs/heads/feature'),
    );
    button('清除分支筛选').click();
    await waitFor(() => !root.querySelector('.filter-chip .tool-button'));
    assert.ok(
      calls.some((call) => call.command === 'read_diff' && call.args.request.revision === 'a'.repeat(40)),
    );
  } finally {
    render(null, root);
  }
});

test('commit layout stages, unstages and commits through the existing commands', async () => {
  const calls = fixture();
  try {
    await waitFor(() => root.querySelector('.workspace-tabs'));
    const tab = [...root.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')].find((node) =>
      node.textContent?.startsWith('提交'),
    )!;
    tab.click();
    await waitFor(() => root.querySelector('#commit-message'));
    button('全部暂存').click();
    await waitFor(() => !button('全部取消暂存').disabled);
    button('全部取消暂存').click();
    await waitFor(() => !button('全部暂存').disabled);
    button('暂存 src/example.ts').click();
    await waitFor(() => !button('全部取消暂存').disabled);
    const input = root.querySelector<HTMLTextAreaElement>('#commit-message')!;
    input.value = 'Update example';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => !button('提交暂存内容').disabled);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await waitFor(() => calls.some((call) => call.command === 'create_commit'));
    assert.equal(calls.find((call) => call.command === 'create_commit')!.args.message, 'Update example');
    assert.equal(calls.filter((call) => call.command === 'stage_paths').length, 3);
  } finally {
    render(null, root);
  }
});

test('merge manager opens from the workspace, applies an arrow and stages the resolved result', async () => {
  const calls = fixture(true);
  try {
    await waitFor(() => root.querySelector('.workspace-tabs .operation'));
    (root.querySelector('.workspace-tabs .operation') as HTMLButtonElement).click();
    await waitFor(() => root.querySelector('.mg-op[data-side="right"][data-action="apply"]'));
    const arrow = root.querySelector('.mg-op[data-side="right"][data-action="apply"]')!;
    arrow.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await waitFor(() => !button('完成并暂存').disabled);
    button('处理选中块').click();
    await waitFor(() => document.querySelector('.action-popup'));
    assert.ok(button('保留双方 · 先右后左'));
    button('处理选中块').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.action-popup'));
    assert.ok(
      root.querySelector('.merge-manager'),
      'Escape closes the menu while keeping the merge manager open',
    );
    button('完成并暂存').click();
    await waitFor(() => calls.some((call) => call.command === 'save_merge'));
    const request = calls.find((call) => call.command === 'save_merge')!.args.request;
    assert.equal(request.progress.lines.join('\n'), 'start\nincoming\nend\n');
    assert.ok(request.progress.states.every((state: any) => state.resolvedLeft && state.resolvedRight));
    assert.equal(request.finish, true);
  } finally {
    render(null, root);
  }
});

test('splitters resize, clamp, persist and reset without remounting their contents', async () => {
  localStorage.clear();
  render(
    <Split storageKey="test" initial={240} min={150} label="测试分隔条">
      <input value="preserved" />
      <div />
    </Split>,
    root,
  );
  const split = root.querySelector<HTMLElement>('.split')!;
  split.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600);
  const handle = root.querySelector<HTMLElement>('[role="separator"]')!;
  const input = root.querySelector('input');
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await waitFor(() => handle.getAttribute('aria-valuenow') === '256');
  assert.equal(localStorage.getItem('split.test'), '256');
  assert.equal(root.querySelector('input'), input);
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {
    handle.dispatchEvent(new window.Event('lostpointercapture', { bubbles: true }));
  };
  handle.dispatchEvent(
    new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 256, bubbles: true }),
  );
  handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 2000, bubbles: true }));
  await waitFor(() => handle.getAttribute('aria-valuenow') === '845');
  handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  assert.equal(localStorage.getItem('split.test'), '845');
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => handle.getAttribute('aria-valuenow') === '240');
  render(null, root);
});

test('branch comparison opens from the branch menu and reads the two immutable snapshots', async () => {
  const calls = fixture();
  try {
    await waitFor(() => root.querySelector('.sidebar'));
    button('分支操作 feature').click();
    await waitFor(() => document.querySelector('.action-popup'));
    assert.equal(button('Merge 到当前分支…').disabled, true, 'dirty worktree disables mutations');
    button('与当前分支比较').click();
    await waitFor(() => root.querySelector('.comparison-dialog .diff-editors'));
    const comparisonCall = calls.find((call) => call.command === 'compare_branch');
    assert.equal(comparisonCall!.args.branch, 'refs/heads/feature');
    assert.ok(
      calls.some(
        (call) =>
          call.command === 'read_diff' &&
          call.args.request.beforeRevision === 'a'.repeat(40) &&
          call.args.request.revision === 'b'.repeat(40) &&
          call.args.request.oldPath === 'src/old.ts',
      ),
    );
    button('重新比较分支').click();
    await waitFor(() => calls.filter((call) => call.command === 'compare_branch').length === 2);
    button('关闭分支比较').click();
    await waitFor(() => !root.querySelector('.comparison-dialog'));
    assert.equal(calls.filter((call) => call.command === 'start_history').length, 0);
  } finally {
    render(null, root);
  }
});

test('merge and rebase menus submit reviewed requests including branch and HEAD snapshots', async () => {
  for (const action of ['merge', 'rebase']) {
    const calls = fixture(false, { clean: true });
    try {
      await waitFor(() => root.querySelector('.sidebar'));
      button('分支操作 feature').click();
      await waitFor(() => document.querySelector('.action-popup'));
      button(action === 'merge' ? 'Merge 到当前分支…' : 'Rebase 当前分支到此处…').click();
      await waitFor(() => root.querySelector('.history-dialog'));
      if (action === 'merge') {
        const select = root.querySelector<HTMLSelectElement>('[aria-label="合并方式"]')!;
        select.value = 'no-ff';
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      button('执行 ' + (action === 'merge' ? 'Merge' : 'Rebase')).click();
      await waitFor(() => calls.some((call) => call.command === 'start_history'));
      const request = calls.find((call) => call.command === 'start_history')!.args.request;
      assert.equal(request.action, action);
      assert.equal(request.expectedHead, 'a'.repeat(40));
      assert.equal(request.expectedBranch, 'main');
      assert.equal(request.target, 'refs/heads/feature');
      assert.equal(request.targetHash, 'b'.repeat(40));
      if (action === 'merge') assert.equal(request.mergeMode, 'no-ff');
      await waitFor(() => !root.querySelector('.history-dialog'));
    } finally {
      render(null, root);
    }
  }
});

test('commit actions require selecting a mainline for merge commits', async () => {
  const calls = fixture(false, { clean: true, parents: ['b'.repeat(40), 'c'.repeat(40)] });
  try {
    await waitFor(() => root.querySelector<HTMLButtonElement>('[aria-label="提交操作"]')?.disabled === false);
    button('提交操作').click();
    await waitFor(() => document.querySelector('.action-popup'));
    button('Revert…').click();
    await waitFor(() => root.querySelector('.history-dialog'));
    assert.equal(button('执行 Revert').disabled, true);
    const select = root.querySelector<HTMLSelectElement>('[aria-label="主线父提交"]')!;
    select.value = '2';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => !button('执行 Revert').disabled);
    assert.equal(select.value, '2');
    button('执行 Revert').click();
    await waitFor(() => calls.some((call) => call.command === 'start_history'));
    assert.equal(calls.find((call) => call.command === 'start_history')!.args.request.mainline, 2);
  } finally {
    render(null, root);
  }
});

test('a cherry-pick conflict refreshes Git state and opens the merge manager automatically', async () => {
  const calls = fixture(false, { clean: true, startConflict: true });
  try {
    await waitFor(() => root.querySelector<HTMLButtonElement>('[aria-label="提交操作"]')?.disabled === false);
    button('提交操作').click();
    await waitFor(() => document.querySelector('.action-popup'));
    button('Cherry-pick…').click();
    await waitFor(() => root.querySelector('.history-dialog'));
    button('执行 Cherry-pick').click();
    await waitFor(() => root.querySelector('.merge-manager .mg-op'));
    assert.equal(calls.find((call) => call.command === 'start_history')!.args.request.action, 'cherry-pick');
    assert.ok(button('跳过当前提交'));
    button('跳过当前提交').click();
    await waitFor(() => root.querySelector('[role="alertdialog"]'));
    button('确认跳过').click();
    await waitFor(() =>
      calls.some((call) => call.command === 'merge_operation' && call.args.action === 'skip'),
    );
  } finally {
    render(null, root);
  }
});

test('a stale operation error remains visible and comparison failures can be closed', async () => {
  const calls = fixture(false, {
    clean: true,
    historyError: '当前分支或 HEAD 已改变',
    comparisonError: '目标分支已删除',
  });
  try {
    await waitFor(() => root.querySelector<HTMLButtonElement>('[aria-label="提交操作"]')?.disabled === false);
    button('提交操作').click();
    await waitFor(() => document.querySelector('.action-popup'));
    button('Cherry-pick…').click();
    await waitFor(() => root.querySelector('.history-dialog'));
    button('执行 Cherry-pick').click();
    await waitFor(() => root.querySelector('[role="alert"]')?.textContent?.includes('HEAD 已改变'));
    assert.equal(root.querySelector('.merge-manager'), null);
    assert.ok(calls.filter((call) => call.command === 'repository_status').length >= 1);
    button('分支操作 feature').click();
    await waitFor(() => document.querySelector('.action-popup'));
    button('与当前分支比较').click();
    await waitFor(() =>
      root.querySelector('.comparison-dialog [role="alert"]')?.textContent?.includes('目标分支已删除'),
    );
    button('关闭分支比较').click();
    await waitFor(() => !root.querySelector('.comparison-dialog'));
  } finally {
    render(null, root);
  }
});

test('branch menus escape scroll containers and support keyboard navigation', async () => {
  fixture(false, { clean: true });
  try {
    await waitFor(() => root.querySelector('.sidebar'));
    const trigger = button('分支操作 feature');
    trigger.click();
    await waitFor(() => document.querySelector('.action-popup'));
    const popup = document.querySelector<HTMLElement>('.action-popup')!;
    assert.equal(root.contains(popup), false);
    assert.equal(document.activeElement, button('签出 feature'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(document.activeElement, button('与当前分支比较'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.action-popup'));
    assert.equal(document.activeElement, trigger);
    trigger.click();
    await waitFor(() => document.querySelector('.action-popup'));
    window.dispatchEvent(new window.Event('resize'));
    await waitFor(() => !document.querySelector('.action-popup'));
  } finally {
    render(null, root);
  }
});

test('closing a merge during background preparation cancels its worker and keeps saving disabled', async () => {
  let terminated = 0;
  class DelayedWorker extends BrowserWorker {
    private timer: ReturnType<typeof setTimeout> | undefined;
    override postMessage(data: unknown) {
      this.timer = setTimeout(() => super.postMessage(data), 150);
    }
    override terminate() {
      clearTimeout(this.timer);
      terminated++;
      super.terminate();
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: DelayedWorker });
  const calls = fixture(true);
  try {
    await waitFor(() => root.querySelector('.workspace-tabs .operation'));
    (root.querySelector('.workspace-tabs .operation') as HTMLButtonElement).click();
    await waitFor(() => root.querySelector('.merge-preparing'));
    assert.equal(button('保存进度').disabled, true);
    assert.equal(button('完成并暂存').disabled, true);
    button('关闭合并管理器').click();
    await waitFor(() => !root.querySelector('.merge-manager'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(terminated, 1);
    assert.equal(
      calls.some((call) => call.command === 'save_merge'),
      false,
    );
    assert.equal(root.querySelector('.mg-host .cm-editor'), null);
  } finally {
    render(null, root);
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: BrowserWorker });
  }
});
