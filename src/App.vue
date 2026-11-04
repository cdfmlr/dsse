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

const envApiKey = (import.meta.env.VITE_DEEPSEEK_API_KEY as string | undefined)?.trim() ?? ''
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
const apiKey = ref(localStorage.getItem(KEY_STORAGE) || envApiKey)
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
const keyLabel = computed(() => (apiKey.value ? `•••• ${apiKey.value.slice(-4)}` : '未配置'))
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
  if (fetchedContent.value) return 'FETCH · 网页正文'
  if (selectedResult.value?.content) return 'SEARCH · 网页正文'
  return 'SEARCH · 摘要'
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
    const value = JSON.parse(localStorage.getItem(HISTORY_STORAGE) || '[]')
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

function readCache(apiQuery: string) {
  try {
    const cache = JSON.parse(sessionStorage.getItem(SESSION_CACHE) || '{}') as Record<
      string,
      { results: SearchResult[]; at: number }
    >
    return cache[shortHash(apiQuery)] || null
  } catch {
    return null
  }
}

function writeCache(apiQuery: string, value: SearchResult[]) {
  if (filters.needContent) return
  try {
    const cache = JSON.parse(sessionStorage.getItem(SESSION_CACHE) || '{}') as Record<
      string,
      { results: SearchResult[]; at: number }
    >
    const entries = Object.entries(cache).sort(([, a], [, b]) => b.at - a.at).slice(0, 4)
    const trimmed = Object.fromEntries(entries)
    trimmed[shortHash(apiQuery)] = { results: value, at: Date.now() }
    sessionStorage.setItem(SESSION_CACHE, JSON.stringify(trimmed))
  } catch {
    // A full or unavailable session store should never block a search.
  }
}

function readFetchCache(url: string) {
  try {
    const cache = JSON.parse(sessionStorage.getItem(FETCH_CACHE) || '{}') as Record<
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
    const cache = JSON.parse(sessionStorage.getItem(FETCH_CACHE) || '{}') as Record<
      string,
      { title: string; content: string; at: number }
    >
    const entries = Object.entries(cache).sort(([, a], [, b]) => b.at - a.at).slice(0, 2)
    const trimmed = Object.fromEntries(entries)
    trimmed[shortHash(url)] = { title, content, at: Date.now() }
    sessionStorage.setItem(FETCH_CACHE, JSON.stringify(trimmed))
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
  localStorage.setItem(HISTORY_STORAGE, JSON.stringify(next))
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
    showToast('已复用本次会话抓取的正文')
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
      const serverMessage = payload.error?.message || ''
      const friendly: Record<number, string> = {
        400: '网页地址不合法，无法抓取。',
        401: 'API Key 无效或已失效，请在设置中更换。',
        402: '账户余额不足，请前往 DeepSeek 开放平台充值。',
        403: '该网页被安全策略拒绝抓取。',
        404: '未能从该网页提取到有效正文。',
        408: '读取请求超时，请稍后再试。',
        413: '网页内容超过抓取大小限制。',
        429: '抓取请求过于频繁，请稍等片刻再试。',
        500: 'DeepSeek 抓取服务暂时出错。',
        504: '抓取服务响应超时，请稍后再试。',
      }
      throw new Error(
        `${friendly[response.status] || `抓取失败（HTTP ${response.status}）`}${
          serverMessage ? ` ${serverMessage}` : ''
        }`,
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
    showToast('网页正文已抓取')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    fetchError.value =
      error instanceof TypeError
        ? '无法连接抓取服务，请检查网络或浏览器跨域限制。'
        : error instanceof Error
          ? error.message
          : '抓取网页时发生未知错误。'
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
    errorMessage.value = `搜索词与筛选条件共 ${apiQuery.length} 个字符，请控制在 ${SEARCH_LIMIT} 个以内。`
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
      const serverMessage = payload.error?.message || ''
      const friendly: Record<number, string> = {
        400: '请求参数不正确，请检查搜索词与筛选条件。',
        401: 'API Key 无效或已失效，请在设置中更换。',
        402: '账户余额不足，请前往 DeepSeek 开放平台充值。',
        403: '请求被安全策略拒绝。',
        408: '读取请求超时，请稍后再试。',
        413: '请求内容过大。',
        429: '请求过于频繁，请稍等片刻再搜。',
        500: 'DeepSeek 搜索服务暂时出错。',
        504: '搜索服务响应超时，请稍后再试。',
      }
      throw new Error(
        `${friendly[response.status] || `请求失败（HTTP ${response.status}）`}${
          serverMessage ? ` ${serverMessage}` : ''
        }`,
      )
    }

    if (!Array.isArray(payload.results)) {
      throw new Error('接口返回格式异常，请稍后再试。')
    }

    results.value = payload.results
    elapsed.value = Math.max(0.01, (performance.now() - startedAt) / 1000)
    status.value = 'success'
    writeCache(apiQuery, payload.results)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    errorMessage.value =
      error instanceof TypeError
        ? '无法连接搜索服务，请检查网络或浏览器跨域限制。'
        : error instanceof Error
          ? error.message
          : '搜索时发生未知错误。'
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
  if (next) localStorage.setItem(KEY_STORAGE, next)
  else localStorage.removeItem(KEY_STORAGE)
  settingsOpen.value = false
  showToast(next ? 'API Key 已保存在当前浏览器' : 'API Key 已清除')
}

function clearLocalKey() {
  draftKey.value = ''
  apiKey.value = envApiKey
  localStorage.removeItem(KEY_STORAGE)
  if (envApiKey) {
    showToast('已恢复内置测试 Key')
  } else {
    showToast('已清除本地 API Key')
  }
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
  if (authority >= 3) return '高权威'
  if (authority >= 1) return '有信誉'
  return '来源待核'
}

function scoreLabel(score: number) {
  return Number.isFinite(score) ? score.toFixed(1) : '—'
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
        <span class="brand__latin">SIFT</span>
      </button>

      <div class="topbar__meta">
        <span class="powered-pill"><Sparkles :size="13" /> DeepSeek Search + Fetch</span>
        <span class="connection" :class="{ 'connection--ready': apiKey }">
          <span></span>{{ apiKey ? 'API READY' : 'KEY REQUIRED' }}
        </span>
      </div>

      <div class="topbar__actions">
        <button class="icon-button" type="button" aria-label="查看搜索语法" @click="guideOpen = true">
          <BookOpenText :size="18" />
        </button>
        <button class="key-button" type="button" @click="openSettings">
          <KeyRound :size="16" />
          <span>{{ keyLabel }}</span>
        </button>
      </div>
    </header>

    <main v-if="!hasSearched" class="landing">
      <div class="landing__ornament" aria-hidden="true">
        <span>SEARCH / 01</span>
        <span>REAL-TIME WEB INDEX</span>
      </div>

      <section class="hero">
        <p class="eyebrow"><span></span> 不做信息流，只找你要的答案</p>
        <h1>在信息的缝隙里，<br /><em>寻到答案。</em></h1>
        <p class="hero__intro">
          连接 DeepSeek 实时网页索引与正文抓取。搜索一次，按需读取；<br class="desktop-break" />
          没有后台轮询，也不为无关结果买单。
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
          <h2>搜索 + 抓取</h2>
          <p>Search 找到实时网页，Fetch 再将单页转为 Markdown 正文；正文只在你点击时读取。</p>
        </div>
        <div class="feature-card">
          <span class="feature-card__number">02</span>
          <SlidersHorizontal :size="20" />
          <h2>精确收束</h2>
          <p>用语言、时间、站内范围控制搜索边界，让问题落在正确的信息场里。</p>
        </div>
        <div class="feature-card">
          <span class="feature-card__number">03</span>
          <ShieldCheck :size="20" />
          <h2>按需，计费</h2>
          <p>搜索与抓取都只在提交时请求，成功产出结果才计费；会话内重复操作直接复用。</p>
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
          <label for="mobile-site">限定站点</label>
          <input id="mobile-site" v-model="filters.site" placeholder="例如 github.com" />
        </div>
        <button class="apply-filter" type="button" @click="runSearch(query)">应用筛选</button>
      </div>

      <div class="results-layout">
        <aside class="search-aside" :class="{ 'search-aside--open': filtersOpen }">
          <div class="aside-heading">
            <h2>收束范围</h2>
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
            <label for="site-filter"><Telescope :size="14" /> 站点范围</label>
            <div class="site-input">
              <span>site:</span>
              <input
                id="site-filter"
                v-model="filters.site"
                placeholder="github.com"
                spellcheck="false"
              />
            </div>
          </div>

          <div class="filter-group">
            <label for="count-filter">返回数量</label>
            <div class="range-row">
              <input id="count-filter" v-model.number="filters.count" type="range" min="5" max="20" step="5" />
              <output>{{ filters.count }}</output>
            </div>
            <p class="filter-note">同一成功请求内，数量不增加费用。</p>
          </div>

          <label class="toggle-row">
            <span>
              <strong>读取正文</strong>
              <small>返回结果更完整</small>
            </span>
            <input v-model="filters.needContent" type="checkbox" />
            <i></i>
          </label>

          <button class="aside-search" type="button" @click="runSearch(query)">
            <SlidersHorizontal :size="15" /> 应用并重新搜索
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
                {{ status === 'loading' ? 'LIVE SEARCH' : isCached ? 'SESSION CACHE' : 'SEARCH COMPLETE' }}
              </p>
              <h1>{{ resultHeading }}</h1>
            </div>
            <div class="results-toolbar">
              <span v-if="status === 'success' && results.length">
                {{ isCached ? '已复用会话结果 · ' : `${elapsed.toFixed(2)}s · ` }}{{ activeFilterCount }} 项筛选
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
            <p class="eyebrow"><span></span> REQUEST INTERRUPTED</p>
            <h2>线索在这里断了</h2>
            <p>{{ errorMessage }}</p>
            <div class="error-panel__actions">
              <button type="button" @click="runSearch(query)">再试一次</button>
              <button class="ghost" type="button" @click="openSettings">
                <KeyRound :size="15" /> 检查 API Key
              </button>
            </div>
          </div>

          <div v-else-if="status === 'success' && !results.length" class="empty-panel">
            <div class="empty-panel__rings"><span></span><span></span><Search :size="28" /></div>
            <p class="eyebrow"><span></span> NO MATCHES</p>
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
                    <span :class="{ trusted: result.authority >= 3 }">
                      <ShieldCheck :size="12" /> {{ authorityLabel(result.authority) }}
                    </span>
                    <span v-if="result.rerank_score > 0">相关性 {{ scoreLabel(result.rerank_score) }}</span>
                  </div>
                  <button type="button" @click="openResult(result)">
                    摘要与正文 <ChevronLeft :size="13" />
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
      <p>寻迹 SIFT · 数据由 DeepSeek 网页搜索与抓取提供</p>
      <div>
        <button type="button" @click="guideOpen = true">搜索语法</button>
        <a href="https://api-docs.deepseek.com/zh-cn/guides/search" target="_blank" rel="noreferrer">
          API 文档 <ExternalLink :size="12" />
        </a>
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
            <div class="modal__kicker"><KeyRound :size="15" /> CONNECTION</div>
            <h2 id="settings-title">连接 DeepSeek</h2>
            <p class="modal__intro">
              当前应用为纯前端模式。Key 仅保存在这台浏览器中，但会直接随请求发送到 DeepSeek。
            </p>

            <label class="field-label" for="api-key">API Key</label>
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
              <span>{{ draftKey ? '已输入' : '为空' }}</span>
            </div>

            <div class="notice">
              <ShieldCheck :size="18" />
              <p>
                <strong>公开部署前请移除默认 Key。</strong>
                纯前端无法隐藏密钥；正式产品建议增加自有后端代理。
              </p>
            </div>

            <div class="modal__actions">
              <button class="text-button" type="button" @click="clearLocalKey">
                <Trash2 :size="14" /> 清除本地 Key
              </button>
              <button class="primary-button" type="button" @click="saveKey">保存连接</button>
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
            <div class="modal__kicker"><BookOpenText :size="15" /> SEARCH + FETCH</div>
            <h2 id="guide-title">先找范围，再读正文</h2>
            <p class="modal__intro">寻迹会把以下语法原样交给 DeepSeek 搜索服务，可与普通关键词组合使用。</p>
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
                <strong>网页抓取由你决定。</strong>
                打开结果后可手动抓取正文，不会自动请求；相同 URL 在当前会话内复用缓存。
              </p>
            </div>
            <a
              class="guide-link"
              href="https://api-docs.deepseek.com/zh-cn/guides/search"
              target="_blank"
              rel="noreferrer"
            >
              阅读完整搜索语法 <ArrowUpRight :size="15" />
            </a>
          </section>
        </div>
      </Transition>

      <Transition name="drawer">
        <div v-if="selectedResult" class="drawer-backdrop" @click.self="closeResult">
          <aside class="result-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
            <div class="drawer__head">
              <span>RESULT / {{ domainOf(selectedResult.url) }}</span>
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
                <span>{{ authorityLabel(selectedResult.authority) }}</span>
                <span>相关性 {{ scoreLabel(selectedResult.rerank_score) }}</span>
              </div>
              <a class="drawer__url" :href="selectedResult.url" target="_blank" rel="noreferrer">
                {{ selectedResult.url }} <ArrowUpRight :size="13" />
              </a>
              <div class="content-origin">
                <span :title="fetchedTitle || selectedResult.title">{{ contentSource }}</span>
                <span v-if="fetchedContent" class="content-origin__cached">SESSION CACHE</span>
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
                    {{ fetchStatus === 'loading' ? '正在抓取网页正文' : fetchStatus === 'error' ? '正文抓取失败' : '读取完整网页正文' }}
                  </h3>
                  <p v-if="fetchStatus === 'error'">{{ fetchError }}</p>
                  <p v-else>
                    通过 DeepSeek Fetch 将页面转为 Markdown。仅在你点击后请求，成功获取正文时约
                    ¥0.005 / 次。
                  </p>
                </div>
                <button type="button" :disabled="fetchStatus === 'loading'" @click="fetchResultContent">
                  <LoaderCircle v-if="fetchStatus === 'loading'" class="spin" :size="14" />
                  <BookOpenText v-else :size="14" />
                  {{ fetchStatus === 'loading' ? '抓取中' : fetchStatus === 'error' ? '重新抓取' : '抓取正文' }}
                </button>
              </div>
              <p v-else class="drawer__note">
                已显示完整正文。关闭后再次打开同一 URL，会优先复用当前会话缓存，不重复抓取。
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
