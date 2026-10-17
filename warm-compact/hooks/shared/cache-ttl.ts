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
// What a request read from the cache is set against the entry the last read left, all that read
// was answered over: one that holds is read whole, whatever is added after it (a long message
// pasted in), and one that lapsed leaves only the tools and the system prompt other sessions keep
// cached, some 25k tokens, half a small conversation, a fifth of a large one. So under half of
// the entry read found it gone, and only 80% or more of an entry large enough that the shared
// part cannot reach it found it whole
const WARM_FROM = 80
const COLD_BELOW = 50
const TELLING_TOKENS = 50_000
// Past a renewal, a read this warm found the conversation, and one this cold found only
// the tools and the system prompt, which other sessions keep cached
const RENEWED_FROM = 90
const LAPSED_BELOW = 50

type RequestUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// All the input the request was answered over: what was read, what was written, and what went
// uncached
export const inputTokens = (usage: RequestUsage): number => usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

// The share of the prompt the cache served, out of all its input
export const hitPercent = (usage: RequestUsage): number | null => {
  const total = inputTokens(usage)
  return total === 0 ? null : Math.round((usage.cache_read_input_tokens / total) * 100)
}

export const isCacheTtl = (value: unknown): value is CacheTtl => value === '5m' || value === '1h'

// Only a pause longer than five minutes and shorter than an hour tells the two TTLs apart
const isTelling = (pause: number): boolean =>
  pause >= TTL_MS['5m'] + TTL_MARGIN_MS && pause <= TTL_MS['1h'] - TTL_MARGIN_MS

// A conversation only grows between two requests: a later one answered over less than this share of
// the entry, or reading more than SERVED_ABOVE of it, went through something the figures do not
// show (a request whose usage is summed over its own server-side steps, as an advisor's is; a
// compaction or a /clear no hook was told of), and tells nothing
const SHRUNK_BELOW = 90
const SERVED_ABOVE = 150

// The share of an entry of `tokens` a later request of `requestTokens` read, or null with no
// entry to set it against, or none the two figures can be trusted for
const servedOf = (read: number, tokens: number | undefined, requestTokens: number): number | null => {
  if (tokens === undefined || tokens <= 0 || requestTokens * 100 < tokens * SHRUNK_BELOW) return null
  const served = Math.round((read / tokens) * 100)
  return served > SERVED_ABOVE ? null : served
}

// `last`: the main thread's last request, when it left (null once a compaction changed the
// prefix), on which model, and all it was answered over. `read`: what the request after it read
// from the cache, out of the `tokens` it was answered over. Past a telling pause, an entry still read means an hour, one gone means five
// minutes. A miss can also come from a prompt that changed meanwhile (an edited CLAUDE.md, a
// server connected), which a long pause with a hit corrects, unless compactions take each pause
export const inferTtl = (last: { at: number | null; model: string; tokens?: number }, model: string, read: number, tokens: number, requestAt: number): CacheTtl | null => {
  if (last.at === null || last.model !== model || !isTelling(requestAt - last.at)) return null
  const served = servedOf(read, last.tokens, tokens)
  if (served === null) return null
  if (served < COLD_BELOW) return '5m'
  return served >= WARM_FROM && (last.tokens ?? 0) >= TELLING_TOKENS ? '1h' : null
}

// A renewal (a plugin's fork of the conversation) reads the entry without the hour-long TTL a
// session's own requests ask for. Whether it holds the entry, of `tokens`, an hour or five
// minutes shows in what a read of `readTokens` a telling pause after it finds
export const inferRenewTtl = (renewedAt: number, tokens: number | undefined, read: number, readTokens: number, readAt: number): CacheTtl | null => {
  if (!isTelling(readAt - renewedAt)) return null
  const served = servedOf(read, tokens, readTokens)
  if (served === null) return null
  if (served >= RENEWED_FROM && (tokens ?? 0) >= TELLING_TOKENS) return '1h'
  return served < LAPSED_BELOW ? '5m' : null
}
