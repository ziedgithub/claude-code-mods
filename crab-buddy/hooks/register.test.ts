import { expect, mock, test } from 'claude-code/testing'

import { CLAUDE_COLOR, drawAgent, drawScene, paletteFor } from './crab'
import type { Mood } from './crab'

import { AGENT_COSTUMES, costumeOf, crewPhase, isThinkingChunk, pickAgentColor, sceneOf, SPARE_AGENT_COLORS } from './register'

test('isThinkingChunk thinks from a piece of thinking until text, a tool call or the stop', () => {
  expect(isThinkingChunk('thinking', false)).toBe(true)
  expect(isThinkingChunk('engine', true)).toBe(true)
  expect(isThinkingChunk('engine', false)).toBe(false)
  for (const kind of ['text', 'tool', 'input', 'stop']) expect(isThinkingChunk(kind, true)).toBe(false)
})

const spare = (place: number): number => SPARE_AGENT_COLORS[place] ?? -1

test('pickAgentColor gives a fork the crab\'s color and any other type a spare one kept for it', () => {
  expect(pickAgentColor('fork', {})).toBe(CLAUDE_COLOR)
  expect(pickAgentColor('reviewer', {})).toBe(spare(0))
  expect(pickAgentColor('reviewer', { auditor: spare(0) })).toBe(spare(1))
  expect(pickAgentColor('auditor', { auditor: spare(4) })).toBe(spare(4))
  const full = Object.fromEntries(SPARE_AGENT_COLORS.map((color, i) => [`type-${i}`, color]))
  expect(SPARE_AGENT_COLORS).toContain(pickAgentColor('one-more', full))
  expect(pickAgentColor('one-more', full)).toBe(pickAgentColor('one-more', full))
  // No spare is the crab's own color
  expect(SPARE_AGENT_COLORS).not.toContain(CLAUDE_COLOR)
})

test('costumeOf dresses each built-in type for its work and any other by the words of its name', () => {
  expect(costumeOf('general-purpose')).toBe('chef')
  expect(costumeOf('Explore')).toBe('explorer')
  expect(costumeOf('Plan')).toBe('planner')
  expect(costumeOf('claude-code-guide')).toBe('scholar')
  expect(costumeOf('statusline-setup')).toBe('mechanic')
  expect(costumeOf('claude')).toBe('wizard')
  expect(costumeOf('fork')).toBe(null)
  expect(Object.keys(AGENT_COSTUMES).length).toBe(7)
  // A project's own agents and a plugin's, past its prefix; the last word naming work wins
  expect(costumeOf('implementer')).toBe('builder')
  expect(costumeOf('planner')).toBe('planner')
  expect(costumeOf('spec-reviewer')).toBe('reviewer')
  expect(costumeOf('reviewer-security')).toBe('reviewer')
  expect(costumeOf('compound-engineering:ce-repo-research-analyst')).toBe('explorer')
  expect(costumeOf('compound-engineering:ce-architecture-strategist')).toBe('planner')
  expect(costumeOf('compound-engineering:ce-ankane-readme-writer')).toBe('scholar')
  expect(costumeOf('compound-engineering:ce-figma-design-sync')).toBe('designer')
  expect(costumeOf('codeReviewer')).toBe('reviewer')
  // The longest match wins; a two-letter word matches a whole word only
  expect(costumeOf('devops-agent')).toBe('mechanic')
  expect(costumeOf('docker-runner')).toBe('mechanic')
  expect(costumeOf('frontend-developer')).toBe('builder')
  expect(costumeOf('ui-polisher')).toBe('designer')
  expect(costumeOf('quick-agent')).toBe(null)
  // No word, no costume; nor from the names objects carry
  expect(costumeOf('my-plugin:zebra')).toBe(null)
  expect(costumeOf('constructor')).toBe(null)
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

test('sceneOf shows up to eight small crabs and counts the rest, fewer beside a smaller crab on a phone', () => {
  const member = { color: CLAUDE_COLOR, costume: 'builder' as const, phase: 'running' as const, isThinking: false, since: 0, isListed: true }
  const members = Array.from({ length: 10 }, () => member)
  const wide = sceneOf('idle', members, 0, 200)
  expect(wide.isCompact).toBe(false)
  expect(wide.minis.length).toBe(8)
  expect(wide.hidden).toBe(2)
  expect(wide.minis[0]).toEqual({ color: CLAUDE_COLOR, mood: 'working', costume: 'builder' })
  const phone = sceneOf('idle', members, 0, 48)
  expect(phone.isCompact).toBe(true)
  expect(phone.minis.length).toBe(3)
  expect(phone.hidden).toBe(7)
  expect(sceneOf('idle', members, 0, 79).isCompact).toBe(true)
  expect(sceneOf('idle', members, 0, 80).isCompact).toBe(false)
})

// Every frame the crab alone draws in a mood, over its longest cycle
const framesOf = (mood: Mood): Set<string> =>
  new Set(Array.from({ length: 64 }, (_, tick) => drawScene({ mood, minis: [], hidden: 0, flights: [], isCompact: false }, tick).cells))

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
  // The engine's own band, which the crab draws over: empty with no survey
  on('ui.render', async ($: any, e: unknown) => h($.ui.resolve(e).Box, null))
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

test('a subagent gets a small crab dressed for its type that thinks, works, cheers, then leaves', async ($, on) => {
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
  expect((await raster()).columns).toBe(19)

  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' } as never)
  world.agents = [{ id: 'a1', description: 'look around', type: 'Explore', status: 'running' }]
  await clock.advance(500)
  const spawned = await raster()
  expect(spawned.columns).toBe(11 + 19)
  // Explore's khaki helmet, its band over its brim, on a face in the crab's own color
  expect(cell(spawned.words, spawned.columns, 1, 1)).toEqual([0x2580, 0x7a5a2e, 0xc8a165])
  expect(cell(spawned.words, spawned.columns, 2, 1)).toEqual([0x20, 0x01000000, CLAUDE_COLOR])

  // Its own step: a bubble over it while it thinks, gone once it writes
  const bubbles = () => world.blits.map(decode).filter(words => cell(words, 30, 0, 7)[1] === 0xd2a8ff).length
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
  const sparks = world.blits.map(decode).filter(words => [7, 8].some(column => cell(words, 30, 0, column)[1] === 0xe3b341))
  expect(sparks.length).toBeGreaterThan(0)
  await clock.advance(5000)
  expect((await raster()).columns).toBe(19)
})

test('a narrow band, as on a phone, draws the smaller crab flush right, no glyph columns past it', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: { ...(BAND as object), bodyColumns: 48 } as never, requestId: 'band' })
  const columns = async () => (await band.find({ type: 'Raster' }))?.props.columns
  expect(await columns()).toBe(12)
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' } as never)
  world.agents = [{ id: 'a1', description: 'look around', type: 'Explore', status: 'running' }]
  await world.clock.advance(500)
  expect(await columns()).toBe(11 + 12)
  // No padding of its own: the engine keeps the room for its `[-]`
  const box = await band.find({ type: 'Box' })
  expect(box?.props.paddingRight).toBe(undefined)
})

test('a type no costume fits goes bare, in the color the store already gave it', async ($, on) => {
  const auditor = spare(3)
  const world = engine(on, { agentColors: { 'my-plugin:zebra': auditor } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: BAND, requestId: 'band' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'my-plugin:zebra' } as never)
  world.agents = [{ id: 'a1', description: 'stripes', type: 'my-plugin:zebra', status: 'running' }]
  await world.clock.advance(500)
  const found = await band.find({ type: 'Raster' })
  const words = decode(found?.props.cells as string)
  const columns = found?.props.columns as number
  const at = (row: number, column: number) => words.slice((row * columns + column) * 3, (row * columns + column) * 3 + 3)
  // Bare-headed, the top of its head in its own color
  expect(at(1, 2)).toEqual([0x2584, paletteFor(auditor).H, 0x01000000])
  expect(at(0, 2)).toEqual([0x20, 0x01000000, 0x01000000])
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
  const flying = () => world.blits.map(decode).filter(words => hasPaper(words, 30)).length

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
  expect(world.blits.map(decode).filter(words => hasPaper(words, 30)).length).toBe(0)
})

const EXPLORER = { id: 'a1', description: 'look around', type: 'Explore', status: 'running' }
const DEFAULT = 0x01000000
const viewing = (agentId: string | undefined, props: object = {}) => ({ ...(BAND as object), ...props, view: agentId === undefined ? {} : { agentId } }) as never

test("in an agent's transcript, the band shows its crab alone at the crab's own size, dressed for its work", async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' } as never)
  world.agents = [EXPLORER]
  await world.clock.advance(500)
  const band = await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: viewing('a1'), requestId: 'band' })
  const raster = async () => {
    const found = await band.find({ type: 'Raster' })
    return { columns: found?.props.columns, rows: found?.props.rows, words: decode(found?.props.cells as string) }
  }
  // The crab's 16 columns and its tool's 5, its explorer's helmet over it
  const agent = await raster()
  expect([agent.columns, agent.rows]).toEqual([21, 6])
  expect(agent.words.includes(0xc8a165)).toBe(true)
  // Painted in place as it works: a frame later, the same size
  world.blits.length = 0
  await world.clock.advance(500)
  expect(world.blits.length).toBeGreaterThan(0)
  for (const cells of world.blits) expect(decode(cells).length).toBe(21 * 6 * 3)
  // A band short of rows for its hat draws its small crab
  await band.redraw(viewing('a1', { maxRows: 5 }))
  const small = await raster()
  expect([small.columns, small.rows]).toEqual([10, 4])
  // Back on the main conversation: the crab and its crew
  await band.redraw(viewing(undefined))
  expect([(await raster()).columns, (await raster()).rows]).toEqual([11 + 19, 4])
})

test("an agent's crab stays dressed in its transcript once it is done and gone from the band", async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' } as never)
  world.agents = [EXPLORER]
  await world.clock.advance(500)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1' } as never)
  world.agents = []
  await world.clock.advance(6000)
  const band = await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: viewing('a1'), requestId: 'band' })
  const found = await band.find({ type: 'Raster' })
  expect([found?.props.columns, found?.props.rows]).toEqual([21, 6])
  expect(decode(found?.props.cells as string).includes(0xc8a165)).toBe(true)
})

test('an agent in view the band never drew is dressed from the list', async ($, on) => {
  const world = engine(on)
  world.agents = [{ id: 'old', description: 'review it', type: 'spec-reviewer', status: 'completed' }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: viewing('old'), requestId: 'band' })
  // A reviewer at rest, in its glasses, its clipboard at its side
  expect((await band.find({ type: 'Raster' }))?.props.cells).toBe(drawAgent({ color: CLAUDE_COLOR, mood: 'idle', costume: 'reviewer' }, 0).cells)
})

test("a fork's crab in its transcript is the crab itself, at its laptop", async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, subagentType: 'fork' } as never)
  world.agents = [{ id: 'a1', description: 'fork', type: 'fork', status: 'running' }]
  await world.clock.advance(500)
  const band = await $.ui.mount({ plugin: 'crab-buddy', surface: 'terminal', component: 'AbovePrompt', props: viewing('a1'), requestId: 'band' })
  const found = await band.find({ type: 'Raster' })
  expect([found?.props.columns, found?.props.rows]).toEqual([19, 4])
  expect(framesOf('working').has(found?.props.cells as string)).toBe(true)
})
