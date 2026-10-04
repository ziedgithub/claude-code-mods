import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const SUMMARY = [{ role: 'user', text: 'The conversation so far.', toolUses: [] }]
const USAGE = { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 500, output_tokens: 100 }
// The compaction's own request, reading the conversation from the cache
const COMPACTION_USAGE = { input_tokens: 10, output_tokens: 1500, cache_read_input_tokens: 119_000, cache_creation_input_tokens: 500 }
// A renewal: the conversation read from the cache, its own short tail written
const FORK_USAGE = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 119_980, cache_creation_input_tokens: 30 }
const FORK_MISS = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 108_010 }
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as never
const COMPLETE = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as never

// The engine beneath the mod: a clock, a store, a session measured at `tokens` with a draft
// in its prompt box, and the compactions, statuses and toasts it was asked for
const engine = (on: any, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  mock.store(on, store)
  const world = { clock, tokens: 120_000 as number | undefined, model: 'claude-opus-5-5', draft: '', usage: COMPACTION_USAGE as object | undefined, forkUsage: FORK_USAGE as object, forks: 0, compactions: [] as string[], statuses: [] as (string | undefined)[], toasts: [] as string[], logs: [] as string[] }
  on('session.usage', async () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: world.tokens } } }))
  on('session.model', async () => ({ value: world.model }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.version', async () => ({ value: { version: '2.1.289', base: '2.1.289', builtAt: '' } }))
  on('model.fork', async () => {
    world.forks += 1
    return { value: { isAnswered: true, text: 'ok', usage: world.forkUsage } }
  })
  on('ui.log', async (_$: unknown, e: { text: string }) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
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
  // The engine's own drawing of the hint line
  on('ui.render', async ($: any, e: unknown) => h($.ui.resolve(e).Box, null))
  on('command.register', async () => ({ value: undefined }))
  on('session.compact', async (_$: unknown, e: { trigger?: string }) => {
    world.compactions.push(e.trigger ?? 'plugin')
    return { messages: SUMMARY, tokensBefore: 120_000, tokensAfter: 2000, ...(world.usage === undefined ? {} : { usage: world.usage }) }
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
  const footer = await $.ui.mount({ plugin: 'warm-compact', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' }, requestId: 'hint', viewport: { columns: 120, rows: 40 } })
  return {
    label: async (): Promise<string | undefined> => (await footer.find({ type: 'Button', key: 'toggle' }))?.props.label,
    press: () => footer.press({ key: 'toggle' }),
    keepWarmLabel: async (): Promise<string | undefined> => (await footer.find({ type: 'Button', key: 'keep-warm' }))?.props.label,
    pressKeepWarm: () => footer.press({ key: 'keep-warm' }),
  }
}

const run = ($: any, args: string) => $.command.run({ command: 'warm-compact', args })
const runKeepWarm = ($: any, args: string) => $.command.run({ command: 'keep-warm', args })

test('the footer chip turns it off for the session, and on again', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const chip = await chipOf($)
  expect(await chip.label()).toBe(' on  ')
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
  expect((await run($, '')).text).toBe('Warm compact is off for this session.')
  expect(await chip.label()).toBe(' off ')
  expect((await run($, 'off')).text).toBe('Warm compact is off for this session.')
  expect((await run($, ' ON ')).text).toBe('Warm compact is on for this session.')
  expect(await chip.label()).toBe(' on  ')
  expect((await run($, 'maybe')).text).toBe('Usage: /warm-compact [on|off|stats]')
  expect(await chip.label()).toBe(' on  ')
})

test('a compaction leaves a line in the transcript for whoever comes back', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.logs).toHaveLength(1)
  expect(world.logs[0]).toMatch(/^Compacted at \d\d:\d\d \(120k → 2k tokens\), just before the prompt cache went cold\./)
})

test('a compaction that found the cache gone says it saved nothing', async ($, on) => {
  const world = engine(on)
  world.usage = { input_tokens: 10, output_tokens: 1500, cache_read_input_tokens: 0, cache_creation_input_tokens: 119_500 }
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.logs[0]).toMatch(/the prompt cache had already lapsed, so this one saved nothing\.$/)
})

test('/warm-compact stats tallies a compaction once the session goes on', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect((await run($, 'stats')).text).toMatch(/This session +0 +0 +0 +-/)
  await answer($)
  await world.clock.advance(61 * MIN)
  // Spent so far: the compaction's own request, 0.05 × 119k read + 2 × 500 written + 10 + 5 × 1500 out
  expect((await run($, 'stats')).text).toMatch(/This session +1 +0 +0 +-14k/)
  await answer($)
  // Back: 2 × 120k spared, less the compaction and 2 × 2k to write the summary
  const stats = (await run($, 'stats')).text
  expect(stats).toMatch(/This session +1 +0 +1 +\+222k/)
  expect(stats).toMatch(/Last 7 days +1 +0 +1 +\+222k/)
  expect(stats).toMatch(/All time +1 +0 +1 +\+222k/)
})

test('the tally is kept across sessions, and a week on leaves the last 7 days', async ($, on) => {
  const record = { at: 0, sessionId: 'old', model: 'claude-sonnet-5-5', ttl: '1h', before: 100_000, after: 5000, usage: null, isReturned: true }
  const world = engine(on, { compactions: [record] })
  await world.clock.advance(8 * 24 * 60 * MIN)
  await $.session.start(START)
  const stats = (await run($, 'stats')).text
  expect(stats).toMatch(/This session +0 +0 +0 +-/)
  expect(stats).toMatch(/Last 7 days +0 +0 +0 +-/)
  // 2 × 100k spared, less 0.1 × 100k read, 5 × 5k summarized and 2 × 5k written back
  expect(stats).toMatch(/All time +1 +0 +1 +\+155k/)
})

test('the keep warm chip and /keep-warm turn keep warm on and off, apart from warm compact', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const chip = await chipOf($)
  expect(await chip.keepWarmLabel()).toBe(' off ')
  await chip.pressKeepWarm()
  expect(await chip.keepWarmLabel()).toBe(' on  ')
  expect(await chip.label()).toBe(' on  ')
  expect((await runKeepWarm($, '')).text).toBe('Keep warm is off for this session.')
  expect(await chip.keepWarmLabel()).toBe(' off ')
  expect((await runKeepWarm($, 'on')).text).toBe('Keep warm is on for this session.')
  expect((await runKeepWarm($, 'later')).text).toBe('Usage: /keep-warm [on|off]')
  expect(await chip.label()).toBe(' on  ')
})

test('keep warm renews the cache twice through a fork, then warm compact takes over', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual([])
  expect(world.logs.at(-1)).toMatch(/^Kept the prompt cache warm at \d\d:\d\d \(1 of 2\)\.$/)
  await world.clock.advance(59 * MIN)
  expect(world.forks).toBe(2)
  expect(world.logs.at(-1)).toMatch(/\(2 of 2\)\.$/)
  await world.clock.advance(59 * MIN)
  expect(world.forks).toBe(2)
  expect(world.compactions).toEqual(['plugin'])
})

test('coming back while a renewal holds the cache counts what it spared', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  await world.clock.advance(20 * MIN)
  await answer($)
  // 2 × 120k spared, less 0.05 × 120k read, 1.25 × 30 written, 20 in and 5 × 5 out
  expect((await run($, 'stats')).text).toMatch(/This session +0 +1 +1 +\+234k/)
})

test('a renewal that misses the cache hands over to a compaction, and the model is skipped after', async ($, on) => {
  const world = engine(on)
  world.forkUsage = FORK_MISS
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual(['plugin'])
  expect(world.logs.some(l => /found the prompt cache gone, so warm compact takes over/.test(l))).toBe(true)

  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual(['plugin', 'plugin'])
  expect(world.logs.some(l => /renewals can't read the conversation from the cache on claude-opus-5-5/.test(l))).toBe(true)
})

test('a second renewal that misses shows renewals hold five minutes, and keep warm stands down', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  world.forkUsage = FORK_MISS
  await world.clock.advance(59 * MIN)
  expect(world.forks).toBe(2)
  expect(world.compactions).toEqual(['plugin'])

  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(2)
  expect(world.logs.some(l => /holds this account's cache for 5 minutes only/.test(l))).toBe(true)
})

test('with warm compact off, keep warm renews and then lets the cache go', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await runKeepWarm($, 'on')
  await answer($)
  for (let hour = 0; hour < 4; hour++) await world.clock.advance(60 * MIN)
  expect(world.forks).toBe(2)
  expect(world.compactions).toEqual([])
})

test('a renewal count starts over once the session goes on', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(2)
  expect(world.logs.at(-1)).toMatch(/\(1 of 2\)\.$/)
})
