import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const tag = process.env.RELEASE_TAG;
if (!tag) throw new Error('Missing RELEASE_TAG');
function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'GitHub release operation failed');
  return result.stdout;
}
const existing = spawnSync('gh', ['release', 'view', tag, '--json', 'isDraft'], { encoding: 'utf8', windowsHide: true });
if (existing.status === 0) {
  if (!JSON.parse(existing.stdout).isDraft) throw new Error('该版本已发布，禁止覆盖已发布的更新文件');
} else {
  const notes = process.env.RELEASE_NOTES_FILE ? ['--notes-file', process.env.RELEASE_NOTES_FILE] : ['--generate-notes'];
  gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', `IdeaGitTool ${tag}`, ...notes,
    ...(/-/.test(tag) ? ['--prerelease'] : [])]);
}
const files = (await readdir('release')).filter(name => /\.(exe|sig|zip|json)$/.test(name)).map(name => `release/${name}`);
gh(['release', 'upload', tag, ...files, '--clobber']);
console.log('签名安装包与 latest.json 已上传至草稿，发布草稿后客户端即可检测更新。');
