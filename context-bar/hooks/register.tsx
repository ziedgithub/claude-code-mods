import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CacheTtl, ContextAction, ContextFill, ModelInfo, Question, Setting } from '../types'
import { COLD_TEXT, DEFAULT_TTL, formatRemaining, hitColor, hitPercent, inferTtl, isCacheTtl, remainingMs } from './cache'

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

const fill = atom({ plugin: 'context-bar', key: 'fill' } as const, null)
const model = atom({ plugin: 'context-bar', key: 'model' } as const, null)
const asking = atom({ plugin: 'context-bar', key: 'asking' } as const, null)
const cache = atom({ plugin: 'context-bar', key: 'cache' } as const, null)

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

// The engine measures the window on each response, and a compaction or a /clear leaves its
// last measure behind: until the next response the bar shows the engine's own estimate, the
// one /context makes, counted locally with no request
const estimateFill = async ($: EngineInterface): Promise<void> => {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const tokens = context.breakdown?.totalTokens
  if (tokens !== undefined) await update($, fill, () => estimatedFill(tokens, context.window))
}

// A fresh session, and one `/clear` started, has no fill until its first response
const estimateMissingFill = async ($: EngineInterface): Promise<void> => {
  if ((await read($, fill)) === null) await estimateFill($)
}

export const isAction = (question: Question): question is ContextAction => question in ACTIONS

// A click only asks: the question that replaces the icons runs the command on `yes`, and
// drops back to the icons after CONFIRM_MS, so a stray click never clears or compacts. The
// choices that replace the model or the effort close likewise after CHOOSE_MS
let askTimer: Timer | null = null

// The cache's countdown is drawn from the clock's last reading, and the footer drawn again
// only when its text changes: once a minute, then once a second for the last one
let cacheTtl: CacheTtl = DEFAULT_TTL
let cacheNow = 0
let shownRemaining = ''

const tickCache = async ($: EngineInterface): Promise<void> => {
  cacheNow = await $.clock.now()
  const info = await read($, cache)
  // A model switch makes no request, so the clock sees it too
  const name = (await read($, model))?.name ?? null
  let text = ''
  if (info !== null) text = name !== null && name !== info.model ? COLD_TEXT : formatRemaining(remainingMs(info, cacheTtl, cacheNow))
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

// Passes the response on as it streams, seeing each chunk on the way
async function* tap<T, R>(stream: AsyncGenerator<T, R>, see: (chunk: T) => Promise<void>): AsyncGenerator<T, R> {
  for (;;) {
    const step = await stream.next()
    if (step.done === true) return step.value
    await see(step.value)
    yield step.value
  }
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
    $.clock.every(FILL_POLL_MS, () => void estimateMissingFill($))
    const stored = await $.store.get(CACHE_TTL_KEY)
    if (isCacheTtl(stored)) cacheTtl = stored
    cacheNow = await $.clock.now()
    $.clock.every(CACHE_TICK_MS, () => void tickCache($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refreshFill($)
    await refreshModel($)
    return next(e)
  })

  // The effort is only known on a request, after any downgrade for the selected model
  // The cache is read on each main-thread request; the first after a message says how much
  // of the conversation was still cached when it was sent
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const effort = e.effort === undefined ? null : String(e.effort)
    const name = await $.session.model()
    await update($, model, prev => ({ name, effort, isEffortKnown: true, isEffortPinned: prev?.isEffortPinned ?? false }))
    const requestAt = await $.clock.now()
    return yield* tap(next(e), async chunk => {
      if (chunk.kind !== 'stop' || chunk.usage === null) return
      const hit = hitPercent(chunk.usage)
      const prev = await read($, cache)
      if (e.index === 0 && hit !== null && prev !== null) await learnTtl($, inferTtl(prev, name, hit, requestAt))
      const hitNow = e.index === 0 || prev === null ? (hit ?? prev?.hitPercent ?? 0) : prev.hitPercent
      await update($, cache, () => ({ hitPercent: hitNow, requestAt, model: name }))
    })
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
    const result = await next(e)
    $.clock.after(0, () => void estimateFill($))
    return result
  })

  // The engine takes the compacted conversation once the hooks have returned, so its estimate
  // waits for that. A compaction computed ahead or vetoed leaves the conversation as it was,
  // and a subagent's leaves the main one. A compacted conversation is a new prefix, which the
  // cache has none of yet
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined || result.skip !== undefined) return result
    $.clock.after(0, () => void estimateFill($))
    await update($, cache, prev => (prev === null ? prev : { ...prev, requestAt: null }))
    return result
  })

  // The footer's right-hand slot, which the engine lays out after the hint line. A tree
  // drawn for `PromptHint` instead shares a row with the mode label the engine puts ahead
  // of it, and any width it claims squeezes that label until its ` · ` wraps
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const current = await read($, fill)
    const info = await read($, model)

    if (current === null && info === null) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? DEFAULT_COLUMNS
    // The labels already in the slot (`focus`, `memory paused`) keep the engine's drawing, and
    // what other mods beneath draw there goes with them, at the right end
    const modesText = e.props.modes.join(' & ')
    const beneath = await next(e)

    const parts = info === null ? null : modelParts(info)
    const pending = await read($, asking)
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
          <Button key="model" label={parts.name} plain onPress={() => void ask($, 'model')} />
          {parts.effort !== null && (
            <Text color={parts.effort.color}>
              {`${' '.repeat(EFFORT_GAP)}${parts.effort.icon === '' ? '' : `${parts.effort.icon} `}`}
            </Text>
          )}
          {parts.effort !== null && (
            <Button key="effort" label={parts.effort.label} plain onPress={() => void ask($, 'effort')} />
          )}
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

      bar = (
        <Box flexShrink={0}>
          {label !== '' && <Text dimColor>{label}</Text>}
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
          <Text color={color} bold>
            {percentText}
          </Text>
        </Box>
      )
    }

    let cacheBlock = null
    let cacheLength = 0
    const cached = await read($, cache)

    if (cached !== null) {
      const label = columns < COMPACT_BELOW ? '' : 'Cache '
      const percentText = `${cached.hitPercent}%`
      // The cache is per model: one switched to has none of the conversation yet
      const isSameModel = info === null || info.name === cached.model
      const remaining = isSameModel ? formatRemaining(remainingMs(cached, cacheTtl, cacheNow)) : COLD_TEXT
      cacheLength = label.length + percentText.length + 1 + remaining.length

      cacheBlock = (
        <Box flexShrink={0}>
          {label !== '' && <Text dimColor>{label}</Text>}
          <Text color={hitColor(cached.hitPercent)} bold>
            {percentText}
          </Text>
          {remaining === COLD_TEXT ? <Text color={COLD_COLOR}>{` ${remaining}`}</Text> : <Text dimColor>{` ${remaining}`}</Text>}
        </Box>
      )
    }

    const actions =
      confirming === null ? (
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

    const blocks = [modelLength, barLength, cacheLength, actionsLength(confirming), modesText.length].filter(
      n => n > 0,
    )
    const rightLength = blocks.reduce((sum, n) => sum + n, 0) + BLOCK_GAP * (blocks.length - 1)

    if (fitsInRow(columns, rightLength)) {
      return (
        <Box flexShrink={0} gap={BLOCK_GAP}>
          {modelBlock}
          {bar}
          {cacheBlock}
          {actions}
          {beneath}
        </Box>
      )
    }

    return (
      <Box flexShrink={0} flexDirection="column" alignItems="flex-end">
        {modelBlock}
        {bar}
        {cacheBlock}
        {actions}
        {beneath}
      </Box>
    )
  })
}
