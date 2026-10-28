import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Run, Usage, View } from '../types'

import { LOOP, NODE_BY_ID, clearGraph, setGraph } from './graph'
import type { LoopMap } from './graph'
import { COL_PX, ROW_PX, paneSvg } from './pane'
import { mapSvg } from './svg'
import {
  COMMAND_SHOWN_MS, EMPTY_RUN, agentStep, commandEnded, commandStarted, handBack, isLive, mainStep, mainToolCall, mainToolResult, markSilent,
  revealCommands, startAgent, stopAgent, turnDone, turnStarted, waitFor, waitOver,
} from './tracker'
import { viewOf } from './view'

const PANE = 'loop-graph'
const run = atom({ plugin: 'loop-graph', key: 'run' } as const, EMPTY_RUN)
const view = atom({ plugin: 'loop-graph', key: 'view' } as const, {
  isLive: false, title: '', chips: [], alerts: [], steps: [], svg: mapSvg(EMPTY_RUN), recent: [], outline: [],
} as View)
// A second's tick while something counts: it redraws the live text laid over
// the image, never the image.
const tick = atom({ plugin: 'loop-graph', key: 'tick' } as const, 0)

// The project's map of its loop, which the setup skill writes.
export const MAP_FILE = '.claude/loop-graph/map.json'
// The folder the session works in, where the map is read from again on /loop-graph reload.
let cwd = ''
// The pane's size in rows and columns, kept beside the mod to check the
// image's row height against a screenshot.
let lastSize = ''
// Names a command whose call came without an id.
let commandCount = 0

const toUsage = (u: ModelUsage): Usage => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
})

// The pane reads only the view, rewritten only when it differs: a token
// count moving inside a step redraws nothing.
// Reads the map: drawn from it when it loads, the map's fault said once
// when it does not. No map leaves the pane empty with a pointer to the skill.
async function loadMap($: EngineInterface): Promise<string> {
  const text = await $.fs.read(`${cwd}/${MAP_FILE}`).catch(() => undefined)
  if (typeof text !== 'string') {
    clearGraph()

    return `No ${MAP_FILE} here: run /loop-graph:setup to map this project's loop.`
  }
  try {
    setGraph(JSON.parse(text) as LoopMap)

    return `${LOOP.name}: map loaded.`
  } catch (error) {
    clearGraph()
    const why = `${MAP_FILE} does not load: ${error instanceof Error ? error.message : String(error)}`
    void $.ui.toast(`loop-graph: ${why}`)

    return why
  }
}

async function change($: EngineInterface, fn: (r: Run) => Run): Promise<void> {
  await update($, run, fn)
  const r = await read($, run)
  const next = viewOf(r)
  if (JSON.stringify(await read($, view)) !== JSON.stringify(next)) await update($, view, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'loop-graph', description: 'Show the live graph of this project\'s loop ("reset" clears the run, "reload" rereads the map)' })
    cwd = e.cwd
    await loadMap($)
    await change($, r => r)
    // A project with a map opens the pane with the session, and again after a plugin reload.
    const isLoopRepo = LOOP.isLoaded
    $.clock.every(60_000, async () => {
      const now = await $.clock.now()
      await change($, r => markSilent(r, now))
    })
    $.clock.every(1000, async () => {
      // A command past its first seconds gets its row: the drawing changes once, for it.
      const now = await $.clock.now()
      const r = await read($, run)
      if (Object.values(r.commands ?? {}).some(c => c.isShown !== true && now - c.since >= COMMAND_SHOWN_MS)) {
        await change($, x => revealCommands(x, now))
      }
      const v = await read($, view)
      if (v.now?.clock !== undefined || v.now?.cmds !== undefined) await update($, tick, t => t + 1)
    })
    if (e.isInteractive && isLoopRepo) void $.ui.open({ id: PANE, title: 'Loop' })

    return next(e)
  })

  on('command.run', { command: 'loop-graph' }, async ($, e) => {
    const said = /reload/.test(e.args ?? '') ? await loadMap($) : undefined
    if (/reset/.test(e.args ?? '') || said !== undefined) await change($, () => EMPTY_RUN)
    await $.ui.open({ id: PANE, title: 'Loop' })

    return { text: said ?? (LOOP.isLoaded ? 'Loop graph pane opened.' : `Loop graph pane opened. No ${MAP_FILE} in this project yet: run /loop-graph:setup.`) }
  })

  // A question you are asked holds the session until you answer it; a
  // permission prompt, asked inside the call it guards, ends with that call.
  on('tool.call', async ($, e, next) => {
    const who = e.agentId
    if (who === undefined) {
      const now = await $.clock.now()
      const input = e as unknown as Record<string, unknown>
      await change($, r => mainToolCall(r, String(e.tool), input, now))
      // A marker that opens a run brings the pane up.
      const step = typeof input.command === 'string' ? input.command.match(/loop-step\.mjs\s+(\S+)/)?.[1] : undefined
      if (e.tool === 'Bash' && step !== undefined && NODE_BY_ID[step]?.isOpening === true) void $.ui.open({ id: PANE, title: 'Loop' })
      if (e.tool === 'AskUserQuestion') await change($, r => waitFor(r, undefined, { why: 'question', since: now }))
    }
    // A background agent hands its report back through this call before it stops.
    const report = (e as unknown as { message?: unknown }).message
    if (who !== undefined && String(e.tool) === 'SubagentHandback' && typeof report === 'string') await change($, r => handBack(r, who, report))
    // A shell command, named by the description it was sent with.
    const args = e as unknown as { command?: unknown; description?: unknown; run_in_background?: unknown; tool_use_id?: unknown }
    const cmdId = e.tool === 'Bash' ? (typeof args.tool_use_id === 'string' ? args.tool_use_id : `cmd-${++commandCount}`) : undefined
    if (cmdId !== undefined) {
      const text = typeof args.description === 'string' && args.description !== '' ? args.description
        : typeof args.command === 'string' ? args.command.split('\n')[0] ?? 'A command' : 'A command'
      const started = await $.clock.now()
      await change($, r => commandStarted(r, { id: cmdId, who, text, isBg: args.run_in_background === true }, started))
    }
    try {
      const res = await next(e)
      if (who === undefined && 'result' in res) await change($, r => mainToolResult(r, String(e.tool), res.result))

      return res
    } finally {
      await change($, r => {
        const freed = waitOver(cmdId === undefined ? r : commandEnded(r, cmdId), who, 'permission')

        return who === undefined && e.tool === 'AskUserQuestion' ? waitOver(freed, undefined, 'question') : freed
      })
    }
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    const now = await $.clock.now()
    await change($, r => waitFor(r, e.agent_id, { why: 'permission', since: now, tool: e.tool_name }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    if (res.agentId !== undefined) {
      const now = await $.clock.now()
      const agent = { id: res.agentId, type: e.subagentType, description: e.description, model: res.model }
      await change($, r => (isLive(r) && !r.isDone ? startAgent(r, agent, now) : r))
    }

    return res
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const now = await $.clock.now()
    await change($, r => stopAgent(r, e.agent_id, e.last_assistant_message, now))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    const usage = res.usage
    if (usage !== null) {
      const u = toUsage(usage)
      const agentId = e.agentId
      const window = (await $.session.usage().catch(() => undefined))?.context.window
      const now = await $.clock.now()
      await change($, r => (agentId === undefined ? mainStep(r, u, window, now, usage.model) : agentStep(r, agentId, u, usage.model, window, now)))
    }

    return res
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await change($, turnStarted)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await change($, r => (isLive(r) ? turnDone(r, now, e.isAborted) : { ...r, isMainBusy: false }))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, view)

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Text bold>{v.title}</Text>
          <Text dimColor>{v.chips.join(' · ')}</Text>
          {v.now !== undefined && <Text color={v.now.tone === 'plain' ? undefined : 'claude'}>{v.now.kicker}: {v.now.title}</Text>}
          {v.alerts.map(a => <Text color={a.level === 'act' ? 'error' : 'warning'}>! {a.what} · {a.where}</Text>)}
          {v.jumps !== undefined && <Text color="error">{v.jumps}</Text>}
          {(v.now?.agents ?? []).map(a => <Text dimColor>  {a.label}{a.context === undefined ? '' : ` · ${a.context}`}</Text>)}
          {v.now?.progress !== undefined && <Text dimColor>  {v.now.progress}</Text>}
          {(v.now?.cmds ?? []).map(c => <Text dimColor>  $ {c.who} · {c.text}{c.isBg ? ' · in background' : ''}</Text>)}
          {v.outline.map(o => <Text dimColor={o.isDim}>{o.mark} {o.label}</Text>)}
        </Box>
      )
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    await read($, tick)
    const now = await $.clock.now()
    const bodyRows = e.props.scroll.bodyRows
    const cols = e.props.bodyColumns
    const pane = paneSvg(v, Math.floor((cols - 2) * COL_PX) - 2, Math.floor(Math.max(240, bodyRows * ROW_PX - 16)), now)
    const size = JSON.stringify({ bodyRows, cols, colPx: COL_PX, rowPx: ROW_PX, image: [pane.width, pane.height] })
    if (size !== lastSize) {
      lastSize = size
      void $.fs.write(`${$.plugin.root}/.pane-size.json`, size).catch(() => undefined)
    }
    // The image is the pane; what counts (times, tokens, context) is live text
    // laid over it, so a moving number never reloads the image.
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box key="pane">
          <Svg
            source={pane.svg}
            width={pane.width}
            height={pane.height}
            alt="The project's loop: the step at work, the path this run takes with its arcs, and the map of every step"
          />
          {pane.live.map(l => (
            <Box key={`live-${l.id}`} position="absolute" top={l.top} right={l.right ?? 2} height={1}>
              <Text
                size="footnote"
                tabular
                dimColor={l.level === undefined && l.isAccent !== true}
                color={l.level === 'act' ? 'error' : l.level === 'watch' ? 'warning' : l.isAccent === true ? 'claude' : undefined}
              >
                {l.text}
              </Text>
            </Box>
          ))}
          <Box position="absolute" top={0} right={0}>
            <Button key="reset" label="Reset" onPress={() => change($, () => EMPTY_RUN)} />
          </Box>
        </Box>
      </Box>
    )
  })
}
