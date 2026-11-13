import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
if (!process.argv[2]) {
  const build = spawnSync(
    'cargo',
    ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'ideagittool-desktop'],
    { cwd: repo, stdio: 'inherit' },
  );
  assert.equal(build.status, 0, 'native helper build');
}
const metadata = spawnSync(
  'cargo',
  ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--no-deps', '--format-version', '1'],
  { cwd: repo, encoding: 'utf8' },
);
assert.equal(metadata.status, 0);
const sourceExecutable = process.argv[2]
  ? resolve(repo, process.argv[2])
  : join(
      JSON.parse(metadata.stdout).target_directory,
      'debug',
      process.platform === 'win32' ? 'ideagittool-desktop.exe' : 'ideagittool-desktop',
    );
const directory = await mkdtemp(join(tmpdir(), 'ideagittool-native-'));
const executable = join(directory, '.git', process.platform === 'win32' ? 'native helper.exe' : 'native helper');
function git(args, environment = {}) {
  const result = spawnSync(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd: directory,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...environment },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
try {
  git(['init', '-b', 'main']);
  await copyFile(sourceExecutable, executable);
  git(['config', 'user.name', 'Native Test']);
  git(['config', 'user.email', 'test@example.test']);
  const commits = [];
  for (let index = 0; index < 4; index++) {
    await writeFile(join(directory, `file-${index}.txt`), `contents ${index}\n`);
    git(['add', '.']);
    git(['commit', '-m', `commit ${index}`]);
    commits.push({
      hash: git(['rev-parse', 'HEAD']),
      parents: [],
      author: '',
      email: '',
      time: 0,
      subject: `commit ${index}`,
      refs: [],
    });
  }
  const planPath = join(directory, '.git', 'ideagittool-interactive.json');
  const editor = `'${executable.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
  const environment = {
    GIT_SEQUENCE_EDITOR: `${editor} --git-sequence-editor`,
    GIT_EDITOR: `${editor} --git-message-editor`,
    IDEAGITTOOL_REBASE_PLAN: planPath.replaceAll('\\', '/'),
  };
  const preview = {
    head: commits[3].hash,
    branch: 'main',
    base: commits[0].hash,
    onto: null,
    mergeCount: 0,
    commits: commits.slice(1),
  };
  await writeFile(
    planPath,
    JSON.stringify({
      preview,
      entries: [
        { hash: commits[1].hash, action: 'reword', message: 'renamed first' },
        {
          hash: commits[2].hash,
          action: 'squash',
          message: 'combined message\n\nretained body',
        },
        { hash: commits[3].hash, action: 'drop', message: '' },
      ],
    }),
  );
  git(
    [
      '-c',
      'core.abbrev=40',
      'rebase',
      '-i',
      '--reapply-cherry-picks',
      '--empty=keep',
      commits[0].hash,
    ],
    environment,
  );
  assert.equal(git(['log', '-1', '--format=%B']), 'combined message\n\nretained body');
  assert.equal(git(['rev-list', '--count', 'HEAD']), '2');
  assert.equal(await readFile(join(directory, 'file-2.txt'), 'utf8'), 'contents 2\n');
  git(['reset', '--hard', commits[3].hash]);
  await writeFile(
    planPath,
    JSON.stringify({
      preview,
      entries: [
        { hash: commits[2].hash, action: 'edit', message: '' },
        { hash: commits[1].hash, action: 'pick', message: '' },
        {
          hash: commits[3].hash,
          action: 'reword',
          message: 'after edit pause',
        },
      ],
    }),
  );
  git(
    [
      '-c',
      'core.abbrev=40',
      'rebase',
      '-i',
      '--reapply-cherry-picks',
      '--empty=keep',
      commits[0].hash,
    ],
    environment,
  );
  assert.equal(git(['rev-parse', '--verify', 'HEAD:file-2.txt']).length, 40);
  git(['commit', '--amend', '--no-edit'], environment);
  git(['rebase', '--continue'], environment);
  assert.equal(git(['log', '-1', '--format=%s']), 'after edit pause');
  const order = git(['log', '--reverse', '--format=%s']).split('\n');
  assert.deepEqual(order, ['commit 0', 'commit 2', 'commit 1', 'after edit pause']);

  const server = createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
    });
    socket.on('end', () => {
      const request = JSON.parse(input);
      assert.equal(request.nonce, 'fixture-nonce');
      assert.equal(request.prompt, 'Password for local fixture');
      socket.end('fixture-password');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(executable, ['Password for local fixture'], {
      cwd: directory,
      windowsHide: true,
      env: {
        ...process.env,
        IDEAGITTOOL_ASKPASS_NONCE: 'fixture-nonce',
        IDEAGITTOOL_ASKPASS_ADDRESS: `127.0.0.1:${server.address().port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert.equal(status, 0);
    assert.equal(output.trim(), 'fixture-password');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  let authenticated = false;
  const askpassExecutable = join(
    directory,
    process.platform === 'win32' ? 'askpass helper.exe' : 'askpass helper',
  );
  await copyFile(executable, askpassExecutable);
  const http = createHttpServer((request, response) => {
    if (
      request.headers.authorization !==
      `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`
    ) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Git fixture"' });
      response.end();
    } else {
      authenticated = true;
      response.writeHead(404);
      response.end('fixture repository');
    }
  });
  const broker = createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
    });
    socket.on('end', () => {
      const request = JSON.parse(input);
      assert.equal(request.nonce, 'http-fixture');
      socket.end(
        request.prompt.toLowerCase().includes('username') ? 'fixture-user' : 'fixture-password',
      );
    });
  });
  await Promise.all([
    new Promise((resolve) => http.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => broker.listen(0, '127.0.0.1', resolve)),
  ]);
  try {
    const child = spawn(
      'git',
      ['-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${http.address().port}/repo.git`],
      {
        cwd: directory,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_ASKPASS: askpassExecutable,
          IDEAGITTOOL_ASKPASS_NONCE: 'http-fixture',
          IDEAGITTOOL_ASKPASS_ADDRESS: `127.0.0.1:${broker.address().port}`,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let output = '';
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('HTTP authentication timed out'));
      }, 15000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.notEqual(status, 0);
    assert.equal(
      authenticated,
      true,
      `Git completed HTTP authentication using the native askpass helper. ${output}`,
    );
    assert.ok(!output.includes('fixture-password'));
  } finally {
    await Promise.all([
      new Promise((resolve) => http.close(resolve)),
      new Promise((resolve) => broker.close(resolve)),
    ]);
  }
  console.log(
    'Native helpers passed: interactive rebase, reword, squash, drop, reorder, edit/continue and askpass.',
  );
} finally {
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}
