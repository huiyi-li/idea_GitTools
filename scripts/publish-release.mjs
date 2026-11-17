import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { releaseAssets, releaseCommands } from './release-plan.mjs';

const tag = process.env.RELEASE_TAG;
const notesFile = process.env.RELEASE_NOTES_FILE;
if (!tag || !notesFile) throw new Error('Missing RELEASE_TAG or RELEASE_NOTES_FILE');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const notes = await readFile(notesFile, 'utf8');
if (!notes.startsWith(`# IdeaGitTool ${version}\n`)) throw new Error('Release notes do not match app version');
const assets = releaseAssets(version);
for (const asset of assets) await access(asset);

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'GitHub release operation failed');
  return result.stdout;
}
const existing = spawnSync('gh', ['release', 'view', tag, '--json', 'isDraft'], { encoding: 'utf8', windowsHide: true });
if (existing.error) throw existing.error;
for (const command of releaseCommands({ tag, version, notesFile, existing, assets })) gh(command);
console.log(`已验证并正式发布 ${tag} 的安装包、便携程序与更新清单。`);
