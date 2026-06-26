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

## F-020: seeding SCHEMAFULL tables in tests trips three SurrealDB write-path gotchas
- **Date**: 2026-06-19
- **What**: the MS-2 scene-aggregator test (`scene/scene.test.ts`) failed three times on row SEEDING (not the aggregator under test): (1) `ORDER BY importance` on a SELECT that didn't also SELECT `importance` → "Parse error: Missing order idiom"; (2) `CREATE memory:x SET content=…, kind=…` WITHOUT `namespace` → "Cannot perform addition with 'NONE' and '|'" because the `dedup_key VALUE (namespace + '|' + …)` field computed before the schema DEFAULT for `namespace` landed; (3) `embedding=[]` → "Incorrect vector dimension (0). Expected a vector of 1024" from the HNSW index on `memory.embedding`.
- **Why**: SurrealDB 2.x computes VALUE fields against the row as-SET — a column relying on a schema DEFAULT is NONE at VALUE-compute time unless you SET it explicitly; the FTS/HNSW index rejects an off-dimension vector at write; and ORDER BY requires the idiom to appear in the projection.
- **Fix**: SELECT every ORDER BY field; SET `namespace="default"` on memory seeds (or use the store helper / CONTENT with a full object); seed `embedding=array::repeat(0.0, 1024)`. All test-side; the aggregator itself was correct.
- **Prevention**: when hand-seeding a SCHEMAFULL table in a test, SET every column a `VALUE`/dedup_key formula references (don't rely on DEFAULT landing first — `namespace`/`status` on memory, `work_type` on work_item); give `memory.embedding` a 1024-dim vector (`array::repeat(0.0, 1024)`), never `[]`; ensure any `ORDER BY <field>` is also in the SELECT list. Prefer the production store/CONTENT path over bare `SET` where practical — it sets the full object and sidesteps all three.

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
- **Sibling (2026-06-13):** adding the deferral-ledger enhancement, I wrote an UNESCAPED backtick (`` `followUps` ``) inside REVIEW_PRE — itself a backtick-delimited template literal — which closed the literal early → load-time `SyntaxError: Unexpected identifier 'followUps'`. The SAME F-016 host-load regression test caught it before any wave ran (it earns its keep). Different trigger (template-literal escaping, not `export`), same class: a load-time syntax break that the build's surface checks miss. **Prevention**: inside the prompt template literals (BUILD_PRE/REVIEW_PRE/COMMON), any literal backtick MUST be escaped `\`…\`` (the `npm run lint` refs already do this) or use plain quotes; ALWAYS run `node --test .claude/workflows/v2-wave.test.mjs` after ANY template edit — the host-load regression is the gate.

## F-045: orchestration.yaml declared code-write capabilities absent from the live catalog → EVERY code-write spawn fail-closed (D-036)
- **Date**: 2026-06-22
- **What**: operator hit the project command-center **Continue** to drive ROUNDS' 6 ready tasks; every spawn died with `unknown skill capability id "svelte5-patterns" — not in the cc-config catalog (fail closed, D-036)` (Restart-looped). No code-write session could launch.
- **Why**: `config/orchestration.yaml` `bundles.code-write.capabilities.skills` declared `[svelte5-patterns, error-learning]`. The runtime `composeCapabilities` validates each declared id against the LIVE cc-config catalog (`catalogIds` = union of `cc_skill`/`cc_agent`/`cc_mcp_server` names across SYNCED scopes) and throws fail-closed on any unknown id. The live catalog was EMPTY: `cc_scope` had zero rows (nothing ever synced), and the only sync path (`reconcileScopes` on the `/claude-code` loader) syncs PROJECT-root `.claude` dirs (+ ~/.claude). The two skills live SOLELY in the platform repo's own `.claude` (`F:\code\ai-playground\.claude\skills\`, the v2-main checkout) — which is neither a registered project root nor `~/.claude` (verified: `~/.claude/skills` has gsd-*/design, NOT these two) — and the live app runs from the worktree `F:\code\ai-playground-v2`, which has NO `.claude` dir at all. So the declared ids could never enter the catalog through any current sync path. D-036 worked exactly as designed; the config was written ahead of the catalog reality (the block's own comment said "Edit to match the live catalog"). `svelte5-patterns` is also project-irrelevant for a C#/BepInEx mod build.
- **Fix**: removed the `capabilities` block from `code-write` (capabilities is optional — `load.ts:145/951`; absent → runtime composes `EMPTY_SET`, no throw). Left an explanatory comment to re-add ids ONLY after they appear in a synced catalog scope. `config/load.test.ts` 114/114 green (tests use a fixture + inline literals; the only real-config assertion checks `dailySpawnCap`, not capabilities). NOTE: orchestration.yaml is read at boot — the live dev server must RESTART (token unset, F-029) to pick up the change.
- **Prevention**: NEVER declare a `bundles.<intent>.capabilities` id that is not present in the LIVE cc-config catalog — the config boundary only shape-checks; the id allow-list is enforced fail-closed at spawn time, so an un-catalogued id silently passes config validation then breaks EVERY spawn of that intent. Before adding a capability id: confirm a SYNCED `.claude` scope (a registered project root or `~/.claude`) carries it (`SELECT name FROM cc_skill` on the live DB), not just that a SKILL.md exists somewhere on disk. A skill in the platform repo's own `.claude` is NOT catalogued unless that repo is a registered scope.

## F-046: isolated CLAUDE_CONFIG_DIR keyed by agent SLOT, not session → concurrent same-slot sessions corrupt .claude.json
- **Date**: 2026-06-22
- **What**: operator hit Continue → 6 ROUNDS code-write sessions spawned; 1 succeeded, 5 failed. Two died with `Claude configuration file at .harness\claude-config\sonnet-1\.claude.json is corrupted: JSON Parse error: Unexpected EOF`; 3 more exited 1 mid-stream, all reaped in a 0.16s window (collateral). Every parallel spawn beyond the first was unreliable.
- **Why**: `runtime/index.ts` `isolatedConfigFor` built the isolated dir as `${harnessConfigRoot}/${safeSegment(req.agentId)}` — keyed by the AGENT SLOT id (e.g. `sonnet-1`), not the session. The Claude CLI writes `.claude.json` (state + `hasTrustDialogHooksAccepted`, also merged by `seedHookTrust`, cli-backend.ts) into that dir at startup. `config/agent-pool.yaml` has ONE slot per tier (`opus-1`/`sonnet-1`/`haiku-1`/`local-1`) while `concurrency.maxAgents=8`, so any two concurrent same-tier tasks shared one slot's dir and raced the `.claude.json` write → truncated/half-written JSON → parse-EOF → exit 1. The `IsolatedConfig.configDir` docstring already PROMISED "Dedicated … for THIS session" — the per-session intent was documented; the code keyed by slot. (Slots are not exclusively allocated — "spawned per-task, no idle pool"; `agent_slot.busy` is non-authoritative — so nothing serialized same-slot use.)
- **Fix**: key the dir by `req.sessionId ?? req.agentId` (session ids are unique per spawn; legacy/no-sessionId spawns fall back to the slot id, byte-identical). Resume reuses the SAME session id (channel.ts threads `req.sessionId` into `runtime.resume → plan → isolatedConfigFor`), so the CLI's transcript reuse (keyed by configDir+cwd) still works. Also set `concurrency.perProject: 1` as a stopgap for the SECOND shared space — all of a project's sessions run in the SAME cwd (`project.root_path`, launch.ts), so >1 concurrent writer in one repo = file/git stomping (F-007 class) until per-session git-worktree isolation lands. Verified: runtime/cli-backend/config tests 142/142; svelte-check 0/0 (905 files).
- **Prevention**: any per-session isolated filesystem resource (config dir, scratch dir, lockfile, transcript dir) MUST be keyed by a SESSION-unique id, NEVER by a shared pool/slot id — a slot is a reusable, possibly-concurrent identity. When the CLI/tool writes state into the dir, two concurrent holders WILL corrupt it. Separately: concurrent agents sharing one working tree need real isolation (git worktree per session) or serialization (perProject=1); don't assume gates/editScope prevent file-level races — they gate tool *permission*, not concurrent-write ordering.
> SUPERSEDE-PROPOSED (2026-06-24): the `concurrency.perProject: 1` stopgap (the SECOND shared space in the Fix above — same-cwd file/git stomping) is now superseded by per-session git-worktree isolation. WI-1 `acquireSessionWorktree` (25c7b03) gives each WRITE session its OWN worktree on the session branch; WI-2 (ef044a2) wires that worktree in as the spawn cwd; WI-3 (5af6db1) does FF-or-preserve merge-back + teardown, composed AFTER the heartbeat post-task commit (HB-1) — so concurrent same-project writers no longer share a cwd, and integration into the project branch is serialized (non-FF falls back to preserving the session branch, never clobbers). Together with the per-project in-flight gate (a3db470) + its extension to all cwd-spawning work types (285b5ca), this closes the same-repo write race that the perProject=1 stopgap was holding shut. Accordingly `config/orchestration.yaml concurrency.perProject` was raised 1 → 3 (≤ maxAgents=8). The session-keyed config-dir fix (0767948) and the worktree isolation are independent layers — both stay in force. MARK, do not delete (G2: agents propose, operator retires) — the operator retires the perProject=1 rationale.

## F-048: uncaught claim-path dedup collision crashed the dev server mid-go-live
- **Date**: 2026-06-25
- **What**: at go-live the orchestrator drove ROUNDS (heartbeat worked — sessions spawned + worktrees merged back), then the dev server CRASHED with an UNCAUGHT `InternalError: Database index 'work_item_dedup' already contains 'memory_review|session:X|session:X|processing'` from the claim path (workqueue.ts claimNext).
- **Why**: `dedup_key` is a computed VALUE keyed on `work_type|session|status` (§4.12). `enqueue` dedups on status='pending' and catches its own UNIQUE violation. But the CLAIM CAS flips status pending→processing, RECOMPUTING dedup_key to `…|processing`. A second memory_review fast-tier fork for the same session enqueues as a fresh 'pending' (different status key → NOT deduped), then on claim its key becomes `…|processing` and collides with the already-processing twin → UNIQUE violation at the claim UPDATE. `claimNext`'s catch only absorbed `/conflict|retry|failed transaction/`, NOT the dedup-collision class → it re-threw → uncaught up the drain → killed the Node process. The SH-2 go-live (production SkillHarvester) + the live fast-tier writer fork made concurrent same-session memory_review items reachable.
- **Fix**: `claimNext` catch now also absorbs `/work_item_dedup|already (contains|exists)/` (mirrors enqueue) → back off + retry instead of re-throw; the redundant pending dup self-heals once its twin terminates (status→done frees the key). Commit `6fb4d3d`.
- **Prevention**: a DB fault on the orchestrator DRAIN path must NEVER crash the server (F-014) — every claim/enqueue/complete query that can hit a UNIQUE/conflict must absorb it as a no-op/retry, never propagate uncaught. When a `dedup_key` VALUE keys on a MUTABLE field (status), a status TRANSITION recomputes the key and can collide at the transition, not just at insert — guard BOTH the insert AND the transition. DEFERRED structural fix: collapse the dedup active-window so {pending,processing} dedup against each other (prevent the second enqueue entirely), rather than absorbing at claim.

## F-049: `headroom-ai` PyPI Windows wheel is NOT self-contained — every compressor + the content detector hard-import the Rust `headroom._core`, absent from the pure-Python wheel
- **Date**: 2026-06-26
- **What**: BL-H2 spike to measure headroom's input-token compression offline. `pip install headroom-ai[proxy]` (newest, 0.27.0) tried to build from sdist via maturin and FAILED (Rust/`link.exe` MSVC-linker error). `--only-binary=:all:` then installed the pure-Python wheel **0.20.15** (`py3-none-any`, no `.pyd`). But that wheel is non-functional offline on Windows: `headroom._core` (Rust) is missing, and `content_router._detect_content` + `SmartCrusher`/`SearchCompressor`/`LogCompressor`/`DiffCompressor` ALL hard-import it with no Python fallback ("Rust extension is a hard dep" per their own docstrings). So `compress()` catches the `ModuleNotFoundError` and returns input unchanged → 0% everywhere. The task premise ("pure-Python, full compressor stack in-process, no Rust build needed") is false for this version on Windows.
- **Why**: PyPI ships headroom-ai as (a) sdist requiring a Rust+MSVC toolchain build, and (b) a `py3-none-any` wheel that omits the compiled `_core` — there is no prebuilt `cp*-win_amd64` binary wheel. The Python reference implementations of the compressors/detector were "retired in Stage 3b/3d" (their comments), so recent pure-Python wheels are shells around an absent native lib. tiktoken `cl100k_base` ALSO needs a network download (blocked offline).
- **Fix**: pivoted to **0.9.7** — the last era where all four structured compressors (SmartCrusher/Search/Log/Diff) still had working pure-Python implementations (verified: run offline with network hard-blocked, no `_core`). Used `litellm.token_counter(model="claude-3-5-sonnet-20241022", ...)` for offline token counts (litellm bundles `anthropic_tokenizer.json`; tiktoken cl100k needs network). Routed each REAL basket item explicitly to its compressor (auto-detection needs `_core`).
- **Prevention**: for any offline Python-lib spike on Windows, FIRST verify the installable wheel is self-contained — `import pkg._core` (or the native submodule) and run one real op with `socket.socket` patched to raise on `connect`, BEFORE building a measurement harness. Don't trust "pure-Python wheel" claims: a `py3-none-any` wheel can still hard-import an absent compiled extension. For offline token counts use `litellm.token_counter` (bundled Anthropic/cl100k data), not `tiktoken.get_encoding` (downloads on first use). If only an old version works, report the version pivot loudly — measured numbers are NOT the shipped (Rust) version's.

## F-050: repo-creation gate hardcodes `git push -u origin main` → fails on a `master`-default local repo ("repo exists but unbacked")
- **Date**: 2026-06-26
- **What**: driving the repoCreate gate for ROUNDS (live, via the project action) CREATED the private repo (`SLO42/BepInExPack_ROUNDS_Port`) but the backing PUSH failed: `git push -u origin main failed (exit 1): error: src refspec main does not match any` → the gate returned `failedAt:'remote'` ("repo exists but unbacked"). consent/token/auth/private/create all green; only the push leg failed.
- **Why**: the local ROUNDS repo (scaffolded by Create-with-AI) was on branch `master`, but the gate's push leg (RC-2) hardcodes the branch name `main`. `src refspec main does not match any` = there is no local `main` to push. The gate assumes the modern default (`main`) and has no fallback to the repo's ACTUAL current branch (`git branch --show-current` / `git symbolic-ref`).
- **Fix**: aligned the local repo to `main` (`git branch -m master main`) + `git push -u origin main`, then re-ran repoCreate — idempotent path reconciled origin, confirmed the backed push, and set `project.repo_url`. Repo now private + backed + recorded.
- **Prevention**: the repo-creation gate's push leg must push the repo's ACTUAL default/current branch (resolve via `git symbolic-ref --short HEAD` or `git branch --show-current`), not a hardcoded `main` — OR normalize the local repo to `main` before pushing and assert it. A `master`-default project (older git, or however Create-with-AI scaffolds) is a real case. Track the gate fix in the BL-0/repo-creation family.
