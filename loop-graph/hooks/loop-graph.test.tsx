import { expect, mock, test } from 'claude-code/testing'

import { EDGES, MAP, NH, NODES, NODE_BY_ID, NW, setGraph } from './graph'
import { DEV_LOOP } from './maps.fixture'

// The /dev loop's map, laid out as the pane lays it out.
setGraph(DEV_LOOP)
// A box's corner on the map, as its rect is drawn.
const boxAt = (id: string) => {
  const n = NODE_BY_ID[id]

  return `x="${(n?.x ?? 0) - (n?.w ?? 0) / 2}" y="${(n?.y ?? 0) - NH / 2}"`
}
import { ROW_PX } from './pane'

const PANE = {
  plugin: 'loop-graph',
  component: 'Pane',
  requestId: 'loop-graph',
  props: {
    title: 'Loop',
    isFocused: false,
    bodyColumns: 84,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

// A step's stream settles only once read to its end.
async function step(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) void _
}

const spawnOf = (subagentType: string, description: string) => ({
  tool_use_id: `tu-${description}`, prompt: description, description, subagentType,
  provider: { plugin: 'engine', tier: 'core' } as const, parentModel: 'claude-opus-5-5', background: true, fork: false,
})

const USAGE = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}
// What the next request reports; a test sets the prompt it was answered over.
let usage = USAGE
const prompt = (tokens: number) => ({ ...USAGE, model: 'claude-sonnet-5-5', input_tokens: 1000, cache_read_input_tokens: tokens - 1500, cache_creation_input_tokens: 500 })

// The drawing as it holds still: the motion just after an arrival taken out.
const still = (svg: string) => svg.replace(/ style="[^"]*animation:[^"]*"/g, '').replace(/ mvg"/g, '"')

const marker = (step: string) => ({ tool: 'Bash' as const, command: `node tools/loop-step.mjs ${step}` })

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>

// `answer` is what the engine's tool answers a call with: run while the call
// is open, so a test can look at the pane mid-call.
function engine(on: Parameters<Body>[1], answer?: (e: { tool: string; command?: unknown }) => unknown) {
  on('command.register', () => ({ value: { command: 'loop-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => (/loop-graph\/map\.json$/.test(String(e.path)) ? { value: JSON.stringify(DEV_LOOP) } : { deny: 'ENOENT' }))
  on('tool.call', async (_, e) => ({ result: (await answer?.(e as unknown as { tool: string; command?: unknown })) ?? {} }))
  on('classic.SubagentStop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
}

test('a standard run follows the steps the loop announces, and the agent at work', async ($, on) => {
  mock.clock(on)
  engine(on)
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++spawned}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('dev.triage --task abc12345'))
  await $.tool.call(marker('orch.intake --lane standard --task abc12345'))
  await $.tool.call({ tool: 'Bash' as const, command: 'node tools/loop-step.mjs orch.startup && ./init.sh' })
  await $.tool.call(marker('orch.plan'))
  await $.agent.spawn(spawnOf('planner', 'Plan abc12345'))
  await step($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' }))
  await $.classic.SubagentStop({
    agent_id: 'a1', agent_type: 'planner', agent_transcript_path: '/t', stop_hook_active: false,
    last_assistant_message: 'Plan ready.\nPLAN: slices=2',
  })
  await $.tool.call(marker('orch.plan-gate'))
  await $.tool.call(marker('orch.implement'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 1'))
  await step($.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a2' }))

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = still(String((await desktop.find({ type: 'Svg' }))?.props.source))
  expect(svg).toContain('>abc12345</text>')
  expect(svg).toContain('>Standard lane</text>')
  expect(svg).toContain('>Working now</text>')
  expect(svg).toMatch(/>Implement slice 1 · opus-5-5 · working<\/text>/)
  // On the path, the arc taken into Implement is labelled and drawn solid.
  expect(svg).toMatch(/<text class="arc taken"[^>]*>approved<\/text>/)
  expect(svg).toMatch(/<text class="arc"[^>]*>no CRITICAL · screen changed<\/text>/)
  // On the map, the design's boxes: Implement at work, Plan done, the express lane not taken.
  expect(svg).toContain(`<g class="node active k-agent"><rect class="box" ${boxAt('orch.implement')}`)
  expect(svg).toContain(`<g class="node visited k-agent"><rect class="box" ${boxAt('orch.plan')}`)
  expect(svg).toContain(`<g class="node off k-self"><rect class="box" ${boxAt('quick.frame')}`)
  expect(svg).toContain('<g class="edge taken"><title>Plan gate → Implement')
  expect(svg).not.toContain('class="edge bad"')
  // The pane is a plain image, which its redraws never reload: an
  // interactive frame reloads, and flashes, on every redraw.
  expect((await desktop.find({ type: 'Svg' }))?.props.isInteractive).toBeUndefined()
  expect(svg).not.toContain('appear when it ends')
  await desktop.unmount()

  // Nothing on it loops: the only motion is the one just after an arrival.
  expect(svg).not.toContain('infinite')
  // More tokens for the agent at work leave the image exactly as it was.
  await step($.turn.step({ turnId: 't3', index: 1, model: 'claude-sonnet-5-5', messageCount: 2, agentId: 'a2' }))
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(still(String((await again.find({ type: 'Svg' }))?.props.source))).toBe(svg)
  await again.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /▶ Implement/ }))?.text).toBe('▶ Implement')
  await terminal.unmount()
})

test('a step announced out of the map\'s order is kept as an unexpected jump', async ($, on) => {
  mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane complete --task x'))
  await $.tool.call(marker('orch.evaluate'))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = still(String((await ui.find({ type: 'Svg' }))?.props.source))
  expect(svg).toContain('1 unexpected jump')
  expect(svg).toContain('Unexpected jump Intake → Evaluate')
  await ui.unmount()
})

test('a stopped step stays stopped through an unrelated message, until the loop announces it again', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '/dev x', turnId: 't1' })
  await $.tool.call(marker('dev.triage --task x'))
  await $.tool.call(marker('quick.frame'))
  await clock.advance(30_000)
  await $.turn.complete({ answer: '', durationMs: 30_000, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.advance(120_000)

  // A message about something else: a turn and its tokens, no marker.
  await $.turn.start({ text: 'what is this empty space?', turnId: 't2' })
  await step($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let svg = still(String((await ui.find({ type: 'Svg' }))?.props.source))
  expect(svg).toMatch(/>Stopped by you at \d\d:\d\d:\d\d<\/text>/)
  expect(svg).toContain('>30s of work · 0 tokens so far</text>')
  expect(svg).toContain(`<g class="node paused k-self"><rect class="box" ${boxAt('quick.frame')}`)
  expect(svg).not.toContain('class="node active k-')
  await ui.unmount()

  await $.tool.call(marker('quick.frame --note resumed'))
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  svg = still(String((await ui.find({ type: 'Svg' }))?.props.source))
  expect(svg).toContain('>Working now</text>')
  expect(svg).toContain(`<g class="node active k-self"><rect class="box" ${boxAt('quick.frame')}`)
  await ui.unmount()
})

test('only a marker moves the run: test runs, edits and reviews alone move nothing', async ($, on) => {
  mock.clock(on)
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'qr' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('quick.frame --task x'))
  await $.tool.call({ tool: 'Edit', file_path: '/r/test/a/b_test.dart', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash' as const, command: "flutter test test/a/b_test.dart --name 'x'" })
  await $.tool.call({ tool: 'Bash' as const, command: 'dart run tool/harness/verify.dart --gate analyze --no-record' })
  await $.tool.call({ tool: 'Skill', skill: 'code-review', args: 'low' })
  await $.tool.call(marker('quick.biuld'))

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let svg = still(String((await ui.find({ type: 'Svg' }))?.props.source))
  expect(svg).toContain(`<g class="node active k-self"><rect class="box" ${boxAt('quick.frame')}`)
  expect(svg).toContain(`<g class="node idle k-self"><rect class="box" ${boxAt('quick.test')}`)
  await ui.unmount()

  // Chained with the step's first command, and an agent on the step announced.
  await $.tool.call({ tool: 'Bash' as const, command: 'node tools/loop-step.mjs quick.test && flutter test x --name y' })
  await $.tool.call({ tool: 'Bash' as const, command: 'cd /r; node tools/loop-step.mjs quick.build; dart run tool/harness/verify.dart' })
  await $.tool.call(marker('quick.clean'))
  await $.tool.call(marker('quick.review'))
  await $.agent.spawn(spawnOf('general-purpose', 'Quick review x'))
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  svg = still(String((await ui.find({ type: 'Svg' }))?.props.source))
  expect(svg).not.toContain('class="edge bad"')
  for (const arc of ['Frame → Test first', 'Test first → Build \\+ tests', 'Build \\+ tests → Clean up', 'Clean up → Second look']) {
    expect(svg).toMatch(new RegExp(`<g class="edge taken"><title>${arc}: [^<]* · taken 1×`))
  }
  expect(svg).toContain(`<g class="node active k-agent"><rect class="box" ${boxAt('quick.review')}`)
  expect(svg).toMatch(/>Quick review x · opus-5-5 · working<\/text>/)
  await ui.unmount()
})

test('the last step ends the run when its turn completes', async ($, on) => {
  mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '/quick x', turnId: 't1' })
  for (const s of ['quick.frame --task x', 'quick.test', 'quick.build', 'quick.clean', 'quick.review', 'quick.recount', 'quick.cost', 'quick.finish']) {
    await $.tool.call(marker(s))
  }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = still(String((await ui.find({ type: 'Svg' }))?.props.source))
  expect(svg).toContain('>Finished</text>')
  expect(svg).toContain(`<g class="node visited k-end"><rect class="box" ${boxAt('quick.finish')}`)
  expect(svg).not.toContain('class="edge bad"')
  await ui.unmount()
})

test('a run whose last turn ends unseen ends with the last thing it did, not the next turn', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '/quick x', turnId: 't1' })
  await $.tool.call(marker('quick.frame --task x'))
  await clock.advance(60_000)
  await $.tool.call(marker('quick.finish'))
  // No end for that turn; ten minutes later a message about something else.
  await clock.advance(600_000)
  await $.turn.start({ text: 'something else', turnId: 't2' })
  await step($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = still(String((await ui.find({ type: 'Svg' }))?.props.source))
  expect(svg).toContain('>Finished</text>')
  expect(svg).toMatch(/>1m00s · [0-9.k]+ tokens<\/text>/)
  await ui.unmount()
})

test('each agent at work shows its live share of the context window, without the image changing', async ($, on) => {
  mock.clock(on)
  engine(on)
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++spawned}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task ctx1'))
  await $.tool.call(marker('orch.implement --slice 1/2'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 1'))
  usage = prompt(120_000)
  await step($.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' }))

  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = still(String((await first.find({ type: 'Svg' }))?.props.source))
  const live = async (m: typeof first) => (await m.findAll({ type: 'Box' }))
    .filter(b => b.props.position === 'absolute' && b.props.display !== 'none' && b.text.includes('% of'))
  expect((await live(first)).map(b => b.text)).toEqual(['0:00 · 16.0k spent · 12% of 1M'])
  expect(svg).toMatch(/>Implement slice 1 · sonnet-5-5 · working<\/text>/)
  expect(svg).not.toContain('120.0k')
  // The row it sits on is the one the drawing left for that agent's name.
  const row = (await live(first))[0]?.props.top as number
  const y = Number(svg.match(/<text class="nl" x="40" y="([\d.]+)">Implement slice 1/)?.[1])
  expect(Math.abs(y - (row * ROW_PX + 14))).toBeLessThan(1)
  await first.unmount()

  usage = prompt(340_000)
  await step($.turn.step({ turnId: 't1', index: 1, model: 'claude-sonnet-5-5', messageCount: 2, agentId: 'a1' }))
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(still(String((await later.find({ type: 'Svg' }))?.props.source))).toBe(svg)
  expect((await live(later)).map(b => b.text.replace(/^.* spent · /, ''))).toEqual(['34% of 1M'])
  await later.unmount()

  // A compaction is a signal turning on: the image changes once, for it.
  usage = prompt(90_000)
  await step($.turn.step({ turnId: 't1', index: 2, model: 'claude-sonnet-5-5', messageCount: 3, agentId: 'a1' }))
  const compacted = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(still(String((await compacted.find({ type: 'Svg' }))?.props.source))).toContain('>Slice 1 was compacted</text>')
  expect((await live(compacted)).map(b => b.text.replace(/^.* spent · /, ''))).toEqual(['9% of 1M'])
  await compacted.unmount()

  // Once it is done, its card keeps the largest context it reached.
  await $.classic.SubagentStop({
    agent_id: 'a1', agent_type: 'implementer', agent_transcript_path: '/t', stop_hook_active: false,
    last_assistant_message: 'SLICE: GREEN | BUILD: PASS | TESTS: 4/4',
  })
  const done = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await live(done)).toHaveLength(0)
  await done.unmount()
  usage = USAGE
})

test('a step\'s progress comes from its announced slices or the agents it sent at once, and nothing else', async ($, on) => {
  mock.clock(on)
  engine(on)
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++spawned}` }))
  const nowCard = async () => {
    const m = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const svg = still(String((await m.find({ type: 'Svg' }))?.props.source))
    await m.unmount()

    return svg.match(/<text class="np"[^>]*>([^<]*)<\/text>/)?.[1]
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task prog1'))
  await $.tool.call(marker('orch.plan'))
  await $.agent.spawn(spawnOf('planner', 'Plan prog1'))
  expect(await nowCard()).toBeUndefined()

  await $.tool.call(marker('orch.implement --slice 2/3'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 2'))
  expect(await nowCard()).toBe('Slice 2 of 3 · 1 green · 33%')
  await $.classic.SubagentStop({
    agent_id: 'a2', agent_type: 'implementer', agent_transcript_path: '/t', stop_hook_active: false,
    last_assistant_message: 'SLICE: GREEN | BUILD: PASS | TESTS: 9/9',
  })
  expect(await nowCard()).toBe('Slice 2 of 3 · 2 green · 67%')
  // A fix pass announces no slice and keeps the count.
  await $.tool.call(marker('orch.implement'))
  expect(await nowCard()).toBe('Slice 2 of 3 · 2 green · 67%')

  await $.tool.call(marker('orch.simplify'))
  await $.tool.call(marker('orch.reviewers'))
  await $.agent.spawn(spawnOf('test-quality-reviewer', 'Review tests'))
  await $.agent.spawn(spawnOf('database-reviewer', 'Review data'))
  expect(await nowCard()).toBe('0 of 2 agents finished · 0%')
  await $.classic.SubagentStop({
    agent_id: 'a4', agent_type: 'database-reviewer', agent_transcript_path: '/t', stop_hook_active: false,
    last_assistant_message: 'FINDINGS: none',
  })
  expect(await nowCard()).toBe('1 of 2 agents finished · 50%')
})

test('with no agent at work, the session itself shows its live share of the context window', async ($, on) => {
  mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('quick.frame --task ses1'))
  await $.tool.call(marker('quick.test'))
  usage = prompt(250_000)
  await step($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))

  const m = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = still(String((await m.find({ type: 'Svg' }))?.props.source))
  expect(svg).toMatch(/>This session · since \d\d:\d\d:\d\d<\/text>/)
  const live = (await m.findAll({ type: 'Box' }))
    .filter(b => b.props.position === 'absolute' && b.props.display !== 'none' && b.text.includes('% of'))
  expect(live.map(b => b.text)).toEqual(['25% of 1M · 250.0k'])
  await m.unmount()
  usage = USAGE
})

test('a marker named in a commit message, a heredoc or a quoted string moves nothing; one that runs does', async ($, on) => {
  mock.clock(on)
  engine(on)
  const current = async () => {
    const m = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const at = (await m.find({ type: 'Text', text: /^▶ / }))?.text
    await m.unmount()

    return at
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('quick.frame --task txt1'))
  await $.tool.call(marker('quick.recount'))
  await $.tool.call({ tool: 'Bash' as const, command: [
    'git add tools/loop-step.mjs && git commit -q -F - <<\'EOF\'',
    'harness: the implement step\'s marker says which slice',
    '',
    '`node tools/loop-step.mjs orch.implement --slice <K>/<N>` before each slice\'s dispatch.',
    'node tools/loop-step.mjs orch.plan',
    'EOF',
    'git log --oneline -1',
  ].join('\n') })
  await $.tool.call({ tool: 'Bash' as const, command: 'git commit -m "run node tools/loop-step.mjs orch.evaluate; then" && echo node tools/loop-step.mjs orch.debt' })
  await $.tool.call({ tool: 'Bash' as const, command: 'grep -n "loop-step.mjs orch.done" .agents/skills/orchestrate/SKILL.md' })
  expect(await current()).toBe('▶ Recount')

  await $.tool.call({ tool: 'Bash' as const, command: 'cd /repo && node tools/loop-step.mjs quick.cost --note "a; b" && node .agents/skills/loop-report/loop-cost.mjs' })
  expect(await current()).toBe('▶ Record cost')
})

test('the pane opens with an interactive session in a repo that runs the loop, and only there', async ($, on) => {
  on('command.register', () => ({ value: { command: 'loop-graph' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => (e.path === '/repo/.claude/loop-graph/map.json' ? { value: JSON.stringify(DEV_LOOP) } : { deny: 'ENOENT' }))
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })

  await $.session.start({ cwd: '/elsewhere', surface: 'desktop', isInteractive: true })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: false })
  expect(opened).toEqual([])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual(['loop-graph'])
})

test('the arcs a run took are drawn over the others, with a count beside one crossed more than once', async ($, on) => {
  mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task arc1'))
  for (const step of ['orch.startup', 'orch.plan', 'orch.plan-gate', 'orch.plan', 'orch.plan-gate', 'orch.implement']) {
    await $.tool.call(marker(step))
  }
  const m = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = still(String((await m.find({ type: 'Svg' }))?.props.source))
  await m.unmount()

  // Plan → Plan gate twice, and back once by feedback: the count shows on the
  // arc crossed twice only, and every taken arc comes after every other.
  expect(svg).toMatch(/<title>Plan → Plan gate: plan written · taken 2×<\/title><path [^>]*\/><text class="cnt"[^>]*>×2<\/text>/)
  expect(svg).toMatch(/<title>Plan gate → Plan: feedback · taken 1×<\/title><path [^>]*\/><text class="el taken"[^>]*>feedback<\/text><\/g>/)
  // The map is drawn once for a wide pane and, when it can be read there,
  // once more for a narrow one: the first drawing is read.
  const counted = [...svg.matchAll(/<title>([^<]*)<\/title><path [^>]*\/>(?:<text class="el[^<]*<\/text>)?<text class="cnt"/g)].map(x => x[1])
  expect([...new Set(counted)]).toEqual(['Plan → Plan gate: plan written · taken 2×'])
  const all = [...svg.matchAll(/<g class="edge (taken|open|off)">/g)].map(x => x[1])
  const edges = all.slice(0, EDGES.length)
  expect(edges.lastIndexOf('open')).toBeLessThan(edges.indexOf('taken'))
  expect(edges.filter(x => x === 'taken')).toHaveLength(5)
})

test('the map beside the path is never cut: the image is as tall as the map drawn at its scale', async ($, on) => {
  mock.clock(on)
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const m = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 118, scroll: { offset: 0, bodyRows: 66 } } })
  const svg = still(String((await m.find({ type: 'Svg' }))?.props.source))
  await m.unmount()

  const width = Number(svg.match(/^<svg [^>]*width="(\d+)"/)?.[1])
  const height = Number(svg.match(/^<svg [^>]*height="(\d+)"/)?.[1])
  const map = svg.match(/<svg class="w" x="(\d+)" y="([\d.]+)" width="(\d+)"/)
  const scale = Number(map?.[3]) / MAP.W
  expect(Number(map?.[1]) + Number(map?.[3])).toBe(width)
  expect(height).toBeGreaterThanOrEqual(Math.floor(Number(map?.[2]) + MAP.H * Math.min(scale, (66 * 20.1 - 16 - Number(map?.[2])) / MAP.H)))
  // Past the path's column a separator, then the map, its width nearly all
  // that is left: a fifth larger than when it took 48 %.
  expect(svg).toContain('<line class="sep w" x1="304"')
  expect(scale).toBeGreaterThan((width * 0.48) / MAP.W * 1.15)
})

test('every route on the map leaves and enters its own boxes, its ends apart, and no label sits on a box', () => {
  setGraph(DEV_LOOP)
  const box = (id: string) => {
    const n = NODE_BY_ID[id]
    const w = n?.w ?? NW

    return { l: (n?.x ?? 0) - w / 2, r: (n?.x ?? 0) + w / 2, t: (n?.y ?? 0) - NH / 2, b: (n?.y ?? 0) + NH / 2 }
  }
  // A margin route: `M x y H …` out of one box's side, its last `… y H x` into another's.
  const ends: { id: string; side: string; y: number }[] = []
  for (const e of EDGES.filter(x => / V /.test(x.d) && / Q /.test(x.d))) {
    const [, sx, sy] = e.d.match(/^M ([\d.]+) ([\d.]+)/) ?? []
    const [, ey, ex] = e.d.match(/([\d.]+) H ([\d.]+)$/) ?? []
    const a = box(e.from)
    const b = box(e.to)
    expect({ e: e.id, out: Number(sy) >= a.t + 3 && Number(sy) <= a.b - 3 }).toEqual({ e: e.id, out: true })
    expect({ e: e.id, in: Number(ey) >= b.t + 3 && Number(ey) <= b.b - 3 }).toEqual({ e: e.id, in: true })
    ends.push({ id: e.from, side: Number(sx) > (NODE_BY_ID[e.from]?.x ?? 0) ? 'r' : 'l', y: Number(sy) })
    ends.push({ id: e.to, side: Number(ex) > (NODE_BY_ID[e.to]?.x ?? 0) ? 'r' : 'l', y: Number(ey) })
  }
  for (const a of ends) {
    for (const b of ends) {
      if (a !== b && a.id === b.id && a.side === b.side) expect({ a, b, apart: Math.abs(a.y - b.y) >= 5 }).toEqual({ a, b, apart: true })
    }
  }
  for (const e of EDGES) {
    if (e.at === undefined || e.label === '' || e.at.isVertical) continue
    const on = NODES.map(n => box(n.id)).find(k => e.at !== undefined && e.at.x > k.l && e.at.x < k.r && e.at.y > k.t && e.at.y < k.b)
    expect({ e: e.id, onBox: on !== undefined }).toEqual({ e: e.id, onBox: false })
  }
})

const paneSvgOf = async ($: Parameters<Body>[0], props: object = {}) => {
  const m = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, ...props } })
  const svg = still(String((await m.find({ type: 'Svg' }))?.props.source))
  await m.unmount()

  return svg
}
// The text laid live over the image.
const liveOf = async ($: Parameters<Body>[0]) => {
  const m = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await m.findAll({ type: 'Box' })).filter(b => b.props.position === 'absolute' && String(b.key ?? '').startsWith('live-')).map(b => b.text)
  await m.unmount()

  return texts
}
const stop = (agent_id: string, agent_type: string, last_assistant_message: string) =>
  ({ agent_id, agent_type, agent_transcript_path: '/t', stop_hook_active: false, last_assistant_message })

test('a question you are asked holds the step waiting for you until you answer it', async ($, on) => {
  mock.clock(on)
  let during = ''
  let duringLive: string[] = []
  engine(on, async e => {
    if (e.tool === 'AskUserQuestion') {
      during = await paneSvgOf($)
      duringLive = await liveOf($)
    }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task w1'))
  await $.tool.call(marker('orch.plan'))
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)

  expect(during).toContain('>Waiting for you</text>')
  expect(during).toMatch(/>A question is open in the chat · since \d\d:\d\d:\d\d<\/text>/)
  // Its row on the path counts the wait, live over the image.
  expect(during).not.toMatch(/<text class="sm waiting/)
  expect(duringLive).toContain('waiting 0:00')
  expect(during).toContain(`<g class="node waiting k-agent"><rect class="box" ${boxAt('orch.plan')}`)
  const after = await paneSvgOf($)
  expect(after).toContain('>Working now</text>')
  expect(after).not.toContain('class="node waiting k-')
})

test('an agent\'s permission prompt holds its step waiting for you until the call it guards ends', async ($, on) => {
  mock.clock(on)
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  on('classic.PermissionRequest', () => ({}))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task w2'))
  await $.tool.call(marker('orch.implement --slice 1/2'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 1'))
  await $.classic.PermissionRequest({
    session_id: 's', transcript_path: '/t', cwd: '/', hook_event_name: 'PermissionRequest', agent_id: 'a1',
    tool_name: 'Bash', tool_input: {},
  } as never)

  const waiting = await paneSvgOf($)
  expect(waiting).toContain('>Waiting for you</text>')
  expect(waiting).toMatch(/>Implement slice 1 · sonnet-5-5 · asks permission for Bash<\/text>/)
  expect(waiting).not.toContain('Implement slice 1 asks permission')
  expect(waiting).toContain(`<g class="node waiting k-agent"><rect class="box" ${boxAt('orch.implement')}`)

  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' } as never)
  expect(await paneSvgOf($)).toContain('>Working now</text>')
})

test('a Planner that stops on questions waits for answers until it is sent them', async ($, on) => {
  mock.clock(on)
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'p1' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task w3'))
  await $.tool.call(marker('orch.plan'))
  await $.agent.spawn(spawnOf('planner', 'Plan w3'))
  await $.classic.SubagentStop(stop('p1', 'planner', 'Two questions before I plan:\n1. Which screen?\n2. Which state?'))

  const asking = await paneSvgOf($)
  expect(asking).toMatch(/>Plan w3 · opus-5-5 · waits for answers<\/text>/)
  expect(asking).not.toMatch(/<text class="sm waiting/)
  expect(await liveOf($)).toContain('waiting 0:00')

  await $.tool.call({ tool: 'SendMessage', to: 'p1', message: 'The home screen.' } as never)
  expect(await paneSvgOf($)).toMatch(/>Plan w3 · opus-5-5 · working<\/text>/)
})

test('a turn that ends at a gate leaves the step waiting for you, not idle', async ($, on) => {
  mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '/dev x', turnId: 't1' })
  await $.tool.call(marker('orch.intake --lane standard --task w4'))
  await $.tool.call(marker('orch.plan-gate'))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const svg = await paneSvgOf($)
  expect(svg).toContain('>Waiting for you</text>')
  expect(svg).toMatch(/>Your reply in the chat moves it on · since \d\d:\d\d:\d\d<\/text>/)
  expect(svg).not.toContain('Session idle')
})

test('each step shows what it came to, read from what the loop reported', async ($, on) => {
  mock.clock(on)
  engine(on, e => (e.tool === 'Bash' && String(e.command).includes('flutter test')
    ? { stdout: '00:41 +3157: some test\n01:07 +3158: All tests passed!', stderr: '' }
    : undefined))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++spawned}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task o1'))
  await $.tool.call(marker('orch.plan'))
  await $.agent.spawn(spawnOf('planner', 'Plan o1'))
  await $.classic.SubagentStop(stop('a1', 'planner', '## 📋 Plan ready — o1\n| # | Slice |\n|---|---|\n| 1 | a |\n| 2 | b |\nPLAN: slices=2'))
  await $.tool.call(marker('orch.plan-gate'))
  await $.tool.call(marker('orch.implement --slice 1/2'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 1'))
  await $.classic.SubagentStop(stop('a2', 'implementer', 'done\nSLICE: GREEN | BUILD: PASS | TESTS: 4/4'))
  await $.tool.call(marker('orch.reviewers'))
  await $.agent.spawn(spawnOf('security-reviewer', 'Security review'))
  await $.agent.spawn(spawnOf('test-quality-reviewer', 'Test review'))
  await $.classic.SubagentStop(stop('a3', 'security-reviewer', 'FINDINGS: CRITICAL=0 HIGH=1'))
  await $.classic.SubagentStop(stop('a4', 'test-quality-reviewer', 'FINDINGS: CRITICAL=0 HIGH=0'))
  await $.tool.call(marker('orch.evaluate'))
  await $.agent.spawn(spawnOf('evaluator', 'Evaluate o1'))
  await $.classic.SubagentStop(stop('a5', 'evaluator', 'VERDICT: ACCEPT | SCORE: 11/12 | CATEGORIES: x | DEBT: created=0 closed=0 | BLOCKING: 0 | NONBLOCKING: 2'))
  await $.tool.call(marker('orch.debt'))
  await $.tool.call({ tool: 'Bash', command: 'flutter test test/home/' } as never)

  const svg = await paneSvgOf($)
  const outcome = (text: string) => expect(svg).toMatch(new RegExp(`<text class="so"[^>]*>${text.replace(/[+.]/g, '\\$&')}</text>`))
  outcome('2 slices')
  outcome('1/2 slices green · 4/4 tests')
  outcome('2 reviews · 0 critical · 1 high')
  outcome('ACCEPT · 11/12')
  outcome('approved')
  outcome('3158 tests passed')
  // A step not reached keeps its role.
  expect(svg).toMatch(/<text class="sr"[^>]*>ship \+ loop report<\/text>/)
})

test('the step at work says what it does in a few words under its name', async ($, on) => {
  mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task d1'))
  await $.tool.call(marker('orch.startup'))

  const svg = await paneSvgOf($)
  expect(svg).toContain('<text class="nt" x="40" y="')
  expect(svg).toMatch(/<text class="nd" x="40" y="[\d.]+">Every fast gate once: the baseline<\/text>/)
})

test('a narrow pane too short for a readable map says to widen it instead of drawing a smudge', async ($, on) => {
  mock.clock(on)
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task n1'))
  const short = await paneSvgOf($, { bodyColumns: 60, scroll: { offset: 0, bodyRows: 75 } })
  expect(short).not.toContain('<g class="n" transform')
  expect(short).toContain('>Widen the pane to see the whole map.</text>')

  const tall = await paneSvgOf($, { bodyColumns: 60, scroll: { offset: 0, bodyRows: 140 } })
  const scale = Number(tall.match(/<g class="n" transform="translate\(-[\d.]+ 0\)"><svg x="50%" y="[\d.]+" width="([\d.]+)"/)?.[1]) / MAP.W
  expect(scale).toBeGreaterThanOrEqual(0.75)
  expect(tall).not.toContain('Widen the pane')
})

test('nothing is drawn past the pane\'s bottom: a long path closes up, and the events are drawn whole or not at all', async ($, on) => {
  mock.clock(on)
  engine(on)
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `a${++spawned}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('dev.triage --task b1'))
  await $.tool.call(marker('orch.intake --lane complete --task b1'))
  await $.tool.call(marker('orch.implement --slice 1/3'))
  for (const d of ['one', 'two', 'three', 'four', 'five']) await $.agent.spawn(spawnOf('implementer', d))

  for (const [cols, rows] of [[86, 52], [60, 52], [118, 40], [60, 36], [86, 44]] as const) {
    const svg = await paneSvgOf($, { bodyColumns: cols, scroll: { offset: 0, bodyRows: rows } })
    const height = Number(svg.match(/^<svg [^>]*height="(\d+)"/)?.[1])
    const left = svg.slice(svg.indexOf('<g class="left">'), svg.indexOf('<svg class="w"'))
    const bottoms = [...left.matchAll(/<text [^>]*y="([\d.]+)"/g)].map(m => Number(m[1]))
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(height)
  }
})

test('under Implement, each slice and each fix pass is a sub-step with its own time and largest share of context', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++spawned}` }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task s1'))
  await $.tool.call(marker('orch.implement --slice 1/2'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 1'))
  await step($.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' }))
  await clock.advance(400_000)
  await $.classic.SubagentStop(stop('a1', 'implementer', 'SLICE: GREEN | BUILD: PASS | TESTS: 412/412'))
  await $.tool.call(marker('orch.implement --slice 2/2'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 2'))
  await clock.advance(70_000)
  await $.classic.SubagentStop(stop('a2', 'implementer', 'SLICE: GREEN | BUILD: PASS | TESTS: 418/418'))
  await $.tool.call(marker('orch.implement'))
  await $.agent.spawn(spawnOf('implementer', 'Fix the review findings'))

  const svg = await paneSvgOf($)
  const sub = (label: string) => svg.match(new RegExp(`<text class="ul"[^>]*>${label}</text><text class="sm[^"]*n"[^>]*>([^<]*)</text>`))?.[1]
  expect(sub('Slice 1')).toBe('6m40s')
  expect(sub('Slice 2')).toBe('1m10s')
  expect(sub('Fix pass')).toMatch(/^since \d\d:\d\d:\d\d$/)
  expect(svg).toMatch(/<text class="uo"[^>]*>green · 412\/412 tests<\/text>/)
  expect(svg).toMatch(/<text class="uo"[^>]*>green · 418\/418 tests<\/text>/)
  // Slice 1 answered one request over a 3,000-token prompt; slice 2 made none.
  expect(svg.match(/<text class="uo w"[^>]*>peak [^<]*<\/text>/g)).toEqual([expect.stringContaining('>peak 0% of 1M<')])
})

const agentRun = async ($: Parameters<Body>[0], on: Parameters<Body>[1], steps: string[]) => {
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++spawned}` }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const s of steps) await $.tool.call(marker(s))
}
const request = (agentId: string, index: number) =>
  step($.turn.step({ turnId: 't', index, model: 'claude-sonnet-5-5', messageCount: index + 1, agentId }))
let $: Parameters<Body>[0]
const liveTexts = async () => {
  const m = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await m.findAll({ type: 'Text' })).filter(t => /% of/.test(t.text)).map(t => ({ text: t.text.replace(/^.* spent · /, ''), color: t.props.color }))
  await m.unmount()

  return texts
}

test('an agent past 80% of its context is worth a look, past 90% to act on, its figure coloured to match', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task c1', 'orch.reviewers'])
  await $.agent.spawn(spawnOf('test-quality-reviewer', 'Test review'))

  usage = prompt(850_000)
  await request('a1', 0)
  const watch = await paneSvgOf($)
  expect(watch).toContain('>1 thing is worth a look</text>')
  expect(watch).toContain('>Test quality review is past 80% of its context</text>')
  expect(await liveTexts()).toEqual([{ text: '85% of 1M', color: 'warning' }])
  // A moving figure that stays past the same threshold changes nothing drawn.
  usage = prompt(870_000)
  await request('a1', 1)
  expect(await paneSvgOf($)).toBe(watch)

  usage = prompt(950_000)
  await request('a1', 2)
  const act = await paneSvgOf($)
  expect(act).toContain('>1 thing needs a look · 1 to act on</text>')
  expect(act).toContain('>Test quality review is past 90% of its context</text>')
  expect(await liveTexts()).toEqual([{ text: '95% of 1M', color: 'error' }])
  usage = USAGE
})

test('a request after the first that finds the cache cold marks its step, with who went cold, after how long idle, and the extra it cost', async (engine$, on) => {
  $ = engine$
  const clock = mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task k1', 'orch.simplify'])
  await $.agent.spawn(spawnOf('simplify-cleaner', 'Simplify'))
  usage = { ...USAGE, input_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40_000 }
  await request('a1', 0)
  expect(await paneSvgOf($)).not.toContain('Cold cache')

  await clock.advance(10 * 60_000)
  await request('a1', 1)
  const svg = await paneSvgOf($)
  expect(svg).toContain('>Cold cache at Simplify</text>')
  expect(svg).toContain('>Simplify after 10m00s idle · 46.0k extra</text>')
  expect(svg).toMatch(/<text class="sl active"[^>]*>Simplify<\/text><circle cx="\d+" cy="[\d.]+" r="6.2" style="fill:var\(--warnfill\)/)
  expect(svg).toContain('<g class="badge watch">')
  usage = USAGE
})

test('the session going cold is named apart from the agents at the same step, each with its longest idle gap', async (engine$, on) => {
  $ = engine$
  const clock = mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task k2', 'orch.device'])
  const cold = { ...USAGE, input_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 40_000 }
  const main = (index: number) => step($.turn.step({ turnId: 'm', index, model: 'claude-opus-5-5', messageCount: index + 1 }))
  await main(0)
  await clock.advance(2 * 60 * 60_000)
  usage = cold
  await main(1)
  usage = USAGE
  await $.agent.spawn(spawnOf('device-checker', 'Phone check'))
  await request('a1', 0)
  for (const idle of [29, 6]) {
    await clock.advance(idle * 60_000)
    usage = cold
    await request('a1', 1)
    usage = USAGE
  }

  const svg = await paneSvgOf($)
  expect(svg).toContain('>Cold cache at Phone check</text>')
  expect(svg).toContain('>the session after 2h00m idle, Phone check 2× up to 29m00s idle · 138.0k extra</text>')
  usage = USAGE
})

test('an agent with no request for five minutes is marked silent, until its next request', async (engine$, on) => {
  $ = engine$
  const clock = mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task q1', 'orch.reviewers'])
  await $.agent.spawn(spawnOf('security-reviewer', 'Security review'))
  await request('a1', 0)
  await clock.advance(4 * 60_000)
  expect(await paneSvgOf($)).not.toContain('silent since')

  await clock.advance(2 * 60_000)
  const svg = await paneSvgOf($)
  expect(svg).toMatch(/>Security review silent since \d\d:\d\d:\d\d<\/text>/)
  expect(svg).toMatch(/<text class="nl watch"[^>]*>Security review · [a-z0-9-]+ · silent since/)

  await request('a1', 1)
  expect(await paneSvgOf($)).not.toContain('silent since')
})

test('a second pass back to a step is worth a look; a third reviewer round is to act on', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task f1', 'orch.implement --slice 1/1', 'orch.simplify', 'orch.reviewers',
    'orch.implement', 'orch.reviewers', 'orch.evaluate', 'orch.implement'])
  const twice = await paneSvgOf($)
  expect(twice).toContain('>2nd pass back to Implement</text>')
  expect(twice).toContain('>Sent back by [BLOCKING] fix, REVISE</text>')

  await $.tool.call(marker('orch.reviewers'))
  const third = await paneSvgOf($)
  expect(third).toContain('>3rd visit to Reviewer gate, past the cap of 2</text>')
  expect(third).not.toContain('pass back to Implement')
})

test('a red slice, a critical finding or failing tests are to act on, until a later pass comes back clean', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on, e => (String(e.command).includes('flutter test') ? { stdout: '01:07 +3156 -2: Some tests failed.', stderr: '' } : undefined))
  await agentRun($, on, ['orch.intake --lane standard --task b2', 'orch.implement --slice 1/1'])
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 1'))
  await $.classic.SubagentStop(stop('a1', 'implementer', 'SLICE: RED | BUILD: PASS | TESTS: 409/412'))
  const red = await paneSvgOf($)
  expect(red).toContain('>Slice 1 came back red · 409/412 tests</text>')
  // The mark is the slice's own, not the step's.
  expect(red).toMatch(/>Slice 1<\/text><circle cx="\d+" cy="[\d.]+" r="6" style="fill:var\(--bad\)"/)

  await $.tool.call(marker('orch.implement'))
  await $.tool.call(marker('orch.implement --slice 1/1'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 1 again'))
  await $.classic.SubagentStop(stop('a2', 'implementer', 'SLICE: GREEN | BUILD: PASS | TESTS: 412/412'))
  expect(await paneSvgOf($)).not.toContain('came back red')

  await $.tool.call(marker('orch.reviewers'))
  await $.agent.spawn(spawnOf('security-reviewer', 'Security review'))
  await $.classic.SubagentStop(stop('a3', 'security-reviewer', 'FINDINGS: CRITICAL=1 HIGH=0'))
  await $.tool.call({ tool: 'Bash', command: 'flutter test test/home/' } as never)
  const bad = await paneSvgOf($)
  expect(bad).toContain('>Security review came back 1 critical · 0 high</text>')
  expect(bad).toContain('>2 tests failed</text>')
  expect(bad).toContain('<g class="badge act">')
})

test('an agent that ends without its report line is worth a look; nothing needing a look draws no box', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task m1', 'orch.simplify'])
  await $.agent.spawn(spawnOf('simplify-cleaner', 'Simplify'))
  const calm = await paneSvgOf($)
  expect(calm).not.toContain('class="abox')
  expect(calm).not.toContain('<g class="badge')

  await $.classic.SubagentStop(stop('a1', 'simplify-cleaner', 'I cleaned a few things.'))
  const svg = await paneSvgOf($)
  expect(svg).toContain('<rect class="abox watch"')
  expect(svg).toContain('>Simplify ended without its report line</text>')
})

test('a report handed back through the hand-back call is read like a last message, and its slice comes from the loop or the agent\'s name', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task h1', 'orch.implement --slice 1/2'])
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 1 of h1'))
  await $.tool.call({ tool: 'SubagentHandback', message: 'Done.\n\nSLICE: GREEN | BUILD: PASS | TESTS: 918/918', agentId: 'a1' } as never)
  await $.classic.SubagentStop(stop('a1', 'implementer', 'Now restructure the detail screen build.'))
  const svg = await paneSvgOf($)
  expect(svg).toMatch(/<text class="uo"[^>]*>green · 918\/918 tests<\/text>/)
  expect(svg).not.toContain('ended without its report line')

  // An agent the loop sent with no slice announced, named for one, is that slice.
  await $.tool.call(marker('orch.implement'))
  await $.agent.spawn(spawnOf('implementer', 'Implement slice 2 of h1'))
  await $.tool.call(marker('orch.implement'))
  await $.agent.spawn(spawnOf('implementer', 'Fix the review findings'))
  const later = await paneSvgOf($)
  expect(later).toContain('>Slice 2</text>')
  expect(later).toContain('>Fix pass</text>')
})

test('a fix pass goes on to the reviewer gate, the phone check or the Evaluator by arcs of its own, never an unexpected jump', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task x1', 'orch.startup', 'orch.plan', 'orch.plan-gate',
    'orch.implement --slice 1/1', 'orch.simplify', 'orch.reviewers', 'orch.implement', 'orch.device'])
  const once = await paneSvgOf($, { scroll: { offset: 0, bodyRows: 80 } })
  expect(once).not.toContain('unexpected jump')
  expect(once).toContain('<g class="edge taken"><title>Implement → Phone check: fix pass · screen changed · taken 1×</title>')
  expect(once).toContain('>Reviewer gate → Implement · [BLOCKING] fix</text>')
  expect(once).toContain('>Implement → Phone check · fix pass · screen changed</text>')
  // Each fix-pass arc carries its own label on the map.
  expect(once).toMatch(/<text class="el taken"[^>]*>fix pass · screen changed<\/text>/)

  for (const s of ['orch.evaluate', 'orch.implement', 'orch.evaluate', 'orch.implement', 'orch.reviewers']) await $.tool.call(marker(s))
  const later = await paneSvgOf($)
  expect(later).not.toContain('unexpected jump')
  expect(later).toContain('<title>Implement → Evaluate: fix pass · no screen change · taken 1×</title>')
  expect(later).toContain('<title>Implement → Reviewer gate: fix pass · gate run again · taken 1×</title>')
})

const rawSvgOf = async (m: { find: (q: { type: 'Svg' }) => Promise<{ props: Record<string, unknown> } | undefined> }) =>
  String((await m.find({ type: 'Svg' }))?.props.source)

test('the pane moves once, just after the loop reaches a step, then holds still', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task m1'))
  await $.tool.call(marker('orch.startup'))
  await clock.advance(5_000)
  await $.tool.call(marker('orch.plan'))

  // Right after the arrival: the arrow taken draws in, the box traces and
  // fills, the path's dot comes in, the step's name fades in.
  const m = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const arriving = await rawSvgOf(m)
  expect(arriving).toMatch(/<g class="edge taken"><title>Startup → Plan[^<]*<\/title><path class="line" style="--len:\d+;stroke-dasharray:\d+ \d+;animation:mvDraw 0.3s ease-out 0s both"/)
  expect(arriving).toMatch(/<g class="node active k-agent"><rect class="box" style="--len:\d+;stroke-dasharray:\d+ \d+;animation:mvDraw 0.45s ease-out 0.3s both,mvFill 0.3s ease-out 0.7s both"/)
  expect(arriving).toContain('<g class="mvp" style="animation:mvPop 0.3s ease-out 0.55s both">')
  expect(arriving).toContain('<line class="rail taken mvg" style="animation:mvGrow 0.35s ease-out 0s both"')
  expect(arriving).toContain('<g style="animation:mvFade 0.3s ease-out 0.2s both"><text class="nt"')
  expect(arriving).toContain('@media (prefers-reduced-motion:reduce){*{animation:none!important}}')
  // Only the step reached moves: nothing else on the map does.
  expect([...arriving.matchAll(/<path class="line" style=/g)]).toHaveLength(1)
  expect(arriving).not.toContain('infinite')
  await m.unmount()

  // Drawn again mid-way (another change), it carries on where it was.
  await clock.advance(700)
  const drawn = async () => {
    const one = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const source = await rawSvgOf(one)
    await one.unmount()

    return source
  }
  const midway = await drawn()
  expect(midway).toContain('animation:mvDraw 0.3s ease-out -0.7s both')
  expect(midway).toContain('animation:mvPop 0.3s ease-out -0.15s both')

  // Past the window it holds still, and a later redraw plays nothing again.
  await clock.advance(900)
  const after = await drawn()
  expect(after).not.toContain('animation')
  expect(after).not.toContain('@keyframes')
  // The loop announcing the same step again is no arrival.
  await $.tool.call(marker('orch.plan'))
  expect(await drawn()).not.toContain('animation')
})

test('times and tokens count live over the image, which stays exactly the same', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task c1'))
  await clock.advance(30_000)
  await $.tool.call(marker('orch.plan'))
  await $.agent.spawn(spawnOf('planner', 'Plan c1'))
  usage = prompt(120_000)
  await step($.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' }))
  await clock.advance(2_000)

  const m = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await rawSvgOf(m)
  const texts = async () => Object.fromEntries((await m.findAll({ type: 'Box' }))
    .filter(b => b.props.position === 'absolute' && String(b.key ?? '').startsWith('live-'))
    .map(b => [String(b.key).slice(5), { text: b.text, top: b.props.top as number }]))
  const first = await texts()
  expect(first.run?.text).toBe('run 0:32')
  expect(first.step?.text).toBe('0:02 · 16.0k')
  expect(first['step-orch.plan']?.text).toBe('0:02 · 16.0k')
  expect(first.a1?.text).toBe('0:02 · 16.0k spent · 12% of 1M')
  // The drawing leaves those numbers out, and each sits on the row its line does.
  expect(svg).not.toContain('working now')
  expect(svg).toContain('>Plan c1 · sonnet-5-5 · working</text>')
  const baseline = (re: RegExp) => Number(svg.match(re)?.[1])
  expect(Math.abs(baseline(/<text class="nt" x="40" y="([\d.]+)">Plan</) - ((first.step?.top ?? 0) * ROW_PX + 14))).toBeLessThan(1)
  expect(Math.abs(baseline(/<text class="k run" x="40" y="([\d.]+)">/) - ((first.run?.top ?? 0) * ROW_PX + 14))).toBeLessThan(1)
  expect(Math.abs(baseline(/<text class="sl active" x="28" y="([\d.]+)">Plan</) - ((first['step-orch.plan']?.top ?? 0) * ROW_PX + 14))).toBeLessThan(1)

  // A second later the pane's own tick has moved the numbers, not the image.
  await clock.advance(1_000)
  const later = await texts()
  expect(later.run?.text).toBe('run 0:33')
  expect(later.step?.text).toBe('0:03 · 16.0k')
  expect(await rawSvgOf(m)).toBe(svg)
  await m.unmount()
})

// What a request reports for an agent on `model` answered over `tokens` of prompt.
const over = (model: string, tokens: number) => ({ ...USAGE, model, input_tokens: 1000, cache_read_input_tokens: tokens - 1500, cache_creation_input_tokens: 500 })
// The peak share drawn on a sub-step's row, read from its label on.
const peakOn = (svg: string, label: string) =>
  svg.match(new RegExp(`>${label}</text>((?!<text class="ul").)*?<text class="uo w"[^>]*>(peak [^<]*)</text>`, 's'))?.[2]

test('the reviewer gate and Evaluate list each agent they sent by name, rounds and panel members apart, each against its own model\'s window', async (engine$, on) => {
  $ = engine$
  const clock = mock.clock(on)
  engine(on)
  const models = ['claude-opus-5-5', 'claude-haiku-4-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-unknown-9']
  let spawned = 0
  on('agent.spawn', () => ({ model: models[spawned] ?? 'claude-opus-5-5', agentId: `a${++spawned}` }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(marker('orch.intake --lane standard --task r1'))
  await $.tool.call(marker('orch.reviewers'))
  await $.agent.spawn(spawnOf('security-reviewer', 'Security review r1'))
  await $.agent.spawn(spawnOf('database-reviewer', 'Database review r1'))
  usage = over('claude-opus-5-5', 400_000)
  await request('a1', 0)
  usage = over('claude-haiku-4-5', 100_000)
  await request('a2', 0)
  await $.classic.SubagentStop(stop('a1', 'security-reviewer', 'FINDINGS: CRITICAL=0 HIGH=0'))
  await $.classic.SubagentStop(stop('a2', 'database-reviewer', 'FINDINGS: CRITICAL=0 HIGH=1'))
  await clock.advance(120_000)
  await $.agent.spawn(spawnOf('security-reviewer', 'Security review r1 again'))
  await $.classic.SubagentStop(stop('a3', 'security-reviewer', 'FINDINGS: CRITICAL=0 HIGH=0'))
  await $.tool.call(marker('orch.evaluate'))
  await $.agent.spawn(spawnOf('evaluator', 'Evaluate r1'))
  await $.agent.spawn(spawnOf('evaluator', 'Evaluate r1, second member'))
  usage = over('claude-unknown-9', 300_000)
  await request('a5', 0)
  await $.classic.SubagentStop(stop('a4', 'evaluator', 'VERDICT: ACCEPT 11/12'))
  await $.classic.SubagentStop(stop('a5', 'evaluator', 'VERDICT: ACCEPT 10/12'))

  const svg = await paneSvgOf($)
  const labels = [...svg.matchAll(/<text class="ul"[^>]*>([^<]*)<\/text>/g)].map(m => m[1])
  expect(labels).toEqual(['Security review', 'Database review', 'Security review · round 2', 'Evaluator · member 1', 'Evaluator · member 2'])
  expect(peakOn(svg, 'Security review')).toBe('peak 40% of 1M')
  expect(peakOn(svg, 'Database review')).toBe('peak 50% of 200k')
  expect(peakOn(svg, 'Evaluator · member 2')).toBe('peak 300.0k · window unknown')
  usage = USAGE
})

test('a reviewer gate left without sending a reviewer says so under it, once the loop has moved on', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task n1', 'orch.reviewers'])
  expect(await paneSvgOf($)).not.toContain('No reviewer sent')

  await $.tool.call(marker('orch.evaluate'))
  expect(await paneSvgOf($)).toMatch(/<circle cx="34"[^>]*stroke-dasharray:2 1.5"\/><text class="ul"[^>]*>No agent sent<\/text>/)
})

test('a compacted reviewer is marked on its own row, not on the reviewer gate', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task m1', 'orch.reviewers'])
  await $.agent.spawn(spawnOf('test-quality-reviewer', 'Test review'))
  await $.agent.spawn(spawnOf('security-reviewer', 'Security review'))
  usage = prompt(500_000)
  await request('a1', 0)
  usage = prompt(200_000)
  await request('a1', 1)
  await $.classic.SubagentStop(stop('a1', 'test-quality-reviewer', 'FINDINGS: CRITICAL=0 HIGH=1'))

  const svg = await paneSvgOf($)
  expect(svg).toContain('>Test quality review was compacted</text>')
  expect(svg).toMatch(/>Test quality review<\/text><circle cx="\d+" cy="[\d.]+" r="6" style="fill:var\(--bad\)/)
  expect(svg).toMatch(/<text class="uo"[^>]*>0 critical · 1 high · compacted 1×<\/text>/)
  expect(svg).not.toMatch(/>Reviewer gate<\/text><circle/)
  usage = USAGE
})

test('a command past three seconds shows under the agent or step running it with a live clock; a short one draws nothing', async (engine$, on) => {
  $ = engine$
  const clock = mock.clock(on)
  let during: (() => Promise<void>) | undefined
  engine(on, async () => { await during?.() })
  await agentRun($, on, ['orch.intake --lane standard --task k1', 'orch.reviewers'])
  await $.agent.spawn(spawnOf('database-reviewer', 'Database review'))
  // Past the arrival's one-shot motion: the drawing holds still from here.
  await clock.advance(2000)
  const before = await paneSvgOf($)

  let seen = ''
  during = async () => {
    await clock.advance(2000)
    seen = await paneSvgOf($)
  }
  await $.tool.call({ tool: 'Bash', command: 'grep -n x y', description: 'Find x', agentId: 'a1' } as never)
  expect(seen).toBe(before)
  expect(await paneSvgOf($)).toBe(before)

  let live: string[] = []
  during = async () => {
    await clock.advance(5000)
    seen = await paneSvgOf($)
    live = await liveOf($)
  }
  await $.tool.call({ tool: 'Bash', command: 'dart test test/db', description: 'Runs the database tests', agentId: 'a1' } as never)
  // Its row under the reviewer's, and a line in the Now card, each with a clock.
  expect(seen).toMatch(/>Database review<\/text>.*<text class="uo" x="50" y="[\d.]+">Runs the database tests<\/text>/s)
  expect(seen).toContain('>Commands running</text>')
  expect(seen).toContain('>Database review · Runs the database tests</text>')
  expect(live.filter(t => t === '0:05')).toHaveLength(2)
  expect(await paneSvgOf($)).toBe(before)

  // One sent to the background stays, its end unseen, until its agent ends.
  during = undefined
  await $.tool.call({ tool: 'Bash', command: 'flutter test', description: 'Runs the app tests', run_in_background: true, agentId: 'a1' } as never)
  await clock.advance(4000)
  const bg = await paneSvgOf($)
  expect(bg).toContain('>Runs the app tests</text>')
  expect(bg).toContain('>in background · end not visible</text>')
  await $.classic.SubagentStop(stop('a1', 'database-reviewer', 'FINDINGS: CRITICAL=0 HIGH=0'))
  expect(await paneSvgOf($)).not.toContain('Runs the app tests')

  // The session's own command shows under its step.
  during = async () => {
    await clock.advance(4000)
    seen = await paneSvgOf($)
  }
  await $.tool.call({ tool: 'Bash', command: 'node tools/loop-step.mjs orch.evaluate && ./gates.sh', description: 'Runs every fast gate' } as never)
  expect(seen).toMatch(/>Evaluate<\/text>.*<text class="uo" x="50" y="[\d.]+">Runs every fast gate<\/text>/s)
  expect(seen).toContain('>This session · Runs every fast gate</text>')
})

test('the Now card keeps room for two commands whether none, two or three run: nothing below it moves', async (engine$, on) => {
  $ = engine$
  const clock = mock.clock(on)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  engine(on, async e => { if (e.tool === 'Bash' && !String(e.command).includes('loop-step')) await held })
  await agentRun($, on, ['orch.intake --lane standard --task r1', 'orch.reviewers'])
  await $.agent.spawn(spawnOf('database-reviewer', 'Database review'))
  await $.agent.spawn(spawnOf('test-quality-reviewer', 'Test review'))
  await clock.advance(2000)
  const cardOf = (svg: string) => svg.match(/<rect class="card" x="0.5" y="[\d.]+" width="100%" height="([\d.]+)"/)?.[1]
  const pathTop = (svg: string) => svg.match(/<text class="h2" x="0" y="([\d.]+)">Path<\/text>/)?.[1]
  const idle = await paneSvgOf($)
  expect(idle).toContain('>None running over 3 seconds</text>')

  const calls = [
    $.tool.call({ tool: 'Bash', command: 'dart test a', description: 'Runs the database tests', agentId: 'a1' } as never),
    $.tool.call({ tool: 'Bash', command: 'dart test b', description: 'Runs the test checks', agentId: 'a2' } as never),
  ]
  await clock.advance(4000)
  const two = await paneSvgOf($)
  expect(two).toContain('>Database review · Runs the database tests</text>')
  expect(two).toContain('>Test quality review · Runs the test checks</text>')
  expect(two).not.toContain('more, under their steps')
  calls.push($.tool.call({ tool: 'Bash', command: 'dart analyze', description: 'Runs the analyzer' } as never))
  await clock.advance(4000)
  const three = await paneSvgOf($)
  expect(three).toContain('>+2 more, under their steps on the path</text>')
  expect(three).not.toContain('>None running over 3 seconds</text>')

  for (const svg of [two, three]) {
    expect(cardOf(svg)).toBe(cardOf(idle))
    expect(pathTop(svg)).toBe(pathTop(idle))
  }
  release()
  await Promise.all(calls)
})

test('a step with one agent keeps that agent\'s mark on its own row, and the largest share of context it used', async (engine$, on) => {
  $ = engine$
  mock.clock(on)
  engine(on)
  await agentRun($, on, ['orch.intake --lane standard --task o1', 'orch.simplify'])
  await $.agent.spawn(spawnOf('simplify-cleaner', 'Simplify o1'))
  usage = prompt(250_000)
  await request('a1', 0)
  await $.classic.SubagentStop(stop('a1', 'simplify-cleaner', 'Cleaned up.'))
  await $.tool.call(marker('orch.reviewers'))

  const svg = await paneSvgOf($)
  expect(svg).toContain('>Simplify o1 ended without its report line</text>')
  expect(svg).toMatch(/>Simplify<\/text><circle/)
  expect(svg).not.toMatch(/<text class="ul"[^>]*>Simplify/)
  expect(svg).toMatch(/<text class="uo w"[^>]*>peak 25% of 1M<\/text>/)
  usage = USAGE
})
