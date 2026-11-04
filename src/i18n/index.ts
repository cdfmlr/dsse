import { createI18n } from 'vue-i18n'
import deDE from './locales/de-DE'
import enUS from './locales/en-US'
import esES from './locales/es-ES'
import frFR from './locales/fr-FR'
import jaJP from './locales/ja-JP'
import koKR from './locales/ko-KR'
import zhCN from './locales/zh-CN'

export const LOCALE_STORAGE_KEY = 'dsse:locale'
export type AppLocale =
  | 'zh-CN'
  | 'en-US'
  | 'ja-JP'
  | 'ko-KR'
  | 'es-ES'
  | 'fr-FR'
  | 'de-DE'

export const LOCALE_OPTIONS: Array<{ value: AppLocale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'es-ES', label: 'Español' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
]

const supportedLocales = LOCALE_OPTIONS.map((option) => option.value)

function readStoredLocale(): AppLocale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return supportedLocales.includes(value as AppLocale) ? (value as AppLocale) : null
  } catch {
    return null
  }
}

function detectLocale(): AppLocale {
  const stored = readStoredLocale()
  if (stored) return stored
  const language = navigator.language.toLowerCase()
  if (language.startsWith('zh')) return 'zh-CN'
  if (language.startsWith('ja')) return 'ja-JP'
  if (language.startsWith('ko')) return 'ko-KR'
  if (language.startsWith('es')) return 'es-ES'
  if (language.startsWith('fr')) return 'fr-FR'
  if (language.startsWith('de')) return 'de-DE'
  return 'en-US'
}

const initialLocale = detectLocale()
document.documentElement.lang = initialLocale

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
    'ja-JP': jaJP,
    'ko-KR': koKR,
    'es-ES': esES,
    'fr-FR': frFR,
    'de-DE': deDE,
  },
  fallbackLocale: 'en-US',
})
