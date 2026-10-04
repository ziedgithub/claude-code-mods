// The Claude Code crab drawn in half blocks: each terminal cell holds two stacked pixels,
// so its 16 by 8 pixels fit 16 columns by 4 rows, shaded with a lighter top and left edge
// and a darker right and underside. The columns past it hold the glyphs of its moods (the
// `z` of sleep, the sparks of a finished answer, the bubble of a thought). Ahead of it
// stands a small crab for each subagent, in the color of its agent type, living its
// agent's moods as the crab lives the main loop's, its glyphs over its head
export type Mood = 'idle' | 'working' | 'thinking' | 'happy' | 'sleeping'
export type Activity = { isWorking: boolean; isThinking: boolean; endedAt: number; isCheering: boolean }
// A subagent at work, waiting for a message, or done; `since` is when it became so
export type MiniPhase = 'running' | 'waiting' | 'done'
export type AgentActivity = { phase: MiniPhase; isThinking: boolean; since: number }
export type Mini = { color: number; mood: Mood }
// A message on its way from a small crab to the crab: `from` is the sender's place among
// the small crabs, one past the drawn ones flying from their count; `progress` runs 0 to 1
export type Flight = { from: number; color: number; progress: number }
// `hidden`: the small crabs past MAX_MINIS, counted as `+N` instead of drawn
export type Scene = { mood: Mood; minis: readonly Mini[]; hidden: number; flights: readonly Flight[] }

export const FRAME_MS = 250
export const PERSONA_ROWS = 4
export const MAX_MINIS = 8
const PIXEL_ROWS = PERSONA_ROWS * 2
const CRAB_COLUMNS = 16
const MARK_COLUMNS = 4
const MINI_COLUMNS = 7
const MINI_ROWS = 4
// The terminal row just over a small crab's head, where its glyph shows
const MINI_GLYPH_ROW = PERSONA_ROWS - MINI_ROWS / 2 - 1
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
const ENVELOPE = ['PFP', 'PPP']
const ENVELOPE_COLUMNS = 3
// It leaves from over the sender's head and arcs this many pixels higher on its way
const ENVELOPE_TOP = PIXEL_ROWS - MINI_ROWS - ENVELOPE.length
const FLIGHT_ARC = 2

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

const HEAD = ['....HHHHHHHH....', '...HOOOOOOOOS...']
const STANDING = ['SOOHOOOOOOOOSOOS', '...SSSSSSSSSS...', '....S.S..S.S....', '....D.D..D.D....']
const GLINTING_EYES = '...HOWEOOWEOS...'
const EYES_AHEAD = [GLINTING_EYES, '...HOEEOOEEOS...']
const EYES_LEFT = ['...HWEOOWEOOS...', '...HEEOOEEOOS...']
const EYES_RIGHT = ['...HOOWEOOWES...', '...HOOEEOOEES...']
const EYES_SHUT = ['...HOOOOOOOOS...', '...HOKKOOKKOS...']

// One claw up at its head, eyes turned to the bubble
const PONDERING = [
  '....HHHHHHHH.O..',
  '...HOOOOOOOOSO..',
  '...HOOWEOOWESO..',
  '...HOOEEOOEESS..',
  'SOOHOOOOOOOOS...',
  '...SSSSSSSSSS...',
  '....S.S..S.S....',
  '....D.D..D.D....',
]

const JUMPING = [
  'O..HHHHHHHHHH..O',
  'OO.HOOOOOOOOS.OO',
  '.OOHOWEOOWEOSOO.',
  '...HOEEOOEEOS...',
  '...HPOOOOOOPS...',
  '...SSSSSSSSSS...',
  '...S.S....S.S...',
  '................',
]
const LANDED = [...HEAD, ...EYES_AHEAD, 'SOOHPOOOOOOPSOOS', ...STANDING.slice(1)]

const ASLEEP = [
  '................',
  '....HHHHHHHH....',
  '...HOOOOOOOOS...',
  '...HOOOOOOOOS...',
  '...HOKKOOKKOS...',
  '.SOHOOOOOOOOSOS.',
  '...SSSSSSSSSS...',
  '...DD.D..D.DD...',
]

// The small crab, 7 by 4, too small for glints: the same poses drawn plainer
const MINI_HEAD = '.HHHHH.'
const MINI_BODY = ['SOOOOOS', '.D...D.']
const MINI_EYES_AHEAD = '.HEOES.'
const MINI_EYES_LEFT = '.EOEOS.'
const MINI_EYES_RIGHT = '.HOEOE.'
const MINI_EYES_SHUT = '.HDODS.'
const MINI_PONDERING = ['.HHHHHO', '.HOEOEO', 'SOOOOS.', '.D...D.']
const MINI_CHEERING = ['OHHHHHO', 'OHEOESO', '.POOOP.', '.D...D.']
const MINI_LANDED = [MINI_HEAD, MINI_EYES_AHEAD, 'SPOOOPS', '.D...D.']
const MINI_ASLEEP = ['.......', MINI_HEAD, 'SHDODSS', '.DSSSD.']

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

// Blinks now and then, and looks left, then later right, as if around the room
type Gaze = 'ahead' | 'left' | 'right' | 'shut'

const gazeAt = (tick: number): Gaze => {
  if (tick % BLINK_EVERY === 0) return 'shut'
  const glance = tick % GLANCE_EVERY
  if (glance >= 20 && glance < 20 + GLANCE_FRAMES) return 'left'
  return glance >= 44 && glance < 44 + GLANCE_FRAMES ? 'right' : 'ahead'
}

const EYES: Record<Gaze, readonly string[]> = { ahead: EYES_AHEAD, left: EYES_LEFT, right: EYES_RIGHT, shut: EYES_SHUT }

const idle = (tick: number): Pose => ({ sprite: [...HEAD, ...EYES[gazeAt(tick)], ...STANDING], marks: [] })

// Behind a laptop seen from the back, one claw up and one down in turn, as when typing,
// the logo on the lid pulsing between two glows
const working = (tick: number): Pose => {
  const isLeftUp = tick % 2 === 0
  const logo = Math.floor(tick / GLOW_FRAMES) % 2 === 0 ? 'GG' : 'NN'
  return {
    sprite: [
      ...HEAD,
      GLINTING_EYES,
      isLeftUp ? '.OOHOEEOOEEOS...' : '...HOEEOOEEOSOS.',
      isLeftUp ? '..OLLLLLLLLLLSS.' : '.OOLLLLLLLLLLS..',
      `...LLLL${logo}LLLL...`,
      '...LLLLLLLLLL...',
      '..BBBBBBBBBBBB..',
    ],
    marks: [],
  }
}

// A bubble beside its raised claw grows one dot at a time, holds whole, then starts over
const thinking = (tick: number): Pose => {
  const phase = Math.floor(tick / BUBBLE_FRAMES) % 4
  const bubble: Mark[] = [
    { row: 2, column: 16, glyph: '.', color: BUBBLE_COLOR },
    { row: 1, column: 17, glyph: 'o', color: BUBBLE_COLOR },
    { row: 0, column: 18, glyph: 'O', color: BUBBLE_COLOR },
  ]
  return { sprite: PONDERING, marks: bubble.slice(0, Math.min(phase, 2) + 1) }
}

// Jumps with its claws up and its cheeks flushed, sparks flying
const happy = (tick: number): Pose => {
  const isUp = tick % 2 === 1
  return {
    sprite: isUp ? JUMPING : LANDED,
    marks: [isUp ? { row: 0, column: 16, glyph: '*', color: SPARK_COLOR } : { row: 1, column: 17, glyph: '+', color: SPARK_COLOR }],
  }
}

// Slumped, eyes shut, claws down, and a `z` rising one step at a time before the next starts low
const sleeping = (tick: number): Pose => {
  const phase = Math.floor(tick / Z_FRAMES) % 4
  const zs: Mark[] = [
    { row: 2, column: 16, glyph: 'z', color: Z_COLOR },
    { row: 1, column: 17, glyph: 'z', color: Z_COLOR },
    { row: 0, column: 18, glyph: 'Z', color: Z_COLOR },
  ]
  return { sprite: ASLEEP, marks: phase === 3 ? [] : zs.slice(0, phase + 1) }
}

const POSES: Record<Mood, (tick: number) => Pose> = { idle, working, thinking, happy, sleeping }

// The small crab's poses; its one glyph a pose shows sits in the row over its head
const MINI_GAZE: Record<Gaze, string> = {
  ahead: MINI_EYES_AHEAD,
  left: MINI_EYES_LEFT,
  right: MINI_EYES_RIGHT,
  shut: MINI_EYES_SHUT,
}

const MINI_POSES: Record<Mood, (tick: number) => Pose> = {
  idle: tick => ({ sprite: [MINI_HEAD, MINI_GAZE[gazeAt(tick)], ...MINI_BODY], marks: [] }),
  working: tick => {
    const isLeftUp = tick % 2 === 0
    const logo = Math.floor(tick / GLOW_FRAMES) % 2 === 0 ? 'G' : 'N'
    return {
      sprite: [MINI_HEAD, isLeftUp ? 'OHEOES.' : '.HEOESS', isLeftUp ? `.LL${logo}LLS` : `OLL${logo}LL.`, 'BBBBBBB'],
      marks: [],
    }
  },
  thinking: tick => {
    const glyph = '.oOO'.charAt(Math.floor(tick / BUBBLE_FRAMES) % 4)
    return { sprite: MINI_PONDERING, marks: [{ row: MINI_GLYPH_ROW, column: 6, glyph, color: BUBBLE_COLOR }] }
  },
  // Claws up and down in turn, too small to leave the ground
  happy: tick => {
    const isUp = tick % 2 === 1
    return {
      sprite: isUp ? MINI_CHEERING : MINI_LANDED,
      marks: [{ row: MINI_GLYPH_ROW, column: isUp ? 6 : 0, glyph: isUp ? '*' : '+', color: SPARK_COLOR }],
    }
  },
  sleeping: tick => {
    const glyph = 'zZ'.charAt(Math.floor(tick / Z_FRAMES) % 3)
    return { sprite: MINI_ASLEEP, marks: glyph === '' ? [] : [{ row: MINI_GLYPH_ROW, column: 5, glyph, color: Z_COLOR }] }
  },
}

const countText = (hidden: number): string => (hidden > 0 ? `+${hidden}` : '')

// The small crabs and their count take the left, a gap, then the crab and its glyphs
export const sceneColumns = (minis: number, hidden: number): number => {
  const count = countText(hidden)
  const crew = minis * (MINI_COLUMNS + MINI_GAP) + (count === '' ? 0 : count.length + MINI_GAP)
  return crew + CRAB_COLUMNS + MARK_COLUMNS
}

type Canvas = { columns: number; pixels: (number | null)[][]; marks: Mark[] }

const stamp = (canvas: Canvas, sprite: readonly string[], palette: Palette, left: number, top: number): void => {
  sprite.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      const color = palette[line.charAt(x)]
      const row = canvas.pixels[top + y]
      if (color !== undefined && row !== undefined && left + x < canvas.columns) row[left + x] = color
    }
  })
}

export const composeScene = (scene: Scene, tick: number): Canvas => {
  const columns = sceneColumns(scene.minis.length, scene.hidden)
  const canvas: Canvas = {
    columns,
    pixels: Array.from({ length: PIXEL_ROWS }, () => Array<number | null>(columns).fill(null)),
    marks: [],
  }
  let left = 0
  scene.minis.forEach((mini, place) => {
    const pose = MINI_POSES[mini.mood](tick + place * MINI_TICK_SHIFT)
    stamp(canvas, pose.sprite, paletteFor(mini.color), left, PIXEL_ROWS - MINI_ROWS)
    for (const mark of pose.marks) canvas.marks.push({ ...mark, column: left + mark.column })
    left += MINI_COLUMNS + MINI_GAP
  })
  const count = countText(scene.hidden)
  for (let i = 0; i < count.length; i++) canvas.marks.push({ row: PERSONA_ROWS - 1, column: left + i, glyph: count.charAt(i), color: COUNT_COLOR })
  const countLeft = left
  if (count !== '') left += count.length + MINI_GAP
  const pose = POSES[scene.mood](tick)
  stamp(canvas, pose.sprite, CRAB_PALETTE, left, 0)
  for (const mark of pose.marks) canvas.marks.push({ ...mark, column: left + mark.column })
  for (const flight of scene.flights) {
    const start = flight.from < scene.minis.length ? flight.from * (MINI_COLUMNS + MINI_GAP) + (MINI_COLUMNS - ENVELOPE_COLUMNS) / 2 : countLeft
    const { column, row } = flightPoint(start, left, flight.progress)
    stamp(canvas, ENVELOPE, { P: PAPER_COLOR, F: flight.color }, column, row)
  }
  return canvas
}

// Eased along the row so it sets off and lands gently, lifted most halfway
export const flightPoint = (start: number, end: number, progress: number): { column: number; row: number } => {
  const t = Math.min(1, Math.max(0, progress))
  const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
  return { column: Math.round(start + (end - start) * eased), row: Math.round(ENVELOPE_TOP - FLIGHT_ARC * 4 * t * (1 - t)) }
}

// `▀` paints the top pixel with the foreground and the bottom one with the background; a
// lone bottom pixel takes `▄`, since a default foreground would draw the empty top
const halfBlock = (top: number | null, bottom: number | null): [number, number, number] => {
  if (top === null && bottom === null) return [0x20, DEFAULT_COLOR, DEFAULT_COLOR]
  if (top === null) return [0x2584, bottom ?? DEFAULT_COLOR, DEFAULT_COLOR]
  return [0x2580, top, bottom ?? DEFAULT_COLOR]
}

// The Raster's `cells`: row-major `[codePoint, foreground, background]` u32 triplets in base64
export const encodeCanvas = (canvas: Canvas): string => {
  const words: number[] = []
  for (let row = 0; row < PERSONA_ROWS; row++) {
    for (let column = 0; column < canvas.columns; column++) {
      const mark = canvas.marks.find(m => m.row === row && m.column === column)
      if (mark !== undefined) {
        words.push(mark.glyph.charCodeAt(0), mark.color, DEFAULT_COLOR)
      } else {
        words.push(...halfBlock(canvas.pixels[row * 2]?.[column] ?? null, canvas.pixels[row * 2 + 1]?.[column] ?? null))
      }
    }
  }
  return new Uint8Array(Uint32Array.from(words).buffer).toBase64()
}

export const drawScene = (scene: Scene, tick: number): { columns: number; cells: string } => {
  const canvas = composeScene(scene, tick)
  return { columns: canvas.columns, cells: encodeCanvas(canvas) }
}
