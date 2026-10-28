# The loop map: `.claude/loop-graph/map.json`

The loop-graph pane reads this file when a session starts, and again on `/loop-graph reload`. It draws every step as a box and every arc as an arrow, and lays them out on its own: you never give coordinates.

A complete map of a real loop with three lanes is in `examples/dev-loop.json`. A small single-lane loop is in `examples/feature-loop.json`.

## Top level

| Field | Required | What it is |
| --- | --- | --- |
| `name` | no | The loop's name. A loop with no lanes shows it as its chip. |
| `lanes` | no | `[{ "id": "express", "label": "Express lane" }]`. The separate paths a run can take, when the loop routes between them. Leave it out for a loop with one path. |
| `steps` | yes | The steps, in the order a run meets them. The order sets the rows and the path list. |
| `arcs` | yes | The moves between steps. |
| `outcomes` | no | Rules that read what an agent's last message came to. |
| `runners` | no | Rules that read what a command run by the session itself came to (a test run). |
| `asksBack` | no | `[{ "agent": "planner", "doneWhen": "Plan ready" }]`. Agents that stop to ask questions before they finish: a stop whose message does not match `doneWhen` (a regex, case-insensitive) shows the step waiting for answers. |
| `reporters` | no | Agent types that must end on a contract line. One that ends without a line any `outcomes` rule matches, nor a `WORD:` line, is flagged. |

## A step

| Field | Required | What it is |
| --- | --- | --- |
| `id` | yes | What the marker names: `node .claude/loop-graph/loop-step.mjs <id>`. Lowercase, dots or dashes, no spaces. |
| `label` | yes | The box's name. 16 characters at most. |
| `role` | no | Who does it, in a few words: `planner`, `you approve`, `npm test`. |
| `kind` | no | `self` (the session works, the default), `agent` (it sends one or more subagents), `human` (it waits on the person: an approval gate), `switch` (it picks the lane), `end` (the run is over when the session's turn ends here). |
| `what` | no | One sentence: what the step does. Shown on its card. |
| `short` | no | A few words, shown under the name while the step works. |
| `lanes` | no | The lane ids that walk this step. Leave out for every lane. A step on exactly one lane picks that lane when announced, and moves a run on another lane to it. |
| `col` | no | The column, from 0 at the left. Give each lane its own column; leave out for a single-column loop. |
| `row` | no | The row in its column. Leave out: each step goes under the one before it in that column. |
| `span` | no | `true` puts the step above the columns, centred: for the step that picks a lane. |
| `opens` | no | `true` when announcing this step starts a new run. By default, the steps no arc leads into, else the first step. A step reached by an arc from the current step never starts a new run, nor does the current step announced again, unless its `--task` names another task. |
| `multi` | no | `true` when the step may send several agents at once (reviewers, a panel): each is listed under the step. |
| `maxVisits` | no | The cap on rounds the loop sets (`at most two review rounds` → `2`). Past it, the step is flagged. |

## An arc

`{ "from": "review", "to": "build", "label": "VERDICT: FIX", "lane": "standard" }`

- `label`: the condition that takes this arc, in the loop's own words, short (`tests red`, `approved`, `REVISE`). Arcs straight down to the next step in the same column show their label only in the path list, not on the map.
- `lane`: the lane this arc belongs to, on the arcs out of the switch: the map dims the arcs of a lane the run did not take. When the same move exists once per lane (the switch into a step two lanes share), write it once per lane; arcs that share a from and a to share one label on the map.
- A step may arc to itself (`next slice`).
- A move the loop makes that has no arc shows as a red unexpected jump: add every arc the instructions describe, loop-backs included.

## Rules (`outcomes` and `runners`)

`{ "match": "^VERDICT: (\\w+).*?SCORE: (\\d+/\\d+)", "text": "$1 · $2", "bad": "^BLOCK", "agents": ["evaluator"] }`

- `match`: a JavaScript regular expression, tested on each line. JSON needs every backslash doubled.
- `text`: what the step came to; `$1`, `$2`… are the match's groups.
- `bad`: a regular expression tested on the worded `text`. When it matches, the step is flagged to act on.
- `agents` (outcomes only): the agent types the rule applies to; leave out for all.
- The first rule that matches wins: put the specific rule before the general one, and failure rules before success rules.

For a slice-by-slice step (`--slice K/N` in its markers), an agent whose outcome is not `bad` counts its slice green.

### Runner rules for common test runners

| Runner | Rules (in this order) |
| --- | --- |
| Jest | `{ "match": "Tests:\\s+(\\d+) failed", "text": "$1 tests failed", "bad": "." }`, `{ "match": "Tests:\\s+(\\d+) passed", "text": "$1 tests passed" }` |
| Vitest | `{ "match": "Tests\\s+(\\d+) failed", "text": "$1 tests failed", "bad": "." }`, `{ "match": "Tests\\s+(\\d+) passed", "text": "$1 tests passed" }` |
| pytest | `{ "match": "=+ .*?(\\d+) failed", "text": "$1 tests failed", "bad": "." }`, `{ "match": "=+ (\\d+) passed", "text": "$1 tests passed" }` |
| Go | `{ "match": "^FAIL\\b", "text": "tests failed", "bad": "." }`, `{ "match": "^ok\\s", "text": "tests passed" }` |
| Dart / Flutter | `{ "match": "\\+(\\d+)(?: ~\\d+)? -(\\d+): Some tests failed", "text": "$2 tests failed", "bad": "." }`, `{ "match": "\\+(\\d+)(?: ~\\d+)?: All tests passed!", "text": "$1 tests passed" }` |
| ESLint (a check, not tests) | `{ "match": "✖ (\\d+) problems?", "text": "$1 lint problems", "bad": "." }` |
| cargo | `{ "match": "test result: FAILED\\. (\\d+) passed; (\\d+) failed", "text": "$2 tests failed", "bad": "." }`, `{ "match": "test result: ok\\. (\\d+) passed", "text": "$1 tests passed" }` |

## The marker

```
node .claude/loop-graph/loop-step.mjs <step> [--task <id or slug>] [--lane <lane>] [--slice <K>/<N>] [--note "<text>"]
```

- `--task`: on the step that opens a run; the pane's title.
- `--lane`: on the step where the loop has picked its lane.
- `--slice K/N`: on a step that sends one agent per slice of a plan, before each slice's agent. Announcing the same step again without `--slice` is a fix pass.
- `--note`: a short note shown on the step's card.

Only the session itself moves the pane: a marker run inside a subagent moves nothing. A marker counts only as a command of its own (alone, or chained with `&&` or `;`); one quoted inside a commit message or a heredoc moves nothing.
