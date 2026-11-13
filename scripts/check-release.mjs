import { readFile } from 'node:fs/promises';
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const configVersion = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).version;
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (packageVersion !== configVersion || packageVersion !== cargoVersion) throw new Error('package.json、Cargo.toml 和 tauri.conf.json 版本必须一致');
if (process.env.RELEASE_TAG && ![packageVersion, `v${packageVersion}`].includes(process.env.RELEASE_TAG)) throw new Error('Git tag 与应用版本不一致');
console.log(`已核对版本 ${packageVersion}`);
