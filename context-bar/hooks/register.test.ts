import { expect, mock, test } from 'claude-code/testing'

import {
  actionsLength,
  agentFill,
  agentLabel,
  agentModel,
  agentWindow,
  barWidthFor,
  choicesFor,
  chooserLength,
  colorFor,
  configuredEffort,
  displayModelName,
  earlyTokens,
  effortFromAnswer,
  effortFromRow,
  estimatedFill,
  fitsInRow,
  inputTokens,
  isAction,
  modelParts,
  pinEffort,
  raisedFill,
  switchedModel,
  toFill,
  withEffort,
} from './register'

test('colorFor switches at 30 and 60', () => {
  expect(colorFor(0)).toBe('#3fb950')
  expect(colorFor(29)).toBe('#3fb950')
  expect(colorFor(30)).toBe('#ff9500')
  expect(colorFor(59)).toBe('#ff9500')
  expect(colorFor(60)).toBe('#f85149')
  expect(colorFor(100)).toBe('#f85149')
})

test('toFill is null until the first response of the window', () => {
  expect(toFill({ window: 200000 })).toBe(null)
  expect(toFill({ window: 200000, percent: 42, tokens: 84000 })).toEqual({
    percent: 42,
    tokens: 84000,
    window: 200000,
    isEstimate: false,
  })
})

test('estimatedFill marks the estimate and caps it at a full window', () => {
  expect(estimatedFill(31000, 200000)).toEqual({ percent: 16, tokens: 31000, window: 200000, isEstimate: true })
  expect(estimatedFill(250000, 200000).percent).toBe(100)
})

test('barWidthFor follows the terminal width within bounds', () => {
  expect(barWidthFor(40)).toBe(3)
  expect(barWidthFor(120)).toBe(6)
  expect(barWidthFor(300)).toBe(8)
})

test('displayModelName turns model ids into names', () => {
  expect(displayModelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(displayModelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(displayModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(displayModelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(displayModelName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)')
  expect(displayModelName('Sonnet 5.5')).toBe('Sonnet 5.5')
})

test('modelParts colors the model by family and the effort by level', () => {
  const sonnet = modelParts({ name: 'claude-sonnet-5-5', effort: 'high', isEffortKnown: true, isEffortPinned: false })
  expect(sonnet.name).toBe('Sonnet 5.5')
  expect(sonnet.family).toBe('sonnet')
  expect(sonnet.modelColor).toBe('#58a6ff')
  expect(sonnet.effort).toEqual({ icon: '▆', color: '#e3b341', label: 'high' })
  expect(sonnet.length).toBe('◆ Sonnet 5.5  ▆ high'.length)
})

test('modelParts omits the effort for a model without one and marks it pending before a request', () => {
  expect(modelParts({ name: 'claude-haiku-4-5', effort: null, isEffortKnown: true, isEffortPinned: false }).effort).toBe(null)
  expect(modelParts({ name: 'claude-sonnet-5-5', effort: null, isEffortKnown: false, isEffortPinned: false }).effort?.label).toBe('…')
})

test('fitsInRow compares the right-hand blocks to the width', () => {
  expect(fitsInRow(40, 32)).toBe(true)
  expect(fitsInRow(30, 32)).toBe(false)
})

test('configuredEffort prefers the model row of modelSettings over the global level', () => {
  const settings = { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }
  expect(configuredEffort(settings, 'claude-opus-5-5')).toBe('xhigh')
  expect(configuredEffort(settings, 'claude-opus-5-5[1m]')).toBe('xhigh')
  expect(configuredEffort(settings, 'claude-sonnet-5-5')).toBe('medium')
  expect(configuredEffort({}, 'claude-opus-5-5')).toBe(null)
  expect(configuredEffort({ effortLevel: 'auto' }, 'claude-opus-5-5')).toBe(null)
})

test('withEffort marks the effort pending when the settings name none', () => {
  expect(withEffort('claude-opus-5-5', 'high')).toEqual({
    name: 'claude-opus-5-5',
    effort: 'high',
    isEffortKnown: true,
    isEffortPinned: false,
  })
  expect(withEffort('claude-opus-5-5', null).isEffortKnown).toBe(false)
})

test('effortFromRow reads the level from the answer of /effort only', () => {
  const answer = (text: string) => [{ type: 'text', text }]
  expect(effortFromRow(answer('<local-command-stdout>Set effort level to high (this session only): Comprehensive</local-command-stdout>'))).toBe('high')
  expect(effortFromRow(answer('<local-command-stdout>Set effort level to max: Maximum capability</local-command-stdout>'))).toBe('max')
  expect(effortFromRow(answer('<command-name>/effort</command-name>'))).toBe(null)
  expect(effortFromRow(answer('Set effort level to high'))).toBe(null)
  expect(effortFromRow([{ type: 'image' }])).toBe(null)
})

test('actionsLength counts the icons at rest and the question while one is asked', () => {
  expect(actionsLength(null)).toBe(' ⇊    ⌫ '.length)
  expect(actionsLength('clear')).toBe('clear context?  yes   no '.length)
})

test('effortFromAnswer reads the level from the answer `$.command.run` returns', () => {
  expect(effortFromAnswer('Set effort level to high (saved as your default for new sessions): Comprehensive')).toBe('high')
  expect(effortFromAnswer("Effort 'max' exceeds the cap for Sonnet 5.5")).toBe(null)
  expect(effortFromAnswer(undefined)).toBe(null)
})

test('isAction tells the confirmations from the setting picks', () => {
  expect(isAction('clear')).toBe(true)
  expect(isAction('compact')).toBe(true)
  expect(isAction('model')).toBe(false)
  expect(isAction('effort')).toBe(false)
})

test('choicesFor lists the model aliases and the effort levels', () => {
  expect(choicesFor('model')).toEqual(['opus', 'sonnet', 'haiku', 'fable'])
  expect(choicesFor('effort')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

test('chooserLength counts the chips with the current one marked', () => {
  expect(chooserLength('model', 'sonnet')).toBe('model:  opus   sonnet ✔   haiku   fable   ✕ '.length)
  expect(chooserLength('effort', null)).toBe('effort:  low   medium   high   xhigh   max   ✕ '.length)
})

test('switchedModel keeps an effort `/effort` pinned and otherwise takes the configured one', () => {
  const configured = withEffort('claude-sonnet-5-5', 'xhigh')
  expect(switchedModel(configured, 'claude-opus-5-5', 'max')).toEqual(withEffort('claude-opus-5-5', 'max'))
  const pinned = pinEffort(configured, 'high')
  expect(pinned).toEqual({ name: 'claude-sonnet-5-5', effort: 'high', isEffortKnown: true, isEffortPinned: true })
  expect(switchedModel(pinned, 'claude-opus-5-5', 'max')).toEqual({ ...pinned, name: 'claude-opus-5-5' })
  expect(switchedModel(null, 'claude-opus-5-5', null)).toEqual(withEffort('claude-opus-5-5', null))
  expect(pinEffort(null, 'high')).toBe(null)
})

test("agentWindow takes the session's window for its model and a default for another", () => {
  expect(agentWindow('claude-opus-5-5', 'claude-opus-5-5[1m]', 1_000_000)).toBe(1_000_000)
  expect(agentWindow('claude-haiku-4-5', 'claude-opus-5-5[1m]', 1_000_000)).toBe(200_000)
  expect(agentWindow('claude-sonnet-5-5[1m]', 'claude-opus-5-5', 200_000)).toBe(1_000_000)
})

test("agentFill and agentModel read a subagent's last request, and nothing before it", () => {
  const stats = { model: 'claude-haiku-4-5', effort: null, tokens: 30_000, window: 200_000 }
  expect(inputTokens({ input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 9_990 })).toBe(30_000)
  expect(agentFill(stats)).toEqual({ percent: 15, tokens: 30_000, window: 200_000, isEstimate: false })
  expect(agentFill({ ...stats, tokens: null })).toBe(null)
  expect(agentFill(null)).toBe(null)
  expect(agentModel(stats)).toEqual({ name: 'claude-haiku-4-5', effort: null, isEffortKnown: true, isEffortPinned: false })
  expect(agentModel(null)).toBe(null)
})

test("agentLabel names a subagent by its type and a teammate by its name", () => {
  expect(agentLabel({ type: 'Explore', name: 'agent-7f3a' })).toBe('Explore')
  expect(agentLabel({ type: 'teammate', name: 'reviewer' })).toBe('reviewer')
  expect(agentLabel(undefined)).toBe('agent')
  expect(agentLabel({ type: 'a-very-long-custom-agent-type' })).toBe('a-very-long-custom-…')
})

const SUMMARY = [{ role: 'user', text: 'The conversation so far.', toolUses: [] }]

// The engine beneath the mod: a clock, a session whose window the last response measured at
// `measured` and the local count estimates at `estimate`, and a compaction
const engine = (on: any) => {
  const clock = mock.clock(on)
  mock.store(on, {})
  const world = { clock, measured: { percent: 60, tokens: 120000 } as { percent?: number; tokens?: number }, estimate: 31000 }
  on('session.usage', async (_$: unknown, e: { breakdown?: string }) => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 200000,
        ...world.measured,
        ...(e.breakdown === undefined ? {} : { breakdown: { totalTokens: world.estimate, maxTokens: 200000, categories: [] } }),
      },
    },
  }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', async () => ({ value: {} }))
  on('session.start', async () => ({ cwd: '/' }))
  on('session.end', async (_$: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.compact', async () => ({ messages: SUMMARY, tokensBefore: 120000, tokensAfter: 2000 }))
  // The engine draws nothing in the slot with no mode label
  on('ui.render', async ($: any, e: unknown) => h($.ui.resolve(e).Box, null))
  return world
}

const footerOf = async ($: any) => {
  const footer = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'footer' })
  return async (): Promise<string | undefined> => (await footer.find({ type: 'Text', text: /%$/ }))?.text
}

const COMPLETE = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as never

test('a compaction shows the estimate until the next response measures the window', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const percent = await footerOf($)
  expect(await percent()).toBe(' 60%')

  // The engine has no measure once compacted, only its estimate
  world.measured = {}
  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
  await world.clock.advance(10)
  expect(await percent()).toBe(' ~16%')

  // The next response measures it
  world.measured = { percent: 13, tokens: 26000 }
  await $.turn.complete(COMPLETE)
  expect(await percent()).toBe(' 13%')
})

test('a compaction computed ahead, vetoed, or of a subagent leaves the bar as it was', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const percent = await footerOf($)
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY } as never)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY, agentId: 'a1' } as never)
  await world.clock.advance(10)
  expect(await percent()).toBe(' 60%')
})

test('a cleared session shows the estimate, and an interrupted turn keeps it', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const percent = await footerOf($)
  world.measured = {}
  world.estimate = 24000
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } } as never)
  await world.clock.advance(10)
  expect(await percent()).toBe(' ~12%')
  await $.turn.complete({ ...(COMPLETE as object), reason: 'aborted' } as never)
  expect(await percent()).toBe(' ~12%')
})

test('a fresh session shows the estimate before its first response', async ($, on) => {
  const world = engine(on)
  world.measured = {}
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const percent = await footerOf($)
  await world.clock.advance(1000)
  expect(await percent()).toBe(' ~16%')
})

const MINUTE = 60_000
// The countdowns below run the footer's one-second clocks for up to seventy minutes
const LONG = { timeoutMs: 20_000 }
const HIT = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 990 }
const MISS = { ...HIT, cache_read_input_tokens: 0, cache_creation_input_tokens: 99_990 }
type Usage = typeof HIT

// Beneath the mod as well: the conversation's requests and other plugins' forks, each costing
// what `step` and `fork` say
const cacheEngine = (on: any) => {
  // The engine's own world, so a test's change to what it measured reaches it
  const world = Object.assign(engine(on), { step: HIT, fork: HIT as Usage | null, answerMs: 0 })
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    if (world.answerMs > 0) await world.clock.sleep(world.answerMs)
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: world.step }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: world.step }
  })
  on('model.fork', async () => ({
    value: world.fork === null ? { isAnswered: false, reason: 'nothing-to-fork' } : { isAnswered: true, text: 'ok', usage: world.fork },
  }))
  return world
}

test('each response of a turn moves the bar before the turn ends, and the turn end keeps it', async ($, on) => {
  const world = cacheEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'footer' })
  const percent = async () => (await footer.find({ type: 'Text', text: /^ ~?\d+%$/ }))?.text
  expect(await percent()).toBe(' 60%')

  // Two requests of one turn, the second over the first's tool results
  world.step = { ...HIT, cache_read_input_tokens: 129_000 }
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
  expect(await percent()).toBe(' 65%')
  world.step = { ...HIT, cache_read_input_tokens: 139_000 }
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 3 }));
  expect(await percent()).toBe(' 70%')

  world.measured = { percent: 70, tokens: 140_000 }
  await $.turn.complete(COMPLETE)
  expect(await percent()).toBe(' 70%')
})

test('a response after a compaction replaces the estimate', async ($, on) => {
  const world = cacheEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'footer' })
  const percent = async () => (await footer.find({ type: 'Text', text: /^ ~?\d+%$/ }))?.text
  world.measured = {}
  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
  await world.clock.advance(10)
  expect(await percent()).toBe(' ~16%')
  world.step = { ...MISS, cache_creation_input_tokens: 39_990 }
  await request($, 't1')
  expect(await percent()).toBe(' 20%')
})

test('earlyTokens adds what the local count grew by to the last measure', () => {
  expect(earlyTokens(null, 50_000)).toBe(null)
  expect(earlyTokens({ counted: 31_000, measured: 100_000 }, 71_000)).toBe(140_000)
  expect(earlyTokens({ counted: 31_000, measured: 100_000 }, 30_000)).toBe(100_000)
})

test('raisedFill takes an early figure only where it raises the percentage', () => {
  const measured = { percent: 50, tokens: 100_000, window: 200_000, isEstimate: false }
  expect(raisedFill(measured, estimatedFill(100_500, 200_000))).toBe(measured)
  expect(raisedFill(measured, estimatedFill(140_000, 200_000))).toEqual(estimatedFill(140_000, 200_000))
  expect(raisedFill(null, estimatedFill(140_000, 200_000))).toEqual(estimatedFill(140_000, 200_000))
})

test("a large tool result raises the bar as the next request leaves, until its response measures it", async ($, on) => {
  const world = cacheEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'footer' })
  const percent = async () => (await footer.find({ type: 'Text', text: /^ ~?\d+%$/ }))?.text
  // The first request has no measure to count from: the bar waits for its response
  await request($, 't1')
  expect(await percent()).toBe(' 50%')

  // A tool result of some 40K tokens, counted locally as the next request leaves
  world.estimate = 71_000
  world.answerMs = 5000
  world.step = { ...HIT, cache_creation_input_tokens: 40_990 }
  const answering = request($, 't1')
  await world.clock.advance(10)
  expect(await percent()).toBe(' ~70%')

  await world.clock.advance(5000)
  await answering
  expect(await percent()).toBe(' 70%')

  // A small one moves no percentage: the measured figure stays, with no `~`
  world.estimate = 71_500
  const small = request($, 't1')
  await world.clock.advance(10)
  expect(await percent()).toBe(' 70%')
  await world.clock.advance(5000)
  await small
})

test('a compaction leaves no measure to count from until a response after it', async ($, on) => {
  const world = cacheEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'footer' })
  const percent = async () => (await footer.find({ type: 'Text', text: /^ ~?\d+%$/ }))?.text
  await request($, 't1')
  world.measured = {}
  world.estimate = 4_000
  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
  await world.clock.advance(10)
  expect(await percent()).toBe(' ~2%')

  world.estimate = 60_000
  world.answerMs = 5000
  const answering = request($, 't2')
  await world.clock.advance(10)
  expect(await percent()).toBe(' ~2%')
  await world.clock.advance(5000)
  await answering
  expect(await percent()).toBe(' 50%')
})

// Another plugin, which forks the conversation on a command as keep warm's renewal does
const KEEPER = {
  name: 'keeper',
  register(on: any) {
    on('command.run', { command: 'renew' }, async ($: any) => {
      await $.model.fork({ prompt: 'Reply with the single word: ok' })
      return { text: '' }
    })
  },
}

const fork = async ($: any): Promise<void> => {
  await $.command.run({ command: 'renew', args: '' })
}

const request = async ($: any, turnId: string): Promise<void> => {
  for await (const _chunk of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
}

const cacheOf = async ($: any) => {
  const footer = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'cache' })
  return async (): Promise<string | undefined> => (await footer.find({ type: 'Text', text: /^ (~\d+[ms]|cold)$/ }))?.text
}

test("another plugin's fork renews the cache's countdown, and a compaction leaves it cold", { ...LONG, plugins: [KEEPER] }, async ($, on) => {
  const world = cacheEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const remaining = await cacheOf($)
  await request($, 't1')
  await world.clock.advance(30 * MINUTE)
  expect(await remaining()).toBe(' ~30m')

  await fork($)
  await world.clock.advance(1000)
  expect(await remaining()).toBe(' ~60m')

  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
  await world.clock.advance(1000)
  expect(await remaining()).toBe(' cold')
})

test('a fork with nothing to fork leaves the countdown as it was', { ...LONG, plugins: [KEEPER] }, async ($, on) => {
  const world = cacheEngine(on)
  world.fork = null
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const remaining = await cacheOf($)
  await request($, 't1')
  await world.clock.advance(30 * MINUTE)
  await fork($)
  await world.clock.advance(1000)
  expect(await remaining()).toBe(' ~30m')
})

test("a fork's entry found gone before the hour makes later forks count down five minutes", { ...LONG, plugins: [KEEPER] }, async ($, on) => {
  const world = cacheEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const remaining = await cacheOf($)
  await request($, 't1')
  await world.clock.advance(50 * MINUTE)
  await fork($)
  // Twenty minutes on, the conversation's next request finds the fork's entry gone
  await world.clock.advance(20 * MINUTE)
  world.step = MISS
  await request($, 't2')
  await world.clock.advance(1000)
  expect(await remaining()).toBe(' ~60m')
  await fork($)
  await world.clock.advance(1000)
  expect(await remaining()).toBe(' ~5m')
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 } }
const SUBAGENT_USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 9_990 }

test("an agent's transcript in view shows its model, effort and context, read-only, and the conversation's on return", async ($, on) => {
  const world = cacheEngine(on)
  on('agent.list', async () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Find the tests', status: 'running' }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'footer' })
  const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: {} }, requestId: 'band' })
  const percent = async () => (await footer.find({ type: 'Text', text: /^ ~?\d+%$/ }))?.text
  await request($, 't1')

  world.step = SUBAGENT_USAGE
  for await (const _chunk of $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', effort: 'low', messageCount: 1, agentId: 'a1' }));
  // The conversation's footer is left at its own last response
  expect(await percent()).toBe(' 50%')

  await band.redraw({ ...BAND, view: { agentId: 'a1' } })
  await world.clock.advance(1)
  expect(await percent()).toBe(' 15%')
  expect(await footer.find({ type: 'Text', text: '↳ Explore' })).toBeDefined()
  expect(await footer.find({ type: 'Text', text: 'Sonnet 5.5' })).toBeDefined()
  expect(await footer.find({ type: 'Text', text: 'low' })).toBeDefined()
  expect(await footer.find({ type: 'Button', key: 'model' })).toBeUndefined()
  expect(await footer.find({ type: 'Button', key: 'clear' })).toBeUndefined()
  expect(await footer.find({ type: 'Text', text: /^ (~\d+[ms]|cold)$/ })).toBeUndefined()

  await band.redraw({ ...BAND, view: {} })
  await world.clock.advance(1)
  expect(await percent()).toBe(' 50%')
  expect(await footer.find({ type: 'Text', text: '↳ Explore' })).toBeUndefined()
  expect(await footer.find({ type: 'Button', key: 'model' })).toBeDefined()
})

test('an agent in view with no request seen yet shows its label alone', async ($, on) => {
  const world = engine(on)
  on('agent.list', async () => ({ value: [] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'footer' })
  await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'gone' } }, requestId: 'band' })
  await world.clock.advance(1)
  expect(await footer.find({ type: 'Text', text: '↳ agent' })).toBeDefined()
  expect(await footer.find({ type: 'Text', text: /%$/ })).toBeUndefined()
})
