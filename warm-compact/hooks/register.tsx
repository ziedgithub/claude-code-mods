import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheTtl, CompactionRecord, CompactionUsage } from '../types'
import { CHIP_ROW_KEY, splitChipRow } from './chips'
import { DEFAULT_TTL, TTL_MS, hitPercent, inferRenewTtl, inferTtl, isCacheTtl, plan, warnText } from './plan'
import { MAX_RECORDS, clockTime, compactionHit, noticeText, recordsOf, statsText } from './savings'

const TICK_MS = 1000
const CACHE_TTL_KEY = 'cacheTtl'
const RECORDS_KEY = 'compactions'
const RENEW_TTL_KEY = 'renewTtl'
// The models a renewal could not read the conversation from the cache on, each with the
// engine version that failed: tried again once the engine changes
const RENEW_MISSES_KEY = 'renewMisses'
// The fork that renews the cache asks for as little as it can
const RENEW_PROMPT = 'Reply with the single word: ok'
// A renewal that read less of its request from the cache than this missed the entry
const RENEW_HIT_FROM = 90
const DEFAULT_MIN_TOKENS = 50_000
const DEFAULT_LEAD_SECONDS = 60
const DEFAULT_MAX_RENEWALS = 2
// Never so close to the lapse that the compaction's request could miss the cache
const MIN_LEAD_MS = 15_000
const DONE_TEXT = 'Compacted before the prompt cache went cold'
const COMMAND = 'warm-compact'
const KEEP_WARM_COMMAND = 'keep-warm'
const COMPACT_LABEL = 'Warm compact'
const KEEP_WARM_LABEL = 'Keep warm'
const ON_COLOR = '#238636'
const OFF_COLOR = '#6e7681'

const last = atom({ plugin: 'warm-compact', key: 'last' } as const, null)
const isTurnRunning = atom({ plugin: 'warm-compact', key: 'isTurnRunning' } as const, false)
const isEnabled = atom({ plugin: 'warm-compact', key: 'isEnabled' } as const, true)
const isKeepWarm = atom({ plugin: 'warm-compact', key: 'isKeepWarm' } as const, false)
const kept = atom({ plugin: 'warm-compact', key: 'kept' } as const, null)
const pendingRecord = atom({ plugin: 'warm-compact', key: 'pendingRecord' } as const, null)

let cacheTtl: CacheTtl = DEFAULT_TTL
let shownStatus: string | undefined
let isCompacting = false
// The renewal or compaction last tried, named by the request and the renewals since: one
// try each, whatever came of it
let triedFor: string | null = null
let maxRenewals = DEFAULT_MAX_RENEWALS
// Until a read after a renewal shows otherwise, it holds the entry as long as a request does
let renewTtl: CacheTtl | null = null
let renewMisses: Record<string, string> = {}
let engineVersion = ''
// Each reason keep warm stood down is said once a session
const saidOnce = new Set<string>()
let minTokens = DEFAULT_MIN_TOKENS
let leadMs = DEFAULT_LEAD_SECONDS * 1000

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

const showStatus = ($: EngineInterface, text: string | undefined): void => {
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

// Passes the response on as it streams, seeing each chunk on the way
async function* tap<T, R>(stream: AsyncGenerator<T, R>, see: (chunk: T) => Promise<void>): AsyncGenerator<T, R> {
  for (;;) {
    const step = await stream.next()
    if (step.done === true) return step.value
    await see(step.value)
    yield step.value
  }
}

// The engine keeps its TTL to itself: a request after a long enough pause tells it, and it
// is kept between sessions since it holds for the account
const learnTtl = async ($: EngineInterface, ttl: CacheTtl | null): Promise<void> => {
  if (ttl === null || ttl === cacheTtl) return
  cacheTtl = ttl
  await $.store.set(CACHE_TTL_KEY, ttl)
}

// A compaction leaves a new prefix, which the cache has none of yet
const forgetRequest = async ($: EngineInterface): Promise<void> => {
  await update($, last, prev => (prev === null ? prev : { ...prev, at: null }))
  await update($, kept, () => null)
}

// A fork re-sends the main thread's last request with one more message after it: it reads
// the conversation from the cache, which renews the entry, and leaves the transcript as
// it was. Resolves when the request started and what it cost, or null when there was
// nothing to fork
const renewCache = async ($: EngineInterface): Promise<{ at: number; usage: CompactionUsage } | null> => {
  const at = await $.clock.now()
  const result = await $.model.fork({ prompt: RENEW_PROMPT })
  if (!result.isAnswered && result.reason === 'nothing-to-fork') return null
  return { at, usage: result.usage }
}

// A renewal that missed the entry wrote the conversation to the cache again itself, so a
// compaction right after reads it from there. One missing after an earlier renewal shows
// that renewal held five minutes; a first one, that this model's renewals miss
const renew = async ($: EngineInterface, model: string, isCompactOn: boolean, tokens: number): Promise<void> => {
  isCompacting = true
  try {
    const renewal = await renewCache($)
    if (renewal === null) return
    const previous = await read($, kept)
    const { usage } = renewal
    const record: CompactionRecord = {
      kind: 'renewal',
      at: renewal.at,
      sessionId: await $.session.id(),
      model,
      ttl: cacheTtl,
      before: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      after: 0,
      usage,
      isReturned: false,
    }
    await addRecord($, record)
    const hit = compactionHit(usage) ?? 0
    if (previous !== null) await learnRenewTtl($, inferRenewTtl(previous.at, hit, renewal.at))
    if (hit < RENEW_HIT_FROM) {
      if (previous === null) await noteRenewMiss($, model)
      $.ui.log(
        `Keep warm: the renewal at ${clockTime(renewal.at)} found the prompt cache gone${isCompactOn ? ', so warm compact takes over' : ''}.`,
      )
      if (isCompactOn) await compact($, model, tokens)
      return
    }
    const count = (previous?.count ?? 0) + 1
    await update($, kept, () => ({ at: renewal.at, count }))
    await update($, pendingRecord, () => renewal.at)
    $.ui.log(`Kept the prompt cache warm at ${clockTime(renewal.at)} (${count} of ${maxRenewals}).`)
  } finally {
    isCompacting = false
  }
}

const addRecord = async ($: EngineInterface, record: CompactionRecord): Promise<void> => {
  const records = recordsOf(await $.store.get(RECORDS_KEY))
  await $.store.set(RECORDS_KEY, [...records, record].slice(-MAX_RECORDS))
}

// The session going on after a compaction, or while a renewal still holds the cache, is
// when the re-read it spared would have been paid
const markReturned = async ($: EngineInterface): Promise<void> => {
  const at = await read($, pendingRecord)
  if (at === null) return
  await update($, pendingRecord, () => null)
  const records = recordsOf(await $.store.get(RECORDS_KEY))
  const now = await $.clock.now()
  const isKept = (r: CompactionRecord): boolean => r.kind !== 'renewal' || now < r.at + TTL_MS[renewTtl ?? r.ttl]
  await $.store.set(RECORDS_KEY, records.map(r => (r.at === at && isKept(r) ? { ...r, isReturned: true } : r)))
}

const sayOnce = ($: EngineInterface, text: string): void => {
  if (saidOnce.has(text)) return
  saidOnce.add(text)
  $.ui.log(text)
}

const learnRenewTtl = async ($: EngineInterface, ttl: CacheTtl | null): Promise<void> => {
  if (ttl === null || ttl === renewTtl) return
  renewTtl = ttl
  await $.store.set(RENEW_TTL_KEY, ttl)
}

const noteRenewMiss = async ($: EngineInterface, model: string): Promise<void> => {
  renewMisses = { ...renewMisses, [model]: engineVersion }
  await $.store.set(RENEW_MISSES_KEY, renewMisses)
}

// Why keep warm cannot help here, or null when it can: a renewal that holds five minutes
// would cost more than a compaction to cover an hour-long cache, and a model whose renewals
// missed would pay for the whole conversation each time
const keepWarmBlock = (model: string): string | null => {
  if (cacheTtl === '1h' && renewTtl === '5m') return 'Keep warm: a renewal holds this account\'s cache for 5 minutes only, so warm compact takes over.'
  if (renewMisses[model] === engineVersion) return `Keep warm: renewals can't read the conversation from the cache on ${model} with this Claude Code version, so warm compact takes over.`
  return null
}

// A plugin's own compaction skips its own hooks, so the request is forgotten here. The toast
// is for someone watching; the transcript line is for whoever comes back
const compact = async ($: EngineInterface, model: string, tokens: number): Promise<void> => {
  isCompacting = true
  showStatus($, undefined)
  try {
    const result = await $.session.compact()
    if (result.skip !== undefined) return
    await forgetRequest($)
    const record: CompactionRecord = {
      at: await $.clock.now(),
      sessionId: await $.session.id(),
      model,
      ttl: cacheTtl,
      before: result.tokensBefore ?? tokens,
      after: result.tokensAfter ?? result.usage?.output_tokens ?? 0,
      usage: result.usage ?? null,
      isReturned: false,
    }
    await addRecord($, record)
    await update($, pendingRecord, () => record.at)
    $.ui.toast(DONE_TEXT)
    $.ui.log(noticeText(record, result.tokensBefore !== undefined && result.tokensAfter !== undefined))
  } catch {
    // A turn began meanwhile, and renews the cache by itself
  } finally {
    isCompacting = false
  }
}

// Padded alike, so the labels after the chips line up
export const chipLabel = (isOn: boolean): string => ` ${(isOn ? 'on' : 'off').padEnd(3)} `

// `/warm-compact` flips it, `/warm-compact on` and `off` set it
export const switchedTo = (args: string, isOn: boolean): boolean | null => {
  const word = args.trim().toLowerCase()
  if (word === '') return !isOn
  if (word === 'on' || word === 'off') return word === 'on'
  return null
}

const turnText = (name: string, isOn: boolean): string => `${name} is ${isOn ? 'on' : 'off'} for this session.`

// Turned off mid-countdown, the countdown goes at once
const turn = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await update($, isEnabled, () => isOn)
  if (!isOn) showStatus($, undefined)
}

const turnKeepWarm = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await update($, isKeepWarm, () => isOn)
}

const tick = async ($: EngineInterface): Promise<void> => {
  if (isCompacting) return
  const isCompactOn = await read($, isEnabled)
  let isKeepWarmOn = await read($, isKeepWarm)
  if (!isCompactOn && !isKeepWarmOn) return
  const request = await read($, last)
  const renewals = await read($, kept)
  const { context } = await $.session.usage()
  const model = await $.session.model()
  const block = isKeepWarmOn ? keepWarmBlock(model) : null
  if (block !== null) isKeepWarmOn = false
  let next = plan(request, {
    now: await $.clock.now(),
    ttl: cacheTtl,
    leadMs,
    model,
    tokens: context.tokens,
    minTokens,
    isTurnRunning: await read($, isTurnRunning),
    isCompactOn,
    isKeepWarmOn,
    maxRenewals,
    kept: renewals,
    renewTtl: renewTtl ?? cacheTtl,
  })
  const attempt = `${request?.at ?? ''}:${renewals?.count ?? 0}`
  if (next.kind !== 'idle' && triedFor === attempt) next = { kind: 'idle' }
  // A draft in the prompt box means the person is back, and holds a compaction off; a
  // renewal keeps the cache for them all the same
  if ((next.kind === 'warn' || next.kind === 'compact') && (await $.prompt.read()).text.trim() !== '') next = { kind: 'idle' }
  if (next.kind === 'warn') showStatus($, warnText(next.inMs))
  else showStatus($, undefined)
  if (next.kind === 'idle' || next.kind === 'warn') return
  triedFor = attempt
  if (block !== null) sayOnce($, block)
  if (next.kind === 'renew') await renew($, model, isCompactOn, context.tokens ?? 0)
  else await compact($, model, context.tokens ?? 0)
}

export const register: Register = (on, options) => {
  minTokens = numberOr(options.minTokens, DEFAULT_MIN_TOKENS)
  leadMs = Math.max(MIN_LEAD_MS, numberOr(options.leadSeconds, DEFAULT_LEAD_SECONDS) * 1000)
  maxRenewals = Math.round(numberOr(options.keepWarmRenewals, DEFAULT_MAX_RENEWALS))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive) return result
    const stored = await $.store.get(CACHE_TTL_KEY)
    if (isCacheTtl(stored)) cacheTtl = stored
    const storedRenewTtl = await $.store.get(RENEW_TTL_KEY)
    if (isCacheTtl(storedRenewTtl)) renewTtl = storedRenewTtl
    const misses = await $.store.get(RENEW_MISSES_KEY)
    if (typeof misses === 'object' && misses !== null) renewMisses = misses as Record<string, string>
    engineVersion = (await $.session.version()).version
    await $.command.register({ name: COMMAND, description: 'Compact before the prompt cache goes cold: on or off for this session (nothing flips it), or stats for what it saved' })
    await $.command.register({ name: KEEP_WARM_COMMAND, description: 'Keep the prompt cache warm while you are away, instead of compacting at once: on or off for this session (nothing flips it)' })
    $.clock.every(TICK_MS, () => void tick($))
    return result
  })

  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunning, () => true)
    await markReturned($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isTurnRunning, () => false)
    return next(e)
  })

  // Each main-thread request renews the cache; the first after a message says how much of
  // the conversation was still cached when it was sent
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const model = await $.session.model()
    const requestAt = await $.clock.now()
    return yield* tap(next(e), async chunk => {
      if (chunk.kind !== 'stop' || chunk.usage === null) return
      const hit = hitPercent(chunk.usage)
      const prev = await read($, last)
      if (e.index === 0 && hit !== null && prev !== null) await learnTtl($, inferTtl(prev, model, hit, requestAt))
      const renewed = await read($, kept)
      if (e.index === 0 && hit !== null && renewed !== null && cacheTtl === '1h') await learnRenewTtl($, inferRenewTtl(renewed.at, hit, requestAt))
      await update($, last, () => ({ at: requestAt, model }))
      await update($, kept, () => null)
    })
  })

  // Anyone's compaction of the main conversation that stands changes the prefix; one
  // computed ahead or vetoed leaves it, and a subagent's leaves the main one
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && result.skip === undefined) await forgetRequest($)
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'stats') {
      return { text: statsText(recordsOf(await $.store.get(RECORDS_KEY)), await $.clock.now(), await $.session.id()) }
    }
    const isOn = switchedTo(e.args, await read($, isEnabled))
    if (isOn === null) return { text: `Usage: /${COMMAND} [on|off|stats]` }
    await turn($, isOn)
    return { text: turnText('Warm compact', isOn) }
  })

  on('command.run', { command: KEEP_WARM_COMMAND }, async ($, e) => {
    const isOn = switchedTo(e.args, await read($, isKeepWarm))
    if (isOn === null) return { text: `Usage: /${KEEP_WARM_COMMAND} [on|off]` }
    await turnKeepWarm($, isOn)
    return { text: turnText('Keep warm', isOn) }
  })

  // The chips go on the row of chips under the hint line, which the engine still draws: the
  // one another mod's chips already started, or a row of their own
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { above, chips } = splitChipRow(await next(e))
    const { Box, Text, Button } = $.ui.resolve(e)
    const isCompactOn = await read($, isEnabled)
    const isKeepWarmOn = await read($, isKeepWarm)
    return (
      <Box flexDirection="column">
        {above}
        <Box key={CHIP_ROW_KEY} columnGap={2} flexWrap="wrap">
          {chips}
          <Box gap={1}>
            <Box backgroundColor={isCompactOn ? ON_COLOR : OFF_COLOR}>
              <Button key="toggle" label={chipLabel(isCompactOn)} plain onPress={() => void turn($, !isCompactOn)} />
            </Box>
            <Text dimColor>{COMPACT_LABEL}</Text>
          </Box>
          <Box gap={1}>
            <Box backgroundColor={isKeepWarmOn ? ON_COLOR : OFF_COLOR}>
              <Button key="keep-warm" label={chipLabel(isKeepWarmOn)} plain onPress={() => void turnKeepWarm($, !isKeepWarmOn)} />
            </Box>
            <Text dimColor>{KEEP_WARM_LABEL}</Text>
          </Box>
        </Box>
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, last, () => null)
      await update($, kept, () => null)
    }
    return next(e)
  })
}
