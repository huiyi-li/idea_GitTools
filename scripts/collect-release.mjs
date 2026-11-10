import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  await mkdir(output, { recursive: true });
  for (const [source, name] of files) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await copyFile(source, join(output, name));
  }
  console.log(`程序已整理到 ${output}`);
  console.log(`双击 ${join(output, 'IdeaGitTool.exe')} 启动`);
} catch (error) {
  console.error(`整理 release 目录失败。请确认打包已成功，并关闭该目录中正在运行的程序。\n${error.message}`);
  process.exitCode = 1;
}
