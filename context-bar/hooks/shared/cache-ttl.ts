// The master copy, kept at the repository's root: each mod that uses it holds a copy under
// hooks/shared/, as a mod loads and installs on its own. Edit it here, then run
// scripts/sync-shared.sh

// The mod's own contract names the two TTLs, for the values it keeps
import type { CacheTtl } from '../../types'

const MINUTE_MS = 60_000

export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * MINUTE_MS, '1h': 60 * MINUTE_MS }
// What the engine picks for a main thread that may cache for an hour, which a session on a
// Claude subscription does, until a request shows otherwise
export const DEFAULT_TTL: CacheTtl = '1h'
// Past a TTL by this much, a request's hit or miss is the entry's lapse and not a race
const TTL_MARGIN_MS = 30_000
const WARM_FROM = 50
const COLD_BELOW = 10
// Past a renewal, a read this warm found the conversation, and one this cold found only
// the tools and the system prompt, which other sessions keep cached
const RENEWED_FROM = 90
const LAPSED_BELOW = 50

type RequestUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// The share of the prompt the cache served, out of all the input the request was answered
// over: what was read, what was written, and what went uncached
export const hitPercent = (usage: RequestUsage): number | null => {
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return total === 0 ? null : Math.round((usage.cache_read_input_tokens / total) * 100)
}

export const isCacheTtl = (value: unknown): value is CacheTtl => value === '5m' || value === '1h'

// Only a pause longer than five minutes and shorter than an hour tells the two TTLs apart
const isTelling = (pause: number): boolean =>
  pause >= TTL_MS['5m'] + TTL_MARGIN_MS && pause <= TTL_MS['1h'] - TTL_MARGIN_MS

// `last`: the main thread's last request, when it left (null once a compaction changed the
// prefix) and on which model. Past a telling pause, a cache still read means an hour, one gone
// means five minutes. A miss can also come from a prompt that changed meanwhile (an edited
// CLAUDE.md, a server connected), which the next long pause with a hit corrects
export const inferTtl = (last: { at: number | null; model: string }, model: string, hit: number, requestAt: number): CacheTtl | null => {
  if (last.at === null || last.model !== model || !isTelling(requestAt - last.at)) return null
  if (hit >= WARM_FROM) return '1h'
  return hit < COLD_BELOW ? '5m' : null
}

// A renewal (a plugin's fork of the conversation) reads the entry without the hour-long TTL a
// session's own requests ask for. Whether it holds the entry an hour or five minutes shows in
// what a read a telling pause after it finds
export const inferRenewTtl = (renewedAt: number, hit: number, readAt: number): CacheTtl | null => {
  if (!isTelling(readAt - renewedAt)) return null
  if (hit >= RENEWED_FROM) return '1h'
  return hit < LAPSED_BELOW ? '5m' : null
}
