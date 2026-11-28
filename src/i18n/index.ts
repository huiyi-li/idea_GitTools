import { useEffect, useState } from 'preact/hooks';
import { messagesZhCN, type I18nKey } from './messages.zh-CN';
import { messagesZhTW } from './messages.zh-TW';
import { messagesEn } from './messages.en';
import { LOCALE_OPTIONS, type LocaleType } from './types';

export type { I18nKey, LocaleType };
export { LOCALE_OPTIONS };

const STORAGE_KEY = 'ui.locale';
const LOCALE_EVENT = 'ideagittool-locale-changed';

const MESSAGES: Record<LocaleType, Record<I18nKey, string>> = {
  'zh-CN': messagesZhCN,
  'zh-TW': messagesZhTW,
  en: messagesEn,
};

export function normalizeLocale(raw: unknown): LocaleType {
  if (raw === 'zh-TW' || raw === 'zh-Hant') return 'zh-TW';
  if (raw === 'en') return 'en';
  return 'zh-CN';
}

function readStoredLocale(): LocaleType {
  if (typeof localStorage === 'undefined') return 'zh-CN';
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return 'zh-CN';
  try {
    return normalizeLocale(JSON.parse(raw));
  } catch {
    return normalizeLocale(raw);
  }
}

let currentLocale: LocaleType = readStoredLocale();

export function getLocale(): LocaleType {
  return currentLocale;
}

export function setLocale(next: LocaleType): void {
  const normalized = normalizeLocale(next);
  currentLocale = normalized;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang =
      normalized === 'zh-TW' ? 'zh-Hant' : normalized === 'en' ? 'en' : 'zh-Hans';
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new window.CustomEvent(LOCALE_EVENT, { detail: normalized }));
  }
}

export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const dict = MESSAGES[currentLocale] ?? messagesZhCN;
  let template = dict[key] ?? messagesZhCN[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replaceAll(`{${k}}`, String(v));
    }
  }
  return template;
}

export function useI18n() {
  const [locale, setLocalState] = useState<LocaleType>(currentLocale);

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<LocaleType>).detail;
      setLocalState(detail ?? readStoredLocale());
    };
    window.addEventListener(LOCALE_EVENT, onChange);
    return () => window.removeEventListener(LOCALE_EVENT, onChange);
  }, []);

  return {
    locale,
    setLocale,
    t,
  };
}
