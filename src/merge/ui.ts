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

const messages: Record<string, string> = {
  Accept: '接受',
  Append: '追加',
  Ignore: '忽略',
  'Resolve Automatically': '自动解决',
  'Accept Left Side': '接受左侧',
  'Accept Right Side': '接受右侧',
  'Resolve using Left': '用左侧解决',
  'Resolve using Right': '用右侧解决',
};

export function t(message: string, ...args: (string | number | boolean)[]) {
  return (messages[message] ?? message).replace(/\{(\d+)\}/g, (value, index) =>
    index < args.length ? String(args[index]) : value,
  );
}
