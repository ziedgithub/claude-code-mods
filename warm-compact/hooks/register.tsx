import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheTtl, CompactionRecord, CompactionUsage, Kept, LastRequest, Upcoming } from '../types'
import { FIVE_MINUTES_TEXT, HINT_TEXT, TTL_SETTING, configuredTtl } from './cache-setting'
import { OFF_TEXT, SETTING, settingsPath, withIdleCompactionOff } from './idle-compaction'
import { LATE_MS, MIN_LEAD_MS, WARN_MS, isInTime, isWake, limitText, nearLimit, plan, startOf, upcoming, warnText } from './plan'
import { MAX_RECORDS, clockTime, compactionHit, isCacheMissed, noticeText, recordsOf, statsText } from './savings'
import { DEFAULT_TTL, TTL_MS, hitPercent, inferRenewTtl, inferTtl, inputTokens, isCacheTtl } from './shared/cache-ttl'
import { CHIP_ROW_KEY, splitChipRow } from './shared/chips'
import { tap } from './shared/stream'

const TICK_MS = 1000
const CACHE_TTL_KEY = 'cacheTtl'
const RECORDS_KEY = 'compactions'
const RENEW_TTL_KEY = 'renewTtl'
// The models a renewal could not read the conversation from the cache on, each with the
// engine version that failed: tried again once the engine changes
const RENEW_MISSES_KEY = 'renewMisses'
// Compactions in a row that found the cache gone, which a pause still within the TTL should
// not, counted for each engine version apart, as two may run at once after an update: from
// COMPACT_MISSES_TO on, warm compact stands down on that version. Claude Code has sent its compaction a conversation the cache did not
// hold while a fork of the same moment read it whole
const COMPACT_MISSES_KEY = 'compactMisses'
const COMPACT_MISSES_TO = 2
// The TTL last picked for Claude Code, 'auto' when left to it: misses counted under another one
// start over
const CONFIGURED_TTL_KEY = 'configuredTtl'
const STAND_DOWN_TEXT = 'Warm compact: its last'
const WAKE_TEXT = 'warm-compact left this pause alone: the computer slept, or Claude Code stalled, and the prompt cache may have lapsed meanwhile'
// The fork that renews the cache asks for as little as it can
const RENEW_PROMPT = 'Reply with the single word: ok'
// A renewal that read less of its request from the cache than this missed the entry
const RENEW_HIT_FROM = 90
const DEFAULT_MIN_TOKENS = 50_000
const DEFAULT_LEAD_SECONDS = 60
const DEFAULT_MAX_RENEWALS = 2
const DONE_TEXT = 'Compacted before the prompt cache went cold'
const DROPPED_TEXT = 'Warm compact could not take over before the prompt cache lapsed: the next prompt reads the conversation uncached.'
const AUTO_COMPACT_OFF_TEXT = 'Warm compact leaves this session alone while auto-compact is off: turn auto-compact on in /config to have it back.'
// Whether it turned Claude Code's own idle compaction off once: after that, the setting is the
// person's, /config's toggle among others
const IDLE_OFF_KEY = 'idleCompactionOff'
// Someone who edited the prompt box this recently is taken to be back, as Claude Code's own
// idle compaction takes them, even with the box emptied again
const PRESENT_MS = 60_000
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
const learned = atom({ plugin: 'warm-compact', key: 'ttl' } as const, null)
const inStore = atom({ plugin: 'warm-compact', key: 'upcoming' } as const, null)
const tried = atom({ plugin: 'warm-compact', key: 'triedFor' } as const, null)
const standsDown = atom({ plugin: 'warm-compact', key: 'standsDown' } as const, false)

let cacheTtl: CacheTtl = DEFAULT_TTL
// Whether a read ever told the TTL, or it is still the default: until one does, a compaction or
// a first renewal that finds the cache gone may only show a five-minute cache, and counts against
// neither Claude Code nor the model
let isTtlKnown = false
// The TTL picked for Claude Code, which no read is needed to tell, or null when left to it
let configured: CacheTtl | null = null
let shownStatus: string | undefined
// A tick still running when the next comes: the next leaves it be, as two compactions at once
// would compact twice
let isTicking = false
// The renewal or compaction last tried, named by the request and the renewals since: one
// try each, whatever came of it. Kept in the plugin's state, which a reload of the mod keeps as
// it keeps the request, so a pause left alone after a sleep stays alone
let triedFor: string | null = null
// The try a renewal handed over to a compaction, and how long the entry it plans on holds: the
// clock starts that compaction as it would its own, or drops it once the entry lapses
let handover: { attempt: string; ttl: CacheTtl } | null = null
let maxRenewals = DEFAULT_MAX_RENEWALS
// Until a read after a renewal shows otherwise, it holds the entry as long as a request does
let renewTtl: CacheTtl | null = null
let renewMisses: Record<string, string> = {}
let compactMisses: Record<string, number> = {}
// A TTL read once that differs from the one held, until a second read agrees with it
let pendingTtl: CacheTtl | null = null
let lastTickAt: number | null = null
// When the person last edited the prompt box, or emptied it, and whether it held a draft at
// the last tick: emptying it by Esc or Ctrl+C is no edit the engine tells of
let editedAt: number | null = null
let hadDraft = false
// Whether auto-compact was on, as last asked for which try and when: the engine counts it in a
// breakdown of the window, too much to ask every second, so it is asked as a compaction comes
// in store, again for its countdown, and again as it starts
let autoCompact: { attempt: string; at: number; isOn: boolean } | null = null
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

// Other mods read what it learned instead of learning it again: context-bar's countdown
// follows it, so the two never disagree
const publishTtl = async ($: EngineInterface): Promise<void> => {
  await update($, learned, () => ({ cache: cacheTtl, renew: renewTtl }))
}

// Written when it differs from what the state holds, as the clock asks every second. The engine
// empties every plugin's state as a session ends, a /clear's or a /resume's too, with no
// session.start after: what it learned is published again then, and so is whether it stands down
const publishUpcoming = async ($: EngineInterface, next: Upcoming | null): Promise<void> => {
  if (JSON.stringify(await read($, inStore)) === JSON.stringify(next)) return
  await update($, inStore, () => next)
}

const republish = async ($: EngineInterface): Promise<void> => {
  if ((await read($, learned)) === null) await publishTtl($)
  const isDown = compactBlock() !== null
  if ((await read($, standsDown)) !== isDown) await update($, standsDown, () => isDown)
}

// The engine keeps its TTL to itself: a request after a long enough pause tells it, and it
// is kept between sessions since it holds for the account
// One read can mislead: a prompt changed meanwhile misses whatever the TTL, so two in a row
// must agree before it changes
const learnTtl = async ($: EngineInterface, ttl: CacheTtl | null): Promise<void> => {
  if (ttl === null || configured !== null) return
  if (ttl === cacheTtl) {
    pendingTtl = null
    if (!isTtlKnown) {
      isTtlKnown = true
      await $.store.set(CACHE_TTL_KEY, ttl)
    }
    return
  }
  if (pendingTtl !== ttl) {
    pendingTtl = ttl
    return
  }
  pendingTtl = null
  cacheTtl = ttl
  isTtlKnown = true
  await $.store.set(CACHE_TTL_KEY, ttl)
  await publishTtl($)
}

// A compaction, or a first renewal, that read the request's entry warm 59 minutes on shows an
// hour-long cache: what a pause never as long as a telling one, nor longer than one, shows. Warm
// as a renewal counts it, past the tools and the system prompt other sessions keep cached. It
// outweighs a single telling read that said otherwise
const confirmHour = async ($: EngineInterface, hit: number): Promise<void> => {
  if (hit < RENEW_HIT_FROM || cacheTtl !== '1h') return
  pendingTtl = null
  if (isTtlKnown) return
  isTtlKnown = true
  await $.store.set(CACHE_TTL_KEY, cacheTtl)
}

// A compaction leaves a new prefix, which the cache has none of yet
const forgetRequest = async ($: EngineInterface): Promise<void> => {
  await update($, last, prev => (prev === null ? prev : { ...prev, at: null }))
  await update($, kept, () => null)
}

// A person who turned auto-compact off wants no compaction they did not ask for, as Claude
// Code's own idle compaction takes it. `maxAgeMs`: how old an answer for the try may be, 0 for
// none but this moment's
const isAutoCompactOn = async ($: EngineInterface, attempt: string, maxAgeMs: number): Promise<boolean> => {
  const now = await $.clock.now()
  if (autoCompact === null || autoCompact.attempt !== attempt || now - autoCompact.at > maxAgeMs) {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    autoCompact = { attempt, at: now, isOn: context.breakdown?.isAutoCompactEnabled ?? true }
  }
  return autoCompact.isOn
}

// A fork re-sends the main thread's last request with one more message after it: it reads
// the conversation from the cache, which renews the entry, and leaves the transcript as
// it was. Resolves when the request started and what it cost, null when there was nothing
// to fork, or why it failed: an error or an abort, which says nothing of the cache
type Renewal = { at: number; usage: CompactionUsage } | { at: number; failure: string }

const renewCache = async ($: EngineInterface): Promise<Renewal | null> => {
  const at = await $.clock.now()
  const result = await $.model.fork({ prompt: RENEW_PROMPT })
  if (result.isAnswered || result.reason === 'empty-reply') {
    return compactionHit(result.usage) === null ? { at, failure: 'nothing counted' } : { at, usage: result.usage }
  }
  if (result.reason === 'nothing-to-fork') return null
  if (result.reason === 'api-error') return { at, failure: `an API error${result.status === null ? '' : ` ${result.status}`}` }
  return { at, failure: 'it was cut short' }
}

// A renewal that missed the entry wrote the conversation to the cache again itself, for five
// minutes at least: a compaction before that reads it from there. One missing after an earlier
// renewal shows that renewal held five minutes; a first one, that this model's renewals miss.
// The compaction that takes over is the clock's to start, with every check its own has, and
// only with auto-compact on, as asked then and there. A renewal a prompt overtook while it ran
// leaves the pause to that prompt, its cost counted
// `previous`: the renewals before this one, as the tick saw them, which a prompt sent meanwhile clears
const renew = async ($: EngineInterface, model: string, isCompactOn: boolean, attempt: string, requestAt: number | null, previous: Kept | null): Promise<void> => {
  const renewal = await renewCache($)
  if (renewal === null) return
  const isOvertaken = (await read($, last))?.at !== requestAt || (await read($, isTurnRunning))
  const isTakingOver = async (): Promise<boolean> => isCompactOn && (await isAutoCompactOn($, attempt, 0))
  const takeoverText = (isOn: boolean): string => (isOn ? ', so warm compact takes over' : '')
  // The cache was likely still there: nothing is learned, and a compaction may still read it
  if ('failure' in renewal) {
    if (isOvertaken) return
    const isOn = await isTakingOver()
    $.ui.log(`Keep warm: the renewal at ${clockTime(renewal.at)} failed (${renewal.failure})${takeoverText(isOn)}.`)
    if (isOn) handover = { attempt, ttl: renewTtl ?? cacheTtl }
    return
  }
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
  if (previous !== null) await learnRenewTtl($, inferRenewTtl(previous.at, previous.tokens, usage.cache_read_input_tokens, record.before, renewal.at))
  if (hit < RENEW_HIT_FROM && previous === null && isTtlKnown) await noteRenewMiss($, model)
  if (previous === null) await confirmHour($, hit)
  if (isOvertaken) return
  if (hit < RENEW_HIT_FROM) {
    const isOn = await isTakingOver()
    $.ui.log(`Keep warm: the renewal at ${clockTime(renewal.at)} found the prompt cache gone${takeoverText(isOn)}.`)
    // The entry is now the one the renewal wrote, with the same count: the try stays the same,
    // and the next read says how long a renewal's entry lasts, not the request's
    await update($, kept, () => ({ at: renewal.at, count: previous?.count ?? 0, tokens: record.before }))
    if (isOn) handover = { attempt, ttl: renewTtl === '1h' ? '1h' : '5m' }
    return
  }
  const count = (previous?.count ?? 0) + 1
  await update($, kept, () => ({ at: renewal.at, count, tokens: record.before }))
  await update($, pendingRecord, () => renewal.at)
  $.ui.log(`Kept the prompt cache warm at ${clockTime(renewal.at)} (${count} of ${maxRenewals}).`)
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
  await publishTtl($)
}

const noteRenewMiss = async ($: EngineInterface, model: string): Promise<void> => {
  renewMisses = { ...renewMisses, [model]: engineVersion }
  await $.store.set(RENEW_MISSES_KEY, renewMisses)
}

// Why keep warm cannot help here, or null when it can: a renewal that holds five minutes
// would cost more than a compaction to cover an hour-long cache, and a model whose renewals
// missed would pay for the whole conversation each time
const keepWarmBlock = (model: string, isCompactOn: boolean): string | null => {
  const then = isCompactOn ? ', so warm compact takes over.' : ', so it stands down.'
  if (cacheTtl === '1h' && renewTtl === '5m') return `Keep warm: a renewal holds this account's cache for 5 minutes only${then}`
  if (renewMisses[model] === engineVersion) return `Keep warm: renewals can't read the conversation from the cache on ${model}${then}`
  return null
}

// The stored counts, by version; one kept before they were, `{ version, count }`, is read as one
// version's. Versions with none in a row are left out
const missesOf = (value: unknown): Record<string, number> => {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  if (typeof record.version === 'string' && typeof record.count === 'number') return record.count > 0 ? { [record.version]: record.count } : {}
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0))
}

// Picked, five minutes stands it down for as long as it stays picked. Left to Claude Code, the
// way out is said too
const compactBlock = (): string | null => {
  if (configured === '5m') return FIVE_MINUTES_TEXT
  const count = compactMisses[engineVersion] ?? 0
  if (count < COMPACT_MISSES_TO) return null
  const fix = configured === null ? ` ${HINT_TEXT};` : ''
  return `${STAND_DOWN_TEXT} ${count} compactions couldn't read the conversation from the prompt cache, so it stands down.${fix} /${COMMAND} on tries again.`
}

// Read as each session starts and each turn does, as /config may change it meanwhile. One that
// differs from the last seen starts the misses over. Left to Claude Code again, the TTL is what
// reads had told
const readConfigured = async ($: EngineInterface): Promise<void> => {
  let next: CacheTtl | null
  try {
    next = configuredTtl(await $.env.get('FORCE_PROMPT_CACHING_5M'), await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'), (await $.settings.read())[TTL_SETTING])
  } catch {
    return
  }
  const wasConfigured = configured !== null
  configured = next
  if (next !== null) {
    cacheTtl = next
    isTtlKnown = true
    pendingTtl = null
  } else if (wasConfigured) {
    const stored = await $.store.get(CACHE_TTL_KEY)
    cacheTtl = isCacheTtl(stored) ? stored : DEFAULT_TTL
    isTtlKnown = isCacheTtl(stored)
  }
  const stored = await $.store.get(CONFIGURED_TTL_KEY)
  if ((isCacheTtl(stored) ? stored : null) !== next) {
    await $.store.set(CONFIGURED_TTL_KEY, next ?? 'auto')
    compactMisses = {}
    await $.store.set(COMPACT_MISSES_KEY, compactMisses)
    for (const text of saidOnce) if (text.startsWith(STAND_DOWN_TEXT)) saidOnce.delete(text)
  }
  if (next !== null || wasConfigured) await publishTtl($)
  await update($, standsDown, () => compactBlock() !== null)
}

// Other sessions count too, on this version or another: each change goes on from the stored counts
const setMisses = async ($: EngineInterface, count: number): Promise<void> => {
  const { [engineVersion]: _, ...others } = missesOf(await $.store.get(COMPACT_MISSES_KEY))
  compactMisses = count > 0 ? { ...others, [engineVersion]: count } : others
  await $.store.set(COMPACT_MISSES_KEY, compactMisses)
  await update($, standsDown, () => compactBlock() !== null)
  // A count started over may stand down again, and say so again
  if (count === 0) for (const text of saidOnce) if (text.startsWith(STAND_DOWN_TEXT)) saidOnce.delete(text)
}

// Only a compaction the request's own entry should still have held tells: after a renewal,
// what the cache held is the renewal's to say
const noteCompaction = async ($: EngineInterface, usage: CompactionUsage | null): Promise<void> => {
  const hit = compactionHit(usage)
  if (hit === null) return
  await confirmHour($, hit)
  if (!isTtlKnown) return
  const stored = missesOf(await $.store.get(COMPACT_MISSES_KEY))
  await setMisses($, isCacheMissed(usage) ? (stored[engineVersion] ?? 0) + 1 : 0)
  const block = compactBlock()
  if (block !== null) sayOnce($, block)
}

// A plugin's own compaction skips its own hooks, so the request is forgotten here. The toast
// is for someone watching; the transcript line is for whoever comes back
const compact = async ($: EngineInterface, model: string, tokens: number, isAfterRenewal: boolean): Promise<void> => {
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
    if (!isAfterRenewal) await noteCompaction($, record.usage)
  } catch {
    // A turn began meanwhile, and renews the cache by itself
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
// Turned on by hand, it tries again after standing down
const turn = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await update($, isEnabled, () => isOn)
  if (isOn && compactBlock() !== null) await setMisses($, 0)
  if (!isOn) showStatus($, undefined)
}

const turnKeepWarm = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await update($, isKeepWarm, () => isOn)
}

// Once off in the person's own settings or a policy's, it stays as it is. Another source (a
// project's, a flag's) speaks for that place only, so the user settings are still written. It is
// done once: turned back on afterwards, in /config or the file, it stays on. A settings file that
// will not read, parse or write is left as it is, and tried again next session
const turnOffIdleCompaction = async ($: EngineInterface): Promise<void> => {
  try {
    if ((await $.store.get(IDLE_OFF_KEY)) === true) return
    const isOff = async (source: 'user' | 'policy'): Promise<boolean> => (await $.settings.read({ source }))[SETTING] === false
    if (!(await isOff('user')) && !(await isOff('policy'))) {
      const path = settingsPath(await $.env.get('CLAUDE_CONFIG_DIR'), (await $.env.get('HOME')) ?? '')
      const next = withIdleCompactionOff((await $.fs.read(path)) as string)
      if (next === null) return
      await $.fs.write(path, next)
      $.ui.log(OFF_TEXT)
    }
    await $.store.set(IDLE_OFF_KEY, true)
  } catch {
    // Left for next session
  }
}

const markTried = async ($: EngineInterface, attempt: string): Promise<void> => {
  triedFor = attempt
  await update($, tried, () => attempt)
}

// One tick at a time: one still running (a renewal, a compaction) has the next leave it be, all
// but the time it came, which tells a sleep from a long tick
const tick = async ($: EngineInterface): Promise<void> => {
  if (isTicking) {
    lastTickAt = await $.clock.now()
    return
  }
  isTicking = true
  try {
    await tickOnce($)
  } finally {
    isTicking = false
  }
}

const tickOnce = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  const sleptMs = isWake(lastTickAt, now) ? now - (lastTickAt ?? now) : 0
  lastTickAt = now
  await republish($)
  triedFor = await read($, tried)
  const isDraft = (await $.prompt.read()).text.trim() !== ''
  if (hadDraft && !isDraft) editedAt = now
  hadDraft = isDraft
  const isCompactWanted = await read($, isEnabled)
  let isKeepWarmOn = await read($, isKeepWarm)
  if (!isCompactWanted && !isKeepWarmOn) {
    await publishUpcoming($, null)
    return
  }
  const request = await read($, last)
  const renewals = await read($, kept)
  const attempt = `${request?.at ?? ''}:${renewals?.count ?? 0}`
  if (handover?.attempt !== attempt) handover = null
  const { context, rateLimits } = await $.session.usage()
  const compactBlocked = isCompactWanted ? compactBlock() : null
  const isCompactOn = isCompactWanted && compactBlocked === null
  const model = await $.session.model()
  const block = isKeepWarmOn ? keepWarmBlock(model, isCompactOn) : null
  if (block !== null) isKeepWarmOn = false
  const moment = {
    now,
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
    heldUntil: isDraft ? Infinity : editedAt === null ? null : editedAt + PRESENT_MS,
  }
  // What the cache did while the computer slept is unknown, so that pause is left alone
  if (sleptMs > 0 && (triedFor !== attempt || handover !== null)) {
    await markTried($, attempt)
    handover = null
    // A sleep during a turn, at a permission prompt say, leaves no pause to speak of
    if (!moment.isTurnRunning && upcoming(request, moment) !== null) $.ui.log(`${WAKE_TEXT} (${Math.round(sleptMs / 60_000)} min).`)
  }
  const limit = nearLimit(rateLimits, now)
  // A handover near a rate limit is left alone at once, and said so
  if (handover !== null && limit !== null) {
    await markTried($, attempt)
    handover = null
    $.ui.log(limitText(limit))
  }
  // A renewal's try handed over to a compaction is the compaction's alone, on the entry it planned on
  const live = handover === null ? moment : { ...moment, isKeepWarmOn: false, renewTtl: handover.ttl }
  const isTried = triedFor === attempt && handover === null
  // One try each, none near a rate limit or with auto-compact found off this pause (or last
  // found off, while a turn runs and nothing is asked), and none past
  // its time: nothing more is in store then. A compaction held off shows when it would start
  const coming = isTried || limit !== null ? null : upcoming(request, live)
  if (coming?.kind === 'compact' && !moment.isTurnRunning) await isAutoCompactOn($, attempt, Infinity)
  const isComing = coming !== null && isInTime(coming, moment.heldUntil, now) && !(coming.kind === 'compact' && autoCompact !== null && !autoCompact.isOn && (autoCompact.attempt === attempt || moment.isTurnRunning))
  await publishUpcoming($, isComing ? { ...coming, at: startOf(coming, moment.heldUntil) } : null)
  // A handover the entry lapsed on, held off all along or come too late, is dropped, and said
  // so; one a prompt overtook is the prompt's
  if (handover !== null && coming !== null && !moment.isTurnRunning && now > coming.expiresAt - LATE_MS) {
    handover = null
    $.ui.log(DROPPED_TEXT)
  }
  let next = isTried ? { kind: 'idle' as const } : plan(request, live)
  // Near a rate limit, the pause is left alone, before a countdown starts
  if (next.kind !== 'idle' && limit !== null) {
    await markTried($, attempt)
    handover = null
    next = { kind: 'idle' }
    $.ui.log(limitText(limit))
  }
  // With auto-compact off, so is warm compact: asked again for the countdown, and as it starts
  if ((next.kind === 'warn' || next.kind === 'compact') && !(await isAutoCompactOn($, attempt, next.kind === 'compact' ? 0 : WARN_MS))) {
    await markTried($, attempt)
    handover = null
    next = { kind: 'idle' }
    sayOnce($, AUTO_COMPACT_OFF_TEXT)
  }
  if (next.kind === 'warn') showStatus($, warnText(next.inMs))
  else showStatus($, undefined)
  if (next.kind === 'idle' && compactBlocked !== null && triedFor !== attempt && plan(request, { ...moment, isCompactOn: true }).kind === 'compact') {
    await markTried($, attempt)
    sayOnce($, compactBlocked)
  }
  // Keep warm standing down says why as its renewal would have come, whatever else left the pause
  // alone then: warm compact off or stood down, auto-compact off, a rate limit. A compaction still
  // to come, held off, says it takes over as it starts
  if (next.kind === 'idle' && block !== null && !(isComing && coming?.kind === 'compact') && plan(request, { ...moment, isKeepWarmOn: true }).kind === 'renew') sayOnce($, keepWarmBlock(model, false) ?? block)
  if (next.kind === 'idle' || next.kind === 'warn') return
  const isHandover = handover !== null
  await markTried($, attempt)
  handover = null
  if (block !== null) sayOnce($, block)
  // Whether auto-compact is on is asked as the compaction a renewal hands over to comes due
  if (next.kind === 'renew') await renew($, model, isCompactOn, attempt, request?.at ?? null, renewals)
  // After a renewal, what the cache held is the renewal's to say, not the compaction's
  else await compact($, model, context.tokens ?? 0, renewals !== null || isHandover)
}

export const register: Register = (on, options) => {
  minTokens = numberOr(options.minTokens, DEFAULT_MIN_TOKENS)
  leadMs = Math.max(MIN_LEAD_MS, numberOr(options.leadSeconds, DEFAULT_LEAD_SECONDS) * 1000)
  maxRenewals = Math.round(numberOr(options.keepWarmRenewals, DEFAULT_MAX_RENEWALS))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive) return result
    const stored = await $.store.get(CACHE_TTL_KEY)
    if (isCacheTtl(stored)) {
      cacheTtl = stored
      isTtlKnown = true
    }
    const storedRenewTtl = await $.store.get(RENEW_TTL_KEY)
    if (isCacheTtl(storedRenewTtl)) renewTtl = storedRenewTtl
    const misses = await $.store.get(RENEW_MISSES_KEY)
    if (typeof misses === 'object' && misses !== null) renewMisses = misses as Record<string, string>
    compactMisses = missesOf(await $.store.get(COMPACT_MISSES_KEY))
    engineVersion = (await $.session.version()).version
    await readConfigured($)
    await publishTtl($)
    await $.command.register({ name: COMMAND, description: 'Compact before the prompt cache goes cold: on or off for this session (nothing flips it), or stats for what it saved' })
    await $.command.register({ name: KEEP_WARM_COMMAND, description: 'Keep the prompt cache warm while you are away, instead of compacting at once: on or off for this session (nothing flips it)' })
    $.clock.every(TICK_MS, () => void tick($))
    await turnOffIdleCompaction($)
    return result
  })

  // A subagent's turn is neither the main one running nor the person coming back. Claude Code
  // 2.1.302 names it in `agentId`, which 2.1.296's contract has not
  on('turn.start', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    await update($, isTurnRunning, () => true)
    await readConfigured($)
    await markReturned($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isTurnRunning, () => false)
    return next(e)
  })

  // The person's own hand on the prompt box: a key or a paste. A recall from the history leaves
  // a draft, which says as much; `prompt.change`, which would tell of it, does not load on
  // Claude Code 2.1.296
  on('prompt.edit', async ($, e, next) => {
    void $.clock.now().then(at => {
      editedAt = at
    })
    return next(e)
  })

  // Each main-thread request renews the cache; the first after a message says how much of
  // the conversation was still cached when it was sent. Unless a compaction went first: then it
  // is the first over a new prefix, and says nothing of the TTL. Where an organization manages
  // Claude Code, `session.compact` passes over the plugins a person installs, and the engine
  // having no measure of the window yet is all that tells of it, a `/compact` while idle or an
  // auto-compact at the turn's start. Until that request, the missing measure leaves the pause
  // alone too. A request the API ran tools of its own in (an advisor) reports usage summed over
  // its steps, which tells nothing and is no entry's size: it is learned from once it is answered
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const model = await $.session.model()
    const requestAt = await $.clock.now()
    const isNewPrefix = (await $.session.usage()).context.tokens === undefined
    const telling: { read: { prev: LastRequest | null; renewed: Kept | null; cacheRead: number; tokens: number } | null } = { read: null }
    const result = yield* tap(next(e), async chunk => {
      if (chunk.kind !== 'stop' || chunk.usage === null) return
      const tokens = inputTokens(chunk.usage)
      const prev = await read($, last)
      const renewed = await read($, kept)
      if (e.index === 0 && hitPercent(chunk.usage) !== null && !isNewPrefix) telling.read = { prev, renewed, cacheRead: chunk.usage.cache_read_input_tokens, tokens }
      await update($, last, () => ({ at: requestAt, model, tokens }))
      await update($, kept, () => null)
    })
    if ((result.serverToolUses ?? []).length > 0) {
      await update($, last, prev => (prev === null ? prev : { ...prev, tokens: undefined }))
      return result
    }
    const seen = telling.read
    // A renewal since the last request held the entry meanwhile: what this read found says how
    // long a renewal's lasts, not a request's
    if (seen?.prev != null && seen.renewed === null) await learnTtl($, inferTtl(seen.prev, model, seen.cacheRead, seen.tokens, requestAt))
    if (seen?.renewed != null && cacheTtl === '1h') await learnRenewTtl($, inferRenewTtl(seen.renewed.at, seen.renewed.tokens, seen.cacheRead, seen.tokens, requestAt))
    return result
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
    // Flipped from what the chip shows: stood down, it is off, and the flip tries again
    const isOn = switchedTo(e.args, (await read($, isEnabled)) && !(await read($, standsDown)))
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
    // Stood down, it shows off, and a press tries again
    const isCompactOn = (await read($, isEnabled)) && !(await read($, standsDown))
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

  // A /clear or a /resume goes on in this process with another conversation, which starts as a
  // new session does: nothing to come back to, and both switches as they start
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, last, () => null)
      await update($, kept, () => null)
      await update($, pendingRecord, () => null)
      await update($, isEnabled, () => true)
      await update($, isKeepWarm, () => false)
      saidOnce.clear()
    }
    return next(e)
  })
}
