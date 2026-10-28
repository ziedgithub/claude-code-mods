import type { AgentRun, Level, Run } from '../types'

import { EDGES, LOOP, MAP, NH, NODES, NODE_BY_ID, NW, isReachable, node } from './graph'
import type { GEdge, GNode } from './graph'
import { addUsage, costEq, ZERO } from './tracker'

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`

  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function fmtTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`

  return `${(n / 1e6).toFixed(2)}M`
}

// The live numbers of what is still running stay out of the drawing, so it
// only changes (and the pane reloads it) when the loop moves.
export const agentMs = (a: AgentRun, now: number) =>
  a.totalMs + (a.activeSince === undefined ? 0 : now - a.activeSince)

export function nodeMs(r: Run, id: string, now: number): number {
  const s = r.nodes[id]
  if (s === undefined) return 0

  return s.totalMs + (s.activeSince === undefined ? 0 : now - s.activeSince)
}

export const agentsAt = (r: Run, id: string) => Object.values(r.agents).filter(a => a.node === id)

type State = 'active' | 'waiting' | 'paused' | 'visited' | 'idle' | 'off'

// Waiting outranks working: a permission prompt holds its agent up whatever
// else runs beside it.
export function nodeState(r: Run, n: GNode): State {
  const here = agentsAt(r, n.id)
  if (here.some(a => a.wait?.why === 'permission')) return 'waiting'
  if (here.some(a => a.status === 'running')) return 'active'
  if (r.current === n.id && !r.isDone) {
    if (r.pause !== undefined) return 'paused'
    const isWaiting = r.wait !== undefined || n.kind === 'human' || here.some(a => a.status === 'waiting')

    return isWaiting ? 'waiting' : 'active'
  }
  if ((r.nodes[n.id]?.visits ?? 0) > 0) return 'visited'

  return isReachable(n, r.lane) ? 'idle' : 'off'
}

function edgeClass(r: Run, e: GEdge): 'taken' | 'open' | 'off' {
  if ((r.edges[e.id] ?? 0) > 0) return 'taken'
  const isOpen = isReachable(node(e.from), r.lane) && isReachable(node(e.to), r.lane)
    && (e.lane === undefined || r.lane === 'unknown' || e.lane === r.lane)

  return isOpen ? 'open' : 'off'
}

function drawLabel(e: GEdge, cls: string): string {
  const at = e.at
  if (at === undefined || e.label === '') return ''
  const text = at.text ?? e.label
  const anchor = at.anchor ?? 'start'
  if (at.lines !== undefined) {
    return `<text class="el ${cls}" text-anchor="${anchor}">${at.lines
      .map((l, i) => `<tspan x="${at.x}" y="${at.y + i * 11}">${esc(l)}</tspan>`).join('')}</text>`
  }
  const rot = at.isVertical ? ` transform="rotate(-90 ${at.x} ${at.y})"` : ''

  return `<text class="el ${cls}" x="${at.x}" y="${at.y}" text-anchor="${anchor}"${rot}>${esc(text)}</text>`
}

function drawEdge(r: Run, e: GEdge): string {
  const cls = edgeClass(r, e)
  const count = r.edges[e.id] ?? 0
  const a = node(e.from)
  const b = node(e.to)
  const tip = `${a.label} → ${b.label}${e.label ? `: ${e.label}` : ''}${count > 0 ? ` · taken ${count}×` : cls === 'off' ? ' · not in this lane' : ' · not taken yet'}`

  const times = count > 1 && e.count !== undefined
    ? `<text class="cnt" x="${e.count.x}" y="${e.count.y}"${e.count.anchor === undefined ? '' : ` text-anchor="${e.count.anchor}"`}>×${count}</text>`
    : ''

  return `<g class="edge ${cls}"><title>${esc(tip)}</title>`
    + `<path class="line" d="${e.d}" marker-end="url(#m-${cls})"/>${drawLabel(e, cls)}${times}</g>`
}

// The arcs taken last, so the path the run took lies over every other line.
const LAYER = { off: 0, open: 1, taken: 2 } as const
const byLayer = (r: Run) => [...EDGES].sort((a, b) => LAYER[edgeClass(r, a)] - LAYER[edgeClass(r, b)])

// Drawn down the left margin of the leftmost box, so it never crosses a box.
function drawJump(j: { from: string; to: string; count: number }): string {
  const a = NODE_BY_ID[j.from]
  const b = NODE_BY_ID[j.to]
  if (a === undefined || b === undefined) return ''
  const X = Math.min(a.x, b.x) - NW / 2 - 7
  const ax = a.x - NW / 2
  const bx = b.x - NW / 2 - 3
  const sy = Math.sign(b.y - a.y) || 1
  const d = `M ${ax} ${a.y + 4} H ${X + 4} Q ${X} ${a.y + 4} ${X} ${a.y + 4 + sy * 4} V ${b.y - 4 - sy * 4} Q ${X} ${b.y - 4} ${X + 4} ${b.y - 4} H ${bx}`
  const tip = `Unexpected jump ${a.label} → ${b.label}, ${j.count}×: the loop announced a step the map does not link to the last one.`

  return `<g class="edge bad"><title>${esc(tip)}</title><path class="line" d="${d}" marker-end="url(#m-bad)"/></g>`
}

export function nodeTokens(r: Run, id: string) {
  const own = r.nodes[id]?.tokens ?? ZERO
  const agents = agentsAt(r, id).reduce((u, a) => addUsage(u, a.tokens), ZERO)

  return { usage: own, all: costEq(own), agents: costEq(agents), main: Math.max(0, costEq(own) - costEq(agents)) }
}

function drawNode(r: Run, n: GNode): string {
  const st = nodeState(r, n)
  const w = n.w
  const x = n.x - w / 2
  const y = n.y - NH / 2
  const text = n.kind === 'human' ? `${n.label} · you` : n.label

  return `<g class="node ${st} k-${n.kind}">`
    + `<rect class="box" x="${x}" y="${y}" width="${w}" height="${NH}" rx="6"/>`
    + `<text class="nl" x="${n.x}" y="${n.y + 3.5}" text-anchor="middle">${esc(text)}</text>`
    + '</g>'
}

// Only done and working steps get a fill; nothing is painted to hide what
// lies beneath. The colour tokens are the pane's (pane.ts).
export const MAP_STYLE = `
.box{fill:none;stroke:var(--line);stroke-width:1}
.nl{font-size:10.5px;fill:var(--faint)}
.visited .box{fill:var(--done);stroke:var(--line)}.visited .nl{fill:var(--fg)}
.active .box{fill:var(--accentfill);stroke:var(--accent);stroke-width:1.5}.active .nl{fill:var(--fg)}
.waiting .box{fill:none;stroke:var(--accent);stroke-width:1.5;stroke-dasharray:4 2}.waiting .nl{fill:var(--fg)}
.paused .box{stroke:var(--muted);stroke-width:1.25;stroke-dasharray:4 2}.paused .nl{fill:var(--fg)}
.off .box{stroke:var(--line);stroke-dasharray:3 3}
.edge .line{fill:none;stroke-width:1.1}
.edge.open .line{stroke:var(--line)}.edge.off .line{stroke:var(--line);stroke-dasharray:3 3}
.edge.taken .line{stroke:var(--fg);stroke-width:1.6}.edge.bad .line{stroke:var(--bad);stroke-width:1.4;stroke-dasharray:5 3}
.el{font-size:9.5px;fill:var(--faint)}.el.taken{fill:var(--fg)}
.cnt{font-size:10px;font-weight:700;fill:var(--fg)}
.mk-taken{fill:var(--fg)}.mk-open,.mk-off{fill:var(--line)}.mk-bad{fill:var(--bad)}
.lg{font-size:11px;fill:var(--muted)}
.badge.act circle:first-child{fill:var(--bad);stroke:var(--bg);stroke-width:2}.badge.watch circle:first-child{fill:var(--bg);stroke:var(--warn);stroke-width:1.4}
`

export function markers(): string {
  return ['taken', 'open', 'off', 'bad']
    .map(c => `<marker id="m-${c}" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`
      + `<path d="M0 0L6 3L0 6z" class="mk-${c}"/></marker>`)
    .join('')
}

function legend(): string {
  const y = MAP.H - 6
  const item = (x: number, cls: string, text: string) =>
    `<g class="node ${cls}"><rect class="box" x="${x}" y="${y - 9}" width="14" height="10" rx="3"/></g><text class="lg" x="${x + 20}" y="${y}">${text}</text>`

  return item(0, 'visited', 'Done') + item(62, 'active', 'Now') + item(116, 'waiting', 'Waiting')
    + item(194, 'idle', 'Not reached yet') + (LOOP.lanes.length === 0 ? '' : item(310, 'off', 'Not on this lane'))
}

// A step that needs a look carries a mark on its box's top right corner:
// a filled red disc to act on, an amber ring worth a look.
function drawBadge(n: GNode, level: Level): string {
  const x = n.x + n.w / 2 - 1
  const y = n.y - NH / 2 + 1
  const ink = level === 'act' ? 'var(--onbad)' : 'var(--warn)'

  return `<g class="badge ${level}"><circle cx="${x}" cy="${y}" r="7"/>`
    + `<path d="M${x} ${y - 3}v3.4" style="stroke:${ink};stroke-width:1.5;stroke-linecap:round"/><circle cx="${x}" cy="${y + 2.6}" r=".85" style="fill:${ink}"/></g>`
}

// The whole loop in the map's own units (MAP.W × MAP.H), for the pane to place.
export function mapSvg(r: Run, badges: Record<string, Level | undefined> = {}): string {
  return byLayer(r).map(e => drawEdge(r, e)).join('')
    + r.unexpected.map(drawJump).join('')
    + NODES.map(n => drawNode(r, n)).join('')
    + NODES.map(n => (badges[n.id] === undefined ? '' : drawBadge(n, badges[n.id] as Level))).join('')
    + legend()
}
