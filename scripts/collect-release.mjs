import { access, copyFile, mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { portableZip } from './portable-zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuration = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const target = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, 'src-tauri', process.env.CARGO_TARGET_DIR || 'target');
const output = join(root, 'release');
const files = [
  [join(target, 'release/ideagittool-desktop.exe'), 'IdeaGitTool.exe'],
  [
    join(target, `release/bundle/nsis/${configuration.productName}_${configuration.version}_x64-setup.exe`),
    'IdeaGitTool-setup.exe',
  ],
  [join(root, 'LICENSE'), 'LICENSE'],
  [join(root, 'NOTICE'), 'NOTICE'],
  [join(root, 'licenses/UPSTREAM_LICENSE.txt'), 'licenses/UPSTREAM_LICENSE.txt'],
];

try {
  // Check the whole build before updating the user-facing launch directory.
  for (const [source] of files) await access(source);
  const contents = await Promise.all(files.map(async ([source, name]) => ({ name, data: await readFile(source) })));
  const zipName = `${configuration.productName}_${configuration.version}_windows-x64.zip`;
  const zip = portableZip(contents.filter((item) => item.name !== 'IdeaGitTool-setup.exe'));
  await mkdir(output, { recursive: true });
  for (const [source, name] of files) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await copyFile(source, join(output, name));
  }
  await writeFile(join(output, `${zipName}.tmp`), zip);
  await rename(join(output, `${zipName}.tmp`), join(output, zipName));
  const manifest = {
    version: configuration.version,
    builtAt: new Date().toISOString(),
    files: [...contents.filter((item) => item.name.endsWith('.exe')), { name: zipName, data: zip }].map(({ name, data }) => ({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })),
  };
  await writeFile(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Preserve previous portable packages in an archive, keeping current launch files obvious.
  for (const name of await readdir(output)) {
    if (name.startsWith(`${configuration.productName}_`) && name.endsWith('_windows-x64.zip') && name !== zipName) {
      await mkdir(join(output, 'archive'), { recursive: true });
      await rename(join(output, name), join(output, 'archive', name));
    }
  }
  console.log(`程序已整理到 ${output}`);
  console.log(`双击 ${join(output, 'IdeaGitTool.exe')} 启动`);
} catch (error) {
  console.error(`整理 release 目录失败。请确认打包已成功，并关闭该目录中正在运行的程序。\n${error.message}`);
  process.exitCode = 1;
}
