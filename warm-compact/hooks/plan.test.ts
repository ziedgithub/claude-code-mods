import { expect, test } from 'claude-code/testing'

import { hitPercent, inferRenewTtl, inferTtl, plan, warnText } from './plan'

const MIN = 60_000
const last = { at: 0, model: 'opus' }
const moment = { now: 0, ttl: '1h' as const, leadMs: MIN, model: 'opus', tokens: 120_000, minTokens: 50_000, isTurnRunning: false, isCompactOn: true, isKeepWarmOn: false, maxRenewals: 2, kept: null, renewTtl: '1h' as const }

test('plan waits, warns for 30 s, then compacts a minute before the hour is up', () => {
  expect(plan(last, { ...moment, now: 58 * MIN })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now: 58.5 * MIN })).toEqual({ kind: 'warn', inMs: 30_000 })
  expect(plan(last, { ...moment, now: 59 * MIN })).toEqual({ kind: 'compact' })
  expect(plan(last, { ...moment, now: 60 * MIN - 6000 })).toEqual({ kind: 'compact' })
})

test('plan gives up once the cache is about to lapse or has', () => {
  expect(plan(last, { ...moment, now: 60 * MIN - 5000 })).toEqual({ kind: 'idle' })
  expect(plan(last, { ...moment, now: 61 * MIN })).toEqual({ kind: 'idle' })
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

test('inferRenewTtl reads how long a renewal held from a later read', () => {
  expect(inferRenewTtl(0, 95, 20 * MIN)).toBe('1h')
  expect(inferRenewTtl(0, 30, 20 * MIN)).toBe('5m')
  expect(inferRenewTtl(0, 70, 20 * MIN)).toBe(null)
  expect(inferRenewTtl(0, 95, 3 * MIN)).toBe(null)
})

test('with both off, nothing happens', () => {
  expect(plan(last, { ...moment, isCompactOn: false, now: 59 * MIN })).toEqual({ kind: 'idle' })
})

test('inferTtl reads the TTL off a pause between five minutes and an hour', () => {
  expect(inferTtl(last, 'opus', 95, 20 * MIN)).toBe('1h')
  expect(inferTtl(last, 'opus', 2, 20 * MIN)).toBe('5m')
  expect(inferTtl(last, 'opus', 30, 20 * MIN)).toBe(null)
  expect(inferTtl(last, 'opus', 95, 2 * MIN)).toBe(null)
  expect(inferTtl(last, 'sonnet', 95, 20 * MIN)).toBe(null)
})

test('hitPercent and warnText', () => {
  expect(hitPercent({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 })).toBe(90)
  expect(hitPercent({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(null)
  expect(warnText(29_400)).toBe('⇊ compacting in 30s, before the cache goes cold · type to hold')
})
