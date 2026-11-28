export type LocaleType = 'zh-CN' | 'zh-TW' | 'en';

export interface LocaleOption {
  value: LocaleType;
  label: string;
}

export const LOCALE_OPTIONS: LocaleOption[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];
