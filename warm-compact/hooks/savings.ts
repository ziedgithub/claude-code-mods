import type { CacheTtl, CompactionRecord, CompactionUsage } from '../types'

const DAY_MS = 24 * 60 * 60_000
const WEEK_MS = 7 * DAY_MS
export const MAX_RECORDS = 1000
// What the API charges, in multiples of a plain input token: a cache write at each TTL,
// and output, on every current model
const WRITE_COST: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2 }
const OUTPUT_COST = 5
// A cache read is a tenth of an input token, less on the newest models
const READ_COSTS: readonly [RegExp, number][] = [
  [/fable-5-1|mythos-5-1/, 0.025],
  [/opus-5-5/, 0.05],
]
const DEFAULT_READ_COST = 0.1
// Below this share read from the cache, the compaction's request found the entry gone
const WARM_FROM = 50

export const readCost = (model: string): number => READ_COSTS.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_READ_COST

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isUsage = (value: unknown): value is CompactionUsage => {
  if (typeof value !== 'object' || value === null) return false
  const usage = value as Record<string, unknown>
  return ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(key => isNumber(usage[key]))
}

export const isRecord = (value: unknown): value is CompactionRecord => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    (record.kind === undefined || record.kind === 'renewal') &&
    isNumber(record.at) &&
    typeof record.sessionId === 'string' &&
    typeof record.model === 'string' &&
    (record.ttl === '5m' || record.ttl === '1h') &&
    isNumber(record.before) &&
    isNumber(record.after) &&
    (record.usage === null || isUsage(record.usage)) &&
    typeof record.isReturned === 'boolean'
  )
}

export const recordsOf = (stored: unknown): CompactionRecord[] => (Array.isArray(stored) ? stored.filter(isRecord) : [])

// What a compaction's request read from the cache, out of all it was answered over
export const compactionHit = (usage: CompactionUsage | null): number | null => {
  if (usage === null) return null
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return total === 0 ? null : Math.round((usage.cache_read_input_tokens / total) * 100)
}

export const isCacheMissed = (usage: CompactionUsage | null): boolean => {
  const hit = compactionHit(usage)
  return hit !== null && hit < WARM_FROM
}

export type Saving = { avoided: number; spent: number }

// In input-token equivalents. Coming back to a cold cache writes the whole conversation
// to it again. A renewal read the conversation instead, and wrote only its own tail, for
// five minutes. After a compaction, the summary is written on the way back, and the
// compaction itself read the conversation and wrote the summary. What was never gone back
// to, or went cold anyway, spared nothing and paid for itself. Requests after the first
// back read a smaller conversation too, which is left out, so the tally errs low
export const savingOf = (record: CompactionRecord): Saving => {
  const write = WRITE_COST[record.ttl]
  const usage = record.usage
  if (record.kind === 'renewal') {
    const renewal =
      usage === null
        ? readCost(record.model) * record.before
        : readCost(record.model) * usage.cache_read_input_tokens +
          WRITE_COST['5m'] * usage.cache_creation_input_tokens +
          usage.input_tokens +
          OUTPUT_COST * usage.output_tokens
    return { avoided: record.isReturned ? write * record.before : 0, spent: renewal }
  }
  const compaction =
    usage === null
      ? readCost(record.model) * record.before + OUTPUT_COST * record.after
      : readCost(record.model) * usage.cache_read_input_tokens +
        write * usage.cache_creation_input_tokens +
        usage.input_tokens +
        OUTPUT_COST * usage.output_tokens
  if (!record.isReturned) return { avoided: 0, spent: compaction }
  return { avoided: write * record.before, spent: compaction + write * record.after }
}

export const formatTokens = (tokens: number): string => {
  const size = Math.abs(tokens)
  if (size >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (size >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(Math.round(tokens))
}

const signed = (tokens: number): string => (tokens >= 0 ? `+${formatTokens(tokens)}` : `-${formatTokens(-tokens)}`)

type Row = { label: string; records: CompactionRecord[] }

const rowText = ({ label, records }: Row): string => {
  const savings = records.map(savingOf)
  const net = savings.reduce((sum, s) => sum + s.avoided - s.spent, 0)
  const returned = records.filter(r => r.isReturned).length
  const renewals = records.filter(r => r.kind === 'renewal').length
  return [
    label.padEnd(14),
    String(records.length - renewals).padStart(11),
    String(renewals).padStart(10),
    String(returned).padStart(11),
    (records.length === 0 ? '-' : signed(net)).padStart(11),
  ].join('')
}

export const statsText = (records: readonly CompactionRecord[], now: number, sessionId: string): string => {
  const rows: Row[] = [
    { label: 'This session', records: records.filter(r => r.sessionId === sessionId) },
    { label: 'Last 7 days', records: records.filter(r => now - r.at < WEEK_MS) },
    { label: 'All time', records: [...records] },
  ]
  return [
    'Savings, in input tokens (a cache write at 1h counts as 2, a cache read as 0.1 or less):',
    '',
    `${''.padEnd(14)}${'compactions'.padStart(11)}${'renewals'.padStart(10)}${'came back'.padStart(11)}${'net saved'.padStart(11)}`,
    ...rows.map(rowText),
    '',
    'A compaction, or the last renewal before you came back, counts once its session goes on: the re-read it spared is set against what it cost. What was never gone back to counts its cost alone.',
  ].join('\n')
}

const pad = (n: number): string => String(n).padStart(2, '0')

export const clockTime = (at: number): string => {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// The transcript's lasting line, for whoever comes back to the session
export const noticeText = (record: CompactionRecord, hasSizes: boolean): string => {
  const sizes = hasSizes ? ` (${formatTokens(record.before)} → ${formatTokens(record.after)} tokens)` : ''
  if (isCacheMissed(record.usage)) {
    return `Compacted at ${clockTime(record.at)}${sizes}, but the prompt cache had already lapsed, so this one saved nothing.`
  }
  return `Compacted at ${clockTime(record.at)}${sizes}, just before the prompt cache went cold. The conversation goes on from the summary.`
}
