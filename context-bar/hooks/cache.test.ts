import { expect, test } from 'claude-code/testing'

import { formatRemaining, hitColor, remainingMs, ttlOf } from './cache'
import { hitPercent, inferRenewTtl, inferTtl, isCacheTtl } from './shared/cache-ttl'

test('hitPercent is the share of the input the cache served', () => {
  expect(hitPercent({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 })).toBe(90)
  expect(hitPercent({ input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 95 })).toBe(0)
  expect(hitPercent({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(null)
})

test('remainingMs counts down one TTL from the last request', () => {
  const info = { hitPercent: 90, requestAt: 1_000_000, model: 'm' }
  expect(remainingMs(info, '5m', 1_000_000 + 60_000)).toBe(240_000)
  expect(remainingMs(info, '1h', 1_000_000 + 3_600_000 + 1)).toBe(0)
  expect(remainingMs(info, '5m', 1_000_000 - 500)).toBe(300_000)
  expect(remainingMs({ hitPercent: 90, requestAt: null, model: 'm' }, '1h', 0)).toBe(0)
})

test('formatRemaining rounds up to the minute, then the second, then says cold', () => {
  expect(formatRemaining(3_600_000)).toBe('~60m')
  expect(formatRemaining(61_000)).toBe('~2m')
  expect(formatRemaining(60_000)).toBe('~1m')
  expect(formatRemaining(42_100)).toBe('~43s')
  expect(formatRemaining(0)).toBe('cold')
})

test('hitColor and isCacheTtl', () => {
  expect(hitColor(95)).toBe('#3fb950')
  expect(hitColor(50)).toBe('#ff9500')
  expect(hitColor(10)).toBe('#f85149')
  expect(isCacheTtl('5m')).toBe(true)
  expect(isCacheTtl('2h')).toBe(false)
})

test('inferTtl tells the TTL from what a request after a pause between five minutes and an hour read of the last entry', () => {
  const prev = { at: 0, model: 'claude-opus-5-5', tokens: 120_000 }
  const tokens = 121_000
  expect(inferTtl(prev, 'claude-opus-5-5', 118_000, tokens, 20 * 60_000)).toBe('1h')
  expect(inferTtl(prev, 'claude-opus-5-5', 2_000, tokens, 20 * 60_000)).toBe('5m')
  // A miss still reads the tools and the system prompt other sessions keep cached
  expect(inferTtl(prev, 'claude-opus-5-5', 36_000, tokens, 20 * 60_000)).toBe('5m')
  expect(inferTtl(prev, 'claude-opus-5-5', 78_000, tokens, 20 * 60_000)).toBe(null)
  // A long message pasted after the pause leaves the entry read whole
  expect(inferTtl(prev, 'claude-opus-5-5', 120_000, 240_000, 20 * 60_000)).toBe('1h')
  // On a small entry, that shared part alone reads warm, and tells nothing
  expect(inferTtl({ ...prev, tokens: 30_000 }, 'claude-opus-5-5', 26_000, 31_000, 20 * 60_000)).toBe(null)
  // Usage summed over an advisor's steps: an entry that seems twice its size
  expect(inferTtl({ ...prev, tokens: 230_000 }, 'claude-opus-5-5', 107_000, 110_000, 20 * 60_000)).toBe(null)
  expect(inferTtl(prev, 'claude-opus-5-5', 2_000, tokens, 4 * 60_000)).toBe(null)
  expect(inferTtl(prev, 'claude-opus-5-5', 2_000, tokens, 2 * 3_600_000)).toBe(null)
  expect(inferTtl(prev, 'claude-sonnet-5-5', 2_000, tokens, 20 * 60_000)).toBe(null)
  expect(inferTtl({ ...prev, at: null }, 'claude-opus-5-5', 118_000, tokens, 20 * 60_000)).toBe(null)
})

test("inferRenewTtl tells a fork's entry from what a read after it found of it, the tools' cache aside", () => {
  expect(inferRenewTtl(0, 120_000, 114_000, 121_000, 20 * 60_000)).toBe('1h')
  expect(inferRenewTtl(0, 120_000, 36_000, 121_000, 20 * 60_000)).toBe('5m')
  expect(inferRenewTtl(0, 120_000, 84_000, 121_000, 20 * 60_000)).toBe(null)
  expect(inferRenewTtl(0, 120_000, 114_000, 121_000, 3 * 60_000)).toBe(null)
})

test("ttlOf counts a fork's entry down on the renewal's TTL once it is known", () => {
  const request = { hitPercent: 90, requestAt: 0, model: 'm' }
  expect(ttlOf(request, { cache: '1h', renew: '5m' })).toBe('1h')
  expect(ttlOf({ ...request, isFork: true }, { cache: '1h', renew: '5m' })).toBe('5m')
  expect(ttlOf({ ...request, isFork: true }, { cache: '1h', renew: null })).toBe('1h')
})
