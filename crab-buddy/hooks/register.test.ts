import { expect, mock, test } from 'claude-code/testing'

import { CLAUDE_COLOR, drawScene, paletteFor } from './crab'
import type { Mood } from './crab'

import { AGENT_COLORS, crewPhase, isThinkingChunk, pickAgentColor, sceneOf, SPARE_AGENT_COLORS } from './register'

test('isThinkingChunk thinks from a piece of thinking until text, a tool call or the stop', () => {
  expect(isThinkingChunk('thinking', false)).toBe(true)
  expect(isThinkingChunk('engine', true)).toBe(true)
  expect(isThinkingChunk('engine', false)).toBe(false)
  for (const kind of ['text', 'tool', 'input', 'stop']) expect(isThinkingChunk(kind, true)).toBe(false)
})

const spare = (place: number): number => SPARE_AGENT_COLORS[place] ?? -1

test('pickAgentColor gives built-in types their own color and any other a spare one kept for it', () => {
  expect(pickAgentColor('Explore', {})).toBe(0x3fb950)
  expect(pickAgentColor('general-purpose', {})).toBe(0x58a6ff)
  expect(pickAgentColor('fork', {})).toBe(CLAUDE_COLOR)
  expect(pickAgentColor('reviewer', {})).toBe(spare(0))
  expect(pickAgentColor('reviewer', { auditor: spare(0) })).toBe(spare(1))
  expect(pickAgentColor('auditor', { auditor: spare(4) })).toBe(spare(4))
  const full = Object.fromEntries(SPARE_AGENT_COLORS.map((color, i) => [`type-${i}`, color]))
  expect(SPARE_AGENT_COLORS).toContain(pickAgentColor('one-more', full))
  expect(pickAgentColor('one-more', full)).toBe(pickAgentColor('one-more', full))
  // No spare repeats a built-in type's color
  for (const color of SPARE_AGENT_COLORS) expect(Object.values(AGENT_COLORS)).not.toContain(color)
})

test('crewPhase reads an agent status as walking, waiting, done or gone', () => {
  expect(crewPhase('pending')).toBe('running')
  expect(crewPhase('running')).toBe('running')
  expect(crewPhase('waiting')).toBe('waiting')
  expect(crewPhase('idle')).toBe('waiting')
  expect(crewPhase('completed')).toBe('done')
  expect(crewPhase('failed')).toBe(null)
  expect(crewPhase('killed')).toBe(null)
})

test('sceneOf shows eight small crabs and counts the rest', () => {
  const member = { color: 0x58a6ff, phase: 'running' as const, isThinking: false, since: 0, isListed: true }
  const scene = sceneOf('idle', Array.from({ length: 10 }, () => member), 0)
  expect(scene.minis.length).toBe(8)
  expect(scene.hidden).toBe(2)
  expect(scene.minis[0]).toEqual({ color: 0x58a6ff, mood: 'working' })
})

// Every frame the crab alone draws in a mood, over its longest cycle
const framesOf = (mood: Mood): Set<string> =>
  new Set(Array.from({ length: 64 }, (_, tick) => drawScene({ mood, minis: [], hidden: 0, flights: [] }, tick).cells))

const decode = (cells: string): number[] => Array.from(new Uint32Array(Uint8Array.fromBase64(cells).buffer))
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never

// The engine beneath the mod: a clock, a store, the band's blits, and agents
const engine = (on: any, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  mock.store(on, store)
  const world = { clock, blits: [] as string[], agents: [] as { id: string; description: string; type: string; status: string }[] }
  on('agent.list', async () => ({ value: world.agents }))
  on('session.start', async () => ({ cwd: '/' }))
  on('turn.start', async (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-4-5', agentId: 'a1' }))
  on('ui.blit', async (_$: unknown, e: { cells?: string }) => {
    if (e.cells !== undefined) world.blits.push(e.cells)
    return { value: {} }
  })
  // Each step thinks for a second, then writes for a second
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'thinking' as const, index: 0, text: 'hmm' }
    await clock.sleep(1000)
    yield { kind: 'text' as const, index: 1, text: 'ok' }
    await clock.sleep(1000)
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return world
}

const readAll = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const _chunk of stream);
}

test('the crab thinks while thinking streams and works once the answer does', async ($, on) => {
  const { clock, blits } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'band' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const reading = readAll($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))

  await clock.advance(900)
  expect(blits.some(cells => framesOf('thinking').has(cells))).toBe(true)
  blits.length = 0
  await clock.advance(1000)
  expect(blits.some(cells => framesOf('working').has(cells))).toBe(true)
  expect(blits.some(cells => framesOf('thinking').has(cells))).toBe(false)
  await clock.advance(1000)
  await reading
})

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Look around.',
  description: 'look around',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
}

test('a subagent gets a small crab in its type color that thinks, works, cheers, then leaves', async ($, on) => {
  const world = engine(on)
  const { clock } = world
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'band' })
  const raster = async () => {
    const found = await band.find({ type: 'Raster' })
    return { columns: found?.props.columns as number, words: decode(found?.props.cells as string) }
  }
  const cell = (words: number[], columns: number, row: number, column: number) =>
    words.slice((row * columns + column) * 3, (row * columns + column) * 3 + 3)
  expect((await raster()).columns).toBe(20)

  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' } as never)
  world.agents = [{ id: 'a1', description: 'look around', type: 'Explore', status: 'running' }]
  await clock.advance(500)
  const spawned = await raster()
  expect(spawned.columns).toBe(8 + 20)
  // Its head's light edge, in Explore's green
  const green = paletteFor(0x3fb950)
  expect(cell(spawned.words, spawned.columns, 2, 1)).toEqual([0x2580, green.H, green.H])

  // Its own step: a bubble over its head while it thinks, gone once it writes
  const bubbles = () => world.blits.map(decode).filter(words => cell(words, 28, 1, 6)[1] === 0xd2a8ff).length
  world.blits.length = 0
  const reading = readAll($.turn.step({ turnId: 's1', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'a1' }))
  await clock.advance(900)
  expect(bubbles()).toBeGreaterThan(0)
  world.blits.length = 0
  await clock.advance(1000)
  expect(bubbles()).toBe(0)
  await clock.advance(1000)
  await reading

  // Done: it cheers with sparks over its head, then leaves
  world.blits.length = 0
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1' } as never)
  world.agents = [{ id: 'a1', description: 'look around', type: 'Explore', status: 'completed' }]
  await clock.advance(1000)
  const sparks = world.blits.map(decode).filter(words => [0, 6].some(column => cell(words, 28, 1, column)[1] === 0xe3b341))
  expect(sparks.length).toBeGreaterThan(0)
  await clock.advance(5000)
  expect((await raster()).columns).toBe(20)
})

test('a type the store already gave a color keeps it in a new session', async ($, on) => {
  const auditor = spare(3)
  const world = engine(on, { agentColors: { 'my-plugin:auditor': auditor } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'band' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'my-plugin:auditor' } as never)
  world.agents = [{ id: 'a1', description: 'audit', type: 'my-plugin:auditor', status: 'running' }]
  await world.clock.advance(500)
  const found = await band.find({ type: 'Raster' })
  const words = decode(found?.props.cells as string)
  const columns = found?.props.columns as number
  const at = (row: number, column: number) => words.slice((row * columns + column) * 3, (row * columns + column) * 3 + 3)
  expect(at(2, 1)).toEqual([0x2580, paletteFor(auditor).H, paletteFor(auditor).H])
})

// A white envelope's paper anywhere in the two rows over the small crabs
const hasPaper = (words: number[], columns: number): boolean =>
  Array.from({ length: 2 * columns }, (_, place) => words.slice(place * 3, place * 3 + 3)).some(
    ([, foreground, background]) => foreground === 0xf0f6fc || background === 0xf0f6fc,
  )

test("a subagent's message and its final report fly from its small crab to the crab", async ($, on) => {
  const world = engine(on)
  const { clock } = world
  on('session.send', async () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'band' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' } as never)
  world.agents = [{ id: 'a1', description: 'look around', type: 'Explore', status: 'running' }]
  await clock.advance(500)
  const flying = () => world.blits.map(decode).filter(words => hasPaper(words, 28)).length

  world.blits.length = 0
  await $.session.send({ to: 'main', text: 'Halfway there.', origin: { kind: 'model' }, agentId: 'a1' } as never)
  await clock.advance(600)
  expect(flying()).toBeGreaterThan(0)
  // Landed and gone
  await clock.advance(1000)
  world.blits.length = 0
  await clock.advance(1000)
  expect(flying()).toBe(0)

  // Its report: the answer that ends its turn
  await $.turn.complete({ reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1' } as never)
  await clock.advance(600)
  expect(flying()).toBeGreaterThan(0)
})

test('a message from the main loop or to another subagent flies nowhere', async ($, on) => {
  const world = engine(on)
  on('session.send', async () => ({ isDelivered: true }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'band' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' } as never)
  world.agents = [{ id: 'a1', description: 'look around', type: 'Explore', status: 'running' }]
  await world.clock.advance(500)
  world.blits.length = 0
  await $.session.send({ to: 'a1', text: 'Keep going.', origin: { kind: 'model' } } as never)
  await world.clock.advance(600)
  expect(world.blits.map(decode).filter(words => hasPaper(words, 28)).length).toBe(0)
})
