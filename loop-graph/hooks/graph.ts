import type { Lane } from '../types'

// The loop's map is the project's own: `.claude/loop-graph/map.json` names its
// steps, the arcs between them, its lanes and how its agents report. The map
// is laid out here, once per load, so a step added to the file needs no
// drawing of its own.

export type NodeKind = 'switch' | 'self' | 'agent' | 'human' | 'end'

// One step as the map file writes it.
export type MapStep = {
  id: string
  label: string
  role?: string
  kind?: NodeKind
  // The lanes that walk this step; every lane when left out.
  lanes?: string[]
  what?: string
  short?: string
  // The column it sits in, from 0 at the left, and its row there; by default
  // the first column, under the step before it.
  col?: number
  row?: number
  // A step above the columns, centred over them: a triage that picks the lane.
  span?: boolean
  // A step that starts a new run when the loop announces it. By default the
  // steps no arc leads into, else the first step listed.
  opens?: boolean
  // A step that sends several agents lists each under it.
  multi?: boolean
  // Past this many visits, the step is flagged: fix passes keep coming back.
  maxVisits?: number
}
export type MapArc = { from: string; to: string; label?: string; lane?: string }
// What a line of an agent's last message, or of a command's output, came to:
// `match` a regular expression, `text` its wording with $1… for its groups,
// `bad` a regular expression the wording matches when the step cannot go on.
export type MapRule = { match: string; text: string; bad?: string; agents?: string[] }
export type LoopMap = {
  name?: string
  lanes?: { id: string; label: string }[]
  steps: MapStep[]
  arcs: MapArc[]
  // Read from an agent's last message: its contract line.
  outcomes?: MapRule[]
  // Read from the output of the commands the session runs itself.
  runners?: MapRule[]
  // Agents that stop to ask questions: a stop whose message does not match
  // `doneWhen` waits for answers.
  asksBack?: { agent: string; doneWhen: string }[]
  // Agents that must end on a contract line: one that does not is flagged.
  reporters?: string[]
}

export type GNode = {
  id: string
  label: string
  role: string
  kind: NodeKind
  lanes?: string[]
  isSpan: boolean
  isOpening: boolean
  isMulti: boolean
  maxVisits?: number
  col: number
  row: number
  x: number
  y: number
  w: number
  what: string
  // What the step does, in a few words, under its name while it works.
  short: string
}

// Where an arc's label sits: beside it, rotated along a vertical run, or on
// two lines. Arcs straight down a column carry none on the map: the pane's
// path list prints them.
export type ArcLabel = { x: number; y: number; anchor?: 'start' | 'middle' | 'end'; isVertical?: boolean; lines?: string[]; text?: string }

export type GEdge = {
  id: string
  from: string
  to: string
  label: string
  lane?: Lane
  d: string
  at?: ArcLabel
  // Where the arc's crossing count sits, when it was crossed more than once.
  count?: { x: number; y: number; anchor?: 'end' }
  // An arc back to a step at or above the one it leaves: a pass back.
  isBack: boolean
}

// Boxes 120 × 26, rows 38 px apart, loop-backs in the gutters 20 px apart.
export const NW = 120
export const NH = 26
const ROW = 38
const TRACK = 20
const TOP = 26
// Below the steps over the columns, room for the arcs that fan out of them.
const SPAN_GAP = 58
const LEFT = 26
const MIN_GUTTER = 44
// The legend's width: the map is never narrower.
const LEGEND_W = 410

export const MAP = { W: LEGEND_W, H: 120 }
export const LOOP = {
  name: 'Loop',
  lanes: [] as { id: string; label: string }[],
  outcomes: [] as MapRule[],
  runners: [] as MapRule[],
  asksBack: [] as { agent: string; doneWhen: string }[],
  reporters: [] as string[],
  isLoaded: false,
}
export const NODES: GNode[] = []
export const EDGES: GEdge[] = []
export const NODE_BY_ID: Record<string, GNode> = {}

// What is wrong with a map, in words for whoever wrote it; empty when it loads.
export function checkMap(m: unknown): string[] {
  const map = m as Partial<LoopMap> | undefined
  if (map === undefined || map === null || typeof map !== 'object') return ['the map is not a JSON object']
  if (!Array.isArray(map.steps) || map.steps.length === 0) return ['the map has no "steps"']
  const out: string[] = []
  const ids = new Set<string>()
  const lanes = new Set((map.lanes ?? []).map(l => l.id))
  for (const s of map.steps) {
    if (typeof s?.id !== 'string' || s.id === '') out.push('a step has no "id"')
    else if (ids.has(s.id)) out.push(`step "${s.id}" is listed twice`)
    else ids.add(s.id)
    if (typeof s?.label !== 'string') out.push(`step "${s?.id}" has no "label"`)
    for (const l of s?.lanes ?? []) if (!lanes.has(l)) out.push(`step "${s.id}" names lane "${l}", which "lanes" does not list`)
  }
  for (const a of map.arcs ?? []) {
    if (!ids.has(a?.from)) out.push(`an arc leaves "${a?.from}", which is no step`)
    if (!ids.has(a?.to)) out.push(`an arc goes to "${a?.to}", which is no step`)
    if (a?.lane !== undefined && !lanes.has(a.lane)) out.push(`arc ${a.from} → ${a.to} names lane "${a.lane}", which "lanes" does not list`)
  }
  for (const r of [...(map.outcomes ?? []), ...(map.runners ?? [])]) {
    for (const re of [r?.match, r?.bad]) {
      if (re === undefined) continue
      try {
        new RegExp(re, 'm')
      } catch {
        out.push(`"${re}" is not a regular expression`)
      }
    }
  }

  return out
}

// A box's side a vertical run leaves or enters by, and how far off its middle.
type Port = { node: string; side: 'l' | 'r' }
type Run = { edge: MapArc & { id: string }; gutter: number; from: Port; to: Port; sy: number; ey: number; track?: number }
// A run down the left of a column, both its ends on that side, keeps to that
// column: its tracks count from the column on the gutter's right.
const hugsRight = (r: Run) => r.from.side === 'l' && r.to.side === 'l'
const trackSet = (r: Run) => `${r.gutter}|${hugsRight(r) ? 'r' : 'l'}`

// Five ports 5 px apart fit a box's side; a sixth run shares one, half-way.
const PORT_OFFSETS = [0, -5, 5, -10, 10, -2.5, 2.5, -7.5, 7.5]

// Lays the map out: columns of boxes, the steps over them centred above, each
// arc straight down to the next row, curved out of a step over the columns, or
// round a vertical run in a gutter beside the columns, each run on its own
// track so no two overlap.
export function setGraph(map: LoopMap): void {
  const errors = checkMap(map)
  if (errors.length > 0) throw new Error(errors.join('; '))

  const spans = map.steps.filter(s => s.span === true)
  const into = new Set(map.arcs.filter(a => a.from !== a.to).map(a => a.to))
  const first = map.steps.some(s => s.opens === true || !into.has(s.id)) ? undefined : map.steps[0]?.id
  const nextRow: Record<number, number> = {}
  const y0 = TOP + spans.length * SPAN_GAP
  const nodes: GNode[] = map.steps.map(s => {
    const isSpan = s.span === true
    const col = isSpan ? 0 : Math.max(0, Math.floor(s.col ?? 0))
    const row = isSpan ? spans.indexOf(s) : s.row ?? nextRow[col] ?? 0
    if (!isSpan) nextRow[col] = row + 1

    return {
      id: s.id, label: s.label, role: s.role ?? '', kind: s.kind ?? 'self', lanes: s.lanes, isSpan,
      isOpening: s.opens ?? (!into.has(s.id) || s.id === first), isMulti: s.multi === true, maxVisits: s.maxVisits,
      col, row, x: 0, y: isSpan ? TOP + row * SPAN_GAP : y0 + row * ROW, w: NW,
      what: s.what ?? s.short ?? '', short: s.short ?? s.what ?? '',
    }
  })
  const byId: Record<string, GNode> = Object.fromEntries(nodes.map(n => [n.id, n]))
  const cols = Math.max(1, ...nodes.filter(n => !n.isSpan).map(n => n.col + 1))
  const order = (n: GNode) => (n.isSpan ? -1000 + n.row : n.y)

  // Arcs that share a from and a to, one per lane, get ids of their own.
  const seen = new Map<string, number>()
  const arcs = map.arcs.map(a => {
    const base = `${a.from}>${a.to}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)

    return { ...a, id: n === 0 ? base : `${base}#${a.lane ?? n}` }
  })

  // Which arcs run vertically in a gutter: gutter c is right of column c, -1
  // the left margin.
  const runs: Run[] = []
  for (const e of arcs) {
    const a = byId[e.from] as GNode
    const b = byId[e.to] as GNode
    if (a.id === b.id || (a.isSpan && !b.isSpan) || (a.isSpan && b.isSpan)) continue
    if (!a.isSpan && !b.isSpan && a.col === b.col && b.row === a.row + 1) continue
    if (!a.isSpan && !b.isSpan && Math.abs(a.col - b.col) === 1 && a.row === b.row) continue
    if (b.isSpan) {
      runs.push({ edge: e, gutter: a.col, from: { node: a.id, side: 'r' }, to: { node: b.id, side: 'r' }, sy: 0, ey: 0 })
    } else if (a.col === b.col && b.row < a.row) {
      // Back up a column: in the gutter on its right.
      runs.push({ edge: e, gutter: a.col, from: { node: a.id, side: 'r' }, to: { node: b.id, side: 'r' }, sy: 0, ey: 0 })
    } else if (a.col === b.col) {
      // Down past the next step: in the gutter on its left.
      runs.push({ edge: e, gutter: a.col - 1, from: { node: a.id, side: 'l' }, to: { node: b.id, side: 'l' }, sy: 0, ey: 0 })
    } else if (b.col > a.col) {
      runs.push({ edge: e, gutter: b.col - 1, from: { node: a.id, side: 'r' }, to: { node: b.id, side: 'l' }, sy: 0, ey: 0 })
    } else {
      runs.push({ edge: e, gutter: b.col, from: { node: a.id, side: 'l' }, to: { node: b.id, side: 'r' }, sy: 0, ey: 0 })
    }
  }

  // Each side of a box spreads the runs that touch it a few pixels apart.
  const ports = new Map<string, number>()
  const portY = (p: Port) => {
    const key = `${p.node}|${p.side}`
    const i = ports.get(key) ?? 0
    ports.set(key, i + 1)

    return (byId[p.node]?.y ?? 0) + (PORT_OFFSETS[i % PORT_OFFSETS.length] ?? 0)
  }
  for (const r of runs) {
    r.sy = portY(r.from)
    r.ey = portY(r.to)
  }

  // Tracks: the shortest runs nearest the columns, none overlapping another.
  const tracks = new Map<string, number>()
  for (const r of [...runs].sort((p, q) => Math.abs(p.ey - p.sy) - Math.abs(q.ey - q.sy))) {
    const lo = Math.min(r.sy, r.ey) - 5
    const hi = Math.max(r.sy, r.ey) + 5
    const taken = runs.filter(o => o !== r && trackSet(o) === trackSet(r) && o.track !== undefined
      && Math.min(o.sy, o.ey) - 5 < hi && Math.max(o.sy, o.ey) + 5 > lo).map(o => o.track as number)
    let t = 0
    while (taken.includes(t)) t++
    r.track = t
    tracks.set(trackSet(r), Math.max(tracks.get(trackSet(r)) ?? 0, t + 1))
  }
  const trackCount = (g: number) => (tracks.get(`${g}|l`) ?? 0) + (tracks.get(`${g}|r`) ?? 0)

  // Columns left to right, each gutter as wide as its tracks need.
  const hasSide = (c: number) => arcs.some(e => {
    const a = byId[e.from] as GNode
    const b = byId[e.to] as GNode

    return !a.isSpan && !b.isSpan && a.row === b.row && Math.min(a.col, b.col) === c && Math.abs(a.col - b.col) === 1
  })
  const gutterW = (c: number) => Math.max(c < cols - 1 ? MIN_GUTTER : 16, trackCount(c) * TRACK + 16 + (tracks.has(`${c}|r`) ? 12 : 0), hasSide(c) ? 76 : 0)
  const colX: number[] = []
  // The left margin holds the runs down column 0, and room for an unexpected jump.
  let x = Math.max(LEFT, trackCount(-1) * TRACK + 30)
  for (let c = 0; c < cols; c++) {
    colX.push(x + NW / 2)
    x += NW + gutterW(c)
  }
  const midX = ((colX[0] ?? 0) + (colX[cols - 1] ?? 0)) / 2
  for (const n of nodes) n.x = n.isSpan ? midX : colX[n.col] ?? 0
  // A gutter's tracks out from the column on its left, or from the one on its
  // right for the runs that keep to that one.
  const trackX = (r: Run) => (hugsRight(r) ? (colX[r.gutter + 1] ?? 0) - NW / 2 - 14 - (r.track ?? 0) * TRACK
    : (colX[r.gutter] ?? 0) + NW / 2 + 14 + (r.track ?? 0) * TRACK)

  const edges: GEdge[] = arcs.map(e => {
    const a = byId[e.from] as GNode
    const b = byId[e.to] as GNode
    const label = e.label ?? ''
    const isBack = order(b) <= order(a)
    const base = { id: e.id, from: a.id, to: b.id, label, lane: e.lane, isBack }
    const top = (n: GNode) => n.y - NH / 2
    const bottom = (n: GNode) => n.y + NH / 2

    if (a.id === b.id) {
      const sx = a.x + 42

      return {
        ...base,
        d: `M ${sx} ${bottom(a)} C ${sx} ${bottom(a) + 9}, ${sx + 12} ${bottom(a) + 9}, ${sx + 12} ${bottom(a) + 3}`,
        at: { x: a.x - 5, y: bottom(a) + 9, anchor: 'end' },
        count: { x: sx + 16, y: bottom(a) + 10 },
      }
    }
    if (a.isSpan) {
      // Out of the step's bottom, a little towards the side it heads for.
      const lean = Math.sign(b.x - a.x)
      const sx = a.x + lean * 20
      const sy = bottom(a)
      const ey = top(b) - 2
      const mid = (sy + ey) / 2
      const d = b.x === sx ? `M ${sx} ${sy} V ${ey}` : `M ${sx} ${sy} C ${sx} ${mid + 4}, ${b.x} ${mid}, ${b.x} ${ey}`

      return {
        ...base,
        d,
        at: label === '' ? undefined : { x: (sx + b.x) / 2 + (lean < 0 ? -6 : 6), y: mid, anchor: lean < 0 ? 'end' : 'start' },
        count: { x: b.x + (lean < 0 ? -8 : 8), y: ey - 2 },
      }
    }
    if (a.col === b.col && b.row === a.row + 1) {
      return { ...base, d: `M ${a.x} ${bottom(a)} V ${top(b) - 2}`, count: { x: a.x + 8, y: (bottom(a) + top(b)) / 2 + 3.5 } }
    }
    if (!b.isSpan && Math.abs(a.col - b.col) === 1 && a.row === b.row) {
      const dir = Math.sign(b.x - a.x)
      const sx = a.x + (dir * a.w) / 2
      const ex = b.x - (dir * b.w) / 2 - dir * 3
      const words = label.split(' ')
      const half = Math.ceil(words.length / 2)
      const lines = label.length > 14 && words.length > 1 ? [words.slice(0, half).join(' '), words.slice(half).join(' ')] : undefined

      return {
        ...base,
        d: `M ${sx} ${a.y} H ${ex}`,
        at: label === '' ? undefined : { x: (sx + ex) / 2, y: a.y - (lines === undefined ? 6 : 17), anchor: 'middle', lines },
        count: { x: ex - dir * 12, y: a.y - 4 },
      }
    }
    const r = runs.find(x => x.edge.id === e.id) as Run
    const T = trackX(r)
    const sx = a.x + (r.from.side === 'r' ? a.w / 2 : -a.w / 2)
    const ex = b.x + (r.to.side === 'r' ? b.w / 2 + 3 : -b.w / 2 - 3)
    const out = Math.sign(T - sx) || 1
    const back = Math.sign(ex - T) || -1
    const sy = r.sy
    const ey = r.ey
    const v = Math.sign(ey - sy) || 1
    const k = 4

    return {
      ...base,
      d: `M ${sx} ${sy} H ${T - out * k} Q ${T} ${sy} ${T} ${sy + v * k} V ${ey - v * k} Q ${T} ${ey} ${T + back * k} ${ey} H ${ex}`,
      // The label on the track's outer side, away from the boxes.
      at: label === '' ? undefined : { x: T + (hugsRight(r) ? -7 : 7), y: (sy + ey) / 2, anchor: 'middle', isVertical: true },
      count: { x: (sx + T) / 2, y: sy - 3 },
    }
  })

  // Arcs that share a from and a to, one per lane, share one label: the first
  // carries all their names, the others none.
  for (const e of edges) {
    const twins = edges.filter(x => x.from === e.from && x.to === e.to)
    if (twins.length < 2 || e.at === undefined) continue
    if (twins[0] !== e) e.at = undefined
    else e.at = { ...e.at, text: [...new Set(twins.map(x => x.label).filter(Boolean))].join(' · ') }
  }

  const right = Math.max(...nodes.map(n => n.x + n.w / 2), ...runs.map(r => trackX(r) + 12))
  MAP.W = Math.ceil(Math.max(LEGEND_W, right + 8))
  MAP.H = Math.ceil(Math.max(...nodes.map(n => n.y + NH / 2)) + 34)

  NODES.splice(0, NODES.length, ...nodes)
  EDGES.splice(0, EDGES.length, ...edges)
  for (const k of Object.keys(NODE_BY_ID)) delete NODE_BY_ID[k]
  Object.assign(NODE_BY_ID, byId)
  Object.assign(LOOP, {
    name: map.name ?? 'Loop',
    lanes: map.lanes ?? [],
    outcomes: map.outcomes ?? [],
    runners: map.runners ?? [],
    asksBack: map.asksBack ?? [],
    reporters: map.reporters ?? [],
    isLoaded: true,
  })
}

// No map loaded: nothing to draw, nothing to track.
export function clearGraph(): void {
  NODES.splice(0)
  EDGES.splice(0)
  for (const k of Object.keys(NODE_BY_ID)) delete NODE_BY_ID[k]
  Object.assign(LOOP, { name: 'Loop', lanes: [], outcomes: [], runners: [], asksBack: [], reporters: [], isLoaded: false })
  MAP.W = LEGEND_W
  MAP.H = 120
}

export function node(id: string): GNode {
  const n = NODE_BY_ID[id]
  if (n === undefined) throw new Error(`loop-graph: no step ${id}`)

  return n
}

export function findEdge(from: string, to: string, lane: Lane): GEdge | undefined {
  const all = EDGES.filter(e => e.from === from && e.to === to)

  return all.find(e => e.lane === lane) ?? all.find(e => e.lane === undefined) ?? all[0]
}

export function isReachable(node: GNode, lane: Lane): boolean {
  if (lane === 'unknown' || node.lanes === undefined) return true

  return node.lanes.includes(lane)
}

// A loop with no lanes is named by the map itself.
export const laneLabel = (lane: Lane) => (LOOP.lanes.length === 0 ? LOOP.name : lane === 'unknown' ? 'Choosing a lane'
  : LOOP.lanes.find(l => l.id === lane)?.label ?? `${lane} lane`)
