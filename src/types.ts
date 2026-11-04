export interface SearchResult {
  rerank_score: number
  title: string
  url: string
  snippet: string
  summary: string
  content: string
  site_name: string | null
  site_icon: string | null
  date: string | null
  authority: number
}

export interface SearchResponse {
  results: SearchResult[]
}

export interface FetchResponse {
  title: string
  content: string
}

export interface ApiErrorShape {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

export type TimeRange = 'any' | 'day' | 'week' | 'month' | 'year'
export type Language = 'auto' | 'zh' | 'en'
export type SortMode = 'relevance' | 'newest'

export interface SearchFilters {
  time: TimeRange
  language: Language
  site: string
  count: number
  needContent: boolean
}
