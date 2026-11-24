import { useEffect, useState } from 'preact/hooks';
import { setMinimapEnabled } from '../ui/editor-preferences';

export type ThemeMode = 'dark' | 'light' | 'system';
export type DensityMode = 'comfortable' | 'compact';
export type UpdateStrategy = 'ff-only' | 'rebase' | 'merge';
export type UpdateAutoClean = 'shelf' | 'stash' | 'none';

export interface AppSettings {
  theme: ThemeMode;
  density: DensityMode;
  editorFontSize: number;
  editorLineHeight: number;
  minimap: boolean;
  inlineBlame: boolean;
  diffSyncScroll: boolean;
  wordDiffHighlights: boolean;
  externalEditorCommand: string;
  updateStrategy: UpdateStrategy;
  updateAutoClean: UpdateAutoClean;
  cloneParent: string;
  workspaceScanDepth: number;
  logDiffPreview: boolean;
  groupFilesByDir: boolean;
  groupBranchesByDir: boolean;
  updaterAutoCheck: boolean;
  updaterAutoDownload: boolean;
}

export type SettingKey = keyof AppSettings;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  density: 'comfortable',
  editorFontSize: 12,
  editorLineHeight: 20,
  minimap: false,
  inlineBlame: false,
  diffSyncScroll: true,
  wordDiffHighlights: true,
  externalEditorCommand: '',
  updateStrategy: 'ff-only',
  updateAutoClean: 'shelf',
  cloneParent: '',
  workspaceScanDepth: 4,
  logDiffPreview: false,
  groupFilesByDir: false,
  groupBranchesByDir: false,
  updaterAutoCheck: true,
  updaterAutoDownload: false,
};

const STORAGE_KEYS: Record<SettingKey, string> = {
  theme: 'theme',
  density: 'ui.density',
  editorFontSize: 'editor.fontSize',
  editorLineHeight: 'editor.lineHeight',
  minimap: 'editor.minimap.enabled',
  inlineBlame: 'diff.inlineBlame',
  diffSyncScroll: 'diff.syncScroll',
  wordDiffHighlights: 'diff.wordHighlights',
  externalEditorCommand: 'editor.externalCommand',
  updateStrategy: 'workflow.updateStrategy',
  updateAutoClean: 'workflow.updateAutoClean',
  cloneParent: 'clone.parent',
  workspaceScanDepth: 'workspace.scanDepth',
  logDiffPreview: 'log.diffPreview',
  groupFilesByDir: 'changes.groupByDir',
  groupBranchesByDir: 'branch.groupByDir',
  updaterAutoCheck: 'updater.autoCheck',
  updaterAutoDownload: 'updater.autoDownload',
};

const SETTINGS_EVENT = 'ideagittool-settings-changed';

function parseStored<K extends SettingKey>(key: K, raw: string | null): AppSettings[K] {
  if (raw === null) return DEFAULT_SETTINGS[key];
  if (key === 'minimap') {
    return (raw === 'true') as AppSettings[K];
  }
  try {
    const parsed = JSON.parse(raw);
    switch (key) {
      case 'theme':
        return (parsed === 'dark' || parsed === 'light' || parsed === 'system'
          ? parsed
          : DEFAULT_SETTINGS.theme) as AppSettings[K];
      case 'density':
        return (parsed === 'compact' || parsed === 'comfortable'
          ? parsed
          : DEFAULT_SETTINGS.density) as AppSettings[K];
      case 'editorFontSize': {
        const n = Number(parsed);
        return (Number.isFinite(n) && n >= 11 && n <= 18
          ? Math.round(n)
          : DEFAULT_SETTINGS.editorFontSize) as AppSettings[K];
      }
      case 'editorLineHeight': {
        const n = Number(parsed);
        return (Number.isFinite(n) && n >= 16 && n <= 28
          ? Math.round(n)
          : DEFAULT_SETTINGS.editorLineHeight) as AppSettings[K];
      }
      case 'workspaceScanDepth': {
        const n = Number(parsed);
        return (Number.isInteger(n) && n >= 0 && n <= 8
          ? n
          : DEFAULT_SETTINGS.workspaceScanDepth) as AppSettings[K];
      }
      case 'updateStrategy':
        return (parsed === 'ff-only' || parsed === 'rebase' || parsed === 'merge'
          ? parsed
          : DEFAULT_SETTINGS.updateStrategy) as AppSettings[K];
      case 'updateAutoClean':
        return (parsed === 'shelf' || parsed === 'stash' || parsed === 'none'
          ? parsed
          : DEFAULT_SETTINGS.updateAutoClean) as AppSettings[K];
      case 'externalEditorCommand':
      case 'cloneParent':
        return (typeof parsed === 'string' ? parsed : '') as AppSettings[K];
      default:
        return (typeof parsed === 'boolean' ? parsed : DEFAULT_SETTINGS[key]) as AppSettings[K];
    }
  } catch {
    if (key === 'theme' && (raw === 'dark' || raw === 'light' || raw === 'system')) {
      return raw as AppSettings[K];
    }
    return DEFAULT_SETTINGS[key];
  }
}

export function getSetting<K extends SettingKey>(key: K): AppSettings[K] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEYS[key]) ?? null;
    return parseStored(key, raw);
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

export function getAllSettings(): AppSettings {
  return {
    theme: getSetting('theme'),
    density: getSetting('density'),
    editorFontSize: getSetting('editorFontSize'),
    editorLineHeight: getSetting('editorLineHeight'),
    minimap: getSetting('minimap'),
    inlineBlame: getSetting('inlineBlame'),
    diffSyncScroll: getSetting('diffSyncScroll'),
    wordDiffHighlights: getSetting('wordDiffHighlights'),
    externalEditorCommand: getSetting('externalEditorCommand'),
    updateStrategy: getSetting('updateStrategy'),
    updateAutoClean: getSetting('updateAutoClean'),
    cloneParent: getSetting('cloneParent'),
    workspaceScanDepth: getSetting('workspaceScanDepth'),
    logDiffPreview: getSetting('logDiffPreview'),
    groupFilesByDir: getSetting('groupFilesByDir'),
    groupBranchesByDir: getSetting('groupBranchesByDir'),
    updaterAutoCheck: getSetting('updaterAutoCheck'),
    updaterAutoDownload: getSetting('updaterAutoDownload'),
  };
}

export function setSetting<K extends SettingKey>(key: K, value: AppSettings[K]): void {
  if (key === 'minimap') {
    setMinimapEnabled(Boolean(value));
  } else {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEYS[key], JSON.stringify(value));
    } catch {
      // Storage unavailable in restricted context
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new window.CustomEvent(SETTINGS_EVENT, { detail: { key, value } }));
  }
}

export function resetAllSettings(): void {
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    setSetting(key, DEFAULT_SETTINGS[key]);
  }
}

export function useSetting<K extends SettingKey>(
  key: K,
): [AppSettings[K], (value: AppSettings[K]) => void] {
  const [value, setValue] = useState<AppSettings[K]>(() => getSetting(key));
  useEffect(() => {
    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: SettingKey }>).detail;
      if (!detail || detail.key === key) {
        setValue(getSetting(key));
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEYS[key]) {
        setValue(getSetting(key));
      }
    };
    const onMinimap = () => {
      if (key === 'minimap') setValue(getSetting(key));
    };
    window.addEventListener(SETTINGS_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    if (key === 'minimap') window.addEventListener('editor-minimap-changed', onMinimap);
    setValue(getSetting(key));
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
      if (key === 'minimap') window.removeEventListener('editor-minimap-changed', onMinimap);
    };
  }, [key]);
  return [value, (next: AppSettings[K]) => setSetting(key, next)];
}

export function resolveEffectiveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applySettingsToDocument(settings: Pick<
  AppSettings,
  'theme' | 'density' | 'editorFontSize' | 'editorLineHeight' | 'wordDiffHighlights'
>) {
  if (typeof document === 'undefined') return;
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  document.body.classList.toggle('ij-dark', effectiveTheme === 'dark');
  document.body.classList.toggle('ij-light', effectiveTheme === 'light');
  document.body.classList.toggle('no-word-diff', !settings.wordDiffHighlights);
  document.body.dataset.density = settings.density;
  document.documentElement.style.setProperty('--editor-font-size', `${settings.editorFontSize}px`);
  document.documentElement.style.setProperty(
    '--editor-line-height',
    `${settings.editorLineHeight}px`,
  );
}
