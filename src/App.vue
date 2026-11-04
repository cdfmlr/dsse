<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  ArrowDownUp,
  ArrowUpRight,
  BookOpenText,
  Check,
  ChevronLeft,
  CircleAlert,
  Clock3,
  Copy,
  ExternalLink,
  Globe2,
  History,
  KeyRound,
  LoaderCircle,
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
const QUICK_SEARCHES = ['2026 诺贝尔物理学奖', 'DeepSeek V4 发布', 'Vue 3.5 新特性']

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
const keyLabel = computed(() => (apiKey.value ? '账户已连接' : '连接账户'))
const connectionLabel = computed(() => (apiKey.value ? '准备就绪' : '连接后开始'))
const resultHeading = computed(() => {
  if (status.value === 'loading') return '正在穿过网页，寻找相关线索'
  if (status.value === 'error') return '这次没有找到答案'
  if (!results.value.length) return '没有找到匹配的网页'
  return `为「${submittedQuery.value}」找到 ${results.value.length} 条结果`
})
const renderedContent = computed(() => {
  const page = selectedResult.value
  if (!page) return ''
  const raw =
    fetchedContent.value ||
    page.content ||
    page.summary ||
    page.snippet ||
    '该网页没有提供可预览的摘要。'
  const html = marked.parse(raw, { async: false })
  return DOMPurify.sanitize(String(html))
})
const hasFullContent = computed(
  () => Boolean(fetchedContent.value || selectedResult.value?.content),
)
const contentSource = computed(() => {
  if (fetchedContent.value || selectedResult.value?.content) return '完整正文'
  return '网页摘要'
})

const timeOptions: Array<{ value: TimeRange; label: string }> = [
  { value: 'any', label: '不限时间' },
  { value: 'day', label: '最近 24 小时' },
  { value: 'week', label: '最近一周' },
  { value: 'month', label: '最近一月' },
  { value: 'year', label: '最近一年' },
]

const languageOptions: Array<{ value: Language; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

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

function buildApiQuery(base: string) {
  const parts = [base.trim()]
  if (filters.language !== 'auto') parts.push(`lang:${filters.language}`)
  const site = filters.site.trim().replace(/^site:/, '')
  if (site) parts.push(`site:${site}`)

  const offsets: Record<TimeRange, number | null> = {
    any: null,
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  }
  const days = offsets[filters.time]
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

function searchCacheSignature(apiQuery: string) {
  return JSON.stringify([apiQuery, filters.count, filters.needContent])
}

function readCache(apiQuery: string) {
  try {
    const cache = JSON.parse(readStorage('session', SESSION_CACHE) || '{}') as Record<
      string,
      { results: SearchResult[]; at: number }
    >
    return cache[shortHash(searchCacheSignature(apiQuery))] || null
  } catch {
    return null
  }
}

function writeCache(apiQuery: string, value: SearchResult[]) {
  if (filters.needContent) return
  try {
    const cache = JSON.parse(readStorage('session', SESSION_CACHE) || '{}') as Record<
      string,
      { results: SearchResult[]; at: number }
    >
    const entries = Object.entries(cache).sort(([, a], [, b]) => b.at - a.at).slice(0, 4)
    const trimmed = Object.fromEntries(entries)
    trimmed[shortHash(searchCacheSignature(apiQuery))] = { results: value, at: Date.now() }
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

function updateUrl(term: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('q', term)
  window.history.replaceState({}, '', url)
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
}

function closeResult() {
  fetchController?.abort()
  selectedResult.value = null
  fetchStatus.value = 'idle'
  fetchError.value = ''
}

async function fetchResultContent() {
  const page = selectedResult.value
  if (!page || fetchStatus.value === 'loading') return
  if (!apiKey.value) {
    draftKey.value = ''
    settingsOpen.value = true
    showToast('请先配置 DeepSeek API Key')
    return
  }

  const cached = readFetchCache(page.url)
  if (cached) {
    fetchedTitle.value = cached.title
    fetchedContent.value = cached.content
    fetchStatus.value = 'success'
    showToast('已载入刚才读取的正文')
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
        400: '这条网页暂时无法读取。',
        401: 'API Key 无效或已失效，请重新连接账户。',
        402: '账户余额不足，请前往 DeepSeek 开放平台充值。',
        403: '该网页不允许读取正文。',
        404: '没有从这条网页中找到可阅读的正文。',
        408: '读取时间有点久，请稍后再试。',
        413: '这条网页的正文太长，暂时无法完整读取。',
        429: '读取得有点频繁，请稍等片刻。',
        500: 'DeepSeek 暂时无法读取这条正文。',
        504: '读取响应超时，请稍后再试。',
      }
      throw new Error(
        friendly[response.status] ||
          `暂时无法读取这条正文，请稍后再试（HTTP ${response.status}）`,
      )
    }

    if (typeof payload.content !== 'string' || !payload.content.trim()) {
      throw new Error('该网页没有返回可阅读的正文。')
    }
    if (selectedResult.value?.url !== page.url) return

    fetchedTitle.value = payload.title || page.title
    fetchedContent.value = payload.content
    fetchStatus.value = 'success'
    writeFetchCache(page.url, fetchedTitle.value, payload.content)
    showToast('正文已准备好')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    fetchError.value =
      error instanceof TypeError
        ? '无法读取网页正文，请检查网络后重试。'
        : error instanceof Error
          ? error.message
          : '暂时无法读取网页正文。'
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
    draftKey.value = ''
    settingsOpen.value = true
    showToast('请先配置 DeepSeek API Key')
    return
  }

  const apiQuery = buildApiQuery(clean)
  if (apiQuery.length > SEARCH_LIMIT) {
    errorMessage.value = `搜索内容有点长，请控制在 ${SEARCH_LIMIT} 个字符以内（含筛选条件）。`
    status.value = 'error'
    submittedQuery.value = clean
    return
  }

  query.value = clean
  submittedQuery.value = clean
  updateUrl(clean)
  saveHistory(clean)
  closeResult()
  filtersOpen.value = false
  isCached.value = false

  const cached = readCache(apiQuery)
  if (cached) {
    results.value = cached.results
    elapsed.value = 0
    status.value = 'success'
    isCached.value = true
    return
  }

  controller?.abort()
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
        count: filters.count,
        need_content: filters.needContent,
      }),
      signal: controller.signal,
    })

    const payload = (await response.json().catch(() => ({}))) as SearchResponse & ApiErrorShape
    if (!response.ok) {
      const friendly: Record<number, string> = {
        400: '搜索条件有些问题，请调整后再试。',
        401: 'API Key 无效或已失效，请重新连接账户。',
        402: '账户余额不足，请前往 DeepSeek 开放平台充值。',
        403: '这次搜索没有被允许，请调整关键词后再试。',
        408: '搜索时间有点久，请稍后再试。',
        413: '搜索内容过长，请精简后再试。',
        429: '搜索得有点快，请稍等片刻。',
        500: 'DeepSeek 搜索暂时不可用。',
        504: '搜索响应超时，请稍后再试。',
      }
      throw new Error(
        friendly[response.status] || '暂时无法完成搜索，请稍后再试。',
      )
    }

    if (!Array.isArray(payload.results)) {
      throw new Error('搜索结果暂时无法显示，请稍后再试。')
    }

    results.value = payload.results
    elapsed.value = Math.max(0.01, (performance.now() - startedAt) / 1000)
    status.value = 'success'
    writeCache(apiQuery, payload.results)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    errorMessage.value =
      error instanceof TypeError
        ? '无法连接搜索服务，请检查网络后重试。'
        : error instanceof Error
          ? error.message
          : '搜索暂时无法完成，请稍后再试。'
    status.value = 'error'
  }
}

function goHome() {
  controller?.abort()
  submittedQuery.value = ''
  status.value = 'idle'
  results.value = []
  errorMessage.value = ''
  closeResult()
  const url = new URL(window.location.href)
  url.searchParams.delete('q')
  window.history.replaceState({}, '', url)
  focusSearch()
}

function openSettings() {
  draftKey.value = apiKey.value
  settingsOpen.value = true
}

function saveKey() {
  const next = draftKey.value.trim()
  apiKey.value = next
  settingsOpen.value = false
  if (!next) {
    removeStorage('local', KEY_STORAGE)
    showToast('API Key 已从当前浏览器移除')
    return
  }

  const saved = writeStorage('local', KEY_STORAGE, next)
  showToast(
    saved
      ? 'API Key 已保存在当前浏览器'
      : '账户已连接，本次页面关闭后需重新填写 Key',
  )
}

function clearLocalKey() {
  draftKey.value = ''
  apiKey.value = ''
  removeStorage('local', KEY_STORAGE)
  showToast('API Key 已从当前浏览器移除')
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

function formatResultDate(value: string | null) {
  if (!value) return '日期未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日期未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function authorityLabel(authority: number) {
  return authority >= 3 ? '可信来源' : ''
}

function relevanceLabel(score: number) {
  if (score >= 2) return '高度相关'
  if (score >= 1.5) return '相关'
  if (score > 0) return '部分相关'
  return ''
}

async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(window.location.href)
    showToast('分享链接已复制')
  } catch {
    showToast('复制失败，请从地址栏复制')
  }
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  const isTyping =
    target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable

  if (event.key === 'Escape') {
    settingsOpen.value = false
    guideOpen.value = false
    filtersOpen.value = false
    closeResult()
  }
  if (!isTyping && (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key === 'k'))) {
    event.preventDefault()
    focusSearch()
  }
}

onMounted(() => {
  const initialQuery = new URL(window.location.href).searchParams.get('q')
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
      <button class="brand" type="button" aria-label="返回首页" @click="goHome">
        <span class="brand__mark" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
        </span>
        <span class="brand__word">寻迹</span>
        <span class="brand__latin">DSSE</span>
      </button>

      <div class="topbar__meta">
        <span class="powered-pill"><Sparkles :size="13" /> DeepSeek 实时搜索</span>
        <span class="connection" :class="{ 'connection--ready': apiKey }">
          <span></span>{{ connectionLabel }}
        </span>
      </div>

      <div class="topbar__actions">
        <button class="icon-button" type="button" aria-label="查看搜索技巧" @click="guideOpen = true">
          <BookOpenText :size="18" />
        </button>
        <button class="key-button" type="button" aria-label="账户设置" @click="openSettings">
          <KeyRound :size="16" />
          <span>{{ keyLabel }}</span>
        </button>
      </div>
    </header>

    <main v-if="!hasSearched" class="landing">
      <div class="landing__ornament" aria-hidden="true">
        <span>实时搜索 / 01</span>
        <span>公开网页</span>
      </div>

      <section class="hero">
        <p class="eyebrow"><span></span> 不做信息流，只找你要的答案</p>
        <h1>在信息的缝隙里，<br /><em>寻到答案。</em></h1>
        <p class="hero__intro">
          搜索实时网页，找到真正相关的内容；需要细读时，再打开完整正文。<br class="desktop-break" />
          只有成功获得结果时才会产生费用。
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
            placeholder="搜索网页、新闻、研究或一个模糊的问题…"
            aria-label="搜索"
          />
          <span class="hero-search__hint"><kbd>/</kbd></span>
          <button type="submit" aria-label="开始搜索">
            <span>寻迹</span>
            <ArrowUpRight :size="18" />
          </button>
        </form>

        <div class="quick-row">
          <span>试一试</span>
          <button
            v-for="term in QUICK_SEARCHES"
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
          <h2>先搜索，再细读</h2>
          <p>先找到相关网页；需要完整内容时，再在当前页面里读取正文。</p>
        </div>
        <div class="feature-card">
          <span class="feature-card__number">02</span>
          <SlidersHorizontal :size="20" />
          <h2>缩小范围</h2>
          <p>按时间、语言和网站收窄结果，更快找到你真正需要的信息。</p>
        </div>
        <div class="feature-card">
          <span class="feature-card__number">03</span>
          <ShieldCheck :size="20" />
          <h2>花费清楚</h2>
          <p>搜索和读取正文只在你主动操作时进行；成功获得结果才会计费。</p>
        </div>
      </section>

      <div v-if="history.length" class="recent-strip">
        <div class="recent-strip__title"><History :size="16" /> 最近搜索</div>
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
            aria-label="搜索"
          />
          <button type="submit" :disabled="status === 'loading'">
            <LoaderCircle v-if="status === 'loading'" class="spin" :size="18" />
            <template v-else>搜索 <span>↗</span></template>
          </button>
        </form>
        <div class="results-top__actions">
          <button class="filter-toggle" type="button" @click="filtersOpen = !filtersOpen">
            <SlidersHorizontal :size="16" />
            筛选
            <span v-if="activeFilterCount">{{ activeFilterCount }}</span>
          </button>
          <button class="icon-button" type="button" aria-label="复制分享链接" @click="copyShareLink">
            <Copy :size="17" />
          </button>
        </div>
      </section>

      <div class="mobile-filter" :class="{ 'mobile-filter--open': filtersOpen }">
        <div class="filter-group">
          <label>时间</label>
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
          <label>语言</label>
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
          <label for="mobile-site">指定网站</label>
          <input id="mobile-site" v-model="filters.site" placeholder="例如 github.com" />
        </div>
        <button class="apply-filter" type="button" @click="runSearch(query)">应用筛选</button>
      </div>

      <div class="results-layout">
        <aside class="search-aside" :class="{ 'search-aside--open': filtersOpen }">
          <div class="aside-heading">
            <h2>筛选结果</h2>
            <button v-if="activeFilterCount" type="button" @click="resetFilters">
              <RotateCcw :size="13" /> 重置
            </button>
          </div>

          <div class="filter-group">
            <label><Clock3 :size="14" /> 时间范围</label>
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
            <label><Globe2 :size="14" /> 网页语言</label>
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
            <label for="site-filter"><Telescope :size="14" /> 指定网站</label>
            <div class="site-input">
              <input
                id="site-filter"
                v-model="filters.site"
                placeholder="github.com"
                spellcheck="false"
              />
            </div>
          </div>

          <div class="filter-group">
            <label for="count-filter">显示结果数</label>
            <div class="range-row">
              <input id="count-filter" v-model.number="filters.count" type="range" min="5" max="20" step="5" />
              <output>{{ filters.count }}</output>
            </div>
            <p class="filter-note">每次搜索按次计费，与显示的结果数量无关。</p>
          </div>

          <label class="toggle-row">
            <span>
              <strong>同时读取正文</strong>
              <small>适合需要完整内容时</small>
            </span>
            <input v-model="filters.needContent" type="checkbox" />
            <i></i>
          </label>

          <button class="aside-search" type="button" @click="runSearch(query)">
            <SlidersHorizontal :size="15" /> 应用筛选并搜索
          </button>

          <div v-if="history.length" class="aside-history">
            <div class="aside-history__title"><History :size="14" /> 最近搜索</div>
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
                {{ status === 'loading' ? '正在搜索' : isCached ? '已载入刚才的结果' : '搜索完成' }}
              </p>
              <h1>{{ resultHeading }}</h1>
            </div>
            <div class="results-toolbar">
              <span v-if="status === 'success' && results.length">
                {{ isCached ? '已载入刚才的结果' : `用时 ${elapsed.toFixed(2)} 秒` }} ·
                {{ activeFilterCount ? `${activeFilterCount} 项筛选` : '未添加筛选' }}
              </span>
              <div class="sort-control">
                <ArrowDownUp :size="14" />
                <select v-model="sortMode" aria-label="排序方式">
                  <option value="relevance">相关度优先</option>
                  <option value="newest">时间优先</option>
                </select>
              </div>
            </div>
          </div>

          <div v-if="status === 'loading'" class="skeleton-list" aria-label="正在搜索">
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
            <p class="eyebrow"><span></span> 搜索遇到问题</p>
            <h2>线索在这里断了</h2>
            <p>{{ errorMessage }}</p>
            <div class="error-panel__actions">
              <button type="button" @click="runSearch(query)">再试一次</button>
              <button class="ghost" type="button" @click="openSettings">
                <KeyRound :size="15" /> 检查账户设置
              </button>
            </div>
          </div>

          <div v-else-if="status === 'success' && !results.length" class="empty-panel">
            <div class="empty-panel__rings"><span></span><span></span><Search :size="28" /></div>
            <p class="eyebrow"><span></span> 没有匹配结果</p>
            <h2>换个问法，也许更近</h2>
            <p>试试减少筛选条件、使用更通用的关键词，或检查站点范围是否过窄。</p>
            <button type="button" @click="resetFilters">清除筛选条件</button>
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
                    v-if="result.site_icon"
                    :src="result.site_icon"
                    alt=""
                    loading="lazy"
                    referrerpolicy="no-referrer"
                    @error="($event.target as HTMLImageElement).style.display = 'none'"
                  />
                  <span class="source-fallback">{{ domainOf(result.url).slice(0, 1).toUpperCase() }}</span>
                  <span class="source-name">{{ result.site_name || domainOf(result.url) }}</span>
                  <span class="source-domain">{{ domainOf(result.url) }}</span>
                </div>

                <a class="result-title" :href="result.url" target="_blank" rel="noopener noreferrer">
                  {{ result.title || '未命名网页' }}
                  <ArrowUpRight :size="17" />
                </a>

                <p class="result-snippet">
                  {{ result.snippet || result.summary || '该网页没有提供摘要，可打开原页面查看。' }}
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
                  <button type="button" @click="openResult(result)">
                    查看内容 <ChevronLeft :size="13" />
                  </button>
                </div>
              </div>
            </article>
          </div>

          <div v-if="status === 'success' && results.length" class="end-marker">
            <span></span>
            <p>这是本次搜索的全部 {{ results.length }} 条结果</p>
            <span></span>
          </div>
        </section>
      </div>
    </main>

    <footer class="footer">
      <p>寻迹 DSSE · 数据来自 DeepSeek 实时搜索</p>
      <div>
        <button type="button" @click="guideOpen = true">搜索技巧</button>
      </div>
    </footer>

    <Transition name="toast">
      <div v-if="toast" class="toast"><Check :size="15" /> {{ toast }}</div>
    </Transition>

    <Teleport to="body">
      <Transition name="fade">
        <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen = false">
          <section class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <button class="modal__close" type="button" aria-label="关闭" @click="settingsOpen = false">
              <X :size="18" />
            </button>
            <div class="modal__kicker"><KeyRound :size="15" /> 账户连接</div>
            <h2 id="settings-title">连接 DeepSeek</h2>
            <p class="modal__intro">
              填入 DeepSeek API Key 后即可开始搜索。Key 只用于访问 DeepSeek 的搜索与正文服务，
              并保存在当前浏览器中。
            </p>

            <label class="field-label" for="api-key">DeepSeek API Key</label>
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
              <span>{{ draftKey ? '已填写' : '未填写' }}</span>
            </div>

            <div class="notice">
              <ShieldCheck :size="18" />
              <p>
                <strong>请像保管密码一样保管 Key。</strong>
                如果你使用公用设备，离开前可以清除这里的 Key。
              </p>
            </div>

            <div class="modal__actions">
              <button class="text-button" type="button" @click="clearLocalKey">
                <Trash2 :size="14" /> 清除 Key
              </button>
              <button class="primary-button" type="button" @click="saveKey">保存设置</button>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="fade">
        <div v-if="guideOpen" class="modal-backdrop" @click.self="guideOpen = false">
          <section class="modal guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
            <button class="modal__close" type="button" aria-label="关闭" @click="guideOpen = false">
              <X :size="18" />
            </button>
            <div class="modal__kicker"><BookOpenText :size="15" /> 搜索技巧</div>
            <h2 id="guide-title">让搜索更准确</h2>
            <p class="modal__intro">在关键词后加入这些写法，可以更快把范围缩小到你关心的网站、语言和时间。</p>
            <div class="syntax-grid">
              <code>site:github.com</code><span>只在指定站点内搜索</span>
              <code>-site:example.com</code><span>排除指定站点</span>
              <code>"精确短语"</code><span>精确匹配一段内容</span>
              <code>lang:zh,en</code><span>限定网页语言</span>
              <code>after:2026-01-01</code><span>限定发布时间之后</span>
              <code>before:2026-12-31</code><span>限定发布时间之前</span>
            </div>
            <div class="fetch-guide-note">
              <BookOpenText :size="18" />
              <p>
                <strong>完整正文按需读取。</strong>
                只有你打开结果并选择读取正文时才会发生；同一条结果在一次浏览中只会读取一次。
              </p>
            </div>
          </section>
        </div>
      </Transition>

      <Transition name="drawer">
        <div v-if="selectedResult" class="drawer-backdrop" @click.self="closeResult">
          <aside class="result-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
            <div class="drawer__head">
              <span>网页详情 · {{ domainOf(selectedResult.url) }}</span>
              <button type="button" aria-label="关闭" @click="closeResult">
                <X :size="18" />
              </button>
            </div>
            <div class="drawer__scroll">
              <div class="drawer__source">
                <span class="source-fallback">{{ domainOf(selectedResult.url).slice(0, 1).toUpperCase() }}</span>
                <span>{{ selectedResult.site_name || domainOf(selectedResult.url) }}</span>
              </div>
              <h2 id="drawer-title">{{ selectedResult.title || '未命名网页' }}</h2>
              <div class="drawer__meta">
                <span>{{ formatResultDate(selectedResult.date) }}</span>
                <span v-if="authorityLabel(selectedResult.authority)">
                  {{ authorityLabel(selectedResult.authority) }}
                </span>
                <span v-if="relevanceLabel(selectedResult.rerank_score)">
                  {{ relevanceLabel(selectedResult.rerank_score) }}
                </span>
              </div>
              <a class="drawer__url" :href="selectedResult.url" target="_blank" rel="noreferrer">
                {{ selectedResult.url }} <ArrowUpRight :size="13" />
              </a>
              <div class="content-origin">
                <span :title="fetchedTitle || selectedResult.title">{{ contentSource }}</span>
                <span v-if="fetchedContent" class="content-origin__cached">本次已读取</span>
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
                    {{ fetchStatus === 'loading' ? '正在读取正文' : fetchStatus === 'error' ? '没有读到这条正文' : '读取完整正文' }}
                  </h3>
                  <p v-if="fetchStatus === 'error'">{{ fetchError }}</p>
                  <p v-else>
                    适合需要细看全文时使用。只有读取成功才会产生约 ¥0.005 的费用。
                  </p>
                </div>
                <button type="button" :disabled="fetchStatus === 'loading'" @click="fetchResultContent">
                  <LoaderCircle v-if="fetchStatus === 'loading'" class="spin" :size="14" />
                  <BookOpenText v-else :size="14" />
                  {{ fetchStatus === 'loading' ? '读取中' : fetchStatus === 'error' ? '重新读取' : '读取全文' }}
                </button>
              </div>
              <p v-else class="drawer__note">
                已显示完整正文。本次浏览期间再次打开这条结果，不会重复读取或收费。
              </p>
            </div>
            <div class="drawer__foot">
              <a :href="selectedResult.url" target="_blank" rel="noreferrer">
                打开原网页 <ExternalLink :size="15" />
              </a>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
