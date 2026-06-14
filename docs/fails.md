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
