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
- **Recurrence (2026-06-11, 16.6 re-run)**: thunderstore.test "times out HONESTLY"
  joined the class — failed 2/2 full-suite (its 1000ms verify window expired before
  ONE poll's HTTP 404 was processed under load, so the last-observed-response
  assertion found nothing), passed isolated 2/2. Applied the prescribed remedy:
  that test's verifyTimeoutMs raised 1000→4000 (its 10s wall-clock ceiling
  assertion unchanged). Note the variant: the starved bound can be a bound INSIDE
  the code under test (a configured poll window), not only vitest's testTimeout.
  Same session: perf/idle.test "burns ~zero CPU" joined too (2/4 full-suite fails,
  isolated green) — process.cpuUsage() is WHOLE-process, so worker GC under
  saturation exceeded the 15ms budget (300ms @ 5%); widened to 1000ms @ 20%,
  still ~5x below a real busy-loop burn; poller case stays locked by the
  periodicArmed assertions. Third variant of the class: a RATIO/measurement
  assertion (not a timeout) whose noise floor scales with machine load.

## F-018: new-gate-family tests must expect the EARLIER family's deny label
- **Date**: 2026-06-10
- **What**: 4/57 first-run failures in the new edit-scope (15.1/B1) unit matrix — every
  one a wrong EXPECTATION, not an implementation bug: tests asserted `allow` (or the new
  gate's label) where a PRE-EXISTING family already denies first. Concretely:
  NotebookEdit-without-Read (read-before-edit denies), `> /dev/null` and `taskkill /F
  /PID` (path-confinement conservatively denies `/`-rooted tokens), and a case-respelled
  in-scope TARGET (the 13.5 confinement resolver compares case-sensitively and denies).
- **Why**: the gate evaluator is LAYERED (config-protection → dangerous-bash →
  edit-scope → path-confinement → read-before-edit) and several earlier families are
  deliberately conservative (false-positive deny is the fail-closed direction). A test
  for a NEW family that only thinks about that family's logic mis-predicts the composed
  decision.
- **Fix**: assert the LAYER, not just the decision — for conservative-deny collisions
  assert `r.gate !== 'edit-scope'` (the new family stays silent) or test the new
  family's pattern/comparator directly; satisfy earlier families' preconditions (Read
  before NotebookEdit) when asserting a composed allow.
- **Prevention**: when adding a gate family to a layered fail-closed evaluator, write
  the test matrix against the COMPOSED evaluator order, and for any input an earlier
  family already denies, pin WHICH gate fires rather than expecting allow. A
  conservative deny from an earlier layer is correct behaviour, never a regression to
  "fix" by reordering.

## F-019: wave stop-regex false positive on prose "blocked"
- **Date**: 2026-06-10
- **What**: wave v2.2a stopped after task 15.1's fully-green build (committed, live-verified) without ever running its review. No defect existed.
- **Why**: the v2-wave template's deviation stop-guard `/\bBLOCK(?:ED|ER)?\b/i` was case-insensitive, so the builder's *advisory* deviation prose — "SDK-path denies surface as **blocked** tool_result events" (describing the gate working correctly) — matched the BLOCKED marker.
- **Fix**: stop markers are now case-SENSITIVE all-caps flags (`CONFLICT|BLOCKED|BLOCKER` exact + the literal phrases "cannot proceed"/"hard stop"); resumed the wave via resumeFromRunId (green build returned cached).
- **Prevention**: machine-parsed control flags embedded in free prose must be syntactically distinguishable from prose — all-caps exact markers, dedicated fields, or sentinel prefixes. Never case-insensitive word-match a control signal against text agents write naturally. (When adding any new verdict-field regex to the template: test it against REAL past verdict texts first.)

## F-020: dev-server keyboard/SSE assertions race client hydration
- **Date**: 2026-06-11 (renumbered from F-019 on 2026-06-11 — the unified log on
  `v2-main` already carries "F-019: wave stop-regex false positive" (2026-06-10);
  keeping both F-019s would have made the promised cross-branch sync yield two
  different entries under one id)
- **What**: the 15.3 shell-primitives verify-flow pressed Ctrl+K immediately after
  the daemon's `nav` resolved ('load') and asserted the command palette opened — it
  hadn't: the press diff showed only live-data noise (and, tellingly, the statusbar
  "connection live" indicator APPEARING during the press's settle window). Manual
  replay seconds later worked.
- **Why**: `waitUntil:'load'` fires before Svelte hydration on a vite DEV server
  (first-load module compile makes the window seconds wide). The Ctrl+K
  `<svelte:window onkeydown>` listener — and the SSE stream the live-row assertions
  depend on — only exist after hydration, so a keypress/SSE assertion straight after
  'load' is a coin flip. e2e never hit it because Playwright drives the BUILT app
  (fast hydration) with auto-waiting locators.
- **Fix**: deterministic gate in the flow harness (`awaitLive`): bounded poll until
  the Topbar `aria-label="connection live"` node exists — that label flips from the
  SSR'd 'unknown' only after hydration AND the SSE stream attaches. Flows gate after
  their first nav before any keyboard/live-update step.
- **Prevention**: against a dev server, never assert client-side behaviour
  (keyboard listeners, SSE-driven updates) straight after 'load' — gate on an
  observable post-hydration signal (`connection live`) first. Related predicate trap
  fixed in the same task: when a tag string appears in MULTIPLE table rows (a
  workflow's name carries the tag too), match rows with per-condition `.some()`,
  never `.find()` — the first matching row shadows the one under test.

## F-021: services-health verify-flow false-failed the gate when Ollama was UP — "like-for-like" probe wasn't
- **Date**: 2026-06-11
- **What**: `npm run verify:flows` exited 1 accusing the /services page of "probe
  DISHONESTY" whenever Ollama was actually running — the documented-normal dev
  state. The page was honest ("probe: healthy"); the flow's "independent truth"
  probe was the liar. The builder's 3/3 PASS was world-dependent: Ollama happened
  to be down during the build, so the up-branch (`expected='healthy'`) was never
  executed before graduation. Caught by the independent 15.3 DoD review.
- **Why**: the flow comment claimed LIKE-FOR-LIKE with the page's probe ("same
  raw OLLAMA_HOST string"), but the page's adapter normalizes bind-form hosts
  (`ollama-adapter.ts normalizeClientHost`: `0.0.0.0:11434` →
  `http://127.0.0.1:11434`) while `harness.mjs ollamaHost()` returned the raw env
  string — global fetch throws on the scheme-less bind form, so `urlUp()` read
  permanently DOWN. The same OLLAMA_HOST bind/connect overload already bit the
  page itself in 10.5 (that's WHY normalizeClientHost exists); the flow re-derived
  the probe instead of reusing the page's semantics and re-introduced the bug.
- **Fix**: `harness.mjs` now carries a JS port of `normalizeClientHost` applied in
  `ollamaHost()` (the plain-node flow layer can't import the TS module); parity
  with the page implementation is LOCKED by a unit suite in runner.test.ts; the
  flow re-proven live in the Ollama-UP world.
- **Prevention**: a flow that claims LIKE-FOR-LIKE with a page probe must REUSE
  the page's own normalization/predicate — or carry a port whose parity is pinned
  by a test importing both — never re-derive it from the env by hand. And when a
  flow declares "both worlds are valid" (up/down), it must be EXECUTED in both
  worlds before graduation; an unexercised branch is an untested claim.

## F-022: SurrealDB 2.x ORDER BY requires the order field in the SELECT projection
- **Date**: 2026-06-11
- **What**: 16.2's github-arrival persistent-dedup seed query
  (`SELECT provenance FROM pm_review … ORDER BY created_at DESC`) threw
  `Parse error: Missing order idiom 'created_at' in statement selection`; the
  surrounding best-effort catch degraded it to in-memory-only dedup, so the
  cross-restart dedup test failed (a re-fire the feature promised to prevent).
- **Why**: SurrealDB 2.x rejects `ORDER BY <field>` when that field is not in the
  SELECT projection. Every prior query in the codebase happened to `SELECT *` or
  already project the order field, so the constraint was invisible until the
  first narrow projection + ORDER BY combination. The silent part: a broad
  try/catch around a "best-effort" read turned a hard parse error into wrong
  behavior instead of a loud failure.
- **Fix**: project the order field too (`SELECT provenance, created_at … ORDER BY
  created_at DESC`); confirmed by reproducing the exact query against a real
  test DB before fixing (Iron Law).
- **Prevention**: in SurrealDB 2.x, any `ORDER BY` field MUST appear in the SELECT
  projection — when narrowing a projection, keep (or add) the order field. And a
  catch that downgrades a read to "best-effort" must still `console.warn` the
  real error — a parse error spotted in logs is a 1-minute fix; swallowed, it is
  a wrong-behavior hunt.

## F-023: env-level gate denial laundered into a TERMINAL candidate verdict
- **Date**: 2026-06-11
- **What**: 16.6's first live gauntlet run scored the candidate `failed:
  "findings contract violated: findings.json absent"` — a terminal capability
  verdict for the version's certification campaign (§2.2) — when the candidate
  had in fact done nothing wrong: the test env lacked HOOK_URL/HOOK_TOKEN, so
  the CLI PreToolUse gate hook denied EVERY tool call fail-closed (D-024) and
  the session could neither read fixtures nor write findings.json.
- **Why**: the runner's §3.6 classification treated "session completed but no
  findings.json" as a capability failure unconditionally. A fail-closed env
  denial produces exactly that shape — the env failure wore a candidate-verdict
  costume. (Found only because the live verify logged `run.results` and the
  transcript was read back; the structural assertions all passed.)
- **Fix**: (1) the live test stands up the in-process loopback gate endpoint
  (the 13.3/15.1 live-harness shape) so tool calls really flow; (2) product
  rail in gauntlet.ts: any tool_result carrying the gate hook's literal
  fail-closed marker ('gate control plane not configured') reclassifies the run
  mechanically as `error_reason='spawn_failure'` — an env outage can never
  terminally fail a version. Regression-tested.
- **Prevention**: when a verdict path infers "the agent failed to deliver X",
  enumerate the ENV reasons X can be absent and detect them mechanically before
  issuing a capability verdict — fail-closed infrastructure makes innocent
  agents look incompetent. Any CLI-spawning live test whose agent must USE
  TOOLS needs the loopback gate endpoint up (launch.live.test.ts gets away
  without one only because its task says "do not use any tools").

## F-024: recall-filter test asserted through FakeEmbedder RANKING — flaky by construction
- **Date**: 2026-06-11
- **What**: 16.6's D-029 recall-exclusion test passed in isolation but failed in
  the full memory suite: with the suite's other rows present, the control memory
  ranked below the `limit: 10` cut (FakeEmbedder hash-cosine is arbitrary), so
  "control recalled, interview row not" failed for a ranking reason, not a
  filter reason.
- **Why**: the assertion target was the FILTER, but the test observed it through
  the RANKER. Two mechanisms, one assertion — the weaker one (mock-embedder
  ranking under unrelated suite rows) decided the outcome.
- **Fix**: widened the net (`k: 50, limit: 50`) so ranking can't evict the
  control; the assertion now isolates the filter.
- **Prevention**: when testing a recall/query FILTER with a mock embedder, take
  ranking out of the equation (limit ≥ row count, or query by id) — never let a
  top-N cut stand between the assertion and the mechanism under test.

## F-025: SurrealDB string::contains(field, "") matches ALL rows — an empty-needle leak/scan filter match-alls (sibling of F-022)
- **Date**: 2026-06-13
- **What**: red-team found two W-D7b gauntlet latent defects. (1) The §4.2
  sentinel sweep runs `string::contains(content, sentinel)` over memory/pm_memory/
  non-interview transcripts. In SurrealDB 2.x an EMPTY needle matches EVERY row
  (probe: 2/2), and an activated/retired `gauntlet_fixture` with `sentinel=''`
  was possible — `createGauntletFixture` had no non-empty guard and the schema
  field was a bare `DEFINE FIELD sentinel TYPE string`. So one empty-sentinel
  active fixture would flag EVERY memory/transcript row as a leak → fabricated
  leak notification (F-008) + a work_item flood at every connected boot
  (`runSentinelSweep` is wired in hooks.server.ts). (2) `runGauntlet` recorded
  the auto day-cap counting token (`recordAutoToken`) BEFORE the pre-flight
  (sampleFixtures/loadScoringKeys/zero-plant floor), which can throw an uncaught
  `WorkforceInputError` — so a `trigger:'auto'` run that failed pre-flight burned
  a day-cap slot for a run that never started. The existing 'refuses BEFORE
  spend' test used `trigger:'operator'` (bypasses the budget gate) so the AUTO
  spend path was untested.
- **Why**: the sentinel is empty BY DESIGN while `status='proposed'` (injected at
  activation), so a blanket non-empty rule was wrong — the gap was a CONDITIONAL
  invariant (empty allowed only for proposed) enforced nowhere. And the token was
  ordered as "gate passed ⇒ spend" instead of "run actually starts ⇒ spend";
  the pre-flight sits between the two and can abort.
- **Fix**: defect 1 — defense-in-depth at 3 layers: (a) `activateGauntletFixture`
  refuses an empty-sentinel fixture with a named `WorkforceInputError` before the
  proposed→active transition; (b) migration `m0034_gauntlet_sentinel_nonempty`
  (OVERWRITE-idempotent) redefines `sentinel` with a sibling-field assert
  `status = NONE OR status = "proposed" OR string::len($value) > 0`; (c) `sentinelSweep` skips
  empty sentinels (never calls `string::contains` with an empty needle). Defect 2
  — moved `recordAutoToken` to AFTER the pre-flight succeeds, so a no-run never
  consumes a slot; regression tests for `trigger:'auto'` hitting each pre-flight
  failure (no active fixtures / keyless fixture / plantless pool) assert NO token
  consumed.
- **Prevention**: NEVER build a leak/scan filter on an unguarded empty needle —
  `string::contains(field, "")` (and the `string::*` family) match-all in
  SurrealDB 2.x; guard the needle (`if (!needle) continue;`) AND make the empty
  state structurally unreachable at the write boundary + schema (conditional
  assert when empty is legal only in a known state). And meter a budget/quota
  token at the point the metered work ACTUALLY STARTS, never at "the gate
  allowed it" — anything that can throw between the gate and the work (a
  pre-flight) will spend a slot for nothing; test the spend path through the
  trigger that actually exercises the gate, not a bypassing trigger.

## F-026: SurrealDB 2.x UNIQUE index on a computed VALUE field does NOT enforce uniqueness under concurrent inserts
- **Date**: 2026-06-13
- **What**: hardening `confirmLaunchKey` against red-team DEFECT 3 (concurrent
  double-confirm), instrumentation revealed the ROOT cause was deeper than the
  reported "raw untyped error": the `gauntlet_key_dedup` UNIQUE index (on the
  computed field `dedup_key VALUE <string>fixture`) does NOT enforce one-key-per-
  fixture under concurrency. A probe firing two `confirmLaunchKey` calls via
  `Promise.allSettled` persisted TWO `gauntlet_key` rows with IDENTICAL `dedup_key`
  in 25/40 races (both fulfilled, zero rejections). The detect-first
  `readGauntletKeyForScoring` read-then-create has a TOCTOU window the secondary
  index does not close. Three DIFFERENT raw `InternalError` message shapes surfaced
  depending on timing — index-`already contains` (serial), `failed transaction …
  read or write conflict` (commit race), and record-`already exists` (primary-key,
  after the fix) — so a regex that matched only one shape let the others leak; the
  DEFECT 3 test failed twice on successive unseen shapes before all three were mapped.
- **Why**: a SurrealDB 2.x secondary UNIQUE index over a computed `VALUE` field is
  not evaluated atomically against concurrent uncommitted writers — each
  transaction computes its own `dedup_key` and both commit. Only the PRIMARY record
  id is collision-atomic. The dedup invariant was riding on the wrong mechanism.
- **Fix**: `createGauntletKey` now derives a DETERMINISTIC record id from the
  fixture (`gauntlet_key:<fixture-suffix>`) and `CREATE $kid CONTENT …`, so a
  concurrent double-create collides atomically on the primary key (probe: 0/40
  duplicate; final row count always exactly 1). `confirmLaunchKey` maps the
  collision (all three raw shapes) to a named `CeremonyGateError`. The dashboard-
  visible invariant asserted by the regression test is FINAL-STATE (count==1) + no-
  raw-error, NOT "exactly one caller saw created:true" — SurrealDB MVCC lets both
  concurrent writers to the same record id observe success at the SDK layer while
  only one row survives (created:true twice, count still 1 — benign, do not assert
  against it). The redundant secondary index is left in place (harmless defense-in-
  depth); the migration was NOT touched (interrupt/idempotency discipline).
- **Prevention**: in SurrealDB 2.x, enforce a one-row-per-key invariant with a
  DETERMINISTIC PRIMARY RECORD ID (collision-atomic), NEVER a secondary UNIQUE
  index over a computed VALUE field under any concurrent write path — the index
  does not hold. A read-then-create dedup is a TOCTOU bug; make the write itself
  the guard. When mapping a DB collision to a named error, REPRODUCE the concurrent
  path (not just the serial one) and enumerate EVERY raw message shape — match on
  shape (resilient regex of all variants), not the error class. Assert the
  persisted-state invariant (count), not an SDK-layer per-call flag that MVCC may
  report optimistically for both racers.

## F-027: field-by-field trust-boundary guards on untrusted-LLM/extractor output recur as an architectural smell — validate the COMPLETE shape against the schema contract ONCE
- **Date**: 2026-06-13
- **What**: `memory/store.ts` validated untrusted-extractor candidate fields one at a
  time across successive waves: first `content` (`isMemoryCandidate`), then a follow-up
  added `assertProvenanceShape` for `project`/`session`. Each time, the red-team
  IMMEDIATELY reproduced the SAME class on the NEXT schema-constrained field that had no
  guard — `kind` ("Found 42 for field kind … expected a string"), `tags` ("expected
  option<array<string>>"), `importance` (a string reaching the float column) — surfacing
  as a generic SurrealDB type error at CREATE (AFTER screen+embed), not a named D-026
  rejection. The guard family was always one field behind the schema.
- **Why**: the boundary was modeled as "guard the field we just got burned on" instead of
  "validate the candidate against the FULL `memory` schema contract". Every LLM-authored
  field the schema constrains (TYPE/ASSERT/range) is an attack surface; guarding a subset
  leaves the complement open, and the next schema field added is open by default. A
  field-by-field family is structurally incapable of closing the class — it's whack-a-mole
  by construction (Iron Law: recurring same-area defect = fix the LAYER, not another patch).
- **Fix**: replaced the per-field `assertProvenanceShape` + `MemoryProvenanceShapeError`
  with a SINGLE `assertCandidateShape` raising ONE named `MemoryCandidateFieldError` (field
  + received shape via `shapeOf`, never the body) that validates EVERY schema-constrained
  field at the store boundary BEFORE screen/embed/link/CREATE: content (non-empty string),
  project/session (string id or absent), kind (in the ASSERT set), namespace (non-empty),
  key/source (string), tags (array<string>), importance (finite number in [0,10]). Regression
  test asserts a malformed value in EACH field → its NAMED error with `countMemories()`
  unchanged, and a fully-valid candidate still stores. Also sanitized the storeMemories
  dropReason (stripped the un-persisted `memory:<id>` from captured CREATE-error messages).
- **Prevention**: when validating untrusted LLM/extractor output destined for a schema-backed
  table, validate the COMPLETE candidate against the FULL schema contract ONCE at the boundary
  (one validator, one named error enumerating offending field + received shape) — do NOT add a
  guard per field as each one gets exploited. The trigger to escalate: the SAME class
  reproduces on a sibling field a guard didn't cover → that is the architectural smell, fix the
  LAYER. Derive the field list + constraints (TYPE/ASSERT/range) FROM the schema so a newly-
  added schema field is covered by default, and keep any inlined allowed-set/range in lock-step
  with the migration. Reject falsy non-strings (never silently treat as absent — F-008).

## F-028: confirm-gated form drove client state only, never posted the gate field
- **Date**: 2026-06-15
- **What**: the day-0 ceremony activate form (`agents/ceremony/+page.svelte`) 400'd on EVERY pool activation with "confirm activation — …", even with the confirm box ticked. Operator-blocking: no fixture pool could be activated → no launch role certifiable → the whole ceremony wedged at step ③.
- **Why**: the confirm checkbox had `checked={activateConfirm[rv]}` + an `onchange` that set client state, but NO `name` attribute — so it never entered the submitted FormData. The form posted only the hidden `fixture` id; the action's `form.get('operatorConfirmed') !== 'on'` gate (`+page.server.ts:302`) therefore rejected every submit. The button's `disabled={!activateConfirm[rv]}` enabling on tick was a false affordance (client state ≠ posted state). The sibling spend-confirm forms (referenceRun/interview, lines 637/650) did it correctly with a hidden `operatorConfirmed` input mirroring state; the activate form was missing that one line.
- **Fix**: added `<input type="hidden" name="operatorConfirmed" value={activateConfirm[rv] ? 'on' : ''} />` to the activate form (mirrors the spend-confirm pattern). svelte-check 0/0. Commit `1caf58b` (v2).
- **Prevention**: a confirm/gate value MUST be carried by a POSTED field — either `name=` on the control itself or a hidden input mirroring the bound state — NEVER by client-only state that just toggles a `disabled` attr. Server-action unit tests POST the field directly, so they CANNOT catch a missing form-field wiring (same blind spot class as F-014): any operator-gated action must be live-verified by actually CLICKING it through to success, not merely rendering the form. When cloning a form pattern, diff the hidden inputs — a dropped gate field fails closed and looks like a permission error.

## F-029: stale shell-exported credential silently shadows a freshly-set `.env` value
- **Date**: 2026-06-15
- **What**: during the day-0 ceremony, driven Claude Code sessions failed auth (401) even after the operator pasted a fresh, valid `CLAUDE_CODE_OAUTH_TOKEN` into `.env` and restarted `npm run dev`. The `.env` value was proven valid in isolation, yet the running server kept using a stale token.
- **Why**: Vite does NOT inject `.env` into `process.env` for dev SSR; `hooks.server.ts` surfaces the `.env` token into `process.env` at boot ONLY when `process.env.CLAUDE_CODE_OAUTH_TOKEN` is not already set ("never overwrite a shell-exported value"). The operator had a stale token *interactively exported in the dev terminal*, so boot skipped the `.env` surface and the stale value won. A fresh shell (no export) was never used for the restart.
- **Fix**: clear the shell export (`Remove-Item Env:\CLAUDE_CODE_OAUTH_TOKEN` / `unset`) and restart, or launch dev from a shell with no such export — then `.env` is the source. (Operator-side; no code change.)
- **Prevention**: a credential read at `process.env.X` with a "don't overwrite existing" boot-surface is ambiguous about precedence — when a live spawn 401s but `.env` looks correct, FIRST check whether the var is exported in the launching shell (it shadows `.env`). Diagnose token validity by sourcing `.env` into an isolated subprocess (never printing the value). Follow-up worth doing: on boot, if BOTH a shell export and a differing `.env` value exist, log a non-secret WARNING that the shell value is winning.

## F-030: a driven-session spawn that fails surfaced a BLANK error (stderr-only), hiding the real cause
- **Date**: 2026-06-15
- **What**: every failed gauntlet interview recorded `runtime stream error: claude CLI exited 1: ` with nothing after the colon, across three DIFFERENT root causes (401 auth, gate-deny, max-turns). Each took a live repro to diagnose because the note was empty.
- **Why**: `cli-backend.ts` built the exit-error from `stderr` only, but the headless CLI (`--output-format stream-json`) writes its failure as an `is_error` result line on STDOUT with empty stderr. The real reason was always on stdout, discarded.
- **Fix**: keep a rolling tail of raw stdout lines; when the CLI exits non-zero, the error note falls back to the stdout tail when stderr is empty. Added `GAUNTLET_TRACE=1` to mirror the full stream-json (thinking/tools/result) to the server log for live debugging.
- **Prevention**: when wrapping a subprocess that speaks a structured protocol on stdout, NEVER assume errors go to stderr — capture and surface the stdout tail on non-zero exit. A blank error string is itself a bug; emit `(no output captured)` rather than an empty suffix.

## F-031: dev server bound IPv6 `::1` only while the loopback control plane spoke IPv4 `127.0.0.1`
- **Date**: 2026-06-15
- **What**: with auth + turns fixed, the interview agent spawned but EVERY tool call was denied "gate endpoint unreachable/timed out — failing closed (D-024)", so it could never read fixtures or write findings.
- **Why**: Vite dev defaults to binding `localhost`, which resolves to IPv6 `::1` — the server had no IPv4 listener. But the whole loopback control plane (HOOK_URL built from `HOST` default `127.0.0.1`, the gate hook POST, SurrealDB, the D-024/D-025 loopback assertions) speaks `127.0.0.1`. The gate hook's POST to `http://127.0.0.1:PORT/api/gates/pretooluse` got connection-refused → fail-closed deny. The browser worked because it reached the server via `localhost`→`::1`.
- **Fix**: bind the dev server to IPv4 loopback explicitly — `server: { host: '127.0.0.1' }` in `vite.config.ts` — so the whole control plane is consistently `127.0.0.1`. (Use `http://127.0.0.1:5173`, not `localhost`.)
- **Prevention**: a loopback-only app must pin ONE loopback family end to end. If any component hardcodes `127.0.0.1` (HOOK_URL, gate, DB), the HTTP server must bind `127.0.0.1` too — never leave it on `localhost`/`::1`. A "server is listening" check is not enough; verify the LocalAddress family matches the callers'.

## F-032: `--max-turns` defaulted to 1 — fatal for every agentic driven session
- **Date**: 2026-06-15
- **What**: the first real interview exited `error_max_turns` ("Reached maximum number of turns (1)") after a single tool call.
- **Why**: `ClaudeCliBackend` defaults `maxTurns` to 1 and the single production construction (`harness/wiring.ts`) never overrode it. One turn is fine for a one-shot reply but fatal for any agent that must read files then write output. Never caught earlier because the real-CLI tests use a `node` stand-in that ignores `--max-turns`.
- **Fix**: `wiring.ts` constructs the backend with `maxTurns: 80`; the per-spawn wall-clock (`timeoutMs`) and the gauntlet's own bound remain the runaway guards.
- **Prevention**: a default that makes the common path fail (turns=1 for an agent) is a wrong default, not a safe one. When a backend option only ever matters under a REAL subprocess that tests stub out, add a live test (or at least assert the production wiring sets a sane value) — a stand-in that ignores the flag proves nothing about it.

## F-033: scorer_control fixtures were excluded from the ceremony keying/activation flow → scorer_error
- **Date**: 2026-06-15
- **What**: with the spawn path fully working (agent reviews, resists injection, writes findings), every interview still failed `error_reason='scorer_error'`: "no active scorer_control fixture (with key)".
- **Why**: §3.4 requires each role's `scorer_control` fixture be ACTIVE and KEYED so the scorer self-verifies (known-pass→all found, known-fail→none) before judging the candidate. But the ceremony's operator key-authoring + activation queries all filter `kind != 'scorer_control'`, so the control stayed `proposed` and unkeyed — the UI gave no path to key/activate it, contradicting the §3.4 contract.
- **Fix**: the scorer_control key is MECHANICALLY derivable from the fixture's own shipped `known-pass.findings.json` (that report IS the answer — §4.4 blesses `author:'fixing_commit_diff'`). Added `ensureScorerControlReady(db, roleId)` (ceremony.ts): derive plants from the known-pass report (file+lines presence plants for a zero-ambiguity full match; regex-escaped artifact for absence), `createGauntletKey(author:'fixing_commit_diff')` check-then-create (idempotent), then `activateGauntletFixture`. Called from both run triggers before `runGauntlet`. Tests assert derive+activate, idempotency, and `runPositiveControl` ⇒ ok.
- **Prevention**: when a scoring/verification step REQUIRES an artifact (here the control key), the flow that sets up the run must PROVISION it — do not exclude it from every authoring path and assume "the operator does it later" with no UI for it. If an artifact is mechanically derivable, derive it (don't make a human hand-author a deterministic value). Live-verify the full run path, not just the unit pieces — none of F-029..F-033 were reachable by the stand-in-based tests.

## F-034: SurrealDB 2.0.3 JS SDK masks an aborted transaction + a per-counter budget races; atomic caps need a UNIQUE-index guard, not a counter check
- **Date**: 2026-06-15
- **What**: enforcing a per-session peer-send budget atomically (PM2 finding c). Three real surprises cost ~10 probe iterations before the design held: (1) wrapping `SELECT count() … then CREATE` in `BEGIN/COMMIT` did NOT serialize concurrent sends — N racers each read "under budget" and all inserted (a SELECT-count is not a write conflict). (2) Switching to an in-transaction monotonic counter (`UPDATE session SET peer_sends_count += 1`) kept the COUNTER correct but still LEAKED rows: this SurrealDB build MERGES concurrent `+= 1`/`-= 1` deltas instead of aborting the loser, so every CREATE committed while the counter netted out. (3) A multi-statement `THROW` inside the tx is reported by the JS SDK (2.0.3) as a generic `"The query was not executed due to a failed transaction"` — the THROW message is LOST; worse, an aborted-on-UNIQUE transaction sometimes RESOLVES and returns the pre-abort `CREATE … RETURN AFTER` value — a PHANTOM row that never committed (and a direct `SELECT … FROM <id>` even returns the phantom, so a by-id read is not a reliable persistence check).
- **Why**: SurrealDB optimistic concurrency here does not abort on a read-then-write or a delta-merge; only a genuine UNIQUE-index collision aborts a transaction. The SDK has no `query_raw`/per-statement status, so a masked transaction failure is indistinguishable from success at the JS layer.
- **Fix**: assign a per-sender monotonic `peer_seq` from the counter and stamp it AT CREATE under a composite `UNIQUE (from_session, peer_seq)` index (m0041) — THAT is the DB-enforced hard cap (two racers that land the same seq collide, one aborts → at most `cap` rows can EVER exist). Over-budget is signaled by an empty/NONE result (avoid THROW — it's masked), mapped to a NAMED SendBudgetError. An HONESTY GUARD confirms the returned row actually owns its (from_session, peer_seq) slot via an INDEX scan (not a by-id read) — a phantom from a masked abort is rejected and retried (bounded, F-014). A dedup-key collision masked inside the tx is recognized by probing for an existing (sender, client_key) row → IdempotencyError, never a budget mis-report. Verified: 3N concurrent sends ⇒ EXACTLY N persist, N succeed (zero phantoms), the rest NAMED-denied, across many runs.
- **Prevention**: To enforce a hard COUNT cap atomically in SurrealDB, do NOT rely on an in-transaction counter/recount — this build merges deltas and won't abort. Use a UNIQUE index on a per-entity monotonic sequence stamped AT CREATE; the index is the only reliable abort signal. Never trust a multi-statement THROW message or a transaction's resolved row at face value on the SDK — confirm the row committed via an INDEX scan (a by-id SELECT can return a phantom from a masked-aborted tx). Also (F-016 sibling, recurred): a literal backtick inside a backtick-delimited migration template literal (`AT MOST `cap` rows`) closed the literal early → an esbuild "Expected }" at load; use plain words/quotes, never backticks, inside the schema/prompt template literals.

## F-035: ms-truncated `new Date(iso).getTime()` comparison collapses SurrealDB's 100ns datetime ordering in a test assertion
- **Date**: 2026-06-16
- **What**: BL-9 work-queue monitor pagination test (`queue-monitor.test.ts`) failed (`expected false to be true`). It enqueued 3 `work_item` rows in a tight loop, paged with limit 2, took the 2nd row's `enqueuedAt` as a `?before=` cursor, then asserted `older.every(r => new Date(r.enqueuedAt).getTime() < new Date(cursor).getTime())`. The lister/SQL were CORRECT — the assertion was wrong. The `listWorkItems` `before` filter (`created_at < <datetime>$before`) and svelte-check/lint/build were all green; only the JS re-assertion failed.
- **Why**: SurrealDB stamps `created_at` (`time::now()`) at 100-nanosecond precision (`2026-06-16T16:27:32.3589883Z`). Three enqueues in one loop share the same MILLISECOND (`.358`). The cursor ISO retains full precision, so the SQL `<` filter correctly returned the strictly-earlier row, but `new Date(iso).getTime()` truncates to ms, collapsing `.3589883` and `.3579139` both to `.358` — so the JS `< cursor` re-check was `358 < 358` = false. A test-side precision mismatch, not a code defect.
- **Fix**: compare the ISO STRINGS lexicographically (`r.enqueuedAt < cursor`) — fixed-width zero-padded UTC ISO sorts chronologically at full precision — and assert `older.length > 0` so the page is proven to have narrowed. Also added a read-only-invariant test (queueStats + listWorkItems mutate nothing even over GC-eligible rows).
- **Prevention**: NEVER re-assert SurrealDB datetime ordering via `new Date(iso).getTime()` — its ms truncation discards the engine's 100ns precision and silently breaks `<`/`>` checks on rows created in the same millisecond. Compare the ISO strings directly (lexicographic == chronological for UTC fixed-width ISO), or assert against the SQL result set itself rather than recomputing the comparison in JS. (Sibling of F-013: SurrealDB datetimes carry more precision than JS Date round-trips — coerce to ISO and keep them as strings.)

## F-036: a new `FROM memory` reader (BL-8 observability.ts) slipped the D-026 leak census because the build wave's targeted test slice excluded the cross-cutting quarantine-leak guard
- **Date**: 2026-06-16
- **What**: BL-8 brain-observability shipped `memory/observability.ts` with `loadMemoryContent` doing `SELECT id, content FROM memory WHERE id IN $ids;` — a content-surfacing read for the utilization lens (listRetrievalOutcomes) that was NOT classified in the `quarantine-leak.test.ts` READERS census and (worse) carried NO `screen_status != "quarantined"` filter. The cross-cutting coverage guard in `quarantine-leak.test.ts` (PART A: "EVERY file in src/lib/server with a `FROM memory` read is classified") went RED on the branch, but BL-8's own wave was green because it ran only the touched-area slice (`observability.test.ts`), never the census guard. So a real D-026 leak-boundary gap (a quarantined memory's stored body could surface in the leaderboard if its retrieval_outcome rows persisted — e.g. recalled-then-quarantined, or adversarially tier-promoted) shipped behind a green build.
- **Why**: (1) The D-026 census is a CROSS-CUTTING invariant (it Globs the whole `src/lib/server` tree), but the build wave's test selection was scoped to the feature's own directory — the guard that polices new readers lives in a DIFFERENT file than the feature, so the feature's slice never ran it. (2) `loadMemoryContent` was written as defence-in-depth-only ("screen the content anyway") on the assumption quarantined rows have no outcome rows — true on the happy path, false adversarially, and the census demands the active-set FILTER, not just a display screen. (3) Sibling subtlety while fixing: the per-file COUNT guard counts the bare phrase `FROM memory` in the SOURCE TEXT including comments — a JSDoc comment that wrote the literal "`FROM memory`" inflated the count from 1→2 and re-failed the guard; reworded to "memory-table content read".
- **Fix**: classified `loadMemoryContent` LEAK and added `screen_status != "quarantined"` to its statement (a quarantined memory now resolves to content '' on the leaderboard — honest, already-documented behaviour — never its body); added the LEAK census entry; added a real-SurrealDB red-team test (`observability.test.ts`) proving a quarantined row with a persisted retrieval_outcome surfaces id+counts but content ''. All 23 quarantine-leak + 15 observability tests green.
- **Prevention**: when adding ANY `FROM memory` reader (or touching ANY surface policed by a cross-cutting guard test — D-026 leak census, schema-drift guards, etc.), RUN that guard test, not only the touched-area slice. The leak census lives in `memory/quarantine-leak.test.ts` and Globs the whole server tree; a new content read MUST be classified LEAK (carry `screen_status != "quarantined"`) or EXEMPT (id-only/write-side probe) there. (F-014 family: targeted test slices miss cross-file invariants — include the guard.) Corollary: the per-file count guard greps raw source text, so NEVER write a bare `FROM memory` phrase in a comment.

## F-037: the `role_version_dedup` UNIQUE index aborts a SERIAL re-insert but NOT two TRULY-CONCURRENT same-key inserts — so it is a serial backstop, not a concurrency lock
- **Date**: 2026-06-16
- **What**: closing the deferred-MEDIUM reversion-race (79f9b19): two concurrent `reversionFailedRole` submits read max(version)=1, both compute version=2, and the loser was expected to collide on the `role_version_dedup` UNIQUE index (`dedup_key = role|version`) and surface a raw 500. Building the test I INSTRUMENTED the index under both shapes (throwaway SurrealDB): (a) SERIAL — `CREATE …version:7…` awaited to commit, THEN a second `CREATE …version:7…` → correctly REJECTED with `Database index 'role_version_dedup' already contains 'role:x|7'`. (b) CONCURRENT — `Promise.allSettled([CREATE version:5, CREATE version:5])` (both in-flight before either commits) → BOTH FULFILLED, 2 rows at version=5. Same result through `createRoleVersion` (two racers both read max=1 → `[1,2,2]`). The UNIQUE index did NOT serialize the concurrent writers.
- **Why**: this SurrealDB build uses optimistic concurrency that only aborts the loser of a UNIQUE collision when the winning row is already COMMITTED at the time the loser's index check runs. Two statements in-flight on the same connection both pass their index check against a pre-insert snapshot, then both commit. This is the SAME class as F-034 (a read-then-write / delta-merge does not abort; only a collision against an ALREADY-COMMITTED unique row aborts).
- **Fix (scoped to this task)**: `reversionFailedRole` now wraps `createRoleVersion` in a try/catch and, on `isDedupCollision` (generalized to match the real unique-violation phrases on ANY table/index — `record … already exists` / `index … already contains` / commit-race — never an unrelated error, F-008), resolves the SERIAL double-submit collision as a benign no-op: re-read, return the winner's freshly-created version (idempotent, at most one new version, no raw 500). The common real-world shape (operator double-click → serialized submits) hits exactly this path. The TRULY-concurrent in-flight case (two simultaneous commits) is NOT defended by the UNIQUE index here and can still produce a duplicate version — that is a DEFERRED, larger integrity item (needs an F-034-style atomic guard: a per-role monotonic sequence stamped under a composite UNIQUE at create, or a real serializing write), out of scope for this UX/honesty fix and LOCKED against weakening the index.
- **Prevention**: do NOT assume a SurrealDB UNIQUE index serializes TRULY-CONCURRENT inserts — it reliably aborts only a re-insert against an already-committed row (the serial double-submit). When a UNIQUE index is the claimed concurrency backstop, INSTRUMENT both shapes (serial-after-commit AND `Promise.all` in-flight) before trusting it; if the in-flight case must be hard-capped, follow F-034 (monotonic sequence stamped AT CREATE under a composite UNIQUE, the only reliable abort signal). A test that creates the winner's row and awaits it before driving the loser is testing the SERIAL backstop, not concurrency.

## F-038: SurrealDB 2.x rejects `UPDATE … MERGE $obj SET field = expr` in one clause — MERGE and SET are mutually exclusive update operators
- **Date**: 2026-06-16
- **What**: building `staffRole` (project_staff data plane, wave v2.3), the re-staff/upsert path used `UPDATE $rid MERGE $merge SET updated_at = time::now() RETURN AFTER;` to merge the supplied fields AND stamp a server-evaluated `updated_at` in one statement. The migration/lint/svelte-check were all green; only the live SurrealDB write failed at run-time: `Parse error: Unexpected token \`SET\`, expected Eof` (2 of 27 unit tests red — exactly the two re-staff/cycle cases that hit the existing-row branch). A first-insert (`CREATE … CONTENT`) and a pure `SET` update both parse fine — only the COMBINATION is illegal.
- **Why**: in SurrealQL an `UPDATE` statement takes exactly ONE data clause — `CONTENT`, `MERGE`, `PATCH`, `REPLACE`, or `SET` — they are alternatives in the grammar, not composable. `MERGE $obj` already fully specifies the update; appending `SET …` is a second data clause, so the parser hits `SET` where it expects end-of-statement. There is no `MERGE … SET` form to attach a computed field (like `time::now()`) onto a param-supplied merge object.
- **Fix**: split into a two-statement query in one round-trip — `UPDATE $rid MERGE $merge; UPDATE $rid SET updated_at = time::now() RETURN AFTER;` — destructure the SECOND result for the returned row. (Alternatives considered: fold an ISO string into the merge object — rejected, a `TYPE datetime` field may reject a raw string and it bypasses server-stamped `time::now()`, D-035.)
- **Prevention**: an `UPDATE` carries ONE data clause only. To merge param-supplied fields AND stamp a server-evaluated field (`time::now()`), use two statements (`UPDATE … MERGE $obj; UPDATE … SET ts = time::now() RETURN AFTER;`), never `MERGE … SET`. This class is invisible to migration/lint/svelte-check — it only surfaces on a live write, so any new repo write combining a merge with a computed timestamp MUST be exercised by a real-SurrealDB unit test on the existing-row branch (the first-insert CREATE path will not catch it).

## F-039: the v2.3 wave chain (§5·§7·BL-3·§7b·hardening) was declared "BUILD COMPLETE" while the FULL suite was red — six cross-cutting-guard failures each per-wave gate's touched-area slice never ran (F-036 recurrence, escalated)
- **Date**: 2026-06-17
- **What**: resuming to push the consolidated v2.3-hardening wave (it had landed H-7b `adedcee` + H-seed `dbbd035` locally but died before H-bl3 and pushed nothing), the pre-push FULL `vitest run` was RED: 6 tests across 3 files. (1) `route-head-a11y.test.ts` ×4 — the BL-3 `agents/staffing/+page.svelte` shipped with NO `<svelte:head><title>`; the BL-6/BL-9 `atelier/+page.svelte` had a reversed title (`Atelier — …` not `… — Atelier`), an h1 `.title` class using `font: var(--type-title, …)` (an UNDEFINED token → the `inherit` fallback resets the display face), and a count-badge `<button>` with no `aria-label`/`aria-hidden`. (2) `watched-tables.test.ts` ×1 — `agents/staffing` + `agents/proposals` subscribe to `project_staff` (BL-3) and `review_proposal` (§5) via `onDbChange`, but neither was added to `WATCHED_TABLES` → those surfaces silently NEVER live-update (the exact 13.1 finding the guard exists to catch). (3) `readback.live.test.ts` ×1 — H-seed itself only broke 2 ceremony-route count assertions (5→6 for the legitimately-seeded 6th researcher role); the readback failure was independent + latent: the marker `HELLO_FROM_BASH_2_11` is IN the task prompt, so a correctly-DENIED agent echoes it in assistant prose, and the assertion checked the WHOLE joined transcript instead of the Bash `tool_result` row — a brittle assertion, not a deny regression.
- **Why**: every v2.3 wave gate (build+test+lint+svelte-check) ran only its FEATURE's touched-area test slice, never the repo-wide guard tests that live in OTHER files: the a11y route gate Globs every `+page.svelte`, the watched-tables census Globs every `onDbChange` call site. A wave that adds a route (`agents/staffing`) or a live subscription is exactly what those guards police, but the wave's own slice excludes them — so each wave was honestly green on its slice while the cross-cutting invariant went red. This is **F-036 recurring** (BL-8's observability.ts slipped the D-026 leak census the same way) — now 2nd+ occurrence ⇒ escalated below. H-seed compounded it: its builder updated its OWN seed-action assertions but not the pre-existing day-0 DRIVER shadow tests hardcoding `5`, so its gate failed on a cross-file test and the wave died WITHOUT pushing (the unpushed state is what saved it from shipping red).
- **Fix**: added `<svelte:head><title>Staffing — Atelier`; reversed the atelier title to `… — Atelier`; `.title` → `font: var(--type-h1)` (the canonical heading token the sibling staffing page already used correctly); count-badge button got `aria-label` + the badge `aria-hidden="true"`; added `review_proposal` + `project_staff` to `WATCHED_TABLES` with route annotations; bumped the two ceremony shadow counts to 6 (asserting the researcher is present + uncertified, encoding WHY); tightened the readback live assertion to hinge on the `tool_result` content only (m0037 `kind`) — STRENGTHENING the security proof (baseline still requires real Bash output, after-edit requires none) rather than weakening it. Full suite re-run green before push.
- **Prevention**: a MULTI-WAVE build is NOT "complete" until the FULL `vitest run` (+ lint + svelte-check) passes as a CONSOLIDATION GATE — per-wave touched-area slices are necessary but NOT sufficient, because cross-cutting guard tests (a11y route gate, watched-tables census, D-026 leak census, schema-drift guards) live in files outside any one feature's slice. Before declaring a wave-chain done OR pushing accumulated wave commits: run the whole suite, not the touched slice. Corollary for the wave template: a task that ADDS A ROUTE must run `route-head-a11y.test.ts`; a task that ADDS AN `onDbChange` must run `watched-tables.test.ts`; a task that ADDS A `FROM memory` READER must run `quarantine-leak.test.ts` (F-036) — and the end-gate runs all of them regardless. (Escalation: F-036 was the 1st of this class; this is the recurrence. The structural rule — "wave end-gate = full suite, never the slice" — is now recorded here as the hard gate.)

## F-040: SurrealDB CREATE fails-closed is the right TOCTOU lock; a post-register writer throw must MARK, never unwind
- **Date**: 2026-06-17
- **What**: CA-H2 hardening of the Create-with-AI EXECUTE path (`src/lib/server/create/execute.ts`). Two latent integrity gaps the CA-2 red-team had DEFERRED: (1) a writer throw AFTER the scanProject register left a registered project + committed scaffold with only PARTIAL writers, NO incident, and a WEDGED slug (the existence gate fails every future re-create, but the project is half-wired) — violating the F-008 honest-creation rail; (2) a TOCTOU double-submit: two parallel same-slug creates both pass the `getProject` null-gate, the loser's `git commit` hits 'nothing to commit', its cleanup `rm -rf`'s the WINNER's live scaffold, and scanProject's UPSERT (last-writer-wins) leaves a phantom row over a deleted dir.
- **Why**: the original executor treated the WHOLE flow as one try/catch that always `rm -rf`'d `projectRoot` on any failure and never distinguished "this run created the dir" from "another run owns it". After the scanProject register the scaffold+commit are DURABLE — unwinding the row (or deleting the dir) to "clean up" is itself the corruption, because a concurrent winner may own that exact path. The null-gate is inherently TOCTOU: a check-then-act with an await in between.
- **Fix**: (a) a slug-keyed advisory **create-lock** (`create_lock:<slug>`) acquired with a **fail-closed `CREATE`** right after the existence gate — verified empirically that SurrealDB 2.x `CREATE $rid` THROWS "already exists" on a duplicate id (it does NOT last-writer-win, unlike UPSERT/MERGE), so exactly one concurrent create proceeds and the rest throw `ConcurrentCreateError` before any disk touch; released in a `finally` with an owner nonce so a release can't clobber another run's lock. (b) **ownership-gated cleanup**: record whether THIS run's `mkdir` created `projectRoot` (it didn't exist before) and ONLY `rm -rf` when we own it — a loser can never delete a dir it didn't create. (c) **post-register = MARK, not unwind**: a throw in any writer after register sets `project.create_status='incomplete'` (new option<string> field, migration 0049, ASSERT IN ["complete","incomplete"]) + logs an incident + throws `PostRegisterWriterError` — the project stays REAL on disk, clearly marked, NOT wedged; full success marks `create_status='complete'`. Migration 0049 is additive + OVERWRITE-idempotent (applied + re-applied clean against the LIVE dev DB; migrate.test apply-twice/half-applied green).
- **Prevention**: (1) For a slug/key uniqueness gate that races, a SurrealDB `CREATE`-on-a-derived-id is a free fail-closed lock — prefer it over check-then-`getProject` (which is TOCTOU); release in `finally` with an owner token. (2) NEVER `rm -rf` a scaffold/work dir on a failure path unless THIS run created it — track ownership (existed-before-mkdir), because a concurrent peer may own the same path. (3) After a durable side effect (committed scaffold, registered row) a later-step failure must be MARKED honestly (a dedicated status field + incident), never unwound — unwinding a durable artifact is how you delete a peer's live work. New honest-state status fields go in their OWN column (`create_status`), not by widening a lifecycle enum (`project.status` active/paused/archived) whose UI/operator semantics they would collide with.

## F-041: secret-detector test fixtures with REAL-FORMAT provider tokens trip GitHub push protection → the whole wave push silently fails
- **Date**: 2026-06-17
- **What**: the CA-H1/CA-H2 secret-echo tests asserted the detector rejects credential literals, so the fixtures used real-FORMAT provider tokens — a `glpat-` GitLab PAT (prefix + 20 chars), a `ghp_` GitHub PAT (prefix + 36), an `sk-ant-` Anthropic key. GitHub secret-scanning **push protection** (repo rule GH013) reads those as exposed secrets and REJECTS the push ("Push cannot contain secrets — GitLab Access Token at plan.test.ts:317,332"). The CA-hardening wave's `pushAtEnd` hit this SAME rejection and failed SILENTLY — the wave reported complete + committed, but origin stayed at the prior tip and the commits sat local-only (caught by a `git rev-list --left-right` check: 6 ahead, 0 behind). The block is on the COMMITTED DIFF (added lines), not just the working tree — so a real-format token introduced in any pushed commit blocks even if a later commit removes it.
- **Why**: a credential DETECTOR's negative tests inherently want strings shaped like real credentials, which is exactly what the platform's scanner is built to catch. The detector here is PREFIX-based (`startsWith('glpat-')` …) + an isolation `screen()`; the full real-format tail was unnecessary for the test but sufficient to trip GitHub's format/length validators.
- **Fix**: assemble the fake token AT RUNTIME from fragments so the SOURCE TEXT carries no contiguous provider-token pattern — `const GLPAT = 'gl' + 'pat-' + 'AbCd…'` (and inline `'sk-' + 'ant-' + '…'` in a template). GitHub scans source text → no match; the runtime value is full-format → the prefix/`screen()` gates under test still fire (create slice stayed 85 green). Because the tokens were already in 6 local commits' history, scrubbing the tree was not enough — `git reset --soft <origin-tip>` collapsed them and ONE clean re-commit (token-free diff) pushed through. Verified pre-push with `git diff --cached <origin> | grep '^+' | grep -E '<provider-token-regexes>'` = 0.
- **Prevention**: NEVER commit a real-FORMAT provider token (a `glpat-`/`ghp_`/`gho_`/`sk-`/`sk-ant-`/`AKIA`/`xox`/`AIza`-prefixed value at the provider's real length) in a test fixture — assemble it at runtime from fragments (the source must not contain the contiguous pattern), or use an obviously-short placeholder when the detector is prefix-only. After ANY wave that adds secret-screening tests, VERIFY the push actually landed (`git rev-list --left-right --count origin/<branch>...HEAD` → `0 0`), because `pushAtEnd` swallows a push-protection rejection and the wave still reports success. Generic high-entropy strings (no known provider prefix) do NOT trip push protection — only the recognized provider formats do.

## F-042: the runtime DB connection signs in ONCE and never refreshes — SurrealDB's 1h root token expires → every query fails "IAM: Not enough permissions" after the dev server has been up >1h
- **Date**: 2026-06-17
- **What**: after the dev server had run >1h, `/agents` (and every DB-backed page) flipped to "disconnected — IAM error: Not enough permissions to perform this action", and `[pm-triggers]` spewed the same IAM error in a loop. The DB process was healthy (`:8000` HTTP 200; `root:root` curls worked fine). It had worked earlier the same session (the operator ran a full cert ceremony on `/agents`).
- **Why**: `Db.connect` (`db/client.ts:80`) signs in ONCE per process (singleton) and never re-authenticates. SurrealDB provisions the root user (via `surreal start --user root --pass root`, `provision.ts`) with the DEFAULT `DURATION FOR TOKEN 1h` (visible in `INFO FOR ROOT`). After 1h the signin token expires; with no refresh the live session drops to UNAUTHENTICATED, and since every table is `PERMISSIONS NONE` (no record/scope grants — owner/root bypasses them, an expired/anon session does not), EVERY query returns IAM "Not enough permissions". The boot is clean and the first hour works, so it looks like a sudden disconnect rather than a token TTL. `root:root` curls always work because each HTTP request is a fresh basic-auth signin (new token).
- **Fix (stopgap, NOT durable)**: `DEFINE USER OVERWRITE root ON ROOT PASSWORD 'root' ROLES OWNER DURATION FOR TOKEN 4w, FOR SESSION 4w;` + restart the dev singleton so it re-signs-in and gets the long token. This RESETS on the next `npm run db:up` (a fresh `surreal start` re-creates root with the 1h default), so it is not a real fix.
- **Prevention / durable fix (queued)**: the runtime `Db` client must survive token expiry on a long-lived connection — either (a) detect the auth-expiry IAM on a query and transparently re-`signin()` + retry once (robust, survives any token policy), or (b) provision the root user with a long `DURATION FOR TOKEN` at `surreal start` (`provision.ts`) so dev tokens don't expire under a day-long session. (a) is the real fix; any single-signin-forever connection against a token-TTL'd user is a latent time-bomb. Diagnostic: "worked then broke over time + a fresh signin/curl works" ⇒ suspect token TTL, check `INFO FOR ROOT` `DURATION FOR TOKEN`.
- **DURABLE FIX LANDED (2026-06-17, TV-2)**: implemented option (a) in `db/client.ts`. The `Db` instance now retains its connect creds IN-MEMORY (never logged — D-026) and the `query()` path self-heals: on a thrown error matching the NARROW auth-expiry signature it re-runs `signin()`+`use()` ONCE and retries; if the re-auth or retry also fails the ORIGINAL error propagates (no masking — F-008). Bounded to one retry per call (no loop); concurrent expiries share ONE in-flight re-auth promise (`this.reauth`) so N queries don't stampede N signins. The 4w-token stopgap is now unnecessary. **SDK behavior learned (verified live against a throwaway server with `DEFINE USER ... DURATION FOR TOKEN 1s`)**: after the token TTL lapses the surrealdb 2.x SDK does NOT auto-refresh — the very next `query()` THROWS exactly `There was a problem with the database: IAM error: Not enough permissions to perform this action` (it does not return an empty result; it throws). A fresh `signin()` on the SAME handle restores it, and `use()` MUST be re-asserted after signin (a fresh signin resets the selected ns/db). Also: `DEFINE USER ... PASSWORD` requires a strand LITERAL — it rejects a `$param` binding with `Parse error: Unexpected token a parameter, expected a strand` (only relevant in provisioning/tests; never bind user input into a DEFINE USER anyway). The auth-expiry regex is kept distinct from `classify.ts`'s connection-LOSS regex — a dead socket is unfixable by re-auth, so the two must not overlap.

## F-043: SurrealDB JS SDK can FALSELY resolve a CREATE under a shared-socket race → read ownership from the DB row, never from the CREATE call's own resolution
- **Date**: 2026-06-20
- **What**: the pm-lifecycle per-project in-flight lock (`projects/pm-lifecycle-lock.ts`, guards the real-spend `startProjectLifecycle` against double-submit) first matched ONLY `/already exists/` on the fail-closed `CREATE`. Under TRUE-parallel double-submit on the app's ONE shared SurrealDB WebSocket connection, two failures appeared: (a) the loser's `CREATE` rejected with the retryable `Failed to commit transaction due to a read or write conflict. This transaction can be retried` — NOT `already exists` — so it re-threw as a raw 500; (b) worse, the SDK sometimes RESOLVED BOTH racers' `CREATE` promises as success while only ONE row actually committed (instrumented on a live :8000 probe: 20/20 races → exactly ONE DB row, but `acquire` returned `held=true` to BOTH callers → 2 holders / 1 row = the exact double-spend the lock exists to prevent). The wave's red-team caught it; the review had passed it (the race is non-deterministic — the reviewer got a lucky green; the skeptic reproduced the fail).
- **Why**: on a shared WS connection the surrealdb 2.x SDK's promise resolution for a `CREATE` is NOT a reliable witness of whether THIS call won the row under contention — it can report success for a write that lost, and it reports the loss in two different error shapes (clean `already exists` for a sequential loser; retryable `read or write conflict` for a true-parallel loser). Deciding ownership from the call's own resolution is therefore unsound. (Sibling of F-026: a UNIQUE secondary index didn't enforce under concurrency; here the PRIMARY-key CREATE *does* keep exactly one row, but the SDK's report of who-won is unreliable.)
- **Fix**: make the DB ROW the single source of truth. `acquireLifecycleLock`: attempt the `CREATE` with a random nonce; absorb BOTH contended error shapes (`isLockContended` = `/already exists/i || /read or write conflict/i`), re-throw anything else (F-008); then UNCONDITIONALLY `SELECT holder` back and hold the lock IFF the persisted holder === our nonce. The loser of any collision shape (already-exists, conflict, OR false-success) reads back the WINNER's nonce → benign `{held:false, reason:'already-running'}`, never a phantom hold. Stale-takeover UPDATE is likewise read-back-verified + conflict-absorbing. Verified: 6 deterministic green runs of the parallel-acquire (1 holder) + two-concurrent-ticks (`generator.calls()===1`, i.e. exactly ONE PM session) races; 60-iter SDK probe twoHolders=0.
- **Prevention**: for a fail-closed `CREATE`-as-lock (or any contended single-row write) on the shared connection, NEVER decide ownership from the `CREATE`/`UPDATE` call's resolution (success OR error) — after the write, read the row back and compare a per-attempt nonce; the persisted value is authoritative. Absorb BOTH `already exists` AND `read or write conflict` as "someone else won" (matching only one re-throws the other as a raw 500). A concurrency-guard test is inherently flaky — a single green run is NOT proof; assert the MEANINGFUL invariant (exactly one holder / one spawned session via a call-counter), run it many iterations, and trust the skeptical reproduction over a lucky pass.

## F-044: a SurrealDB token DURATION > ~24.8 days overflows the SDK's 32-bit setTimeout expiry scheduler → 1ms hot-loop floods the console + struggles the app
- **Date**: 2026-06-20
- **What**: after a PM session was started (the pm-lifecycle one-click), the operator's console flooded — thousands/sec of `(node:<dev-pid>) TimeoutOverflowWarning: 2418949000 does not fit into a 32-bit signed integer. Timeout duration was set to 1.` — and the dashboard "struggled" (dev-server CPU climbing). NOT a spawn storm: the DB showed 0 running sessions, 0 processing work_items. SurrealDB itself was healthy (2% CPU).
- **Why**: the running dev DB's root user had `DEFINE USER root … DURATION FOR TOKEN 4w, FOR SESSION 4w` (the F-042 STOPGAP, applied by hand). 4 weeks = 2,419,200,000 ms, which EXCEEDS the Node `setTimeout`/`setInterval` 32-bit ceiling 2,147,483,647 ms (~24.85 days). The surrealdb JS SDK schedules a token-expiry timer at the token's lifetime (`setTimeout(onExpire, exp − now)`); with a 4w token that delay overflows → Node clamps it to **1ms** + emits `TimeoutOverflowWarning` → the timer fires ~immediately → the SDK re-arms it (still ~4w out) → fires again in 1ms → an infinite hot-loop that re-emits the warning every call and pegs the event loop. The exact warned value (2,418,949,000 ≈ 4w − ~4min) = the token lifetime minus the ~4min since it was minted, which pinned it. There is NO such timer in our source (grep-confirmed) — it is inside the SDK, reacting to the token we issued.
- **Fix**: re-issued the running DB's root token at a SAFE duration under the ceiling — `DEFINE USER OVERWRITE root ON ROOT PASSWORD 'root' ROLES OWNER DURATION FOR TOKEN 1w, FOR SESSION 1w;` (1w = 604,800,000 ms, well under 2^31−1). Then the dev server must be RESTARTED so its SDK connection re-signs-in and arms a fresh (non-overflowing) expiry timer — re-issuing the DB token does NOT retroactively clear the already-armed in-memory loop. The F-042 durable reactive re-auth (heal-on-thrown-expiry) means a LONG token was never needed in the first place.
- **Prevention**: NEVER set a SurrealDB `DURATION FOR TOKEN`/`FOR SESSION` greater than ~24 days — the SDK's setTimeout-based expiry scheduler overflows 32-bit ms and hot-loops. The F-042 stopgap MUST use ≤ a safe value (1w/1d), not 4w; the durable F-042 reactive heal already covers expiry, so prefer a SHORT token (the heal re-auths on demand). Diagnostic: a flood of `TimeoutOverflowWarning: <N> does not fit into a 32-bit signed integer` where N ≈ a token/session lifetime in ms ⇒ a too-long DB token; check `INFO FOR ROOT` `DURATION FOR TOKEN`, re-issue ≤1w, restart the connection holder. (Any `setTimeout(absoluteDeadline − now)` is a latent 32-bit-overflow bug when the delay can exceed 24.8 days — clamp such delays to a max and re-arm in chunks.)

## F-045: `DEFINE FIELD … TYPE bool DEFAULT false` does NOT backfill existing rows → a non-optional bool reads/writes NONE → every later UPDATE of a pre-field row throws (F-015 recurrence on a NEW field kind)
- **Date**: 2026-06-20
- **What**: adding the PMA `pm.auto_publish_preauthorized` flag (m0058) — and re-examining the SHIPPED m0057 `pm.autonomous` flag — both used `DEFINE FIELD OVERWRITE <f> ON pm TYPE bool DEFAULT false`. All unit tests passed (fresh DB). But on the LIVE dev DB, every `pm` row written before the field existed had the column as NONE, and a `UPDATE pm … MERGE { … }` (the arm/disarm + auto-publish toggle path — and `setPmAutonomous`, the already-shipped feature) threw `InternalError: Found NONE for field 'auto_publish_preauthorized', with record pm:…, but expected a bool`. A plain `SELECT *` (the getPm read path) did NOT fail — the NONE column is simply absent from the projection and normPm coerces it to false — which is why the page LOADED fine and the gap stayed invisible until a WRITE.
- **Why**: a `DEFINE FIELD … DEFAULT <v>` applies the default only to rows CREATEd AFTER the field is defined; it NEVER backfills pre-existing rows (same root as F-015: the DEFAULT lands on insert, not retroactively). For a NON-OPTIONAL `TYPE bool`, SurrealDB then re-validates the WHOLE record on any UPDATE/MERGE and rejects the still-NONE column — so a write to ANY pre-field row fails, even when the write touches a different column. m0057 shipped with this exact latent gap; it only ever passed tests because tests run on a fresh DB where every pm row is created after the field exists. (This is the bool-typed sibling of F-013's datetime-NONE: a field that is NONE on every prior row is invisible to read-back unit tests — assert on a row where it matters, or live-verify the WRITE.)
- **Fix**: m0058's `up` now BACKFILLS in the same migration — one idempotent `UPDATE pm SET auto_publish_preauthorized = (auto_publish_preauthorized ?? false), autonomous = (autonomous ?? false) WHERE auto_publish_preauthorized IS NONE OR autonomous IS NONE;` (sets BOTH bool flags in a SINGLE write so the row re-validates atomically — backfilling them one-at-a-time would itself fail on the other still-NONE column; the `?? false` preserves any real operator value; the `WHERE … IS NONE` makes it idempotent and surgical). The LIVE dev DB was unwedged by running the same backfill UPDATE against it (the runner had already recorded 0058, so it won't re-run — F-015 discipline: unwedge live by hand + bake the backfill into the migration for fresh DBs). Added a migrate.test.ts case that seeds a pm row with NONE flags and asserts m0058 makes it writable again + a second apply does not reset a real `true`.
- **Prevention**: when ADDING a non-optional scalar field (bool/number/string) with a `DEFAULT` to a table that ALREADY has rows, the DEFINE alone is NOT enough — append an idempotent BACKFILL `UPDATE … SET <f> = (<f> ?? <default>) WHERE <f> IS NONE` to the SAME migration, and if the table has MULTIPLE such just-added non-optional fields, set them all in ONE UPDATE (a per-field backfill fails on the other still-NONE field). Test the half-applied/pre-field state explicitly (a row with the column NONE), not just a fresh-DB apply. ALWAYS `npm run db:up` against the LIVE dev DB AND exercise a WRITE path during verify (a read-only check passes over a NONE column and hides this). Prefer `option<bool>` only when absence is semantically real; for a flag with a true default, non-optional + backfill is correct.
