export interface MenuEntry {
  label?: string;
  icon?: string;
  shortcut?: string;
  separator?: boolean;
  checked?: boolean;
  disabled?: boolean;
  children?: MenuEntry[];
  action?: () => void;
}

const icons = import.meta.glob('./icons/*.svg', { eager: true, query: '?url', import: 'default' });

export function iconUrl(name: string, dark: boolean) {
  const file = name.slice(name.lastIndexOf('/') + 1);
  return icons[`./icons/${file}${dark ? '_dark' : ''}.svg`] as string;
}

import { t as i18nT, type I18nKey } from '../i18n';

const LEGACY_KEYS: Record<string, I18nKey> = {
  Accept: 'merge.accept',
  Append: 'merge.append',
  Ignore: 'merge.ignore',
  Resolve: 'merge.resolve',
  'Resolve Automatically': 'merge.resolveAutomatically',
  'Accept Left Side': 'merge.acceptLeftSide',
  'Accept Right Side': 'merge.acceptRightSide',
  'Resolve using Left': 'merge.resolveUsingLeft',
  'Resolve using Right': 'merge.resolveUsingRight',
  'Compare with Clipboard': 'merge.compareWithClipboard',
  'Collapse Unchanged Fragments': 'merge.collapseUnchanged',
  'Synchronize Scrolling': 'merge.syncScrolling',
  'Click to expand': 'merge.clickToExpand',
  '{0}\nCtrl+click to resolve conflict': 'merge.ctrlClickToResolve',
};

export function t(message: string, ...args: (string | number | boolean)[]) {
  const mapped = LEGACY_KEYS[message];
  const resolved = mapped ? i18nT(mapped) : message;
  return resolved.replace(/\{(\d+)\}/g, (value, index) =>
    index < args.length ? String(args[index]) : value,
  );
}
