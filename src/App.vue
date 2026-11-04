<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDownUp,
  ArrowUpRight,
  BookOpenText,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  Globe2,
  History,
  KeyRound,
  Languages,
  LoaderCircle,
  PanelRightOpen,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Telescope,
  Trash2,
  X,
} from 'lucide-vue-next'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { LOCALE_STORAGE_KEY, type AppLocale } from './i18n'
import type {
  ApiErrorShape,
  FetchResponse,
  Language,
  SearchFilters,
  SearchResult,
  SearchResponse,
  SortMode,
  TimeRange,
} from './types'

const apiBase = (
  (import.meta.env.VITE_DEEPSEEK_API_BASE as string | undefined) || 'https://api.deepseek.com'
).replace(/\/$/, '')

const KEY_STORAGE = 'sift:api-key'
const HISTORY_STORAGE = 'sift:history'
const SESSION_CACHE = 'sift:search-cache'
const FETCH_CACHE = 'sift:fetch-cache'
const MAX_HISTORY = 6
const SEARCH_LIMIT = 128
const QUICK_SEARCH_KEYS = [
  'quickSearches.physics',
  'quickSearches.deepseekRelease',
  'quickSearches.vueFeatures',
] as const

const { t, locale } = useI18n()

type StorageKind = 'local' | 'session'

function getStorage(kind: StorageKind): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

function readStorage(kind: StorageKind, key: string) {
  try {
    return getStorage(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(kind: StorageKind, key: string, value: string) {
  try {
    const storage = getStorage(kind)
    if (!storage) return false
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function removeStorage(kind: StorageKind, key: string) {
  try {
    getStorage(kind)?.removeItem(key)
  } catch {
    // Best-effort cleanup only; blocked storage must not affect the app.
  }
}

const query = ref('')
const submittedQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const status = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const results = ref<SearchResult[]>([])
const errorMessage = ref('')
const elapsed = ref(0)
const isCached = ref(false)
const sortMode = ref<SortMode>('relevance')
const settingsOpen = ref(false)
const guideOpen = ref(false)
const filtersOpen = ref(false)
const selectedResult = ref<SearchResult | null>(null)
const settingsDialog = ref<HTMLElement | null>(null)
const guideDialog = ref<HTMLElement | null>(null)
const resultDialog = ref<HTMLElement | null>(null)
const failedSiteIcons = reactive(new Set<string>())
const fetchStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const fetchError = ref('')
const fetchedContent = ref('')
const fetchedTitle = ref('')
const toast = ref('')
const draftKey = ref('')
const apiKey = ref(readStorage('local', KEY_STORAGE) || '')
const history = ref<Array<{ query: string; at: number }>>(readHistory())

const filters = reactive<SearchFilters>({
  time: 'any',
  language: 'auto',
  site: '',
  count: 10,
  needContent: false,
})

let controller: AbortController | null = null
let fetchController: AbortController | null = null
let toastTimer: number | null = null
type DialogKind = 'settings' | 'guide' | 'result'
const dialogReturnFocus = new Map<DialogKind, HTMLElement | null>()

const hasSearched = computed(() => submittedQuery.value.trim().length > 0)
const sortedResults = computed(() => {
  if (sortMode.value === 'relevance') return results.value
  return [...results.value].sort((a, b) => {
    const aTime = a.date ? new Date(a.date).getTime() : 0
    const bTime = b.date ? new Date(b.date).getTime() : 0
    return bTime - aTime
  })
})
const activeFilterCount = computed(
  () =>
    Number(filters.time !== 'any') +
    Number(filters.language !== 'auto') +
    Number(filters.site.trim().length > 0) +
    Number(filters.needContent),
)
const keyLabel = computed(() => t(apiKey.value ? 'account.connected' : 'account.connect'))
const connectionLabel = computed(() =>
  t(apiKey.value ? 'account.ready' : 'account.connectToStart'),
)
const isEnglish = computed(() => locale.value === 'en-US')
const localeToggleLabel = computed(() => (isEnglish.value ? '中文' : 'EN'))
const localeAriaLabel = computed(() =>
  t(isEnglish.value ? 'locale.switchToChinese' : 'locale.switchToEnglish'),
)
const quickSearches = computed(() => QUICK_SEARCH_KEYS.map((key) => t(key)))
const resultHeading = computed(() => {
  if (status.value === 'loading') return t('results.heading.loading')
  if (status.value === 'error') return t('results.heading.error')
  if (!results.value.length) return t('results.heading.empty')
  return t('results.heading.count', {
    query: submittedQuery.value,
    count: results.value.length,
  })
})
const renderedContent = computed(() => {
  const page = selectedResult.value
  if (!page) return ''
  const raw =
    fetchedContent.value ||
    page.content ||
    page.summary ||
    page.snippet ||
    t('drawer.noPreview')
  const html = marked.parse(raw, { async: false })
  return DOMPurify.sanitize(String(html))
})
const hasFullContent = computed(
  () => Boolean(fetchedContent.value || selectedResult.value?.content),
)
const contentSource = computed(() => {
  if (fetchedContent.value || selectedResult.value?.content) return t('drawer.fullContent')
  return t('drawer.summary')
})

const timeOptions = computed<Array<{ value: TimeRange; label: string }>>(() => [
  { value: 'any', label: t('filters.time.any') },
  { value: 'day', label: t('filters.time.day') },
  { value: 'week', label: t('filters.time.week') },
  { value: 'month', label: t('filters.time.month') },
  { value: 'year', label: t('filters.time.year') },
])

const languageOptions = computed<Array<{ value: Language; label: string }>>(() => [
  { value: 'auto', label: t('filters.language.auto') },
  { value: 'zh', label: t('filters.language.zh') },
  { value: 'en', label: t('filters.language.en') },
])

function toggleLocale() {
  const next: AppLocale = isEnglish.value ? 'zh-CN' : 'en-US'
  locale.value = next
}

watch(
  locale,
  (value) => {
    document.documentElement.lang = value
    document.title = t('meta.title')
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', t('meta.description'))
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, value)
    } catch {
      // Locale persistence is best-effort; switching still works for this visit.
    }
  },
  { immediate: true },
)

function readHistory(): Array<{ query: string; at: number }> {
  try {
    const value = JSON.parse(readStorage('local', HISTORY_STORAGE) || '[]')
    return Array.isArray(value) ? value.slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

function showToast(message: string) {
  toast.value = message
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
  }, 2400)
}

function rememberDialogFocus(kind: DialogKind) {
  const active = document.activeElement
  dialogReturnFocus.set(kind, active instanceof HTMLElement ? active : null)
}

function focusDialog(kind: DialogKind) {
  rememberDialogFocus(kind)
  nextTick(() => activeDialogElement()?.focus())
}

function restoreDialogFocus(kind: DialogKind) {
  const target = dialogReturnFocus.get(kind)
  dialogReturnFocus.delete(kind)
  nextTick(() => {
    if (target?.isConnected) target.focus()
  })
}

function activeDialogElement() {
  if (settingsOpen.value) return settingsDialog.value
  if (guideOpen.value) return guideDialog.value
  if (selectedResult.value) return resultDialog.value
  return null
}

function handleDialogTab(event: KeyboardEvent) {
  const dialog = activeDialogElement()
  if (!dialog) return

  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null)

  if (!focusable.length) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  const focusIsOutside = !dialog.contains(active)

  if (event.shiftKey && (active === first || active === dialog || focusIsOutside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || focusIsOutside)) {
    event.preventDefault()
    first.focus()
  }
}

function focusSearch() {
  nextTick(() => searchInput.value?.focus())
}

function submitSearch() {
  if (!query.value.trim()) {
    focusSearch()
    return
  }
  void runSearch(query.value)
}

function searchQuick(term: string) {
  query.value = term
  void runSearch(term)
}

function formatDateOffset(days: number) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function snapshotFilters(): SearchFilters {
  return {
    time: filters.time,
    language: filters.language,
    site: filters.site,
    count: filters.count,
    needContent: filters.needContent,
  }
}

function buildApiQuery(base: string, options: SearchFilters) {
  const parts = [base.trim()]
  if (options.language !== 'auto') parts.push(`lang:${options.language}`)
  const site = options.site.trim().replace(/^site:/, '')
  if (site) parts.push(`site:${site}`)

  const offsets: Record<TimeRange, number | null> = {
    any: null,
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  }
  const days = offsets[options.time]
  if (days) parts.push(`after:${formatDateOffset(days)}`)
  return parts.join(' ')
}

function shortHash(value: string) {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

interface SearchRequestOptions {
  count: number
  needContent: boolean
}

function searchCacheSignature(apiQuery: string, options: SearchRequestOptions) {
  return JSON.stringify([apiQuery, options.count, options.needContent])
}

function readCache(apiQuery: string, options: SearchRequestOptions) {
  try {
    const cache = JSON.parse(readStorage('session', SESSION_CACHE) || '{}') as Record<
      string,
      { results: SearchResult[]; at: number }
    >
    return cache[shortHash(searchCacheSignature(apiQuery, options))] || null
  } catch {
    return null
  }
}

function writeCache(apiQuery: string, options: SearchRequestOptions, value: SearchResult[]) {
  if (options.needContent) return
  try {
    const cache = JSON.parse(readStorage('session', SESSION_CACHE) || '{}') as Record<
      string,
      { results: SearchResult[]; at: number }
    >
    const entries = Object.entries(cache).sort(([, a], [, b]) => b.at - a.at).slice(0, 4)
    const trimmed = Object.fromEntries(entries)
    trimmed[shortHash(searchCacheSignature(apiQuery, options))] = {
      results: value,
      at: Date.now(),
    }
    writeStorage('session', SESSION_CACHE, JSON.stringify(trimmed))
  } catch {
    // A full or unavailable session store should never block a search.
  }
}

function readFetchCache(url: string) {
  try {
    const cache = JSON.parse(readStorage('session', FETCH_CACHE) || '{}') as Record<
      string,
      { title: string; content: string; at: number }
    >
    return cache[shortHash(url)] || null
  } catch {
    return null
  }
}

function writeFetchCache(url: string, title: string, content: string) {
  try {
    const cache = JSON.parse(readStorage('session', FETCH_CACHE) || '{}') as Record<
      string,
      { title: string; content: string; at: number }
    >
    const entries = Object.entries(cache).sort(([, a], [, b]) => b.at - a.at).slice(0, 2)
    const trimmed = Object.fromEntries(entries)
    trimmed[shortHash(url)] = { title, content, at: Date.now() }
    writeStorage('session', FETCH_CACHE, JSON.stringify(trimmed))
  } catch {
    // Fetching should still work if browser storage is full or unavailable.
  }
}

function saveHistory(term: string) {
  const next = [
    { query: term, at: Date.now() },
    ...history.value.filter((item) => item.query !== term),
  ].slice(0, MAX_HISTORY)
  history.value = next
  writeStorage('local', HISTORY_STORAGE, JSON.stringify(next))
}

const SEARCH_PARAM_KEYS = ['q', 'time', 'lang', 'site', 'count', 'content'] as const

function writeSearchParams(url: URL, term: string, options: SearchFilters) {
  url.searchParams.set('q', term)

  if (options.time === 'any') url.searchParams.delete('time')
  else url.searchParams.set('time', options.time)

  if (options.language === 'auto') url.searchParams.delete('lang')
  else url.searchParams.set('lang', options.language)

  const site = options.site.trim()
  if (site) url.searchParams.set('site', site)
  else url.searchParams.delete('site')

  if (options.count === 10) url.searchParams.delete('count')
  else url.searchParams.set('count', String(options.count))

  if (options.needContent) url.searchParams.set('content', '1')
  else url.searchParams.delete('content')
}

function updateUrl(term: string, options: SearchFilters) {
  const url = new URL(window.location.href)
  writeSearchParams(url, term, options)
  window.history.replaceState({}, '', url)
}

function restoreFiltersFromUrl(url: URL) {
  const time = url.searchParams.get('time')
  if (timeOptions.value.some((option) => option.value === time)) {
    filters.time = time as TimeRange
  }

  const language = url.searchParams.get('lang')
  if (languageOptions.value.some((option) => option.value === language)) {
    filters.language = language as Language
  }

  filters.site = url.searchParams.get('site') || ''

  const count = Number(url.searchParams.get('count'))
  if ([5, 10, 15, 20].includes(count)) filters.count = count
  filters.needContent = url.searchParams.get('content') === '1'
}

function openResult(result: SearchResult) {
  fetchController?.abort()
  selectedResult.value = result
  fetchStatus.value = 'idle'
  fetchError.value = ''
  fetchedContent.value = ''
  fetchedTitle.value = ''

  const cached = readFetchCache(result.url)
  if (cached) {
    fetchedTitle.value = cached.title
    fetchedContent.value = cached.content
    fetchStatus.value = 'success'
  }
  focusDialog('result')
}

function closeResult(restoreFocus = true) {
  fetchController?.abort()
  selectedResult.value = null
  fetchStatus.value = 'idle'
  fetchError.value = ''
  if (restoreFocus) restoreDialogFocus('result')
  else dialogReturnFocus.delete('result')
}

async function fetchResultContent() {
  const page = selectedResult.value
  if (!page || fetchStatus.value === 'loading') return
  if (!apiKey.value) {
    openSettings()
    showToast(t('toasts.configureKey'))
    return
  }

  const cached = readFetchCache(page.url)
  if (cached) {
    fetchedTitle.value = cached.title
    fetchedContent.value = cached.content
    fetchStatus.value = 'success'
    showToast(t('toasts.cachedContent'))
    return
  }

  fetchController?.abort()
  fetchController = new AbortController()
  fetchStatus.value = 'loading'
  fetchError.value = ''

  try {
    const response = await fetch(`${apiBase}/v1/tools/fetch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: page.url }),
      signal: fetchController.signal,
    })

    const payload = (await response.json().catch(() => ({}))) as Partial<FetchResponse> &
      ApiErrorShape
    if (!response.ok) {
      const friendly: Record<number, string> = {
        400: t('errors.fetch.400'),
        401: t('errors.fetch.401'),
        402: t('errors.fetch.402'),
        403: t('errors.fetch.403'),
        404: t('errors.fetch.404'),
        408: t('errors.fetch.408'),
        413: t('errors.fetch.413'),
        429: t('errors.fetch.429'),
        500: t('errors.fetch.500'),
        504: t('errors.fetch.504'),
      }
      throw new Error(
        friendly[response.status] ||
          t('errors.fetch.unknown', { status: response.status }),
      )
    }

    if (typeof payload.content !== 'string' || !payload.content.trim()) {
      throw new Error(t('errors.fetch.emptyContent'))
    }
    if (selectedResult.value?.url !== page.url) return

    fetchedTitle.value = payload.title || page.title
    fetchedContent.value = payload.content
    fetchStatus.value = 'success'
    writeFetchCache(page.url, fetchedTitle.value, payload.content)
    showToast(t('toasts.contentReady'))
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    fetchError.value =
      error instanceof TypeError
        ? t('errors.fetch.network')
        : error instanceof Error
          ? error.message
          : t('errors.fetch.fallback')
    fetchStatus.value = 'error'
  }
}

async function runSearch(term: string) {
  const clean = term.trim()
  if (!clean) {
    focusSearch()
    return
  }
  if (!apiKey.value) {
    openSettings()
    showToast(t('toasts.configureKey'))
    return
  }

  const requestFilters = snapshotFilters()
  const apiQuery = buildApiQuery(clean, requestFilters)
  if (apiQuery.length > SEARCH_LIMIT) {
    errorMessage.value = t('errors.queryTooLong', { limit: SEARCH_LIMIT })
    status.value = 'error'
    submittedQuery.value = clean
    return
  }

  query.value = clean
  submittedQuery.value = clean
  updateUrl(clean, requestFilters)
  saveHistory(clean)
  closeResult(false)
  filtersOpen.value = false
  isCached.value = false

  controller?.abort()
  controller = null
  const cached = readCache(apiQuery, requestFilters)
  if (cached) {
    results.value = cached.results
    elapsed.value = 0
    status.value = 'success'
    isCached.value = true
    return
  }

  controller = new AbortController()
  status.value = 'loading'
  results.value = []
  errorMessage.value = ''
  const startedAt = performance.now()

  try {
    const response = await fetch(`${apiBase}/v1/tools/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: apiQuery,
        count: requestFilters.count,
        need_content: requestFilters.needContent,
      }),
      signal: controller.signal,
    })

    const payload = (await response.json().catch(() => ({}))) as SearchResponse & ApiErrorShape
    if (!response.ok) {
      const friendly: Record<number, string> = {
        400: t('errors.search.400'),
        401: t('errors.search.401'),
        402: t('errors.search.402'),
        403: t('errors.search.403'),
        408: t('errors.search.408'),
        413: t('errors.search.413'),
        429: t('errors.search.429'),
        500: t('errors.search.500'),
        504: t('errors.search.504'),
      }
      throw new Error(friendly[response.status] || t('errors.search.unknown'))
    }

    if (!Array.isArray(payload.results)) {
      throw new Error(t('errors.search.invalidResponse'))
    }

    results.value = payload.results
    elapsed.value = Math.max(0.01, (performance.now() - startedAt) / 1000)
    status.value = 'success'
    writeCache(apiQuery, requestFilters, payload.results)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    errorMessage.value =
      error instanceof TypeError
        ? t('errors.search.network')
        : error instanceof Error
          ? error.message
          : t('errors.search.fallback')
    status.value = 'error'
  }
}

function goHome() {
  controller?.abort()
  submittedQuery.value = ''
  status.value = 'idle'
  results.value = []
  errorMessage.value = ''
  closeResult(false)
  const url = new URL(window.location.href)
  SEARCH_PARAM_KEYS.forEach((key) => url.searchParams.delete(key))
  window.history.replaceState({}, '', url)
  focusSearch()
}

function openSettings() {
  draftKey.value = apiKey.value
  settingsOpen.value = true
  focusDialog('settings')
}

function closeSettings() {
  settingsOpen.value = false
  restoreDialogFocus('settings')
}

function openGuide() {
  guideOpen.value = true
  focusDialog('guide')
}

function closeGuide() {
  guideOpen.value = false
  restoreDialogFocus('guide')
}

function saveKey() {
  const next = draftKey.value.trim()
  apiKey.value = next
  closeSettings()
  if (!next) {
    removeStorage('local', KEY_STORAGE)
    showToast(t('toasts.keyRemoved'))
    return
  }

  const saved = writeStorage('local', KEY_STORAGE, next)
  showToast(t(saved ? 'toasts.keySaved' : 'toasts.keySessionOnly'))
}

function clearLocalKey() {
  draftKey.value = ''
  apiKey.value = ''
  removeStorage('local', KEY_STORAGE)
  showToast(t('toasts.keyRemoved'))
}

function resetFilters() {
  filters.time = 'any'
  filters.language = 'auto'
  filters.site = ''
  filters.count = 10
  filters.needContent = false
}

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function markSiteIconFailed(url: string | null) {
  if (url) failedSiteIcons.add(url)
}

function formatResultDate(value: string | null) {
  if (!value) return t('errors.dateUnknown')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('errors.dateUnknown')
  return new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function authorityLabel(authority: number) {
  return authority >= 3 ? t('results.card.trustedSource') : ''
}

function relevanceLabel(score: number) {
  if (score >= 2) return t('results.card.relevanceHigh')
  if (score >= 1.5) return t('results.card.relevance')
  if (score > 0) return t('results.card.relevancePartial')
  return ''
}

async function copyShareLink() {
  try {
    const term = query.value.trim() || submittedQuery.value
    const url = new URL(window.location.href)
    if (term) writeSearchParams(url, term, snapshotFilters())
    await navigator.clipboard.writeText(url.toString())
    showToast(t('toasts.shareCopied'))
  } catch {
    showToast(t('toasts.copyFailed'))
  }
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  const isTyping =
    target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable

  if (event.key === 'Tab') {
    handleDialogTab(event)
    return
  }

  if (event.key === 'Escape') {
    if (settingsOpen.value) closeSettings()
    else if (guideOpen.value) closeGuide()
    else if (selectedResult.value) closeResult()
    else if (filtersOpen.value) filtersOpen.value = false
    return
  }

  const dialogOpen = Boolean(settingsOpen.value || guideOpen.value || selectedResult.value)
  if (
    !isTyping &&
    !dialogOpen &&
    (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key === 'k'))
  ) {
    event.preventDefault()
    focusSearch()
  }
}

onMounted(() => {
  const initialUrl = new URL(window.location.href)
  restoreFiltersFromUrl(initialUrl)
  const initialQuery = initialUrl.searchParams.get('q')
  if (initialQuery) query.value = initialQuery
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  controller?.abort()
  fetchController?.abort()
  window.removeEventListener('keydown', handleKeydown)
  if (toastTimer) window.clearTimeout(toastTimer)
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar" :class="{ 'topbar--compact': hasSearched }">
      <button class="brand" type="button" :aria-label="t('app.backHome')" @click="goHome">
        <span class="brand__mark" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
        </span>
        <span class="brand__word">{{ t('app.brand') }}</span>
        <span class="brand__latin">DSSE</span>
      </button>

      <div class="topbar__meta">
        <span class="powered-pill"><Sparkles :size="13" /> {{ t('app.powered') }}</span>
        <span class="connection" :class="{ 'connection--ready': apiKey }">
          <span></span>{{ connectionLabel }}
        </span>
      </div>

      <div class="topbar__actions">
        <button
          class="locale-button"
          type="button"
          :aria-label="localeAriaLabel"
          @click="toggleLocale"
        >
          <Languages :size="15" />
          <span>{{ localeToggleLabel }}</span>
        </button>
        <button class="icon-button" type="button" :aria-label="t('app.viewGuide')" @click="openGuide">
          <BookOpenText :size="18" />
        </button>
        <button class="key-button" type="button" :aria-label="t('app.accountSettings')" @click="openSettings">
          <KeyRound :size="16" />
          <span>{{ keyLabel }}</span>
        </button>
      </div>
    </header>

    <main v-if="!hasSearched" class="landing">
      <div class="landing__ornament" aria-hidden="true">
        <span>{{ t('landing.ornamentFirst') }}</span>
        <span>{{ t('landing.ornamentSecond') }}</span>
      </div>

      <section class="hero">
        <p class="eyebrow"><span></span> {{ t('landing.eyebrow') }}</p>
        <h1>{{ t('landing.titleStart') }}<br /><em>{{ t('landing.titleAccent') }}</em></h1>
        <p class="hero__intro">
          {{ t('landing.introLine1') }}<br class="desktop-break" />
          {{ t('landing.introLine2') }}
        </p>

        <form class="hero-search" @submit.prevent="submitSearch">
          <Search class="hero-search__icon" :size="22" />
          <input
            ref="searchInput"
            v-model="query"
            type="search"
            autocomplete="off"
            spellcheck="false"
            maxlength="128"
            :placeholder="t('landing.searchPlaceholder')"
            :aria-label="t('app.search')"
          />
          <span class="hero-search__hint"><kbd>/</kbd></span>
          <button type="submit" :aria-label="t('app.startSearch')">
            <span>{{ t('app.brand') }}</span>
            <ArrowUpRight :size="18" />
          </button>
        </form>

        <div class="quick-row">
          <span>{{ t('landing.try') }}</span>
          <button
            v-for="term in quickSearches"
            :key="term"
            type="button"
            @click="searchQuick(term)"
          >
            {{ term }}
          </button>
        </div>
      </section>

      <section class="landing__lower">
        <div class="feature-card feature-card--accent">
          <span class="feature-card__number">01</span>
          <Sparkles :size="20" />
          <h2>{{ t('landing.features.search.title') }}</h2>
          <p>{{ t('landing.features.search.body') }}</p>
        </div>
        <div class="feature-card">
          <span class="feature-card__number">02</span>
          <SlidersHorizontal :size="20" />
          <h2>{{ t('landing.features.narrow.title') }}</h2>
          <p>{{ t('landing.features.narrow.body') }}</p>
        </div>
        <div class="feature-card">
          <span class="feature-card__number">03</span>
          <ShieldCheck :size="20" />
          <h2>{{ t('landing.features.cost.title') }}</h2>
          <p>{{ t('landing.features.cost.body') }}</p>
        </div>
      </section>

      <div v-if="history.length" class="recent-strip">
        <div class="recent-strip__title"><History :size="16" /> {{ t('landing.recent') }}</div>
        <div class="recent-strip__items">
          <button
            v-for="item in history.slice(0, 4)"
            :key="`${item.query}-${item.at}`"
            type="button"
            @click="searchQuick(item.query)"
          >
            {{ item.query }} <ArrowUpRight :size="13" />
          </button>
        </div>
      </div>
    </main>

    <main v-else class="results-page">
      <section class="results-top">
        <form class="compact-search" @submit.prevent="submitSearch">
          <Search :size="19" />
          <input
            ref="searchInput"
            v-model="query"
            type="search"
            autocomplete="off"
            spellcheck="false"
            maxlength="128"
            :aria-label="t('app.search')"
          />
          <button type="submit" :disabled="status === 'loading'">
            <LoaderCircle v-if="status === 'loading'" class="spin" :size="18" />
            <template v-else>{{ t('app.search') }} <span>↗</span></template>
          </button>
        </form>
        <div class="results-top__actions">
          <button class="filter-toggle" type="button" @click="filtersOpen = !filtersOpen">
            <SlidersHorizontal :size="16" />
            {{ t('filters.heading') }}
            <span v-if="activeFilterCount">{{ activeFilterCount }}</span>
          </button>
          <button class="icon-button" type="button" :aria-label="t('app.copyShare')" @click="copyShareLink">
            <Copy :size="17" />
          </button>
        </div>
      </section>

      <div class="mobile-filter" :class="{ 'mobile-filter--open': filtersOpen }">
        <div class="filter-group">
          <label>{{ t('filters.time.label') }}</label>
          <div class="option-grid">
            <button
              v-for="option in timeOptions"
              :key="option.value"
              type="button"
              :class="{ active: filters.time === option.value }"
              @click="filters.time = option.value"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div class="filter-group">
          <label>{{ t('filters.language.label') }}</label>
          <div class="option-grid">
            <button
              v-for="option in languageOptions"
              :key="option.value"
              type="button"
              :class="{ active: filters.language === option.value }"
              @click="filters.language = option.value"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div class="filter-group">
          <label for="mobile-site">{{ t('filters.site.mobile') }}</label>
          <input id="mobile-site" v-model="filters.site" :placeholder="t('filters.site.placeholder')" />
        </div>
        <button class="apply-filter" type="button" @click="runSearch(query)">
          {{ t('filters.apply') }}
        </button>
      </div>

      <div class="results-layout">
        <aside class="search-aside" :class="{ 'search-aside--open': filtersOpen }">
          <div class="aside-heading">
            <h2>{{ t('filters.heading') }}</h2>
            <button v-if="activeFilterCount" type="button" @click="resetFilters">
              <RotateCcw :size="13" /> {{ t('filters.reset') }}
            </button>
          </div>

          <div class="filter-group">
            <label><Clock3 :size="14" /> {{ t('filters.time.label') }}</label>
            <div class="filter-stack">
              <button
                v-for="option in timeOptions"
                :key="option.value"
                type="button"
                :class="{ active: filters.time === option.value }"
                @click="filters.time = option.value"
              >
                {{ option.label }} <i></i>
              </button>
            </div>
          </div>

          <div class="filter-group">
            <label><Globe2 :size="14" /> {{ t('filters.language.label') }}</label>
            <div class="segmented">
              <button
                v-for="option in languageOptions"
                :key="option.value"
                type="button"
                :class="{ active: filters.language === option.value }"
                @click="filters.language = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <div class="filter-group">
            <label for="site-filter"><Telescope :size="14" /> {{ t('filters.site.aside') }}</label>
            <div class="site-input">
              <input
                id="site-filter"
                v-model="filters.site"
                :placeholder="t('filters.sitePlaceholder')"
                spellcheck="false"
              />
            </div>
          </div>

          <div class="filter-group">
            <label for="count-filter">{{ t('filters.count') }}</label>
            <div class="range-row">
              <input id="count-filter" v-model.number="filters.count" type="range" min="5" max="20" step="5" />
              <output>{{ filters.count }}</output>
            </div>
            <p class="filter-note">{{ t('filters.countNote') }}</p>
          </div>

          <label class="toggle-row">
            <span>
              <strong>{{ t('filters.content') }}</strong>
              <small>{{ t('filters.contentHint') }}</small>
            </span>
            <input v-model="filters.needContent" type="checkbox" />
            <i></i>
          </label>

          <button class="aside-search" type="button" @click="runSearch(query)">
            <SlidersHorizontal :size="15" /> {{ t('filters.applyAndSearch') }}
          </button>

          <div v-if="history.length" class="aside-history">
            <div class="aside-history__title"><History :size="14" /> {{ t('landing.recent') }}</div>
            <button
              v-for="item in history.slice(0, 4)"
              :key="`${item.query}-${item.at}`"
              type="button"
              @click="searchQuick(item.query)"
            >
              <span>{{ item.query }}</span><ArrowUpRight :size="13" />
            </button>
          </div>
        </aside>

        <section class="results-main">
          <div class="results-heading">
            <div>
              <p class="results-heading__eyebrow">
                <span class="live-dot"></span>
                {{
                  status === 'loading'
                    ? t('results.status.loading')
                    : isCached
                      ? t('results.status.cached')
                      : t('results.status.complete')
                }}
              </p>
              <h1>{{ resultHeading }}</h1>
            </div>
            <div class="results-toolbar">
              <span v-if="status === 'success' && results.length">
                {{
                  isCached
                    ? t('results.status.cached')
                    : t('results.elapsed', { seconds: elapsed.toFixed(2) })
                }}
                ·
                {{
                  activeFilterCount
                    ? t('filters.filtersCount', { count: activeFilterCount })
                    : t('filters.noFilters')
                }}
              </span>
              <div class="sort-control">
                <ArrowDownUp :size="14" />
                <select v-model="sortMode" :aria-label="t('results.sortLabel')">
                  <option value="relevance">{{ t('results.sort.relevance') }}</option>
                  <option value="newest">{{ t('results.sort.newest') }}</option>
                </select>
              </div>
            </div>
          </div>

          <div v-if="status === 'loading'" class="skeleton-list" :aria-label="t('results.loadingAria')">
            <article v-for="index in 4" :key="index" class="skeleton-card">
              <div class="skeleton-card__source"></div>
              <div class="skeleton-card__title"></div>
              <div class="skeleton-card__line"></div>
              <div class="skeleton-card__line short"></div>
              <div class="skeleton-card__foot"></div>
            </article>
          </div>

          <div v-else-if="status === 'error'" class="error-panel">
            <div class="error-panel__icon"><CircleAlert :size="28" /></div>
            <p class="eyebrow"><span></span> {{ t('results.error.kicker') }}</p>
            <h2>{{ t('results.error.title') }}</h2>
            <p>{{ errorMessage }}</p>
            <div class="error-panel__actions">
              <button type="button" @click="runSearch(query)">{{ t('results.error.retry') }}</button>
              <button class="ghost" type="button" @click="openSettings">
                <KeyRound :size="15" /> {{ t('results.error.checkAccount') }}
              </button>
            </div>
          </div>

          <div v-else-if="status === 'success' && !results.length" class="empty-panel">
            <div class="empty-panel__rings"><span></span><span></span><Search :size="28" /></div>
            <p class="eyebrow"><span></span> {{ t('results.empty.kicker') }}</p>
            <h2>{{ t('results.empty.title') }}</h2>
            <p>{{ t('results.empty.body') }}</p>
            <button type="button" @click="resetFilters">{{ t('results.empty.clear') }}</button>
          </div>

          <div v-else class="result-list">
            <article
              v-for="(result, index) in sortedResults"
              :key="`${result.url}-${index}`"
              class="result-card"
              :style="{ '--delay': `${Math.min(index, 7) * 45}ms` }"
            >
              <div class="result-card__rail">
                <span>{{ String(index + 1).padStart(2, '0') }}</span>
                <i></i>
              </div>
              <div class="result-card__body">
                <div class="result-card__source">
                  <img
                    v-if="result.site_icon && !failedSiteIcons.has(result.site_icon)"
                    :src="result.site_icon"
                    alt=""
                    loading="lazy"
                    referrerpolicy="no-referrer"
                    @error="markSiteIconFailed(result.site_icon)"
                  />
                  <span
                    v-if="!result.site_icon || failedSiteIcons.has(result.site_icon)"
                    class="source-fallback"
                  >
                    {{ domainOf(result.url).slice(0, 1).toUpperCase() }}
                  </span>
                  <span class="source-name">{{ result.site_name || domainOf(result.url) }}</span>
                  <span class="source-domain">{{ domainOf(result.url) }}</span>
                </div>

                <button class="result-title" type="button" @click="openResult(result)">
                  {{ result.title || t('results.card.untitled') }}
                  <PanelRightOpen :size="17" />
                </button>

                <p class="result-snippet">
                  {{
                    result.snippet ||
                    result.summary ||
                    t('results.card.fallbackSummary')
                  }}
                </p>

                <div class="result-card__foot">
                  <div class="result-tags">
                    <span>{{ formatResultDate(result.date) }}</span>
                    <span v-if="authorityLabel(result.authority)" :class="{ trusted: result.authority >= 3 }">
                      <ShieldCheck :size="12" /> {{ authorityLabel(result.authority) }}
                    </span>
                    <span v-if="relevanceLabel(result.rerank_score)">
                      {{ relevanceLabel(result.rerank_score) }}
                    </span>
                  </div>
                  <a
                    class="result-card__link"
                    :href="result.url"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ t('results.card.openOriginal') }} <ExternalLink :size="13" />
                  </a>
                </div>
              </div>
            </article>
          </div>

          <div v-if="status === 'success' && results.length" class="end-marker">
            <span></span>
            <p>{{ t('results.end', { count: results.length }) }}</p>
            <span></span>
          </div>
        </section>
      </div>
    </main>

    <footer class="footer">
      <p>{{ t('footer.tagline') }}</p>
      <div>
        <button type="button" @click="openGuide">{{ t('footer.guide') }}</button>
      </div>
    </footer>

    <Transition name="toast">
      <div v-if="toast" class="toast"><Check :size="15" /> {{ toast }}</div>
    </Transition>

    <Teleport to="body">
      <Transition name="fade">
        <div v-if="settingsOpen" class="modal-backdrop" @click.self="closeSettings">
          <section
            ref="settingsDialog"
            class="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            tabindex="-1"
          >
            <button class="modal__close" type="button" :aria-label="t('app.close')" @click="closeSettings">
              <X :size="18" />
            </button>
            <div class="modal__kicker"><KeyRound :size="15" /> {{ t('settings.kicker') }}</div>
            <h2 id="settings-title">{{ t('settings.title') }}</h2>
            <p class="modal__intro">{{ t('settings.intro') }}</p>

            <label class="field-label" for="api-key">{{ t('settings.field') }}</label>
            <div class="key-input">
              <KeyRound :size="17" />
              <input
                id="api-key"
                v-model="draftKey"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="sk-…"
                @keydown.enter="saveKey"
              />
              <span>{{ draftKey ? t('settings.filled') : t('settings.empty') }}</span>
            </div>

            <div class="notice">
              <ShieldCheck :size="18" />
              <p>
                <strong>{{ t('settings.noticeTitle') }}</strong>
                {{ t('settings.noticeBody') }}
              </p>
            </div>

            <div class="modal__actions">
              <button class="text-button" type="button" @click="clearLocalKey">
                <Trash2 :size="14" /> {{ t('settings.clear') }}
              </button>
              <button class="primary-button" type="button" @click="saveKey">
                {{ t('settings.save') }}
              </button>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="fade">
        <div v-if="guideOpen" class="modal-backdrop" @click.self="closeGuide">
          <section
            ref="guideDialog"
            class="modal guide-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
            tabindex="-1"
          >
            <button class="modal__close" type="button" :aria-label="t('app.close')" @click="closeGuide">
              <X :size="18" />
            </button>
            <div class="modal__kicker"><BookOpenText :size="15" /> {{ t('guide.kicker') }}</div>
            <h2 id="guide-title">{{ t('guide.title') }}</h2>
            <p class="modal__intro">{{ t('guide.intro') }}</p>
            <div class="syntax-grid">
              <code>site:github.com</code><span>{{ t('guide.syntax.site') }}</span>
              <code>-site:example.com</code><span>{{ t('guide.syntax.excludeSite') }}</span>
              <code>{{ t('guide.examples.phrase') }}</code><span>{{ t('guide.syntax.phrase') }}</span>
              <code>lang:zh,en</code><span>{{ t('guide.syntax.language') }}</span>
              <code>after:2026-01-01</code><span>{{ t('guide.syntax.after') }}</span>
              <code>before:2026-12-31</code><span>{{ t('guide.syntax.before') }}</span>
            </div>
            <div class="fetch-guide-note">
              <BookOpenText :size="18" />
              <p>
                <strong>{{ t('guide.noteTitle') }}</strong>
                {{ t('guide.noteBody') }}
              </p>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="drawer">
        <div v-if="selectedResult" class="drawer-backdrop" @click.self="closeResult()">
          <aside
            ref="resultDialog"
            class="result-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="drawer-title"
            tabindex="-1"
          >
            <div class="drawer__head">
              <span>{{ t('drawer.label', { domain: domainOf(selectedResult.url) }) }}</span>
              <button type="button" :aria-label="t('app.close')" @click="closeResult()">
                <X :size="18" />
              </button>
            </div>
            <div class="drawer__scroll">
              <div class="drawer__source">
                <span class="source-fallback">{{ domainOf(selectedResult.url).slice(0, 1).toUpperCase() }}</span>
                <span>{{ selectedResult.site_name || domainOf(selectedResult.url) }}</span>
              </div>
              <h2 id="drawer-title">{{ selectedResult.title || t('results.card.untitled') }}</h2>
              <div class="drawer__meta">
                <span>{{ formatResultDate(selectedResult.date) }}</span>
                <span v-if="authorityLabel(selectedResult.authority)">
                  {{ authorityLabel(selectedResult.authority) }}
                </span>
                <span v-if="relevanceLabel(selectedResult.rerank_score)">
                  {{ relevanceLabel(selectedResult.rerank_score) }}
                </span>
              </div>
              <span class="drawer__url">{{ selectedResult.url }}</span>
              <div class="content-origin">
                <span :title="fetchedTitle || selectedResult.title">{{ contentSource }}</span>
                <span v-if="fetchedContent" class="content-origin__cached">{{ t('drawer.readThisTime') }}</span>
              </div>
              <div class="markdown-body" v-html="renderedContent"></div>
              <div v-if="!hasFullContent" class="fetch-panel" :class="{ 'fetch-panel--error': fetchStatus === 'error' }">
                <div class="fetch-panel__icon">
                  <LoaderCircle v-if="fetchStatus === 'loading'" class="spin" :size="20" />
                  <CircleAlert v-else-if="fetchStatus === 'error'" :size="20" />
                  <BookOpenText v-else :size="20" />
                </div>
                <div class="fetch-panel__copy">
                  <h3>
                    {{
                      fetchStatus === 'loading'
                        ? t('drawer.fetch.loading')
                        : fetchStatus === 'error'
                          ? t('drawer.fetch.error')
                          : t('drawer.fetch.idle')
                    }}
                  </h3>
                  <p v-if="fetchStatus === 'error'">{{ fetchError }}</p>
                  <p v-else>
                    {{ t('drawer.fetch.description') }}
                  </p>
                </div>
                <button type="button" :disabled="fetchStatus === 'loading'" @click="fetchResultContent">
                  <LoaderCircle v-if="fetchStatus === 'loading'" class="spin" :size="14" />
                  <BookOpenText v-else :size="14" />
                  {{
                    fetchStatus === 'loading'
                      ? t('drawer.fetch.reading')
                      : fetchStatus === 'error'
                        ? t('drawer.fetch.retry')
                        : t('drawer.fetch.action')
                  }}
                </button>
              </div>
              <p v-else class="drawer__note">
                {{ t('drawer.fetch.complete') }}
              </p>
            </div>
            <div class="drawer__foot">
              <a :href="selectedResult.url" target="_blank" rel="noopener noreferrer">
                {{ t('drawer.openOriginal') }} <ExternalLink :size="15" />
              </a>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
