import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { render } from 'preact';
import { updateManifest } from '../scripts/update-manifest.mjs';

const window = new Window({ url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'MutationObserver'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const { UpdateManager, readUpdateSession, UPDATE_SESSION } = await import('../src/UpdateManager');
const host = document.createElement('div');
document.body.append(host);
afterEach(() => { render(null, host); localStorage.clear(); });
after(() => window.happyDOM.close());

async function waitFor(predicate: () => unknown) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Updater did not reach expected state');
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label);
  assert.ok(result, label);
  return result;
}
function content() { return document.querySelector('[aria-label="软件更新"]')?.textContent || ''; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const calls: string[] = [];
  const value = { version: '0.4.3', body: '<script>unsafe()</script>\nNew features', date: '2026-11-13T00:00:00Z',
    close: async () => { calls.push('close'); },
    download: async (event: (value: unknown) => void) => {
      calls.push('download'); event({ event: 'Started', data: { contentLength: 1024 } });
      event({ event: 'Progress', data: { chunkLength: 512 } }); event({ event: 'Finished' });
    },
    install: async (options: unknown) => { calls.push('install'); assert.deepEqual(options, { restartAfterInstall: true }); },
  };
  (globalThis as any).testUpdater = async (options: unknown) => { calls.push('check'); assert.deepEqual(options, { timeout: 30000 }); return value; };
  return { calls, value };
}
function mount(props: Partial<Parameters<typeof UpdateManager>[0]> = {}) {
  render(<UpdateManager open onOpenChange={() => {}} blocked="" beforeInstall={() => {}} onInstallFailed={() => {}} {...props} />, host);
}

test('signed updater checks, shows plain release notes, downloads and installs after saving session', async () => {
  const { calls } = fixture();
  mount({ beforeInstall: () => { calls.push('save'); } });
  button('检查更新').click(); button('检查更新').click();
  await waitFor(() => content().includes('0.4.3 发布说明'));
  assert.equal(calls.filter(c => c === 'check').length, 1);
  assert.equal(document.querySelector('.update-notes script'), null);
  assert.ok(content().includes('<script>unsafe()</script>'));
  button('下载更新').click();
  await waitFor(() => content().includes('通过签名校验'));
  assert.ok(!calls.includes('install'));
  button('安装并重启').click(); button('安装并重启').click();
  await waitFor(() => calls.includes('install'));
  assert.deepEqual(calls, ['check', 'download', 'save', 'install']);
});

test('updater reports no newer version and 404 without pretending it is up to date', async () => {
  (globalThis as any).testUpdater = async () => null;
  mount(); button('检查更新').click();
  await waitFor(() => content().includes('已是最新版本'));
  (globalThis as any).testUpdater = async () => { throw Error('HTTP 404'); };
  button('检查更新').click();
  await waitFor(() => content().includes('latest.json 更新清单'));
  assert.ok(!content().includes('已是最新版本'));
  (globalThis as any).testUpdater = async () => { throw Error('Could not fetch a valid release JSON from the remote'); };
  button('检查更新').click();
  await waitFor(() => content().includes('GitHub 连接与发布资源'));
});

test('signature failure prevents installation and allows download retry', async () => {
  const { calls, value } = fixture();
  const download = value.download;
  value.download = async () => { throw Error('signature verification failed'); };
  mount(); button('检查更新').click();
  await waitFor(() => content().includes('0.4.3 发布说明'));
  button('下载更新').click();
  await waitFor(() => content().includes('签名校验失败'));
  assert.ok(!calls.includes('install'));
  assert.equal(document.querySelector('.update-dialog .primary')?.textContent, '下载更新');
  value.download = download;
  button('下载更新').click();
  await waitFor(() => content().includes('通过签名校验'));
});

test('Git work blocks installation even if it starts during download, install errors can retry', async () => {
  const { calls, value } = fixture();
  const downloaded = deferred<void>();
  value.download = async () => downloaded.promise;
  mount(); button('检查更新').click();
  await waitFor(() => content().includes('0.4.3 发布说明'));
  button('下载更新').click();
  mount({ blocked: 'Git 操作正在运行' });
  downloaded.resolve();
  await waitFor(() => content().includes('通过签名校验'));
  assert.equal(button('安装并重启').disabled, true);
  button('安装并重启').click();
  assert.ok(!calls.includes('install'));
  let failed = 0;
  value.install = async () => { throw Error('installer spawn failed'); };
  mount({ onInstallFailed: () => { failed++; } });
  button('安装并重启').click();
  await waitFor(() => failed === 1 && content().includes('installer spawn failed'));
  assert.equal(button('安装并重启').disabled, false);
});

test('automatic download preference persists and defers install until requested', async () => {
  const { calls } = fixture();
  mount();
  const checkbox = document.querySelectorAll<HTMLInputElement>('.update-option input')[1];
  checkbox.checked = true; checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => localStorage.getItem('updater.autoDownload') === 'true');
  button('检查更新').click();
  await waitFor(() => content().includes('通过签名校验'));
  assert.ok(calls.includes('download'));
  assert.ok(!calls.includes('install'));
});

test('pending check resources close on unmount and downloaded resources close when dismissed permanently', async () => {
  const { value, calls } = fixture();
  const checked = deferred<typeof value>();
  (globalThis as any).testUpdater = async () => checked.promise;
  mount(); button('检查更新').click();
  render(null, host); checked.resolve(value);
  await waitFor(() => calls.includes('close'));
  assert.equal(calls.filter(c => c === 'close').length, 1);
  assert.equal(document.querySelector('.update-dialog'), null);
});

test('update session validates stored drafts and expires old sessions', () => {
  localStorage.setItem(UPDATE_SESSION, JSON.stringify({ root: 'C:/repo', message: 'draft', savedAt: Date.now() }));
  assert.equal(readUpdateSession()?.message, 'draft');
  localStorage.setItem(UPDATE_SESSION, JSON.stringify({ root: 'C:/repo', message: 'old', savedAt: Date.now() - 86400001 }));
  assert.equal(readUpdateSession(), null);
  localStorage.setItem(UPDATE_SESSION, JSON.stringify({ root: {}, message: 4, savedAt: Date.now() }));
  assert.equal(readUpdateSession(), null);
});

test('startup checks in the background and keeps installation explicit', async () => {
  const { calls } = fixture();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  try {
    mount({ open: false });
    await new Promise(resolve => setTimeout(resolve, 5250));
    await waitFor(() => calls.includes('check'));
    assert.equal(document.querySelector('.update-dialog'), null);
    assert.ok(host.textContent?.includes('新版本 0.4.3'));
    assert.ok(!calls.includes('download'));
    assert.ok(!calls.includes('install'));
  } finally { delete (window as any).__TAURI_INTERNALS__; }
});

test('release manifest targets signed NSIS assets and requires a matching tag', () => {
  const manifest = updateManifest({ version: '0.4.3', tag: 'v0.4.3', signature: ' signature\n', notes: 'notes' });
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'signature');
  assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/huiyi-li/idea_GitTools/releases/download/v0.4.3/IdeaGitTool-setup.exe');
  assert.equal(manifest.notes, 'notes');
  assert.throws(() => updateManifest({ version: '0.4.3', signature: '' }));
  assert.throws(() => updateManifest({ version: '0.4.3', tag: '0.4.2', signature: 'sig' }));
  assert.throws(() => updateManifest({ version: '../../oops', signature: 'sig' }));
});
