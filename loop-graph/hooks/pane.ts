import type { Arrival, LiveClock, Level, StepState, View, ViewCommand } from '../types'

import { EDGES, MAP, NH, NODE_BY_ID } from './graph'
import { MAP_STYLE, esc, fmtTok, markers } from './svg'

// The whole pane is one still image drawn to the approved design: a plain
// image never reloads on a redraw, so nothing on it can blink (an interactive
// frame would reload, visibly, on every one). It is as wide as the pane and
// at most as tall, so it never scrolls.

// A pane cell in CSS pixels, measured on a 1:1 screenshot of a 118-column
// pane: the Reset button's right edge (the pane's) 1028 px right of the image's
// left edge over 116 columns, and native text on row 7 centred 151 px down.
// An image needs a width in pixels: a percentage falls back to 300 px. Its
// layout then follows that width through media queries.
export const COL_PX = 8.86
export const ROW_PX = 20.1
// From this image width the map sits right of the path's column, past a
// separator, and takes all the width left.
const WIDE_PX = 700
const COL = 290
const SEP = COL + 14
const MAP_X = SEP + 14
// Under this scale the map's labels are too small to read: a narrow pane
// leaves it out rather than draw a smudge.
const MIN_MAP_SCALE = 0.75

const TOP_GAP = 16
const STEP_ROW = 40
const STEP_ARC = 16
const COMPACT_ROW = 24
const SUB_ROW = 34
const COMPACT_SUB_ROW = 22
// A command's row at its tallest: snapped down to the grid, then a second
// line for one in the background.
const CMD_ROW = 22 + ROW_PX
const RECENT_LINE = 18

const LIGHT = '--fg:#1A1A1A;--muted:#6B6B6B;--faint:#737373;--line:rgba(0,0,0,.18);--done:rgba(0,0,0,.05);'
  + '--card:rgba(0,0,0,.02);--chip:rgba(0,0,0,.06);--accent:#D97757;--accentfill:rgba(217,119,87,.16);'
  + '--accenttext:#B5583A;--bad:#C0392B;--onbad:#FFFFFF;--badfill:rgba(192,57,43,.06);--badedge:rgba(192,57,43,.35);'
  + '--warn:#9A6700;--warnfill:rgba(154,103,0,.10);--warnedge:rgba(154,103,0,.35);--bg:#FFFFFF'
const DARK = '--fg:#EFEFEF;--muted:#9C9C9C;--faint:#8A8A8A;--line:rgba(255,255,255,.16);--done:rgba(255,255,255,.07);'
  + '--card:rgba(255,255,255,.025);--chip:rgba(255,255,255,.08);--accent:#D97757;--accentfill:rgba(217,119,87,.2);'
  + '--accenttext:#E08A6D;--bad:#E5735F;--onbad:#191919;--badfill:rgba(229,115,95,.12);--badedge:rgba(229,115,95,.45);'
  + '--warn:#D29922;--warnfill:rgba(210,153,34,.14);--warnedge:rgba(210,153,34,.42);--bg:#191919'

const STYLE = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root{${DARK}}}
svg{font-family:-apple-system,system-ui,"Segoe UI",sans-serif;background:transparent}
text{fill:var(--fg)}
.t{font-size:15px;font-weight:600}.c{font-size:12px;fill:var(--muted)}.cs{font-size:12px;font-weight:500}
.k{font-size:12px;font-weight:500;fill:var(--muted)}.k.run,.k.wait{fill:var(--accenttext)}
.nt{font-size:15px;font-weight:600}.nd{font-size:12.5px;fill:var(--muted)}.nl{font-size:13px;fill:var(--muted)}.np{font-size:13px;font-weight:500}.nh{font-size:12px;fill:var(--faint)}
.h2{font-size:12px;font-weight:500;fill:var(--faint)}
.sl{font-size:14px;font-weight:500}.sl.pending{fill:var(--faint)}.sr{font-size:12px;fill:var(--faint)}.so{font-size:12px;fill:var(--muted)}
.ul{font-size:13px;font-weight:500}.uo{font-size:11.5px;fill:var(--muted)}.ue{font-size:11.5px;fill:var(--faint)}
.sm{font-size:12px;fill:var(--muted)}.sm.active,.sm.waiting{fill:var(--accenttext)}
.arc{font-size:11.5px;fill:var(--faint)}.arc.taken{fill:var(--muted)}
.rail{stroke:var(--line);stroke-width:1.25;stroke-dasharray:3 3}.rail.taken{stroke:var(--faint);stroke-dasharray:none}
.sep{stroke:var(--line);stroke-width:1}
.warn{font-size:12px;fill:var(--bad)}
.off{fill:none;stroke:var(--line);stroke-dasharray:3 3}.offt{font-size:13px;fill:var(--faint)}
.ra{font-size:12px;fill:var(--faint)}.rt{font-size:12px;fill:var(--muted)}
.card{fill:var(--card);stroke:var(--line)}.chip{fill:var(--chip)}
.abox.act{fill:var(--badfill);stroke:var(--badedge)}.abox.watch{fill:var(--warnfill);stroke:var(--warnedge)}
.ak{font-size:12px;font-weight:500}.ak.act{fill:var(--bad)}.ak.watch{fill:var(--warn)}
.aw{font-size:13px;font-weight:500}.ay{font-size:12px;fill:var(--muted)}.ae{font-size:12px;fill:var(--faint)}
.nl.watch{fill:var(--warn);font-weight:500}.nl.act{fill:var(--bad);font-weight:500}
.w{display:none}
@media (min-width:${WIDE_PX}px){.w{display:inline}.n{display:none}.left{clip-path:url(#col)}}
${MAP_STYLE}`

const chipWidth = (text: string) => Math.round(text.length * 6.6 + 16)
// The widest live text of an agent's row, `12:34 · 999.9k spent · 100% of 1M`,
// in the pane's footnote size.
const LIVE_PX = 215
const clip = (text: string, chars: number) => (text.length <= chars ? text : `${text.slice(0, Math.max(1, Math.floor(chars) - 1))}…`)

// A count as it reads at `now`: minutes and seconds, then hours and minutes.
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)

  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`
}
const elapsed = (c: LiveClock, now: number) => clockText(c.baseMs + Math.max(0, now - c.since))
const stepText = (c: LiveClock, now: number) => (c.isWait === true ? `waiting ${elapsed(c, now)}`
  : `${elapsed(c, now)}${c.tokens === undefined ? '' : ` · ${fmtTok(c.tokens)}`}`)

// The row of the pane's grid a line of text sits on, and its baseline there:
// live text can only be laid on whole rows.
const gridRow = (baseline: number) => Math.ceil((baseline - 14) / ROW_PX - 0.001)
const onGrid = (row: number) => row * ROW_PX + 14

// A path's length, near enough to draw it in: each curve taken as the line
// through its control points.
export function pathLength(d: string): number {
  let x = 0
  let y = 0
  let len = 0
  for (const [, cmd, args] of d.matchAll(/([MHVLQC])([^MHVLQC]*)/g)) {
    const a = (args ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number)
    const pts: [number, number][] = cmd === 'H' ? [[a[0] ?? x, y]] : cmd === 'V' ? [[x, a[0] ?? y]]
      : Array.from({ length: Math.floor(a.length / 2) }, (_, i) => [a[2 * i] ?? 0, a[2 * i + 1] ?? 0])
    for (const [px, py] of pts) {
      if (cmd !== 'M') len += Math.hypot(px - x, py - y)
      x = px
      y = py
    }
  }

  return len
}

// Once, just after the loop reaches a step: the arrow it took draws itself,
// the new box's outline traces round it and fills, the path's line grows into
// the new row and its dot comes in, the Now card's name fades in. Each motion
// is placed by how long ago the arrival was, so a redraw in the middle carries
// on where it was; past the window the drawing holds still.
export const ARRIVAL_MS = 1500
type Motion = { arrival: Arrival; css: (name: string, s: number, delay: number) => string }

const KEYFRAMES = '@keyframes mvDraw{from{stroke-dashoffset:var(--len)}to{stroke-dashoffset:0}}'
  + '@keyframes mvFill{from{fill-opacity:0}to{fill-opacity:1}}'
  + '@keyframes mvGrow{from{transform:scaleY(0)}to{transform:scaleY(1)}}'
  + '@keyframes mvPop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:scale(1)}}'
  + '@keyframes mvFade{from{opacity:0}to{opacity:1}}'
  + '.mvg{transform-box:fill-box;transform-origin:top}.mvp{transform-box:fill-box;transform-origin:center}'
  + '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'

function motionOf(arrival: Arrival | undefined, now: number): Motion | undefined {
  if (arrival === undefined || now < arrival.at || now - arrival.at >= ARRIVAL_MS) return undefined
  const ago = (now - arrival.at) / 1000

  return { arrival, css: (name, s, delay) => `${name} ${s}s ease-out ${+(delay - ago).toFixed(3)}s both` }
}

// The map's own drawing, with the arrival's motion set on the arrow it took
// and the box it reached; a dash as long as the line, drawn in from its end.
function movingMap(svg: string, m: Motion | undefined): string {
  if (m === undefined) return svg
  const { from, to } = m.arrival
  const edge = from === undefined ? undefined : EDGES.find(e => e.from === from && e.to === to)
  let out = svg
  if (edge !== undefined) {
    const len = Math.ceil(pathLength(edge.d) * 1.1 + 4)
    out = out.replace(`<path class="line" d="${edge.d}"`,
      `<path class="line" style="--len:${len};stroke-dasharray:${len} ${len};animation:${m.css('mvDraw', 0.3, 0)}" d="${edge.d}"`)
  }
  const n = NODE_BY_ID[to]
  if (n === undefined) return out
  const w = n.w
  const box = `<rect class="box" x="${n.x - w / 2}" y="${n.y - NH / 2}"`
  const at = out.indexOf(box)
  if (at < 0) return out
  const group = out.lastIndexOf('<g class="node ', at)
  const state = out.slice(group + '<g class="node '.length).split(/[ "]/)[0]
  const len = Math.ceil(2 * (w + NH)) + 4
  // A box that waits on you keeps its dashed outline: it only fades in.
  const style = state === 'waiting' ? `animation:${m.css('mvFade', 0.3, 0.35)}`
    : `--len:${len};stroke-dasharray:${len} ${len};animation:${m.css('mvDraw', 0.45, 0.3)},${m.css('mvFill', 0.3, 0.7)}`

  return `${out.slice(0, at)}<rect class="box" style="${style}"${out.slice(at + '<rect class="box"'.length)}`
}

// The markers of the design: a check in a soft disc, the orange dot of the
// step at work, the orange ring and hand of a step waiting, the pause sign, a
// small ring for a step not reached.
function mark(state: StepState, cx: number, cy: number): string {
  if (state === 'done') {
    return `<circle cx="${cx}" cy="${cy}" r="8" style="fill:var(--done)"/>`
      + `<path d="M${cx - 3} ${cy + 0.2}l2 2 4-4.4" style="fill:none;stroke:var(--fg);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round"/>`
  }
  if (state === 'active') {
    return `<circle cx="${cx}" cy="${cy}" r="8" style="fill:var(--accentfill)"/><circle cx="${cx}" cy="${cy}" r="4" style="fill:var(--accent)"/>`
  }
  if (state === 'waiting') {
    return `<circle cx="${cx}" cy="${cy}" r="7" style="fill:none;stroke:var(--accent);stroke-width:1.5"/>`
      + `<path d="M${cx} ${cy - 3.5}V${cy}h2.6" style="fill:none;stroke:var(--accent);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round"/>`
  }
  if (state === 'paused') {
    return `<circle cx="${cx}" cy="${cy}" r="7" style="fill:none;stroke:var(--muted);stroke-width:1.4"/>`
      + `<path d="M${cx - 1.5} ${cy - 2.5}v5M${cx + 1.5} ${cy - 2.5}v5" style="stroke:var(--muted);stroke-width:1.4;stroke-linecap:round"/>`
  }

  return `<circle cx="${cx}" cy="${cy}" r="3.4" style="fill:none;stroke:var(--line);stroke-width:1.25"/>`
}

// The two marks of the design: a filled red disc with a white stroke to act
// on, an amber ring worth a look.
function alertMark(level: Level, cx: number, cy: number, r = 7): string {
  const k = r / 7
  if (level === 'act') {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" style="fill:var(--bad)"/>`
      + `<path d="M${cx} ${cy - 3.4 * k}v${4 * k}" style="stroke:var(--onbad);stroke-width:1.6;stroke-linecap:round"/>`
      + `<circle cx="${cx}" cy="${cy + 3.2 * k}" r="${0.95 * k}" style="fill:var(--onbad)"/>`
  }

  return `<circle cx="${cx}" cy="${cy}" r="${r - 0.8}" style="fill:var(--warnfill);stroke:var(--warn);stroke-width:1.4"/>`
    + `<path d="M${cx} ${cy - 3 * k}v${3.6 * k}" style="stroke:var(--warn);stroke-width:1.5;stroke-linecap:round"/>`
    + `<circle cx="${cx}" cy="${cy + 2.9 * k}" r="${0.85 * k}" style="fill:var(--warn)"/>`
}

// A slice's marker: the step's own, smaller.
// A command's prompt mark: accent while its clock runs, faint in the background.
function cmdMark(isBg: boolean, cx: number, cy: number): string {
  const ink = isBg ? 'var(--faint)' : 'var(--accent)'

  return `<path d="M${cx - 4} ${cy - 3}l3 3-3 3" style="fill:none;stroke:${ink};stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round"/>`
    + `<path d="M${cx + 0.5} ${cy + 3.5}h4" style="fill:none;stroke:${ink};stroke-width:1.4;stroke-linecap:round"/>`
}

function subMark(state: 'done' | 'active' | 'waiting' | 'none', cx: number, cy: number): string {
  if (state === 'none') return `<circle cx="${cx}" cy="${cy}" r="3.5" style="fill:none;stroke:var(--faint);stroke-width:1.25;stroke-dasharray:2 1.5"/>`
  if (state === 'done') {
    return `<circle cx="${cx}" cy="${cy}" r="6" style="fill:var(--done)"/>`
      + `<path d="M${cx - 2.4} ${cy + 0.2}l1.6 1.6 3.2-3.5" style="fill:none;stroke:var(--fg);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round"/>`
  }
  if (state === 'active') return `<circle cx="${cx}" cy="${cy}" r="6" style="fill:var(--accentfill)"/><circle cx="${cx}" cy="${cy}" r="3" style="fill:var(--accent)"/>`

  return `<circle cx="${cx}" cy="${cy}" r="5.3" style="fill:none;stroke:var(--accent);stroke-width:1.3"/>`
    + `<path d="M${cx} ${cy - 2.6}V${cy}h2" style="fill:none;stroke:var(--accent);stroke-width:1.3;stroke-linecap:round"/>`
}

export type PaneLayout = {
  svg: string
  width: number
  height: number
  rows: { id: string; y: number }[]
  // Text the pane draws itself over the image, by pane row and columns from
  // its right edge: it may change without the image changing.
  live: Live[]
}
export type Live = { id: string; top: number; text: string; level?: Level; right?: number; isAccent?: boolean }

const ALERT_ROWS = 4
// A card that counts keeps this many command rows whether any runs or not, so
// a command starting or ending never moves what sits below the card.
export const CMD_SLOTS = 2

export function paneSvg(v: View, width: number, height: number, now = 0): PaneLayout {
  const out: string[] = []
  const motion = motionOf(v.arrival, now)
  let y = 18
  out.push(`<text class="t" x="0" y="${y}">${esc(v.title)}</text>`)

  y += 12
  let x = 0
  v.chips.forEach((c, i) => {
    if (i === 0 && v.isLive) {
      const w = chipWidth(c)
      out.push(`<rect class="chip" x="0" y="${y}" width="${w}" height="20" rx="10"/><text class="cs" x="8" y="${y + 14}">${esc(c)}</text>`)
      x = w + 10
    } else {
      out.push(`<text class="c" x="${x}" y="${y + 14}">${esc(c)}</text>`)
      x += Math.round(c.length * 6.6) + 12
    }
  })
  y += 20 + TOP_GAP

  // What needs a look, above everything else on the pane, the most serious
  // first; nothing at all when nothing does.
  if (v.alerts.length > 0) {
    const acts = v.alerts.filter(a => a.level === 'act').length
    const n = v.alerts.length
    const level: Level = acts > 0 ? 'act' : 'watch'
    const title = acts > 0 ? `${n} thing${n === 1 ? ' needs' : 's need'} a look · ${acts} to act on`
      : `${n} thing${n === 1 ? ' is' : 's are'} worth a look`
    const rows = v.alerts.slice(0, n > ALERT_ROWS ? ALERT_ROWS - 1 : ALERT_ROWS)
    const h = 40 + rows.length * 40 + (rows.length < n ? 20 : 0)
    out.push(`<rect class="abox ${level}" x="0.5" y="${y + 0.5}" width="100%" height="${h - 1}" rx="10" style="width:calc(100% - 1px)"/>`)
    out.push(alertMark(level, 21, y + 19))
    out.push(`<text class="ak ${level}" x="36" y="${y + 23}">${esc(title)}</text>`)
    rows.forEach((a, i) => {
      const ry = y + 38 + i * 40
      const room = (width - 36 - 14 - a.where.length * 6.6 - 12) / 7
      out.push(alertMark(a.level, 21, ry + 9))
      out.push(`<text class="aw" x="36" y="${ry + 13}">${esc(clip(a.what, room))}</text>`)
      out.push(`<text class="ae" x="${width - 14}" y="${ry + 13}" text-anchor="end">${esc(a.where)}</text>`)
      out.push(`<text class="ay" x="36" y="${ry + 29}">${esc(clip(a.why, (width - 50) / 6.3))}</text>`)
    })
    if (rows.length < n) out.push(`<text class="ae" x="36" y="${y + 38 + rows.length * 40 + 8}">+${n - rows.length} more, marked on the path</text>`)
    y += h + TOP_GAP
  }

  const live: Live[] = []
  if (v.now !== undefined) {
    const n = v.now
    // A card that counts sits on the grid: its kicker row carries the run's
    // time, its title row the step's, laid live at their right ends.
    if (n.clock !== undefined) {
      y = onGrid(gridRow(y + 26)) - 26
      const row = gridRow(y + 26)
      if (n.runSince !== undefined) live.push({ id: 'run', top: row, text: `run ${clockText(now - n.runSince)}` })
      live.push({ id: 'step', top: row + 1, text: stepText(n.clock, now), isAccent: true })
    }
    const lines: string[] = []
    let ly = y + 46
    if (n.def !== undefined) lines.push(`<text class="nd" x="40" y="${(ly += 18)}">${esc(clip(n.def, (width - 48) / 6.6))}</text>`)
    if (n.line !== undefined) lines.push(`<text class="nl" x="40" y="${(ly += 19)}">${esc(n.line)}</text>`)
    // Each agent's row sits on the pane's grid: its context is live text the
    // pane lays at that row's right end, in the room the name leaves.
    const room = Math.max(12, Math.floor((width - 40 - 17 - LIVE_PX) / 6.8))
    for (const a of n.agents ?? []) {
      const row = Math.ceil((ly + 6) / ROW_PX)
      ly = Math.round(row * ROW_PX + 14)
      lines.push(`<text class="nl${a.level === undefined ? '' : ` ${a.level}`}" x="40" y="${ly}">${esc(clip(a.label, room))}</text>`)
      const spent = a.clock === undefined ? undefined : `${elapsed(a.clock, now)} · ${fmtTok(a.clock.tokens ?? 0)} spent`
      const text = [spent, a.context].filter(Boolean).join(' · ')
      if (text !== '') live.push({ id: a.id, top: row, text, level: a.contextLevel })
    }
    if (n.progress !== undefined) lines.push(`<text class="np" x="40" y="${(ly += 19)}">${esc(n.progress)}</text>`)
    // Each command on its own grid row, its clock live at the row's end; past
    // the slots, the last one says how many more run.
    if (n.clock !== undefined || n.cmds !== undefined) {
      const cmds = n.cmds ?? []
      const shown = cmds.length > CMD_SLOTS ? cmds.slice(0, CMD_SLOTS - 1) : cmds
      lines.push(`<text class="nh" x="40" y="${(ly += 22)}">Commands running</text>`)
      for (let i = 0; i < CMD_SLOTS; i++) {
        const row = Math.ceil((ly + 6) / ROW_PX)
        ly = Math.round(row * ROW_PX + 14)
        const c = shown[i]
        if (c === undefined) {
          const more = cmds.length - shown.length
          if (more > 0 && i === shown.length) lines.push(`<text class="nh" x="40" y="${ly}">+${more} more, under their steps on the path</text>`)
          else if (cmds.length === 0 && i === 0) lines.push(`<text class="nh" x="40" y="${ly}">None running over 3 seconds</text>`)
          continue
        }
        lines.push(cmdMark(c.isBg, 45, ly - 4))
        lines.push(`<text class="nl" x="56" y="${ly}">${esc(clip(`${c.who} · ${c.text}`, room - 3))}</text>`)
        if (c.isBg) lines.push(`<text class="nh" x="${width - 14}" y="${ly}" text-anchor="end">in background · end not visible</text>`)
        else live.push({ id: `now-cmd-${c.id}`, top: row, text: clockText(now - c.since), isAccent: true })
      }
    }
    if (n.hint !== undefined) lines.push(`<text class="nh" x="40" y="${(ly += 17)}">${esc(n.hint)}</text>`)
    const h = ly - y + 12
    const icon = n.kicker === 'Finished'
      ? `<circle cx="22" cy="${y + 22}" r="7" style="fill:none;stroke:var(--fg);stroke-width:1.4"/><path d="M19 ${y + 22.2}l2 2 4-4.4" style="fill:none;stroke:var(--fg);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round"/>`
      : mark(n.tone === 'run' ? 'active' : n.tone === 'wait' ? 'waiting' : 'paused', 22, y + 22)
    out.push(`<rect class="card" x="0.5" y="${y + 0.5}" width="100%" height="${h - 1}" rx="10" style="width:calc(100% - 1px)"/>`)
    out.push(icon)
    out.push(`<text class="k${n.tone === 'plain' ? '' : ` ${n.tone}`}" x="40" y="${y + 26}">${esc(n.kicker)}</text>`)
    const named = `<text class="nt" x="40" y="${y + 46}">${esc(n.title)}</text>${lines.slice(0, n.def === undefined ? 0 : 1).join('')}`
    out.push(motion === undefined ? named : `<g style="animation:${motion.css('mvFade', 0.3, 0.2)}">${named}</g>`)
    out.push(...lines.slice(n.def === undefined ? 0 : 1))
    y += h + TOP_GAP
  }
  if (v.jumps !== undefined) {
    out.push(`<text class="warn" x="0" y="${y + 4}">${esc(v.jumps)}</text>`)
    y += 20
  }

  // The path, then what the lane leaves out and the latest events: the left
  // column when the map sits beside it.
  const isWide = width >= WIDE_PX
  const colTop = y
  const left: string[] = []
  const rows: { id: string; y: number }[] = []
  // A path too tall for the pane drops its arc labels, then its second
  // lines, rather than run past the bottom.
  const offH = (v.offLanes === undefined ? 0 : 32 + TOP_GAP) + (v.steps.some(st => st.clock !== undefined) ? ROW_PX : 0)
  const subs = v.steps.reduce((k, st) => k + (st.subs?.length ?? 0), 0)
  // Commands get rows only on a path roomy enough for second lines.
  const cmdRows = v.steps.reduce((k, st) => k + (st.cmds?.length ?? 0) + (st.subs ?? []).filter(s => s.cmd !== undefined).length, 0)
  const pathH = (row: number, arc: number) => 24 + v.steps.length * row + subs * (row === STEP_ROW ? SUB_ROW : COMPACT_SUB_ROW)
    + (row === STEP_ROW ? cmdRows * CMD_ROW : 0) + Math.max(0, v.steps.length - 1) * arc + offH
  const arcGap = colTop + pathH(STEP_ROW, STEP_ARC) <= height ? STEP_ARC : 0
  const rowH = arcGap > 0 || colTop + pathH(STEP_ROW, 0) <= height ? STEP_ROW : COMPACT_ROW
  // Still too tall: the earliest finished steps fold into one line, then the
  // sub-steps keep their latest rows under a line counting the others.
  const rowsFit = Math.floor((height - colTop - 24 - offH) / COMPACT_ROW)
  const over = rowH === COMPACT_ROW ? v.steps.length + subs - rowsFit : 0
  const doneCount = v.steps.findIndex(st => st.state !== 'done')
  const foldable = doneCount < 0 ? v.steps.length : doneCount
  const folded = over > 0 && foldable >= 2 ? Math.min(foldable, over + 1) : 0
  const subCap = over > 0 ? Math.max(1, rowsFit - (v.steps.length - folded) - (folded > 0 ? 1 : 0)) : Infinity
  // Last resort: the steps still ahead fold into one line at the end.
  const subRows = Number.isFinite(subCap) ? Math.min(subs, subCap) : subs
  const stillOver = over > 0 ? (folded > 0 ? 1 : 0) + (v.steps.length - folded) + subRows - rowsFit : 0
  const firstAhead = v.steps.findIndex((st, i) => i >= folded && v.steps.slice(i).every(x => x.state === 'pending'))
  const ahead = stillOver > 0 && firstAhead >= 0 ? Math.min(v.steps.length - firstAhead, stillOver + 1) : 0
  const shown = v.steps.slice(folded, v.steps.length - ahead)
  if (v.steps.length > 0) {
    left.push(`<text class="h2" x="0" y="${y + 4}">Path</text>`)
    y += 14
    if (folded > 0) {
      left.push(mark('done', 8, y + 10))
      left.push(`<text class="sr" x="28" y="${y + 15}">${folded} earlier step${folded === 1 ? '' : 's'} done</text>`)
      left.push(`<line class="rail taken" x1="8" y1="${y + 21}" x2="8" y2="${y + COMPACT_ROW - 1}"/>`)
      y += COMPACT_ROW
    }
    // The column's right end, in the pane's columns from its right edge: the
    // separator when the map sits beside the path, else the pane's own edge.
    const metaRight = Math.max(0, Math.round(2 + (width - 14 - (isWide ? COL : width)) / COL_PX))
    // Text at the column's right end: the pane's edge when narrow, the separator when wide.
    const rightText = (cls: string, ty: number, text: string) => [
      `<text class="${cls} n" x="100%" y="${ty}" text-anchor="end">${esc(text)}</text>`,
      `<text class="${cls} w" x="${COL}" y="${ty}" text-anchor="end">${esc(text)}</text>`,
    ]
    // A command's row sits on the grid, its clock live at the row's right end;
    // one in the background says so in place of a clock. Returns its bottom.
    const cmdRow = (c: ViewCommand, top: number): number => {
      const row = gridRow(top + 12)
      const base = onGrid(row)
      left.push(cmdMark(c.isBg, 34, base - 4))
      left.push(`<text class="uo" x="50" y="${base}">${esc(clip(c.text, ((isWide ? COL : width) - 50 - 48) / 6))}</text>`)
      if (c.isBg) {
        left.push(`<text class="ue" x="50" y="${base + 14}">in background · end not visible</text>`)

        return base + 22
      }
      live.push({ id: `cmd-${c.id}`, top: row, text: clockText(now - c.since), isAccent: true, right: metaRight })

      return base + 8
    }
    if (shown[0]?.clock !== undefined) y = onGrid(gridRow(y + 15)) - 15
    shown.forEach((st, i) => {
      rows.push({ id: st.id, y })
      const dot = mark(st.state, 8, y + 10)
      left.push(motion?.arrival.to === st.id ? `<g class="mvp" style="animation:${motion.css('mvPop', 0.3, 0.55)}">${dot}</g>` : dot)
      left.push(`<text class="sl ${st.state}" x="28" y="${y + 15}">${esc(st.label)}</text>`)
      if (st.alert !== undefined) left.push(alertMark(st.alert, Math.round(28 + st.label.length * 7.7 + 12), y + 10))
      // Once known, what the step came to takes its role's place.
      if (rowH === STEP_ROW) {
        left.push(st.outcome === undefined
          ? `<text class="sr" x="28" y="${y + 30}">${esc(st.role)}</text>`
          : `<text class="so" x="28" y="${y + 30}">${esc(st.outcome)}</text>`)
      }
      if (st.clock !== undefined) {
        live.push({ id: `step-${st.id}`, top: gridRow(y + 15), text: stepText(st.clock, now), isAccent: true, right: metaRight })
      } else if (st.meta !== '') {
        left.push(`<text class="sm ${st.state} n" x="100%" y="${y + 15}" text-anchor="end">${esc(st.meta)}</text>`)
        left.push(`<text class="sm ${st.state} w" x="${COL}" y="${y + 15}" text-anchor="end">${esc(st.meta)}</text>`)
      }
      if (rowH === STEP_ROW && st.share !== undefined) left.push(...rightText('uo', y + 30, st.share))
      // Under the step, its own commands, then one row per agent it sent, the
      // rail running on beside them.
      const subH = rowH === STEP_ROW ? SUB_ROW : COMPACT_SUB_ROW
      const subTop = y + (rowH === STEP_ROW ? STEP_ROW - 6 : rowH)
      let sy = subTop
      if (rowH === STEP_ROW) for (const c of st.cmds ?? []) sy = cmdRow(c, sy)
      const all = st.subs ?? []
      const kept = all.length <= subCap ? all : all.slice(all.length - (subCap - 1))
      if (kept.length < all.length) {
        left.push(`<text class="uo" x="50" y="${sy + 12}">+${all.length - kept.length} more</text>`)
        sy += subH
      }
      for (const sub of kept) {
        const state = sub.state === 'done' ? '' : ` ${sub.state}`
        left.push(subMark(sub.state, 34, sy + 8))
        left.push(`<text class="ul" x="50" y="${sy + 12}">${esc(sub.label)}</text>`)
        if (sub.alert !== undefined) left.push(alertMark(sub.alert, Math.round(50 + sub.label.length * 7.1 + 11), sy + 8, 6))
        left.push(`<text class="sm${state} n" x="100%" y="${sy + 12}" text-anchor="end">${esc(sub.meta)}</text>`)
        left.push(`<text class="sm${state} w" x="${COL}" y="${sy + 12}" text-anchor="end">${esc(sub.meta)}</text>`)
        if (rowH === STEP_ROW && sub.outcome !== undefined) left.push(`<text class="uo" x="50" y="${sy + 26}">${esc(sub.outcome)}</text>`)
        if (rowH === STEP_ROW && sub.share !== undefined) left.push(...rightText('uo', sy + 26, sub.share))
        sy += subH
        if (rowH === STEP_ROW && sub.cmd !== undefined) sy = cmdRow(sub.cmd, sy)
      }
      // The row's bottom: the last sub-step's when it has any.
      const bottom = sy > subTop ? sy : y + rowH
      if (sy > subTop) left.push(`<line class="rail taken" x1="8" y1="${y + 21}" x2="8" y2="${bottom - 2}"/>`)
      // The row that counts lies on the grid: the gap before it stretches.
      const next = shown[i + 1]
      const gap = next?.clock === undefined ? arcGap : onGrid(gridRow(bottom + arcGap + 15)) - 15 - bottom
      if (next !== undefined) {
        const taken = st.arc?.isTaken === true ? ' taken' : ''
        const isGrowing = motion?.arrival.to === next.id && motion.arrival.from === st.id
        const grow = isGrowing ? ` mvg" style="animation:${motion.css('mvGrow', 0.35, 0)}` : ''
        left.push(`<line class="rail${taken}${grow}" x1="8" y1="${sy > subTop ? bottom - 2 : y + 21}" x2="8" y2="${bottom + gap - 1}"/>`)
        if (st.arc !== undefined && arcGap > 0) {
          left.push(`<text class="arc${taken}" x="28" y="${bottom + gap / 2 + 4}">${esc(st.arc.text)}</text>`)
        }
      }
      y = bottom + (next !== undefined ? gap : 0)
    })
    if (ahead > 0) {
      left.push(`<line class="rail" x1="8" y1="${y - COMPACT_ROW + 21}" x2="8" y2="${y + 4}"/>`)
      left.push(mark('pending', 8, y + 10))
      left.push(`<text class="sr" x="28" y="${y + 15}">${ahead} more step${ahead === 1 ? '' : 's'} ahead</text>`)
      y += COMPACT_ROW
    }
    y += 10
  }
  if (v.offLanes !== undefined) {
    left.push(`<rect class="off n" x="0.5" y="${y + 0.5}" width="100%" height="31" rx="10" style="width:calc(100% - 1px)"/>`)
    left.push(`<rect class="off w" x="0.5" y="${y + 0.5}" width="${COL - 1}" height="31" rx="10"/>`)
    left.push(`<text class="offt" x="14" y="${y + 21}">${esc(v.offLanes)}</text>`)
    y += 32 + TOP_GAP
  }
  // The latest events and the footnote are drawn whole or not at all, and a
  // narrow pane gives up the events first if the map then fits readably.
  const NOTE_H = 34
  const recentH = v.recent.length > 0 ? 22 + v.recent.length * RECENT_LINE + 6 : 0
  const fit = (top: number) => Math.max(0, Math.min(1, (height - top) / MAP.H, width / MAP.W))
  const pathBottom = y
  const isRecentShown = recentH > 0 && y + recentH + NOTE_H <= height
    && (isWide || fit(y + recentH + NOTE_H + TOP_GAP) >= MIN_MAP_SCALE || fit(y + NOTE_H + TOP_GAP) < MIN_MAP_SCALE)
  if (isRecentShown) {
    left.push(`<text class="h2" x="0" y="${y + 4}">Recent</text>`)
    v.recent.forEach((l, i) => {
      const ry = y + 24 + i * RECENT_LINE
      left.push(`<text class="ra" x="0" y="${ry}">${esc(l.at)}</text><text class="rt" x="64" y="${ry}">${esc(l.text)}</text>`)
    })
    y += recentH
  }
  if (y + NOTE_H <= height) {
    for (const [i, line] of ['Tokens are cost-equivalent: a reread', 'counts 0.1, a written token 5.'].entries()) {
      left.push(`<text class="nh" x="0" y="${y + 4 + i * 16}">${line}</text>`)
    }
    y += NOTE_H
  }

  // Below the path the map takes what height is left, never more than its own
  // size, and only at a size it can be read at; else a line says to widen it.
  const narrowTop = Math.max(y, pathBottom) + TOP_GAP
  const scale = fit(narrowTop)
  const isNarrowMap = scale >= MIN_MAP_SCALE
  if (!isWide && !isNarrowMap && narrowTop + 8 <= height) left.push(`<text class="nh n" x="0" y="${narrowTop + 4}">Widen the pane to see the whole map.</text>`)
  // Right of the separator the map takes all the width left, scaled to that
  // and to the room below the path's top: the image is as tall as that drawing.
  const wideScale = Math.min((width - MAP_X) / MAP.W, (height - colTop) / MAP.H)
  const narrowMap = !isNarrowMap ? '' : `<g class="n" transform="translate(${-MAP.W * scale / 2} 0)"><svg x="50%" y="${narrowTop}" `
    + `width="${MAP.W * scale}" height="${MAP.H * scale}" viewBox="0 0 ${MAP.W} ${MAP.H}">${movingMap(v.svg, motion)}</svg></g>`
  const wideMap = `<svg class="w" x="${MAP_X}" y="${colTop}" width="${width - MAP_X}" height="${height - colTop}" `
    + `viewBox="0 0 ${MAP.W} ${MAP.H}" preserveAspectRatio="xMidYMin meet">${movingMap(v.svg, motion)}</svg>`
  // As tall as what it draws, at most the pane: never a scroll.
  const content = isWide ? colTop + MAP.H * wideScale : isNarrowMap ? narrowTop + MAP.H * scale : narrowTop + 12
  const drawn = Math.ceil(Math.min(height, Math.max(y, content) + 4))
  const separator = `<line class="sep w" x1="${SEP}" y1="${colTop}" x2="${SEP}" y2="${drawn - 4}"/>`

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${drawn}">`
      + `<style>${STYLE}${motion === undefined ? '' : KEYFRAMES}</style>`
      + `<defs>${markers()}<clipPath id="col"><rect width="${COL}" height="${height}"/></clipPath></defs>`
      + out.join('')
      + `<g class="left">${left.join('')}</g>`
      + separator
      + narrowMap
      + wideMap
      + '</svg>',
    width,
    height: drawn,
    rows,
    live,
  }
}
