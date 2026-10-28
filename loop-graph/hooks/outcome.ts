import type { Outcome } from '../types'

import { LOOP } from './graph'
import type { MapRule } from './graph'

// What a step came to, read only where the loop says it: the lines the map's
// rules name, in an agent's last message or a command's output.

// The first line a rule matches, worded by the rule: $1… are its groups.
function apply(rules: MapRule[], text: string, type?: string): Outcome | undefined {
  const lines = text.split('\n')
  for (const rule of rules) {
    if (type !== undefined && rule.agents !== undefined && !rule.agents.includes(type)) continue
    const re = new RegExp(rule.match)
    // The last line that matches: a runner prints its summary at the end.
    const m = lines.map(l => l.match(re)).filter(x => x !== null).pop()
    if (m == null) continue
    const worded = rule.text.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? '').trim()

    return { text: worded, isBad: rule.bad === undefined ? undefined : new RegExp(rule.bad).test(worded) }
  }

  return undefined
}

export const agentOutcome = (type: string, message: string | undefined): Outcome | undefined =>
  message === undefined ? undefined : apply(LOOP.outcomes, message, type)

// An agent that interviews before it works: a stop whose message does not say
// it is done is a round of questions it waits to have answered.
export function isAskingBack(type: string, message: string | undefined): boolean {
  const rule = LOOP.asksBack.find(a => a.agent === type)

  return rule !== undefined && message !== undefined && !new RegExp(rule.doneWhen, 'i').test(message)
}

// The runner's summary the map's rules find in a command's output, and whether
// it says something broke.
export const runnerOutcome = (output: string): Outcome | undefined => apply(LOOP.runners, output)
