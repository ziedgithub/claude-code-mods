import { expect, test } from 'claude-code/testing'

import { isWake, limitText, nearLimit, plan, upcoming, warnText } from './plan'
import { hitPercent, inferRenewTtl, inferTtl } from './shared/cache-ttl'

const MIN = 60_000
const last = { at: 0, model: 'opus' }
const moment = { now: 0, ttl: '1h' as const, leadMs: MIN, model: 'opus', tokens: 120_000, minTokens: 50_000, isTurnRunning: false, isCompactOn: true, isKeepWarmOn: false, maxRenewals: 2, kept: null, renewTtl: '1h' as const, heldUntil: null }

test('plan waits, warns for 30 s, then compacts a minute before the hour is up', () => {
  expect(plan(last, { ...moment, now: 58 * MIN })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now: 58.5 * MIN })).toEqual({ kind: 'warn', inMs: 30_000 })
  expect(plan(last, { ...moment, now: 59 * MIN })).toEqual({ kind: 'compact' })
  expect(plan(last, { ...moment, now: 60 * MIN - 15_000 })).toEqual({ kind: 'compact' })
})

test('plan gives up once the cache is about to lapse or has', () => {
  expect(plan(last, { ...moment, now: 60 * MIN - 14_000 })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now: 61 * MIN })).toEqual({ kind: 'idle' })
})

test('plan holds a compaction off for someone back, then announces it again, if the entry still holds', () => {
  // Back until 59:30: the countdown starts again at 59:00, the compaction at 59:30
  const heldUntil = 59.5 * MIN
  expect(plan(last, { ...moment, now: 58.75 * MIN, heldUntil })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now: 59 * MIN, heldUntil })).toEqual({ kind: 'warn', inMs: 30_000 })
  expect(plan(last, { ...moment, now: 59.5 * MIN, heldUntil })).toEqual({ kind: 'compact' })
  // A hold that ends too close to the lapse, or a draft in the box, leaves the pause alone
  expect(plan(last, { ...moment, now: 59.5 * MIN, heldUntil: 60 * MIN - 14_000 })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now: 59 * MIN, heldUntil: Infinity })).toEqual({ kind: 'idle' })
  // A hold over before the compaction is due changes nothing
  expect(plan(last, { ...moment, now: 58.5 * MIN, heldUntil: 50 * MIN })).toEqual({ kind: 'warn', inMs: 30_000 })
  // A renewal goes on for someone back
  expect(plan(last, { ...moment, isKeepWarmOn: true, now: 59 * MIN, heldUntil: Infinity })).toEqual({ kind: 'renew' })
})

test('plan follows a five-minute cache', () => {
  expect(plan(last, { ...moment, ttl: '5m', now: 3.5 * MIN })).toEqual({ kind: 'warn', inMs: 30_000 })
  expect(plan(last, { ...moment, ttl: '5m', now: 4 * MIN })).toEqual({ kind: 'compact' })
  // A lead past the TTL still leaves the warning its time
  expect(plan(last, { ...moment, ttl: '5m', leadMs: 10 * MIN, now: 0 })).toEqual({ kind: 'warn', inMs: 30_000 })
  expect(plan(last, { ...moment, ttl: '5m', leadMs: 10 * MIN, now: 30_000 })).toEqual({ kind: 'compact' })
})

test('plan leaves a running turn, a switched model, a small or unmeasured conversation and a new prefix alone', () => {
  const now = 59 * MIN
  expect(plan(last, { ...moment, now, isTurnRunning: true })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now, model: 'sonnet' })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now, tokens: 40_000 })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now, tokens: undefined })).toEqual({ kind: 'idle' })
  expect(plan({ ...last, at: null }, { ...moment, now })).toEqual({ kind: 'idle' })
  expect(plan(null, { ...moment, now })).toEqual({ kind: 'idle' })
})

test('keep warm renews the cache before each lapse, then hands over to a compaction', () => {
  const warm = { ...moment, isKeepWarmOn: true }
  // No countdown before a renewal
  expect(plan(last, { ...warm, now: 58.7 * MIN })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...warm, now: 59 * MIN })).toEqual({ kind: 'renew' })
  // The renewal at 59 minutes moves the lapse an hour on
  const once = { at: 59 * MIN, count: 1 }
  expect(plan(last, { ...warm, kept: once, now: 61 * MIN })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...warm, kept: once, now: 118 * MIN })).toEqual({ kind: 'renew' })
  // After the last renewal, the compaction, announced
  const twice = { at: 118 * MIN, count: 2 }
  expect(plan(last, { ...warm, kept: twice, now: 176.5 * MIN })).toEqual({ kind: 'warn', inMs: 30_000 })
  expect(plan(last, { ...warm, kept: twice, now: 177 * MIN })).toEqual({ kind: 'compact' })
  // With compaction off, the cache is let go
  expect(plan(last, { ...warm, isCompactOn: false, kept: twice, now: 177 * MIN })).toEqual({ kind: 'idle' })
})

test('a renewal that holds five minutes is renewed again within them', () => {
  const warm = { ...moment, isKeepWarmOn: true, renewTtl: '5m' as const, maxRenewals: 3 }
  const once = { at: 59 * MIN, count: 1 }
  expect(plan(last, { ...warm, kept: once, now: 63 * MIN })).toEqual({ kind: 'renew' })
})

test('inferRenewTtl reads how long a renewal held from what a later read found of its entry', () => {
  expect(inferRenewTtl(0, 120_000, 114_000, 121_000, 20 * MIN)).toBe('1h')
  expect(inferRenewTtl(0, 120_000, 36_000, 121_000, 20 * MIN)).toBe('5m')
  expect(inferRenewTtl(0, 120_000, 84_000, 121_000, 20 * MIN)).toBe(null)
  expect(inferRenewTtl(0, 120_000, 114_000, 121_000, 3 * MIN)).toBe(null)
  // An entry too small to tell from the shared tools and system prompt, or of no known size
  expect(inferRenewTtl(0, 30_000, 29_000, 31_000, 20 * MIN)).toBe(null)
  expect(inferRenewTtl(0, undefined, 114_000, 121_000, 20 * MIN)).toBe(null)
})

test('inferTtl reads the TTL off a pause between five minutes and an hour, from what was read of the last entry', () => {
  const entry = { ...last, tokens: 120_000 }
  expect(inferTtl(entry, 'opus', 114_000, 121_000, 20 * MIN)).toBe('1h')
  expect(inferTtl(entry, 'opus', 2_000, 121_000, 20 * MIN)).toBe('5m')
  // A miss still reads the tools and the system prompt other sessions keep cached
  expect(inferTtl(entry, 'opus', 26_000, 121_000, 20 * MIN)).toBe('5m')
  expect(inferTtl(entry, 'opus', 78_000, 121_000, 20 * MIN)).toBe(null)
  // A long message pasted after the pause leaves the entry read whole
  expect(inferTtl(entry, 'opus', 120_000, 240_000, 20 * MIN)).toBe('1h')
  // On a small entry, that shared part alone reads warm, and tells nothing
  expect(inferTtl({ ...last, tokens: 30_000 }, 'opus', 26_000, 31_000, 20 * MIN)).toBe(null)
  // Usage summed over an advisor's steps: an entry that seems twice its size, or a read that does
  expect(inferTtl({ ...last, tokens: 230_000 }, 'opus', 107_000, 110_000, 20 * MIN)).toBe(null)
  expect(inferTtl(entry, 'opus', 240_000, 245_000, 20 * MIN)).toBe(null)
  expect(inferTtl(last, 'opus', 114_000, 121_000, 20 * MIN)).toBe(null)
  expect(inferTtl(entry, 'opus', 114_000, 121_000, 2 * MIN)).toBe(null)
  expect(inferTtl(entry, 'sonnet', 114_000, 121_000, 20 * MIN)).toBe(null)
})

test('hitPercent and warnText', () => {
  expect(hitPercent({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 })).toBe(90)
  expect(hitPercent({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(null)
  expect(warnText(29_400)).toBe('⇊ compacting in 30s, before the cache goes cold · type to hold')
})

test('upcoming says what the pause holds and when, whatever the time or a running turn', () => {
  const compact = { kind: 'compact', at: 59 * MIN, expiresAt: 60 * MIN }
  expect(upcoming(last, moment)).toEqual(compact)
  expect(upcoming(last, { ...moment, now: 90 * MIN, isTurnRunning: true })).toEqual(compact)
  expect(upcoming(last, { ...moment, isKeepWarmOn: true })).toEqual({ ...compact, kind: 'renew' })
  // Its renewals spent, keep warm hands the pause over to a compaction an hour after the last
  expect(upcoming(last, { ...moment, isKeepWarmOn: true, kept: { at: 59 * MIN, count: 2 } })).toEqual({ kind: 'compact', at: 118 * MIN, expiresAt: 119 * MIN })
  expect(upcoming(last, { ...moment, tokens: 20_000 })).toBe(null)
  expect(upcoming(last, { ...moment, isCompactOn: false })).toBe(null)
  expect(upcoming({ at: null, model: 'opus' }, moment)).toBe(null)
})

test('a tick long after the last one is a wake from sleep', () => {
  expect(isWake(null, 100_000)).toBe(false)
  expect(isWake(100_000, 101_000)).toBe(false)
  expect(isWake(100_000, 130_000)).toBe(false)
  expect(isWake(100_000, 131_000)).toBe(true)
})

test('nearLimit finds the first window used past 90% that has not reset since, and limitText names it', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  expect(nearLimit([], now)).toBe(null)
  expect(nearLimit([{ kind: 'five_hour', percentUsed: 89.9 }], now)).toBe(null)
  const limit = nearLimit([{ kind: 'five_hour', percentUsed: 20 }, { kind: 'seven_day', percentUsed: 90 }], now)
  expect(limit).toEqual({ kind: 'seven_day', percentUsed: 90 })
  expect(nearLimit([{ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-16T11:59:00Z' }], now)).toBe(null)
  expect(nearLimit([{ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-16T12:30:00Z' }], now)).toEqual({ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-16T12:30:00Z' })
  expect(limitText({ kind: 'seven_day', percentUsed: 90 })).toBe('warm-compact left this pause alone: 90% of your weekly limit is used.')
  expect(limitText({ kind: 'gateway_budget', percentUsed: 101.5 })).toBe('warm-compact left this pause alone: 102% of your gateway budget limit is used.')
})
