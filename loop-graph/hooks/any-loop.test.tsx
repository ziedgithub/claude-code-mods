import { expect, mock, test } from 'claude-code/testing'

import { EDGES, MAP, NH, NODES, checkMap, setGraph } from './graph'
import { FEATURE_LOOP } from './maps.fixture'

const PANE = {
  plugin: 'loop-graph',
  component: 'Pane',
  requestId: 'loop-graph',
  props: { title: 'Loop', isFocused: false, bodyColumns: 84, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const still = (svg: string) => svg.replace(/ style="[^"]*animation:[^"]*"/g, '').replace(/ mvg"/g, '"')
const marker = (step: string) => ({ tool: 'Bash' as const, command: `node .claude/loop-graph/loop-step.mjs ${step}` })

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>

// `map` is what the project's map file holds, undefined for none.
function engine(on: Parameters<Body>[1], map: string | undefined, answer?: (e: { tool: string; command?: unknown }) => unknown) {
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'loop-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => (e.path === '/p/.claude/loop-graph/map.json' && map !== undefined ? { value: map } : { deny: 'ENOENT' }))
  on('tool.call', async (_, e) => ({ result: (await answer?.(e as unknown as { tool: string; command?: unknown })) ?? {} }))
  on('classic.SubagentStop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))

  return toasts
}

const paneOf = async ($: Parameters<Body>[0]) => {
  const m = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = still(String((await m.find({ type: 'Svg' }))?.props.source))
  await m.unmount()

  return svg
}

test('a loop with no lanes walks every step: its path shows from the first marker, named by the map', async ($, on) => {
  mock.clock(on)
  engine(on, JSON.stringify(FEATURE_LOOP), e => (String(e.command).includes('npm test') ? { stdout: 'Tests:       2 failed, 40 passed, 42 total', stderr: '' } : undefined))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++spawned}` }))

  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('spec --task login-form'))
  await $.tool.call(marker('build'))
  await $.tool.call({ tool: 'Bash' as const, command: 'node .claude/loop-graph/loop-step.mjs test && npm test' })

  const svg = await paneOf($)
  expect(svg).toContain('>login-form</text>')
  expect(svg).toContain('>Feature loop</text>')
  // Every step is on the path before it is reached, and no lane is talked of.
  expect(svg).toMatch(/<text class="sl pending"[^>]*>Ship<\/text>/)
  expect(svg).not.toContain('lane')
  // The runner rule read the test summary, and failing tests are to act on.
  expect(svg).toContain('>2 tests failed</text>')
  expect(svg).toContain('<g class="badge act">')

  // Back to Build by the arc the map draws, then a review sent back.
  await $.tool.call(marker('build'))
  await $.tool.call(marker('test'))
  await $.tool.call(marker('review'))
  await $.agent.spawn({
    tool_use_id: 'tu-r', prompt: 'Review', description: 'Review the diff', subagentType: 'reviewer',
    provider: { plugin: 'engine', tier: 'core' } as const, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'reviewer', agent_transcript_path: '/t', stop_hook_active: false, last_assistant_message: 'Two issues.\nVERDICT: FIX' })
  const reviewed = await paneOf($)
  expect(reviewed).not.toContain('unexpected jump')
  expect(reviewed).toContain('<g class="edge taken"><title>Test → Build: tests red · taken 1×</title>')
  expect(reviewed).toContain('>Review the diff came back FIX</text>')
})

test('a loop back into the first step goes on with the same run; the first step anew opens a new one', async ($, on) => {
  mock.clock(on)
  engine(on, JSON.stringify(FEATURE_LOOP))

  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('spec --task one'))
  await $.tool.call(marker('build'))
  await $.tool.call(marker('test'))
  await $.tool.call(marker('review'))
  await $.tool.call(marker('approve'))
  await $.tool.call(marker('spec'))
  const back = await paneOf($)
  expect(back).toContain('>one</text>')
  expect(back).toContain('<g class="edge taken"><title>Approve → Spec: rethink · taken 1×</title>')

  await $.tool.call(marker('build'))
  await $.tool.call(marker('spec --task two'))
  const fresh = await paneOf($)
  expect(fresh).toContain('>two</text>')
  expect(fresh).not.toContain('class="edge taken"')
})

test('the switch announced again with its lane goes on with the same run; a step of another lane moves the run to it', async ($, on) => {
  mock.clock(on)
  engine(on, JSON.stringify({
    name: 'Two paths',
    lanes: [{ id: 'fast', label: 'Fast lane' }, { id: 'careful', label: 'Careful lane' }],
    steps: [
      { id: 'scope', label: 'Scope', kind: 'switch', span: true },
      { id: 'code', label: 'Code', lanes: ['fast'], col: 0 },
      { id: 'plan', label: 'Plan', lanes: ['careful'], col: 1 },
      { id: 'done', label: 'Done', kind: 'end', col: 1 },
    ],
    arcs: [
      { from: 'scope', to: 'code', label: 'small', lane: 'fast' }, { from: 'scope', to: 'plan', label: 'big', lane: 'careful' },
      { from: 'code', to: 'plan', label: 'grew' }, { from: 'code', to: 'done' }, { from: 'plan', to: 'done' },
    ],
  }))

  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('scope --task ENG-1'))
  await $.tool.call(marker('scope --lane fast'))
  await $.tool.call(marker('code'))
  const fast = await paneOf($)
  expect(fast).toContain('>ENG-1</text>')
  expect(fast).toContain('>Fast lane</text>')
  await $.tool.call(marker('plan'))
  const moved = await paneOf($)
  expect(moved).toContain('>ENG-1</text>')
  expect(moved).toContain('>Careful lane</text>')
  expect(moved).not.toContain('unexpected jump')
})

test('the last step ends the run when its turn completes', async ($, on) => {
  mock.clock(on)
  engine(on, JSON.stringify(FEATURE_LOOP))

  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (const s of ['spec --task t', 'build', 'test', 'review', 'approve', 'ship']) await $.tool.call(marker(s))
  await $.turn.complete({ turnId: 't1', isAborted: false } as never)
  expect(await paneOf($)).toContain('>Finished</text>')
})

test('with no map in the project the pane says how to make one, and a marker moves nothing', async ($, on) => {
  mock.clock(on)
  engine(on, undefined)

  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('spec --task x'))
  const svg = await paneOf($)
  expect(svg).toContain('/loop-graph:setup')
  expect(svg).toContain('No loop run yet')
  expect(await $.command.run({ command: 'loop-graph', args: '' } as never)).toMatchObject({ text: expect.stringContaining('/loop-graph:setup') })
})

test('a map that does not load is said once, in words, and draws nothing', async ($, on) => {
  mock.clock(on)
  const toasts = engine(on, JSON.stringify({ ...FEATURE_LOOP, arcs: [...(FEATURE_LOOP.arcs ?? []), { from: 'ship', to: 'deploy' }] }))

  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  expect(toasts).toEqual([expect.stringContaining('an arc goes to "deploy", which is no step')])
  expect(await paneOf($)).toContain('/loop-graph:setup')
})

test('a map is checked in words its writer can act on', () => {
  expect(checkMap({ steps: [] })).toEqual(['the map has no "steps"'])
  expect(checkMap({ steps: [{ id: 'a', label: 'A', lanes: ['x'] }, { id: 'a', label: 'A' }], arcs: [{ from: 'a', to: 'b' }], outcomes: [{ match: '(', text: '' }] })).toEqual([
    'step "a" names lane "x", which "lanes" does not list',
    'step "a" is listed twice',
    'an arc goes to "b", which is no step',
    '"(" is not a regular expression',
  ])
})

test('a loop of any shape is laid out with no box on another and every route inside the map', () => {
  // Three columns, a step over them, loop-backs and skips in every direction.
  setGraph({
    name: 'Wide',
    lanes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    steps: [
      { id: 'pick', label: 'Pick', kind: 'switch', span: true },
      ...['a', 'b', 'c'].flatMap((l, col) => [1, 2, 3, 4].map(i => ({ id: `${l}${i}`, label: `${l.toUpperCase()} ${i}`, col, lanes: [l] }))),
      { id: 'end', label: 'End', kind: 'end' as const, col: 1 },
    ],
    arcs: [
      ...['a', 'b', 'c'].map(l => ({ from: 'pick', to: `${l}1`, label: l, lane: l })),
      ...['a', 'b', 'c'].flatMap(l => [1, 2, 3].map(i => ({ from: `${l}${i}`, to: `${l}${i + 1}` }))),
      { from: 'a4', to: 'a1', label: 'again' }, { from: 'a1', to: 'a3', label: 'skip' }, { from: 'a2', to: 'b1', label: 'move' },
      { from: 'c4', to: 'b2', label: 'back' }, { from: 'b4', to: 'end' }, { from: 'c3', to: 'c3', label: 'retry' }, { from: 'a1', to: 'b1', label: 'side' },
    ],
  })
  const boxes = NODES.map(n => ({ id: n.id, l: n.x - n.w / 2, r: n.x + n.w / 2, t: n.y - NH / 2, b: n.y + NH / 2 }))
  for (const p of boxes) {
    for (const q of boxes) {
      if (p !== q) expect({ p: p.id, q: q.id, overlap: p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b }).toEqual({ p: p.id, q: q.id, overlap: false })
    }
    expect(p.l).toBeGreaterThanOrEqual(0)
    expect(p.r).toBeLessThanOrEqual(MAP.W)
  }
  for (const e of EDGES) {
    const xs = [...e.d.matchAll(/-?[\d.]+/g)].map(m => Number(m[0]))
    expect({ e: e.id, inside: xs.every(v => v >= 0 && v <= Math.max(MAP.W, MAP.H)) }).toEqual({ e: e.id, inside: true })
  }
})
