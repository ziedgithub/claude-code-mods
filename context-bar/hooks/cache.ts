import type { CacheInfo, CacheTtl, LearnedTtl } from '../types'
import { TTL_MS } from './shared/cache-ttl'

const GOOD_FROM = 80
const FAIR_FROM = 40
const MINUTE_MS = 60_000
const SECOND_MS = 1000
export const COLD_TEXT = 'cold'

// A fork's entry may not last as long as one a request of the conversation leaves
export const ttlOf = (info: CacheInfo, ttls: LearnedTtl): CacheTtl =>
  info.isFork === true ? (ttls.renew ?? ttls.cache) : ttls.cache

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

