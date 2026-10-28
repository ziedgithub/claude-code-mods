#!/usr/bin/env node
// Marks the start of one step of this project's loop, for the loop-graph pane.
// The loop's instructions run it at every step, so where a run stands is said
// by the loop itself, never guessed from the commands it happens to run.
//
//   node .claude/loop-graph/loop-step.mjs <step> [--task <id or slug>] [--lane <lane>] [--slice <K>/<N>] [--note "<text>"]
//
// <step> is a step id from map.json beside this file. A step stays current
// until the next marker; after an interruption, the current step's marker
// again says the loop is back on it. An unknown step or lane exits 1: a typo
// fails loudly. Prints the step and the UTC time.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAP = join(dirname(fileURLToPath(import.meta.url)), 'map.json');
const KEYS = ['task', 'lane', 'slice', 'note'];

export function parse(argv, map) {
  const [step, ...rest] = argv;
  const steps = map.steps.map(s => s.id);
  if (!steps.includes(step)) throw new Error(`unknown loop step "${step ?? ''}"; known: ${steps.join(', ')}`);
  const event = { step };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    const value = rest[i + 1];
    if (!KEYS.includes(key) || value === undefined) {
      throw new Error(`unexpected argument "${rest[i]}"; use ${KEYS.map(k => `--${k}`).join(', ')}, each with a value`);
    }
    event[key] = value;
  }
  const lanes = (map.lanes ?? []).map(l => l.id);
  if (event.lane !== undefined && !lanes.includes(event.lane)) {
    throw new Error(lanes.length === 0 ? 'this loop has no lanes: drop --lane' : `--lane is ${lanes.join(' or ')}, not "${event.lane}"`);
  }
  const [at, of] = (event.slice ?? '1/1').split('/').map(Number);
  if (event.slice !== undefined && !(/^\d+\/\d+$/.test(event.slice) && at >= 1 && of >= at)) {
    throw new Error(`--slice is <K>/<N> with 1 ≤ K ≤ N, not "${event.slice}"`);
  }

  return event;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const event = { at: new Date().toISOString(), ...parse(process.argv.slice(2), JSON.parse(readFileSync(MAP, 'utf8'))) };
    console.log(`loop step: ${event.step} at ${event.at}`);
  } catch (error) {
    console.error(`loop-step: ${error.message}`);
    process.exit(1);
  }
}
