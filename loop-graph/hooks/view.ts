import type { AgentRun, Level, LiveClock, Run, RunCommand, StepState, View, ViewAlert, ViewAgent, ViewCommand, ViewFact, ViewNow, ViewStep, ViewSub, Wait } from '../types'

import { EDGES, LOOP, NODES, NODE_BY_ID, findEdge, isReachable, laneLabel } from './graph'
import type { GNode } from './graph'
import { agentsAt, fmtDur, fmtTok, mapSvg, nodeMs, nodeState, nodeTokens } from './svg'
import { SESSION, costEq, isLive } from './tracker'

const MARK = { active: '▶', waiting: '◷', paused: '‖', visited: '✓', idle: '·', off: ' ' } as const

const two = (n: number) => String(n).padStart(2, '0')
export const clockTime = (ms: number) => {
  const d = new Date(ms)

  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

const runTokens = (r: Run) => costEq(r.mainTokens) + Object.values(r.agents).reduce((n, a) => n + costEq(a.tokens), 0)
const model = (m?: string) => (m ? ` · ${m.replace(/^claude-/, '')}` : '')

const windowText = (w: number) => (w >= 1e6 ? `${+(w / 1e6).toFixed(1)}M` : `${Math.round(w / 1000)}k`)

// Context windows by model, from Anthropic's model table. A model not listed
// shows its count alone: a guessed window would give a wrong share.
const WINDOWS: Record<string, number> = {
  'claude-fable-5-1': 1_000_000, 'claude-fable-5': 1_000_000, 'claude-mythos-5-1': 1_000_000,
  'claude-opus-5-5': 1_000_000, 'claude-opus-5': 1_000_000, 'claude-opus-4-8': 1_000_000, 'claude-opus-4-7': 1_000_000, 'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5-5': 1_000_000, 'claude-sonnet-5': 1_000_000, 'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-5-5': 1_000_000, 'claude-haiku-4-5': 200_000,
}

// The window an agent's context fills: the session's own when it runs the
// session's model (that one is live, settings included), else its model's.
export function windowOf(r: Run, m: string | undefined): number | undefined {
  if (m === undefined || m === r.mainModel) return r.window

  return WINDOWS[m.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')]
}

const shareOf = (tokens: number, w: number | undefined) => (w === undefined || w <= 0 ? undefined
  : `${Math.round((tokens / w) * 100)}% of ${windowText(w)}`)

// The session's share beside the count it is made of.
function contextText(r: Run, tokens: number): string {
  const share = shareOf(tokens, r.window)

  return share === undefined ? `${fmtTok(tokens)} context` : `${share} · ${fmtTok(tokens)}`
}

// An agent's share of its window alone: beside it, what it spent counts live.
const shareText = (r: Run, a: AgentRun, tokens: number) => shareOf(tokens, windowOf(r, a.model)) ?? `${fmtTok(tokens)} · window unknown`

// The largest share an agent used, kept once it ends.
const peakShare = (r: Run, a: AgentRun) => (a.peakContext === undefined ? undefined : `peak ${shareText(r, a, a.peakContext)}`)

const peakLine = (r: Run, a: AgentRun) => (a.peakContext === undefined ? ''
  : ` · ${peakShare(r, a)}${(a.compactions ?? 0) > 0 ? ` · compacted ${a.compactions}×` : ''}`)

// How far the step is, only where the loop or its agents say so: the slice
// the implement step announced, or the agents it sent at once. Any other step
// gets no figure: a guess from the clock would only be a timer.
export function progressOf(r: Run, id: string): string | undefined {
  const s = r.nodes[id]
  if (s?.slice !== undefined) {
    const { at, of, green } = s.slice

    return `Slice ${at} of ${of} · ${green} green · ${Math.round((green / of) * 100)}%`
  }
  const sent = agentsAt(r, id).filter(a => a.startedAt >= (s?.enteredAt ?? 0))
  if (sent.length < 2) return undefined
  const done = sent.filter(a => a.status === 'done').length

  return `${done} of ${sent.length} agents finished · ${Math.round((done / sent.length) * 100)}%`
}

// Several agents at one step reporting the same kind of line, figures apart
// (`0 critical · 1 high`): their figures added up.
function sumOf(agents: AgentRun[]): string | undefined {
  const texts = agents.map(a => a.outcome?.text ?? '')
  const shape = (t: string) => t.replace(/\d+/g, '#')
  if (texts.length < 2 || !/\d/.test(texts[0] ?? '') || texts.some(t => shape(t) !== shape(texts[0] ?? ''))) return undefined
  const sums = texts.map(t => (t.match(/\d+/g) ?? []).map(Number)).reduce((acc, ns) => acc.map((v, i) => v + (ns[i] ?? 0)))
  let i = 0
  const who = agents.every(a => a.type.endsWith('-reviewer')) ? 'reviews' : 'agents'

  return `${texts.length} ${who} · ${(texts[0] ?? '').replace(/\d+/g, () => String(sums[i++] ?? 0))}`
}

// What a step came to, only from what the loop reported: the agents'
// contract lines (reviews added up), the slices that came back green, a
// runner's summary, the arc a gate was left by, the lane triage picked.
export function outcomeOf(r: Run, n: GNode): string | undefined {
  const s = r.nodes[n.id]
  const here = agentsAt(r, n.id).filter(a => a.outcome !== undefined)
  const summed = sumOf(here.filter(a => a.slice === undefined && a.isFixPass === undefined))
  if (summed !== undefined) return summed
  const last = here[here.length - 1]?.outcome?.text
  if (s?.slice !== undefined && last !== undefined) return `${s.slice.green}/${s.slice.of} slices green · ${last.replace(/^(green|red) · /, '')}`
  if (last !== undefined) return last
  if (s?.outcome !== undefined) return s.outcome
  if (s?.leftAt === undefined) return undefined
  if (n.kind === 'human') return s.leftBy
  if (n.kind === 'switch' && r.lane !== 'unknown') return laneLabel(r.lane)

  return undefined
}

const waitText = (w: Wait, who?: string) => ({
  question: 'a question is open in the chat',
  permission: `${who === undefined ? '' : `${who} asks `}permission for ${w.tool ?? 'a tool'}`,
  reply: 'your reply in the chat moves it on',
  answers: `${who ?? 'the agent'} waits for answers`,
})[w.why]

// The step held up on you, and why, when anything at it waits: the session
// first, then an agent's permission prompt, then a gate.
function waitAt(r: Run, n: GNode): { text: string; since: number; isOnYou: boolean } | undefined {
  const here = agentsAt(r, n.id)
  const asking = here.find(a => a.wait?.why === 'permission')
  if (asking?.wait !== undefined) return { text: waitText(asking.wait, asking.description || asking.type), since: asking.wait.since, isOnYou: true }
  if (r.current !== n.id || r.isDone || r.pause !== undefined) return undefined
  if (r.wait !== undefined) return { text: waitText(r.wait), since: r.wait.since, isOnYou: true }
  const answers = here.find(a => a.status === 'waiting')
  if (answers?.wait !== undefined) return { text: waitText(answers.wait, answers.description || answers.type), since: answers.wait.since, isOnYou: false }
  if (n.kind === 'human') return { text: 'your decision', since: r.nodes[n.id]?.activeSince ?? 0, isOnYou: true }

  return undefined
}

// A sliced step's agents, in the order sent: each slice, and each fix pass,
// with its own time and tokens once it ends.
// A slice as the loop announced it, else as the agent was named; a fix pass
// only when the loop announced one.
function subLabel(a: AgentRun): string {
  const slice = a.slice ?? Number(a.description.match(/\bslice (\d+)\b/i)?.[1] ?? NaN)
  if (slice >= 1) return `Slice ${slice}`

  return a.isFixPass === true ? 'Fix pass' : 'Implementer'
}
// Built-in agent types that say nothing of the work.
const GENERIC = new Set(['general-purpose', 'claude', 'fork', 'Explore', 'Plan'])
const roleName = (type: string) => (type.endsWith('-reviewer') ? reviewerName(type) : `${type[0]?.toUpperCase()}${type.slice(1).replace(/-/g, ' ')}`)
// A reviewer by its role: `database-reviewer` is Database review.
function reviewerName(type: string): string {
  const role = type.replace(/-reviewer$/, '').replace(/-/g, ' ')

  return `${role[0]?.toUpperCase()}${role.slice(1)} review`
}
// An agent by the name the pane gives it: its slice at a sliced step, a
// reviewer by its role.
const isSliced = (a: AgentRun) => a.slice !== undefined || a.isFixPass !== undefined
const agentName = (a: AgentRun) => (isSliced(a) ? subLabel(a)
  : a.type.endsWith('-reviewer') ? reviewerName(a.type) : a.description || a.type)

// The steps that may send several agents list each under them: those the map
// marks, and any that sent more than one.
const isMultiAt = (r: Run, id: string) => NODE_BY_ID[id]?.isMulti === true || agentsAt(r, id).length > 1
// Agents sent within this long of the one before went out together: one
// reviewer round, or the two evaluators of a panel.
const BATCH_MS = 30_000

function batchesOf(sent: AgentRun[]): AgentRun[][] {
  const out: AgentRun[][] = []
  for (const a of sent) {
    const last = out[out.length - 1]
    const prev = last?.[last.length - 1]
    if (last !== undefined && prev !== undefined && a.startedAt - prev.startedAt <= BATCH_MS) last.push(a)
    else out.push([a])
  }

  return out
}

function subName(a: AgentRun, batch: AgentRun[], round: number): string {
  if (isSliced(a)) return subLabel(a)
  const same = batch.filter(b => b.type === a.type)
  const member = same.length > 1 ? ` · member ${same.indexOf(a) + 1}` : ''
  // Panel members of one kind are named by their kind.
  const name = same.length > 1 && !GENERIC.has(a.type) ? roleName(a.type) : agentName(a)

  return `${name}${member}${round > 0 ? ` · round ${round + 1}` : ''}`
}

// The commands that have run long enough to show, oldest first.
const shownCommands = (r: Run) => Object.values(r.commands ?? {}).filter(c => c.isShown === true).sort((a, b) => a.since - b.since)
function commandView(r: Run, c: RunCommand): ViewCommand {
  const a = c.who === undefined ? undefined : r.agents[c.who]

  return { id: c.id, who: a === undefined ? 'This session' : agentName(a), text: c.text, since: c.since, isBg: c.isBg }
}

// Who reread under a fifth of its prompt from the cache, each with its longest
// idle gap before one: the session's own breaks count at the step it was on.
function coldBy(r: Run, by: Record<string, { count: number; gapMs: number }>): string {
  return Object.entries(by).map(([who, c]) => {
    const a = r.agents[who]
    const name = who === SESSION ? 'the session' : a !== undefined ? agentName(a) : who

    return c.count > 1 ? `${name} ${c.count}× up to ${fmtDur(c.gapMs)} idle` : `${name} after ${fmtDur(c.gapMs)} idle`
  }).join(', ')
}

// The context share past which an agent is worth a look, then to act on.
const CONTEXT_WATCH = 0.8
const CONTEXT_ACT = 0.9
const contextLevel = (tokens: number | undefined, window: number | undefined): Level | undefined => {
  if (tokens === undefined || window === undefined || window <= 0) return undefined
  const share = tokens / window

  return share >= CONTEXT_ACT ? 'act' : share >= CONTEXT_WATCH ? 'watch' : undefined
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`
// The ways back to an earlier step, by the step they lead back to.
const backArcs = () => EDGES.filter(e => e.isBack && e.from !== e.to).reduce<Record<string, string[]>>(
  (by, e) => ({ ...by, [e.to]: [...(by[e.to] ?? []), e.id] }), {})
const edgeLabel = (id: string) => EDGES.find(e => e.id === id)?.label || id

// What needs a look, read only from what the loop and its agents reported,
// the most serious first. Its words hold still while a step runs: a share of
// context says the threshold it passed, never the moving figure.
export function alertsOf(r: Run): ViewAlert[] {
  if (!isLive(r)) return []
  const at = (id: string) => NODE_BY_ID[id]?.label ?? id
  const act: ViewAlert[] = []
  const watch: ViewAlert[] = []
  const agents = Object.values(r.agents).sort((a, b) => a.startedAt - b.startedAt)

  // The latest done agent of each slice or kind at each step says how it stands.
  const latest = new Map<string, AgentRun>()
  for (const a of agents) if (a.status === 'done' && a.node !== undefined) latest.set(`${a.node}|${a.slice ?? a.type}`, a)
  for (const a of latest.values()) {
    if (a.outcome?.isBad !== true || a.node === undefined) continue
    const what = `${agentName(a)} came back ${a.outcome.text}`
    act.push({ level: 'act', what, why: 'The change cannot go on as it is', where: at(a.node), node: a.node, agent: a.id })
  }
  for (const [id, s] of Object.entries(r.nodes)) {
    if (s.outcomeBad === true && s.outcome !== undefined) {
      act.push({ level: 'act', what: `${s.outcome[0]?.toUpperCase()}${s.outcome.slice(1)}`, why: 'The last run of the checks at this step', where: at(id), node: id })
    }
  }
  for (const a of agents) {
    if ((a.compactions ?? 0) > 0 && a.node !== undefined) {
      act.push({ level: 'act', what: `${agentName(a)} was compacted`, why: 'Its agent lost part of its context: check its result against the plan', where: at(a.node), node: a.node, agent: a.id })
    }
  }
  // Past its cap, a step met again and again: fix passes keep coming back.
  const capped = new Set<string>()
  for (const n of NODES) {
    const visits = r.nodes[n.id]?.visits ?? 0
    if (n.maxVisits === undefined || visits <= n.maxVisits) continue
    capped.add(n.id)
    act.push({ level: 'act', what: `${ordinal(visits)} visit to ${n.label}, past the cap of ${n.maxVisits}`, why: 'Fix passes keep coming back: the plan may be wrong', where: at(n.id), node: n.id })
  }
  const contexts = [
    ...agents.filter(a => a.status === 'running').map(a => ({ name: agentName(a), tokens: a.context, window: windowOf(r, a.model), node: a.node ?? r.current, agent: a.id })),
    { name: 'This session', tokens: r.isDone ? undefined : r.mainContext, window: r.window, node: r.current, agent: undefined },
  ]
  for (const c of contexts) {
    const level = contextLevel(c.tokens, c.window)
    if (level === undefined || c.node === undefined) continue
    const alert = { level, node: c.node, where: at(c.node), agent: c.agent }
    if (level === 'act') act.push({ ...alert, what: `${c.name} is past ${CONTEXT_ACT * 100}% of its context`, why: 'It is about to compact and lose detail' })
    else watch.push({ ...alert, what: `${c.name} is past ${CONTEXT_WATCH * 100}% of its context`, why: 'It will compact if it reaches the limit' })
  }
  for (const a of agents) {
    if (a.status === 'running' && a.silentSince !== undefined && a.node !== undefined) {
      watch.push({ level: 'watch', what: `${agentName(a)} silent since ${clockTime(a.silentSince)}`, why: 'No request since then: it may be stuck', where: at(a.node), node: a.node, agent: a.id })
    }
  }
  for (const [to, ids] of Object.entries(backArcs())) {
    const taken = ids.filter(id => (r.edges[id] ?? 0) > 0)
    const times = taken.reduce((n, id) => n + (r.edges[id] ?? 0), 0)
    // A step past its cap that sends runs back here already says it.
    if (times < 2 || EDGES.some(e => e.isBack && e.to === to && capped.has(e.from))) continue
    const by = taken.map(edgeLabel).join(', ')
    watch.push({ level: 'watch', what: `${ordinal(times)} pass back to ${at(to)}`, why: `Sent back by ${by}`, where: at(to), node: to })
  }
  for (const [id, s] of Object.entries(r.nodes)) {
    if (s.cold !== undefined) {
      watch.push({ level: 'watch', what: `Cold cache at ${at(id)}`, why: `${coldBy(r, s.cold.by)} · ${fmtTok(s.cold.extra)} extra`, where: at(id), node: id })
    }
  }
  for (const a of agents) {
    const reports = LOOP.reporters.includes(a.type)
    if (a.status === 'done' && reports && a.contract === undefined && a.outcome === undefined && a.node !== undefined) {
      watch.push({ level: 'watch', what: `${agentName(a)} ended without its report line`, why: 'The session has to ask it again for its result', where: at(a.node), node: a.node, agent: a.id })
    }
  }

  return [...act, ...watch]
}

const worst = (alerts: ViewAlert[]): Level | undefined =>
  alerts.some(a => a.level === 'act') ? 'act' : alerts.length > 0 ? 'watch' : undefined

// Under a step that sends several agents, one row each, in the order sent: its
// time and, once it ends, the largest share of its context it used. The step
// itself keeps what they cost.
function subsOf(r: Run, n: GNode, alerts: ViewAlert[]): ViewSub[] | undefined {
  if (!isMultiAt(r, n.id)) return undefined
  const sent = agentsAt(r, n.id).sort((a, b) => a.startedAt - b.startedAt)
  if (sent.length === 0) {
    const isLeft = r.nodes[n.id]?.leftAt !== undefined && r.current !== n.id

    return n.kind === 'agent' && isLeft ? [{ id: 'none', label: 'No agent sent', state: 'none', meta: '' }] : undefined
  }
  const cmds = shownCommands(r)

  return batchesOf(sent).flatMap((batch, round) => batch.map(a => {
    const state = a.wait !== undefined ? 'waiting' as const : a.status === 'running' ? 'active' as const : 'done' as const
    // Like its time, an agent's compactions and peak show once it ends.
    const compacted = state === 'done' && (a.compactions ?? 0) > 0 ? `compacted ${a.compactions}×` : undefined
    const outcome = [a.outcome?.text, compacted].filter(Boolean).join(' · ')
    const cmd = cmds.filter(c => c.who === a.id).pop()

    return {
      id: a.id,
      label: subName(a, batch, round),
      state,
      alert: worst(alerts.filter(x => x.agent === a.id)),
      meta: state === 'done' ? fmtDur(a.totalMs)
        : state === 'active' ? `since ${clockTime(a.startedAt)}` : a.wait?.why === 'answers' ? 'waits for answers' : 'waiting for you',
      share: state === 'done' ? peakShare(r, a) : undefined,
      outcome: outcome === '' ? undefined : outcome,
      cmd: cmd === undefined ? undefined : commandView(r, cmd),
    }
  }))
}

// The steps the run's lane walks, in the map's order, plus any it reached
// from another lane; before a lane is picked, only those reached. A loop
// with no lanes walks every step.
function onPath(r: Run, n: GNode): boolean {
  if ((r.nodes[n.id]?.visits ?? 0) > 0) return true
  if (LOOP.lanes.length === 0) return true

  return r.lane !== 'unknown' && isReachable(n, r.lane)
}

function stateOf(r: Run, n: GNode): StepState {
  const st = nodeState(r, n)
  if (st === 'active' || st === 'waiting' || st === 'paused') return st
  if (st === 'visited') return 'done'

  return 'pending'
}

function factsOf(r: Run, n: GNode, state: StepState, cameBy: string | undefined): ViewFact[] {
  const s = r.nodes[n.id]
  const t = nodeTokens(r, n.id)
  const visits = s?.visits ?? 0
  const tokens = `${fmtTok(t.all)} cost-eq${t.agents > 0 ? ` (session ${fmtTok(t.main)} · agents ${fmtTok(t.agents)})` : ''}`
  const via = s?.via === undefined ? [] : [{ k: 'Came in by', v: s.via }]

  if (state === 'pending') return [{ k: 'Reached', v: 'not yet' }, ...(cameBy ? [{ k: 'Comes in by', v: cameBy }] : [])]
  if (state === 'active' || state === 'waiting') {
    const wait = waitAt(r, n)
    const outcome = outcomeOf(r, n)

    return [
      { k: 'Since', v: clockTime(s?.activeSince ?? s?.enteredAt ?? 0) },
      ...(wait === undefined ? [] : [{ k: 'Waiting', v: `${wait.text}, since ${clockTime(wait.since)}` }]),
      ...via,
      ...(visits > 1 ? [{ k: 'Visits', v: `${visits}` }] : []),
      ...(progressOf(r, n.id) === undefined ? [] : [{ k: 'Progress', v: progressOf(r, n.id) ?? '' }]),
      ...(outcome === undefined ? [] : [{ k: 'So far', v: outcome }]),
    ]
  }
  if (state === 'paused') {
    return [
      { k: r.pause === 'stopped' ? 'Stopped' : 'Idle', v: `${r.pause === 'stopped' ? 'by you ' : 'since '}${r.pause === 'stopped' ? 'at ' : ''}${clockTime(r.pausedAt ?? 0)}` },
      { k: 'So far', v: `${fmtDur(nodeMs(r, n.id, 0))} · ${tokens}` },
      ...via,
    ]
  }
  const span = s?.enteredAt !== undefined && s.leftAt !== undefined && visits === 1
    ? `, ${clockTime(s.enteredAt)} to ${clockTime(s.leftAt)}`
    : visits > 1 ? ` over ${visits} visits` : ''

  const outcome = outcomeOf(r, n)

  return [
    ...(outcome === undefined ? [] : [{ k: 'Came to', v: outcome }]),
    { k: 'Time', v: `${fmtDur(s?.totalMs ?? 0)}${span}` },
    { k: 'Tokens', v: tokens },
    { k: 'Raw', v: `${fmtTok(t.usage.cacheRead)} reread · ${fmtTok(t.usage.input + t.usage.cacheWrite)} new · ${fmtTok(t.usage.output)} written` },
    ...via,
    ...(s?.leftBy === undefined ? [] : [{ k: 'Left by', v: s.leftBy }]),
  ]
}

// What counts while a step runs or waits, read by the pane against its clock:
// the step's time and tokens, or how long it has waited.
function stepClock(r: Run, id: string, wait: { since: number } | undefined): LiveClock | undefined {
  const s = r.nodes[id]
  if (wait !== undefined) return { since: wait.since, baseMs: 0, isWait: true }
  if (s?.activeSince === undefined) return undefined

  return { since: s.activeSince, baseMs: s.totalMs, tokens: nodeTokens(r, id).all }
}

function stepsOf(r: Run, alerts: ViewAlert[]): ViewStep[] {
  const path = NODES.filter(n => onPath(r, n))
  const cmds = shownCommands(r)

  return path.map((n, i) => {
    const state = stateOf(r, n)
    const s = r.nodes[n.id]
    const next = path[i + 1]
    const edge = next === undefined ? undefined : findEdge(n.id, next.id, r.lane)
    const prev = path[i - 1]
    const cameBy = prev === undefined ? undefined : findEdge(prev.id, n.id, r.lane)?.label
    const wait = state === 'waiting' ? waitAt(r, n) : undefined
    const meta = state === 'active'
      ? 'working now'
      : state === 'waiting' ? (wait?.isOnYou === false ? 'waiting for answers' : 'waiting for you')
      : state === 'paused' ? (r.pause === 'stopped' ? 'stopped' : 'idle')
        : state === 'done' ? `${fmtDur(s?.totalMs ?? 0)} · ${fmtTok(nodeTokens(r, n.id).all)}`
            : ''
    const isMulti = isMultiAt(r, n.id)
    const peak = isMulti || state !== 'done' ? undefined
      : agentsAt(r, n.id).filter(a => a.peakContext !== undefined).sort((a, b) => (b.peakContext ?? 0) - (a.peakContext ?? 0))[0]
    // The step's own commands: the session's, or its one agent's.
    const own = cmds.filter(c => c.node === n.id && (c.who === undefined || !isMulti))

    return {
      id: n.id,
      label: n.label,
      role: n.role,
      state,
      meta,
      subs: subsOf(r, n, alerts),
      share: peak === undefined ? undefined : peakShare(r, peak),
      cmds: own.length === 0 ? undefined : own.map(c => commandView(r, c)),
      // An agent's own alert marks its row, not the step's.
      alert: worst(alerts.filter(x => x.node === n.id && (!isMulti || x.agent === undefined || r.agents[x.agent]?.node !== n.id))),
      outcome: state === 'pending' ? undefined : outcomeOf(r, n),
      arc: edge === undefined ? undefined : { text: edge.label, isTaken: (r.edges[edge.id] ?? 0) > 0 },
      what: n.what,
      facts: factsOf(r, n, state, cameBy),
      // Cards are part of the drawing: an agent at work shows no live count
      // there, its context is the Now card's live text.
      agents: agentsAt(r, n.id).slice(-4).map(a => (a.wait !== undefined
        ? `◷ ${a.description || a.type}${model(a.model)} · ${agentState(a)} since ${clockTime(a.wait.since)}`
        : a.status === 'running'
        ? `● ${a.description || a.type}${model(a.model)} · running since ${clockTime(a.startedAt)}`
        : `✓ ${a.description || a.type}${model(a.model)} · ${fmtDur(a.totalMs)} · ${fmtTok(costEq(a.tokens))} · ${a.steps} requests${peakLine(r, a)}`)),
      note: s?.note,
      clock: state === 'active' ? stepClock(r, n.id, undefined) : state === 'waiting' && wait !== undefined ? stepClock(r, n.id, wait) : undefined,
    }
  })
}

// An agent's own state in a few words, for its row in the Now card.
const agentState = (a: AgentRun) => (a.wait?.why === 'permission' ? `asks permission for ${a.wait.tool ?? 'a tool'}`
  : a.wait?.why === 'answers' ? 'waits for answers' : 'working')

function nowOf(r: Run): ViewNow | undefined {
  const runMs = r.updatedAt - (r.startedAt ?? r.updatedAt)
  if (r.isDone) {
    return { kicker: 'Finished', tone: 'plain', title: `${fmtDur(runMs)} · ${fmtTok(runTokens(r))} tokens`, line: `Ended ${clockTime(r.updatedAt)}` }
  }
  const here = r.current === undefined ? undefined : NODE_BY_ID[r.current]
  if (here === undefined) return undefined
  const s = r.nodes[here.id]
  if (r.pause !== undefined) {
    return {
      kicker: r.pause === 'stopped' ? `Stopped by you at ${clockTime(r.pausedAt ?? 0)}` : `Session idle since ${clockTime(r.pausedAt ?? 0)}`,
      tone: 'plain',
      title: here.label,
      def: here.short,
      line: `${fmtDur(nodeMs(r, here.id, 0))} of work · ${fmtTok(nodeTokens(r, here.id).all)} tokens so far`,
      hint: 'Send a message in the chat to pick it up again.',
    }
  }
  // An agent's permission prompt holds the run up wherever that agent works.
  const asking = Object.values(r.agents).find(a => a.wait?.why === 'permission')
  const onYou = asking === undefined ? waitAt(r, here) : waitAt(r, NODE_BY_ID[asking.node ?? ''] ?? here)
  const progress = progressOf(r, here.id)
  const held = Object.values(r.agents).filter(a => a.status === 'running' || a.status === 'waiting')
  const agents: ViewAgent[] = held.slice(0, 4).map(a => ({
    id: a.id,
    label: a.silentSince !== undefined && a.wait === undefined
      ? `${a.description || a.type}${model(a.model)} · silent since ${clockTime(a.silentSince)}`
      : `${a.description || a.type}${model(a.model)} · ${agentState(a)}`,
    context: a.context === undefined ? undefined : shareText(r, a, a.context),
    // Its time and what it spent count live beside its context.
    clock: a.activeSince === undefined ? undefined : { since: a.activeSince, baseMs: a.totalMs, tokens: costEq(a.tokens) },
    level: a.silentSince !== undefined && a.wait === undefined ? 'watch' : undefined,
    contextLevel: contextLevel(a.context, windowOf(r, a.model)),
  }))
  const more = held.length - agents.length
  const hint = more > 0 ? `${more} more agents at work.` : undefined
  const running = shownCommands(r).map(c => commandView(r, c))
  const cmds = running.length > 0 ? running : undefined
  if (onYou?.isOnYou === true) {
    const step = asking?.node === undefined ? here : NODE_BY_ID[asking.node] ?? here

    return {
      kicker: 'Waiting for you', tone: 'wait', title: step.label, def: step.short,
      clock: { since: onYou.since, baseMs: 0, isWait: true }, runSince: r.startedAt,
      // An agent's prompt is said on that agent's own row.
      line: asking === undefined ? `${onYou.text[0]?.toUpperCase()}${onYou.text.slice(1)} · since ${clockTime(onYou.since)}` : undefined,
      agents: agents.length > 0 ? agents : undefined, progress, cmds, hint,
    }
  }
  if (agents.length === 0) {
    const session: ViewAgent = {
      id: 'session',
      label: `This session · since ${clockTime(s?.activeSince ?? 0)}`,
      context: r.mainContext === undefined ? undefined : contextText(r, r.mainContext),
      contextLevel: contextLevel(r.mainContext, r.window),
    }

    return { kicker: 'Working now', tone: 'run', title: here.label, def: here.short, agents: [session], progress, cmds, hint, clock: stepClock(r, here.id, undefined), runSince: r.startedAt }
  }

  return { kicker: 'Working now', tone: 'run', title: here.label, def: here.short, agents, progress, cmds, hint, clock: stepClock(r, here.id, undefined), runSince: r.startedAt }
}

// Everything drawn here holds still while a step runs: times are clock times,
// and what counts (a step's time and tokens, an agent's) is read live by the
// pane from the clocks it carries.
export function viewOf(r: Run): View {
  const live = isLive(r)
  const off = NODES.filter(n => !onPath(r, n)).length
  const jumps = r.unexpected.reduce((n, j) => n + j.count, 0)
  const alerts = alertsOf(r)
  const badges = Object.fromEntries(NODES.map(n => [n.id, worst(alerts.filter(a => a.node === n.id))]).filter(([, l]) => l !== undefined))

  return {
    isLive: live,
    title: live ? r.task ?? 'Loop run' : 'No loop run yet',
    alerts,
    chips: live
      ? [laneLabel(r.lane), `Started ${clockTime(r.startedAt ?? r.updatedAt)}`, ...(r.isDone ? [`Ended ${clockTime(r.updatedAt)}`] : [])]
      : [LOOP.isLoaded ? 'Run the loop: its first step opens a run here. The map below is the whole loop.'
        : 'No loop map in this project yet: run /loop-graph:setup to draw one.'],
    now: live ? nowOf(r) : undefined,
    jumps: jumps > 0 ? `${jumps} unexpected jump${jumps > 1 ? 's' : ''}: the loop moved between steps the map does not link (red on the map)` : undefined,
    steps: live ? stepsOf(r, alerts) : [],
    offLanes: !live || LOOP.lanes.length === 0 ? undefined
      : r.lane === 'unknown' ? 'Lane not picked yet'
        : `${off} steps not on this lane`,
    svg: mapSvg(r, badges),
    recent: r.log.slice(-5).reverse().map(l => ({ at: clockTime(l.at), text: l.text })),
    outline: NODES.filter(n => nodeState(r, n) !== 'off')
      .map(n => ({ mark: MARK[nodeState(r, n)], label: n.label, isDim: nodeState(r, n) === 'idle' })),
    arrival: live ? r.arrival : undefined,
  }
}
