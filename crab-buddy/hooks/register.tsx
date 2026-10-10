import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import { AGENT_ROWS, agentMoodFor, CHEER_FRAMES, CLAUDE_COLOR, COMPACT_BELOW, drawAgent, drawLone, drawScene, flapColorOf, FRAME_MS, IDLE, minisThatFit, moodFor, PERSONA_ROWS } from './crab'
import type { Activity, AgentActivity, Costume, Flight, Mini, MiniPhase, Scene } from './crab'

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

// The small crab of each built-in agent type is dressed for its work; a fork, a copy of the
// conversation, goes bare in the crab's own color
export const AGENT_COSTUMES: Readonly<Record<string, Costume | null>> = {
  'general-purpose': 'chef',
  Explore: 'explorer',
  Plan: 'planner',
  'claude-code-guide': 'scholar',
  'statusline-setup': 'mechanic',
  claude: 'wizard',
  fork: null,
}
// Any other type is dressed by the words of its name, past a plugin's prefix: the last word
// that names a kind of work wins, as `spec-reviewer` reviews. A word here matches the start
// of a name's word (a word of two letters, the whole of it), the longest match winning, so
// `devops` sets up while `developer` builds
export const COSTUME_WORDS: Readonly<Record<Costume, readonly string[]>> = {
  reviewer: ['review', 'audit', 'critic', 'inspect', 'verif', 'check', 'lint', 'test', 'qa', 'detect', 'guard', 'sentinel', 'secur', 'judge'],
  designer: ['design', 'figma', 'ui', 'ux', 'style', 'css', 'brand', 'visual'],
  planner: ['plan', 'architect', 'strateg', 'roadmap', 'spec', 'scope'],
  explorer: ['explor', 'search', 'research', 'find', 'scout', 'investigat', 'analy', 'histor', 'discover', 'locat', 'browse', 'crawl', 'fetch'],
  scholar: ['guide', 'doc', 'readme', 'writ', 'teach', 'explain', 'tutor', 'help', 'learn', 'summar', 'translat'],
  mechanic: ['setup', 'config', 'install', 'deploy', 'devops', 'ops', 'infra', 'ci', 'docker', 'statusline', 'release', 'maint'],
  builder: ['implement', 'build', 'code', 'coder', 'dev', 'engineer', 'fix', 'refactor', 'migrat', 'program', 'creat', 'generat'],
  chef: ['cook', 'chef', 'general'],
  wizard: ['wizard', 'magic', 'oracle', 'claude'],
}
// A bare small crab, of a type no word dresses, takes the first of these no type holds yet,
// kept in the store for good
export const SPARE_AGENT_COLORS: readonly number[] = [
  0xff7b72, 0x56d4dd, 0xa5d65a, 0xdb61a2, 0x79c0ff, 0xd29922, 0xf0f6fc, 0x8b949e, 0x2ea043, 0x9e6a03,
]

const wordsOf = (type: string): string[] =>
  (type.split(':').pop() ?? type)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word !== '')

const costumeOfWord = (word: string): Costume | null => {
  let best: Costume | null = null
  let bestLength = 0
  for (const [costume, stems] of Object.entries(COSTUME_WORDS) as [Costume, readonly string[]][]) {
    for (const stem of stems) {
      const isMatch = stem.length <= 2 ? word === stem : word.startsWith(stem)
      if (isMatch && stem.length > bestLength) {
        best = costume
        bestLength = stem.length
      }
    }
  }
  return best
}

export const costumeOf = (type: string): Costume | null => {
  if (Object.hasOwn(AGENT_COSTUMES, type)) return AGENT_COSTUMES[type] ?? null
  for (const word of wordsOf(type).reverse()) {
    const costume = costumeOfWord(word)
    if (costume !== null) return costume
  }
  return null
}

const isColorRecord = (value: unknown): value is Record<string, number> =>
  typeof value === 'object' && value !== null && Object.values(value).every(color => typeof color === 'number')

const hashOf = (text: string): number => {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash
}

// A fork takes the crab's own color, any other type the one kept for it, else the first spare
// no type holds; once the spares run out, one picked by the name
export const pickAgentColor = (type: string, kept: Readonly<Record<string, number>>): number => {
  if (type === 'fork') return CLAUDE_COLOR
  const known = kept[type]
  if (known !== undefined) return known
  const taken = new Set(Object.values(kept))
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
let paintedSize = ''
let redrawAskedAt: number | null = null
// The band's room, and the agent whose transcript is in view above it, from the subagent
// list or `/tasks` (none: the main conversation's), known once it is drawn
let bandColumns = Number.POSITIVE_INFINITY
let bandRows = Number.POSITIVE_INFINITY
let viewedAgent: string | undefined

// The subagents' small crabs, in the order they started, dressed for their type's work or
// bare in its color. `isListed` once `$.agent.list()` showed the agent, whose leaving the
// list then ends it; a workflow's agents are never listed and end with their `turn.complete`
// alone
type CrewMember = AgentActivity & { color: number; costume: Costume | null; isListed: boolean }
const crew = new Map<string, CrewMember>()
let keptColors: Record<string, number> = {}

// How each agent the session ran is dressed, kept once its small crab has left, so its crab
// is dressed while its transcript is in view after it is done; `leftAt`, the frame it left
type Dress = { color: number; costume: Costume | null; leftAt: number | null }
const roster = new Map<string, Dress>()

// A new type's color is written at once, over what another session may have kept meanwhile
const colorOf = async ($: EngineInterface, type: string): Promise<number> => {
  if (type === 'fork' || keptColors[type] !== undefined) return pickAgentColor(type, keptColors)
  const stored = await $.store.get(AGENT_COLORS_KEY)
  if (isColorRecord(stored)) keptColors = { ...stored, ...keptColors }
  const color = pickAgentColor(type, keptColors)
  keptColors = { ...keptColors, [type]: color }
  await $.store.set(AGENT_COLORS_KEY, keptColors)
  return color
}

const enlist = async ($: EngineInterface, id: string, type: string, phase: MiniPhase, isListed: boolean): Promise<void> => {
  const costume = costumeOf(type)
  const color = costume === null ? await colorOf($, type) : CLAUDE_COLOR
  if (!roster.has(id)) roster.set(id, { color, costume, leftAt: null })
  if (!crew.has(id)) crew.set(id, { color, costume, phase, isThinking: false, since: frameTick, isListed })
}

// A small crab leaves the band; its agent stays dressed in the roster
const dismiss = (id: string): void => {
  crew.delete(id)
  const dress = roster.get(id)
  if (dress !== undefined && dress.leftAt === null) roster.set(id, { ...dress, leftAt: frameTick })
}

// An agent in view the band never drew, as one started before a reload, dressed from the
// list and the colors the store keeps, writing none: a drawing writes nothing
const learn = async ($: EngineInterface, agents: readonly AgentInfo[], id: string): Promise<void> => {
  const agent = agents.find(one => one.id === id)
  if (roster.has(id) || agent === undefined) return
  const costume = costumeOf(agent.type)
  if (costume === null && agent.type !== 'fork' && keptColors[agent.type] === undefined) {
    const stored = await $.store.get(AGENT_COLORS_KEY)
    if (isColorRecord(stored)) keptColors = { ...stored, ...keptColors }
  }
  const color = costume === null ? pickAgentColor(agent.type, keptColors) : CLAUDE_COLOR
  roster.set(id, { color, costume, leftAt: crew.has(id) ? null : frameTick })
}

// The crab of an agent in view: its small crab's mood while it has one, else at rest from
// when it left, then asleep, as a waiting one; an agent never seen goes bare in orange
const loneOf = (id: string): Mini => {
  const member = crew.get(id)
  if (member !== undefined) return { color: member.color, costume: member.costume, mood: agentMoodFor(member, frameTick) }
  const dress = roster.get(id)
  const rest: AgentActivity = { phase: 'waiting', isThinking: false, since: dress?.leftAt ?? frameTick }
  return { color: dress?.color ?? CLAUDE_COLOR, costume: dress?.costume ?? null, mood: agentMoodFor(rest, frameTick) }
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
  flights = [...flights, { agentId, color: flapColorOf(member), step: 0 }]
  flightTimer ??= $.clock.every(FLIGHT_MS, () => void fly($))
}

// An answer is the agent's report to the main loop: unless the agent just sent it itself, it
// flies over before the small crab cheers and leaves; an interrupted or failed agent just leaves
const finish = ($: EngineInterface, id: string, isAnswered: boolean): void => {
  const member = crew.get(id)
  if (member === undefined || member.phase === 'done') return
  if (!isAnswered) {
    dismiss(id)
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
    if (member.isListed && !listed.has(id) && member.phase !== 'done') dismiss(id)
  }
}

// A narrow band, as on a phone, takes the smaller crab, and draws the small crabs it has
// room for, counting the others
export const sceneOf = (mood: Scene['mood'], members: readonly CrewMember[], tick: number, columns: number): Scene => {
  const isCompact = columns < COMPACT_BELOW
  const shown = minisThatFit(members.length, columns, isCompact)
  return {
    mood,
    minis: members.slice(0, shown).map(member => ({ color: member.color, mood: agentMoodFor(member, tick), costume: member.costume })),
    hidden: members.length - shown,
    flights: [],
    isCompact,
  }
}

// A message whose sender's small crab has left is dropped with it; one from a small crab
// past the `shown` ones leaves from their count
export const flightsOf = (ids: readonly string[], inFlight: readonly InFlight[], shown: number): Flight[] =>
  inFlight.flatMap(flight => {
    const from = Math.min(ids.indexOf(flight.agentId), shown)
    return from < 0 ? [] : [{ from, color: flight.color, progress: flight.step / FLIGHT_STEPS }]
  })

const currentScene = (): Scene => {
  const scene = sceneOf(moodFor(activity, frameTick), [...crew.values()], frameTick, bandColumns)
  return { ...scene, flights: flightsOf([...crew.keys()], flights, scene.minis.length) }
}

// What the band draws: the crab and its crew; or, while an agent's transcript is in view,
// that agent's crab alone at the crab's own size, its outfit drawn at that size, or its
// small crab where the band lacks the rows for its hat
const drawBand = (): { columns: number; rows: number; cells: string } => {
  if (viewedAgent === undefined) return { ...drawScene(currentScene(), frameTick), rows: PERSONA_ROWS }
  const mini = loneOf(viewedAgent)
  return mini.costume !== null && bandRows < AGENT_ROWS ? drawLone(mini, frameTick) : drawAgent(mini, frameTick)
}

const animate = async ($: EngineInterface): Promise<void> => {
  frameTick++
  for (const [id, member] of crew) {
    if (member.phase === 'done' && frameTick - member.since >= CHEER_FRAMES) dismiss(id)
  }
  await paint($)
}

const paint = async ($: EngineInterface): Promise<void> => {
  const { columns, rows, cells } = drawBand()
  if (personaSite === null || cells === paintedCells) return
  // A crab more or fewer changes the size, which takes a redraw rather than a blit
  if (`${columns}x${rows}` !== paintedSize) {
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

  // A subagent's small crab appears as it starts, dressed for its type's work
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

  // The band above the prompt, empty unless a survey takes it; drawn on the right of the
  // room the engine leaves it beside its collapse mark. The crab is drawn in the terminal only.
  // A switch to an agent's transcript, or back, draws it again
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    // The crab takes the band, but the mods beneath still see it drawn: context-bar learns
    // the agent in view from it
    await next(e)
    const { Box, Raster } = $.ui.resolve(e)
    bandColumns = e.props.bodyColumns
    bandRows = e.props.maxRows
    viewedAgent = e.props.view?.agentId
    if (viewedAgent !== undefined && !roster.has(viewedAgent)) await learn($, await $.agent.list(), viewedAgent)
    const { columns, rows, cells } = drawBand()
    personaSite = e.requestId
    paintedCells = cells
    paintedSize = `${columns}x${rows}`
    redrawAskedAt = null
    return (
      <Box justifyContent="flex-end">
        <Raster key={PERSONA_KEY} columns={columns} rows={rows} cells={cells} />
      </Box>
    )
  })
}
