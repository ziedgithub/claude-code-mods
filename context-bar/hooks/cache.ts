import type { CacheInfo, CacheTtl } from '../types'

const GOOD_FROM = 80
const FAIR_FROM = 40
const MINUTE_MS = 60_000
const SECOND_MS = 1000

export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * MINUTE_MS, '1h': 60 * MINUTE_MS }
// What the engine picks for a main thread that may cache for an hour, which a session on a
// Claude subscription does, until a request shows otherwise
export const DEFAULT_TTL: CacheTtl = '1h'
// Past a TTL by this much, a request's hit or miss is the entry's lapse and not a race
const TTL_MARGIN_MS = 30_000
const WARM_FROM = 50
const COLD_BELOW = 10
export const COLD_TEXT = 'cold'

type RequestUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// The share of the prompt the cache served, out of all the input the request was answered
// over: what was read, what was written, and what went uncached
export const hitPercent = (usage: RequestUsage): number | null => {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return total === 0 ? null : Math.round((usage.cache_read_input_tokens / total) * 100)
}

export const isCacheTtl = (value: unknown): value is CacheTtl => value === '5m' || value === '1h'

// Each request that reads the cache renews its entry, so it lapses one TTL after the last.
// The clock is read once a second, so a request just made may postdate its last reading
export const remainingMs = (info: CacheInfo, ttl: CacheTtl, now: number): number =>
  info.requestAt === null ? 0 : Math.min(TTL_MS[ttl], Math.max(0, info.requestAt + TTL_MS[ttl] - now))

// Rounded up, so `~1m` still has the cache warm and nothing shows `~0m`
export const formatRemaining = (ms: number): string => {
  if (ms <= 0) return COLD_TEXT
  if (ms < MINUTE_MS) return `~${Math.ceil(ms / SECOND_MS)}s`
  return `~${Math.ceil(ms / MINUTE_MS)}m`
}

export const hitColor = (percent: number): string => {
  if (percent >= GOOD_FROM) return '#3fb950'
  if (percent >= FAIR_FROM) return '#ff9500'
  return '#f85149'
}

// A pause longer than five minutes and shorter than an hour tells the TTL apart: a cache
// still read means an hour, one gone means five minutes. A miss can also come from a
// prompt that changed meanwhile (an edited CLAUDE.md, a server connected), which the
// next long pause with a hit corrects
export const inferTtl = (prev: CacheInfo, model: string, hit: number, requestAt: number): CacheTtl | null => {
  if (prev.requestAt === null || prev.model !== model) return null
  const pause = requestAt - prev.requestAt
  if (pause < TTL_MS['5m'] + TTL_MARGIN_MS || pause > TTL_MS['1h'] - TTL_MARGIN_MS) return null
  if (hit >= WARM_FROM) return '1h'
  return hit < COLD_BELOW ? '5m' : null
}
