import { expect, mock, test } from 'claude-code/testing'

import { OFF_TEXT } from './idle-compaction'
import { CHIP_ROW_KEY, splitChipRow } from './shared/chips'

const MIN = 60_000
// The tests below run the one-second clock for an hour or more of the session
const LONG = { timeoutMs: 20_000 }
const SUMMARY = [{ role: 'user', text: 'The conversation so far.', toolUses: [] }]
const USAGE = { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 500, output_tokens: 100 }
// The compaction's own request, reading the conversation from the cache
const COMPACTION_USAGE = { input_tokens: 10, output_tokens: 1500, cache_read_input_tokens: 119_000, cache_creation_input_tokens: 500 }
// A renewal: the conversation read from the cache, its own short tail written
const FORK_USAGE = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 119_980, cache_creation_input_tokens: 30 }
const FORK_MISS = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 108_010 }
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as never
const SETTINGS = '/home/me/.claude/settings.json'
const COMPLETE = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as never

// The engine beneath the mod: a clock, a store, a session measured at `tokens` with a draft
// in its prompt box, and the compactions, statuses and toasts it was asked for
const engine = (on: any, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  // The plugin's store in memory, open to the test as other sessions write to it
  const kept: Record<string, unknown> = { ...store }
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: kept[e.key] }))
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', async (_$: unknown, e: { key: string }) => {
    delete kept[e.key]
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: Object.keys(kept) }))
  const world = { clock, store: kept, tokens: 120_000 as number | undefined, model: 'claude-opus-5-5', draft: '', usage: COMPACTION_USAGE as object | undefined, forkUsage: FORK_USAGE as object, forkResult: undefined as object | undefined, stepUsage: USAGE as object, forks: 0, compactions: [] as string[], statuses: [] as (string | undefined)[], toasts: [] as string[], logs: [] as string[], settings: { idleCompaction: false } as Record<string, unknown>, projectSettings: {} as Record<string, unknown>, isReadOnly: false, forkMs: 0, duringFork: undefined as (() => Promise<void>) | undefined, rateLimits: [] as object[], serverToolUses: undefined as object[] | undefined, isAutoCompactEnabled: true, breakdowns: 0, files: { [SETTINGS]: '{\n  "model": "opus"\n}\n' } as Record<string, string> }
  on('session.usage', async (_$: unknown, e: { breakdown?: string } | undefined) => {
    if (e?.breakdown !== undefined) world.breakdowns += 1
    const breakdown = e?.breakdown === undefined ? {} : { breakdown: { isAutoCompactEnabled: world.isAutoCompactEnabled } }
    return { value: { startedAt: 0, rateLimits: world.rateLimits, context: { window: 200_000, tokens: world.tokens, ...breakdown } } }
  })
  on('session.model', async () => ({ value: world.model }))
  on('session.id', async () => ({ value: 's1' }))
  on('session.version', async () => ({ value: { version: '2.1.289', base: '2.1.289', builtAt: '' } }))
  on('model.fork', async () => {
    world.forks += 1
    if (world.forkMs > 0) await clock.sleep(world.forkMs)
    await world.duringFork?.()
    return { value: world.forkResult ?? { isAnswered: true, text: 'ok', usage: world.forkUsage } }
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
  // `settings` stands for the user's own, merged under the project's
  on('settings.read', async (_$: unknown, e: { source?: string } | undefined) => {
    const source = e?.source
    if (source === undefined) return { value: { ...world.settings, ...world.projectSettings } }
    return { value: source === 'user' ? world.settings : source === 'project' ? world.projectSettings : {} }
  })
  on('env.get', async (_$: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const text = world.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => {
    if (world.isReadOnly) throw new Error(`EACCES: ${e.path}`)
    world.files[e.path] = e.text
    return { value: undefined }
  })
  on('session.end', async (_$: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: world.stepUsage }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: world.stepUsage, ...(world.serverToolUses === undefined ? {} : { serverToolUses: world.serverToolUses }) }
  })
  // A plugin's own call reaches the test's hook as the plugin made it, before the engine
  // stamps it `plugin`
  // The engine's own drawing of the hint line
  on('ui.render', async ($: any, e: unknown) => h($.ui.resolve(e).Box, null))
  on('command.register', async () => ({ value: undefined }))
  on('prompt.edit', async (_$: unknown, e: { text: string; cursor: number }) => ({ text: e.text, cursor: e.cursor }))
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

test('an idle session is compacted a minute before its hour is up, after a countdown', LONG, async ($, on) => {
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

test('a running turn, a small conversation, a switched model or a learned five-minute cache change what happens', LONG, async ($, on) => {
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

test('a compaction or a /clear by anyone else resets the wait', LONG, async ($, on) => {
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

test("a subagent's turn starting while the session is idle neither holds the compaction off nor counts as coming back", LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  // A background agent, a teammate woken by a message, a workflow's agents; `agentId` is in
  // Claude Code 2.1.302's contract, not 2.1.296's
  await $.turn.start({ text: 'in the background', turnId: 'a1', agentId: 'agent-1' } as never)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
  await $.turn.start({ text: 'in the background', turnId: 'a2', agentId: 'agent-1' } as never)
  expect((await run($, 'stats')).text).toMatch(/This session\s+1\s+0\s+0\s/)
})

const chipOf = async ($: any, requestId = 'hint') => {
  const footer = await $.ui.mount({ plugin: 'warm-compact', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' }, requestId, viewport: { columns: 120, rows: 40 } })
  return {
    label: async (): Promise<string | undefined> => (await footer.find({ type: 'Button', key: 'toggle' }))?.props.label,
    press: () => footer.press({ key: 'toggle' }),
    keepWarmLabel: async (): Promise<string | undefined> => (await footer.find({ type: 'Button', key: 'keep-warm' }))?.props.label,
    pressKeepWarm: () => footer.press({ key: 'keep-warm' }),
  }
}

test('both chips sit on one row under the hint line, which another mod with chips may share', async ($, on) => {
  engine(on)
  await $.session.start(START)
  const footer = await $.ui.mount({ plugin: 'warm-compact', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' }, requestId: 'hint', viewport: { columns: 120, rows: 40 } })
  const drawn: any = await footer.drawn()
  expect(drawn.props.flexDirection).toBe('column')
  const [line, row] = drawn.children
  expect(row.props.key).toBe(CHIP_ROW_KEY)
  expect(row.children.map((chip: any) => chip.children[1].children[0])).toEqual(['Warm compact', 'Keep warm'])
  // Drawn over by another such mod, the chips are handed over whole for it to add its own to
  expect(splitChipRow(drawn)).toEqual({ above: [line], chips: row.children })
})

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

test('keep warm renews the cache twice through a fork, then warm compact takes over', LONG, async ($, on) => {
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

// A store that already learned the account's TTL, as misses count only once it is known
const KNOWN = { cacheTtl: '1h' }

test('a renewal that misses the cache hands over to a compaction on the entry it wrote, and the model is skipped after', LONG, async ($, on) => {
  const world = engine(on, KNOWN)
  world.forkUsage = FORK_MISS
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
  expect(world.logs.some(l => /found the prompt cache gone, so warm compact takes over\.$/.test(l))).toBe(true)
  // The entry the renewal wrote holds five minutes at least: the compaction comes a minute before
  expect(world.compactions).toEqual([])
  await world.clock.advance(3 * MIN + 30_000)
  expect(world.statuses.at(-1)).toMatch(/^⇊ compacting in/)
  await world.clock.advance(MIN)
  expect(world.compactions).toEqual(['plugin'])

  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual(['plugin', 'plugin'])
  expect(world.logs.some(l => /renewals can't read the conversation from the cache on claude-opus-5-5/.test(l))).toBe(true)
})

test('a second renewal that misses shows renewals hold five minutes, and keep warm stands down', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  world.forkUsage = FORK_MISS
  await world.clock.advance(59 * MIN)
  expect(world.forks).toBe(2)
  await world.clock.advance(4 * MIN)
  expect(world.compactions).toEqual(['plugin'])

  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(2)
  expect(world.logs.some(l => /holds this account's cache for 5 minutes only/.test(l))).toBe(true)
})

test('a renewal that fails says nothing of the cache: warm compact takes over, and the model is not skipped', LONG, async ($, on) => {
  const world = engine(on)
  world.forkResult = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual(['plugin'])
  expect(world.logs.some(l => /^Keep warm: the renewal at \d\d:\d\d failed \(an API error 529\), so warm compact takes over\.$/.test(l))).toBe(true)
  expect(world.logs.some(l => /found the prompt cache gone/.test(l))).toBe(false)

  world.forkResult = undefined
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(2)
  expect(world.logs.at(-1)).toMatch(/\(1 of 2\)\.$/)
})

const FORK_FAILED = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: FORK_USAGE }

test('a draft holds off the compaction a failed renewal hands over to; emptied, it is announced and starts a minute on', { ...LONG, options: { leadSeconds: 300 } }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  world.draft = 'half a prompt'
  world.forkResult = FORK_FAILED
  await world.clock.advance(55 * MIN + 1000)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual([])
  expect(world.logs.some(l => /failed \(an API error 529\), so warm compact takes over\.$/.test(l))).toBe(true)
  // Emptied by Esc, which no edit tells of: a minute more, announced for the last 30 s
  world.draft = ''
  await world.clock.advance(35_000)
  expect(world.compactions).toEqual([])
  expect(world.statuses.at(-1)).toMatch(/^⇊ compacting in/)
  await world.clock.advance(30_000)
  expect(world.compactions).toEqual(['plugin'])
  expect(world.forks).toBe(1)
})

test('a compaction held off after a failed renewal is dropped once the cache lapses, and said so', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  world.draft = 'half a prompt'
  world.forkResult = FORK_FAILED
  await world.clock.advance(60 * MIN)
  world.draft = ''
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual([])
  expect(world.forks).toBe(1)
  expect(world.logs.filter(l => /could not take over before the prompt cache lapsed/.test(l))).toHaveLength(1)
})

test('a compaction a failed renewal handed over to does not count toward the stand-down, whatever it found', LONG, async ($, on) => {
  const world = engine(on)
  world.usage = COLD_COMPACTION
  await $.session.start(START)
  await runKeepWarm($, 'on')
  for (const _pause of [1, 2, 3]) {
    await answer($)
    world.forkResult = FORK_FAILED
    await world.clock.advance(60 * MIN)
  }
  expect(world.compactions).toEqual(['plugin', 'plugin', 'plugin'])
  expect(world.logs.some(l => /stands down/.test(l))).toBe(false)
})

test('a renewal that fails too slowly for a compaction leaves the pause alone, said so', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  for (const _pause of [1, 2]) {
    await answer($)
    world.forkResult = FORK_FAILED
    world.forkMs = 90_000
    await world.clock.advance(62 * MIN)
  }
  expect(world.forks).toBe(2)
  expect(world.compactions).toEqual([])
  expect(world.logs.filter(l => /could not take over before the prompt cache lapsed/.test(l))).toHaveLength(2)
})

test('after a missed renewal, a draft emptied soon enough still lets the compaction in before the entry the renewal wrote lapses', LONG, async ($, on) => {
  const world = engine(on)
  world.forkUsage = FORK_MISS
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  world.draft = 'half a prompt'
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual([])
  world.draft = ''
  await world.clock.advance(3 * MIN + 50_000)
  expect(world.compactions).toEqual([])
  await world.clock.advance(15_000)
  expect(world.compactions).toEqual(['plugin'])
  expect(world.forks).toBe(1)
})

test('with warm compact off, keep warm renews and then lets the cache go', LONG, async ($, on) => {
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

// Another mod reading what it publishes, as context-bar does
const READER = {
  name: 'reader',
  register(on: any) {
    on('command.run', { command: 'read-warm' }, async ($: any, e: { args: string }) => {
      const read = e.args === 'ttl' ? await $.state.get({ plugin: 'warm-compact', key: 'ttl' }) : await $.state.get({ plugin: 'warm-compact', key: 'upcoming' })
      return { text: JSON.stringify(read.value ?? null) }
    })
  },
}
const WITH_READER = { plugins: [READER] }
const published = async ($: any, key: 'ttl' | 'upcoming') => JSON.parse((await $.command.run({ command: 'read-warm', args: key })).text)

test('it publishes the TTL it learned and what the pause holds, for other mods to show', WITH_READER, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
  const start = world.clock.now()
  await answer($)
  await world.clock.advance(1000)
  expect(await published($, 'upcoming')).toEqual({ kind: 'compact', at: start + 59 * MIN, expiresAt: start + 60 * MIN })

  await runKeepWarm($, 'on')
  await world.clock.advance(1000)
  expect((await published($, 'upcoming'))?.kind).toBe('renew')

  await run($, 'off')
  await runKeepWarm($, 'off')
  await world.clock.advance(1000)
  expect(await published($, 'upcoming')).toBe(null)
})

test('a compaction tried, or a cache about to lapse, leaves nothing in store', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  world.draft = 'and then'
  await world.clock.advance(60 * MIN - 5000)
  expect(await published($, 'upcoming')).toBe(null)

  world.draft = ''
  await answer($)
  await world.clock.advance(59 * MIN + 2000)
  expect(world.compactions).toEqual(['plugin'])
  expect(await published($, 'upcoming')).toBe(null)
})

test('coming back while a renewal holds a five-minute cache is not taken for an hour-long one', WITH_READER, async ($, on) => {
  const world = engine(on, { cacheTtl: '5m' })
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(4 * MIN + 1000)
  expect(world.forks).toBe(1)
  await world.clock.advance(3 * MIN)
  await answer($)
  expect(await published($, 'ttl')).toEqual({ cache: '5m', renew: null })
})

test('it turns off Claude Code\'s own idle compaction in the user settings, and says so', async ($, on) => {
  const world = engine(on)
  world.settings = {}
  await $.session.start(START)
  expect(JSON.parse(world.files[SETTINGS] ?? '')).toEqual({ model: 'opus', idleCompaction: false })
  expect(world.logs).toEqual([OFF_TEXT])
})

test('idle compaction already off, by the person or a policy, is left as it is', async ($, on) => {
  const world = engine(on)
  const before = world.files[SETTINGS]
  await $.session.start(START)
  expect(world.files[SETTINGS]).toBe(before)
  expect(world.logs).toEqual([])
})

test('idle compaction turned back on after warm-compact turned it off is left on', async ($, on) => {
  const world = engine(on, { idleCompactionOff: true })
  world.settings = { idleCompaction: true }
  world.files[SETTINGS] = '{\n  "idleCompaction": true\n}\n'
  const before = world.files[SETTINGS]
  await $.session.start(START)
  expect(world.files[SETTINGS]).toBe(before)
  expect(world.logs).toEqual([])
})

test('idle compaction found off is taken as turned off once, and left as it is after', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  // Turned back on by hand before the next session
  world.settings = {}
  world.files[SETTINGS] = '{}\n'
  await $.session.start(START)
  expect(world.files[SETTINGS]).toBe('{}\n')
  expect(world.logs).toEqual([])
})

test('a settings file that will not read is not written', async ($, on) => {
  const world = engine(on)
  world.settings = {}
  delete world.files[SETTINGS]
  await $.session.start(START)
  expect(world.files[SETTINGS]).toBe(undefined)
  expect(world.logs).toEqual([])
})

const COLD_COMPACTION = { input_tokens: 10, output_tokens: 1500, cache_read_input_tokens: 0, cache_creation_input_tokens: 119_500 }

test('two compactions in a row that find the cache gone stand warm compact down, until it is turned on by hand', LONG, async ($, on) => {
  const world = engine(on, KNOWN)
  world.usage = COLD_COMPACTION
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual(['plugin', 'plugin'])
  expect(world.logs.at(-1)).toMatch(/^Warm compact: its last 2 compactions found the prompt cache already gone on Claude Code 2\.1\.289, so it stands down/)

  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual(['plugin', 'plugin'])

  await run($, 'on')
  world.usage = COMPACTION_USAGE
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual(['plugin', 'plugin', 'plugin'])
})

test('a compaction that reads the cache starts the count over, and a stand-down is kept across sessions for the same version', LONG, async ($, on) => {
  const world = engine(on, { compactMisses: { version: '2.1.289', count: 1 } })
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  world.usage = COLD_COMPACTION
  await answer($)
  await world.clock.advance(61 * MIN)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual(['plugin', 'plugin', 'plugin'])
})

test('a stand-down stored for an older Claude Code is tried again', async ($, on) => {
  const world = engine(on, { compactMisses: { version: '2.1.288', count: 2 } })
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual(['plugin'])
})

const COLD_STEP = { input_tokens: 10, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 115_000, output_tokens: 100 }

test('the cache is taken for five minutes only once two telling pauses in a row agree', WITH_READER, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await answer($)
  await world.clock.advance(10 * MIN)
  world.stepUsage = COLD_STEP
  await answer($)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
  await world.clock.advance(10 * MIN)
  await answer($)
  expect(await published($, 'ttl')).toEqual({ cache: '5m', renew: null })
})

// Where an organization manages Claude Code, no session.compact hook hears a compaction: the
// engine has no measure of the window from then until the next response, and that is all that
// shows it. The first request over the compacted conversation finds it uncached
const answerAfterCompaction = async ($: any, world: any, isAtTurnStart: boolean): Promise<void> => {
  if (!isAtTurnStart) world.tokens = undefined
  await world.clock.advance(10 * MIN)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  world.tokens = undefined
  world.stepUsage = COLD_STEP
  await readAll($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  world.tokens = 120_000
  await $.turn.complete(COMPLETE)
}

test('a /compact no hook is told of leaves the pause alone, and is not read as a five-minute cache', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  world.tokens = undefined
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
  world.tokens = 120_000
  await run($, 'off')
  await answer($)
  await answerAfterCompaction($, world, false)
  await answerAfterCompaction($, world, false)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

test('an auto-compact no hook is told of, at a turn\'s start, is not read as a five-minute cache', WITH_READER, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await answer($)
  await answerAfterCompaction($, world, true)
  await answerAfterCompaction($, world, true)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

test('coming back after a missed renewal held off tells how long a renewal holds the entry, not a request', WITH_READER, async ($, on) => {
  const world = engine(on)
  world.forkUsage = FORK_MISS
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  world.draft = 'half a prompt'
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
  await world.clock.advance(10 * MIN)
  world.draft = ''
  // The entry the renewal wrote, read whole
  world.stepUsage = { input_tokens: 10, cache_read_input_tokens: 119_000, cache_creation_input_tokens: 500, output_tokens: 100 }
  await answer($)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: '1h' })
})

// The person's hand on the prompt box, as the editor raises it
const edit = ($: any, text = 'a') => $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: text })

test('an edit of the prompt box in the last minute holds the compaction off, even with the box empty again', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(58 * MIN + 30_000)
  await edit($)
  // The compaction is due from 59:00; the edit holds it until 59:30
  await world.clock.advance(50_000)
  expect(world.compactions).toEqual([])
  await world.clock.advance(15_000)
  expect(world.compactions).toEqual(['plugin'])

  // An edit too close to the lapse leaves the pause alone
  await answer($)
  await world.clock.advance(58 * MIN + 56_000)
  await edit($)
  await world.clock.advance(2 * 60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
})

test('near a rate limit, the pause is left alone: no compaction, no countdown, no renewal', LONG, async ($, on) => {
  const world = engine(on)
  world.rateLimits = [{ kind: 'seven_day', percentUsed: 40 }, { kind: 'five_hour', percentUsed: 92.5 }]
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
  expect(world.statuses.filter(s => s !== undefined)).toEqual([])
  expect(world.logs).toEqual(['warm-compact left this pause alone: 93% of your five-hour limit is used.'])

  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(0)
  expect(world.logs).toHaveLength(2)

  // Below the limit again, the next pause goes on as usual
  world.rateLimits = [{ kind: 'five_hour', percentUsed: 60 }]
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
})

test('with auto-compact off, warm compact leaves the session alone and says so once, while keep warm goes on', LONG, async ($, on) => {
  const world = engine(on)
  world.isAutoCompactEnabled = false
  world.forkUsage = FORK_MISS
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
  expect(world.logs).toEqual(['Warm compact leaves this session alone while auto-compact is off: turn auto-compact on in /config to have it back.'])
  // Asked as the pause starts and again for the countdown, not every second
  expect(world.breakdowns).toBe(2)

  // A renewal that misses hands over to a compaction that, asked as it comes due, does not run
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(65 * MIN)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual([])
  expect(world.logs.filter(l => /auto-compact is off/.test(l))).toHaveLength(1)

  // On again, the next pause compacts
  world.isAutoCompactEnabled = true
  await runKeepWarm($, 'off')
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
})

test('a prompt sent while a renewal runs keeps its own pause: the renewal only counts its cost', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  world.forkUsage = FORK_MISS
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  let sentAt = 0
  world.duringFork = async () => {
    world.duringFork = undefined
    sentAt = world.clock.now()
    await answer($)
  }
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
  expect(world.logs.some(l => /found the prompt cache gone/.test(l))).toBe(false)
  expect((await published($, 'upcoming')).expiresAt).toBe(sentAt + 60 * MIN)
  await world.clock.advance(5 * MIN)
  expect(world.compactions).toEqual([])
})

test('near a rate limit, a pending handover is left alone and said so once', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  world.draft = 'half a prompt'
  world.forkResult = FORK_FAILED
  await world.clock.advance(59 * MIN + 1000)
  world.rateLimits = [{ kind: 'five_hour', percentUsed: 95 }]
  await world.clock.advance(2 * MIN)
  expect(world.compactions).toEqual([])
  expect(world.logs.filter(l => /five-hour limit/.test(l))).toHaveLength(1)
  expect(world.logs.some(l => /could not take over/.test(l))).toBe(false)
})

// The clock as the mod reads it, set forward by `/sleep <ms>` to stand for a computer that
// slept: the ticks stop meanwhile, and the next reads the time jumped. A plugin keeps its own
// environment, so the jump goes to it as a command
const SLEEPER = {
  name: 'sleeper',
  register(on: any) {
    let skew = 0
    on('clock.now', async (_$: unknown, e: unknown, next: any) => {
      const result = await next(e)
      return { ...result, value: result.value + skew }
    })
    on('command.run', { command: 'sleep' }, async (_$: unknown, e: { args: string }) => {
      skew += Number(e.args)
      return { text: '' }
    })
  },
}

const sleep = ($: any, ms: number) => $.command.run({ command: 'sleep', args: String(ms) })

test('a sleep while a handover is pending leaves the pause alone', { ...LONG, plugins: [SLEEPER], options: { leadSeconds: 300 } }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  world.draft = 'half a prompt'
  world.forkResult = FORK_FAILED
  await world.clock.advance(55 * MIN + 1000)
  expect(world.forks).toBe(1)
  world.draft = ''
  await sleep($, 2 * MIN)
  await world.clock.advance(2 * MIN)
  expect(world.compactions).toEqual([])
  expect(world.logs.some(l => /the computer slept/.test(l))).toBe(true)
})

test('auto-compact turned off during the countdown is heeded as the compaction starts', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(58 * MIN + 45_000)
  expect(world.statuses.at(-1)).toMatch(/^⇊ compacting in/)
  world.isAutoCompactEnabled = false
  await world.clock.advance(2 * MIN)
  expect(world.compactions).toEqual([])
})

test('a pending handover is not dropped while the prompt that overtook it runs', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  world.draft = 'half a prompt'
  world.forkResult = FORK_FAILED
  await world.clock.advance(59 * MIN + 1000)
  // Sent before the lapse, answered after it
  await $.turn.start({ text: 'half a prompt', turnId: 't2' })
  await world.clock.advance(2 * MIN)
  expect(world.logs.some(l => /could not take over/.test(l))).toBe(false)
  await readAll($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await $.turn.complete(COMPLETE)
  expect(world.logs.some(l => /could not take over/.test(l))).toBe(false)
})

test('a compaction held off to the last 15 s before the lapse is left alone', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(58 * MIN + 46_000)
  await edit($)
  await world.clock.advance(3 * MIN)
  expect(world.compactions).toEqual([])
})

test('a renewal a prompt overtook does not blame the model for a miss', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  expect(world.forks).toBe(1)
  // The second renewal misses while a prompt runs
  world.forkUsage = FORK_MISS
  world.duringFork = async () => {
    world.duringFork = undefined
    await answer($)
  }
  await world.clock.advance(59 * MIN)
  expect(world.forks).toBe(2)
  // What it shows is that renewals hold five minutes, not that this model's miss
  await world.clock.advance(60 * MIN)
  expect(world.logs.some(l => /renewals can't read the conversation/.test(l))).toBe(false)
  expect(world.logs.some(l => /5 minutes only/.test(l))).toBe(true)
})

test('auto-compact turned off mid-pause is heeded, and never asked during a turn', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for (const index of [0, 1, 2, 3]) await readAll($.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1 }))
  await world.clock.advance(5000)
  expect(world.breakdowns).toBe(0)
  await $.turn.complete(COMPLETE)
  await world.clock.advance(2 * MIN)
  world.isAutoCompactEnabled = false
  await world.clock.advance(59 * MIN)
  expect(world.compactions).toEqual([])
  expect(world.logs.some(l => /auto-compact is off/.test(l))).toBe(true)
})

test('near a rate limit, nothing is shown in store for other mods', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  world.rateLimits = [{ kind: 'five_hour', percentUsed: 95 }]
  await $.session.start(START)
  await answer($)
  await world.clock.advance(1000)
  expect(await published($, 'upcoming')).toBe(null)
  // A window that has reset since the response no longer counts
  world.rateLimits = [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(world.clock.now() + 5 * MIN).toISOString() }]
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
})

test('a settings file that will not write leaves warm compact working, and is tried again next session', LONG, async ($, on) => {
  const world = engine(on)
  world.settings = {}
  world.isReadOnly = true
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
  world.isReadOnly = false
  await $.session.start(START)
  expect(JSON.parse(world.files[SETTINGS] ?? '')).toEqual({ model: 'opus', idleCompaction: false })
})

test('idle compaction off in a project only still has the user settings written', async ($, on) => {
  const world = engine(on)
  world.settings = {}
  world.projectSettings = { idleCompaction: false }
  await $.session.start(START)
  expect(JSON.parse(world.files[SETTINGS] ?? '')).toEqual({ model: 'opus', idleCompaction: false })
})

test('auto-compact found off in an earlier pause, and turned back on, lets a failed renewal hand over', LONG, async ($, on) => {
  const world = engine(on)
  world.isAutoCompactEnabled = false
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual([])
  world.isAutoCompactEnabled = true
  await runKeepWarm($, 'on')
  await answer($)
  world.forkResult = FORK_FAILED
  await world.clock.advance(60 * MIN)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual(['plugin'])
})

test('other mods are shown a held-off compaction at the time it would start', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(58 * MIN + 30_000)
  await edit($)
  await world.clock.advance(1000)
  // Due at 59:00, held to 59:30
  expect((await published($, 'upcoming')).at).toBe(world.clock.now() - 1000 + MIN)
  // A draft holds it off for as long as it sits there: nothing is shown
  world.draft = 'half a prompt'
  await world.clock.advance(1000)
  expect(await published($, 'upcoming')).toBe(null)
})

// Requests fall anywhere in a second, the clock's ticks on whole seconds
const OFF_GRID = 500

test('the shortest lead still leaves ticks to start in, wherever the request fell', { ...LONG, options: { leadSeconds: 15 } }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await world.clock.advance(OFF_GRID)
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
  await runKeepWarm($, 'on')
  await world.clock.advance(OFF_GRID)
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.forks).toBe(1)
})

test('with auto-compact off, a failed renewal says nothing of a takeover, and none comes', LONG, async ($, on) => {
  const world = engine(on)
  world.isAutoCompactEnabled = false
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  world.forkResult = FORK_FAILED
  await world.clock.advance(62 * MIN)
  expect(world.forks).toBe(1)
  expect(world.compactions).toEqual([])
  expect(world.logs.some(l => /^Keep warm: the renewal at \d\d:\d\d failed \(an API error 529\)\.$/.test(l))).toBe(true)
  expect(world.logs.some(l => /could not take over/.test(l))).toBe(false)
})

test('a sleep during a turn says nothing of a pause', { ...LONG, plugins: [SLEEPER] }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await $.turn.start({ text: 'hi', turnId: 't2' })
  // A tick or two first, for the sleep to fall between ticks
  await world.clock.advance(3000)
  await sleep($, 2 * MIN)
  await world.clock.advance(5000)
  expect(world.logs.some(l => /the computer slept/.test(l))).toBe(false)
})

test('auto-compact found off in an earlier pause does not hide the next pause from other mods', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  world.isAutoCompactEnabled = false
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  world.isAutoCompactEnabled = true
  await answer($)
  await world.clock.advance(10 * MIN)
  expect((await published($, 'upcoming'))?.kind).toBe('compact')
})

test('with auto-compact off, other mods are shown nothing for the pause from its start', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  world.isAutoCompactEnabled = false
  await $.session.start(START)
  await answer($)
  await world.clock.advance(10 * MIN)
  expect(await published($, 'upcoming')).toBe(null)
})

test('a /clear or a /resume after a compaction is no coming back, and starts both switches afresh', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
  await run($, 'off')
  await runKeepWarm($, 'on')
  for (const reason of ['clear', 'resume']) {
    await $.session.end({ reason, sessionId: 's1', resume: { sessionId: 's1' } } as never)
    await answer($)
  }
  expect((await run($, 'stats')).text).toMatch(/This session\s+1\s+0\s+0\s/)
  const chips = await chipOf($)
  expect(await chips.label()).toBe(' on  ')
  expect(await chips.keepWarmLabel()).toBe(' off ')
})

test('before the TTL is known, misses at 59 minutes stand nothing down and blame no model', LONG, async ($, on) => {
  const world = engine(on)
  world.usage = COLD_COMPACTION
  world.forkUsage = FORK_MISS
  await $.session.start(START)
  await runKeepWarm($, 'on')
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(65 * MIN)
  }
  expect(world.logs.some(l => /stands down|renewals can't read/.test(l))).toBe(false)
  expect(world.forks).toBe(2)
})

test('before the TTL is known, two compactions finding the cache gone do not stand warm compact down', LONG, async ($, on) => {
  const world = engine(on)
  world.usage = COLD_COMPACTION
  await $.session.start(START)
  for (const _pause of [1, 2, 3]) {
    await answer($)
    await world.clock.advance(60 * MIN)
  }
  expect(world.compactions).toEqual(['plugin', 'plugin', 'plugin'])
  expect(world.logs.some(l => /stands down/.test(l))).toBe(false)
})

test('with auto-compact found off, other mods are shown nothing while the next turn runs', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  world.isAutoCompactEnabled = false
  await $.session.start(START)
  await answer($)
  await world.clock.advance(5 * MIN)
  await $.turn.start({ text: 'go on', turnId: 't2' })
  await readAll($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await world.clock.advance(3 * MIN)
  expect(await published($, 'upcoming')).toBe(null)
})

test('a compaction that reads the cache warm at 59 minutes shows an hour, and misses count after', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  world.usage = COLD_COMPACTION
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(60 * MIN)
  }
  expect(world.logs.some(l => /stands down/.test(l))).toBe(true)
})

test('a telling read that agrees with the hour makes it known, and misses count after', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await answer($)
  await world.clock.advance(30 * MIN)
  await answer($)
  await run($, 'on')
  world.usage = COLD_COMPACTION
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(60 * MIN)
  }
  expect(world.logs.some(l => /stands down/.test(l))).toBe(true)
})

test('a five-minute TTL learned in this session makes it known, and misses count after', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await answer($)
  world.stepUsage = COLD_STEP
  for (const _pause of [1, 2]) {
    await world.clock.advance(10 * MIN)
    await answer($)
  }
  expect(await published($, 'ttl')).toEqual({ cache: '5m', renew: null })
  await run($, 'on')
  world.stepUsage = USAGE
  world.usage = COLD_COMPACTION
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(5 * MIN)
  }
  expect(world.logs.some(l => /stands down/.test(l))).toBe(true)
})

test('a /resume alone after a compaction is no coming back, and starts both switches afresh', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
  await run($, 'off')
  await runKeepWarm($, 'on')
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { sessionId: 's1' } } as never)
  await answer($)
  expect((await run($, 'stats')).text).toMatch(/This session\s+1\s+0\s+0\s/)
  const chips = await chipOf($)
  expect(await chips.label()).toBe(' on  ')
  expect(await chips.keepWarmLabel()).toBe(' off ')
})

test('a first renewal that reads the cache warm at 59 minutes shows an hour, and its misses count after', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(59 * MIN + 1000)
  world.forkUsage = FORK_MISS
  await answer($)
  await world.clock.advance(65 * MIN)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(2)
  expect(world.logs.some(l => /renewals can't read the conversation/.test(l))).toBe(true)
})

// Half the conversation read from the cache: the tools and the system prompt, other sessions'
const HALF_WARM_COMPACTION = { input_tokens: 10, output_tokens: 1500, cache_read_input_tokens: 66_000, cache_creation_input_tokens: 54_000 }

test('a compaction only half warm at 59 minutes shows no hour', LONG, async ($, on) => {
  const world = engine(on)
  world.usage = HALF_WARM_COMPACTION
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  world.usage = COLD_COMPACTION
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(60 * MIN)
  }
  expect(world.compactions).toHaveLength(3)
  expect(world.logs.some(l => /stands down/.test(l))).toBe(false)
})

test('an hour shown at 59 minutes outweighs a single telling read that said five minutes', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(10 * MIN)
  world.stepUsage = COLD_STEP
  await answer($)
  world.stepUsage = USAGE
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
  await run($, 'off')
  await answer($)
  await world.clock.advance(10 * MIN)
  world.stepUsage = COLD_STEP
  await answer($)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

// A miss on a small conversation: only the tools and the system prompt, other sessions', read
const SMALL_MISS_COMPACTION = { input_tokens: 10, output_tokens: 1500, cache_read_input_tokens: 36_000, cache_creation_input_tokens: 24_000 }

test('a compaction that read only the shared tools and system prompt is a miss, and counts toward the stand-down', LONG, async ($, on) => {
  const world = engine(on, KNOWN)
  world.usage = SMALL_MISS_COMPACTION
  await $.session.start(START)
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(60 * MIN)
  }
  expect(world.logs.some(l => /had already lapsed, so this one saved nothing/.test(l))).toBe(true)
  expect(world.logs.some(l => /stands down/.test(l))).toBe(true)
})

test('with the hour already known, a proof at 59 minutes still outweighs a single telling read that said five minutes', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on, KNOWN)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(10 * MIN)
  world.stepUsage = COLD_STEP
  await answer($)
  world.stepUsage = USAGE
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
  await run($, 'off')
  await answer($)
  await world.clock.advance(10 * MIN)
  world.stepUsage = COLD_STEP
  await answer($)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

// A request that missed: only the tools and the system prompt, which other sessions keep cached, read
const SHARED_ONLY_STEP = { input_tokens: 10, cache_read_input_tokens: 26_000, cache_creation_input_tokens: 94_000, output_tokens: 100 }
// The same on a small conversation, where that shared part is most of it
const SMALL_SHARED_ONLY_STEP = { input_tokens: 10, cache_read_input_tokens: 26_000, cache_creation_input_tokens: 4_000, output_tokens: 100 }

test('two telling reads that found only the shared tools and system prompt show a five-minute cache', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await answer($)
  world.stepUsage = SHARED_ONLY_STEP
  for (const _pause of [1, 2]) {
    await world.clock.advance(10 * MIN)
    await answer($)
  }
  expect(await published($, 'ttl')).toEqual({ cache: '5m', renew: null })
})

test('a telling read on a small conversation, warm only with the shared part, shows no hour', LONG, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await world.clock.advance(10 * MIN)
  world.stepUsage = SMALL_SHARED_ONLY_STEP
  await answer($)
  world.stepUsage = USAGE
  world.usage = COLD_COMPACTION
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(60 * MIN)
  }
  expect(world.compactions).toHaveLength(2)
  expect(world.logs.some(l => /stands down/.test(l))).toBe(false)
})

test('a long message pasted after a pause leaves the hour as it is, the entry being read whole', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await answer($)
  // The 90k entry read whole, and 100k pasted after it
  world.stepUsage = { input_tokens: 100_000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 500, output_tokens: 100 }
  for (const _pause of [1, 2]) {
    await world.clock.advance(10 * MIN)
    await answer($)
    world.stepUsage = { input_tokens: 200_000, cache_read_input_tokens: 190_000, cache_creation_input_tokens: 500, output_tokens: 100 }
  }
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

test('the stand-down counts misses across sessions, as the store holds them', LONG, async ($, on) => {
  const world = engine(on, KNOWN)
  world.usage = COLD_COMPACTION
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  // Another session missed too meanwhile, after this one's first
  world.store.compactMisses = { version: '2.1.289', count: 2 }
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.logs.some(l => /its last 3 compactions found/.test(l))).toBe(true)
})

// A turn's last request ran an advisor: its usage is summed over its own two steps, twice the entry
const ADVISOR_STEP = { input_tokens: 20, cache_read_input_tokens: 227_000, cache_creation_input_tokens: 3_000, output_tokens: 200 }
// The next request, after a pause, reads that entry whole
const AFTER_ADVISOR_STEP = { input_tokens: 10, cache_read_input_tokens: 107_000, cache_creation_input_tokens: 3_000, output_tokens: 100 }

test('a turn that ended on an advisor call does not make the warm read after it look like a miss', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  for (const _pause of [1, 2]) {
    world.stepUsage = ADVISOR_STEP
    await answer($)
    await world.clock.advance(10 * MIN)
    world.stepUsage = AFTER_ADVISOR_STEP
    await answer($)
  }
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

test('misses on another Claude Code version, running at the same time, and this one\'s keep their own counts', LONG, async ($, on) => {
  const world = engine(on, KNOWN)
  world.usage = COLD_COMPACTION
  await $.session.start(START)
  await answer($)
  await world.clock.advance(60 * MIN)
  // A session still on the older version missed meanwhile
  world.store.compactMisses = { ...(world.store.compactMisses as object), '2.1.288': 1 }
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.logs.some(l => /its last 2 compactions found the prompt cache already gone on Claude Code 2\.1\.289/.test(l))).toBe(true)
  expect((world.store.compactMisses as Record<string, number>)['2.1.288']).toBe(1)
})

test('a request the API ran tools of its own in, an advisor, teaches no TTL, nor the request after it', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await answer($)
  world.stepUsage = COLD_STEP
  world.serverToolUses = [{ id: 'srv1', name: 'advisor', input: {} }]
  for (const _pause of [1, 2]) {
    await world.clock.advance(10 * MIN)
    await answer($)
  }
  world.serverToolUses = undefined
  await world.clock.advance(10 * MIN)
  await answer($)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

// warm-compact's state as a reload of the mod would leave it: the try it read back is the one
// set by `/mark-tried`, through a hook on its reads, as a plugin may not write another's
const MARKER = {
  name: 'marker',
  register(on: any) {
    let marked: string | null = null
    on('command.run', { command: 'mark-tried' }, async (_$: unknown, e: { args: string }) => {
      marked = e.args
      return { text: '' }
    })
    on('state.get', async (_$: unknown, e: { plugin: string; key: string }, next: any) => {
      const result = await next(e)
      return e.plugin === 'warm-compact' && e.key === 'triedFor' && marked !== null ? { ...result, value: { ...result.value, value: marked } } : result
    })
  },
}

test('a try kept in the plugin\'s state, as a reload keeps it, is not tried again', { ...LONG, plugins: [MARKER] }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await answer($)
  await $.command.run({ command: 'mark-tried', args: '0:0' } as never)
  await world.clock.advance(61 * MIN)
  expect(world.compactions).toEqual([])
})

// The engine emptying every plugin's state as a session ends, a /clear's too, which the test kit
// does not: after `/wipe`, warm-compact's published TTL reads as nothing until it writes it again
const WIPER = {
  name: 'wiper',
  register(on: any) {
    let isWiped = false
    on('command.run', { command: 'wipe' }, async () => {
      isWiped = true
      return { text: '' }
    })
    on('state.set', async (_$: unknown, e: { plugin: string; key: string }, next: any) => {
      if (e.plugin === 'warm-compact' && e.key === 'ttl') isWiped = false
      return next(e)
    })
    on('state.get', async (_$: unknown, e: { plugin: string; key: string }, next: any) => {
      const result = await next(e)
      return isWiped && e.plugin === 'warm-compact' && e.key === 'ttl' ? { ...result, value: { ...result.value, value: null } } : result
    })
  },
}

test('the TTL it learned is published again once the engine empties the state, as a /clear does', { ...LONG, plugins: [READER, WIPER] }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
  await $.command.run({ command: 'wipe', args: '' } as never)
  expect(await published($, 'ttl')).toBe(null)
  await world.clock.advance(1000)
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

test('/warm-compact on, after it stood down, tries again on this version and leaves another\'s count', LONG, async ($, on) => {
  const world = engine(on, { ...KNOWN, compactMisses: { '2.1.289': 2, '2.1.288': 2 } })
  await $.session.start(START)
  await run($, 'on')
  expect(world.store.compactMisses).toEqual({ '2.1.288': 2 })
})

test('standing down, the chip shows off, and a click tries again', LONG, async ($, on) => {
  const world = engine(on, { ...KNOWN, compactMisses: { '2.1.289': 2 } })
  await $.session.start(START)
  await world.clock.advance(1000)
  const chip = await chipOf($)
  expect(await chip.label()).toBe(' off ')
  await chip.press()
  await world.clock.advance(1000)
  expect(await chip.label()).toBe(' on  ')
  expect(world.store.compactMisses).toEqual({})
  await answer($)
  await world.clock.advance(60 * MIN)
  expect(world.compactions).toEqual(['plugin'])
})

test('a request after an advisor call learns no TTL from it, the entry\'s size being unknown', { ...LONG, ...WITH_READER }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, 'off')
  await answer($)
  for (const _pause of [1, 2]) {
    await world.clock.advance(10 * MIN)
    world.serverToolUses = [{ id: 'srv1', name: 'advisor', input: {} }]
    await answer($)
    world.serverToolUses = undefined
    await world.clock.advance(10 * MIN)
    world.stepUsage = COLD_STEP
    await answer($)
    world.stepUsage = USAGE
  }
  expect(await published($, 'ttl')).toEqual({ cache: '1h', renew: null })
})

// The engine emptying every key of the plugin's state, as a /clear or a /resume does: after
// `/wipe-all`, each reads as its default until written again
const FULL_WIPER = {
  name: 'full-wiper',
  register(on: any) {
    let wiped = new Set<string>()
    on('command.run', { command: 'wipe-all' }, async () => {
      wiped = new Set(['last', 'isTurnRunning', 'isEnabled', 'isKeepWarm', 'kept', 'pendingRecord', 'ttl', 'upcoming', 'triedFor', 'standsDown'])
      return { text: '' }
    })
    on('state.set', async (_$: unknown, e: { plugin: string; key: string }, next: any) => {
      if (e.plugin === 'warm-compact') wiped.delete(e.key)
      return next(e)
    })
    on('state.get', async (_$: unknown, e: { plugin: string; key: string }, next: any) => {
      const result = await next(e)
      return e.plugin === 'warm-compact' && wiped.has(e.key) ? { ...result, value: { ...result.value, value: undefined } } : result
    })
  },
}

test('stood down, the chip still shows off once the engine empties the state', { ...LONG, plugins: [FULL_WIPER] }, async ($, on) => {
  const world = engine(on, { ...KNOWN, compactMisses: { '2.1.289': 2 } })
  await $.session.start(START)
  await world.clock.advance(1000)
  expect(await (await chipOf($)).label()).toBe(' off ')
  await $.command.run({ command: 'wipe-all', args: '' } as never)
  await world.clock.advance(2000)
  expect(await (await chipOf($, 'hint2')).label()).toBe(' off ')
})

test('a second stand-down in the same process is said again', LONG, async ($, on) => {
  const world = engine(on, KNOWN)
  world.usage = COLD_COMPACTION
  await $.session.start(START)
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(61 * MIN)
  }
  expect(world.logs.filter(l => /stands down/.test(l))).toHaveLength(1)
  await run($, 'on')
  for (const _pause of [1, 2]) {
    await answer($)
    await world.clock.advance(61 * MIN)
  }
  expect(world.compactions).toHaveLength(4)
  expect(world.logs.filter(l => /stands down/.test(l))).toHaveLength(2)
})

test('/warm-compact with nothing after it, while it stands down and its chip shows off, tries again', LONG, async ($, on) => {
  const world = engine(on, { ...KNOWN, compactMisses: { '2.1.289': 2 } })
  await $.session.start(START)
  await world.clock.advance(1000)
  expect((await run($, '')).text).toBe('Warm compact is on for this session.')
  expect(world.store.compactMisses).toEqual({})
})

test('with warm compact off, keep warm on renewals that hold 5 minutes says so as its renewal would have come', LONG, async ($, on) => {
  const world = engine(on, { ...KNOWN, renewTtl: '5m' })
  await $.session.start(START)
  await run($, 'off')
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(0)
  expect(world.logs.some(l => /^Keep warm: a renewal holds this account's cache for 5 minutes only, so it stands down\.$/.test(l))).toBe(true)
})

test('with warm compact off, keep warm on a model whose renewals miss says so as its renewal would have come', LONG, async ($, on) => {
  const world = engine(on, { ...KNOWN, renewMisses: { 'claude-opus-5-5': '2.1.289' } })
  await $.session.start(START)
  await run($, 'off')
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(0)
  expect(world.logs.some(l => /^Keep warm: renewals can't read .*, so it stands down\.$/.test(l))).toBe(true)
})

test('after a /clear, the new conversation is told again why warm compact leaves it alone', LONG, async ($, on) => {
  const world = engine(on)
  world.isAutoCompactEnabled = false
  await $.session.start(START)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.logs.filter(l => /auto-compact is off/.test(l))).toHaveLength(1)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } } as never)
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.logs.filter(l => /auto-compact is off/.test(l))).toHaveLength(2)
})

test('keep warm standing down says so with warm compact stood down too', LONG, async ($, on) => {
  const world = engine(on, { ...KNOWN, renewTtl: '5m', compactMisses: { '2.1.289': 2 } })
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(0)
  expect(world.logs.some(l => /^Keep warm: a renewal holds this account's cache for 5 minutes only, so it stands down\.$/.test(l))).toBe(true)
})

test('keep warm standing down says so with auto-compact off', LONG, async ($, on) => {
  const world = engine(on, { ...KNOWN, renewTtl: '5m' })
  world.isAutoCompactEnabled = false
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(61 * MIN)
  expect(world.forks).toBe(0)
  expect(world.logs.some(l => /^Keep warm: a renewal holds this account's cache for 5 minutes only, so it stands down\.$/.test(l))).toBe(true)
})

test('keep warm standing down, with a compaction held off but still to come, only says it takes over', LONG, async ($, on) => {
  const world = engine(on, { ...KNOWN, renewTtl: '5m' })
  await $.session.start(START)
  await runKeepWarm($, 'on')
  await answer($)
  await world.clock.advance(60 * MIN - 80_000)
  await edit($)
  await world.clock.advance(80_000)
  expect(world.compactions).toEqual(['plugin'])
  expect(world.logs.filter(l => /^Keep warm:/.test(l))).toEqual(["Keep warm: a renewal holds this account's cache for 5 minutes only, so warm compact takes over."])
})
