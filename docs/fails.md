# Failure log — ai-playground v2

Carried-forward failure patterns + prevention rules. Scan this BEFORE starting a
task (error-learning protocol). Append a new `F-NNN` entry whenever build/test
did not pass on the first try; escalate recurrences per the protocol.

This is the UNIFIED F-001–F-015 log (2026-06-10): F-001..F-013 were carried on
the build branch (`v2`), F-014/F-015 were logged on `v2-main` — merged here and
synced to both branches so every agent sees the full set.

The F-001..F-012 entries below are **carried from v1** (IMPLEMENTATION-PLAN §6)
— the prevention rules apply to v2 from day 0.

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

## F-015: non-idempotent migration wedged db:up; tests green on fresh DB, broken on live DB
- **Date**: 2026-06-09
- **What**: v1.7/11.4 shipped migration m0025 with a bare `DEFINE TABLE pm_review SCHEMAFULL`. It half-applied on the live dev DB (table created, field defs/index never landed, migration not recorded), so `npm run db:up` failed permanently with "The table 'pm_review' already exists", and pm_review rows missing `created_at` rendered the literal string "undefined" in the PM tab. All 14 unit tests passed.
- **Why**: (1) The migration wasn't idempotent, and the runner records a migration only on success — any partial apply wedges every future `db:up`. (2) Tests ran migrations against a FRESH throwaway DB where m0025 applies cleanly, so the half-applied live-DB state was unreachable by the suite. (3) The normalizer did `str(row.created_at)` — stringifying `undefined` into fake-looking UI text instead of coercing absent datetimes to null/'—'.
- **Fix**: Made m0025 idempotent (IF NOT EXISTS/OVERWRITE pattern), unwedged the live DB + backfilled created_at, hardened normPmReview (absent datetime → null → '—'), added idempotency tests incl. the half-applied recovery path, swept other migrations for the same pattern.
- **Prevention**: Every SurrealDB migration statement must be idempotent (IF NOT EXISTS / OVERWRITE) — assume it can die mid-apply and will re-run. Migration tests must cover: apply twice, and apply over a simulated half-applied state. Never `str()` a possibly-absent datetime in a normalizer — absent → null, UI renders '—' (extends F-013). Run `npm run db:up` against the LIVE dev DB as part of verify, not only fresh test DBs.

## F-016: unhandled ChildProcess 'error' event crashed the whole dev server
- **Date**: 2026-06-10
- **What**: The first REAL session resume (14.6) anchored at a project root that no
  longer existed (a cleaned-up temp fixture). `spawn()` emitted the ChildProcess
  `'error'` event (ENOENT) with NO listener registered — an EventEmitter `'error'`
  with no listener is an UNCAUGHT EXCEPTION, so the entire SvelteKit dev server
  process died mid-request (browser dropped to chrome-error://). All unit tests were
  green; it only surfaced clicking Resume in the live browser verify.
- **Why**: cli-backend.ts only consumed the child's stdout/close; the `'error'` event
  path was unreachable while resume/interject were stubs (every production spawn used
  an existing project root), so the missing listener was latent until a real resume
  could target a vanished cwd.
- **Fix**: (1) `child.once('error', …)` captures the spawn failure; the stream yields
  an honest `error` event ("claude CLI failed to start: …") and the exit-wait promise
  also resolves on `'error'` (a failed spawn may never emit `'close'`). (2)
  channel.resume refuses a vanished root PRE-spawn (`existsSync` check → honest
  "project root no longer exists"). Regression tests: proto suite spawns a
  nonexistent binary and asserts an error EVENT (not a crash); channel suite resumes
  a session whose project root is gone and asserts the pre-spawn refusal with no
  state flip.
- **Prevention**: EVERY `spawn()` call must register a `'error'` listener in the same
  change that adds it — an unhandled ChildProcess `'error'` kills the whole server
  process, and unit tests with valid fixtures will not catch it. When a child's exit
  is awaited, resolve the wait on `'error'` as well as `'close'`. Validate
  operator-supplied / DB-derived cwd paths with `existsSync` BEFORE spawning.

## F-017: full-suite 5s-timeout flakes — OS/process-heavy tests starve under concurrency
- **Date**: 2026-06-10
- **What**: Three consecutive full `npm test` runs each failed a DIFFERENT 1–3 tests
  (ollama-adapter discoverPid; catalog.test "spans publish+deploy+sync"; manager.test
  "healthy tick"), every failure an exact ~5000ms default-timeout hit. All passed
  isolated (0.5–1.4s).
- **Why**: ~120 suites run concurrently, several booting real SurrealDB test servers
  + spawning real CLIs (`tasklist`, `npm`, `claude`). Under that load an OS probe
  that takes <1.5s alone can exceed vitest's 5s default testTimeout. The failing set
  varies run to run — it is scheduler starvation, not a code defect.
- **Fix**: None needed in code under test — re-ran the implicated suites isolated and
  confirmed green before judging the change (14.7).
- **Prevention**: A full-suite failure that (a) is an exact default-timeout hit, (b)
  lands in a test spawning OS processes / probing services, and (c) passes isolated,
  is ENV NOISE — verify isolated, do not chase it in the feature diff. Extends the
  known cc-config readback.live / capability-wiring.live concurrency-flake class. If
  a specific test joins this class repeatedly, give IT a larger explicit timeout
  rather than raising the global default.
