---
name: atelier-wave
description: Use when authoring, editing, running, or recovering a v2-wave build in Atelier — the workflow-per-wave build factory (.claude/workflows/v2-wave.js). Covers the load-time syntax traps that make a wave un-runnable (F-016/F-056), the sentinel stop markers (F-019), model-per-kind cost discipline, and the StructuredOutput-crash recovery (F-051) so committed work is never lost or re-run.
---

# Atelier v2-wave — build factory, safely

`v2-wave` is how features get built here: one workflow per wave, BUILD → independent D-038 review
→ bounded fix-loop → optional red-team → commit-on-green → `pushAtEnd`. It is fiddly at the edges;
every trap below has cost a full re-run.

## Where
- Script: `F:\code\ai-playground\.claude\workflows\v2-wave.js` (branch `v2-main`). NOT in the v2
  worktree.
- Test / load-gate: `.claude/workflows/v2-wave.test.mjs`.
- Queue it drives: `docs/BUILD-QUEUE.md` (git-tracked, operator-authorized; markdown, NOT the DB —
  the factory must not store control state in the SurrealDB it migrates/resets).

## Args (shape)
```js
{ waveName, tasks: [{ id, title, build, redTeam?, tier? }],
  commonExtra?, maxFixAttempts? /*2*/, redTeamAll?, model?, models?, pushAtEnd? /*true*/ }
```
Per task: BUILD → independent review → in-script fix-loop (`MAX_FIX=2`, no main-thread round-trip)
→ verdict-artifact gate → red-team second pass on `redTeam`/`redTeamAll` → commit on green.
`pushAtEnd` pushes `origin v2` after a fully-green wave. In-scope MEDIUM+ findings flip
`passed=false` → fix-loop; DEFERRED findings → `deferredFollowUps` ledger → chain a hardening wave.

## Load-time traps (break the wave BEFORE any agent spawns)
The host AST-requires `export const meta` as the FIRST statement and slices it off; the rest is
pre-checked with `new Function("async function _check(){'use strict';\n"+body+"\n}")`. So:

1. **Only the leading `export const meta` is tolerated. Any other `export` = load-time SyntaxError
   (F-016).** Helper functions are plain `function` declarations, never `export function`.
2. **Escape every literal backtick inside a prompt template literal** (`BUILD_PRE`/`REVIEW_PRE`/
   `COMMON`): `` \` `` — an unescaped backtick closes the template early (F-016 sibling).
3. **Never put `*/` inside a `/* */` or `/** */` comment (F-056).** Cron `*/5`, glob `**/*.ts`, and
   regex fragments all contain `*/` and terminate the comment → transform SyntaxError. Use a `//`
   line comment or a string literal.

**After ANY template/script edit, run the load-gate — it re-runs the host's exact V8 pre-check:**
```bash
node --test .claude/workflows/v2-wave.test.mjs
```
`node --check` is NOT enough — it doesn't replicate the host load pipeline (F-016).

## Control-flow traps
- **Stop markers are sentinel-prefix only (F-019).** A wave stops on a deviation ONLY when the
  deviation field BEGINS with an all-caps marker: `BLOCKED:` / `CONFLICT:` / `BLOCKER:` /
  `CANNOT PROCEED` / `HARD STOP` (regex `^\s*(...)`). Prose mentioning "blocked" mid-sentence must
  NOT stop the wave — that false-positived twice before the sentinel fix. When you intend a stop,
  begin the deviation with `BLOCKED: <why>`.
- **Cost discipline — `modelFor(kind, task, waveArgs)`**: for build/fix, `task.tier` wins; else
  `models[kind]`; else blanket `model`; else `push` → `haiku`; else inherit. Push/mechanical steps
  cheap; review/red-team rigor is never silently traded for cost. Model-retirement = a FRESH wave,
  never resume a cache from a retired model.
- **`node --test` the template against REAL past verdict/deviation texts** before adding any new
  verdict-field regex (F-019) — substring presence is never intent; only position + convention is.

## Recovery — `StructuredOutput retry cap` host crash (F-051)
The host can die at a schema step with `StructuredOutput retry cap (5) exceeded` AFTER each task's
BUILD→review→commit already landed, but BEFORE `pushAtEnd`. **Work is safe and committed; the
branch is just unpushed.** Do NOT re-run the whole wave. Recover:
```bash
git log --oneline origin/v2..HEAD          # see which tasks committed
# re-run the gate manually (token unset), on the touched suites:
npm run lint && npx svelte-check --threshold error && npx vitest run <touched> && npm run build
git push origin v2
```
Resume-by-scriptPath does NOT work alone: the script reads `waveName`/`tasks` from the `args`
global, which is `undefined` on a `{scriptPath, resumeFromRunId}` relaunch → it dies instantly.
To truly resume, re-pass the FULL original `args` alongside `resumeFromRunId` (completed agents
return cached). For a tiny remaining task, just finish it directly.

## Running a wave (operator loop)
- Waves auto-chain on green (standing autonomy directive): a green wave (all D-038 reviews passed +
  pushed) launches the next `queued` item with no per-wave ask. **Stops are deviation-driven only**:
  a review failure that exhausts its fix-loop, a `CONFLICT`/`BLOCKED` sentinel, or a `gate:operator`
  item. Anything spending real tokens without recorded consent stops (§ escalation).
- Close every autonomous stretch with the devlog digest (`@.claude/skills/atelier-live-verify`).
