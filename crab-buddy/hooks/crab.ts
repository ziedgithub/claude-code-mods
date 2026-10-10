// The Claude Code crab drawn in block glyphs: each terminal cell holds four pixels, two
// across and two down, in at most two colors, the finest a terminal's text can draw. The
// crab, 16 columns by 4 rows, is shaded with a lighter top and left edge and a darker right
// and underside. The columns past it hold the glyphs of its moods (the `z` of sleep, the
// sparks of a finished answer, the bubble of a thought). In a narrow band, as on a phone, a
// smaller crab of 12 columns stands in for it, its glyphs over its head to spare the
// columns. Ahead of it stands a small crab for each subagent, dressed for its agent's kind
// of work, living its agent's moods as the crab lives the main loop's, its glyphs over its
// head. While an agent's own transcript is in view, its crab stands alone at the crab's own
// size, its outfit drawn again at that size
import { COSTUME_COLORS, COSTUMES, FULL_COSTUMES } from './costumes'
import type { Costume, FullOutfit, Outfit } from './costumes'

export type { Costume } from './costumes'
export type Mood = 'idle' | 'working' | 'thinking' | 'happy' | 'sleeping'
export type Activity = { isWorking: boolean; isThinking: boolean; endedAt: number; isCheering: boolean }
// A subagent at work, waiting for a message, or done; `since` is when it became so
export type MiniPhase = 'running' | 'waiting' | 'done'
export type AgentActivity = { phase: MiniPhase; isThinking: boolean; since: number }
// A small crab wears the costume of its agent's kind of work; without one, as a fork or a
// type no costume fits, it goes bare in its own color and works at a laptop as the crab does
export type Mini = { color: number; mood: Mood; costume: Costume | null }
// A message on its way from a small crab to the crab: `from` is the sender's place among
// the small crabs, one past the drawn ones flying from their count; `progress` runs 0 to 1
export type Flight = { from: number; color: number; progress: number }
// `hidden`: the small crabs past the drawn ones, counted as `+N`; `isCompact`: the smaller crab
export type Scene = { mood: Mood; minis: readonly Mini[]; hidden: number; flights: readonly Flight[]; isCompact: boolean }

export const FRAME_MS = 250
export const PERSONA_ROWS = 4
export const MAX_MINIS = 8
// A band narrower than this, as on a phone, takes the smaller crab
export const COMPACT_BELOW = 80
// Each cell holds two pixels across and two down
const CELL_PIXELS = 2
// The small crab is 14 pixels wide, standing on the band's floor, the top of its head on the
// fourth pixel row under its hat; the six pixel columns at its right hold its tool
const MINI_BODY_PIXELS = 14
const MINI_TOOL_PIXELS = 6
const MINI_COLUMNS = (MINI_BODY_PIXELS + MINI_TOOL_PIXELS) / CELL_PIXELS
const MINI_HEAD_ROW = 3
// Its glyph shows in the top row, over its tool, clear of its hat
const MINI_GLYPH_ROW = 0
const MINI_GLYPH_COLUMN = MINI_BODY_PIXELS / CELL_PIXELS
const MINI_GAP = 1
// Each small crab keeps its own time, so they neither blink nor type in step
const MINI_TICK_SHIFT = 7
const HAPPY_FRAMES = 20
// A done subagent's small crab cheers as long as the crab does, then leaves
export const CHEER_FRAMES = HAPPY_FRAMES
const SLEEP_FRAMES = 240
const BLINK_EVERY = 16
const GLANCE_EVERY = 64
const GLANCE_FRAMES = 8
const Z_FRAMES = 3
const GLOW_FRAMES = 4
const BUBBLE_FRAMES = 2

const DEFAULT_COLOR = 0x01000000
// The `claude` color of Claude Code's theme, the one of its welcome crab
export const CLAUDE_COLOR = 0xd77757
const Z_COLOR = 0x8b949e
const SPARK_COLOR = 0xe3b341
const BUBBLE_COLOR = 0xd2a8ff
const COUNT_COLOR = 0x8b949e
const PAPER_COLOR = 0xf0f6fc
// A white envelope, its flap in the sender's color
const ENVELOPE = ['PFFFFP', 'PPFFPP']
const ENVELOPE_PIXELS = 6
// It leaves from over the sender's head and arcs this many pixels higher on its way
const ENVELOPE_TOP = 2
const FLIGHT_ARC = 2
// An empty pixel counts as a dark terminal's background when a cell must give up a color
const BACKDROP = 0x1e1e1e

type Palette = Readonly<Record<string, number>>

const mixColor = (from: number, to: number, amount: number): number => {
  let mixed = 0
  for (const shift of [16, 8, 0]) {
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff
    mixed |= Math.round(a + (b - a) * amount) << shift
  }
  return mixed
}

// `E` eyes, `W` their glint, `K` shut eyes, `P` blush, and the laptop: `L` lid, `G` and `N`
// its logo's two glows, `B` base
const FIXED: Palette = {
  E: 0x1c1c22,
  W: 0xffffff,
  K: 0x4b2318,
  P: 0xff9696,
  L: 0x8b949e,
  G: 0xf0f6fc,
  N: 0x58a6ff,
  B: 0x6e7681,
}

// `H` highlight, `O` the color itself, `S` shadow, `D` the darkest, for feet and shut eyes
export const paletteFor = (color: number): Palette => ({
  ...FIXED,
  H: mixColor(color, 0xffffff, 0.28),
  O: color,
  S: mixColor(color, 0x000000, 0.25),
  D: mixColor(color, 0x000000, 0.5),
})

const CRAB_PALETTE = paletteFor(CLAUDE_COLOR)

// The color a small crab's messages carry on their flap: its costume's, else its own
export const flapColorOf = (mini: Pick<Mini, 'color' | 'costume'>): number =>
  mini.costume === null ? mini.color : COSTUMES[mini.costume].flap

// Blinks now and then, and looks left, then later right, as if around the room
type Gaze = 'ahead' | 'left' | 'right' | 'shut'

type Cell = { row: number; column: number }

// One size of the crab: its head and standing body around the eyes of each gaze, and its
// whole sprite in the other poses, each as tall as the band; then where its glyphs show
type CrabArt = {
  columns: number
  // The columns past it its glyphs take
  markColumns: number
  // A thought's bubble and sleep's `z`s, one cell after the other
  rise: readonly Cell[]
  // Sparks as it jumps up and as it lands, where it leaves room for them
  sparkUp: Cell | null
  sparkDown: Cell
  head: readonly string[]
  eyes: Readonly<Record<Gaze, readonly string[]>>
  standing: readonly string[]
  // Behind a laptop seen from the back, one claw up, the logo on its lid in one glow
  working: (isLeftUp: boolean, glow: string) => readonly string[]
  // One claw up at its head, eyes turned to the bubble
  pondering: readonly string[]
  jumping: readonly string[]
  landed: readonly string[]
  asleep: readonly string[]
}

// The crab, 32 pixels by 8: its head's corners rounded, eyes four pixels by two with a glint
// in one, pincers open at the ends of its claws, four legs splayed out
const FULL_HEAD = ['.......HHHHHHHHHHHHHHHHHS.......', '......HHOOOOOOOOOOOOOOOOSS......']
const FULL_GLINTING_EYES = '......HOOOWEEEOOOOWEEEOOOS......'
const FULL_EYES_AHEAD = [FULL_GLINTING_EYES, 'O.O...HOOOEEEEOOOOEEEEOOOS...O.O']
const FULL_UNDERSIDE = '......SSSSSSSSSSSSSSSSSSSS......'
const FULL_LEGS = ['.........S...S....S...S.........', '........S...S......S...S........']
const FULL_STANDING = ['OOOOOOOOOOOOOOOOOOOOOOOOOSOOOOOO', FULL_UNDERSIDE, ...FULL_LEGS]
const FULL_LID = '......LLLLLLLLLLLLLLLLLLLL......'

const FULL: CrabArt = {
  columns: 16,
  markColumns: 3,
  rise: [
    { row: 2, column: 16 },
    { row: 1, column: 17 },
    { row: 0, column: 18 },
  ],
  sparkUp: { row: 0, column: 16 },
  sparkDown: { row: 1, column: 17 },
  head: FULL_HEAD,
  eyes: {
    ahead: FULL_EYES_AHEAD,
    left: ['......HOWEEEOOOOWEEEOOOOOS......', 'O.O...HOEEEEOOOOEEEEOOOOOS...O.O'],
    right: ['......HOOOOOWEEEOOOOWEEEOS......', 'O.O...HOOOOOEEEEOOOOEEEEOS...O.O'],
    shut: ['......HOOOOOOOOOOOOOOOOOOS......', 'O.O...HOOOKKKKOOOOKKKKOOOS...O.O'],
  },
  standing: FULL_STANDING,
  working: (isLeftUp, glow) => [
    ...FULL_HEAD,
    isLeftUp ? '..O.O.HOOOWEEEOOOOWEEEOOOS......' : '......HOOOWEEEOOOOWEEEOOOS.O.O..',
    isLeftUp ? '..OOOOHOOOEEEEOOOOEEEEOOOS......' : '......HOOOEEEEOOOOEEEEOOOSOOOO..',
    isLeftUp ? `....OOLLLLLLLLL${glow}${glow}LLLLLLLLLSSSS..` : `..OOOOLLLLLLLLL${glow}${glow}LLLLLLLLLSS....`,
    `......LLLLLLLL${glow.repeat(4)}LLLLLLLL......`,
    FULL_LID,
    '....BBBBBBBBBBBBBBBBBBBBBBBB....',
  ],
  pondering: [
    '.......HHHHHHHHHHHHHHHHHS.O.O...',
    '......HHOOOOOOOOOOOOOOOOSSOO....',
    '......HOOOOOWEEEOOOOWEEEOSOO....',
    'O.O...HOOOOOEEEEOOOOEEEEOSSS....',
    'OOOOOOOOOOOOOOOOOOOOOOOOOS......',
    FULL_UNDERSIDE,
    ...FULL_LEGS,
  ],
  jumping: [
    'O.O...HHHHHHHHHHHHHHHHHHSS...O.O',
    'OOOO..HOOOOOOOOOOOOOOOOOOS..OOOO',
    '..OOOOHOOOWEEEOOOOWEEEOOOSOOOO..',
    '......HOOOEEEEOOOOEEEEOOOS......',
    '......OOPPOOOOOOOOOOOOPPOS......',
    FULL_UNDERSIDE,
    '.......S...S........S...S.......',
    '................................',
  ],
  landed: [...FULL_HEAD, ...FULL_EYES_AHEAD, 'OOOOOOOOPPOOOOOOOOOOOOPPOSOOOOOO', FULL_UNDERSIDE, ...FULL_LEGS],
  asleep: [
    '................................',
    '.......HHHHHHHHHHHHHHHHHS.......',
    '......HHOOOOOOOOOOOOOOOOSS......',
    '......HOOOOOOOOOOOOOOOOOOS......',
    '......HOOOKKKKOOOOKKKKOOOS......',
    '..OOOOHOOOOOOOOOOOOOOOOOOSOOOO..',
    FULL_UNDERSIDE,
    '......DDDD..DD....DD..DDDD......',
  ],
}

// The smaller crab, 24 pixels by 6 under two empty rows: eyes a cell each, glinting, under a
// row of forehead; its glyphs take the top row, over its head and its raised claw
const COMPACT_HEAD = [
  '........................',
  '........................',
  '.....HHHHHHHHHHHHHS.....',
  '....HHOOOOOOOOOOOOSS....',
]
const COMPACT_GLINTING_EYES = 'O.O.HOOOWEOOOOWEOOOS.O.O'
const COMPACT_UNDERSIDE = '....SSSSSSSSSSSSSSSS....'
const COMPACT_LEGS = '......S..S....S..S......'
const COMPACT_STANDING = [COMPACT_UNDERSIDE, COMPACT_LEGS]

const COMPACT: CrabArt = {
  columns: 12,
  markColumns: 0,
  rise: [
    { row: 0, column: 9 },
    { row: 0, column: 10 },
    { row: 0, column: 11 },
  ],
  sparkUp: null,
  sparkDown: { row: 0, column: 10 },
  head: COMPACT_HEAD,
  eyes: {
    ahead: [COMPACT_GLINTING_EYES, 'OOOOHOOOEEOOOOEEOOOSOOOO'],
    left: ['O.O.HOWEOOOOWEOOOOOS.O.O', 'OOOOHOEEOOOOEEOOOOOSOOOO'],
    right: ['O.O.HOOOOOWEOOOOWEOS.O.O', 'OOOOHOOOOOEEOOOOEEOSOOOO'],
    shut: ['O.O.HOOOOOOOOOOOOOOS.O.O', 'OOOOHOOOKKOOOOKKOOOSOOOO'],
  },
  standing: COMPACT_STANDING,
  working: (isLeftUp, glow) => [
    ...COMPACT_HEAD.slice(0, 3),
    isLeftUp ? '..O.HHOOOOOOOOOOOOSS....' : '....HHOOOOOOOOOOOOSS.O..',
    isLeftUp ? '..OOHOOOEEOOOOEEOOOS....' : '....HOOOEEOOOOEEOOOSOO..',
    isLeftUp ? '....OOLLLLLLLLLLLLSSSS..' : '..SSOOLLLLLLLLLLLLSS....',
    `....LLLLLL${glow.repeat(4)}LLLLLL....`,
    '..BBBBBBBBBBBBBBBBBBBB..',
  ],
  pondering: [
    '........................',
    '........................',
    '.....HHHHHHHHHHHHHS.O.O.',
    '....HHOOOOOOOOOOOOSSOO..',
    'O.O.HOOOOOEEOOOOEEOSSS..',
    'OOOOHOOOOOOOOOOOOOOS....',
    ...COMPACT_STANDING,
  ],
  jumping: [
    'O.O..HHHHHHHHHHHHHS..O.O',
    'OOOOHHOOOOOOOOOOOOSSOOOO',
    '....HOOOWEOOOOWEOOOS....',
    '....HOPPEEOOOOEEPPOS....',
    COMPACT_UNDERSIDE,
    COMPACT_LEGS,
    '........................',
    '........................',
  ],
  landed: [...COMPACT_HEAD, COMPACT_GLINTING_EYES, 'OOOOHOPPEEOOOOEEPPOSOOOO', ...COMPACT_STANDING],
  asleep: [
    '........................',
    '........................',
    '........................',
    '.....HHHHHHHHHHHHHS.....',
    '....HHOOOOOOOOOOOOSS....',
    '....HOOOOOOOOOOOOOOS....',
    'OOOOOOOOKKOOOOKKOOOOOOOO',
    '....DDSSSSSSSSSSSSDD....',
  ],
}

// The small crab, 14 by 5 at two pixels a column: eyes a cell each with a glint, claws out
// at its sides, four thin legs. Its head's top row hides under a hat
const MINI_TOP = '...HHHHHHHH...'
const MINI_UNDERSIDE = '..SSSSSSSSSS..'
const MINI_LEGS = '..S.S....S.S..'
const MINI_GAZE: Record<Gaze, readonly string[]> = {
  ahead: ['..OOWEOOWEOO..', 'OOOOEEOOEEOOOO'],
  left: ['..WEOOWEOOOO..', 'OOEEOOEEOOOOOO'],
  right: ['..OOOOWEOOWE..', 'OOOOOOEEOOEEOO'],
  shut: ['..OOOOOOOOOO..', 'OOOOKKOOKKOOOO'],
}
// Peeking over a laptop seen from the back, one claw up, the logo on its lid in one glow
const miniTyping = (isLeftUp: boolean, glow: string): readonly string[] => [
  MINI_TOP,
  isLeftUp ? 'OOOOEEOOEEOO..' : '..OOEEOOEEOOOO',
  isLeftUp ? '..LLLLLLLLLLOO' : 'OOLLLLLLLLLL..',
  `..LLLL${glow}${glow}LLLL..`,
  '.BBBBBBBBBBBB.',
]
// Eyes up to its raised claw
const MINI_PONDERING = [MINI_TOP, '..OOOOEEOOEEOO', 'OOOOOOOOOOOOO.', MINI_UNDERSIDE, MINI_LEGS]
// Eyes shut in arcs over flushed cheeks, claws out, then up
const MINI_LANDED = [MINI_TOP, '..OOEEOOEEOO..', 'OOPPOOOOOOPPOO', MINI_UNDERSIDE, MINI_LEGS]
const MINI_CHEERING = [MINI_TOP, 'O.OOEEOOEEOO.O', '.OPPOOOOOOPPO.', MINI_UNDERSIDE, MINI_LEGS]
// Sat down, eyes shut, claws on the ground
const MINI_ASLEEP = [MINI_TOP, '..OOOOOOOOOO..', '.OOOKKOOKKOOO.', 'OOSSSSSSSSSSOO', MINI_UNDERSIDE]

type Mark = { row: number; column: number; glyph: string; color: number }
type Pose = { sprite: readonly string[]; marks: readonly Mark[] }

export const IDLE: Activity = { isWorking: false, isThinking: false, endedAt: -SLEEP_FRAMES, isCheering: false }

// A subagent's small crab works, thinks, cheers once done, and falls asleep after a minute
// of waiting, as the crab does for the main loop
export const agentMoodFor = (agent: AgentActivity, tick: number): Mood => {
  if (agent.phase === 'running') return agent.isThinking ? 'thinking' : 'working'
  if (agent.phase === 'done') return 'happy'
  return tick - agent.since >= SLEEP_FRAMES ? 'sleeping' : 'idle'
}

// A finished answer cheers for a moment; a quiet session falls asleep after a minute
export const moodFor = (activity: Activity, tick: number): Mood => {
  if (activity.isWorking) return activity.isThinking ? 'thinking' : 'working'
  const quiet = tick - activity.endedAt
  if (activity.isCheering && quiet < HAPPY_FRAMES) return 'happy'
  return quiet >= SLEEP_FRAMES ? 'sleeping' : 'idle'
}

const gazeAt = (tick: number): Gaze => {
  if (tick % BLINK_EVERY === 0) return 'shut'
  const glance = tick % GLANCE_EVERY
  if (glance >= 20 && glance < 20 + GLANCE_FRAMES) return 'left'
  return glance >= 44 && glance < 44 + GLANCE_FRAMES ? 'right' : 'ahead'
}

// The crab's poses in one of its sizes
const posesOf = (art: CrabArt): Record<Mood, (tick: number) => Pose> => {
  const rising = (glyphs: string, color: number): Mark[] => art.rise.map((cell, i) => ({ ...cell, glyph: glyphs.charAt(i), color }))
  return {
    idle: tick => ({ sprite: [...art.head, ...art.eyes[gazeAt(tick)], ...art.standing], marks: [] }),
    // Typing, one claw up and one down in turn, the logo pulsing between two glows
    working: tick => ({ sprite: art.working(tick % 2 === 0, Math.floor(tick / GLOW_FRAMES) % 2 === 0 ? 'G' : 'N'), marks: [] }),
    // A bubble beside its raised claw grows one dot at a time, holds whole, then starts over
    thinking: tick => {
      const phase = Math.floor(tick / BUBBLE_FRAMES) % 4
      return { sprite: art.pondering, marks: rising('.oO', BUBBLE_COLOR).slice(0, Math.min(phase, 2) + 1) }
    },
    // Jumps with its claws up and its cheeks flushed, sparks flying
    happy: tick => {
      const isUp = tick % 2 === 1
      const spark = isUp ? art.sparkUp : art.sparkDown
      const marks = spark === null ? [] : [{ ...spark, glyph: isUp ? '*' : '+', color: SPARK_COLOR }]
      return { sprite: isUp ? art.jumping : art.landed, marks }
    },
    // Slumped, eyes shut, claws down, and a `z` rising one step at a time before the next starts low
    sleeping: tick => {
      const phase = Math.floor(tick / Z_FRAMES) % 4
      return { sprite: art.asleep, marks: phase === 3 ? [] : rising('zzZ', Z_COLOR).slice(0, phase + 1) }
    },
  }
}

const FULL_POSES = posesOf(FULL)
const COMPACT_POSES = posesOf(COMPACT)

// The small crab's poses; its one glyph a pose shows sits in the top row
const glyphOver = (glyph: string, color: number, column = MINI_GLYPH_COLUMN): Mark[] => [
  { row: MINI_GLYPH_ROW, column, glyph, color },
]

const standing = (gaze: Gaze): readonly string[] => [MINI_TOP, ...MINI_GAZE[gaze], MINI_UNDERSIDE, MINI_LEGS]

const MINI_POSES: Record<Mood, (tick: number) => Pose> = {
  idle: tick => ({ sprite: standing(gazeAt(tick)), marks: [] }),
  working: tick => ({ sprite: miniTyping(tick % 2 === 0, Math.floor(tick / GLOW_FRAMES) % 2 === 0 ? 'G' : 'N'), marks: [] }),
  thinking: tick => ({ sprite: MINI_PONDERING, marks: glyphOver('.oOO'.charAt(Math.floor(tick / BUBBLE_FRAMES) % 4), BUBBLE_COLOR) }),
  // Claws up and down in turn, too small to leave the ground
  happy: tick => {
    const isUp = tick % 2 === 1
    return { sprite: isUp ? MINI_CHEERING : MINI_LANDED, marks: glyphOver(isUp ? '*' : '+', SPARK_COLOR, MINI_GLYPH_COLUMN + (isUp ? 0 : 1)) }
  },
  sleeping: tick => {
    const glyph = 'zZ'.charAt(Math.floor(tick / Z_FRAMES) % 3)
    return { sprite: MINI_ASLEEP, marks: glyph === '' ? [] : glyphOver(glyph, Z_COLOR) }
  },
}

// Dressed, it stands while idle, uses its tool while its agent works, its eyes on it, and in
// its other moods holds it as it thinks, cheers or sleeps
const dressedPose = (outfit: Outfit, mood: Mood, tick: number): { sprite: readonly string[]; tool: readonly string[] } => {
  if (mood === 'working') return { sprite: standing('right'), tool: outfit.work[tick % outfit.work.length] ?? outfit.tool }
  return { sprite: MINI_POSES[mood](tick).sprite, tool: outfit.tool }
}

const countText = (hidden: number): string => (hidden > 0 ? `+${hidden}` : '')

// The small crabs and their count take the left, a gap, then the crab and its glyphs
export const sceneColumns = (minis: number, hidden: number, isCompact: boolean): number => {
  const count = countText(hidden)
  const crew = minis * (MINI_COLUMNS + MINI_GAP) + (count === '' ? 0 : count.length + MINI_GAP)
  const art = isCompact ? COMPACT : FULL
  return crew + art.columns + art.markColumns
}

// As many small crabs as the band has room for beside the crab, at most MAX_MINIS, the
// others counted
export const minisThatFit = (members: number, bodyColumns: number, isCompact: boolean): number => {
  for (let shown = Math.min(members, MAX_MINIS); shown > 0; shown--) {
    if (sceneColumns(shown, members - shown, isCompact) <= bodyColumns) return shown
  }
  return 0
}

// `columns` counts cells; `pixels` holds two to a cell across and down, its rows as many as
// the cells' rows take, and `marks` sit in cells
type Canvas = { columns: number; pixels: (number | null)[][]; marks: Mark[] }

const blankCanvas = (columns: number, rows: number): Canvas => ({
  columns,
  pixels: Array.from({ length: rows * CELL_PIXELS }, () => Array<number | null>(columns * CELL_PIXELS).fill(null)),
  marks: [],
})

const stamp = (canvas: Canvas, sprite: readonly string[], palette: Palette, left: number, top: number): void => {
  sprite.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      const color = palette[line.charAt(x)]
      const row = canvas.pixels[top + y]
      if (color !== undefined && row !== undefined && left + x < row.length) row[left + x] = color
    }
  })
}

// A bare small crab in its own color; a dressed one in its wear, its hat over the top of its
// head, its tool at its right
const drawMini = (canvas: Canvas, mini: Mini, tick: number, column: number): void => {
  const left = column * CELL_PIXELS
  const pose = MINI_POSES[mini.mood](tick)
  for (const mark of pose.marks) canvas.marks.push({ ...mark, column: column + mark.column })
  if (mini.costume === null) {
    stamp(canvas, pose.sprite, paletteFor(mini.color), left, MINI_HEAD_ROW)
    return
  }
  const outfit = COSTUMES[mini.costume]
  const palette = { ...paletteFor(mini.color), ...COSTUME_COLORS }
  const { sprite, tool } = dressedPose(outfit, mini.mood, tick)
  stamp(canvas, sprite, palette, left, MINI_HEAD_ROW)
  stamp(canvas, outfit.wear, palette, left, MINI_HEAD_ROW + 1)
  stamp(canvas, outfit.hat, palette, left, MINI_HEAD_ROW + 1 - outfit.hat.length)
  stamp(canvas, tool, palette, left + MINI_BODY_PIXELS, 0)
}

export const composeScene = (scene: Scene, tick: number): Canvas => {
  const canvas = blankCanvas(sceneColumns(scene.minis.length, scene.hidden, scene.isCompact), PERSONA_ROWS)
  let left = 0
  scene.minis.forEach((mini, place) => {
    drawMini(canvas, mini, tick + place * MINI_TICK_SHIFT, left)
    left += MINI_COLUMNS + MINI_GAP
  })
  const count = countText(scene.hidden)
  for (let i = 0; i < count.length; i++) canvas.marks.push({ row: PERSONA_ROWS - 1, column: left + i, glyph: count.charAt(i), color: COUNT_COLOR })
  const countLeft = left
  if (count !== '') left += count.length + MINI_GAP
  const pose = (scene.isCompact ? COMPACT_POSES : FULL_POSES)[scene.mood](tick)
  stamp(canvas, pose.sprite, CRAB_PALETTE, left * CELL_PIXELS, 0)
  for (const mark of pose.marks) canvas.marks.push({ ...mark, column: left + mark.column })
  for (const flight of scene.flights) {
    const start = flight.from < scene.minis.length
      ? flight.from * (MINI_COLUMNS + MINI_GAP) * CELL_PIXELS + (MINI_BODY_PIXELS - ENVELOPE_PIXELS) / 2
      : countLeft * CELL_PIXELS
    const { column, row } = flightPoint(start, left * CELL_PIXELS, flight.progress)
    stamp(canvas, ENVELOPE, { P: PAPER_COLOR, F: flight.color }, column, row)
  }
  return canvas
}

// Eased along the row so it sets off and lands gently, lifted most halfway; in pixels
export const flightPoint = (start: number, end: number, progress: number): { column: number; row: number } => {
  const t = Math.min(1, Math.max(0, progress))
  const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
  return { column: Math.round(start + (end - start) * eased), row: Math.round(ENVELOPE_TOP - FLIGHT_ARC * 4 * t * (1 - t)) }
}

// The block glyph of each set of a cell's four pixels, by bit: top left 1, top right 2,
// bottom left 4, bottom right 8
const QUADRANTS = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b, 0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588]

const distance = (a: number | null, b: number | null): number => {
  const from = a ?? BACKDROP
  const to = b ?? BACKDROP
  let sum = 0
  for (const shift of [16, 8, 0]) {
    const step = ((from >> shift) & 0xff) - ((to >> shift) & 0xff)
    sum += step * step
  }
  return sum
}

// A cell of four pixels: its glyph paints the foreground's pixels and leaves the background's,
// an empty pixel the terminal's own. A cell of more than two colors keeps the pair that
// draws it closest, the most used first, each other pixel taking the nearer of them
const cellOf = (pixels: readonly (number | null)[]): [number, number, number] => {
  const counts = new Map<number | null, number>()
  for (const pixel of pixels) counts.set(pixel, (counts.get(pixel) ?? 0) + 1)
  const colors = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
  let pair: (number | null)[] = colors.slice(0, 2)
  if (colors.length > 2) {
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const a = colors[i] ?? null
        const b = colors[j] ?? null
        const cost = pixels.reduce<number>((sum, pixel) => sum + Math.min(distance(pixel, a), distance(pixel, b)), 0)
        if (cost < best) {
          best = cost
          pair = [a, b]
        }
      }
    }
  }
  const [first = null, second = null] = pair
  const back = first === null ? first : second
  const fore = first === null ? second : first
  if (fore === null) return [0x20, DEFAULT_COLOR, DEFAULT_COLOR]
  if (back === null && pair.length === 1) return [0x20, DEFAULT_COLOR, fore]
  let set = 0
  pixels.forEach((pixel, bit) => {
    if (pixel === fore || (pixel !== back && distance(pixel, fore) < distance(pixel, back))) set |= 1 << bit
  })
  return [QUADRANTS[set] ?? 0x20, fore, back ?? DEFAULT_COLOR]
}

// The Raster's `cells`: row-major `[codePoint, foreground, background]` u32 triplets in base64
export const encodeCanvas = (canvas: Canvas): string => {
  const words: number[] = []
  for (let row = 0; row < canvas.pixels.length / CELL_PIXELS; row++) {
    const top = canvas.pixels[row * CELL_PIXELS] ?? []
    const bottom = canvas.pixels[row * CELL_PIXELS + 1] ?? []
    for (let column = 0; column < canvas.columns; column++) {
      const mark = canvas.marks.find(m => m.row === row && m.column === column)
      if (mark !== undefined) {
        words.push(mark.glyph.charCodeAt(0), mark.color, DEFAULT_COLOR)
      } else {
        const x = column * CELL_PIXELS
        words.push(...cellOf([top[x] ?? null, top[x + 1] ?? null, bottom[x] ?? null, bottom[x + 1] ?? null]))
      }
    }
  }
  return new Uint8Array(Uint32Array.from(words).buffer).toBase64()
}

export const drawScene = (scene: Scene, tick: number): { columns: number; cells: string } => {
  const canvas = composeScene(scene, tick)
  return { columns: canvas.columns, cells: encodeCanvas(canvas) }
}

// A dressed agent's crab at the crab's own size: its hat's four rows over its head, the
// crab under them, its tool in the ten pixel columns right of its claw, its glyphs over its
// right shoulder, between its hat and its tool
const AGENT_HAT_PIXELS = 4
const AGENT_TOOL_PIXELS = 10
export const AGENT_COLUMNS = FULL.columns + AGENT_TOOL_PIXELS / CELL_PIXELS
export const AGENT_ROWS = PERSONA_ROWS + AGENT_HAT_PIXELS / CELL_PIXELS
const AGENT_ART: CrabArt = {
  ...FULL,
  rise: [
    { row: 1, column: 13 },
    { row: 0, column: 14 },
    { row: 0, column: 15 },
  ],
  sparkUp: { row: 0, column: 15 },
  sparkDown: { row: 1, column: 14 },
}
const AGENT_POSES = posesOf(AGENT_ART)

// Dressed, it stands while idle, uses its tool while its agent works, its eyes on it, and in
// its other moods holds it as it thinks, cheers or sleeps; asleep, its head sits a row lower
const agentPose = (outfit: FullOutfit, mood: Mood, tick: number): { sprite: readonly string[]; tool: readonly string[]; marks: readonly Mark[]; drop: number } => {
  if (mood === 'working') return { sprite: [...FULL_HEAD, ...FULL.eyes.right, ...FULL_STANDING], tool: outfit.work[tick % outfit.work.length] ?? outfit.tool, marks: [], drop: 0 }
  const pose = AGENT_POSES[mood](tick)
  return { sprite: pose.sprite, tool: outfit.tool, marks: pose.marks, drop: mood === 'sleeping' ? 1 : 0 }
}

// A small crab alone at its own size, where the band lacks the rows for its hat
export const drawLone = (mini: Mini, tick: number): { columns: number; rows: number; cells: string } => {
  const canvas = blankCanvas(MINI_COLUMNS, PERSONA_ROWS)
  drawMini(canvas, mini, tick, 0)
  return { columns: canvas.columns, rows: PERSONA_ROWS, cells: encodeCanvas(canvas) }
}

// An agent's crab drawn alone at the crab's own size, as the band draws it while the agent's
// transcript is in view. Bare, it is the crab in its agent's color, at work on its laptop;
// dressed, it wears its outfit drawn at that size
export const drawAgent = (mini: Mini, tick: number): { columns: number; rows: number; cells: string } => {
  const palette = { ...paletteFor(mini.color), ...COSTUME_COLORS }
  if (mini.costume === null) {
    const canvas = blankCanvas(FULL.columns + FULL.markColumns, PERSONA_ROWS)
    const pose = FULL_POSES[mini.mood](tick)
    stamp(canvas, pose.sprite, palette, 0, 0)
    canvas.marks.push(...pose.marks)
    return { columns: canvas.columns, rows: PERSONA_ROWS, cells: encodeCanvas(canvas) }
  }
  const outfit = FULL_COSTUMES[mini.costume]
  const canvas = blankCanvas(AGENT_COLUMNS, AGENT_ROWS)
  const { sprite, tool, marks, drop } = agentPose(outfit, mini.mood, tick)
  stamp(canvas, sprite, palette, 0, AGENT_HAT_PIXELS)
  stamp(canvas, outfit.wear, palette, 0, AGENT_HAT_PIXELS + drop)
  stamp(canvas, outfit.hat, palette, 0, drop)
  stamp(canvas, tool, palette, FULL.columns * CELL_PIXELS, 0)
  canvas.marks.push(...marks)
  return { columns: canvas.columns, rows: AGENT_ROWS, cells: encodeCanvas(canvas) }
}
