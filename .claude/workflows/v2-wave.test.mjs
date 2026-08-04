// Unit tests for the pure helpers in v2-wave.js (Lane A-code A4/A7).
// Run: node .claude/workflows/v2-wave.test.mjs   (or: node --test .claude/workflows)
//
// v2-wave.js is a workflow-host script (top-level `await agent(...)` / top-level `return`),
// so it is NOT importable as a standard ES module — `import` throws "Illegal return statement".
// The helpers are PLAIN function declarations, NOT exported (F-016): the host loader special-cases
// ONLY the leading `export const meta` — it AST-requires it as the FIRST statement, slices it off
// verbatim, then pre-checks the remaining body with
//   Function("async function _check() {'use strict';\n" + body + "\n}")
// where any `export` is a load-time SyntaxError. Nothing else export-shaped is tolerated.
// So we extract the sentinel-delimited pure-helper block from the source and evaluate it.
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

const { checkVerdict, shouldRedTeam, modelFor, collectDeferred, buildStop, stopRegex } = new Function(`${block}; return { checkVerdict, shouldRedTeam, modelFor, collectDeferred, buildStop, stopRegex }`)()

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

// ---- modelFor matrix (cost discipline, 2026-06-11) ----

test('modelFor: no config anywhere → inherit (undefined) for build/review/fix/redTeam', () => {
  for (const kind of ['build', 'review', 'fix', 'redTeam']) {
    assert.equal(modelFor(kind, { id: '1' }, {}), undefined)
    assert.equal(modelFor(kind, null, null), undefined)
  }
})

test('modelFor: push defaults to haiku, overridable by models.push and blanket model', () => {
  assert.equal(modelFor('push', null, {}), 'haiku')
  assert.equal(modelFor('push', null, { models: { push: 'sonnet' } }), 'sonnet')
  assert.equal(modelFor('push', null, { model: 'opus' }), 'opus')
})

test('modelFor: per-kind map beats blanket pin', () => {
  assert.equal(modelFor('review', { id: '1' }, { model: 'opus', models: { review: 'sonnet' } }), 'sonnet')
  assert.equal(modelFor('build', { id: '1' }, { model: 'opus', models: { review: 'sonnet' } }), 'opus')
})

test('modelFor: task tier applies ONLY to that task\'s build/fix — never review/redTeam', () => {
  const t = { id: '1', tier: 'sonnet' }
  const a = { models: { review: 'opus' } }
  assert.equal(modelFor('build', t, a), 'sonnet')
  assert.equal(modelFor('fix', t, a), 'sonnet')
  assert.equal(modelFor('review', t, a), 'opus')
  assert.equal(modelFor('redTeam', t, a), undefined)
})

test('modelFor: garbage shapes fail safe to inherit/defaults', () => {
  assert.equal(modelFor('build', { id: '1', tier: 42 }, {}), undefined)
  assert.equal(modelFor('build', { id: '1', tier: '' }, {}), undefined)
  assert.equal(modelFor('review', { id: '1' }, { models: 'opus' }), undefined)
  assert.equal(modelFor('review', { id: '1' }, { models: { review: 7 } }), undefined)
  assert.equal(modelFor('push', null, { models: { review: 'sonnet' } }), 'haiku')
})

// ---- collectDeferred matrix (deferral ledger, operator directive 2026-06-13) ----

test('collectDeferred: pulls scope=deferred followUps from BOTH review and redTeam, tagged with the feature', () => {
  const results = [
    { build: {}, review: { feature: 'H1 x', followUps: [{ severity: 'MEDIUM', scope: 'deferred', title: 'a' }] },
      redTeam: { feature: 'H1 x', followUps: [{ severity: 'HIGH', scope: 'deferred', title: 'b' }] }, fixes: [] },
  ]
  const led = collectDeferred(results)
  assert.equal(led.length, 2)
  assert.deepEqual(led[0], { task: 'H1 x', severity: 'MEDIUM', title: 'a' })
  assert.deepEqual(led[1], { task: 'H1 x', severity: 'HIGH', title: 'b' })
})

test('collectDeferred: scope=in-scope findings are NOT collected (those flip passed=false and are fixed in-task)', () => {
  const results = [
    { review: { feature: 'f', followUps: [{ severity: 'HIGH', scope: 'in-scope', title: 'fixed-now' }] }, redTeam: null },
  ]
  assert.deepEqual(collectDeferred(results), [])
})

test('collectDeferred: missing/empty/non-array followUps and empty-title entries are ignored, never throw', () => {
  const results = [
    { review: { feature: 'a' }, redTeam: null },
    { review: { feature: 'b', followUps: [] }, redTeam: { feature: 'b', followUps: 'nope' } },
    { review: { feature: 'c', followUps: [{ severity: 'LOW', scope: 'deferred', title: '   ' }] }, redTeam: null },
    null,
  ]
  assert.deepEqual(collectDeferred(results), [])
})

test('collectDeferred: non-array input → [] (never throws)', () => {
  for (const bad of [null, undefined, {}, 'x', 7]) assert.deepEqual(collectDeferred(bad), [])
})

test('collectDeferred: a verdict with no feature string falls back to "(unknown)"', () => {
  const results = [{ review: { followUps: [{ severity: 'MEDIUM', scope: 'deferred', title: 't' }] }, redTeam: null }]
  assert.deepEqual(collectDeferred(results), [{ task: '(unknown)', severity: 'MEDIUM', title: 't' }])
})

// ---- buildStop matrix (relative suite semantics, 2026-08-04) ----
// The defect this pins: the old gate was `verifyPassed===false`, an ABSOLUTE claim that cannot tell
// "I broke the suite" from "the suite was red when I arrived" — it hard-stopped a wave whose builder
// had honestly reported a pre-existing red suite, leaving 5 good commits unreviewed.

const goodBuild = (over = {}) => ({
  task: 'TC-1', summary: 's', filesChanged: ['a.ts'], verifyPassed: true, nonTestGatesPassed: true,
  suite: { baselineFailed: 0, afterFailed: 0, baselineSource: 'npm test @ 73046cd' },
  liveVerified: true, liveVerifyReason: null, lintClean: true, committed: true, commitSha: 'abc', deviation: null,
  ...over,
})

test('buildStop: clean build → null (proceed to review)', () => {
  assert.equal(buildStop(goodBuild(), {}), null)
})

test('buildStop: THE REGRESSION — pre-existing red suite, no worse after → proceeds to review', () => {
  const b = goodBuild({ verifyPassed: false, suite: { baselineFailed: 3, afterFailed: 3, baselineSource: 'npm test @ 73046cd (tip, before my change)' } })
  assert.equal(buildStop(b, {}), null)
  // and the same build even repairs one of them
  assert.equal(buildStop(goodBuild({ verifyPassed: false, suite: { baselineFailed: 3, afterFailed: 1, baselineSource: 'npm test @ 73046cd' } }), {}), null)
})

test('buildStop: a build that makes the suite WORSE stops, naming both numbers', () => {
  const r = buildStop(goodBuild({ verifyPassed: false, suite: { baselineFailed: 3, afterFailed: 5, baselineSource: 'npm test @ 73046cd' } }), {})
  assert.match(String(r), /WORSE: 3 failing at baseline → 5 after/)
})

test('buildStop: NON-TEST gates red always stops, even with a spotless suite delta', () => {
  const r = buildStop(goodBuild({ nonTestGatesPassed: false }), {})
  assert.match(String(r), /NON-TEST gates red/)
})

test('buildStop: unmeasured/malformed suite counts stop — the honesty is the number, not the flag', () => {
  for (const bad of [undefined, null, 'green', [], {}, { baselineFailed: 1 }, { baselineFailed: 1, afterFailed: '1', baselineSource: 'x' },
    { baselineFailed: 1.5, afterFailed: 1, baselineSource: 'x' }, { baselineFailed: -1, afterFailed: -2, baselineSource: 'x' }]) {
    assert.match(String(buildStop(goodBuild({ suite: bad }), {})), /no MEASURED suite counts/)
  }
})

test('buildStop: stopOnAnyRed opt-out restores ABSOLUTE semantics (strict === true)', () => {
  const b = goodBuild({ verifyPassed: false, suite: { baselineFailed: 3, afterFailed: 3, baselineSource: 'npm test @ 73046cd' } })
  assert.match(String(buildStop(b, { stopOnAnyRed: true })), /suite still red \(3 failing\)/)
  assert.equal(buildStop(b, { stopOnAnyRed: 'yes' }), null)   // truthy non-boolean does NOT opt in
  assert.equal(buildStop(b, {}), null)
  assert.equal(buildStop(goodBuild(), { stopOnAnyRed: true }), null) // green suite is unaffected by the opt-out
})

test('buildStop: sentinel-prefix stop marker still stops (F-019); an advisory mention does not', () => {
  assert.match(String(buildStop(goodBuild({ deviation: 'BLOCKED: spec contradicts D-016' }), {})), /signalled a hard stop/)
  assert.equal(buildStop(goodBuild({ deviation: 'No BLOCKED/CONFLICT items; renamed a helper.' }), {}), null)
  assert.equal(buildStop(goodBuild({ deviation: 'blocked tool_result events are logged now' }), {}), null)
})

test('buildStop: a dead/skipped build agent still stops, and garbage args never throws', () => {
  assert.match(String(buildStop(null, {})), /no verdict/)
  assert.match(String(buildStop(undefined, null)), /no verdict/)
  assert.equal(buildStop(goodBuild(), null), null)
  assert.equal(buildStop(goodBuild(), undefined), null)
})

test('buildStop: verifyPassed is no longer the gate — true or false alone decides nothing', () => {
  assert.equal(buildStop(goodBuild({ verifyPassed: false }), {}), null)
  // an over-claiming builder is NOT auto-stopped; the contradiction is surfaced to the reviewer instead
  assert.equal(buildStop(goodBuild({ verifyPassed: true, suite: { baselineFailed: 2, afterFailed: 2, baselineSource: 'npm test @ 73046cd' } }), {}), null)
})

test('schema/prompt drift guard: BUILD requires the new fields and BUILD_PRE tells builders to measure', () => {
  const s = src.replaceAll('\r\n', '\n') // F-054: editors here flip LF→CRLF
  assert.match(s, /required:\[[^\]]*'nonTestGatesPassed'[^\]]*'suite'[^\]]*\]/, 'BUILD schema must REQUIRE nonTestGatesPassed + suite so they cannot be silently omitted')
  assert.match(s, /SUITE BASELINE — MEASURE IT, DO NOT GUESS IT/, 'BUILD_PRE must instruct builders to measure the baseline')
  assert.ok(!/b\.verifyPassed===false|f\.verifyPassed===false/.test(s), 'verifyPassed must no longer be used as the wave-stop gate')
})

// ---- host-load regression (F-016) ----
// Reproduce the workflow host's EXACT load pipeline in pure Node: the loader AST-requires
// `export const meta` as the FIRST statement, slices it off verbatim (scriptBody = src.slice(meta.end)),
// then pre-checks the remaining body with V8 via Function("async function _check() {'use strict';\n"+body+"\n}").
// Any `export` (or anything else illegal inside a function body) left in that body means EVERY future
// wave invocation dies at load, before any BUILD agent spawns. node --check, ESM dynamic import, and
// extract-and-eval all bypass this pipeline — only this repro catches the class.

function bodyAfterMeta(source) {
  assert.ok(source.startsWith('export const meta'), 'host loader requires `export const meta` as the first statement')
  // find the end of the meta object literal: brace-match, honoring quotes and escapes
  let depth = 0, quote = null
  for (let k = source.indexOf('{'); k < source.length; k++) {
    const c = source[k]
    if (quote) {
      if (c === '\\') k++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return source.slice(k + 1)
  }
  assert.fail('meta object literal never closes')
}

test('host-load regression (F-016): body after meta passes the host V8 pre-check', () => {
  const body = bodyAfterMeta(src)
  assert.ok(!/^\s*export\b/m.test(body), 'no export statements may remain after the leading meta export')
  assert.doesNotThrow(
    () => new Function("async function _check() {'use strict';\n" + body + "\n}"),
    'v2-wave.js body must compile inside the host async-function wrapper — only the leading `export const meta` is tolerated (F-016)'
  )
})
