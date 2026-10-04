import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheTtl, CompactionRecord } from '../types'
import { DEFAULT_TTL, hitPercent, inferTtl, isCacheTtl, plan, warnText } from './plan'
import { MAX_RECORDS, noticeText, recordsOf, statsText } from './savings'

const TICK_MS = 1000
const CACHE_TTL_KEY = 'cacheTtl'
const RECORDS_KEY = 'compactions'
const DEFAULT_MIN_TOKENS = 50_000
const DEFAULT_LEAD_SECONDS = 60
// Never so close to the lapse that the compaction's request could miss the cache
const MIN_LEAD_MS = 15_000
const DONE_TEXT = 'Compacted before the prompt cache went cold'
const COMMAND = 'warm-compact'
const LABEL = 'Warm compact '
const NARROW_BELOW = 80
const BLOCK_GAP = 2
const ON_COLOR = '#238636'
const OFF_COLOR = '#6e7681'

const last = atom({ plugin: 'warm-compact', key: 'last' } as const, null)
const isTurnRunning = atom({ plugin: 'warm-compact', key: 'isTurnRunning' } as const, false)
const isEnabled = atom({ plugin: 'warm-compact', key: 'isEnabled' } as const, true)
const pendingCompaction = atom({ plugin: 'warm-compact', key: 'pendingCompaction' } as const, null)

let cacheTtl: CacheTtl = DEFAULT_TTL
let shownStatus: string | undefined
let isCompacting = false
// The request whose cache a compaction was tried for: one try each, whatever came of it
let triedFor: number | null = null
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
const forgetRequest = ($: EngineInterface): Promise<unknown> =>
  update($, last, prev => (prev === null ? prev : { ...prev, at: null }))

const addRecord = async ($: EngineInterface, record: CompactionRecord): Promise<void> => {
  const records = recordsOf(await $.store.get(RECORDS_KEY))
  await $.store.set(RECORDS_KEY, [...records, record].slice(-MAX_RECORDS))
}

// The session going on after a compaction is when the re-read it spared would have been paid
const markReturned = async ($: EngineInterface): Promise<void> => {
  const at = await read($, pendingCompaction)
  if (at === null) return
  await update($, pendingCompaction, () => null)
  const records = recordsOf(await $.store.get(RECORDS_KEY))
  await $.store.set(RECORDS_KEY, records.map(r => (r.at === at ? { ...r, isReturned: true } : r)))
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
    await update($, pendingCompaction, () => record.at)
    $.ui.toast(DONE_TEXT)
    $.ui.log(noticeText(record, result.tokensBefore !== undefined && result.tokensAfter !== undefined))
  } catch {
    // A turn began meanwhile, and renews the cache by itself
  } finally {
    isCompacting = false
  }
}

export const chipLabel = (isOn: boolean, isNarrow: boolean): string => ` ${isNarrow ? 'warm ' : ''}${isOn ? 'on' : 'off'} `

// `/warm-compact` flips it, `/warm-compact on` and `off` set it
export const switchedTo = (args: string, isOn: boolean): boolean | null => {
  const word = args.trim().toLowerCase()
  if (word === '') return !isOn
  if (word === 'on' || word === 'off') return word === 'on'
  return null
}

const turnText = (isOn: boolean): string =>
  isOn ? 'Warm compact is on for this session.' : 'Warm compact is off for this session.'

// Turned off mid-countdown, the countdown goes at once
const turn = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await update($, isEnabled, () => isOn)
  if (!isOn) showStatus($, undefined)
}

const tick = async ($: EngineInterface): Promise<void> => {
  if (isCompacting) return
  if (!(await read($, isEnabled))) return
  const request = await read($, last)
  const { context } = await $.session.usage()
  const model = await $.session.model()
  let next = plan(request, {
    now: await $.clock.now(),
    ttl: cacheTtl,
    leadMs,
    model,
    tokens: context.tokens,
    minTokens,
    isTurnRunning: await read($, isTurnRunning),
  })
  // A draft in the prompt box means the person is back, and holds it off
  if (next.kind !== 'idle' && (triedFor === request?.at || (await $.prompt.read()).text.trim() !== '')) next = { kind: 'idle' }
  if (next.kind === 'warn') showStatus($, warnText(next.inMs))
  else showStatus($, undefined)
  if (next.kind !== 'compact') return
  triedFor = request?.at ?? null
  await compact($, model, context.tokens ?? 0)
}

export const register: Register = (on, options) => {
  minTokens = numberOr(options.minTokens, DEFAULT_MIN_TOKENS)
  leadMs = Math.max(MIN_LEAD_MS, numberOr(options.leadSeconds, DEFAULT_LEAD_SECONDS) * 1000)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive) return result
    const stored = await $.store.get(CACHE_TTL_KEY)
    if (isCacheTtl(stored)) cacheTtl = stored
    await $.command.register({ name: COMMAND, description: 'Compact before the prompt cache goes cold: on or off for this session (nothing flips it), or stats for what it saved' })
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
      await update($, last, () => ({ at: requestAt, model }))
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
    return { text: turnText(isOn) }
  })

  // The chip goes right of what the plugins beneath and the engine draw in the footer slot
  // (the mode labels, context-bar's blocks), each of which keeps its place
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const beneath = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isOn = await read($, isEnabled)
    const isNarrow = (e.viewport?.columns ?? NARROW_BELOW) < NARROW_BELOW
    return (
      <Box flexShrink={0} gap={BLOCK_GAP}>
        {beneath}
        <Box flexShrink={0}>
          {!isNarrow && <Text dimColor>{LABEL}</Text>}
          <Box backgroundColor={isOn ? ON_COLOR : OFF_COLOR}>
            <Button key="toggle" label={chipLabel(isOn, isNarrow)} plain onPress={() => void turn($, !isOn)} />
          </Box>
        </Box>
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, last, () => null)
    return next(e)
  })
}
