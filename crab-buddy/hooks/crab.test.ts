import { expect, test } from 'claude-code/testing'

import { agentMoodFor, CLAUDE_COLOR, composeScene, drawScene, flightPoint, IDLE, moodFor, paletteFor, PERSONA_ROWS, sceneColumns } from './crab'
import type { Mini, Mood, Scene } from './crab'

const decode = (cells: string): number[] => Array.from(new Uint32Array(Uint8Array.fromBase64(cells).buffer))
const cellAt = (words: number[], columns: number, row: number, column: number) =>
  words.slice((row * columns + column) * 3, (row * columns + column) * 3 + 3)
const alone = (mood: Mood): Scene => ({ mood, minis: [], hidden: 0, flights: [] })
const MOODS: readonly Mood[] = ['idle', 'working', 'thinking', 'happy', 'sleeping']
const DEFAULT_COLOR = 0x01000000
const CRAB_COLUMNS = 16

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

test('every pose of the crab stays within its 16 columns, its glyphs past them', () => {
  for (const mood of MOODS) {
    for (let tick = 0; tick < 64; tick++) {
      const canvas = composeScene(alone(mood), tick)
      expect(canvas.columns).toBe(20)
      for (const row of canvas.pixels) expect(row.slice(CRAB_COLUMNS).every(pixel => pixel === null)).toBe(true)
      expect(canvas.marks.every(mark => mark.column >= CRAB_COLUMNS)).toBe(true)
      expect(decode(drawScene(alone(mood), tick).cells).length).toBe(20 * PERSONA_ROWS * 3)
    }
  }
})

test('the crab is shaded and its eyes glint', () => {
  const crab = paletteFor(CLAUDE_COLOR)
  const words = decode(drawScene(alone('idle'), 1).cells)
  // The eye's glint over its pupil, the head's light top edge over the body
  expect(cellAt(words, 20, 1, 5)).toEqual([0x2580, 0xffffff, 0x1c1c22])
  expect(cellAt(words, 20, 0, 5)).toEqual([0x2580, crab.H, crab.O])
  // The shaded right edge, and a dark foot under a shaded leg
  expect(cellAt(words, 20, 0, 12)).toEqual([0x2584, crab.S, DEFAULT_COLOR])
  expect(cellAt(words, 20, 3, 4)).toEqual([0x2580, crab.S, crab.D])
})

test('a thinking crab raises a claw beside a bubble that grows dot by dot', () => {
  const first = composeScene(alone('thinking'), 0)
  expect(first.marks.map(mark => mark.glyph)).toEqual(['.'])
  const whole = composeScene(alone('thinking'), 4)
  expect(whole.marks.map(mark => [mark.row, mark.column, mark.glyph])).toEqual([[2, 16, '.'], [1, 17, 'o'], [0, 18, 'O']])
  expect(whole.pixels[0]?.[13]).toBe(CLAUDE_COLOR)
})

test('a sleeping crab shuts its eyes and lets a z rise', () => {
  const canvas = composeScene(alone('sleeping'), 0)
  expect(canvas.pixels[4]?.[5]).toBe(0x4b2318)
  expect(canvas.marks).toEqual([{ row: 2, column: 16, glyph: 'z', color: 0x8b949e }])
})

test('a working crab types, one claw up then the other', () => {
  expect(drawScene(alone('working'), 0).cells).not.toBe(drawScene(alone('working'), 1).cells)
})

test('small crabs stand left of the crab in their own colors, bottom-aligned', () => {
  const blue = 0x58a6ff
  const green = 0x3fb950
  const scene: Scene = { mood: 'idle', minis: [{ color: blue, mood: 'idle' }, { color: green, mood: 'working' }], hidden: 0, flights: [] }
  const { columns, cells } = drawScene(scene, 1)
  expect(columns).toBe(2 * 8 + 20)
  expect(sceneColumns(2, 0)).toBe(columns)
  const words = decode(cells)
  // Two rows tall, under a row kept for their glyphs
  expect(cellAt(words, columns, 0, 1)).toEqual([0x20, DEFAULT_COLOR, DEFAULT_COLOR])
  expect(cellAt(words, columns, 1, 1)).toEqual([0x20, DEFAULT_COLOR, DEFAULT_COLOR])
  // Its body over a dark foot, in the small crab's own color; a laptop's lid before the other
  expect(cellAt(words, columns, 3, 1)).toEqual([0x2580, blue, paletteFor(blue).D])
  expect(cellAt(words, columns, 3, 8 + 2)[1]).toBe(0x8b949e)
  // The crab follows them
  expect(cellAt(words, columns, 1, 16 + 5)).toEqual([0x2580, 0xffffff, 0x1c1c22])
})

test('a subagent works, thinks, cheers once done, and sleeps after a minute of waiting', () => {
  expect(agentMoodFor({ phase: 'running', isThinking: false, since: 0 }, 5)).toBe('working')
  expect(agentMoodFor({ phase: 'running', isThinking: true, since: 0 }, 5)).toBe('thinking')
  expect(agentMoodFor({ phase: 'done', isThinking: false, since: 0 }, 5)).toBe('happy')
  expect(agentMoodFor({ phase: 'waiting', isThinking: false, since: 10 }, 249)).toBe('idle')
  expect(agentMoodFor({ phase: 'waiting', isThinking: false, since: 10 }, 250)).toBe('sleeping')
})

test('each small crab shows its mood with the glyph over its head', () => {
  const marksOf = (mood: Mood, tick: number) =>
    composeScene({ mood: 'idle', minis: [{ color: 0x58a6ff, mood }], hidden: 0, flights: [] }, tick).marks
      .filter(mark => mark.column < 7)
      .map(mark => [mark.row, mark.column, mark.glyph])
  expect(marksOf('thinking', 4)).toEqual([[1, 6, 'O']])
  expect(marksOf('sleeping', 0)).toEqual([[1, 5, 'z']])
  expect(marksOf('happy', 1)).toEqual([[1, 6, '*']])
  expect(marksOf('idle', 0)).toEqual([])
  // Every pose stays within its 7 columns and its two bottom rows
  for (const mood of MOODS) {
    for (let tick = 0; tick < 64; tick++) {
      const canvas = composeScene({ mood: 'idle', minis: [{ color: 0x58a6ff, mood }], hidden: 0, flights: [] }, tick)
      expect(canvas.pixels.slice(0, 4).every(row => row.slice(0, 8).every(pixel => pixel === null))).toBe(true)
      expect(canvas.pixels.every(row => row[7] === null)).toBe(true)
    }
  }
})

test('two small crabs in the same mood keep their own time', () => {
  const scene: Scene = { mood: 'idle', minis: [{ color: 0x58a6ff, mood: 'working' }, { color: 0x58a6ff, mood: 'working' }], hidden: 0, flights: [] }
  const canvas = composeScene(scene, 0)
  const first = canvas.pixels.map(row => row.slice(0, 7).join())
  const second = canvas.pixels.map(row => row.slice(8, 15).join())
  expect(first).not.toEqual(second)
})

test('small crabs past the shown ones are counted', () => {
  const scene: Scene = { mood: 'idle', minis: [{ color: 0x58a6ff, mood: 'working' }], hidden: 3, flights: [] }
  const canvas = composeScene(scene, 0)
  expect(canvas.columns).toBe(8 + 3 + 20)
  expect(canvas.marks.filter(mark => mark.row === 3).map(mark => [mark.column, mark.glyph])).toEqual([[8, '+'], [9, '3']])
})

test('a message flies in an arc from over its sender to beside the crab', () => {
  const blue = 0x58a6ff
  const paper = 0xf0f6fc
  const minis: Mini[] = [{ color: 0x3fb950, mood: 'working' }, { color: blue, mood: 'working' }]
  const at = (progress: number) => composeScene({ mood: 'idle', minis, hidden: 0, flights: [{ from: 1, color: blue, progress }] }, 1)
  // Over the second small crab's head, its flap in the sender's color; the width unchanged
  expect(at(0).columns).toBe(2 * 8 + 20)
  expect(at(0).pixels[2]?.slice(10, 13)).toEqual([paper, blue, paper])
  expect(at(0).pixels[3]?.slice(10, 13)).toEqual([paper, paper, paper])
  // Lifted two pixels halfway, then landing beside the crab's head
  expect(flightPoint(10, 16, 0.5)).toEqual({ column: 13, row: 0 })
  expect(at(1).pixels[2]?.slice(16, 19)).toEqual([paper, blue, paper])
  // One from a small crab past the drawn ones leaves from their count
  const hidden = composeScene({ mood: 'idle', minis: minis.slice(0, 1), hidden: 2, flights: [{ from: 1, color: blue, progress: 0 }] }, 1)
  expect(hidden.pixels[2]?.[8 + 1]).toBe(blue)
})
