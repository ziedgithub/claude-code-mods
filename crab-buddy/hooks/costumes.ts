// What a subagent's small crab wears for its kind of work: a hat, what it wears over its face
// (glasses), and a tool it holds at its right and uses while its agent works.
// All are drawn at two pixels a column, as the small crab is: a terminal cell shows four
// pixels in at most two colors, so the art keeps to two colors in each two by two block
export type Costume = 'builder' | 'planner' | 'explorer' | 'reviewer' | 'chef' | 'scholar' | 'wizard' | 'mechanic' | 'designer'

export type Outfit = {
  // Rows over its head, 14 pixels wide, the last over the top row of its head
  hat: readonly string[]
  // Rows over its face from its eyes down, 14 pixels wide, in every pose
  wear: readonly string[]
  // The tool, six pixels wide by the band's eight pixel rows: held, clear of the top row where
  // the crab's glyph shows, and the frames of its use
  tool: readonly string[]
  work: readonly (readonly string[])[]
  // Its color on the flap of the messages it sends
  flap: number
}

// The costumes' own colors, in lowercase letters beside the crab's uppercase ones
export const COSTUME_COLORS = {
  // hats: a hard hat's yellow with its light, a white one's grey, khaki and its band, a
  // mortarboard's black and grey, violet, gold, a cap's blue and its peak, a beret's red
  y: 0xf5c518,
  l: 0xfff3b0,
  w: 0xf4f4f4,
  x: 0xb8bcc2,
  t: 0xc8a165,
  r: 0x7a5a2e,
  i: 0x3d444d,
  a: 0x6e7681,
  v: 0x8957e5,
  j: 0xffd33d,
  n: 0x2f81f7,
  m: 0x1158c7,
  f: 0xda3633,
  // wear: glasses' frame and lenses
  k: 0x1f2328,
  q: 0x9ecbff,
  // tools: wood and its dark, steel and its dark, paper and its ink, red ink, a blueprint, paint
  b: 0xa0703c,
  d: 0x6b4423,
  g: 0xc9d1d9,
  h: 0x8b949e,
  p: 0xf6f8fa,
  c: 0x57606a,
  e: 0xe5534b,
  u: 0x1f6feb,
  z: 0x3fb950,
  // shades the outfits drawn at the crab's own size add: each hat's shadow, a steel and a
  // wood highlight, a blueprint's light lines
  1: 0xc99a06,
  2: 0xc9ced4,
  3: 0x9c7a45,
  4: 0x5f36b0,
  5: 0x1a5fd0,
  6: 0xa82724,
  7: 0xf6f8fa,
  8: 0xc48a4a,
  9: 0x79b8ff,
} as const

const NONE = '......'

// A tool drawn from a pixel row down, padded to the band's height
const at = (top: number, ...rows: string[]): readonly string[] =>
  Array.from({ length: 8 }, (_, row) => rows[row - top] ?? NONE)

const hardHat = (shell: string, ridge: string): readonly string[] => [
  `....${shell}${shell}${ridge}${ridge}${shell}${shell}....`,
  `..${shell.repeat(4)}${ridge}${ridge}${shell.repeat(4)}..`,
  `..${shell.repeat(4)}${ridge}${ridge}${shell.repeat(4)}..`,
  shell.repeat(14),
]

// An open wrench held up on a slant
const WRENCH = ['...g.g', '...ggg', '..gg..', '.gg...', 'gg....']
// A sheet's line of writing, then ticked in red
const SHEET = ['..ppcc', '..pppp']
const TICKED = ['..pecc', '..eppp']
// A ring of steel round a glass, its handle down to the claw
const LENS = ['.gggg.', 'ggqqgg', 'ggqqgg', '.gggg.', '.b....', 'b.....']

export const COSTUMES: Readonly<Record<Costume, Outfit>> = {
  // A yellow hard hat, hammering
  builder: {
    hat: hardHat('y', 'l'),
    wear: [],
    tool: at(2, 'gggg..', 'hhhh..', '.bb...', '.bb...', '.bb...'),
    work: [at(0, 'gggg..', 'hhhh..', '.bb...', '.bb...', '.bb...'), at(2, '....gg', '....gg', '....gg', 'bbbbgg')],
    flap: COSTUME_COLORS.y,
  },
  // A white hard hat and a blueprint, drawn line by line
  planner: {
    hat: hardHat('w', 'x'),
    wear: [],
    tool: at(2, 'uuuuuu', 'uppppu', 'uuupuu', 'upuupu', 'upuupu', 'uuuuuu'),
    work: [
      at(2, 'uuuuuu', 'uuuuuu', 'uuuuuu', 'uuuuuu', 'uuuuuu', 'uuuuuu'),
      at(2, 'uuuuuu', 'uppppu', 'uuuuuu', 'uuuuuu', 'uuuuuu', 'uuuuuu'),
      at(2, 'uuuuuu', 'uppppu', 'uuupuu', 'uuupuu', 'uuuuuu', 'uuuuuu'),
      at(2, 'uuuuuu', 'uppppu', 'uuupuu', 'upuupu', 'upuupu', 'uuuuuu'),
    ],
    flap: COSTUME_COLORS.u,
  },
  // A khaki explorer's helmet and a magnifying glass, sweeping up and down
  explorer: {
    hat: ['....tttttt....', '...tttttttt...', '..rrrrrrrrrr..', 'tttttttttttttt'],
    wear: [],
    tool: at(2, ...LENS),
    work: [at(0, ...LENS), at(2, ...LENS)],
    flap: COSTUME_COLORS.t,
  },
  // Glasses, ticking a sheet in red
  reviewer: {
    hat: [],
    wear: ['..OkqqkkqqkO..', '..OkEEOOEEkO..'],
    tool: at(2, ...SHEET, ...SHEET, ...SHEET),
    work: [at(2, ...SHEET, ...SHEET, ...SHEET), at(2, ...TICKED, ...SHEET, ...SHEET), at(2, ...TICKED, ...TICKED, ...SHEET), at(2, ...TICKED, ...TICKED, ...TICKED)],
    flap: COSTUME_COLORS.e,
  },
  // A chef's toque, stirring a pot
  chef: {
    hat: ['..ww.wwww.ww..', '.wwwwwwwwwwww.', '..wwwwwwwwww..', '..xxxxxxxxxx..'],
    wear: [],
    tool: at(2, '..bb..', '..bb..', '...b..', '...b..', '...b..'),
    work: [at(2, '...b..', '...b..', '...b..', '...b..', 'gggggg', 'hhhhhh'), at(2, '..b...', '..b...', '..b...', '..b...', 'gggggg', 'hhhhhh')],
    flap: COSTUME_COLORS.w,
  },
  // A mortarboard and its tassel, reading a book a page at a time
  scholar: {
    hat: ['....aaaaaa....', 'aaaaaaaaaaaaaa', '...iiiiiiii..j', '...iiiiiiii..j'],
    wear: [],
    tool: at(4, 'dddd..', 'djjd..', 'dddd..', 'pppp..'),
    work: [at(4, 'pppppp', 'pcpcpc', 'dddddd'), at(2, '..pp..', '..pp..', 'pppppp', 'pcpcpc', 'dddddd')],
    flap: COSTUME_COLORS.j,
  },
  // A starred wizard's hat, waving a wand
  wizard: {
    hat: ['.......vv.....', '.....vvvv.....', '....vvjvvv....', '.vvvvvvvvvvvv.'],
    wear: [],
    tool: at(2, '..jj..', '..jj..', '..d...', '..d...', '.d....', 'd.....'),
    work: [at(0, '...l.j', '....j.', '...d..', '..d...', '.d....', 'd.....'), at(4, '....lj', 'ddddjj', '.....l')],
    flap: COSTUME_COLORS.v,
  },
  // A blue cap, turning a wrench
  mechanic: {
    hat: ['..............', '...nnnnnnnn...', '..nnnnnnnnnn..', '..nnnnnnnnnnmm'],
    wear: [],
    tool: at(2, ...WRENCH),
    work: [at(0, ...WRENCH), at(0, '..gg.g', '..gggg', ...WRENCH.slice(2))],
    flap: COSTUME_COLORS.n,
  },
  // A red beret, painting from a palette
  designer: {
    hat: ['......f.......', '...ffffffff...', '.fffffffffffff'],
    wear: [],
    tool: at(4, 'tttttt', 'tftntz', 'tttttt'),
    work: [at(0, '...d..', '...d..', '...f..', '...f..', 'tttttt', 'tftntz', 'tttttt'), at(0, '..d...', '..d...', '..n...', '..n...', 'tttttt', 'tftntz', 'tttttt')],
    flap: COSTUME_COLORS.f,
  },
}

// The same outfits drawn again for the crab's own size, as an agent's crab wears them while
// its transcript is in view, at the crab's 32 pixels by 8: a hat of five rows, the last on
// the top row of its head, a tassel's rows past them; wear over its face from that row; and
// a tool ten pixels wide by the figure's twelve rows, held right of its claw
export type FullOutfit = { hat: readonly string[]; wear: readonly string[]; tool: readonly string[]; work: readonly (readonly string[])[] }

const BLANK = '..........'

// A tool at the crab's size drawn from a pixel row down, padded to the figure's height
const tall = (top: number, ...rows: string[]): readonly string[] =>
  Array.from({ length: 12 }, (_, row) => rows[row - top] ?? BLANK)

const hardHatOf = (shell: string, ridge: string, shade: string): readonly string[] => [
  `...........${shell.repeat(4)}${ridge}${ridge}${shell.repeat(3)}${shade}...........`,
  `.........${shell.repeat(6)}${ridge}${ridge}${shell.repeat(5)}${shade}.........`,
  `........${shell.repeat(7)}${ridge}${ridge}${shell.repeat(6)}${shade}........`,
  `........${shell.repeat(7)}${ridge}${ridge}${shell.repeat(6)}${shade}........`,
  `....${shell.repeat(23)}${shade}....`,
]

// A hammer's steel head over its handle; a magnifying glass, its lens catching the light; an
// open wrench
const HAMMER = ['7gggggh...', 'gggggggh..', 'hhhhhhhh..', '.8b.......', '.8b.......', '.8b.......', '.8b.......', '.8b.......', '.8b.......']
const FULL_LENS = ['..7ggg7...', '.gq99qqg..', 'gq9pqqqqg.', 'gqqqqqqqg.', 'gqqqqqqhg.', '.gqqqqhg..', '..ghhhg...', '.bb.......', 'bb........']
const FULL_WRENCH = ['.g...g....', '.gg.gg....', '..ggg.....', '..7gh.....', '..gh......', '..gh......', '..gh......', '..gh......', '.ggg......', 'g..g......']
// A clipboard's sheet of three lines, ticked one by one in red
const PAD = ['ddddgddd..', 'dpppppcd..', 'dpccccpd..', 'dppppppd..', 'dpccccpd..', 'dppppppd..', 'dpccccpd..', 'dddddddd..']
const ticked = (lines: number): readonly string[] =>
  PAD.map((row, i) => ([2, 4, 6].slice(0, lines).includes(i) ? 'depcccpd..' : row))

export const FULL_COSTUMES: Readonly<Record<Costume, FullOutfit>> = {
  builder: {
    hat: hardHatOf('y', 'l', '1'),
    wear: [],
    tool: tall(3, ...HAMMER),
    work: [
      tall(0, ...HAMMER),
      tall(5, '..........', '.......7gh', '.......ggh', '8bbbbbbggh', 'bbbbbbbggh', '.......hhh'),
    ],
  },
  planner: {
    hat: hardHatOf('w', 'x', '2'),
    wear: [],
    tool: tall(4, 'uuuuuuuuu.', 'u999999uu.', 'uuuu9uuuu.', 'u9uu9uu9u.', 'u9uu9uu9u.', 'u9uuuuu9u.', 'u9999999u.', 'uuuuuuuuu.'),
    work: [
      tall(4, 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.'),
      tall(4, 'uuuuuuuuu.', 'u999999uu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.'),
      tall(4, 'uuuuuuuuu.', 'u999999uu.', 'uuuu9uuuu.', 'u9uu9uuuu.', 'u9uu9uuuu.', 'u9uuuuuuu.', 'uuuuuuuuu.', 'uuuuuuuuu.'),
      tall(4, 'uuuuuuuuu.', 'u999999uu.', 'uuuu9uuuu.', 'u9uu9uu9u.', 'u9uu9uu9u.', 'u9uuuuu9u.', 'u9999999u.', 'uuuuuuuuu.'),
    ],
  },
  explorer: {
    hat: [
      '............tttttttt............',
      '..........ttttttttttt3..........',
      '.........tttttttttttttt3........',
      '........rrrrrrrrrrrrrrrr........',
      '...tttttttttttttttttttttttttt3..',
    ],
    wear: [],
    tool: tall(2, ...FULL_LENS),
    work: [tall(0, ...FULL_LENS), tall(3, ...FULL_LENS)],
  },
  reviewer: {
    hat: [],
    wear: ['', '.........gggggg..gggggg.........', '.........g....gggg....g.........', '.........g....g..g....g.........', '.........gggggg..gggggg.........'],
    tool: tall(4, ...PAD),
    work: [tall(4, ...PAD), tall(4, ...ticked(1)), tall(4, ...ticked(2)), tall(4, ...ticked(3))],
  },
  chef: {
    hat: [
      '.........wwww.wwww.wwww.........',
      '.......wwwwwwwwwwwwwwwww2.......',
      '........www2www2www2www2........',
      '.........ww2www2www2ww2.........',
      '........xxxxxxxxxxxxxxxx........',
    ],
    wear: [],
    tool: tall(3, '..8b......', '.8bbb.....', '.bbbb.....', '..bb......', '..b.......', '..b.......', '..b.......', '..b.......', '..b.......'),
    work: [
      tall(2, '....b.....', '....b.....', '....b.....', '...b......', '...b......', 'g7gggggggh', 'ghhhhhhhhh', '.ggggggggh', '.ghhhhhhh.', '..hhhhhh..'),
      tall(2, '..b.......', '..b.......', '..b.......', '...b......', '...b......', 'g7gggggggh', 'ghhhhhhhhh', '.ggggggggh', '.ghhhhhhh.', '..hhhhhh..'),
    ],
  },
  scholar: {
    hat: [
      '...............jj...............',
      '...aaaaaaaaaaaaaaaaaaaaaaaaaa...',
      '.....aaaaaaaaaaaaaaaaaaaaaaj....',
      '........iiiiiiiiiiiiiiii...j....',
      '.......iiiiiiiiiiiiiiiiii..j....',
      '...........................j....',
      '..........................jjj...',
    ],
    wear: [],
    tool: tall(5, 'ddddddd...', 'djjjjjd...', 'dddddddp..', 'dddddddp..', 'dddddddp..', 'dddddddp..', 'pppppppp..'),
    work: [
      tall(5, 'pppp.pppp.', 'pccp.pccp.', 'pppp.pppp.', 'pccpdpccp.', 'ppppdpppp.', 'ddddddddd.'),
      tall(3, '....pp....', '....pcp...', '....ppp...', 'pppp.pppp.', 'pccp.pccp.', 'pppp.pppp.', 'pccpdpccp.', 'ppppdpppp.', 'ddddddddd.'),
    ],
  },
  wizard: {
    hat: [
      '.......vvv......................',
      '.........vvvvvv.................',
      '..........vvvvjvvvv4............',
      '........vvvvvvvvvvvvvvv4........',
      '....vvvvvvvvvvvvvvvvvvvvvvv4....',
    ],
    wear: [],
    tool: tall(4, '......lj..', '.....jjj..', '......j...', '.....d....', '....d.....', '...d......', '..d.......', '.d........'),
    work: [
      tall(0, '.......l..', '......ljl.', '.....l.l..', '....jj....', '....d.....', '...d......', '...d......', '..d.......', '.d........'),
      tall(5, '.......l.l', '........j.', 'ddddddjjjl', '........j.', '.......l.l'),
    ],
  },
  mechanic: {
    hat: [
      '...............mm...............',
      '...........nnnnnnnnnn...........',
      '.........nnnnnnnnnnnnnn5........',
      '........nnnnnnnnnnnnnnnn5.......',
      '.......nnnnnnnnnnnnnnnnnnmmmmmm.',
    ],
    wear: [],
    tool: tall(2, ...FULL_WRENCH),
    work: [tall(0, ...FULL_WRENCH), tall(2, 'g.g.......', '.ggg......', '..ggg.....', '...7gh....', '....gh....', '.....gh...', '......gh..', '.......gh.', '........gg')],
  },
  designer: {
    hat: [
      '................................',
      '..............ff................',
      '........ffffffffffffff6.........',
      '....ffffffffffffffffffff66......',
      '...fff66666666666666666.........',
    ],
    wear: [],
    tool: tall(6, '.ttttttt..', 'ttfttnttt.', 'tttzt..tt.', 'ttyttt.tt.', '.ttttttt..'),
    work: [
      tall(0, '....d.....', '....d.....', '....d.....', '....d.....', '....f.....', '....f.....', '.ttttttt..', 'ttfttnttt.', 'tttzt..tt.', 'ttyttt.tt.', '.ttttttt..'),
      tall(0, '..d.......', '..d.......', '..d.......', '..d.......', '..n.......', '..n.......', '.ttttttt..', 'ttfttnttt.', 'tttzt..tt.', 'ttyttt.tt.', '.ttttttt..'),
    ],
  },
}
