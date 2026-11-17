import { readFile } from 'node:fs/promises';
import { releaseNotesMatchVersion } from './release-plan.mjs';
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const configVersion = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).version;
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const npmLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const cargoLock = await readFile('src-tauri/Cargo.lock', 'utf8');
const cargoLockVersion = cargoLock.match(/\[\[package\]\]\s+name = "ideagittool-desktop"\s+version = "([^"]+)"/)?.[1];
if ([configVersion, cargoVersion, npmLock.version, npmLock.packages[''].version, cargoLockVersion].some(version => version !== packageVersion)) {
  throw new Error('应用版本与配置、npm/Cargo lockfile 不一致');
}
if (process.env.RELEASE_TAG && ![packageVersion, `v${packageVersion}`].includes(process.env.RELEASE_TAG)) throw new Error('Git tag 与应用版本不一致');
if (process.env.RELEASE_TAG || process.env.RELEASE_NOTES_FILE) {
  const notes = await readFile(process.env.RELEASE_NOTES_FILE || `docs/RELEASE_${packageVersion}.md`, 'utf8');
  if (!releaseNotesMatchVersion(notes, packageVersion)) throw new Error('Release 说明标题与应用版本不一致');
}
console.log(`已核对版本 ${packageVersion}`);
