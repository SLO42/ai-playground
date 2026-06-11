# Failure log — ai-playground v2

Carried-forward failure patterns + prevention rules. Scan this BEFORE starting a
task (error-learning protocol). Append a new `F-NNN` entry whenever build/test
did not pass on the first try; escalate recurrences per the protocol.

This is the UNIFIED log (F-001 onward; 2026-06-10): F-001..F-013 were carried on
the build branch (`v2`), F-014/F-015 were logged on `v2-main` — merged here and
synced to both branches so every agent sees the full set. New entries append here.

The F-001..F-012 entries below are **carried from v1** (IMPLEMENTATION-PLAN §6)
— the prevention rules apply to v2 from day 0.

**Iron Law (harvested: gstack investigate/SKILL.md, MIT):** no fix without an
instrumented root cause — reproduce the failure and confirm the cause with
evidence (log/assertion at the suspected cause) BEFORE fixing; lock debug edits
to the affected module; 3 failed hypotheses = STOP and escalate. A recurring
F-entry in the same files is an **architectural smell**, not a coincidence —
escalate per the error-learning protocol instead of re-patching.

**Staleness/contradiction marking (harvested: gstack learn/SKILL.md, MIT — G2:
agents propose, operator retires):** if an entry looks obsolete (its files/
commands no longer exist — cite the search that proved it) or two entries
contradict, append a dated `> STALE-PROPOSED:` / `> CONFLICT:` line under the
entry with the evidence. **MARK, never delete** — entries stay in force until
the operator retires them.

## F-001: process.kill(pid, 0) unreliable on Windows/MINGW
- **What**: liveness checks via `process.kill(pid, 0)` give wrong answers on
  Windows.
- **Why**: MINGW signal emulation doesn't map to Windows process semantics.
- **Fix**: use `tasklist /FI "PID eq <pid>"` to check liveness.
- **Prevention**: never `process.kill(pid, 0)` on Windows — `tasklist` only.

## F-002: detached spawn breaks on paths with spaces
- **What**: `spawn(..., { detached: true })` fails for `C:\Program Files\...`.
- **Why**: Node argv quoting on Windows.
- **Fix/Prevention**: pass `shell: true` on Windows for detached spawn; still
  pass args as an array (no string concatenation) to avoid shell injection.

## F-005: routing fallback must be explicit
- **What**: a route with no match silently dropped the task.
- **Prevention**: `resolveRoute` always ends in an explicit fallback branch.

## F-006: native/provisioned binaries run unverified
- **What**: a provisioned binary (SurrealDB) ran without integrity check.
- **Why**: no checksum gate before spawn.
- **Prevention**: SHA-256-verify every provisioned binary before spawn; fail
  hard on mismatch (SEC-009 / D-006).

## F-007: worktree agents lose work if they don't commit
- **What**: a worktree agent finished without committing — changes lost.
- **Prevention**: worktree/dispatched agents MUST commit before finishing.

## F-008: fake/hardcoded runtime data
- **What**: UI showed plausible-looking numbers not backed by a live source.
- **Prevention**: runtime data ALWAYS from live sources; honest states
  (loading/empty/error/stale/unknown) instead of fabricated values. Fixtures
  allowed only in tests.

## F-009: runes require .svelte.ts (not .ts)
- **What**: `$state`/`$derived` in a plain `.ts` module didn't compile as runes.
- **Prevention**: reactive runes live in `.svelte.ts` (or `.svelte`); plain
  `.ts` modules stay rune-free.

## F-010: Playwright networkidle hangs with SSE
- **What**: `waitUntil: 'networkidle'` never settles when an SSE stream is open.
- **Prevention**: use `waitUntil: 'load'` for pages with a live SSE stream.

## F-011: {@const} placement
- **What**: `{@const}` outside an allowed block was a compile error.
- **Prevention**: `{@const}` only as an immediate child of `{#each}`/`{#if}`/
  `{#await}`/`{#snippet}`/`<svelte:boundary>` etc.

## F-012: worktree agents MUST commit (recurrence of F-007)
- **What**: repeat of F-007 in a different wave.
- **Prevention**: bake "commit before finishing, then merge back" into every
  dispatched implementation agent's prompt.

## F-013: SurrealDB datetime fields break SvelteKit load serialization
- **Date**: 2026-06-08
- **What**: setting a new `option<datetime>` field (`sprint.completed_at`) and
  returning the row from a `+page.server.ts` `load` threw a 500 — "Cannot
  stringify arbitrary non-POJOs (data.sprints[0].completed_at)". Build/unit-tests
  were green; it only surfaced on the live re-invalidation after the write.
- **Why**: the SurrealDB 2.x SDK returns datetime columns as a non-POJO Date-like
  the SvelteKit devalue serializer rejects. The table's `norm*()` only coerced
  id/project; datetime fields were passed through raw and were NONE on every prior
  row, so the gap was invisible until a row actually had the field SET.
- **Fix**: coerce every datetime field to an ISO string in the row normalizer
  (`isoOrUndef()` in projects/repo.ts `normSprint`); omit when absent (§6.1).
- **Prevention**: when adding ANY `datetime` field to a table whose rows are
  returned from a SvelteKit `load`, coerce it to a string in that table's
  normalizer — never return a raw SDK datetime to the client. Unit tests that
  read back rows where the field is NONE will NOT catch this; assert it on a row
  where the field is SET, or live-verify after the write.

## F-014: live-verify hang + dev-server orphan storm
- **Date**: 2026-06-08
- **What**: A gap-closure build agent (v1.6/10.1) ran ~2h with no commit; it had built all files but spun forever on the mandatory live agent-browser verify, leaking 17 orphaned dev-server node processes.
- **Why**: agent-browser on Windows is flaky (os error 10060 read-timeouts; SurrealDB SDK hangs ~90s on a dead socket). The per-feature live-verify had NO time bound and NO server reuse/cleanup, so agents retry-spun and each re-booted (then leaked) a dev server.
- **Fix**: Hard commit gate = build+test+lint(0)+svelte-check(0). agent-browser smoke is REQUIRED-BUT-BOUNDED (~5 min, no spin) → on env timeout, record liveVerified:false + reason and proceed; consolidated live pass at the end-gate. Reuse ONE dev server; mandatory teardown of every spawned process. Code-side (v1.9, `ecc9c4d`): `Db.connect` is now hard-bounded (`db/client.ts` `DEFAULT_CONNECT_TIMEOUT_MS=5000`, rejects honestly into the degraded-boot path) — the ~90s dead-socket SDK hang can no longer wedge boot.
- **Prevention**: In any workflow that live-verifies via a browser/dev-server: bound the browser step in wall-clock, never spin-retry a flaky tool, reuse a single server, and kill every process you spawn before returning.

## F-019: wave stop-regex false positive on prose "blocked"
- **Date**: 2026-06-10
- **What**: wave v2.2a stopped after task 15.1's fully-green build (committed, live-verified) without ever running its review. No defect existed.
- **Why**: the v2-wave template's deviation stop-guard `/\bBLOCK(?:ED|ER)?\b/i` was case-insensitive, so the builder's *advisory* deviation prose — "SDK-path denies surface as **blocked** tool_result events" (describing the gate working correctly) — matched the BLOCKED marker.
- **Fix**: stop markers are now case-SENSITIVE all-caps flags (`CONFLICT|BLOCKED|BLOCKER` exact + the literal phrases "cannot proceed"/"hard stop"); resumed the wave via resumeFromRunId (green build returned cached).
- **Prevention**: machine-parsed control flags embedded in free prose must be syntactically distinguishable from prose — all-caps exact markers, dedicated fields, or sentinel prefixes. Never case-insensitive word-match a control signal against text agents write naturally. (When adding any new verdict-field regex to the template: test it against REAL past verdict texts first.)
- **Recurrence (2026-06-11)**: the case-sensitive fix false-matched AGAIN on a NEGATED caps mention — 16.6's green build wrote "No BLOCKED/CONFLICT items" in its deviation and stopped wave v2.1. Escalated to the structural fix the entry already prescribed: **sentinel prefix** — markers count only at the START of the deviation (`/^\s*(CONFLICT|BLOCKED|...)/`), and BUILD_PRE now instructs builders to BEGIN the deviation with "BLOCKED:"/"CONFLICT:" when a stop is intended. Lesson: substring presence is never intent; only position + convention is.

## F-015: non-idempotent migration wedged db:up; tests green on fresh DB, broken on live DB
- **Date**: 2026-06-09
- **What**: v1.7/11.4 shipped migration m0025 with a bare `DEFINE TABLE pm_review SCHEMAFULL`. It half-applied on the live dev DB (table created, field defs/index never landed, migration not recorded), so `npm run db:up` failed permanently with "The table 'pm_review' already exists", and pm_review rows missing `created_at` rendered the literal string "undefined" in the PM tab. All 14 unit tests passed.
- **Why**: (1) The migration wasn't idempotent, and the runner records a migration only on success — any partial apply wedges every future `db:up`. (2) Tests ran migrations against a FRESH throwaway DB where m0025 applies cleanly, so the half-applied live-DB state was unreachable by the suite. (3) The normalizer did `str(row.created_at)` — stringifying `undefined` into fake-looking UI text instead of coercing absent datetimes to null/'—'.
- **Fix**: Made m0025 idempotent (IF NOT EXISTS/OVERWRITE pattern), unwedged the live DB + backfilled created_at, hardened normPmReview (absent datetime → null → '—'), added idempotency tests incl. the half-applied recovery path, swept other migrations for the same pattern.
- **Prevention**: Every SurrealDB migration statement must be idempotent (IF NOT EXISTS / OVERWRITE) — assume it can die mid-apply and will re-run. Migration tests must cover: apply twice, and apply over a simulated half-applied state. Never `str()` a possibly-absent datetime in a normalizer — absent → null, UI renders '—' (extends F-013). Run `npm run db:up` against the LIVE dev DB as part of verify, not only fresh test DBs.

## F-016: workflow-host scripts tolerate ONLY the leading `export const meta` — any other export is a load-time SyntaxError
- **Date**: 2026-06-10
- **What**: v2-wave.js (cb02fe5, Lane A-code A4/A7) marked the new pure helpers `export function checkVerdict/shouldRedTeam`. Every wave invocation died at LOAD with `SyntaxError: Unexpected token 'export'` — before any BUILD agent spawned. The canonical wave template was un-runnable.
- **Why**: the workflow-host loader AST-requires `export const meta` as the FIRST statement, slices it off verbatim (`scriptBody = src.slice(meta.end)`), then pre-checks the remaining body with `Function("async function _check() {'use strict';\n" + body + "\n}")` and parses `(async () => {...})()` with acorn sourceType:'script' — `export` inside a function body is illegal in both. meta is SPECIAL-CASED and sliced off; nothing else export-shaped is tolerated. The builder's three verification channels (node --check — exits 0 even on some genuinely malformed module-detected sources; ESM dynamic import — fails only for the unrelated top-level-return reason; extract-and-eval tests) all bypass the host's actual load pipeline, so the inference "host tolerates exports, per the existing meta export" went unverified.
- **Fix**: de-exported both helpers to plain `function` declarations (host load pre-check re-run: LOAD OK); corrected the comments that encoded the false premise; added a host-load regression test to v2-wave.test.mjs that re-runs the host's exact V8 pre-check on the body-after-meta.
- **Prevention**: workflow-host scripts: only the leading `export const meta` is tolerated; any other `export` is a load-time SyntaxError; verify template changes against the host load-path repro — `new Function("async function _check() {'use strict';\n" + bodyAfterMeta + "\n}")` — not node --check.
