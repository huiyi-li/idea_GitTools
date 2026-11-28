#!/usr/bin/env node
/**
 * Pre-build i18n integrity gatekeeper for IdeaGitTool.
 *
 * Checks:
 * 1. All locale dictionaries (zh-CN, zh-TW, en) have identical key sets and no empty values.
 * 2. Interpolation placeholders ({name}) match across all locales for every key.
 * 3. Every t('...') call in src/ references a valid key defined in all locales.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = join(root, 'src', 'i18n');
const srcDir = join(root, 'src');

const LOCALES = [
  { id: 'zh-CN', file: 'messages.zh-CN.ts', exportName: 'messagesZhCN' },
  { id: 'zh-TW', file: 'messages.zh-TW.ts', exportName: 'messagesZhTW' },
  { id: 'en', file: 'messages.en.ts', exportName: 'messagesEn' },
];

async function loadLocaleDict(file, exportName) {
  const source = await readFile(join(i18nDir, file), 'utf8');
  const { code } = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'cjs',
  });
  const mod = { exports: {} };
  const fn = new Function('module', 'exports', code);
  fn(mod, mod.exports);
  const dict = mod.exports[exportName];
  if (!dict || typeof dict !== 'object') {
    throw new Error(`Locale file ${file} did not export ${exportName}`);
  }
  return dict;
}

function extractPlaceholders(str) {
  const matches = [...String(str).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
  return [...new Set(matches)].sort();
}

async function walkTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTsFiles(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const dicts = {};
  for (const loc of LOCALES) {
    dicts[loc.id] = await loadLocaleDict(loc.file, loc.exportName);
  }

  const errors = [];
  const baseId = 'zh-CN';
  const baseDict = dicts[baseId];
  const baseKeys = Object.keys(baseDict);

  // 1. Key parity & empty value & placeholder parity checks
  for (const loc of LOCALES) {
    const dict = dicts[loc.id];
    const keys = Object.keys(dict);
    const keySet = new Set(keys);
    const baseSet = new Set(baseKeys);

    if (loc.id !== baseId) {
      for (const k of baseKeys) {
        if (!keySet.has(k)) {
          errors.push(`[${loc.id}] Missing translation key: "${k}"`);
        }
      }
      for (const k of keys) {
        if (!baseSet.has(k)) {
          errors.push(`[${loc.id}] Orphan key not present in ${baseId}: "${k}"`);
        }
      }
    }

    for (const k of keys) {
      const val = dict[k];
      if (typeof val !== 'string' || val.trim() === '') {
        errors.push(`[${loc.id}] Empty translation value for key: "${k}"`);
        continue;
      }
      if (loc.id !== baseId && baseDict[k]) {
        const expectedPh = extractPlaceholders(baseDict[k]);
        const actualPh = extractPlaceholders(val);
        if (JSON.stringify(expectedPh) !== JSON.stringify(actualPh)) {
          errors.push(
            `[${loc.id}] Placeholder mismatch for "${k}": expected [${expectedPh.join(', ')}], got [${actualPh.join(', ')}]`,
          );
        }
      }
    }
  }

  // 2. Scan all src/**/*.{ts,tsx} for t('key') / t("key") calls
  const tsFiles = await walkTsFiles(srcDir);
  const callRegex = /(?:^|[^.\w$])\bt\(\s*(['"])([a-zA-Z0-9_.-]+)\1/g;
  let usedKeysCount = 0;

  for (const file of tsFiles) {
    if (file.startsWith(i18nDir)) continue;
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      let match;
      callRegex.lastIndex = 0;
      while ((match = callRegex.exec(line)) !== null) {
        const key = match[2];
        usedKeysCount++;
        for (const loc of LOCALES) {
          if (!(key in dicts[loc.id])) {
            errors.push(
              `[${relative(root, file)}:${idx + 1}] Missing i18n key "${key}" in locale "${loc.id}"`,
            );
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(`i18n check FAILED with ${errors.length} error(s):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `PASS i18n check: ${baseKeys.length} keys verified across [${LOCALES.map((l) => l.id).join(', ')}] (${usedKeysCount} t() usages scanned).`,
  );
}

main().catch((err) => {
  console.error('i18n check crashed:', err);
  process.exit(1);
});
