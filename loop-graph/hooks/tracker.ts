import type { AgentRun, Lane, NodeStat, Run, Usage, Wait } from '../types'

import { LOOP, NODE_BY_ID, findEdge } from './graph'
import { agentOutcome, isAskingBack, runnerOutcome } from './outcome'

export const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const EMPTY_RUN: Run = {
  updatedAt: 0,
  lane: 'unknown',
  isDone: false,
  isMainBusy: false,
  nodes: {},
  edges: {},
  unexpected: [],
  agents: {},
  log: [],
  mainTokens: ZERO,
}

export const total = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite

// Cost-equivalent weights: cache read costs a tenth of a
// fresh input token, a cache write 1.25, an output token five.
export const costEq = (u: Usage) => Math.round(u.input + 1.25 * u.cacheWrite + 0.1 * u.cacheRead + 5 * u.output)

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

const stat = (r: Run, id: string): NodeStat => r.nodes[id] ?? { visits: 0, totalMs: 0, tokens: ZERO }

export const isLive = (r: Run) => r.lane !== 'unknown' || r.current !== undefined

export function log(r: Run, now: number, text: string): Run {
  return { ...r, updatedAt: now, log: [...r.log, { at: now, text }].slice(-40) }
}

// Only ever started from a tool call, so inside a turn of the session.
export function freshRun(now: number, lane: Lane, task?: string): Run {
  return { ...EMPTY_RUN, task: task || undefined, startedAt: now, updatedAt: now, lane, isMainBusy: true }
}

// Moves the main loop to `to`, recording the arc taken. A jump with no arc in
// the map is kept as an unexpected one, which the graph draws in red.
export function goTo(r: Run, to: string, now: number, why: string, isRepeat = false): Run {
  const from = r.current
  if (from === to && !isRepeat) return r

  const edge = from === undefined ? undefined : findEdge(from, to, r.lane)
  const nodes = { ...r.nodes }
  if (from !== undefined && from !== to) {
    const left = stat(r, from)
    nodes[from] = {
      ...left,
      totalMs: left.totalMs + (left.activeSince === undefined ? 0 : now - left.activeSince),
      activeSince: undefined,
      leftAt: now,
      leftBy: edge?.label ?? `unexpected jump to ${label(to)}`,
    }
  }
  const entered = stat({ ...r, nodes }, to)
  nodes[to] = {
    ...entered,
    visits: entered.visits + 1,
    activeSince: from === to ? entered.activeSince ?? now : now,
    enteredAt: from === to ? entered.enteredAt : now,
    via: from === to ? entered.via : edge?.label ?? (from === undefined ? why : `unexpected jump from ${label(from)}`),
  }

  let edges = r.edges
  let unexpected = r.unexpected
  if (from !== undefined) {
    if (edge !== undefined) {
      edges = { ...edges, [edge.id]: (edges[edge.id] ?? 0) + 1 }
    } else if (from !== to) {
      const known = unexpected.find(j => j.from === from && j.to === to)
      unexpected = known
        ? unexpected.map(j => (j === known ? { ...j, count: j.count + 1 } : j))
        : [...unexpected, { from, to, count: 1 }]
    }
  }

  const arrival = from === to ? r.arrival : { from, to, at: now }
  const moved: Run = { ...r, current: to, nodes, edges, unexpected, pause: undefined, pausedAt: undefined, wait: undefined, arrival }

  const text = from === undefined ? `${label(to)} started` : `${label(from)} → ${label(to)}${edge?.label ? ` · ${edge.label}` : ''}`

  return log(moved, now, edge === undefined && from !== undefined && from !== to ? `${text} · unexpected` : text)
}

function closeNode(r: Run, id: string, now: number): Run {
  const s = stat(r, id)
  if (s.activeSince === undefined) return r

  return { ...r, nodes: { ...r.nodes, [id]: { ...s, totalMs: s.totalMs + now - s.activeSince, activeSince: undefined } } }
}

const label = (id: string) => NODE_BY_ID[id]?.label ?? id

export function noteNode(r: Run, id: string, note: string): Run {
  return { ...r, nodes: { ...r.nodes, [id]: { ...stat(r, id), note } } }
}

export function addNodeTokens(r: Run, id: string, u: Usage): Run {
  const s = stat(r, id)

  return { ...r, nodes: { ...r.nodes, [id]: { ...s, tokens: addUsage(s.tokens, u) } } }
}

// The loop says where it is: every step opens with `node
// .claude/loop-graph/loop-step.mjs <step>`, and nothing else moves the run.
// A step is named by its id in the map.
export function nodeOfStep(step: string): string | undefined {
  return NODE_BY_ID[step] === undefined ? undefined : step
}

// A marker counts only as a command of its own: `node <path>loop-step.mjs
// <step>`, alone or chained. Text that names one, in a commit message, a
// heredoc or a quoted string, moves nothing.
const MARKER = /^\(*\s*node\s+\S*loop-step\.mjs\s+(\S+)(.*)$/

// The commands of a shell script: split on ; & | and line ends outside
// quotes, with heredoc bodies left out.
export function commandsOf(script: string): string[] {
  const out: string[] = []
  const tags: string[] = []
  let cur = ''
  let quote: string | undefined
  const push = () => {
    if (cur.trim() !== '') out.push(cur.trim())
    cur = ''
  }
  for (let i = 0; i < script.length; i++) {
    const c = script[i] ?? ''
    if (quote !== undefined) {
      cur += c
      if (c === quote && (quote === "'" || script[i - 1] !== '\\')) quote = undefined
      continue
    }
    const heredoc = c === '<' ? script.slice(i).match(/^<<-?\s*(['"]?)(\w+)\1/) : null
    if (heredoc !== null) {
      tags.push(heredoc[2] ?? '')
      cur += heredoc[0]
      i += heredoc[0].length - 1
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '\n') {
      push()
      for (const tag of tags.splice(0)) {
        while (i < script.length) {
          const end = script.indexOf('\n', i + 1)
          const line = script.slice(i + 1, end === -1 ? script.length : end)
          i = end === -1 ? script.length : end
          if (line.trim() === tag) break
        }
      }
    } else if (c === ';' || c === '&' || c === '|') {
      push()
    } else {
      cur += c
    }
  }
  push()

  return out
}
const arg = (rest: string, key: string) =>
  rest.match(new RegExp(`--${key}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`))?.slice(1).find(v => v !== undefined)

export function marker(r: Run, cmd: string, now: number): Run {
  const m = cmd.match(MARKER)
  if (m === null) return r
  const rest = m[2] ?? ''
  const to = nodeOfStep(m[1] ?? '')
  if (to === undefined) return r
  const task = arg(rest, 'task')
  const note = arg(rest, 'note')
  const slice = arg(rest, 'slice')?.match(/^(\d+)\/(\d+)$/)
  const n = NODE_BY_ID[to]

  // A step that opens runs opens a new one, unless the run under way leads
  // into it by an arc of the map: a lane picked, a run moved to a fuller loop.
  // The step under way announced again (a resume, a lane picked) goes on with
  // the same run, unless it names another task.
  const isOn = isLive(r) && !r.isDone && r.current !== undefined
  const isLed = isOn && r.current !== undefined && findEdge(r.current, to, r.lane) !== undefined
  const isSame = isOn && r.current === to && (task === undefined || task === r.task)
  const base = n?.isOpening === true && !isLed && !isSame ? freshRun(now, 'unknown', task) : { ...r, task: r.task ?? task }
  // `--lane` picks the lane; a step on one lane alone picks it too, and moves
  // the run to its lane when it was on another.
  const only = n?.lanes?.length === 1 ? n.lanes[0] : undefined
  const isOffLane = base.lane === 'unknown' || (n?.lanes !== undefined && !n.lanes.includes(base.lane))
  const lane: Lane = arg(rest, 'lane') ?? (isOffLane && only !== undefined ? only : base.lane)
  const laned = { ...base, lane }

  // The same marker again: a resume after a pause, or the step met anew.
  if (laned.current === to && laned.pause !== undefined) {
    const s = stat(laned, to)
    const resumed = { ...laned, pause: undefined, pausedAt: undefined, nodes: { ...laned.nodes, [to]: { ...s, activeSince: now } } }

    return log(note === undefined ? resumed : noteNode(resumed, to, note), now, `back at ${label(to)}`)
  }
  const sliced = withSlice(goTo(laned, to, now, note ?? to, true), to, slice)
  // A step that went by slices, announced again without one: a fix pass.
  const wasSliced = laned.nodes[to]?.slice !== undefined
  const moved = wasSliced || slice != null
    ? { ...sliced, nodes: { ...sliced.nodes, [to]: { ...stat(sliced, to), isFixPass: slice == null } } }
    : sliced

  return note === undefined ? moved : noteNode(moved, to, note)
}

// Slice K of N opens with K - 1 green; a fix pass announces no slice and keeps
// the count.
function withSlice(r: Run, id: string, m: RegExpMatchArray | null | undefined): Run {
  const at = Number(m?.[1])
  const of = Number(m?.[2])
  if (!(at >= 1 && of >= at)) return r
  const s = stat(r, id)

  return { ...r, nodes: { ...r.nodes, [id]: { ...s, slice: { at, of, green: Math.max(s.slice?.of === of ? s.slice.green : 0, at - 1) } } } }
}

// An agent works on the step the loop has announced.
const nodeForAgent = (r: Run) => r.current

export function startAgent(r: Run, a: { id: string; type: string; description: string; model?: string }, now: number): Run {
  const node = nodeForAgent(r)
  const withVisit = node === undefined || node === r.current ? r : {
    ...r,
    nodes: { ...r.nodes, [node]: { ...stat(r, node), visits: stat(r, node).visits + 1, enteredAt: now, via: 'beside the slices' } },
  }
  const s = node === undefined ? undefined : withVisit.nodes[node]
  const agent: AgentRun = {
    id: a.id,
    type: a.type,
    description: a.description,
    model: a.model,
    node,
    slice: s?.slice !== undefined && s.isFixPass !== true ? s.slice.at : undefined,
    isFixPass: s?.slice !== undefined ? s.isFixPass === true : undefined,
    startedAt: now,
    activeSince: now,
    totalMs: 0,
    steps: 0,
    tokens: ZERO,
    status: 'running',
  }

  return log({ ...withVisit, agents: { ...withVisit.agents, [a.id]: agent } }, now, `${a.description || a.type} started`)
}

// An agent's contract line: one of the map's outcome lines, else a line that
// opens on a word in capitals and a colon (`VERDICT: ACCEPT`).
const CONTRACT = /^[A-Z][A-Z0-9_-]+:.*$/m
const contractOf = (message: string | undefined) => {
  const lines = message?.split('\n') ?? []

  return LOOP.outcomes.map(o => lines.find(l => new RegExp(o.match).test(l))).find(l => l !== undefined) ?? message?.match(CONTRACT)?.[0]
}

export function handBack(r: Run, id: string, report: string): Run {
  const a = r.agents[id]

  return a === undefined ? r : { ...r, agents: { ...r.agents, [id]: { ...a, report } } }
}

export function stopAgent(r: Run, id: string, last: string | undefined, now: number): Run {
  const a = r.agents[id]
  if (a === undefined) return r
  const lastMessage = a.report ?? last

  const contract = contractOf(lastMessage)?.slice(0, 160)
  const isAsking = isAskingBack(a.type, lastMessage)
  const done: AgentRun = {
    ...a,
    status: isAsking ? 'waiting' : 'done',
    activeSince: undefined,
    totalMs: a.totalMs + (a.activeSince === undefined ? 0 : now - a.activeSince),
    contract: contract ?? a.contract,
    outcome: agentOutcome(a.type, lastMessage) ?? a.outcome,
    wait: isAsking ? { why: 'answers', since: now } : undefined,
    report: undefined,
  }
  const commands = isAsking ? r.commands : Object.fromEntries(Object.entries(r.commands ?? {}).filter(([, c]) => c.who !== id))
  const next = log({ ...r, agents: { ...r.agents, [id]: done }, commands }, now, isAsking
    ? `${a.description || a.type} asks questions`
    : `${a.description || a.type} finished${contract ? ` · ${contract.slice(0, 60)}` : ''}`)

  const noted = contract && a.node !== undefined ? noteNode(next, a.node, contract) : next
  const s = a.node === undefined ? undefined : noted.nodes[a.node]
  const outcome = done.outcome
  if (s?.slice === undefined || a.node === undefined || a.slice === undefined || outcome === undefined || outcome.isBad === true) return noted

  return { ...noted, nodes: { ...noted.nodes, [a.node]: { ...s, slice: { ...s.slice, green: Math.max(s.slice.green, a.slice) } } } }
}

export function resumeAgent(r: Run, to: string, now: number): Run {
  const a = Object.values(r.agents).find(x => x.id === to || x.description === to || x.type === to)
  if (a === undefined) return r

  const running: AgentRun = { ...a, status: 'running', activeSince: a.activeSince ?? now, wait: undefined }

  return log({ ...r, agents: { ...r.agents, [a.id]: running } }, now, `message sent to ${a.type}`)
}

// A request's prompt is its whole input side: uncached, cache-read and
// cache-written together, as the status line counts the session's context.
export const promptOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite

// A request after the first that rereads under a fifth of its prompt from the
// cache and writes most of it again found the cache cold: it pays 1.25 for
// what a warm one rereads at 0.1.
export const isCold = (u: Usage) => promptOf(u) > 0 && u.cacheRead < 0.2 * promptOf(u) && u.cacheWrite > 0.5 * promptOf(u)

export const SESSION = 'session'

function addCold(r: Run, id: string, u: Usage, who: string, gapMs: number): Run {
  const s = stat(r, id)
  const was = s.cold?.by[who]
  const cold = {
    count: (s.cold?.count ?? 0) + 1,
    extra: (s.cold?.extra ?? 0) + Math.round(1.15 * u.cacheWrite),
    by: { ...s.cold?.by, [who]: { count: (was?.count ?? 0) + 1, gapMs: Math.max(was?.gapMs ?? 0, gapMs) } },
  }

  return { ...r, nodes: { ...r.nodes, [id]: { ...s, cold } } }
}

export function agentStep(r: Run, id: string, u: Usage, model: string | undefined, window?: number, now?: number): Run {
  const a = r.agents[id]
  if (a === undefined) return r

  const context = promptOf(u)
  const compacted = a.context !== undefined && context < a.context * 0.6
  const next: AgentRun = {
    ...a,
    steps: a.steps + 1,
    tokens: addUsage(a.tokens, u),
    model: model ?? a.model,
    context,
    peakContext: Math.max(a.peakContext ?? 0, context),
    compactions: (a.compactions ?? 0) + (compacted ? 1 : 0),
    lastAt: now ?? a.lastAt,
    silentSince: undefined,
  }
  const withAgent = { ...r, window: window ?? r.window, agents: { ...r.agents, [id]: next } }
  if (a.node === undefined) return withAgent
  const counted = addNodeTokens(withAgent, a.node, u)

  const gapMs = now !== undefined && a.lastAt !== undefined ? now - a.lastAt : 0

  return a.steps > 0 && isCold(u) ? addCold(counted, a.node, u, id, gapMs) : counted
}

// While the run is paused the session is not working on the loop: a chat
// about something else is not the step's cost.
export function mainStep(r: Run, u: Usage, window?: number, now?: number, model?: string): Run {
  if (!isLive(r) || r.isDone) return r
  // Paused, its requests still keep the cache warm: only the gap is kept.
  if (r.pause !== undefined) return now === undefined ? r : { ...r, mainAt: now }
  const withMain = {
    ...r, window: window ?? r.window, mainModel: model ?? r.mainModel, mainContext: promptOf(u), mainTokens: addUsage(r.mainTokens, u), mainAt: now ?? r.mainAt,
  }
  if (r.current === undefined) return withMain
  const counted = addNodeTokens(withMain, r.current, u)
  const gapMs = now !== undefined && r.mainAt !== undefined ? now - r.mainAt : 0

  return r.mainContext !== undefined && isCold(u) ? addCold(counted, r.current, u, SESSION, gapMs) : counted
}

// The main loop's own tool calls: a Bash call carrying a step marker, alone or
// chained (`node .claude/loop-graph/loop-step.mjs build && npm test`), and a message
// that wakes an agent.
export function mainToolCall(r: Run, tool: string, input: Record<string, unknown>, now: number): Run {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (tool === 'Bash') return commandsOf(str('command')).reduce((acc, part) => marker(acc, part, now), r)
  if (tool === 'SendMessage' && isLive(r) && !r.isDone) return resumeAgent(r, str('to'), now)

  return r
}

// A command shorter than this never draws: a grep would only flash.
export const COMMAND_SHOWN_MS = 3000

// A command starts at the step its runner works on: the session's open step,
// or the agent's. Background commands left behind by an ended agent or an
// earlier step go as a new one starts.
export function commandStarted(r: Run, c: { id: string; who?: string; text: string; isBg: boolean }, now: number): Run {
  if (!isLive(r) || r.isDone) return r
  const node = c.who === undefined ? r.current : r.agents[c.who]?.node
  if (node === undefined) return r
  const kept = Object.values(r.commands ?? {}).filter(k => (k.who === undefined ? k.node === r.current : r.agents[k.who]?.status !== 'done'))

  return { ...r, commands: { ...Object.fromEntries(kept.map(k => [k.id, k])), [c.id]: { ...c, node, since: now } } }
}

// A background command's call returns at once while the command runs on: it
// stays, its end unseen.
export function commandEnded(r: Run, id: string): Run {
  const c = r.commands?.[id]
  if (c === undefined || c.isBg) return r
  const { [id]: _, ...rest } = r.commands ?? {}

  return { ...r, commands: rest }
}

export function revealCommands(r: Run, now: number): Run {
  const due = Object.values(r.commands ?? {}).filter(c => c.isShown !== true && now - c.since >= COMMAND_SHOWN_MS)
  if (due.length === 0) return r

  return { ...r, commands: { ...r.commands, ...Object.fromEntries(due.map(c => [c.id, { ...c, isShown: true }])) } }
}

// A runner's summary in the output of a command the session ran itself is
// what its open step came to so far.
export function mainToolResult(r: Run, tool: string, output: unknown): Run {
  if (tool !== 'Bash' || !isLive(r) || r.isDone || r.current === undefined) return r
  const o = output as { stdout?: unknown; stderr?: unknown } | undefined
  const outcome = runnerOutcome(`${typeof o?.stdout === 'string' ? o.stdout : ''}\n${typeof o?.stderr === 'string' ? o.stderr : ''}`)

  return outcome === undefined ? r
    : { ...r, nodes: { ...r.nodes, [r.current]: { ...stat(r, r.current), outcome: outcome.text, outcomeBad: outcome.isBad === true } } }
}

// Waits: the session's own (`who` undefined) or an agent's. A permission
// prompt ends with the call it guarded; a question with its answer.
export function waitFor(r: Run, who: string | undefined, wait: Wait): Run {
  if (!isLive(r) || r.isDone) return r
  if (who === undefined) return { ...r, wait }
  const a = r.agents[who]

  return a === undefined ? r : { ...r, agents: { ...r.agents, [who]: { ...a, wait } } }
}

export function waitOver(r: Run, who: string | undefined, why: Wait['why']): Run {
  if (who === undefined) return r.wait?.why === why ? { ...r, wait: undefined } : r
  const a = r.agents[who]

  return a?.wait?.why === why ? { ...r, agents: { ...r.agents, [who]: { ...a, wait: undefined } } } : r
}

// An agent at work with no request for this long may be stuck. Checked once a
// minute: the run changes only when an agent goes silent.
export const STALL_MS = 5 * 60_000

export function markSilent(r: Run, now: number): Run {
  const silent = Object.values(r.agents).filter(a => a.status === 'running' && a.wait === undefined
    && a.silentSince === undefined && now - (a.lastAt ?? a.startedAt) >= STALL_MS)
  if (silent.length === 0) return r

  return { ...r, agents: { ...r.agents, ...Object.fromEntries(silent.map(a => [a.id, { ...a, silentSince: a.lastAt ?? a.startedAt }])) } }
}

export const hasRunningAgents = (r: Run) => Object.values(r.agents).some(a => a.status === 'running')

const isEnd = (id: string) => NODE_BY_ID[id]?.kind === 'end'

const finish = (r: Run, at: number): Run =>
  r.current === undefined ? r : log({ ...closeNode(r, r.current, at), isDone: true, updatedAt: at }, at, 'run finished')

// The turn that reaches the last step ends the run, however it ends. Any other
// end with nothing running pauses the step until the loop announces a step
// again; a new turn alone never resumes it, since it may be about something else.
export function turnDone(r: Run, now: number, isAborted: boolean): Run {
  const idle = { ...r, isMainBusy: false, updatedAt: now }
  if (idle.isDone || idle.current === undefined || hasRunningAgents(idle)) return idle
  if (isEnd(idle.current)) return finish(idle, now)
  if (idle.pause !== undefined) return idle
  // At a gate, or with an agent's questions open, the turn ends on you.
  const isOnYou = NODE_BY_ID[idle.current]?.kind === 'human' || Object.values(idle.agents).some(a => a.status === 'waiting')
  if (!isAborted && isOnYou) {
    return idle.wait?.why === 'reply' ? idle : log({ ...idle, wait: { why: 'reply', since: now } }, now, `waiting for you at ${label(idle.current)}`)
  }

  const paused = { ...closeNode(idle, idle.current, now), pause: isAborted ? 'stopped' as const : 'idle' as const, pausedAt: now }

  return log(paused, now, isAborted ? `stopped by you at ${label(idle.current)}` : `session idle at ${label(idle.current)}`)
}

// A turn that starts while the last step is still open missed its end: the
// run ended with the last thing it did.
export const turnStarted = (r: Run): Run =>
  !r.isDone && r.current !== undefined && isEnd(r.current) && !hasRunningAgents(r)
    ? { ...finish(r, r.updatedAt), isMainBusy: true }
    : { ...waitOver(r, undefined, 'reply'), isMainBusy: true }
