import { createI18n } from 'vue-i18n'
import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'

export const LOCALE_STORAGE_KEY = 'dsse:locale'
export type AppLocale = 'zh-CN' | 'en-US'

const supportedLocales: AppLocale[] = ['zh-CN', 'en-US']

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
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

const initialLocale = detectLocale()
document.documentElement.lang = initialLocale

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
})
