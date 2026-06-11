// Unit tests for the pure helpers in v2-wave.js (Lane A-code A4/A7).
// Run: node .claude/workflows/v2-wave.test.mjs   (or: node --test .claude/workflows)
//
// v2-wave.js is a workflow-host script (top-level `await agent(...)` / top-level `return`),
// so it is NOT importable as a standard ES module — `import` throws "Illegal return statement".
// The helpers are still marked `export` (host tolerates exports, per the existing meta export);
// here we extract the sentinel-delimited pure-helper block from the source and evaluate it.
// The block is host-free by contract (no agent/phase/log/args), asserted below.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const SRC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'v2-wave.js')
const src = readFileSync(SRC_PATH, 'utf8')

const START = '// ---- pure helpers'
const END = '// ---- end pure helpers ----'
const i = src.indexOf(START), j = src.indexOf(END)
assert.ok(i >= 0 && j > i, 'pure-helper sentinel block missing from v2-wave.js')
const block = src.slice(i, j).replaceAll('export function', 'function')

test('pure-helper block is host-free (no agent/phase/log/parallel/pipeline/args)', () => {
  assert.ok(!/\b(agent|phase|parallel|pipeline|log|args)\s*\(/.test(block), 'helper block must not call workflow-host primitives')
  assert.ok(!/\bargs\b/.test(block), 'helper block must not reference the host args global')
})

const { checkVerdict, shouldRedTeam } = new Function(`${block}; return { checkVerdict, shouldRedTeam }`)()

const allTrue = { complete: true, tested: true, designSystem: true, functional: true, purpose: true, honest: true }
const evidenceVerdict = 'Ran npm test (14 files green), npm run lint clean, svelte-check 0 errors; drove the live app in the browser and verified the flow. Recommendation: ship.'

// ---- checkVerdict matrix ----

test('checkVerdict: pass-valid — passed=true, all criteria true, evidenced verdict → no defects', () => {
  const r = { feature: 'x', passed: true, criteria: { ...allTrue }, gaps: [], verdict: evidenceVerdict }
  assert.deepEqual(checkVerdict(r), [])
})

test('checkVerdict: valid FAIL — passed=false with named gaps → no defects (gate must not block honest failures)', () => {
  const r = { feature: 'x', passed: false, criteria: { ...allTrue, tested: false }, gaps: ['src/lib/foo.ts:12 — stub handler, no error path'], verdict: 'FAIL' }
  assert.deepEqual(checkVerdict(r), [])
})

test('checkVerdict: fail-no-gaps — passed=false with empty gaps → defect', () => {
  const r = { feature: 'x', passed: false, criteria: { ...allTrue, tested: false }, gaps: [], verdict: 'FAIL: not done' }
  const d = checkVerdict(r)
  assert.equal(d.length, 1)
  assert.match(d[0], /passed=false requires at least one named gap/)
})

test('checkVerdict: criteria-false-but-passed — any false criterion with passed=true → defect', () => {
  const r = { feature: 'x', passed: true, criteria: { ...allTrue, tested: false }, gaps: [], verdict: evidenceVerdict }
  const d = checkVerdict(r)
  assert.equal(d.length, 1)
  assert.match(d[0], /criteria flag is false.*requires passed=false/)
})

test('checkVerdict: evidence-missing — trivially short verdict → defect', () => {
  const r = { feature: 'x', passed: true, criteria: { ...allTrue }, gaps: [], verdict: 'LGTM' }
  const d = checkVerdict(r)
  assert.equal(d.length, 1)
  assert.match(d[0], /lacks evidence of independent verification/)
})

test('checkVerdict: evidence-missing — long verdict without any verification keyword → defect', () => {
  const r = { feature: 'x', passed: true, criteria: { ...allTrue }, gaps: [], verdict: 'This change looks good to me and I am confident in its quality and shape overall, well done.' }
  const d = checkVerdict(r)
  assert.equal(d.length, 1)
  assert.match(d[0], /lacks evidence of independent verification/)
})

test('checkVerdict: evidence-missing — keyword present but trivial length → defect', () => {
  const r = { feature: 'x', passed: true, criteria: { ...allTrue }, gaps: [], verdict: 'tests pass' }
  const d = checkVerdict(r)
  assert.equal(d.length, 1)
  assert.match(d[0], /lacks evidence of independent verification/)
})

test('checkVerdict: gap-empty-string — empty/whitespace/non-string gap entries → one defect per bad entry', () => {
  const r = { feature: 'x', passed: false, criteria: { ...allTrue, honest: false }, gaps: ['', '  ', 42, 'src/lib/foo.ts:12 — real gap'], verdict: 'FAIL' }
  const d = checkVerdict(r)
  assert.equal(d.length, 3)
  assert.match(d[0], /gaps\[0\] is not a non-empty string/)
  assert.match(d[1], /gaps\[1\] is not a non-empty string/)
  assert.match(d[2], /gaps\[2\] is not a non-empty string/)
})

test('checkVerdict: non-object inputs → single "not an object" defect', () => {
  for (const bad of [null, undefined, 'passed', 7, [1, 2]]) {
    assert.deepEqual(checkVerdict(bad), ['verdict is not an object'])
  }
})

test('checkVerdict: passed=false needs gaps but NOT verification-evidence wording', () => {
  const r = { feature: 'x', passed: false, criteria: { ...allTrue, functional: false }, gaps: ['dead button on /agents'], verdict: 'no' }
  assert.deepEqual(checkVerdict(r), [])
})

// ---- shouldRedTeam matrix ----

test('shouldRedTeam: task flag true → true', () => {
  assert.equal(shouldRedTeam({ id: '1', redTeam: true }, {}), true)
})

test('shouldRedTeam: task flag false → false', () => {
  assert.equal(shouldRedTeam({ id: '1', redTeam: false }, {}), false)
})

test('shouldRedTeam: task flag absent → false', () => {
  assert.equal(shouldRedTeam({ id: '1' }, {}), false)
})

test('shouldRedTeam: redTeamAll=true covers unflagged and even redTeam:false tasks → true', () => {
  assert.equal(shouldRedTeam({ id: '1' }, { redTeamAll: true }), true)
  assert.equal(shouldRedTeam({ id: '1', redTeam: false }, { redTeamAll: true }), true)
})

test('shouldRedTeam: strict === true — truthy non-boolean values do NOT trigger', () => {
  assert.equal(shouldRedTeam({ id: '1', redTeam: 'true' }, {}), false)
  assert.equal(shouldRedTeam({ id: '1', redTeam: 1 }, {}), false)
  assert.equal(shouldRedTeam({ id: '1' }, { redTeamAll: 'yes' }), false)
})

test('shouldRedTeam: null/undefined inputs → false, and always returns a boolean', () => {
  assert.equal(shouldRedTeam(null, null), false)
  assert.equal(shouldRedTeam(undefined, undefined), false)
  assert.equal(typeof shouldRedTeam(null, { redTeamAll: true }), 'boolean')
  assert.equal(shouldRedTeam(null, { redTeamAll: true }), true)
})
