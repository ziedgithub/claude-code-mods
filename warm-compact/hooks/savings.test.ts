import { expect, test } from 'claude-code/testing'

import type { CompactionRecord } from '../types'
import { formatTokens, isRecord, readCost, recordsOf, savingOf } from './savings'

const RECORD: CompactionRecord = {
  at: 0,
  sessionId: 's1',
  model: 'claude-sonnet-5-5',
  ttl: '1h',
  before: 120_000,
  after: 2000,
  usage: { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 },
  isReturned: true,
}

test('readCost follows the model', () => {
  expect(readCost('claude-fable-5-1')).toBe(0.025)
  expect(readCost('claude-opus-5-5[1m]')).toBe(0.05)
  expect(readCost('claude-sonnet-5-5')).toBe(0.1)
  expect(readCost('claude-haiku-4-5-20251001')).toBe(0.1)
})

test('savingOf sets the spared re-read against the compaction and the summary', () => {
  // 0.1 × 120k read + 5 × 1k out, then 2 × 2k written back; 2 × 120k spared
  expect(savingOf(RECORD)).toEqual({ avoided: 240_000, spent: 12_000 + 5000 + 4000 })
  expect(savingOf({ ...RECORD, ttl: '5m' })).toEqual({ avoided: 150_000, spent: 12_000 + 5000 + 2500 })
})

test('savingOf counts only the cost of a compaction nobody came back to', () => {
  expect(savingOf({ ...RECORD, isReturned: false })).toEqual({ avoided: 0, spent: 17_000 })
})

test('savingOf estimates a compaction the engine reported no usage for', () => {
  expect(savingOf({ ...RECORD, usage: null, isReturned: false }).spent).toBe(12_000 + 10_000)
})

test('recordsOf keeps the well-formed records only', () => {
  expect(recordsOf([RECORD, { ...RECORD, ttl: '2h' }, null, 'x'])).toEqual([RECORD])
  expect(recordsOf(undefined)).toEqual([])
  expect(isRecord({ ...RECORD, usage: null })).toBe(true)
})

test('formatTokens', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(221_540)).toBe('222k')
  expect(formatTokens(2_140_000)).toBe('2.1M')
})
