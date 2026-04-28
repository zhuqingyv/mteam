import { useCallback, useEffect, useState } from 'react';
import zhCN, { type TranslationKey } from './locales/zh-CN';
import en from './locales/en';
import zhTW from './locales/zh-TW';

export type Locale = 'zh-CN' | 'en' | 'zh-TW';

export const SUPPORTED_LOCALES: Locale[] = ['zh-CN', 'en', 'zh-TW'];
const STORAGE_KEY = 'mteam.locale';
const LOCALE_EVENT = 'mteam:locale-change';

const TABLES: Record<Locale, Partial<Record<TranslationKey, string>>> = {
  'zh-CN': zhCN,
  en,
  'zh-TW': zhTW,
};

function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'zh-CN';
  const raw = (navigator.language || '').toLowerCase();
  if (raw.startsWith('zh')) {
    if (raw.includes('tw') || raw.includes('hk') || raw.includes('hant')) return 'zh-TW';
    return 'zh-CN';
  }
  if (raw.startsWith('en')) return 'en';
  return 'zh-CN';
}

function readStoredLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && (SUPPORTED_LOCALES as string[]).includes(v)) return v as Locale;
  } catch {
    /* ignore */
  }
  return null;
}

function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? detectSystemLocale();
}

export function formatMessage(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = params[k];
    return v === undefined ? `{${k}}` : String(v);
  });
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const primary = TABLES[locale]?.[key];
  if (primary !== undefined) return formatMessage(primary, params);
  const fallback = TABLES['zh-CN'][key];
  if (fallback !== undefined) return formatMessage(fallback, params);
  return key;
}

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(() => resolveInitialLocale());

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<Locale>;
      if (ce.detail && (SUPPORTED_LOCALES as string[]).includes(ce.detail)) {
        setLocaleState(ce.detail);
      }
    };
    window.addEventListener(LOCALE_EVENT, handler as EventListener);
    return () => window.removeEventListener(LOCALE_EVENT, handler as EventListener);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    if (!(SUPPORTED_LOCALES as string[]).includes(next)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent<Locale>(LOCALE_EVENT, { detail: next }));
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  );

  return { locale, setLocale, t };
}

export type { TranslationKey };
