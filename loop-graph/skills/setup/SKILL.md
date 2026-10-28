---
name: setup
description: Maps a project's agent loop for the loop-graph pane, so each run of the loop shows live beside the chat (the step at work, the arcs taken, each agent sent, its time and context). Use when the user wants to "set up loop-graph", "graph my loop", see their workflow, skill or agent pipeline live in a pane, or update the map after their loop changed. Reads the loop's instructions, writes .claude/loop-graph/map.json and the step marker, and adds one marker line at the start of each step.
---

# Map a project's loop for the loop-graph pane

The loop-graph pane draws a project's loop from two things you set up here:

1. **The map**, `.claude/loop-graph/map.json`: the loop's steps, the arcs between them, its lanes, and how its agents and test runs report. The pane lays it out on its own.
2. **The markers**: at the start of each step, the loop's instructions run `node .claude/loop-graph/loop-step.mjs <step id>`. Only markers move the pane: where a run stands is said by the loop itself, never guessed.

The files beside this SKILL.md: `map-format.md` (every field of the map, rules for common test runners: read it before writing the map), `loop-step.mjs` (the marker, copied into the project as is), `check-map.mjs` (checks a map and the markers), and `examples/` (two complete maps).

## 1. Find the loop

A loop is a multi-step workflow that Claude runs in this project, usually a skill or a slash command that walks phases, sends subagents and may loop back (plan, implement, test, review, fix). Look in:

- `.claude/skills/*/SKILL.md`, `.claude/commands/*.md`, `.agents/skills/`, and `.claude/agents/*.md` for the agents it sends;
- `AGENTS.md`, `CLAUDE.md` and the docs they point to;
- a loop split across several skills (a triage skill that hands over to a light and a full one) is one loop with lanes.

If `.claude/loop-graph/map.json` already exists, this is an update: read it, and in step 2 change only what the instructions changed, keeping step ids that still apply (old runs and markers use them).

If you find several candidate loops, or none, ask the user which workflow to map with `AskUserQuestion`. A project can have one map.

## 2. Read the whole loop and draft the map

Read every file of the loop end to end, including the agent definitions it sends. Then draft, following `map-format.md`:

- **Steps**: one per phase the instructions name, in the order a run meets them, 4 to 25 in all. A step is something the session starts and moves on from, not every tool call. Give each a short id, a label of 16 characters at most, its kind, and a `what` and `short` in plain words taken from the instructions.
- **Ids**: short, lowercase, unique; prefix them by lane when lanes repeat names (`f.test`, `c.test`). Keep the ids of an existing map.
- **Kinds**: `agent` when the step sends subagents, `human` when it waits for the person's approval, `switch` for the step that picks between lanes, `end` for the last step. Lanes that finish the same way can share one `end` step with no `lanes`. Set `multi: true` on a step that sends several agents at once (a review panel); a step that sends one agent per slice needs no `multi`, its slices are listed anyway.
- **Lanes**: only when the loop routes runs down separate paths (light versus full). One column per lane (`col`), the switch above them (`span: true`), each step's `lanes`, and `lane` on each arc out of the switch (the map dims the arcs of the lanes a run did not take).
- **Arcs**: every move the instructions describe, with the condition as label in the loop's own words: the straight path, each loop-back (`tests red`, `REVISE`, `feedback`), each skip, each exit to an end, and the switch into each lane. A move left out shows as a red unexpected jump.
- **Rules**: if agents end their report on a fixed line (`VERDICT: ACCEPT`, `FINDINGS: CRITICAL=0`), write an `outcomes` rule for each, and list in `reporters` the agents whose final message always ends on such a line. If the loop runs the project's tests or checks itself, find the commands (package.json scripts, Makefile, CI config) and add the `runners` rules for them from `map-format.md`; for a check the table lacks, write a rule on the same pattern, failure first. If an agent interviews the person before it works, add it to `asksBack`; it can also be a reporter, since its interview stops are not checked.
- **Caps**: where the instructions cap rounds ("at most two review rounds, then ask the user"), set `maxVisits`; the cap needs no arc or step of its own.

## 3. Show the draft, then write

Before writing anything, show the user the draft in a compact table: each step with its kind and lane, and the arcs leaving it with their labels. Say which instruction files you will add markers to. Ask once whether to go ahead with `AskUserQuestion` (go ahead, or change something); this edits their loop's instructions.

On the go-ahead:

1. Write `.claude/loop-graph/map.json`.
2. Copy `loop-step.mjs` from beside this file to `.claude/loop-graph/loop-step.mjs`, unchanged.
3. Check it (after writing, not on the draft): `node <this skill's folder>/check-map.mjs .claude/loop-graph/map.json`. Fix every `✗` error. Fix each `!` warning too, unless it is intended (say which).

## 4. Add the markers

At the very start of each step's section in the loop's instructions, add one line that makes the session announce the step. Match the instructions' own style; for example, as the first item of the step:

```
Announce the step: `node .claude/loop-graph/loop-step.mjs review`
```

Rules:

- Every step id in the map gets a marker at the start of its section. One is enough when every way into the step leads to that section ("go back to F1"); a step the instructions start from elsewhere, without sending the session to its section, gets a marker there too.
- The session runs markers itself, as a command of its own. Never put a marker in a prompt sent to a subagent or in an agent's definition: a marker run by a subagent moves nothing.
- The step that opens a run carries `--task <the task, card id or slug>`; say in the instructions where the value comes from.
- The lane: the switch announces itself before it has decided, so give `--lane <id>` to the first step of each lane (`node .claude/loop-graph/loop-step.mjs c.plan --lane careful`). A step whose `lanes` lists one lane alone picks that lane by itself, also when a run moves to it from another lane; `--lane` is needed only on a first step shared by several lanes (`--lane standard` or `--lane complete`, as the instructions decide it).
- A step that sends one agent per slice of a plan carries `--slice <K>/<N>` before each slice's agent; a fix pass announces the step without `--slice`.
- After an interruption, the instructions should re-run the current step's marker to say the loop is back on it; this never starts a new run. Add that sentence once, near the top of the loop's main file. When a sentence names the marker in general, write the step as `<step>`: the checker reads any other word after `loop-step.mjs` as a step id.

Then check the markers against the map, naming every file you edited: `node <this skill's folder>/check-map.mjs .claude/loop-graph/map.json <file> <file> …`. It reports steps never announced and markers that name no step. Fix both.

## 5. Finish

1. Every marker is a Bash call. Offer to add `"Bash(node .claude/loop-graph/loop-step.mjs:*)"` to `permissions.allow` in the project's `.claude/settings.json` (created if missing, merged into it otherwise), so the loop does not stop on a permission prompt at every step. Add it only on the user's yes.
2. Tell the user how to see it: the loop-graph mod must be installed (see below); then `/loop-graph reload` in a running session, or start a new session in this project, and run the loop. The pane opens on the first marker of a run. `/loop-graph reset` clears a run.
3. Suggest committing `.claude/loop-graph/` with the marker edits, so everyone on the project gets the pane.

If the user does not have the mod, it installs with:

```
claude plugin marketplace add ziedgithub/claude-code-mods && claude plugin install loop-graph@zied-mods
```

then a restart of Claude Code. It needs Claude Code 2.1.296 or later.
