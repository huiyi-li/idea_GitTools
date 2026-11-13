import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { BrowserWorker } from './browser-worker';

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
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.getComputedStyle = window.getComputedStyle.bind(window) as typeof getComputedStyle;
Object.defineProperty(globalThis, 'Worker', {
  configurable: true,
  value: BrowserWorker,
});
after(() => window.happyDOM.close());
const { CloneDialog } = await import('../src/TransportDialog');
const host = document.createElement('div');
document.body.append(host);
async function waitFor(predicate: () => unknown) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('UI did not reach expected state');
}
function input(label: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  element.value = value;
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  assert.ok(result, label);
  return result;
}
function submit() {
  host
    .querySelector('form')!
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('URL clone infers a folder, requires no hosting account and opens the completed repository once', async () => {
  const calls: string[] = [];
  const opened: string[] = [];
  localStorage.clear();
  (globalThis as any).testBackend = async (command: string, args: any) => {
    calls.push(command);
    if (command === 'start_clone') {
      assert.equal(args.request.url, 'git@github_ming:owner/repo.git');
      assert.equal(args.request.directory, 'repo');
      return 'job';
    }
    if (command === 'transport_progress')
      return {
        id: 'job',
        state: 'done',
        directory: 'C:/new/repo',
        lines: ['done'],
        prompt: null,
        error: '',
      };
    throw Error(command);
  };
  render(
    <CloneDialog
      onClose={() => {}}
      onOpen={async (path) => {
        opened.push(path);
      }}
    />,
    host,
  );
  try {
    input('仓库地址', 'git@github_ming:owner/repo.git');
    input('克隆父目录', 'C:/new');
    await waitFor(
      () => host.querySelector<HTMLInputElement>('[aria-label="克隆目录名称"]')?.value === 'repo',
    );
    submit();
    await waitFor(() => opened.length === 1);
    assert.ok(!calls.some((command) => command.startsWith('hosting_')));
    assert.equal(localStorage.getItem('clone.parent'), '"C:/new"');
  } finally {
    render(null, host);
  }
});

const { RemoteDialog, TransferDialog } = await import('../src/RemoteDialog');
const { RepositoryManager } = await import('../src/RepositoryManager');
const { WorktreeDialog } = await import('../src/WorktreeDialog');
const { HunkDialog, AmendDialog } = await import('../src/HunkDialog');
const { InteractiveRebase, autosquash } = await import('../src/InteractiveRebase');
const { FileHistoryDialog } = await import('../src/FileHistoryDialog');
const { ReviewActions, ReviewThreads } = await import('../src/hosting/ReviewActions');

test('worktree management creates from a pinned revision and confirms clean removal', async () => {
  const entries = [{ path: 'C:/repo', head: 'a'.repeat(40), branch: 'refs/heads/main', locked: null, prunable: null,
    bare: false, main: true, current: true, dirty: false, error: '', fingerprint: 'main' },
  { path: 'C:/task', head: 'a'.repeat(40), branch: 'refs/heads/task', locked: null, prunable: null,
    bare: false, main: false, current: false, dirty: false, error: '', fingerprint: 'task' }];
  const writes: { command: string; args: any }[] = [];
  const opened: string[] = [];
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'read_worktrees') return { entries: structuredClone(entries), branches: [], head: 'a'.repeat(40) };
    writes.push({ command, args });
    if (command === 'edit_worktree') return '';
    if (command === 'create_worktree') return args.request.path;
    throw Error(command);
  };
  render(<WorktreeDialog root="C:/repo" onClose={() => {}} onChanged={async () => {}} onOpen={async path => { opened.push(path); }} />, host);
  try {
    await waitFor(() => host.querySelectorAll('.worktree-list button').length === 2);
    (host.querySelectorAll('.worktree-list button')[1] as HTMLButtonElement).click();
    await waitFor(() => [...host.querySelectorAll('button')].some(item => item.textContent === '删除此工作区…'));
    button('打开此工作区').click();
    await waitFor(() => opened.length === 1);
    assert.equal(opened[0], 'C:/task');
    await waitFor(() => !button('删除此工作区…').disabled);
    button('删除此工作区…').click();
    await waitFor(() => host.querySelector('[aria-label="确认删除 Worktree"]'));
    assert.equal(writes.length, 0);
    button('确认删除工作区').click();
    await waitFor(() => writes.length === 1);
    assert.equal(writes[0].args.entry.fingerprint, 'task');
    await waitFor(() => !button('创建工作区').disabled || !host.querySelector('[aria-label="确认删除 Worktree"]'));
    input('Worktree 目标目录', 'C:/new-tree');
    input('Worktree 新分支名', 'new-task');
    await new Promise(resolve => setTimeout(resolve, 20));
    submit();
    await waitFor(() => writes.some(item => item.command === 'create_worktree'));
    assert.equal(writes.at(-1)!.args.request.base, 'a'.repeat(40));
  } finally { render(null, host); }
});
const head = 'a'.repeat(40);
const remote = {
  name: 'origin',
  fetchUrls: ['https://host/repo.git'],
  pushUrls: ['https://host/repo.git'],
};
const commit = {
  hash: head,
  parents: [],
  author: 'Ming',
  email: '',
  time: 1,
  subject: 'commit',
  refs: [],
};
const status = {
  repository: {
    root: 'C:/repo',
    name: 'repo',
    branch: 'main',
    head,
    operation: 'none',
  },
  changes: [],
  branches: [],
  stashes: [],
};
function changeSelect(selector: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(selector)!;
  select.value = value;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('remote configuration sends the reviewed prior values and preserves a separate push URL', async () => {
  let saved: any;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'transfer_overview')
      return { remotes: [remote], branch: 'main', head, upstream: '' };
    if (command === 'edit_remote') {
      saved = args.request;
      return;
    }
    throw Error(command);
  };
  render(<RemoteDialog root="C:/repo" onClose={() => {}} onChanged={async () => {}} />, host);
  try {
    await waitFor(() => host.textContent?.includes('origin'));
    button('origin').click();
    await waitFor(() => host.querySelector<HTMLInputElement>('[aria-label="远程名称"]')?.disabled);
    input('远程 Fetch 地址', 'git@github_ming:owner/repo.git');
    input('远程 Push 地址', 'https://host/push.git');
    await new Promise((resolve) => setTimeout(resolve, 0));
    submit();
    await waitFor(() => saved);
    assert.deepEqual(saved.expected, remote);
    assert.equal(saved.action, 'edit');
    assert.equal(saved.pushUrl, 'https://host/push.git');
  } finally {
    render(null, host);
  }
});

test('first push previews commits and forwards upstream configuration to the authenticated transport', async () => {
  let request: any;
  let refreshed = 0;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'transfer_overview')
      return { remotes: [remote], branch: 'main', head, upstream: '' };
    if (command === 'repository_status') return status;
    if (command === 'outgoing_commits') return [commit];
    if (command === 'start_transfer') {
      request = args.request;
      return 'push';
    }
    if (command === 'transport_progress')
      return {
        id: 'push',
        state: 'done',
        directory: 'C:/repo',
        lines: [],
        prompt: null,
        error: '',
      };
    throw Error(command);
  };
  render(
    <TransferDialog
      root="C:/repo"
      action="push"
      onClose={() => {}}
      onChanged={async () => {
        refreshed++;
      }}
    />,
    host,
  );
  try {
    await waitFor(() => host.textContent?.includes('commit'));
    input('传输目标分支', 'published');
    await new Promise((resolve) => setTimeout(resolve, 0));
    submit();
    await waitFor(() => refreshed === 1);
    assert.equal(request.setUpstream, true);
    assert.equal(request.expectedHead, head);
    assert.equal(request.branch, 'published');
  } finally {
    render(null, host);
  }
});

test('tag deletion requires confirmation and stash pop pins the selected object', async () => {
  const writes: any[] = [];
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'repository_management')
      return {
        status: {
          ...status,
          stashes: [{ reference: 'stash@{0}', hash: head, message: 'saved' }],
        },
        tags: [{ name: 'v1', hash: head, subject: 'tag' }],
        remotes: [remote],
      };
    if (command === 'edit_ref' || command === 'edit_stash') {
      writes.push(args.request);
      return;
    }
    if (command === 'stash_files')
      return [{ path: 'new.txt', revision: head, base: 'b'.repeat(40) }];
    throw Error(command);
  };
  render(<RepositoryManager root="C:/repo" onClose={() => {}} onChanged={async () => {}} />, host);
  try {
    await waitFor(() => host.querySelector('[aria-label="管理本地分支"]'));
    button('标签管理').click();
    await waitFor(() => host.querySelector('[aria-label="管理标签"]'));
    changeSelect('[aria-label="管理标签"]', 'v1');
    assert.equal(button('删除本地标签').disabled, true);
    const confirmation = [
      ...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((input) => input.parentElement?.textContent?.includes('确认删除本地标签'))!;
    confirmation.click();
    await waitFor(() => !button('删除本地标签').disabled);
    button('删除本地标签').click();
    await waitFor(() => writes.length === 1);
    assert.equal(writes[0].hash, head);
    await waitFor(() => !button('Stash 管理').disabled);
    button('Stash 管理').click();
    await waitFor(() => host.querySelector('[aria-label="选择 Stash"]'));
    changeSelect('[aria-label="选择 Stash"]', 'stash@{0}');
    await waitFor(() => host.textContent?.includes('new.txt'));
    button('Pop').click();
    await waitFor(() => writes.length === 2);
    assert.equal(writes[1].hash, head);
    assert.equal(writes[1].action, 'pop');
  } finally {
    render(null, host);
  }
});

test('hunk staging uses the reviewed preview and reports a clean file after the last block', async () => {
  let applied: any;
  const preview = {
    path: 'file.txt',
    area: 'unstaged',
    fingerprint: 'snapshot',
    header: 'header',
    hunks: ['@@ -1 +1 @@\n-old\n+new\n'],
  };
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'preview_hunks') return applied ? { ...preview, hunks: [] } : preview;
    if (command === 'apply_hunk') {
      applied = args;
      return;
    }
    throw Error(command);
  };
  render(
    <HunkDialog
      root="C:/repo"
      path="file.txt"
      area="unstaged"
      onClose={() => {}}
      onChanged={async () => {}}
    />,
    host,
  );
  try {
    await waitFor(() => host.textContent?.includes('+new'));
    button('暂存此块').click();
    await waitFor(() => host.textContent?.includes('没有可处理的文本变化块'));
    assert.equal(applied.index, 0);
    assert.deepEqual(applied.preview, preview);
    assert.equal(applied.discard, false);
  } finally {
    render(null, host);
  }
});

test('selected diff lines use the pinned preview and require confirmation before discarding', async () => {
  const preview = { path: 'file.txt', area: 'unstaged', fingerprint: 'lines', header: 'header', hunks: ['@@ -1 +1 @@\n-old\n+new\n'] };
  let applied: any;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'preview_hunks') return applied ? { ...preview, hunks: [] } : preview;
    if (command === 'apply_hunk_lines') { applied = args; return; }
    throw Error(command);
  };
  render(<HunkDialog root="C:/repo" path="file.txt" area="unstaged" onClose={() => {}} onChanged={async () => {}} />, host);
  try {
    await waitFor(() => host.querySelector('[aria-label="选择变化行 3"]'));
    const checkbox = host.querySelector<HTMLInputElement>('[aria-label="选择变化行 3"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => !button('放弃选中行…').disabled);
    button('放弃选中行…').click();
    await waitFor(() => host.textContent?.includes('确认将选中的 1 个变化行'));
    assert.equal(applied, undefined);
    button('确认放弃选中行').click();
    await waitFor(() => applied);
    assert.deepEqual(applied.selections, [{ hunk: 0, lines: [2] }]);
    assert.deepEqual(applied.preview, preview);
    assert.equal(applied.discard, true);
  } finally { render(null, host); }
});

test('amend requires confirmation and pins both HEAD and the staged snapshot', async () => {
  let request: any;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'preview_amend')
      return { head, message: 'original', changes: [], fingerprint: 'index' };
    if (command === 'amend_commit') {
      request = args;
      return;
    }
    throw Error(command);
  };
  render(<AmendDialog root="C:/repo" onClose={() => {}} onChanged={async () => {}} />, host);
  try {
    await waitFor(() => host.querySelector<HTMLTextAreaElement>('textarea')?.value === 'original');
    assert.equal(button('执行 Amend').disabled, true);
    input('Amend 提交说明', 'updated');
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await waitFor(() => !button('执行 Amend').disabled);
    submit();
    await waitFor(() => request);
    assert.equal(request.expectedHead, head);
    assert.equal(request.fingerprint, 'index');
    assert.equal(request.message, 'updated');
  } finally {
    render(null, host);
  }
});

test('interactive rebase presents an ordered plan and autosquash moves matching fixups', async () => {
  const commits = [
    commit,
    { ...commit, hash: 'b'.repeat(40), subject: 'another' },
    { ...commit, hash: 'c'.repeat(40), subject: 'fixup! commit' },
  ];
  const entries = commits.map((commit) => ({
    hash: commit.hash,
    action: 'pick',
    message: '',
  }));
  const ordered = autosquash(entries, commits);
  assert.deepEqual(
    ordered.map((entry) => entry.hash),
    [head, 'c'.repeat(40), 'b'.repeat(40)],
  );
  assert.equal(ordered[1].action, 'fixup');
  let request: any;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'preview_interactive')
      return {
        head,
        branch: 'main',
        base: null,
        onto: null,
        commits,
        mergeCount: 0,
      };
    if (command === 'start_interactive') {
      request = args;
      return 'rebase';
    }
    if (command === 'transport_progress')
      return {
        id: 'rebase',
        state: 'done',
        directory: 'C:/repo',
        lines: [],
        prompt: null,
        error: '',
      };
    throw Error(command);
  };
  render(<InteractiveRebase root="C:/repo" onClose={() => {}} onChanged={async () => {}} />, host);
  try {
    button('读取提交计划').click();
    await waitFor(() => host.textContent?.includes('fixup! commit'));
    button('Autosquash').click();
    await waitFor(
      () =>
        host.querySelector<HTMLSelectElement>(`[aria-label="Rebase 动作 ${'c'.repeat(40)}"]`)
          ?.value === 'fixup',
    );
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await waitFor(() => !button('执行交互式 Rebase').disabled);
    button('执行交互式 Rebase').click();
    await waitFor(() => request);
    assert.deepEqual(request.entries, ordered);
    assert.equal(request.preview.head, head);
  } finally {
    render(null, host);
  }
});

test('file history exposes rename-aware versions and Blame source metadata', async () => {
  (globalThis as any).testBackend = async (command: string) => {
    if (command === 'file_history')
      return {
        revision: head,
        entries: [{ commit, path: 'new.txt', oldPath: 'old.txt' }],
        hasMore: false,
      };
    if (command === 'file_blame')
      return {
        lines: [
          {
            hash: head,
            path: 'old.txt',
            line: 1,
            originalLine: 1,
            author: 'Ming',
            summary: 'source',
            time: 1,
            text: '<script>code</script>',
          },
        ],
        hasMore: false,
      };
    throw Error(command);
  };
  render(<FileHistoryDialog root="C:/repo" initialPath="new.txt" onClose={() => {}} />, host);
  try {
    await waitFor(() => host.textContent?.includes('old.txt → new.txt'));
    button('Blame').click();
    await waitFor(() => host.textContent?.includes('<script>code</script>'));
    assert.equal(host.querySelector('script'), null);
    assert.ok(host.textContent?.includes('Ming'));
  } finally {
    render(null, host);
  }
});

const review = {
  number: 7,
  title: 'PR',
  body: '',
  author: 'author',
  state: 'open',
  draft: false,
  sourceBranch: 'topic',
  sourceRepository: 'owner/repo',
  targetBranch: 'main',
  headSha: head,
  baseSha: 'b'.repeat(40),
  webUrl: '',
  updatedAt: '',
  mergeStatus: '',
};
const args = { accountId: 'account', repository: 'owner/repo', number: 7 };
test('remote approval requires an explicit confirmation and forwards the reviewed commit', async () => {
  let request: any;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'hosting_review_mutation') {
      request = args.request;
      return;
    }
    throw Error(command);
  };
  render(
    <ReviewActions
      args={args}
      review={review}
      provider="github"
      localRoot=""
      onChanged={() => {}}
      onOpen={async () => {}}
    />,
    host,
  );
  try {
    button('审查、合并与签出').click();
    await waitFor(() => host.querySelector('form'));
    assert.equal(button('提交审查操作').disabled, true);
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await waitFor(() => !button('提交审查操作').disabled);
    submit();
    await waitFor(() => request);
    assert.equal(request.headSha, head);
    assert.equal(request.action, 'approve');
  } finally {
    render(null, host);
  }
});

test('review threads render text safely and send replies to the selected thread', async () => {
  let request: any;
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'hosting_read')
      return {
        items: [
          {
            id: 'thread',
            path: 'file.txt',
            line: 4,
            side: 'RIGHT',
            resolved: false,
            resolvable: true,
            outdated: false,
            truncated: false,
            notes: [
              {
                id: 'note',
                author: 'reviewer',
                body: '<script>review</script>',
                createdAt: '',
              },
            ],
          },
        ],
        nextCursor: null,
      };
    if (command === 'hosting_cancel_read') return;
    if (command === 'hosting_review_mutation') {
      request = args.request;
      return;
    }
    throw Error(command);
  };
  render(<ReviewThreads args={args} review={review} />, host);
  try {
    await waitFor(() => host.textContent?.includes('<script>review</script>'));
    assert.equal(host.querySelector('script'), null);
    button('回复讨论').click();
    await waitFor(() => host.querySelector('textarea'));
    input('讨论回复', 'reply');
    await waitFor(() => !button('发送回复').disabled);
    submit();
    await waitFor(() => request);
    assert.equal(request.threadId, 'thread');
    assert.equal(request.headSha, head);
    assert.equal(request.body, 'reply');
  } finally {
    render(null, host);
  }
});

test('clone exposes authentication without persisting the password, and cancellation remains available', async () => {
  const answers: any[] = [];
  let cancelled = false;
  localStorage.clear();
  (globalThis as any).testBackend = async (command: string, args: any) => {
    if (command === 'start_clone') return 'job';
    if (command === 'transport_progress')
      return {
        id: 'job',
        state: cancelled ? 'cancelled' : 'running',
        directory: 'C:/new/repo',
        lines: ['Receiving objects: 10%'],
        error: '',
        prompt: cancelled
          ? null
          : {
              id: 1,
              message: 'Password for host',
              secret: true,
              confirmation: false,
            },
      };
    if (command === 'answer_transport') {
      answers.push(args);
      return;
    }
    if (command === 'cancel_transport') {
      cancelled = true;
      return;
    }
    throw Error(command);
  };
  render(
    <CloneDialog
      initialUrl="https://host/repo.git"
      onClose={() => {}}
      onOpen={async () => {
        assert.fail('cancelled clone must not open');
      }}
    />,
    host,
  );
  try {
    input('克隆父目录', 'C:/new');
    submit();
    await waitFor(() => host.querySelector('input[type="password"]'));
    const password = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    password.value = 'temporary-secret';
    password.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => !button('继续认证').disabled);
    host
      .querySelector('.transport-auth')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => answers.length === 1);
    assert.equal(answers[0].value, 'temporary-secret');
    assert.ok(!JSON.stringify(localStorage).includes('temporary-secret'));
    assert.equal(button('关闭').disabled, true);
    button('取消 Git 操作').click();
    await waitFor(() => !button('关闭').disabled);
    assert.ok(host.textContent?.includes('已取消'));
  } finally {
    render(null, host);
  }
});

test('a failed clone retains its fields, shows Git output and can start a corrected retry', async () => {
  let attempts = 0;
  localStorage.clear();
  (globalThis as any).testBackend = async (command: string) => {
    if (command === 'start_clone') return `job-${++attempts}`;
    if (command === 'transport_progress')
      return {
        id: `job-${attempts}`,
        state: 'error',
        directory: '',
        lines: ['fatal: repository not found'],
        error: 'repository not found',
        prompt: null,
      };
    throw Error(command);
  };
  render(
    <CloneDialog initialUrl="http://host/repo.git" onClose={() => {}} onOpen={async () => {}} />,
    host,
  );
  try {
    input('克隆父目录', 'C:/new');
    submit();
    await waitFor(() => host.textContent?.includes('repository not found'));
    assert.equal(
      host.querySelector<HTMLInputElement>('[aria-label="仓库地址"]')!.value,
      'http://host/repo.git',
    );
    input('克隆目录名称', 'retry');
    submit();
    await waitFor(() => attempts === 2);
  } finally {
    render(null, host);
  }
});
