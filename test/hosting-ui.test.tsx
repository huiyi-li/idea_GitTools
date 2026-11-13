import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { BrowserWorker } from './browser-worker';
import type { Account, HostedRepository, ReviewRequest } from '../src/hosting/types';

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
const { default: HostingView } = await import('../src/hosting/HostingView');
const { Accounts } = await import('../src/hosting/Accounts');
const root = document.body.appendChild(document.createElement('div'));

async function waitFor(predicate: () => unknown) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`UI did not reach expected state. ${root.textContent}`);
}

function button(label: string) {
  const element = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
  );
  assert.ok(element, `button ${label} exists`);
  return element;
}

function input(selector: string, value: string) {
  const element = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  assert.ok(element, selector);
  element.value = value;
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const github: Account = {
  id: 'github-user',
  provider: 'github',
  server: 'https://github.com',
  userId: '1',
  login: 'ming',
};
const gitlab: Account = {
  id: 'gitlab-user',
  provider: 'gitlab',
  server: 'https://gitlab.example.test',
  userId: '2',
  login: 'team',
};
const repository: HostedRepository = {
  id: 'repo-1',
  path: 'owner/repo',
  name: 'repo',
  description: '',
  private: true,
  defaultBranch: 'main',
  webUrl: 'https://github.com/owner/repo',
  sshUrl: 'git@github.com:owner/repo.git',
  httpsUrl: 'https://github.com/owner/repo.git',
};
const review: ReviewRequest = {
  number: 7,
  title: 'Feature review',
  body: 'Review description',
  author: 'dev',
  state: 'open',
  draft: false,
  sourceBranch: 'feature',
  sourceRepository: 'owner/repo',
  targetBranch: 'main',
  headSha: 'b'.repeat(40),
  baseSha: 'a'.repeat(40),
  webUrl: 'https://github.com/owner/repo/pull/7',
  updatedAt: '2026-11-11',
  mergeStatus: 'clean',
};

type Call = { command: string; args: any };
function backend(options: { empty?: boolean; failCreate?: boolean; delayedRepos?: boolean } = {}) {
  const calls: Call[] = [];
  let accounts = options.empty ? [] : [github, gitlab];
  let state = 'open';
  let resolveOld: ((value: any) => void) | undefined;
  globalThis.testBackend = async (command: string, args: any = {}) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === 'hosting_read') {
      const query = args.request;
      switch (query.kind) {
        case 'accounts':
          return structuredClone(accounts);
        case 'repositories':
          if (options.delayedRepos && query.accountId === github.id)
            return new Promise((resolve) => {
              resolveOld = resolve;
            });
          return {
            items: [
              {
                ...repository,
                path: query.accountId === gitlab.id ? 'group/sub/project' : repository.path,
              },
            ],
            hasMore: query.page === 1,
          };
        case 'reviews':
          return { items: [{ ...review, state }], hasMore: false };
        case 'review':
          return { ...review, state };
        case 'comments':
          return {
            items: [
              { id: '1', author: 'dev', body: '<script>unsafe()</script>', createdAt: 'today' },
            ],
            hasMore: false,
          };
        case 'commits':
          return {
            items: [{ sha: 'b'.repeat(40), title: 'Feature commit', author: 'dev' }],
            hasMore: false,
          };
        case 'files':
          return {
            items: [
              {
                path: 'src/file.ts',
                oldPath: '',
                status: 'modified',
                additions: 1,
                deletions: 1,
                patch: '',
              },
            ],
            hasMore: false,
          };
        case 'file_diff':
          return {
            before: 'const before = 1;\n',
            after: 'const after = 2;\n',
            binary: false,
            tooLarge: false,
          };
        case 'checks':
          return [{ name: 'Build', state: 'success', webUrl: '' }];
      }
    }
    switch (command) {
      case 'initial_repository':
        return null;
      case 'hosting_cancel_read':
        return null;
      case 'hosting_login':
        accounts = [github];
        return github;
      case 'hosting_validate':
        return github;
      case 'hosting_logout':
        accounts = accounts.filter((item) => item.id !== args.accountId);
        return null;
      case 'hosting_comment':
        return { id: '2', author: 'ming', body: args.body, createdAt: 'today' };
      case 'hosting_change_state':
        state = args.action === 'close' ? 'closed' : 'open';
        return { ...review, state };
      case 'hosting_create_review':
        if (options.failCreate) throw new Error('HTTP 422');
        return { ...review, title: args.request.title };
      case 'hosting_repository':
        return repository;
      case 'hosting_start_clone':
        return 'clone-job';
      case 'transport_progress':
        return { id: 'clone-job', state: 'done', directory: 'C:/fixture/repo', lines: [], error: '', prompt: null };
      case 'hosting_open_url':
        return null;
      default:
        throw Error(`Unexpected backend command ${command}`);
    }
    throw Error(`Unexpected query ${JSON.stringify(args)}`);
  };
  localStorage.clear();
  return { calls, oldRepositoryResponse: () => resolveOld };
}

async function openRepository() {
  await waitFor(() => root.textContent?.includes('owner/repo'));
  button('owner/repo私有 · main').click();
  await waitFor(() => root.querySelector('.hosting-review-heading'));
}

test('browser login opens through account management, remembers the public client ID and connects the authorized identity', async () => {
  const calls: Call[] = [];
  const changed: Account[] = [];
  let complete: (account: Account) => void = () => {};
  globalThis.testBackend = async (command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'hosting_oauth_start') return { id: 'login-id', url: 'https://github.com/login/device', userCode: 'ABCD-EFGH', expiresAt: Date.now() / 1000 + 900 };
    if (command === 'hosting_oauth_finish') return new Promise<Account>(resolve => { complete = resolve; });
    if (command === 'hosting_oauth_open' || command === 'hosting_oauth_registration') return null;
    if (command === 'hosting_oauth_cancel') return true;
    throw Error(command);
  };
  localStorage.clear();
  render(<Accounts accounts={[]} onChanged={account => { if (account) changed.push(account); }} onClose={() => render(null, root)} />, root);
  try {
    assert.equal(button('使用 GitHub 网页登录').disabled, true);
    assert.ok(root.textContent?.includes('Enable Device Flow'));
    input('input[aria-label="OAuth Client ID"]', 'public-client-id');
    await waitFor(() => !button('使用 GitHub 网页登录').disabled);
    button('使用 GitHub 网页登录').click();
    await waitFor(() => root.querySelector('input[aria-label="网页验证码"]'));
    assert.equal((root.querySelector('input[aria-label="网页验证码"]') as HTMLInputElement).value, 'ABCD-EFGH');
    assert.equal(calls.find(call => call.command === 'hosting_oauth_open')?.args.sessionId, 'login-id');
    assert.equal(button('关闭账户管理').disabled, false);
    complete(github);
    await waitFor(() => root.textContent?.includes('已通过网页连接 ming'));
    assert.deepEqual(changed, [github]);
    assert.ok(localStorage.getItem('hosting.oauthApps')?.includes('public-client-id'));
    assert.ok(!localStorage.getItem('hosting.oauthApps')?.includes('ABCD-EFGH'));
    assert.ok(!localStorage.getItem('hosting.oauthApps')?.includes('login-id'));
    assert.equal(root.querySelector('input[aria-label="网页验证码"]'), null);
  } finally { render(null, root); }
});

test('GitLab browser login configures the selected self-hosted server and shows its exact callback URI', async () => {
  const calls: Call[] = [];
  let complete: (account: Account) => void = () => {};
  globalThis.testBackend = async (command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'hosting_oauth_start') return { id: 'gitlab-login', url: 'https://gitlab.example.test/oauth/authorize', userCode: null, expiresAt: Date.now() / 1000 + 300 };
    if (command === 'hosting_oauth_finish') return new Promise<Account>(resolve => { complete = resolve; });
    if (command === 'hosting_oauth_open') return null;
    if (command === 'hosting_oauth_cancel') return true;
    throw Error(command);
  };
  localStorage.clear();
  render(<Accounts accounts={[]} onChanged={() => {}} onClose={() => render(null, root)} />, root);
  try {
    const platform = root.querySelector('select')!;
    platform.value = 'gitlab';
    platform.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => root.textContent?.includes('使用 GitLab 网页登录'));
    input('input[type="url"]', 'https://gitlab.example.test');
    await waitFor(() => root.textContent?.includes('Confidential'));
    assert.ok(root.textContent?.includes('http://127.0.0.1:34171/oauth/callback'));
    input('input[aria-label="OAuth Client ID"]', 'gitlab-client-id');
    await waitFor(() => !button('使用 GitLab 网页登录').disabled);
    button('使用 GitLab 网页登录').click();
    await waitFor(() => calls.some(call => call.command === 'hosting_oauth_finish'));
    assert.deepEqual(calls.find(call => call.command === 'hosting_oauth_start')!.args.request,
      { provider: 'gitlab', server: 'https://gitlab.example.test', clientId: 'gitlab-client-id' });
    assert.equal(root.querySelector('input[aria-label="网页验证码"]'), null);
    complete(gitlab);
    await waitFor(() => root.textContent?.includes('已通过网页连接 team'));
  } finally { render(null, root); }
});

test('cancelling browser authorization releases the controls and allows another attempt', async () => {
  let rejectPending: (error: Error) => void = () => {};
  let starts = 0;
  globalThis.testBackend = async (command: string) => {
    if (command === 'hosting_oauth_start') return { id: `login-${++starts}`, url: 'https://github.com/login/device', userCode: 'CODE', expiresAt: Date.now() / 1000 + 900 };
    if (command === 'hosting_oauth_finish') return new Promise((_, reject) => { rejectPending = reject; });
    if (command === 'hosting_oauth_open') return null;
    if (command === 'hosting_oauth_cancel') { rejectPending(new Error('网页登录已取消')); return true; }
    throw Error(command);
  };
  localStorage.clear();
  render(<Accounts accounts={[]} onChanged={() => assert.fail('cancelled login must not select an account')} onClose={() => render(null, root)} />, root);
  try {
    input('input[aria-label="OAuth Client ID"]', 'public-client');
    await waitFor(() => !button('使用 GitHub 网页登录').disabled);
    button('使用 GitHub 网页登录').click();
    await waitFor(() => root.textContent?.includes('取消网页登录'));
    button('取消网页登录').click();
    await waitFor(() => root.textContent?.includes('网页登录已取消'));
    assert.equal(button('使用 GitHub 网页登录').disabled, false);
    button('使用 GitHub 网页登录').click();
    await waitFor(() => starts === 2 && root.textContent?.includes('取消网页登录'));
    button('取消网页登录').click();
    await waitFor(() => !button('使用 GitHub 网页登录').disabled);
  } finally { render(null, root); }
});

test('closing while device authorization is starting cancels the late session without finishing it', async () => {
  const calls: Call[] = [];
  let resolveStart: (value: unknown) => void = () => {};
  globalThis.testBackend = async (command: string, args: any) => {
    calls.push({ command, args });
    if (command === 'hosting_oauth_start') return new Promise(resolve => { resolveStart = resolve; });
    if (command === 'hosting_oauth_cancel') return true;
    throw Error(command);
  };
  localStorage.clear();
  render(<Accounts accounts={[]} onChanged={() => assert.fail('closed login must not select an account')} onClose={() => render(null, root)} />, root);
  try {
    input('input[aria-label="OAuth Client ID"]', 'public-client');
    await waitFor(() => !button('使用 GitHub 网页登录').disabled);
    button('使用 GitHub 网页登录').click();
    await waitFor(() => calls.some(call => call.command === 'hosting_oauth_start'));
    button('关闭账户管理').click();
    resolveStart({ id: 'late-id', url: 'https://github.com/login/device', userCode: 'LATE', expiresAt: Date.now() / 1000 + 900 });
    await waitFor(() => calls.some(call => call.command === 'hosting_oauth_cancel'));
    assert.equal(calls.find(call => call.command === 'hosting_oauth_cancel')!.args.sessionId, 'late-id');
    assert.equal(calls.some(call => call.command === 'hosting_oauth_finish'), false);
  } finally { render(null, root); }
});

test('hosting opens through the main toolbar and stores no token in browser persistence', async () => {
  const { calls } = backend({ empty: true });
  render(<App />, root);
  try {
    button('托管平台 · GitHub / GitLab').click();
    await waitFor(() => root.textContent?.includes('连接 GitHub 或 GitLab'));
    button('添加平台账户').click();
    await waitFor(() => root.querySelector('input[type="password"]'));
    input('input[type="password"]', 'fixture-secret-token');
    await waitFor(() => !button('验证并保存').disabled);
    root
      .querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => calls.some((call) => call.command === 'hosting_login'));
    await waitFor(() => root.textContent?.includes('已连接 ming'));
    assert.equal((root.querySelector('input[type="password"]') as HTMLInputElement).value, '');
    assert.equal(
      calls.find((call) => call.command === 'hosting_login')!.args.request.token,
      'fixture-secret-token',
    );
    for (let i = 0; i < localStorage.length; i++)
      assert.ok(!localStorage.getItem(localStorage.key(i)!)?.includes('fixture-secret-token'));
    button('关闭账户管理').click();
    await waitFor(() => !root.querySelector('[role="dialog"]'));
    button('返回本地工作区').click();
    await waitFor(() => root.querySelector('.welcome'));
  } finally {
    render(null, root);
  }
});

test('switching accounts cancels old reads and discards late repository responses', async () => {
  const fixture = backend({ delayedRepos: true });
  render(<HostingView localRoot="" onOpen={async () => {}} onClose={() => {}} />, root);
  try {
    await waitFor(() => fixture.oldRepositoryResponse());
    const select = root.querySelector<HTMLSelectElement>('[aria-label="托管账户"]')!;
    select.value = gitlab.id;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => root.textContent?.includes('group/sub/project'));
    fixture.oldRepositoryResponse()!({
      items: [{ ...repository, path: 'old-account/private-repository' }],
      hasMore: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!root.textContent?.includes('old-account/private-repository'));
    assert.ok(fixture.calls.some((call) => call.command === 'hosting_cancel_read'));
    const repoList = root.querySelector('.hosting-repositories')!;
    [...repoList.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === '下一页')!
      .click();
    await waitFor(() =>
      fixture.calls.some(
        (call) =>
          call.command === 'hosting_read' &&
          call.args.request.accountId === gitlab.id &&
          call.args.request.page === 2,
      ),
    );
  } finally {
    render(null, root);
  }
});

test('remote request details render safe comments, remote diff and explicit state mutations', async () => {
  const { calls } = backend();
  render(<HostingView localRoot="" onOpen={async () => {}} onClose={() => {}} />, root);
  try {
    await openRepository();
    await waitFor(() => root.textContent?.includes('<script>unsafe()</script>'));
    assert.equal(root.querySelector('.hosting-comments script'), null);
    input('textarea', 'Reviewed from desktop');
    await waitFor(() => !button('发布评论').disabled);
    root
      .querySelector('.hosting-comments form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => root.textContent?.includes('评论已发布'));
    assert.equal(calls.find((call) => call.command === 'hosting_comment')!.args.number, 7);
    button('变更文件').click();
    await waitFor(() => root.querySelector('.hosting-diff .diff-editors'));
    const read = calls.find(
      (call) => call.command === 'hosting_read' && call.args.request.kind === 'file_diff',
    )!;
    assert.equal(read.args.request.request.headSha, review.headSha);
    assert.equal(read.args.request.request.baseSha, review.baseSha);
    button('CI 状态').click();
    await waitFor(() => root.textContent?.includes('success'));
    button('关闭请求').click();
    await waitFor(() => root.querySelector('[role="alertdialog"]'));
    assert.equal(calls.filter((call) => call.command === 'hosting_change_state').length, 0);
    button('确认关闭').click();
    await waitFor(() => root.querySelector('.hosting-state.closed'));
    button('重新打开').click();
    await waitFor(() => root.querySelector('[role="alertdialog"]'));
    button('确认重新打开').click();
    await waitFor(() => root.querySelector('.hosting-state.open'));
  } finally {
    render(null, root);
  }
});

test('failed request creation preserves form inputs and never retries a write automatically', async () => {
  const { calls } = backend({ failCreate: true });
  render(<HostingView localRoot="" onOpen={async () => {}} onClose={() => {}} />, root);
  try {
    await openRepository();
    button('创建 PR').click();
    await waitFor(() => root.querySelector('[role="dialog"]'));
    const fields = root.querySelectorAll<HTMLInputElement>(
      '[role="dialog"] input:not([type="checkbox"])',
    );
    fields[0].value = 'New request';
    fields[0].dispatchEvent(new window.Event('input', { bubbles: true }));
    fields[1].value = 'feature';
    fields[1].dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => !button('创建请求').disabled);
    root
      .querySelector('[role="dialog"] form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() =>
      root.querySelector('[role="dialog"] [role="alert"]')?.textContent?.includes('HTTP 422'),
    );
    assert.equal(calls.filter((call) => call.command === 'hosting_create_review').length, 1);
    assert.equal(fields[0].value, 'New request');
    assert.equal(fields[1].value, 'feature');
  } finally {
    render(null, root);
  }
});

test('GitLab creation sends the selected account and a draft, and account removal is explicit', async () => {
  const { calls } = backend();
  render(<HostingView localRoot="" onOpen={async () => {}} onClose={() => {}} />, root);
  try {
    await waitFor(() => root.textContent?.includes('owner/repo'));
    const select = root.querySelector<HTMLSelectElement>('[aria-label="托管账户"]')!;
    select.value = gitlab.id;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => root.textContent?.includes('group/sub/project'));
    button('group/sub/project私有 · main').click();
    await waitFor(() => root.querySelector('.hosting-review-heading'));
    button('创建 MR').click();
    await waitFor(() => root.querySelector('[role="dialog"]'));
    const fields = root.querySelectorAll<HTMLInputElement>(
      '[role="dialog"] input:not([type="checkbox"])',
    );
    fields[0].value = 'GitLab draft';
    fields[0].dispatchEvent(new window.Event('input', { bubbles: true }));
    fields[1].value = 'feature';
    fields[1].dispatchEvent(new window.Event('input', { bubbles: true }));
    const draft = root.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
    draft.checked = true;
    draft.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => !button('创建请求').disabled);
    root
      .querySelector('[role="dialog"] form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => calls.some((call) => call.command === 'hosting_create_review'));
    const request = calls.find((call) => call.command === 'hosting_create_review')!.args;
    assert.equal(request.accountId, gitlab.id);
    assert.equal(request.repository, 'group/sub/project');
    assert.equal(request.request.draft, true);
    await waitFor(() => !root.querySelector('[role="dialog"]'));
    button('管理账户').click();
    await waitFor(() => root.querySelector('.hosting-account-dialog'));
    const row = [...root.querySelectorAll('.hosting-account-row')].find((node) =>
      node.textContent?.includes('GitLab'),
    )!;
    [...row.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === '移除')!
      .click();
    await waitFor(() => row.textContent?.includes('确认移除'));
    assert.equal(calls.filter((call) => call.command === 'hosting_logout').length, 0);
    button('确认移除').click();
    await waitFor(() => calls.some((call) => call.command === 'hosting_logout'));
    assert.equal(
      calls.find((call) => call.command === 'hosting_logout')!.args.accountId,
      gitlab.id,
    );
  } finally {
    render(null, root);
  }
});

test('clone dialog forwards SSH aliases and associates the completed local repository', async () => {
  const { calls } = backend();
  (globalThis as any).testDialog = async () => 'C:/fixture';
  render(<HostingView localRoot="" onOpen={async () => {}} onClose={() => {}} />, root);
  try {
    await openRepository();
    button('克隆').click();
    await waitFor(() => root.querySelector('[role="dialog"]'));
    button('选择目录').click();
    input('input[placeholder="例如 github_ming"]', 'github_ming');
    await waitFor(() => !button('开始克隆').disabled);
    root
      .querySelector('[role="dialog"] form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => root.textContent?.includes('本地 · C:/fixture/repo'));
    const request = calls.find((call) => call.command === 'hosting_start_clone')!.args.request;
    assert.equal(request.sshAlias, 'github_ming');
    assert.equal(request.protocol, 'ssh');
    assert.equal(request.parent, 'C:/fixture');
    assert.equal(
      localStorage.getItem(`hosting.local.${github.id}.${repository.id}`),
      '"C:/fixture/repo"',
    );
  } finally {
    render(null, root);
    delete (globalThis as any).testDialog;
  }
});
