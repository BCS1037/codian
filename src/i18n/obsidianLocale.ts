import { moment } from 'obsidian';

import { setLocale } from './i18n';
import type { Locale } from './types';

const OBSIDIAN_LOCALE_MAP: Readonly<Record<string, Locale>> = {
  de: 'de',
  en: 'en',
  es: 'es',
  fr: 'fr',
  ja: 'ja',
  ko: 'ko',
  pt: 'pt',
  'pt-br': 'pt',
  ru: 'ru',
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
};

export function resolveObsidianLocale(language: string): Locale {
  const normalized = language.trim().replaceAll('_', '-').toLowerCase();
  return OBSIDIAN_LOCALE_MAP[normalized] ?? 'en';
}

export function syncLocaleWithObsidian(): Locale {
  const locale = resolveObsidianLocale(moment.locale());
  setLocale(locale);
  return locale;
}
