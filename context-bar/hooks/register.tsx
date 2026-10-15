import { atom, memberOf, read, update } from 'claude-code'
import type { ContextCategory, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentStats, CacheInfo, CacheTtl, ContextAction, ContextFill, ContextRow, LearnedTtl, ModelInfo, Question, Setting, Upcoming } from '../types'
import { COLD_TEXT, formatRemaining, hitColor, remainingMs, ttlOf } from './cache'
import { DEFAULT_TTL, hitPercent, inferRenewTtl, inferTtl, isCacheTtl } from './shared/cache-ttl'
import { tap } from './shared/stream'

const BAR_MIN = 3
const BAR_MAX = 8
const BAR_SHARE = 0.05
const COMPACT_BELOW = 80
const DEFAULT_COLUMNS = 120
const BLOCK_GAP = 2
const EFFORT_GAP = 2
const GREEN_BELOW = 30
const ORANGE_BELOW = 60
const MODEL_POLL_MS = 1000
const FILL_POLL_MS = 1000
const CACHE_TICK_MS = 1000
const CACHE_TTL_KEY = 'cacheTtl'
const RENEW_TTL_KEY = 'renewTtl'
const COLD_COLOR = '#58a6ff'
const CONFIRM_MS = 5000
const CHOOSE_MS = 10000
const ACTION_GAP = 2
const MODEL_ICON = '◆'
const NEUTRAL = '#8b949e'
// One glyph each, one cell wide, drawn on a chip of the action's color: a Button takes no
// color of its own at rest, so the color is the Box behind it
const ACTIONS: Record<ContextAction, { icon: string; question: string; color: string }> = {
  compact: { icon: '⇊', question: 'compact context?', color: '#1f6feb' },
  clear: { icon: '⌫', question: 'clear context?', color: '#da3633' },
}
const NO_COLOR = '#6e7681'
const CONTEXT_ACTIONS: readonly ContextAction[] = ['compact', 'clear']
// `/effort`'s answer as the transcript keeps it: `Set effort level to high (this session only): …`
const EFFORT_SET = /<local-command-stdout>Set effort level to ([a-z]+)\b/
// The same answer as `$.command.run` returns it, before the transcript wraps it
const EFFORT_ANSWER = /^Set effort level to ([a-z]+)\b/

const MODEL_COLORS: Record<string, string> = {
  opus: '#bc8cff',
  sonnet: '#58a6ff',
  haiku: '#7ee787',
  fable: '#f778ba',
}

const EFFORT_STYLES: Record<string, { icon: string; color: string }> = {
  low: { icon: '▂', color: '#8b949e' },
  medium: { icon: '▄', color: '#39c5bb' },
  high: { icon: '▆', color: '#e3b341' },
  xhigh: { icon: '▇', color: '#ffa657' },
  max: { icon: '█', color: '#ff7b72' },
}

// The aliases `/model` takes, each switching to the latest model of its family
const MODEL_CHOICES = ['opus', 'sonnet', 'haiku', 'fable']
// The chips' backgrounds are darker than the text colors above, so the terminal's own text
// color, the only one a Button takes at rest, stays readable on them
const MODEL_CHIPS: Record<string, string> = {
  opus: '#8957e5',
  sonnet: '#1f6feb',
  haiku: '#238636',
  fable: '#bf4b8a',
}
const EFFORT_CHIPS: Record<string, string> = {
  low: '#6e7681',
  medium: '#1b7c83',
  high: '#9e6a03',
  xhigh: '#bd561d',
  max: '#da3633',
}
const CURRENT_MARK = '✔'
const CLOSE_ICON = '✕'
// What a subagent's footer starts with, so its figures are not taken for the conversation's
const AGENT_ICON = '↳'
const AGENT_FALLBACK = 'agent'
const AGENT_LABEL_MAX = 20
// The window of a model other than the session's, which the engine reports for its own alone
const DEFAULT_WINDOW = 200_000
const LONG_WINDOW = 1_000_000
// The card over the bar, a cell per category of what fills the window, in columns as tall as
// the rows it has: the prompt and its two rules, since the band above them paints over it
const CARD_ROWS = 3
const ROW_GLYPHS: Record<ContextRow['kind'], string> = { used: '■', free: '□', buffer: '▒' }
// What warm-compact has in store for the pause, beside the countdown it runs on
const UPCOMING_STYLES: Record<Upcoming['kind'], { icon: string; color: string }> = {
  compact: { icon: '⇊', color: '#58a6ff' },
  renew: { icon: '♨', color: '#ffa657' },
}

const fill = atom({ plugin: 'context-bar', key: 'fill' } as const, null)
const model = atom({ plugin: 'context-bar', key: 'model' } as const, null)
const asking = atom({ plugin: 'context-bar', key: 'asking' } as const, null)
const cache = atom({ plugin: 'context-bar', key: 'cache' } as const, null)
const viewing = atom({ plugin: 'context-bar', key: 'viewing' } as const, null)
// One member per agent, keyed by its id
const agents = atom({ plugin: 'context-bar', key: 'agents' } as const, null)
const breakdown = atom({ plugin: 'context-bar', key: 'breakdown' } as const, null)
// warm-compact's, while it is loaded: it acts on the cache, so the countdown runs on its figures
const warmTtl = atom({ plugin: 'warm-compact', key: 'ttl' } as const, null)
const warmUpcoming = atom({ plugin: 'warm-compact', key: 'upcoming' } as const, null)

// The bar takes a twentieth of the terminal width, so it follows resizes
export const barWidthFor = (columns: number): number =>
  Math.min(BAR_MAX, Math.max(BAR_MIN, Math.round(columns * BAR_SHARE)))

// The blocks stack, right-aligned, when one row cannot hold them
export const fitsInRow = (columns: number, rightLength: number): boolean => rightLength <= columns

export const colorFor = (percent: number): string => {
  if (percent < GREEN_BELOW) return '#3fb950'
  if (percent < ORANGE_BELOW) return '#ff9500'
  return '#f85149'
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

// `claude-sonnet-5-5` -> `Sonnet 5.5`, `claude-haiku-4-5-20251001` -> `Haiku 4.5`,
// `claude-3-5-sonnet-20241022` -> `Sonnet 3.5`; anything else is left as received
export const displayModelName = (id: string): string => {
  const isLongContext = id.endsWith('[1m]')
  const bare = id.replace(/\[1m\]$/, '')
  const suffix = isLongContext ? ' (1M)' : ''
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare)

  if (modern !== null) {
    const [, family = '', major, minor] = modern
    return `${capitalize(family)} ${minor === undefined ? major : `${major}.${minor}`}${suffix}`
  }

  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(bare)

  if (legacy !== null) {
    const [, major, minor, family = ''] = legacy
    return `${capitalize(family)} ${minor === undefined ? major : `${major}.${minor}`}${suffix}`
  }

  return id
}

export type ModelParts = {
  name: string
  family: string
  modelColor: string
  effort: { icon: string; color: string; label: string } | null
  length: number
}

// An effort neither the settings nor a request has told yet is shown as `…`
export const modelParts = (info: ModelInfo): ModelParts => {
  const name = displayModelName(info.name)
  const family = (name.split(' ')[0] ?? '').toLowerCase()
  const modelColor = MODEL_COLORS[family] ?? NEUTRAL

  let effort: ModelParts['effort'] = null

  if (!info.isEffortKnown) {
    effort = { icon: '', color: NEUTRAL, label: '…' }
  } else if (info.effort !== null) {
    const style = EFFORT_STYLES[info.effort] ?? { icon: '●', color: NEUTRAL }
    effort = { ...style, label: info.effort }
  }

  const effortLength =
    effort === null
      ? 0
      : EFFORT_GAP + (effort.icon === '' ? 0 : effort.icon.length + 1) + effort.label.length

  return { name, family, modelColor, effort, length: MODEL_ICON.length + 1 + name.length + effortLength }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// What the settings ask of a model until a request reports it: the model's own
// `modelSettings` row, else the global `effortLevel`. A level the model does not take is
// only corrected by the next request
export const configuredEffort = (settings: Readonly<Record<string, unknown>>, modelId: string): string | null => {
  const rows = settings.modelSettings
  const row = isRecord(rows) ? rows[modelId.replace(/\[1m\]$/, '')] : undefined
  const own = isRecord(row) ? row.effortLevel : undefined
  const level = typeof own === 'string' ? own : settings.effortLevel
  return typeof level === 'string' && level in EFFORT_STYLES ? level : null
}

export const withEffort = (name: string, effort: string | null): ModelInfo => ({
  name,
  effort,
  isEffortKnown: effort !== null,
  isEffortPinned: false,
})

export const pinEffort = (prev: ModelInfo | null, effort: string): ModelInfo | null =>
  prev === null ? prev : { ...prev, effort, isEffortKnown: true, isEffortPinned: true }

// `/effort` sets the level for the whole session, so a model switch keeps it; otherwise the
// new model starts at what the settings ask of it
export const switchedModel = (prev: ModelInfo | null, name: string, configured: string | null): ModelInfo =>
  prev !== null && prev.isEffortPinned ? { ...prev, name } : withEffort(name, configured)

const knownLevel = (level: string | undefined): string | null =>
  level !== undefined && level in EFFORT_STYLES ? level : null

// The level `/effort` set, read from its answer row; null for any other row
export const effortFromRow = (blocks: readonly { type: string }[]): string | null => {
  for (const block of blocks) {
    const text = 'text' in block && typeof block.text === 'string' ? block.text : ''
    const level = knownLevel(EFFORT_SET.exec(text)?.[1])
    if (level !== null) return level
  }
  return null
}

// The level `/effort` set, read from the answer `$.command.run` returns; null for a refusal
export const effortFromAnswer = (text: string | undefined): string | null =>
  text === undefined ? null : knownLevel(EFFORT_ANSWER.exec(text)?.[1])

// /clear ends the session and the next one starts with empty state, while the engine keeps
// the model and its effort: they are carried over from the end to the next refresh
let carried: ModelInfo | null = null

const refreshModel = async ($: EngineInterface): Promise<void> => {
  const name = await $.session.model()
  const prev = await read($, model)
  if (prev !== null && prev.name === name) return
  const kept = prev === null && carried?.name === name ? carried : null
  carried = null
  const effort = configuredEffort(await $.settings.read(), name)
  await update($, model, () => kept ?? switchedModel(prev, name, effort))
}

// A turn with no response, an interrupted one, leaves the last fill as it was
const refreshFill = async ($: EngineInterface): Promise<void> => {
  const { context } = await $.session.usage()
  await update($, fill, prev => toFill(context) ?? prev)
}

// The window's categories as /context lists them, less the tool schemas loaded on demand,
// which stay outside it, and the empty ones
export const contextRows = (categories: readonly ContextCategory[], window: number): ContextRow[] =>
  categories.flatMap(({ name, tokens, color, kind }) =>
    kind === 'deferred' || tokens <= 0 ? [] : [{ name, tokens, percent: Math.round((tokens / window) * 100), color, kind }],
  )

// The engine's local count, as /context makes it with no request. What fills the window, by
// category, goes to the card over the bar
const countTokens = async ($: EngineInterface): Promise<{ tokens: number; window: number } | null> => {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const counted = context.breakdown
  if (counted === undefined) return null
  const rows = contextRows(counted.categories, counted.maxTokens)
  if (JSON.stringify(await read($, breakdown)) !== JSON.stringify(rows)) await update($, breakdown, () => rows)
  return { tokens: counted.totalTokens, window: context.window }
}

// The engine measures the window on each response, and a compaction or a /clear leaves its
// last measure behind: until the next response the bar shows the engine's own estimate
const estimateFill = async ($: EngineInterface): Promise<void> => {
  const counted = await countTokens($)
  if (counted !== null) await update($, fill, () => estimatedFill(counted.tokens, counted.window))
}

// A fresh session, and one `/clear` started, has no fill until its first response
const estimateMissingFill = async ($: EngineInterface): Promise<void> => {
  if ((await read($, fill)) === null) await estimateFill($)
}

// The local count as a request left, and what its response then measured. The count is not
// the measure, but what it grows by is near what the conversation grew by
type Baseline = { counted: number; measured: number }
let baseline: Baseline | null = null

// The engine takes the compacted or cleared conversation some time after the hooks have
// returned, and until then its estimate still counts the old one, matched to the old measure:
// the bar would keep its figure, with a `~`. It drops that measure once it has the new one,
// so the estimate waits for that, on the free figures, and after TAKE_WAIT_MS stops waiting. A
// response that measured the window meanwhile has the last word
const TAKE_POLL_MS = 50
const TAKE_WAIT_MS = 10_000
let isAwaitingTake = false

const estimateOnceTaken = async ($: EngineInterface, waitedMs = 0): Promise<void> => {
  if (!isAwaitingTake) return
  const { context } = await $.session.usage()
  if (context.percent !== undefined && waitedMs < TAKE_WAIT_MS) {
    $.clock.after(TAKE_POLL_MS, () => void estimateOnceTaken($, waitedMs + TAKE_POLL_MS))
    return
  }
  const counted = await countTokens($)
  await update($, fill, prev =>
    !isAwaitingTake || counted === null ? prev : estimatedFill(counted.tokens, counted.window),
  )
  isAwaitingTake = false
}

const estimateWhenTaken = ($: EngineInterface): void => {
  isAwaitingTake = true
  isDropTold = true
  $.clock.after(0, () => void estimateOnceTaken($))
}

// Where an organization manages Claude Code, `session.compact` passes over the plugins a person
// installs, and nothing tells the footer of a compaction. The engine still drops its measure
// once it has taken the compacted conversation: the clock sees the measure go, and the bar
// takes it as a compaction. A drop a hook already told of is left to that hook
let wasMeasured = false
let isDropTold = false

const followMeasure = async ($: EngineInterface): Promise<void> => {
  const { context } = await $.session.usage()
  const isDropped = wasMeasured && context.percent === undefined
  wasMeasured = context.percent !== undefined
  if (!isDropped) return
  if (isDropTold) {
    isDropTold = false
    return
  }
  baseline = null
  await update($, cache, prev => (prev === null || prev.requestAt === null ? prev : { ...prev, requestAt: null }))
  await estimateFill($)
}

// The last measure, and what the conversation grew by since its request, as counted locally
export const earlyTokens = (base: Baseline | null, counted: number): number | null =>
  base === null ? null : base.measured + Math.max(0, counted - base.counted)

// An early figure is shown only where it raises the bar: one that would not move the
// percentage leaves the measured figure, so the `~` comes and goes only on a real jump
export const raisedFill = (prev: ContextFill | null, early: ContextFill): ContextFill | null =>
  prev !== null && early.percent <= prev.percent ? prev : early

export const isAction = (question: Question): question is ContextAction => question in ACTIONS

// A click only asks: the question that replaces the icons runs the command on `yes`, and
// drops back to the icons after CONFIRM_MS, so a stray click never clears or compacts. The
// choices that replace the model or the effort close likewise after CHOOSE_MS
let askTimer: Timer | null = null

// The cache's countdown is drawn from the clock's last reading, and the footer drawn again
// only when its text changes: once a minute, then once a second for the last one
let cacheTtl: CacheTtl = DEFAULT_TTL
// How long a fork's entry lasts, once a request after one has told; until then, a request's
let renewTtl: CacheTtl | null = null
let cacheNow = 0
let shownRemaining = ''

// The agent in view as the band last told it; undefined until it tells after a load, so a
// reload never keeps a view the person has since left
let viewedAgent: string | null | undefined

// The TTLs the countdown runs on: warm-compact's while it is loaded, else the footer's own
const ttlsOf = async ($: EngineInterface): Promise<LearnedTtl> =>
  (await read($, warmTtl)) ?? { cache: cacheTtl, renew: renewTtl }

const tickCache = async ($: EngineInterface): Promise<void> => {
  cacheNow = await $.clock.now()
  const info = await read($, cache)
  // A model switch makes no request, so the clock sees it too
  const name = (await read($, model))?.name ?? null
  let text = ''
  if (info !== null) text = name !== null && name !== info.model ? COLD_TEXT : formatRemaining(remainingMs(info, ttlOf(info, await ttlsOf($)), cacheNow))
  if (text === shownRemaining) return
  shownRemaining = text
  $.ui.invalidate('ui.render')
}

// The engine keeps its TTL to itself: a request after a long enough pause tells it, and it
// is kept between sessions since it holds for the account
const learnTtl = async ($: EngineInterface, ttl: CacheTtl | null): Promise<void> => {
  if (ttl === null || ttl === cacheTtl) return
  cacheTtl = ttl
  await $.store.set(CACHE_TTL_KEY, ttl)
}

// A fork's entry is told apart the same way, by the first request after a long enough pause.
// On an account that caches for five minutes it can last no less
const learnRenewTtl = async ($: EngineInterface, ttl: CacheTtl | null): Promise<void> => {
  if (ttl === null || ttl === renewTtl || cacheTtl !== '1h') return
  renewTtl = ttl
  await $.store.set(RENEW_TTL_KEY, ttl)
}

// The first request after a pause tells how long the entry the last read left lasts, a fork's
// or a request's. While warm-compact is loaded it learns that itself, and the countdown runs on
// its figures, so the two never disagree
const learnFrom = async ($: EngineInterface, prev: CacheInfo, model: string, hit: number, requestAt: number): Promise<void> => {
  if ((await read($, warmTtl)) !== null) return
  if (prev.isFork !== true) return learnTtl($, inferTtl({ at: prev.requestAt, model: prev.model }, model, hit, requestAt))
  if (prev.requestAt !== null && prev.model === model) await learnRenewTtl($, inferRenewTtl(prev.requestAt, hit, requestAt))
}

const ask = async ($: EngineInterface, question: Question): Promise<void> => {
  askTimer?.cancel()
  await update($, asking, () => question)
  askTimer = $.clock.after(isAction(question) ? CONFIRM_MS : CHOOSE_MS, () => void update($, asking, () => null))
}

const settle = async ($: EngineInterface): Promise<void> => {
  askTimer?.cancel()
  askTimer = null
  await update($, asking, () => null)
}

const confirm = async ($: EngineInterface, action: ContextAction): Promise<void> => {
  await settle($)
  await $.command.run({ command: action })
}

// `/model <alias>` and `/effort <level>` save the pick as the default, as typed. A plugin's
// run skips its own `command.run` hooks, so the footer is updated from the answer here
const choose = async ($: EngineInterface, setting: Setting, choice: string): Promise<void> => {
  await settle($)
  const { text } = await $.command.run({ command: setting, args: choice })

  if (setting === 'model') {
    await refreshModel($)
    return
  }

  const effort = effortFromAnswer(text)
  if (effort !== null) await update($, model, prev => pinEffort(prev, effort))
}

export const choicesFor = (setting: Setting): readonly string[] =>
  setting === 'model' ? MODEL_CHOICES : Object.keys(EFFORT_STYLES)

const choiceLabel = (choice: string, current: string | null): string =>
  choice === current ? `${choice} ${CURRENT_MARK}` : choice

// The label pads the glyph so the whole chip, not its one middle cell, takes the click
export const chipLabel = (text: string): string => ` ${text} `

export const chooserLength = (setting: Setting, current: string | null): number =>
  `${setting}:`.length +
  choicesFor(setting).reduce((sum, choice) => sum + 1 + chipLabel(choiceLabel(choice, current)).length, 0) +
  1 +
  chipLabel(CLOSE_ICON).length

export const actionsLength = (pending: ContextAction | null): number =>
  pending === null
    ? CONTEXT_ACTIONS.reduce((sum, action) => sum + chipLabel(ACTIONS[action].icon).length, 0) +
      ACTION_GAP * (CONTEXT_ACTIONS.length - 1)
    : ACTIONS[pending].question.length + ` ${chipLabel('yes')} ${chipLabel('no')}`.length

// `percent` is absent until the first response of a fresh or just-compacted window
export const toFill = (context: {
  percent?: number
  tokens?: number
  window: number
}): ContextFill | null =>
  context.percent === undefined || context.tokens === undefined
    ? null
    : { percent: context.percent, tokens: context.tokens, window: context.window, isEstimate: false }

export const estimatedFill = (tokens: number, window: number): ContextFill => ({
  percent: Math.min(100, Math.round((tokens / window) * 100)),
  tokens,
  window,
  isEstimate: true,
})

const bareModel = (id: string): string => id.replace(/\[1m\]$/, '')

// A subagent on the session's model has the session's window; another model, its own default
export const agentWindow = (agentModel: string, sessionModel: string, sessionWindow: number): number => {
  if (agentModel.endsWith('[1m]')) return LONG_WINDOW
  return bareModel(agentModel) === bareModel(sessionModel) ? sessionWindow : DEFAULT_WINDOW
}

// What the request was answered over: uncached, cache-read and cache-written input alike
export const inputTokens = (usage: {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number => usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

// A response's own count of what it was answered over, as the engine measures it at turn end
export const measuredFill = (tokens: number, window: number): ContextFill => ({
  ...estimatedFill(tokens, window),
  isEstimate: false,
})

export const agentFill = (stats: AgentStats | null): ContextFill | null =>
  stats === null || stats.tokens === null ? null : measuredFill(stats.tokens, stats.window)

// A subagent's effort is the one its request named, never a setting the person pinned
export const agentModel = (stats: AgentStats | null): ModelInfo | null =>
  stats === null ? null : { name: stats.model, effort: stats.effort, isEffortKnown: true, isEffortPinned: false }

export const agentLabel = (info: { type: string; name?: string } | undefined): string => {
  const label = info === undefined ? AGENT_FALLBACK : info.type === 'teammate' ? (info.name ?? info.type) : info.type
  return label.length > AGENT_LABEL_MAX ? `${label.slice(0, AGENT_LABEL_MAX - 1)}…` : label
}

// 850, 3.1k, 98k, 1.2M: as short as the card's column allows
export const tokenText = (tokens: number): string => {
  if (tokens < 1000) return String(tokens)
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

export type CardCell = { glyph: string; color: string; text: string; isDim: boolean }

// The card's lines, the categories down each column of CARD_ROWS, every column lined up and every
// line padded to the card's full width: drawn over the rows above the footer, it covers every
// cell of them it spans. The window left and the compaction buffer are dimmed
export const cardLines = (rows: readonly ContextRow[]): CardCell[][] => {
  const columns: ContextRow[][] = []
  for (let i = 0; i < rows.length; i += CARD_ROWS) columns.push(rows.slice(i, i + CARD_ROWS))
  const cells = columns.map(column => {
    const nameWidth = Math.max(...column.map(row => row.name.length))
    const tokenWidth = Math.max(...column.map(row => tokenText(row.tokens).length))
    return column.map(row => ({
      glyph: ` ${ROW_GLYPHS[row.kind]}`,
      color: row.color,
      text: ` ${row.name.padEnd(nameWidth)}  ${tokenText(row.tokens).padStart(tokenWidth)} ${`${row.percent}%`.padStart(4)} `,
      isDim: row.kind !== 'used',
    }))
  })
  return Array.from({ length: Math.min(rows.length, CARD_ROWS) }, (_, line) =>
    cells.map(column => {
      const [first] = column
      return column[line] ?? { glyph: '', color: first?.color ?? '', text: ' '.repeat((first?.glyph.length ?? 0) + (first?.text.length ?? 0)), isDim: true }
    }),
  )
}

// What the card over warm-compact's mark says: what runs, and when
export const upcomingText = (coming: Upcoming, now: number): string => {
  const ms = coming.at - now
  const when = ms <= 0 ? 'now' : `in ${formatRemaining(ms)}`
  const { icon } = UPCOMING_STYLES[coming.kind]
  return coming.kind === 'compact'
    ? `${icon} Warm compact runs ${when}, before the cache goes cold`
    : `${icon} Keep warm renews the cache ${when}`
}

export type DesktopSegment = { text: string; color?: string }

// The desktop's line: the agent in view, how full its window is and the cache, each short
export const desktopSegments = (parts: {
  agent: string | null
  fill: ContextFill | null
  cached: CacheInfo | null
  remaining: string | null
  upcoming: Upcoming | null
}): DesktopSegment[] => {
  const segments: DesktopSegment[] = []
  if (parts.agent !== null) segments.push({ text: `${AGENT_ICON} ${parts.agent}` })
  if (parts.fill !== null) {
    const percent = Math.min(100, Math.max(0, parts.fill.percent))
    segments.push({ text: `Context ${parts.fill.isEstimate ? '~' : ''}${percent}%`, color: colorFor(percent) })
  }
  if (parts.cached !== null && parts.remaining !== null) {
    const mark = parts.upcoming === null ? '' : ` ${UPCOMING_STYLES[parts.upcoming.kind].icon}`
    segments.push({
      text: `Cache ${parts.cached.hitPercent}% ${parts.remaining}${mark}`,
      color: parts.remaining === COLD_TEXT ? COLD_COLOR : hitColor(parts.cached.hitPercent),
    })
  }
  return segments
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { context } = await $.session.usage()
    // A reload fires session.start before any new response: keep the last known fill
    await update($, fill, prev => toFill(context) ?? prev)
    const name = await $.session.model()
    const effort = configuredEffort(await $.settings.read(), name)
    // A reload keeps what a request or `/effort` told about the same model
    await update($, model, prev =>
      prev !== null && prev.name === name && prev.isEffortKnown ? prev : withEffort(name, effort),
    )
    // `/model`, its picker and alt+p switch the model without any event or request
    $.clock.every(MODEL_POLL_MS, () => void refreshModel($))
    wasMeasured = context.percent !== undefined
    isDropTold = false
    $.clock.every(FILL_POLL_MS, () => void estimateMissingFill($).then(() => followMeasure($)))
    const stored = await $.store.get(CACHE_TTL_KEY)
    if (isCacheTtl(stored)) cacheTtl = stored
    const storedRenewTtl = await $.store.get(RENEW_TTL_KEY)
    if (isCacheTtl(storedRenewTtl)) renewTtl = storedRenewTtl
    cacheNow = await $.clock.now()
    $.clock.every(CACHE_TICK_MS, () => void tickCache($))
    // A resumed session has a measure and no breakdown until its first request
    $.clock.after(0, () => void countTokens($))
    viewedAgent = undefined
    return next(e)
  })

  // Only the band above the prompt is told which transcript is on screen, and told again on
  // each switch: the footer follows it from there. It draws nothing of its own, and as a
  // drawing writes no state, the footer is told from the clock
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const agentId = e.props.view?.agentId ?? null
    if (agentId !== viewedAgent) {
      viewedAgent = agentId
      const label = agentId === null ? '' : agentLabel((await $.agent.list()).find(agent => agent.id === agentId))
      $.clock.after(0, () => void update($, viewing, () => (agentId === null ? null : { id: agentId, label })))
    }
    return next(e)
  })

  // The card over the bar takes in the turn's last answer
  on('turn.complete', async ($, e, next) => {
    await refreshFill($)
    await refreshModel($)
    if (e.agentId === undefined) $.clock.after(0, () => void countTokens($))
    return next(e)
  })

  // The effort is only known on a request, after any downgrade for the selected model, and the
  // window's fill on each response
  // The cache is read on each main-thread request; the first after a message says how much
  // of the conversation was still cached when it was sent
  on('turn.step', async function* ($, e, next) {
    const effort = e.effort === undefined ? null : String(e.effort)
    // A subagent's requests are kept apart, for the footer to show while its transcript is
    const agentId = e.agentId
    if (agentId !== undefined) {
      const { context } = await $.session.usage()
      const window = agentWindow(e.model, await $.session.model(), context.window)
      const stats = memberOf(agents, { requestId: agentId })
      await update($, stats, prev => ({ model: e.model, effort, tokens: prev?.tokens ?? null, window }))
      return yield* tap(next(e), async chunk => {
        if (chunk.kind !== 'stop' || chunk.usage === null) return
        const tokens = inputTokens(chunk.usage)
        await update($, stats, prev => (prev === null ? prev : { ...prev, tokens }))
      })
    }
    const name = await $.session.model()
    await update($, model, prev => ({ name, effort, isEffortKnown: true, isEffortPinned: prev?.isEffortPinned ?? false }))
    const requestAt = await $.clock.now()
    const { context } = await $.session.usage()
    // What the conversation took on since the last response (tool results, the new prompt) is
    // counted as the request leaves, without holding it, and shown until this one measures
    let isMeasured = false
    const counting = countTokens($).catch(() => null)
    void counting.then(async counted => {
      const tokens = counted === null ? null : earlyTokens(baseline, counted.tokens)
      if (tokens === null || counted === null || isMeasured) return
      const early = estimatedFill(tokens, counted.window)
      await update($, fill, prev => (isMeasured ? prev : raisedFill(prev, early)))
    })
    return yield* tap(next(e), async chunk => {
      if (chunk.kind !== 'stop' || chunk.usage === null) return
      // Each response of a turn moves the bar, not only the turn's end
      isMeasured = true
      isAwaitingTake = false
      const tokens = inputTokens(chunk.usage)
      await update($, fill, () => measuredFill(tokens, context.window))
      const counted = await counting
      baseline = counted === null ? null : { counted: counted.tokens, measured: tokens }
      const hit = hitPercent(chunk.usage)
      const prev = await read($, cache)
      if (e.index === 0 && hit !== null && prev !== null) await learnFrom($, prev, name, hit, requestAt)
      const hitNow = e.index === 0 || prev === null ? (hit ?? prev?.hitPercent ?? 0) : prev.hitPercent
      await update($, cache, () => ({ hitPercent: hitNow, requestAt, model: name }))
    })
  })

  // A plugin's fork re-sends the main thread's last request with one more message after it,
  // whichever plugin forks: it reads the conversation from the cache, or writes it there once
  // the entry lapsed, and either way the entry starts over. Keep warm renews the cache so
  on('model.fork', async ($, e, next) => {
    const requestAt = await $.clock.now()
    const result = await next(e)
    const usage = result.value !== undefined && 'usage' in result.value ? result.value.usage : null
    const hit = usage === null ? null : hitPercent(usage)
    if (hit === null) return result
    const name = await $.session.model()
    await update($, cache, () => ({ hitPercent: hit, requestAt, model: name, isFork: true }))
    return result
  })

  // `/effort` changes the level without a request: its answer row says to what
  on('session.append', { door: 'command' }, async ($, e, next) => {
    const effort = e.agentId === undefined ? effortFromRow(e.message.content) : null
    if (effort !== null) await update($, model, prev => pinEffort(prev, effort))
    return next(e)
  })

  // The cleared conversation is estimated once the engine has emptied it
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') return next(e)
    carried = await read($, model)
    baseline = null
    const result = await next(e)
    estimateWhenTaken($)
    return result
  })

  // The compacted conversation is estimated once the engine has taken it. A compaction computed ahead or vetoed leaves the conversation as it was,
  // and a subagent's leaves the main one. A compacted conversation is a new prefix, which the
  // cache has none of yet
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined || result.skip !== undefined) return result
    baseline = null
    estimateWhenTaken($)
    await update($, cache, prev => (prev === null ? prev : { ...prev, requestAt: null }))
    return result
  })

  // The footer's right-hand slot, which the engine lays out after the hint line. A tree
  // drawn for `PromptHint` instead shares a row with the mode label the engine puts ahead
  // of it, and any width it claims squeezes that label until its ` · ` wraps
  // While an agent's transcript is on screen the footer shows that agent's model, effort and
  // window, read-only: the picks, the cache and the actions are the conversation's
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const viewed = await read($, viewing)
    const stats = viewed === null ? null : await read($, memberOf(agents, { requestId: viewed.id }))
    const current = viewed === null ? await read($, fill) : agentFill(stats)
    const info = viewed === null ? await read($, model) : agentModel(stats)

    if (viewed === null && current === null && info === null) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? DEFAULT_COLUMNS
    // The labels already in the slot (`focus`, `memory paused`) keep the engine's drawing, and
    // what other mods beneath draw there goes with them, at the right end
    const modesText = e.props.modes.join(' & ')
    const beneath = await next(e)

    // The desktop draws the model, the effort and the window's fill of its own, and lays this
    // slot out as one short line, its buttons first: it gets one line of what it lacks
    if (e.surface !== 'terminal') {
      const cached = viewed === null ? await read($, cache) : null
      const isSameModel = cached === null || info === null || info.name === cached.model
      const remaining =
        cached === null ? null : isSameModel ? formatRemaining(remainingMs(cached, ttlOf(cached, await ttlsOf($)), cacheNow)) : COLD_TEXT
      const coming = remaining === null || remaining === COLD_TEXT ? null : await read($, warmUpcoming)
      const segments = desktopSegments({ agent: viewed?.label ?? null, fill: current, cached, remaining, upcoming: coming })
      return (
        <Box flexShrink={0} gap={1}>
          {segments.map((segment, i) => (
            <Text color={segment.color} dimColor={segment.color === undefined}>{`${i === 0 ? '' : '· '}${segment.text}`}</Text>
          ))}
          {beneath}
        </Box>
      )
    }

    const parts = info === null ? null : modelParts(info)
    const pending = viewed === null ? await read($, asking) : null
    const confirming = pending !== null && isAction(pending) ? pending : null
    // An effort pick is moot once the model in use takes none
    const choosing =
      pending === null || isAction(pending) || parts === null || (pending === 'effort' && parts.effort === null)
        ? null
        : pending
    const selected =
      choosing === 'model' ? (parts?.family ?? null) : info !== null && info.isEffortKnown ? info.effort : null

    let modelBlock = null
    let modelLength = 0

    if (parts !== null && choosing !== null) {
      const chips = choosing === 'model' ? MODEL_CHIPS : EFFORT_CHIPS
      modelLength = chooserLength(choosing, selected)
      modelBlock = (
        <Box flexShrink={0} gap={1}>
          <Text dimColor>{`${choosing}:`}</Text>
          {choicesFor(choosing).map(choice => (
            <Box backgroundColor={chips[choice] ?? NO_COLOR}>
              <Button
                key={`${choosing}:${choice}`}
                label={chipLabel(choiceLabel(choice, selected))}
                plain
                onPress={() => void (choice === selected ? settle($) : choose($, choosing, choice))}
              />
            </Box>
          ))}
          <Box backgroundColor={NO_COLOR}>
            <Button key="close" label={chipLabel(CLOSE_ICON)} plain onPress={() => void settle($)} />
          </Box>
        </Box>
      )
    } else if (parts !== null) {
      modelLength = parts.length
      // A Button takes no color at rest: the icons keep the model's and the effort's
      modelBlock = (
        <Box flexShrink={0}>
          <Text color={parts.modelColor}>{`${MODEL_ICON} `}</Text>
          {viewed === null ? (
            <Button key="model" label={parts.name} plain onPress={() => void ask($, 'model')} />
          ) : (
            <Text>{parts.name}</Text>
          )}
          {parts.effort !== null && (
            <Text color={parts.effort.color}>
              {`${' '.repeat(EFFORT_GAP)}${parts.effort.icon === '' ? '' : `${parts.effort.icon} `}`}
            </Text>
          )}
          {parts.effort !== null &&
            (viewed === null ? (
              <Button key="effort" label={parts.effort.label} plain onPress={() => void ask($, 'effort')} />
            ) : (
              <Text>{parts.effort.label}</Text>
            ))}
        </Box>
      )
    }

    let bar = null
    let barLength = 0

    if (current !== null) {
      const percent = Math.min(100, Math.max(0, current.percent))
      const isCompact = columns < COMPACT_BELOW
      const barWidth = barWidthFor(columns)
      const filled = Math.round((percent / 100) * barWidth)
      const color = colorFor(percent)
      const label = isCompact ? '' : 'Context '
      const percentText = ` ${current.isEstimate ? '~' : ''}${percent}%`
      barLength = label.length + barWidth + percentText.length
      // The conversation's alone: a subagent's window has no breakdown
      const rows = viewed === null ? await read($, breakdown) : null
      const card = rows === null || rows.length === 0 ? null : cardLines(rows)

      // Hovering the bar shows the card over the rows above it, right-aligned to it
      bar = (
        <Box key="context-card" flexShrink={0}>
          {label !== '' && <Text dimColor>{label}</Text>}
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
          <Text color={color} bold>
            {percentText}
          </Text>
          {card !== null && (
            <Box position="absolute" bottom={1} right={0} display="none" hover={{ display: 'flex' }} flexDirection="column">
              {card.map(line => (
                <Box>
                  {line.flatMap(cell => [
                    <Text color={cell.color}>{cell.glyph}</Text>,
                    <Text dimColor={cell.isDim}>{cell.text}</Text>,
                  ])}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    let cacheBlock = null
    let cacheLength = 0
    const cached = viewed === null ? await read($, cache) : null

    if (cached !== null) {
      const label = columns < COMPACT_BELOW ? '' : 'Cache '
      const percentText = `${cached.hitPercent}%`
      // The cache is per model: one switched to has none of the conversation yet
      const isSameModel = info === null || info.name === cached.model
      const remaining = isSameModel ? formatRemaining(remainingMs(cached, ttlOf(cached, await ttlsOf($)), cacheNow)) : COLD_TEXT
      // warm-compact's mark for what it does before the entry lapses, while there is one
      const upcoming = await read($, warmUpcoming)
      const coming = remaining === COLD_TEXT ? null : upcoming
      const mark = coming === null ? null : UPCOMING_STYLES[coming.kind]
      cacheLength = label.length + percentText.length + 1 + remaining.length + (mark === null ? 0 : 1 + mark.icon.length)

      cacheBlock = (
        <Box key="cache-card" flexShrink={0}>
          {label !== '' && <Text dimColor>{label}</Text>}
          <Text color={hitColor(cached.hitPercent)} bold>
            {percentText}
          </Text>
          {remaining === COLD_TEXT ? <Text color={COLD_COLOR}>{` ${remaining}`}</Text> : <Text dimColor>{` ${remaining}`}</Text>}
          {mark !== null && <Text color={mark.color}>{` ${mark.icon}`}</Text>}
          {coming !== null && (
            <Box position="absolute" bottom={1} right={0} display="none" hover={{ display: 'flex' }} borderStyle="round" borderDimColor>
              <Text>{` ${upcomingText(coming, cacheNow)} `}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const agentText = viewed === null ? '' : `${AGENT_ICON} ${viewed.label}`
    const agentBlock = agentText === '' ? null : <Text dimColor>{agentText}</Text>

    const actions =
      viewed !== null ? null : confirming === null ? (
        <Box flexShrink={0} gap={ACTION_GAP}>
          {CONTEXT_ACTIONS.map(action => (
            <Box backgroundColor={ACTIONS[action].color}>
              <Button key={action} label={chipLabel(ACTIONS[action].icon)} plain onPress={() => void ask($, action)} />
            </Box>
          ))}
        </Box>
      ) : (
        <Box flexShrink={0} gap={1}>
          <Text color={ACTIONS[confirming].color} bold>
            {ACTIONS[confirming].question}
          </Text>
          <Box backgroundColor={ACTIONS[confirming].color}>
            <Button key="yes" label={chipLabel('yes')} plain onPress={() => void confirm($, confirming)} />
          </Box>
          <Box backgroundColor={NO_COLOR}>
            <Button key="no" label={chipLabel('no')} plain onPress={() => void settle($)} />
          </Box>
        </Box>
      )

    const blocks = [
      agentText.length,
      cacheLength,
      modelLength,
      barLength,
      viewed === null ? actionsLength(confirming) : 0,
      modesText.length,
    ].filter(n => n > 0)
    const rightLength = blocks.reduce((sum, n) => sum + n, 0) + BLOCK_GAP * (blocks.length - 1)

    if (fitsInRow(columns, rightLength)) {
      return (
        <Box flexShrink={0} gap={BLOCK_GAP}>
          {agentBlock}
          {cacheBlock}
          {modelBlock}
          {bar}
          {actions}
          {beneath}
        </Box>
      )
    }

    return (
      <Box flexShrink={0} flexDirection="column" alignItems="flex-end">
        {agentBlock}
        {cacheBlock}
        {modelBlock}
        {bar}
        {actions}
        {beneath}
      </Box>
    )
  })
}
