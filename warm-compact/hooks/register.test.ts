import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const SUMMARY = [{ role: 'user', text: 'The conversation so far.', toolUses: [] }]
const USAGE = { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 500, output_tokens: 100 }
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as never
const COMPLETE = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as never

// The engine beneath the mod: a clock, a store, a session measured at `tokens` with a draft
// in its prompt box, and the compactions, statuses and toasts it was asked for
const engine = (on: any, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  mock.store(on, store)
  const world = { clock, tokens: 120_000 as number | undefined, model: 'claude-opus-5-5', draft: '', compactions: [] as string[], statuses: [] as (string | undefined)[], toasts: [] as string[] }
  on('session.usage', async () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: world.tokens } } }))
  on('session.model', async () => ({ value: world.model }))
  on('prompt.read', async () => ({ value: { text: world.draft, cursor: 0 } }))
  on('ui.status', async (_$: unknown, e: { text?: string }) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$: unknown, e: { text: string }) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', async () => ({ cwd: '/' }))
  on('session.end', async (_$: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: USAGE }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
  })
  // A plugin's own call reaches the test's hook as the plugin made it, before the engine
  // stamps it `plugin`
  // The engine draws nothing in the footer slot with no mode label
  on('ui.render', async ($: any, e: unknown) => h($.ui.resolve(e).Box, null))
  on('command.register', async () => ({ value: undefined }))
  on('session.compact', async (_$: unknown, e: { trigger?: string }) => {
    world.compactions.push(e.trigger ?? 'plugin')
    return { messages: SUMMARY, tokensBefore: 120_000, tokensAfter: 2000 }
  })
  return world
}

const readAll = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const _chunk of stream);
}

// One prompt answered in one request
const answer = async ($: any): Promise<void> => {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await readAll($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await $.turn.complete(COMPLETE)
}

test('an idle session is compacted a minute before its hour is up, after a countdown', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(58 * MIN)
  expect(world.compactions).toEqual([])
  await world.clock.advance(31_000)
  expect(world.statuses.at(-1)).toMatch(/^⇊ compacting in \d+s/)
  expect(world.compactions).toEqual([])
  await world.clock.advance(30_000)
  expect(world.compactions).toEqual(['plugin'])
  expect(world.statuses.at(-1)).toBe(undefined)
  expect(world.toasts).toEqual(['Compacted before the prompt cache went cold'])
  // The compacted conversation is a new prefix: nothing more until the next request
  await world.clock.advance(2 * 60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
})

test('a draft in the prompt box holds the compaction off', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  world.draft = 'and then'
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
  expect(world.statuses.filter(s => s !== undefined)).toEqual([])
})

test('a running turn, a small conversation, a switched model or a learned five-minute cache change what happens', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await $.turn.start({ text: 'long one', turnId: 't2' })
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
  await $.turn.complete(COMPLETE)

  world.tokens = 20_000
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])

  world.tokens = 120_000
  await answer($)
  world.model = 'claude-sonnet-5-5'
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
})

test('a compaction or a /clear by anyone else resets the wait', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual(['manual'])

  await answer($)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } } as never)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual(['manual'])
})

test('a stored five-minute TTL compacts at four minutes, under the options given', async ($, on) => {
  const world = engine(on, { cacheTtl: '5m' })
  await $.session.start(START)
  await answer($)
  await world.clock.advance(3 * MIN)
  expect(world.compactions).toEqual([])
  await world.clock.advance(1 * MIN + 1000)
  expect(world.compactions).toEqual(['plugin'])
})

test('a headless session is left alone', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', isInteractive: false } as never)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
})

test('the options set the threshold and the lead', { options: { minTokens: 200_000, leadSeconds: 600 } }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
  world.tokens = 250_000
  await answer($)
  await world.clock.advance(50 * MIN + 1000)
  expect(world.compactions).toEqual(['plugin'])
})

test("a subagent's turn ending leaves the main turn running", async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await $.turn.start({ text: 'long one', turnId: 't2' })
  await $.turn.complete({ ...(COMPLETE as object), agentId: 'a1' } as never)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
})

const chipOf = async ($: any) => {
  const footer = await $.ui.mount({ plugin: 'warm-compact', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, requestId: 'footer', viewport: { columns: 120, rows: 40 } })
  return {
    label: async (): Promise<string | undefined> => (await footer.find({ type: 'Button' }))?.props.label,
    press: () => footer.press({ key: 'toggle' }),
  }
}

const run = ($: any, args: string) => $.command.run({ command: 'warm-compact', args })

test('the footer chip turns it off for the session, and on again', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const chip = await chipOf($)
  expect(await chip.label()).toBe(' on ')
  await answer($)
  await chip.press()
  expect(await chip.label()).toBe(' off ')
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
  expect(world.statuses.filter(s => s !== undefined)).toEqual([])

  await chip.press()
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual(['plugin'])
})

test('turning it off mid-countdown takes the countdown down', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const chip = await chipOf($)
  await answer($)
  await world.clock.advance(58.7 * MIN)
  expect(world.statuses.at(-1)).toMatch(/^⇊ compacting in/)
  await chip.press()
  expect(world.statuses.at(-1)).toBe(undefined)
  await world.clock.advance(2 * MIN)
  expect(world.compactions).toEqual([])
})

test('/warm-compact flips it, and takes on or off', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const chip = await chipOf($)
  expect((await run($, '')).text).toBe('Auto-compact is off for this session.')
  expect(await chip.label()).toBe(' off ')
  expect((await run($, 'off')).text).toBe('Auto-compact is off for this session.')
  expect((await run($, ' ON ')).text).toBe('Auto-compact is on for this session.')
  expect(await chip.label()).toBe(' on ')
  expect((await run($, 'maybe')).text).toBe('Usage: /warm-compact [on|off]')
  expect(await chip.label()).toBe(' on ')
})
