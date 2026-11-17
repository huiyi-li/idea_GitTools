import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseAssets, releaseCommands, releaseNotesMatchVersion } from './release-plan.mjs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const notesFile = `docs/RELEASE_${version}.md`;
const assets = releaseAssets(version);

test('release note headers accept LF, CRLF and UTF-8 BOM but reject another version', () => {
  assert.equal(releaseNotesMatchVersion(`# IdeaGitTool ${version}\n\n新增功能`, version), true);
  assert.equal(releaseNotesMatchVersion(`# IdeaGitTool ${version}\r\n\r\n新增功能`, version), true);
  assert.equal(releaseNotesMatchVersion(`\uFEFF# IdeaGitTool ${version}\r\n新增功能`, version), true);
  assert.equal(releaseNotesMatchVersion('# IdeaGitTool 0.4.3\r\n', version), false);
  assert.equal(releaseNotesMatchVersion(`# IdeaGitTool ${version}-wrong\r\n`, version), false);
});

test('publishes only versioned executable and signed updater assets', () => {
  assert.deepEqual(assets, [
    'release/IdeaGitTool.exe',
    'release/IdeaGitTool-setup.exe',
    'release/IdeaGitTool-setup.exe.sig',
    `release/IdeaGitTool_${version}_windows-x64.zip`,
    'release/latest.json',
    'release/release-manifest.json',
  ]);
  assert.throws(() => releaseAssets('../other'), /Invalid release version/);
});

test('a new release stays private until all verified assets upload', () => {
  const commands = releaseCommands({ tag: version, version, notesFile, assets,
    existing: { status: 1, stderr: 'release not found' } });
  assert.deepEqual(commands[0], ['release', 'create', version, '--verify-tag', '--draft', '--title', `release ${version}`, '--notes-file', notesFile]);
  assert.deepEqual(commands[1], ['release', 'upload', version, ...assets, '--clobber']);
  assert.deepEqual(commands[2], ['release', 'edit', version, '--draft=false', '--latest']);
});

test('a failed upload leaves a draft that can be retried without replacing published assets', () => {
  const commands = releaseCommands({ tag: version, version, notesFile, assets,
    existing: { status: 0, stdout: '{"isDraft":true}' } });
  assert.deepEqual(commands[0], ['release', 'edit', version, '--draft', '--title', `release ${version}`, '--notes-file', notesFile]);
  assert.deepEqual(commands[1], ['release', 'upload', version, ...assets, '--clobber']);
  assert.throws(() => releaseCommands({ tag: version, version, notesFile, assets,
    existing: { status: 0, stdout: '{"isDraft":false}' } }), /已发布/);
  assert.throws(() => releaseCommands({ tag: version, version, notesFile, assets,
    existing: { status: 1, stderr: 'HTTP 403 permission denied' } }), /403/);
  assert.throws(() => releaseCommands({ tag: `${version}-mismatch`, version, notesFile, assets,
    existing: { status: 1, stderr: 'release not found' } }), /does not match/);
});

test('versioned notes use the existing release layout and list features only', () => {
  const notes = readFileSync(notesFile, 'utf8');
  assert.equal(releaseNotesMatchVersion(notes, version), true);
  assert.match(notes, /^## 多仓库工作区$/m);
  assert.match(notes, /^## 提交与本地更改$/m);
  assert.match(notes, /^## 日志与提交图$/m);
  assert.doesNotMatch(notes, /^- .*修复/m);
});
