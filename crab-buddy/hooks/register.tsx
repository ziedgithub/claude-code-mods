import type { EngineInterface, Register, Timer } from 'claude-code'

import { agentMoodFor, CHEER_FRAMES, CLAUDE_COLOR, drawScene, FRAME_MS, IDLE, MAX_MINIS, moodFor, PERSONA_ROWS } from './crab'
import type { Activity, AgentActivity, Flight, MiniPhase, Scene } from './crab'

// The band draws its collapse mark `[-]` over the last cells of its first row
const BAND_MARK_COLUMNS = 4
const PERSONA_KEY = 'persona'
const CREW_POLL_MS = 1000
const AGENT_COLORS_KEY = 'agentColors'
// A width change asked for a redraw that has not come yet is asked again after this many frames
const REDRAW_RETRY_FRAMES = 4
// A message flies on a clock of its own, smoother than the poses', for FLIGHT_STEPS of it
const FLIGHT_MS = 50
const FLIGHT_STEPS = 24
// A report delivered this soon after the agent's own send is that same message
const SENT_RECENTLY_FRAMES = 8

// The small crab of each built-in agent type has its own color, the same on every machine;
// a fork, a copy of the conversation, takes the crab's own
export const AGENT_COLORS: Readonly<Record<string, number>> = {
  'general-purpose': 0x58a6ff,
  Explore: 0x3fb950,
  Plan: 0xbc8cff,
  'claude-code-guide': 0xe3b341,
  'statusline-setup': 0x39c5bb,
  claude: 0xf778ba,
  fork: CLAUDE_COLOR,
}
// Any other type takes the first of these no type holds yet, kept in the store for good
export const SPARE_AGENT_COLORS: readonly number[] = [
  0xff7b72, 0x56d4dd, 0xa5d65a, 0xdb61a2, 0x79c0ff, 0xd29922, 0xf0f6fc, 0x8b949e, 0x2ea043, 0x9e6a03,
]

const isColorRecord = (value: unknown): value is Record<string, number> =>
  typeof value === 'object' && value !== null && Object.values(value).every(color => typeof color === 'number')

const hashOf = (text: string): number => {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash
}

// A built-in type's own color, else the one kept for it, else the first spare no type holds;
// once the spares run out, one picked by the name
export const pickAgentColor = (type: string, kept: Readonly<Record<string, number>>): number => {
  const known = AGENT_COLORS[type] ?? kept[type]
  if (known !== undefined) return known
  const taken = new Set([...Object.values(AGENT_COLORS), ...Object.values(kept)])
  const free = SPARE_AGENT_COLORS.find(color => !taken.has(color))
  return free ?? SPARE_AGENT_COLORS[hashOf(type) % SPARE_AGENT_COLORS.length] ?? CLAUDE_COLOR
}

// What an agent's status means for its small crab: walking, standing, a last hop, or gone
export const crewPhase = (status: string): MiniPhase | null => {
  if (status === 'pending' || status === 'running') return 'running'
  if (status === 'waiting' || status === 'idle') return 'waiting'
  return status === 'completed' ? 'done' : null
}

// The crab thinks from the first piece of thinking until the model writes, calls a tool or
// stops; the stream's own bookkeeping items leave it as it was
export const isThinkingChunk = (kind: string, wasThinking: boolean): boolean => {
  if (kind === 'thinking') return true
  return kind === 'engine' ? wasThinking : false
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

// The crab above the prompt is repainted in place on each frame of the clock: a blit, not
// a redraw. Its site is known once the band is drawn, and gone while a dialog takes it
let frameTick = 0
let activity: Activity = IDLE
let personaSite: string | null = null
let paintedCells: string | null = null
let paintedColumns = 0
let redrawAskedAt: number | null = null

// The subagents' small crabs, in the order they started. `isListed` once `$.agent.list()`
// showed the agent, whose leaving the list then ends it; a workflow's agents are never
// listed and end with their `turn.complete` alone
type CrewMember = AgentActivity & { color: number; isListed: boolean }
const crew = new Map<string, CrewMember>()
let keptColors: Record<string, number> = {}

// A new type's color is written at once, over what another session may have kept meanwhile
const colorOf = async ($: EngineInterface, type: string): Promise<number> => {
  if (AGENT_COLORS[type] !== undefined || keptColors[type] !== undefined) return pickAgentColor(type, keptColors)
  const stored = await $.store.get(AGENT_COLORS_KEY)
  if (isColorRecord(stored)) keptColors = { ...stored, ...keptColors }
  const color = pickAgentColor(type, keptColors)
  keptColors = { ...keptColors, [type]: color }
  await $.store.set(AGENT_COLORS_KEY, keptColors)
  return color
}

const enlist = async ($: EngineInterface, id: string, type: string, phase: MiniPhase, isListed: boolean): Promise<void> => {
  const color = await colorOf($, type)
  if (!crew.has(id)) crew.set(id, { color, phase, isThinking: false, since: frameTick, isListed })
}

// The messages in the air, from the small crab of `agentId`, and when each agent last sent
type InFlight = { agentId: string; color: number; step: number }
let flights: InFlight[] = []
let flightTimer: Timer | null = null
const sentAt = new Map<string, number>()

const fly = async ($: EngineInterface): Promise<void> => {
  flights = flights.map(flight => ({ ...flight, step: flight.step + 1 })).filter(flight => flight.step <= FLIGHT_STEPS)
  if (flights.length === 0) {
    flightTimer?.cancel()
    flightTimer = null
  }
  await paint($)
}

const launch = ($: EngineInterface, agentId: string): void => {
  const member = crew.get(agentId)
  if (member === undefined) return
  sentAt.set(agentId, frameTick)
  flights = [...flights, { agentId, color: member.color, step: 0 }]
  flightTimer ??= $.clock.every(FLIGHT_MS, () => void fly($))
}

// An answer is the agent's report to the main loop: unless the agent just sent it itself, it
// flies over before the small crab cheers and leaves; an interrupted or failed agent just leaves
const finish = ($: EngineInterface, id: string, isAnswered: boolean): void => {
  const member = crew.get(id)
  if (member === undefined || member.phase === 'done') return
  if (!isAnswered) {
    crew.delete(id)
    return
  }
  const sent = sentAt.get(id)
  if (sent === undefined || frameTick - sent >= SENT_RECENTLY_FRAMES) launch($, id)
  crew.set(id, { ...member, phase: 'done', isThinking: false, since: frameTick })
}

const moveTo = (id: string, member: CrewMember, phase: MiniPhase): void => {
  if (member.phase !== phase) crew.set(id, { ...member, phase, isThinking: false, since: frameTick })
}

// The list says which agents still run or wait; one marked done stays done until a step of
// its own says it runs again
const syncCrew = async ($: EngineInterface): Promise<void> => {
  const agents = await $.agent.list()
  const listed = new Set(agents.map(agent => agent.id))
  for (const agent of agents) {
    const phase = crewPhase(agent.status)
    const member = crew.get(agent.id)
    if (member === undefined) {
      if (phase === 'running' || phase === 'waiting') await enlist($, agent.id, agent.type, phase, true)
    } else if (phase === null || phase === 'done') {
      finish($, agent.id, phase === 'done')
    } else if (member.phase !== 'done') {
      const listed = { ...member, isListed: true }
      crew.set(agent.id, listed)
      moveTo(agent.id, listed, phase)
    }
  }
  for (const [id, member] of crew) {
    if (member.isListed && !listed.has(id) && member.phase !== 'done') crew.delete(id)
  }
}

export const sceneOf = (mood: Scene['mood'], members: readonly CrewMember[], tick: number): Scene => ({
  mood,
  minis: members.slice(0, MAX_MINIS).map(member => ({ color: member.color, mood: agentMoodFor(member, tick) })),
  hidden: Math.max(0, members.length - MAX_MINIS),
  flights: [],
})

// A message whose sender's small crab has left is dropped with it
export const flightsOf = (ids: readonly string[], inFlight: readonly InFlight[]): Flight[] =>
  inFlight.flatMap(flight => {
    const from = Math.min(ids.indexOf(flight.agentId), MAX_MINIS)
    return from < 0 ? [] : [{ from, color: flight.color, progress: flight.step / FLIGHT_STEPS }]
  })

const currentScene = (): Scene => ({
  ...sceneOf(moodFor(activity, frameTick), [...crew.values()], frameTick),
  flights: flightsOf([...crew.keys()], flights),
})

const animate = async ($: EngineInterface): Promise<void> => {
  frameTick++
  for (const [id, member] of crew) {
    if (member.phase === 'done' && frameTick - member.since >= CHEER_FRAMES) crew.delete(id)
  }
  await paint($)
}

const paint = async ($: EngineInterface): Promise<void> => {
  const { columns, cells } = drawScene(currentScene(), frameTick)
  if (personaSite === null || cells === paintedCells) return
  // A crab more or fewer changes the width, which takes a redraw rather than a blit
  if (columns !== paintedColumns) {
    if (redrawAskedAt === null || frameTick - redrawAskedAt >= REDRAW_RETRY_FRAMES) {
      redrawAskedAt = frameTick
      $.ui.invalidate('ui.render')
    }
    return
  }
  const result = await $.ui.blit({ requestId: personaSite, key: PERSONA_KEY, cells })
  if (!('deny' in result)) paintedCells = cells
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(FRAME_MS, () => void animate($))
    $.clock.every(CREW_POLL_MS, () => void syncCrew($))
    return next(e)
  })

  // A subagent's message flies from its small crab to the crab, unless it goes to another
  // of the subagents
  on('session.send', async ($, e, next) => {
    const result = await next(e)
    if (result.isDelivered && e.agentId !== undefined && !crew.has(e.to)) launch($, e.agentId)
    return result
  })

  // A subagent's small crab appears as it starts, in its type's color
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId !== undefined) await enlist($, result.agentId, e.subagentType, 'running', false)
    return result
  })

  // A subagent's run raises no `turn.start`: the crab works for the main loop only
  on('turn.start', async ($, e, next) => {
    activity = { ...activity, isWorking: true, isThinking: false }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      activity = { isWorking: false, isThinking: false, endedAt: frameTick, isCheering: e.reason === 'answer' }
    } else {
      finish($, e.agentId, e.reason === 'answer')
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent's small crab works on each of its steps and thinks while its thinking
    // streams; one the crew lacks, started before a reload, is looked up in the list
    if (e.agentId !== undefined) {
      const id = e.agentId
      const member = crew.get(id)
      if (member === undefined) await syncCrew($)
      else moveTo(id, member, 'running')
      return yield* tap(next(e), async chunk => {
        const current = crew.get(id)
        if (current === undefined || current.phase !== 'running') return
        const isThinking = isThinkingChunk(chunk.kind, current.isThinking)
        if (isThinking !== current.isThinking) crew.set(id, { ...current, isThinking })
      })
    }
    return yield* tap(next(e), async chunk => {
      const isThinking = isThinkingChunk(chunk.kind, activity.isThinking)
      if (isThinking !== activity.isThinking) activity = { ...activity, isThinking }
    })
  })

  // The band above the prompt, empty unless a survey takes it; drawn on the right, clear of
  // its collapse mark. The crab is drawn in the terminal only
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const { Box, Raster } = $.ui.resolve(e)
    const { columns, cells } = drawScene(currentScene(), frameTick)
    personaSite = e.requestId
    paintedCells = cells
    paintedColumns = columns
    redrawAskedAt = null
    return (
      <Box justifyContent="flex-end" paddingRight={BAND_MARK_COLUMNS}>
        <Raster key={PERSONA_KEY} columns={columns} rows={PERSONA_ROWS} cells={cells} />
      </Box>
    )
  })
}
