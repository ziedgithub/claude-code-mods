#!/usr/bin/env node
// Checks a loop-graph map before the pane reads it, and, given the loop's
// instruction files, that every step is announced and every marker names a step.
//
//   node check-map.mjs <map.json> [instruction file …]
//
// Exits 1 on an error the pane would refuse; warnings are printed and pass.

import { readFileSync } from 'node:fs';

const KINDS = ['switch', 'self', 'agent', 'human', 'end'];
const [mapPath, ...files] = process.argv.slice(2);
if (mapPath === undefined) {
  console.error('usage: node check-map.mjs <map.json> [instruction file …]');
  process.exit(2);
}

const errors = [];
const warnings = [];
let map;
try {
  map = JSON.parse(readFileSync(mapPath, 'utf8'));
} catch (error) {
  console.error(`✗ ${mapPath} does not parse: ${error.message}`);
  process.exit(1);
}

const steps = Array.isArray(map.steps) ? map.steps : [];
const arcs = Array.isArray(map.arcs) ? map.arcs : [];
const lanes = new Set((map.lanes ?? []).map(l => l.id));
const ids = new Set();
if (steps.length === 0) errors.push('the map has no "steps"');
for (const s of steps) {
  if (typeof s.id !== 'string' || s.id === '') errors.push('a step has no "id"');
  else if (ids.has(s.id)) errors.push(`step "${s.id}" is listed twice`);
  else ids.add(s.id);
  if (typeof s.label !== 'string') errors.push(`step "${s.id}" has no "label"`);
  if (s.kind !== undefined && !KINDS.includes(s.kind)) errors.push(`step "${s.id}": kind is one of ${KINDS.join(', ')}`);
  for (const l of s.lanes ?? []) if (!lanes.has(l)) errors.push(`step "${s.id}" names lane "${l}", which "lanes" does not list`);
  if ((s.label ?? '').length > 16) warnings.push(`step "${s.id}": label "${s.label}" is over 16 characters and will be cut in its box`);
  if (s.what === undefined && s.short === undefined) warnings.push(`step "${s.id}" has no "what": its card will be blank`);
}
for (const a of arcs) {
  if (!ids.has(a.from)) errors.push(`an arc leaves "${a.from}", which is no step`);
  if (!ids.has(a.to)) errors.push(`an arc goes to "${a.to}", which is no step`);
  if (a.lane !== undefined && !lanes.has(a.lane)) errors.push(`arc ${a.from} → ${a.to} names lane "${a.lane}", which "lanes" does not list`);
}
for (const r of [...(map.outcomes ?? []), ...(map.runners ?? [])]) {
  for (const re of [r.match, r.bad]) {
    if (re === undefined) continue;
    try {
      new RegExp(re);
    } catch {
      errors.push(`"${re}" is not a regular expression`);
    }
  }
  if (typeof r.text !== 'string') errors.push(`rule "${r.match}" has no "text"`);
}

// The shape of the loop: where runs open and end, and steps no arc reaches.
const into = new Set(arcs.filter(a => a.from !== a.to).map(a => a.to));
const outOf = new Set(arcs.filter(a => a.from !== a.to).map(a => a.from));
const bare = steps.filter(s => s.opens ?? !into.has(s.id));
// No step marked and every one led into: the first step listed opens runs.
const opening = bare.length > 0 || steps.some(s => s.opens === true) ? bare : steps.slice(0, 1);
if (steps.length > 0 && opening.length === 0) warnings.push('no step opens a run: mark the first one "opens": true');
if (!steps.some(s => s.kind === 'end')) warnings.push('no step has kind "end": a run never shows as finished');
for (const s of steps) {
  if (s.kind !== 'end' && !outOf.has(s.id)) warnings.push(`step "${s.id}" leads nowhere: add its arcs, or make it kind "end"`);
}
const seen = new Set(opening.map(s => s.id));
for (let grew = true; grew;) {
  grew = false;
  for (const a of arcs) if (seen.has(a.from) && !seen.has(a.to)) seen.add(a.to), (grew = true);
}
for (const s of steps) if (!seen.has(s.id)) warnings.push(`step "${s.id}" cannot be reached from a step that opens a run`);

// The markers in the loop's own instructions.
if (files.length > 0) {
  const announced = new Set();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/loop-step\.mjs\s+([^\s`'"]+)/g)) {
      const step = m[1];
      // A placeholder (`<step>`, `…`) names no step.
      if (!/^[A-Za-z0-9][\w.-]*$/.test(step)) continue;
      if (!ids.has(step)) errors.push(`${f} announces "${step}", which is no step of the map`);
      announced.add(step);
    }
  }
  for (const id of ids) if (!announced.has(id)) warnings.push(`step "${id}" is never announced in the files given: the pane will skip it`);
}

for (const w of warnings) console.log(`! ${w}`);
for (const e of errors) console.log(`✗ ${e}`);
console.log(errors.length === 0
  ? `✓ ${steps.length} steps, ${arcs.length} arcs${lanes.size > 0 ? `, ${lanes.size} lanes` : ''}: the pane can read this map${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`
  : `✗ ${errors.length} error${errors.length > 1 ? 's' : ''}: the pane will refuse this map`);
process.exit(errors.length === 0 ? 0 : 1);
