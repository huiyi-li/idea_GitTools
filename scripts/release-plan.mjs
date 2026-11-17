export function releaseAssets(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  return [
    'IdeaGitTool.exe',
    'IdeaGitTool-setup.exe',
    'IdeaGitTool-setup.exe.sig',
    `IdeaGitTool_${version}_windows-x64.zip`,
    'latest.json',
    'release-manifest.json',
  ].map(name => `release/${name}`);
}

export function releaseCommands({ tag, version, notesFile, existing, assets }) {
  if (tag !== version && tag !== `v${version}`) throw new Error('Release tag does not match app version');
  if (!notesFile) throw new Error('Missing RELEASE_NOTES_FILE');
  let prepare;
  if (existing.status === 0) {
    if (!JSON.parse(existing.stdout).isDraft) throw new Error('该版本已发布，禁止覆盖已发布的更新文件');
    prepare = ['release', 'edit', tag, '--draft', '--title', `release ${version}`, '--notes-file', notesFile];
  } else if (existing.stderr?.includes('release not found')) {
    prepare = ['release', 'create', tag, '--verify-tag', '--draft', '--title', `release ${version}`, '--notes-file', notesFile];
  } else {
    throw new Error(existing.stderr || '无法检查现有 GitHub Release，请先确认权限与网络');
  }
  return [
    prepare,
    ['release', 'upload', tag, ...assets, '--clobber'],
    ['release', 'edit', tag, '--draft=false', '--latest'],
  ];
}
