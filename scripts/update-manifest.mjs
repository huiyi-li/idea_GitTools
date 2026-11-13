const repository = 'huiyi-li/idea_GitTools';

export function updateManifest({ version, signature, tag = version, notes = '', date = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
  if (tag !== version && tag !== `v${version}`) throw new Error('Release tag does not match app version');
  if (!signature?.trim()) throw new Error('Missing updater signature');
  if (!Number.isFinite(Date.parse(date))) throw new Error('Invalid publication date');
  return {
    version, notes, pub_date: date,
    platforms: {
      'windows-x86_64': {
        signature: signature.trim(),
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/IdeaGitTool-setup.exe`,
      },
    },
  };
}
