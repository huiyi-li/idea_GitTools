import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localKey = process.env.IDEAGITTOOL_SIGNING_KEY_PATH || join(homedir(), '.tauri/IdeaGitTool/updater.key');
const env = { ...process.env };
try {
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    await access(localKey);
    env.TAURI_SIGNING_PRIVATE_KEY = await readFile(localKey, 'utf8');
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
    const publicKey = (await readFile(`${localKey}.pub`, 'utf8')).trim();
    const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    if (publicKey !== config.plugins.updater.pubkey) throw new Error('本地签名公钥与应用配置不匹配');
  }
  const child = spawn(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...process.argv.slice(2)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(`启动打包失败。${error.message}`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(`签名打包准备失败。${error.message}\n请恢复本机签名密钥，或配置 TAURI_SIGNING_PRIVATE_KEY 与 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。详见 README。`);
  process.exitCode = 1;
}
