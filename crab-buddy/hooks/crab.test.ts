import { expect, test } from 'claude-code/testing'

import { COSTUME_COLORS, COSTUMES, FULL_COSTUMES } from './costumes'
import type { Costume } from './costumes'
import { AGENT_COLUMNS, AGENT_ROWS, agentMoodFor, CLAUDE_COLOR, composeScene, drawAgent, drawLone, drawScene, encodeCanvas, flapColorOf, flightPoint, IDLE, minisThatFit, moodFor, paletteFor, PERSONA_ROWS, sceneColumns } from './crab'
import type { Mini, Mood, Scene } from './crab'

const decode = (cells: string): number[] => Array.from(new Uint32Array(Uint8Array.fromBase64(cells).buffer))
const cellAt = (words: number[], columns: number, row: number, column: number) =>
  words.slice((row * columns + column) * 3, (row * columns + column) * 3 + 3)
const alone = (mood: Mood, isCompact = false): Scene => ({ mood, minis: [], hidden: 0, flights: [], isCompact })
const crewOf = (minis: Mini[], hidden = 0): Scene => ({ mood: 'idle', minis, hidden, flights: [], isCompact: false })
const bare = (color: number, mood: Mood): Mini => ({ color, mood, costume: null })
const MOODS: readonly Mood[] = ['idle', 'working', 'thinking', 'happy', 'sleeping']
const COSTUME_NAMES = Object.keys(COSTUMES) as Costume[]
const DEFAULT_COLOR = 0x01000000
const CRAB_COLUMNS = 16
const COMPACT_COLUMNS = 12
// The crab and the three columns of its glyphs
const SCENE_COLUMNS = CRAB_COLUMNS + 3
// A small crab, its tool's three columns, and the gap after it
const MINI_STEP = 11
// Pixels: two to a column, the small crab's body 14 wide, its tool's lane the 6 past it
const MINI_BODY = 14
const MINI_PIXELS = 20
const STEP_PIXELS = MINI_STEP * 2

test('moodFor works through a turn, thinks while thinking, cheers after an answer, then sleeps', () => {
  expect(moodFor({ ...IDLE, isWorking: true }, 5)).toBe('working')
  expect(moodFor({ ...IDLE, isWorking: true, isThinking: true }, 5)).toBe('thinking')
  expect(moodFor({ ...IDLE, isThinking: true }, 5)).toBe('sleeping')
  const answered = { isWorking: false, isThinking: false, endedAt: 100, isCheering: true }
  expect(moodFor(answered, 105)).toBe('happy')
  expect(moodFor(answered, 125)).toBe('idle')
  expect(moodFor({ ...answered, isCheering: false }, 105)).toBe('idle')
  expect(moodFor(answered, 100 + 240)).toBe('sleeping')
  expect(moodFor(IDLE, 0)).toBe('sleeping')
})

test('every pose of the crab stays within its 16 columns, its glyphs in the three past them', () => {
  for (const mood of MOODS) {
    for (let tick = 0; tick < 64; tick++) {
      const canvas = composeScene(alone(mood), tick)
      expect(canvas.columns).toBe(SCENE_COLUMNS)
      for (const row of canvas.pixels) expect(row.slice(CRAB_COLUMNS * 2).every(pixel => pixel === null)).toBe(true)
      expect(canvas.marks.every(mark => mark.column >= CRAB_COLUMNS)).toBe(true)
      expect(decode(drawScene(alone(mood), tick).cells).length).toBe(SCENE_COLUMNS * PERSONA_ROWS * 3)
    }
  }
})

test('the compact crab keeps to its 12 columns, its glyphs in the empty top row over it', () => {
  expect(sceneColumns(0, 0, true)).toBe(COMPACT_COLUMNS)
  for (const mood of MOODS) {
    for (let tick = 0; tick < 64; tick++) {
      const canvas = composeScene(alone(mood, true), tick)
      expect(canvas.columns).toBe(COMPACT_COLUMNS)
      for (const mark of canvas.marks) {
        expect(mark.row).toBe(0)
        for (const row of canvas.pixels.slice(0, 2)) expect(row.slice(mark.column * 2, mark.column * 2 + 2)).toEqual([null, null])
      }
    }
  }
  // Smaller than the crab: two empty pixel rows over it while it stands
  const idle = composeScene(alone('idle', true), 1)
  expect(idle.pixels.slice(0, 2).every(row => row.every(pixel => pixel === null))).toBe(true)
  expect(idle.pixels[2]?.slice(6, 8)).toEqual([paletteFor(CLAUDE_COLOR).H, paletteFor(CLAUDE_COLOR).H])
  // Thinking, the bubble grows over its raised claw; asleep, the z's rise over its head
  expect(composeScene(alone('thinking', true), 4).marks.map(mark => [mark.column, mark.glyph])).toEqual([[9, '.'], [10, 'o'], [11, 'O']])
  expect(composeScene(alone('sleeping', true), 6).marks.map(mark => mark.glyph)).toEqual(['z', 'z', 'Z'])
})

test('the crab is shaded and its eyes glint, a quarter of a cell to a pixel', () => {
  const crab = paletteFor(CLAUDE_COLOR)
  const words = decode(drawScene(alone('idle'), 1).cells)
  // The eye's glint in one corner of its pupil, the head's light top edge over the body
  expect(cellAt(words, SCENE_COLUMNS, 1, 5)).toEqual([0x259f, 0x1c1c22, 0xffffff])
  expect(cellAt(words, SCENE_COLUMNS, 0, 5)).toEqual([0x2580, crab.H, crab.O])
  // The shaded right edge, its corner rounded, and a leg splayed out
  expect(cellAt(words, SCENE_COLUMNS, 0, 12)).toEqual([0x2599, crab.S, DEFAULT_COLOR])
  expect(cellAt(words, SCENE_COLUMNS, 3, 4)).toEqual([0x259e, crab.S, DEFAULT_COLOR])
})

test('every pose of either crab keeps to two colors a cell, so the terminal draws it as drawn', () => {
  for (const isCompact of [false, true]) {
    for (const mood of MOODS) {
      for (let tick = 0; tick < 64; tick++) {
        const canvas = composeScene(alone(mood, isCompact), tick)
        for (const row of canvas.pixels) expect(row.length).toBe(canvas.columns * 2)
        for (let row = 0; row < 8; row += 2) {
          for (let x = 0; x < canvas.columns * 2; x += 2) {
            const cell = [canvas.pixels[row]?.[x], canvas.pixels[row]?.[x + 1], canvas.pixels[row + 1]?.[x], canvas.pixels[row + 1]?.[x + 1]]
            expect(new Set(cell).size).toBeLessThanOrEqual(2)
          }
        }
      }
    }
  }
})

test('a thinking crab raises a claw beside a bubble that grows dot by dot', () => {
  const first = composeScene(alone('thinking'), 0)
  expect(first.marks.map(mark => mark.glyph)).toEqual(['.'])
  const whole = composeScene(alone('thinking'), 4)
  expect(whole.marks.map(mark => [mark.row, mark.column, mark.glyph])).toEqual([[2, 16, '.'], [1, 17, 'o'], [0, 18, 'O']])
  // Its pincer open over its raised claw
  expect(whole.pixels[0]?.slice(26, 29)).toEqual([CLAUDE_COLOR, null, CLAUDE_COLOR])
})

test('a sleeping crab shuts its eyes and lets a z rise', () => {
  const canvas = composeScene(alone('sleeping'), 0)
  expect(canvas.pixels[4]?.[10]).toBe(0x4b2318)
  expect(canvas.marks).toEqual([{ row: 2, column: 16, glyph: 'z', color: 0x8b949e }])
})

test('a working crab types, one claw up then the other', () => {
  expect(drawScene(alone('working'), 0).cells).not.toBe(drawScene(alone('working'), 1).cells)
})

test('bare small crabs stand left of the crab in their own colors, bottom-aligned', () => {
  const blue = 0x58a6ff
  const green = 0x3fb950
  const { columns, cells } = drawScene(crewOf([bare(blue, 'idle'), bare(green, 'working')]), 1)
  expect(columns).toBe(2 * MINI_STEP + SCENE_COLUMNS)
  expect(sceneColumns(2, 0, false)).toBe(columns)
  const words = decode(cells)
  // Under the rows kept for a hat and their glyphs, but for the top of its head
  expect(cellAt(words, columns, 0, 2)).toEqual([0x20, DEFAULT_COLOR, DEFAULT_COLOR])
  expect(cellAt(words, columns, 1, 2)).toEqual([0x2584, paletteFor(blue).H, DEFAULT_COLOR])
  // An eye, its glint in a quarter of its cell; its underside on a leg, in its own shade
  expect(cellAt(words, columns, 2, 2)).toEqual([0x259f, 0x1c1c22, 0xffffff])
  expect(cellAt(words, columns, 3, 1)).toEqual([0x259b, paletteFor(blue).S, DEFAULT_COLOR])
  // A laptop's lid over its base before the other
  expect(cellAt(words, columns, 3, MINI_STEP + 2)).toEqual([0x2580, 0x8b949e, 0x6e7681])
  // The crab follows them
  expect(cellAt(words, columns, 1, 2 * MINI_STEP + 5)).toEqual([0x259f, 0x1c1c22, 0xffffff])
})

test('a cell of more than two colors keeps the two that draw it closest', () => {
  const white = 0xffffff
  const black = 0x000000
  const grey = 0x202020
  const words = decode(encodeCanvas({ columns: 1, pixels: [[white, white], [black, grey]], marks: [] }))
  expect(words.slice(0, 3)).toEqual([0x2580, white, black])
  // Two colors and an empty pixel: the near-black one is left to the terminal's dark background
  const corner = decode(encodeCanvas({ columns: 1, pixels: [[null, white], [white, 0x111111]], marks: [] }))
  expect(corner.slice(0, 3)).toEqual([0x259e, white, DEFAULT_COLOR])
})

test('every costume is drawn to size: hats and wear as wide as the small crab, tools six pixels the band tall', () => {
  for (const name of COSTUME_NAMES) {
    const outfit = COSTUMES[name]
    expect(outfit.hat.length).toBeLessThanOrEqual(4)
    expect(outfit.wear.length).toBeLessThanOrEqual(4)
    for (const line of [...outfit.hat, ...outfit.wear]) expect(line.length).toBe(MINI_BODY)
    for (const tool of [outfit.tool, ...outfit.work]) {
      expect(tool.length).toBe(8)
      for (const line of tool) expect(line.length).toBe(6)
    }
  }
})

test('a dressed small crab wears its hat on its head and holds its tool at its right, in every mood', () => {
  const crab = paletteFor(CLAUDE_COLOR)
  for (const name of COSTUME_NAMES) {
    for (const mood of MOODS) {
      for (let tick = 0; tick < 16; tick++) {
        const canvas = composeScene(crewOf([{ color: CLAUDE_COLOR, mood, costume: name }]), tick)
        // Its body, in the crab's own colors, stands on the floor; its tool stays in its lane
        expect(canvas.pixels.slice(4).some(row => row.slice(0, MINI_BODY).some(pixel => pixel === crab.O))).toBe(true)
        expect(canvas.pixels.some(row => row.slice(MINI_BODY, MINI_PIXELS).some(pixel => pixel !== null))).toBe(true)
        expect(canvas.pixels.every(row => row.slice(MINI_PIXELS, STEP_PIXELS).every(pixel => pixel === null))).toBe(true)
        // Its glyph sits in the top row, clear of its hat and of the tool it holds
        for (const mark of canvas.marks.filter(m => m.column < MINI_STEP)) {
          expect(mark.row).toBe(0)
          for (const row of canvas.pixels.slice(0, 2)) expect(row.slice(mark.column * 2, mark.column * 2 + 2)).toEqual([null, null])
        }
        // Each cell of it in two colors at most, so the terminal draws it as drawn
        for (let row = 0; row < 8; row += 2) {
          for (let x = 0; x < MINI_PIXELS; x += 2) {
            const cell = [canvas.pixels[row]?.[x], canvas.pixels[row]?.[x + 1], canvas.pixels[row + 1]?.[x], canvas.pixels[row + 1]?.[x + 1]]
            expect(new Set(cell).size).toBeLessThanOrEqual(2)
          }
        }
      }
    }
  }
  // The hard hat's brim over the top of its head, in every pose
  const yellow = 0xf5c518
  const builder = (mood: Mood) => composeScene(crewOf([{ color: CLAUDE_COLOR, mood, costume: 'builder' }]), 1).pixels
  for (const mood of MOODS) expect(builder(mood)[3]?.slice(0, MINI_BODY).every(pixel => pixel === yellow)).toBe(true)
  // The reviewer's glasses over its eyes: frames round two lenses
  const frame = 0x1f2328
  const lens = 0x9ecbff
  const reviewer = composeScene(crewOf([{ color: CLAUDE_COLOR, mood: 'idle', costume: 'reviewer' }]), 1).pixels
  expect(reviewer[4]?.slice(3, 11)).toEqual([frame, lens, lens, frame, frame, lens, lens, frame])
})

test('a dressed small crab works with its tool, not a laptop', () => {
  for (const name of COSTUME_NAMES) {
    const frames = new Set(Array.from({ length: 8 }, (_, tick) => {
      const canvas = composeScene(crewOf([{ color: CLAUDE_COLOR, mood: 'working', costume: name }]), tick)
      expect(canvas.pixels.slice(4).some(row => row.slice(0, MINI_BODY).some(pixel => pixel === 0x8b949e || pixel === 0x6e7681))).toBe(false)
      return canvas.pixels.map(row => row.slice(MINI_BODY, MINI_PIXELS).join()).join('|')
    }))
    expect(frames.size).toBeGreaterThan(1)
  }
})

test("a dressed small crab's messages carry its costume's color, a bare one's its own", () => {
  expect(flapColorOf({ color: CLAUDE_COLOR, costume: 'builder' })).toBe(0xf5c518)
  expect(flapColorOf({ color: 0x58a6ff, costume: null })).toBe(0x58a6ff)
})

test('as many small crabs are drawn as the band has room for, the others counted', () => {
  // A phone: the compact crab and three small crabs, with room for a count
  expect(minisThatFit(3, 48, true)).toBe(3)
  expect(minisThatFit(5, 48, true)).toBe(3)
  expect(sceneColumns(3, 2, true)).toBeLessThanOrEqual(48)
  // A wide terminal draws up to eight; one too narrow for any, none
  expect(minisThatFit(10, 200, false)).toBe(8)
  expect(minisThatFit(4, 20, false)).toBe(0)
})

test('a subagent works, thinks, cheers once done, and sleeps after a minute of waiting', () => {
  expect(agentMoodFor({ phase: 'running', isThinking: false, since: 0 }, 5)).toBe('working')
  expect(agentMoodFor({ phase: 'running', isThinking: true, since: 0 }, 5)).toBe('thinking')
  expect(agentMoodFor({ phase: 'done', isThinking: false, since: 0 }, 5)).toBe('happy')
  expect(agentMoodFor({ phase: 'waiting', isThinking: false, since: 10 }, 249)).toBe('idle')
  expect(agentMoodFor({ phase: 'waiting', isThinking: false, since: 10 }, 250)).toBe('sleeping')
})

test('each small crab shows its mood with the glyph in the top row, past its body', () => {
  const marksOf = (mood: Mood, tick: number) =>
    composeScene(crewOf([bare(0x58a6ff, mood)]), tick).marks
      .filter(mark => mark.column < MINI_STEP)
      .map(mark => [mark.row, mark.column, mark.glyph])
  expect(marksOf('thinking', 4)).toEqual([[0, 7, 'O']])
  expect(marksOf('sleeping', 0)).toEqual([[0, 7, 'z']])
  expect(marksOf('happy', 1)).toEqual([[0, 7, '*']])
  expect(marksOf('happy', 2)).toEqual([[0, 8, '+']])
  expect(marksOf('idle', 0)).toEqual([])
  // A bare one's every pose stays within its 14 pixels across and its five bottom rows
  for (const mood of MOODS) {
    for (let tick = 0; tick < 64; tick++) {
      const canvas = composeScene(crewOf([bare(0x58a6ff, mood)]), tick)
      expect(canvas.pixels.slice(0, 3).every(row => row.slice(0, STEP_PIXELS).every(pixel => pixel === null))).toBe(true)
      expect(canvas.pixels.every(row => row.slice(MINI_BODY, STEP_PIXELS).every(pixel => pixel === null))).toBe(true)
    }
  }
})

test('two small crabs in the same mood keep their own time', () => {
  const canvas = composeScene(crewOf([bare(0x58a6ff, 'working'), bare(0x58a6ff, 'working')]), 0)
  const first = canvas.pixels.map(row => row.slice(0, MINI_BODY).join())
  const second = canvas.pixels.map(row => row.slice(STEP_PIXELS, STEP_PIXELS + MINI_BODY).join())
  expect(first).not.toEqual(second)
})

test('small crabs past the shown ones are counted', () => {
  const canvas = composeScene(crewOf([bare(0x58a6ff, 'working')], 3), 0)
  expect(canvas.columns).toBe(MINI_STEP + 3 + SCENE_COLUMNS)
  expect(canvas.marks.filter(mark => mark.row === 3).map(mark => [mark.column, mark.glyph])).toEqual([[MINI_STEP, '+'], [MINI_STEP + 1, '3']])
})

test('a message flies in an arc from over its sender to beside the crab', () => {
  const blue = 0x58a6ff
  const paper = 0xf0f6fc
  const minis: Mini[] = [bare(0x3fb950, 'working'), bare(blue, 'working')]
  const at = (progress: number) => composeScene({ ...crewOf(minis), flights: [{ from: 1, color: blue, progress }] }, 1)
  // Over the second small crab's head, its flap in the sender's color; the width unchanged
  const over = STEP_PIXELS + 4
  expect(at(0).columns).toBe(2 * MINI_STEP + SCENE_COLUMNS)
  expect(at(0).pixels[2]?.slice(over, over + 6)).toEqual([paper, blue, blue, blue, blue, paper])
  expect(at(0).pixels[3]?.slice(over, over + 6)).toEqual([paper, paper, blue, blue, paper, paper])
  // Lifted two pixels halfway, then landing beside the crab's head
  expect(flightPoint(10, 16, 0.5)).toEqual({ column: 13, row: 0 })
  expect(at(1).pixels[2]?.slice(2 * STEP_PIXELS, 2 * STEP_PIXELS + 6)).toEqual([paper, blue, blue, blue, blue, paper])
  // One from a small crab past the drawn ones leaves from their count
  const hidden = composeScene({ ...crewOf(minis.slice(0, 1), 2), flights: [{ from: 1, color: blue, progress: 0 }] }, 1)
  expect(hidden.pixels[2]?.[STEP_PIXELS + 1]).toBe(blue)
})

test("an agent's crab is the crab's own size: bare, the crab itself in its agent's color", () => {
  for (const mood of MOODS) {
    for (const tick of [0, 1, 4, 7]) {
      const crab = drawAgent({ color: CLAUDE_COLOR, mood, costume: null }, tick)
      expect([crab.columns, crab.rows]).toEqual([SCENE_COLUMNS, PERSONA_ROWS])
      expect(crab.cells).toBe(drawScene(alone(mood), tick).cells)
    }
  }
  const blue = drawAgent(bare(0x58a6ff, 'idle'), 1)
  expect(decode(blue.cells).includes(0x58a6ff)).toBe(true)
  expect(decode(blue.cells).includes(CLAUDE_COLOR)).toBe(false)
})

test("a dressed agent's crab wears its outfit over the crab's own body, its hat two rows over it", () => {
  const BODY_ROWS = [3, 4, 5]
  for (const name of COSTUME_NAMES) {
    for (const mood of MOODS) {
      const dressed = drawAgent({ color: CLAUDE_COLOR, mood, costume: name }, 3)
      expect([dressed.columns, dressed.rows]).toEqual([AGENT_COLUMNS, AGENT_ROWS])
      expect(decode(dressed.cells).length).toBe(AGENT_COLUMNS * AGENT_ROWS * 3)
    }
  }
  // Under its hat, a builder's crab is the crab's own, row for row, its legs and claws too
  const crab = decode(drawScene(alone('idle'), 1).cells)
  const builder = decode(drawAgent({ color: CLAUDE_COLOR, mood: 'idle', costume: 'builder' }, 1).cells)
  for (const row of BODY_ROWS) {
    for (let column = 0; column < CRAB_COLUMNS; column++) expect(cellAt(builder, AGENT_COLUMNS, row, column)).toEqual(cellAt(crab, SCENE_COLUMNS, row - 2, column))
  }
  // Its hard hat's yellow over its head, its hammer's steel right of its claw
  expect(cellAt(builder, AGENT_COLUMNS, 1, 5)).toEqual([0x20, DEFAULT_COLOR, 0xf5c518])
  expect([0, 1, 2, 3, 4, 5].some(row => [16, 17, 18, 19, 20].some(column => cellAt(builder, AGENT_COLUMNS, row, column).includes(0xc9d1d9)))).toBe(true)
})

test("every costume is drawn to the crab's size too: hats and wear 32 pixels wide, tools ten by twelve", () => {
  for (const name of COSTUME_NAMES) {
    const outfit = FULL_COSTUMES[name]
    expect(outfit.hat.length).toBeLessThanOrEqual(7)
    for (const line of outfit.hat) expect(line.length).toBe(32)
    for (const line of outfit.wear) if (line !== '') expect(line.length).toBe(32)
    expect(outfit.work.length).toBeGreaterThan(0)
    for (const tool of [outfit.tool, ...outfit.work]) {
      expect(tool.length).toBe(12)
      for (const line of tool) expect(line.length).toBe(10)
    }
    // Every pixel is a color of the crab's or the costumes'
    for (const line of [...outfit.hat, ...outfit.wear, ...outfit.tool, ...outfit.work.flat()]) {
      for (const pixel of line) if (pixel !== '.') expect(pixel in COSTUME_COLORS || pixel in paletteFor(CLAUDE_COLOR)).toBe(true)
    }
  }
})

test("an agent's glyphs show over its right shoulder, between its hat and its tool", () => {
  const glyphsOf = (mood: Mood, tick: number) => {
    const words = decode(drawAgent({ color: CLAUDE_COLOR, mood, costume: 'explorer' }, tick).cells)
    return [13, 14, 15].flatMap(column => [0, 1].map(row => String.fromCharCode(cellAt(words, AGENT_COLUMNS, row, column)[0] ?? 0))).filter(glyph => /[.oOzZ*+]/.test(glyph))
  }
  expect(glyphsOf('thinking', 4).sort()).toEqual(['.', 'O', 'o'])
  expect(glyphsOf('sleeping', 6).sort()).toEqual(['Z', 'z', 'z'])
  expect(glyphsOf('happy', 1)).toEqual(['*'])
  expect(glyphsOf('idle', 1)).toEqual([])
})

test('a small crab alone, where the band lacks the rows for a hat, is drawn as the band draws it', () => {
  const mini = { color: CLAUDE_COLOR, mood: 'idle' as const, costume: 'explorer' as const }
  const lone = drawLone(mini, 3)
  expect([lone.columns, lone.rows]).toEqual([MINI_STEP - 1, PERSONA_ROWS])
  const band = decode(drawScene(crewOf([mini]), 3).cells)
  const words = decode(lone.cells)
  for (let row = 0; row < PERSONA_ROWS; row++) {
    for (let column = 0; column < MINI_STEP - 1; column++) expect(cellAt(words, MINI_STEP - 1, row, column)).toEqual(cellAt(band, SCENE_COLUMNS + MINI_STEP, row, column))
  }
})
