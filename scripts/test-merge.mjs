import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'ideagittool-merge-test-'));
try {
  const tests = [
    'merge.test',
    'merge-ui.test',
    'workspace-ui.test',
    'analysis.test',
    'diff-ui.test',
    'minimap.test',
    'hosting-ui.test',
    'review-ui.test',
    'navigation-ui.test',
  ];
  await build({
    entryPoints: [
      ...tests.map(
        (name) =>
          `test/${name}.${['workspace-ui.test', 'diff-ui.test', 'minimap.test', 'hosting-ui.test', 'review-ui.test', 'navigation-ui.test'].includes(name) ? 'tsx' : 'ts'}`,
      ),
      'test/analysis-worker.ts',
    ],
    outdir: directory,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      {
        name: 'test-environment',
        setup(build) {
          build.onLoad({ filter: /[\\/]merge[\\/]analysis-client\.ts$/ }, async (args) => ({
            contents: (await readFile(args.path, 'utf8')).replace(
              "new URL('./analysis.worker.ts', import.meta.url)",
              "new URL('./analysis-worker.mjs', import.meta.url)",
            ),
            loader: 'ts',
          }));
          build.onLoad({ filter: /[\\/]ui[\\/]controls\.tsx$/ }, async (args) => ({
            contents: (await readFile(args.path, 'utf8')).replace(/import\.meta\.glob\([^)]*\)/, '{}'),
            loader: 'tsx',
          }));
          build.onResolve({ filter: /^@tauri-apps\// }, (args) => ({
            path: args.path,
            namespace: 'tauri-test',
          }));
          build.onLoad({ filter: /.*/, namespace: 'tauri-test' }, () => ({
            contents: `
              export const invoke = (command, args) => globalThis.testBackend(command, args);
              export const listen = async () => () => {};
              export const open = async (...args) => globalThis.testDialog ? globalThis.testDialog(...args) : null;
              export const getCurrentWindow = () => ({ onCloseRequested: async () => () => {}, close: async () => {} });
            `,
          }));
          build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
          build.onResolve({ filter: /^happy-dom$/ }, () => ({
            path: pathToFileURL(resolve('node_modules/happy-dom/lib/index.js')).href,
            external: true,
          }));
          build.onResolve({ filter: /^\.\/ui$/ }, () => ({ path: 'merge-ui', namespace: 'test' }));
          build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export const iconUrl = () => ""; export const t = (text) => text;',
          }));
        },
      },
    ],
  });
  const result = spawnSync(
    process.execPath,
    ['--test', ...tests.map((name) => join(directory, `${name}.mjs`))],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
} finally {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory');
  await rm(directory, { recursive: true, force: true });
}
