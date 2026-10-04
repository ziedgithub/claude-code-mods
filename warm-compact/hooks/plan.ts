import type { CacheTtl, Kept, LastRequest } from '../types'

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
// The countdown shows this long before the compaction starts
export const WARN_MS = 30 * SECOND_MS
// A compaction started this close to the lapse may reach the API after it
export const LATE_MS = 5 * SECOND_MS

type RequestUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// The share of the prompt the cache served, out of all the input the request was answered over
export const hitPercent = (usage: RequestUsage): number | null => {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return total === 0 ? null : Math.round((usage.cache_read_input_tokens / total) * 100)
}

export const isCacheTtl = (value: unknown): value is CacheTtl => value === '5m' || value === '1h'

// A pause longer than five minutes and shorter than an hour tells the TTL apart: a cache
// still read means an hour, one gone means five minutes. A miss can also come from a
// prompt that changed meanwhile (an edited CLAUDE.md, a server connected), which the
// next long pause with a hit corrects
export const inferTtl = (prev: LastRequest, model: string, hit: number, requestAt: number): CacheTtl | null => {
  if (prev.at === null || prev.model !== model) return null
  const pause = requestAt - prev.at
  if (pause < TTL_MS['5m'] + TTL_MARGIN_MS || pause > TTL_MS['1h'] - TTL_MARGIN_MS) return null
  if (hit >= WARM_FROM) return '1h'
  return hit < COLD_BELOW ? '5m' : null
}

// Past a renewal, a read this warm found the conversation, and one this cold found only
// the tools and the system prompt, which other sessions keep cached
const RENEWED_FROM = 90
const LAPSED_BELOW = 50

// A renewal reads the entry without the hour-long TTL a session's own requests ask for.
// Whether it holds the entry an hour or five minutes shows in what a read between the two
// after it finds
export const inferRenewTtl = (renewedAt: number, hit: number, readAt: number): CacheTtl | null => {
  const pause = readAt - renewedAt
  if (pause < TTL_MS['5m'] + TTL_MARGIN_MS || pause > TTL_MS['1h'] - TTL_MARGIN_MS) return null
  if (hit >= RENEWED_FROM) return '1h'
  return hit < LAPSED_BELOW ? '5m' : null
}

export type Moment = {
  now: number
  ttl: CacheTtl
  leadMs: number
  // The session's model now: the cache entry is per model
  model: string
  // The conversation's size as the last response measured it
  tokens: number | undefined
  minTokens: number
  isTurnRunning: boolean
  isCompactOn: boolean
  isKeepWarmOn: boolean
  // The most renewals in one pause, after which a compaction takes over
  maxRenewals: number
  kept: Kept | null
  // How long a renewal holds the entry, which may be less than a request's TTL
  renewTtl: CacheTtl
}

export type Plan = { kind: 'idle' } | { kind: 'warn'; inMs: number } | { kind: 'compact' } | { kind: 'renew' }

const IDLE: Plan = { kind: 'idle' }

// Each request renews the entry, so it lapses one TTL after the last, or after the last
// renewal keep warm made. Before it does, keep warm renews it again, up to `maxRenewals`
// times in a pause, and then a compaction takes over. Either starts `leadMs` ahead, while
// its own request can still read the conversation from the cache. A compaction is
// announced for WARN_MS before it starts; a renewal changes nothing anyone sees. A turn
// renews the entry by itself; a switched model has none of the conversation cached, and a
// small conversation costs little to read cold
export const plan = (last: LastRequest | null, m: Moment): Plan => {
  if (last === null || last.at === null || m.isTurnRunning || last.model !== m.model) return IDLE
  if (m.tokens === undefined || m.tokens < m.minTokens) return IDLE
  const renewals = m.kept?.count ?? 0
  const action = m.isKeepWarmOn && renewals < m.maxRenewals ? 'renew' : m.isCompactOn ? 'compact' : null
  if (action === null) return IDLE
  const ttlMs = m.kept === null ? TTL_MS[m.ttl] : TTL_MS[m.renewTtl]
  const expiresAt = (m.kept?.at ?? last.at) + ttlMs
  const startAt = expiresAt - Math.min(m.leadMs, ttlMs - WARN_MS)
  if (m.now >= expiresAt - LATE_MS) return IDLE
  if (m.now >= startAt) return { kind: action }
  if (action === 'compact' && m.now >= startAt - WARN_MS) return { kind: 'warn', inMs: startAt - m.now }
  return IDLE
}

export const warnText = (inMs: number): string => `⇊ compacting in ${Math.ceil(inMs / SECOND_MS)}s, before the cache goes cold · type to hold`
