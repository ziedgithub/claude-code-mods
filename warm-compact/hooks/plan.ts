import type { CacheTtl, Kept, LastRequest, Upcoming } from '../types'
import { TTL_MS } from './shared/cache-ttl'

const SECOND_MS = 1000

// The countdown shows this long before the compaction starts
export const WARN_MS = 30 * SECOND_MS
// A compaction or a renewal started this close to the lapse may reach the API after it, and
// miss: none starts later
export const LATE_MS = 15 * SECOND_MS
// The shortest lead: past LATE_MS, a few ticks to start in, as ticks fall anywhere in a second
export const MIN_LEAD_MS = LATE_MS + 5 * SECOND_MS
// Ticks come a second apart. A longer gap is the computer asleep or the process stalled:
// what the cache did meanwhile is unknown, Claude Code's keep-alive having stopped with it
export const WAKE_GAP_MS = 30 * SECOND_MS

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
  // Until when someone back holds a compaction off: a minute past their last edit of the prompt
  // box, or for as long as a draft sits in it (Infinity); null when nobody is
  heldUntil: number | null
}

export type Plan = { kind: 'idle' } | { kind: 'warn'; inMs: number } | { kind: 'compact' } | { kind: 'renew' }

const IDLE: Plan = { kind: 'idle' }

// Each request renews the entry, so it lapses one TTL after the last, or after the last
// renewal keep warm made. Before it does, keep warm renews it again, up to `maxRenewals`
// times in a pause, and then a compaction takes over. Either starts `leadMs` ahead, while
// its own request can still read the conversation from the cache. A switched model has none
// of the conversation cached, and a small conversation costs little to read cold. What the
// pause holds, whatever the time, is what other mods show: context-bar beside its countdown
export const upcoming = (last: LastRequest | null, m: Moment): Upcoming | null => {
  if (last === null || last.at === null || last.model !== m.model) return null
  if (m.tokens === undefined || m.tokens < m.minTokens) return null
  const renewals = m.kept?.count ?? 0
  const kind = m.isKeepWarmOn && renewals < m.maxRenewals ? 'renew' : m.isCompactOn ? 'compact' : null
  if (kind === null) return null
  const ttlMs = m.kept === null ? TTL_MS[m.ttl] : TTL_MS[m.renewTtl]
  const expiresAt = (m.kept?.at ?? last.at) + ttlMs
  return { kind, at: expiresAt - Math.min(m.leadMs, ttlMs - WARN_MS), expiresAt }
}

// When what is in store starts: someone back holds a compaction off until the hold is over; a
// renewal goes on, as it keeps the cache for them
export const startOf = (next: Upcoming, heldUntil: number | null): number =>
  next.kind === 'compact' && heldUntil !== null ? Math.max(next.at, heldUntil) : next.at

// Whether it can still start in time, now or when due
export const isInTime = (next: Upcoming, heldUntil: number | null, now: number): boolean =>
  Math.max(startOf(next, heldUntil), now) <= next.expiresAt - LATE_MS

// A compaction is announced for WARN_MS before it starts, held off or not; a renewal changes
// nothing anyone sees. A turn renews the entry by itself
export const plan = (last: LastRequest | null, m: Moment): Plan => {
  const next = m.isTurnRunning ? null : upcoming(last, m)
  if (next === null || !isInTime(next, m.heldUntil, m.now)) return IDLE
  const at = startOf(next, m.heldUntil)
  if (m.now >= at) return { kind: next.kind }
  if (next.kind === 'compact' && m.now >= at - WARN_MS) return { kind: 'warn', inMs: at - m.now }
  return IDLE
}

// Near a rate limit, what a compaction or a renewal would spend is better left to the person,
// as Claude Code's own idle compaction leaves it
export const LIMIT_FROM = 90

const LIMIT_NAMES: Record<string, string> = { five_hour: 'five-hour', seven_day: 'weekly', spend_limit: 'spend' }

// The first rate-limit window used past LIMIT_FROM, or null. The figures are the last
// response's, so a window that has reset since no longer counts
export const nearLimit = <L extends { kind: string; percentUsed: number; resetsAt?: string }>(limits: readonly L[], now: number): L | null =>
  limits.find(l => l.percentUsed >= LIMIT_FROM && !(l.resetsAt !== undefined && Date.parse(l.resetsAt) <= now)) ?? null

export const limitText = (limit: { kind: string; percentUsed: number }): string =>
  `warm-compact left this pause alone: ${Math.round(limit.percentUsed)}% of your ${LIMIT_NAMES[limit.kind] ?? limit.kind.replace(/_/g, ' ')} limit is used.`

export const warnText = (inMs: number): string => `⇊ compacting in ${Math.ceil(inMs / SECOND_MS)}s, before the cache goes cold · type to hold`

// Whether the tick at `now` follows one long enough ago that the computer slept between
export const isWake = (lastTickAt: number | null, now: number): boolean => lastTickAt !== null && now - lastTickAt > WAKE_GAP_MS
