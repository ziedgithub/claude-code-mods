// A lane the map lists, or 'unknown' before the loop has picked one.
export type Lane = string

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type NodeStat = {
  visits: number
  activeSince?: number
  totalMs: number
  tokens: Usage
  note?: string
  // The last time the loop came into and left this step, and by which arc.
  enteredAt?: number
  via?: string
  leftAt?: number
  leftBy?: string
  // The slice the implement step is on, as its marker announced it
  // (`--slice 2/3`), and how many slices have come back green.
  slice?: { at: number; of: number; green: number }
  // The implement step was last announced with no slice: a fix pass.
  isFixPass?: boolean
  // What the step's own commands reported: the test runner's or the gate
  // runner's summary, for the steps the session runs itself.
  outcome?: string
  outcomeBad?: boolean
  // Requests at this step that found the cache cold, and the cost-equivalent
  // tokens that cost over a warm reread; by who went cold (an agent's id, or
  // `session`), how often and the longest idle gap before one.
  cold?: { count: number; extra: number; by: Record<string, { count: number; gapMs: number }> }
}

// Who is held up, and on what: a question or a permission prompt you have to
// answer, your reply in the chat, or an agent's questions the session has to
// answer it.
export type Wait = { why: 'question' | 'permission' | 'reply' | 'answers'; since: number; tool?: string }

// What an agent's last message reported, read from its contract line.
export type Outcome = { text: string; findings?: { critical: number; high: number }; isBad?: boolean }

export type AgentRun = {
  id: string
  type: string
  description: string
  model?: string
  node?: string
  startedAt: number
  activeSince?: number
  totalMs: number
  steps: number
  tokens: Usage
  status: 'running' | 'waiting' | 'done'
  // The slice an implement-step agent was sent for, as the loop announced
  // it, and whether the loop announced a fix pass instead.
  slice?: number
  isFixPass?: boolean
  // The report a background agent handed back through its hand-back call:
  // its last message is then only its last remark.
  report?: string
  contract?: string
  outcome?: Outcome
  wait?: Wait
  // Its context: the prompt its last request was answered over, the largest
  // one, and how often it shrank to under 60 % of the one before (a compaction).
  context?: number
  peakContext?: number
  compactions?: number
  // Its last request, and since when it has made none, once that passes the
  // stall threshold.
  lastAt?: number
  silentSince?: number
}

// A shell command the session or an agent runs: shown once it has run past a
// few seconds, at the step (and the agent) it runs for. One sent to the
// background ends unseen: it stays until its agent ends or the step changes.
export type RunCommand = { id: string; who?: string; node: string; text: string; since: number; isBg: boolean; isShown?: boolean }

export type LoopEvent = { at: number; text: string }

export type Jump = { from: string; to: string; count: number }

export type Run = {
  // What the loop was given: the card or the task, as its first marker said.
  task?: string
  startedAt?: number
  updatedAt: number
  lane: Lane
  current?: string
  isDone: boolean
  isMainBusy: boolean
  // Set when the session's turn ended with nothing running: the open step's
  // clock stops until the next turn starts. 'stopped' when you interrupted it.
  pause?: 'idle' | 'stopped'
  pausedAt?: number
  // The session itself waiting on you.
  wait?: Wait
  nodes: Record<string, NodeStat>
  edges: Record<string, number>
  unexpected: Jump[]
  agents: Record<string, AgentRun>
  log: LoopEvent[]
  mainTokens: Usage
  // The session's own context: the prompt its last request was answered over.
  mainContext?: number
  // When the session's last request was answered.
  mainAt?: number
  // The context window the session reports for its model, in tokens, and
  // that model: an agent on the same model has the same window.
  window?: number
  mainModel?: string
  commands?: Record<string, RunCommand>
  // The last move to another step: the pane moves once, just after it.
  arrival?: Arrival
}
export type Arrival = { from?: string; to: string; at: number }

// What the pane draws, rewritten only when one of its values changes: the
// drawing reloads on every redraw, so nothing in it may tick. What counts
// (times, tokens) is live text laid over it, read from a clock here.
// A count that runs while the pane is drawn: `baseMs` gathered before `since`.
export type LiveClock = { since: number; baseMs: number; tokens?: number; isWait?: boolean }
export type StepState = 'done' | 'active' | 'waiting' | 'paused' | 'pending'
export type ViewFact = { k: string; v: string }
// A step on the run's path: its row, the arc to the next row, and the card
// pointing at it reveals.
export type ViewStep = {
  id: string
  label: string
  role: string
  state: StepState
  meta: string
  alert?: Level
  // The agents a step that sends several sent, one row each under it: a
  // slice or a fix pass, a reviewer, an evaluator.
  subs?: ViewSub[]
  // A step with one agent: the largest share of its model's context it used.
  share?: string
  // The commands running for the step itself, the session's or its one agent's.
  cmds?: ViewCommand[]
  // What the step came to, in its row in place of its role once known.
  outcome?: string
  arc?: { text: string; isTaken: boolean }
  what: string
  facts: ViewFact[]
  agents: string[]
  note?: string
  // The step at work or waiting: its time (and tokens) count live in its row.
  clock?: LiveClock
}
export type Level = 'act' | 'watch'
// Something that needs a look: what, why, and the step it happened at.
export type ViewAlert = { level: Level; what: string; why: string; where: string; node: string; agent?: string }
// `none`: a step that sends agents was left without sending one.
export type ViewSub = {
  id: string; label: string; state: 'done' | 'active' | 'waiting' | 'none'; meta: string; outcome?: string; alert?: Level
  // Once it ends, the largest share of its model's context it used.
  share?: string
  cmd?: ViewCommand
}
// A command's row: its clock counts live from `since`; one in the background has none.
export type ViewCommand = { id: string; who: string; text: string; since: number; isBg: boolean }
// A running agent's row in the Now card: its name is drawn, its context is
// live text laid over the drawing, so a moving number never reloads it.
export type ViewAgent = { id: string; label: string; context?: string; level?: Level; contextLevel?: Level; clock?: LiveClock }
export type ViewNow = {
  kicker: string
  tone: 'run' | 'wait' | 'plain'
  title: string
  // What the step does, in a few words.
  def?: string
  line?: string
  agents?: ViewAgent[]
  progress?: string
  cmds?: ViewCommand[]
  hint?: string
  // The step's time and tokens and the run's time, counting while it runs.
  clock?: LiveClock
  runSince?: number
}
export type ViewRow = { mark: string; label: string; isDim: boolean }
export type View = {
  isLive: boolean
  title: string
  chips: string[]
  alerts: ViewAlert[]
  now?: ViewNow
  jumps?: string
  steps: ViewStep[]
  offLanes?: string
  svg: string
  recent: { at: string; text: string }[]
  outline: ViewRow[]
  arrival?: Arrival
}

declare module 'claude-code' {
  interface PluginState {
    'loop-graph': { run: Run; view: View; tick: number }
  }
}
