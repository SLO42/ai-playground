# Atelier (ai-playground v2) — Operating Manual

This repo builds **Atelier**: a studio that takes a project across its whole lifecycle
(create → develop → maintain → release) by driving Claude Code sessions. The dashboard is
the operator's face; the orchestrator/heartbeat is the engine underneath. One SurrealDB 2.x
datastore owns all product state (D-001).

This file is the manual. Read it fully, then work at the level it describes. When it and the
codebase disagree, **the codebase wins — verify, then fix this file.**

---

## 0. Geography (verify against disk; do not assume from memory)

| Thing | Where |
|---|---|
| **Product code** | branch `v2`, worktree `F:\code\ai-playground-v2`. **App is at the repo ROOT** — `src/routes`, `src/lib/server`. There is NO `dashboard/` in v2 (that path is v1). |
| **Docs / this file / workflows** | branch `v2-main`, `F:\code\ai-playground` — `docs/`, `CLAUDE.md`, `.claude/workflows/v2-wave.js`, `docs/devlog/`. |
| **Backend subsystems** | `src/lib/server/<subsystem>/` — verified against disk 2026-07-26 (41): `adapters agent agent-library analytics atelier auth autonomy cannibalize cc-config claude-code concierge config create db events harness home hooks importer loops memory notifications observability orchestrator peer perf projects providers release routing runtime scanner scene services sessions skills sync tasks workflows workforce`. |
| **SurrealDB migrations** | `const mNNNN_name: Migration = {...}` **inside `src/lib/server/db/schema.ts`** → exported `schemaMigrations`. **There is NO migrations directory and NO per-migration files.** Head is **`m0087`** (`m0087_task_tags` — `DEFINE FIELD OVERWRITE tags ON task TYPE option<array<string>>`, TASK-BOARD P2, 2026-08-05; prior `m0086_boot_skip_ledger` AV-4). **Next FREE id: `m0088`.** **PAPER RESERVATIONS ARE VOID — allocate from the LIVE head, never from the number a spec quotes (they have now collided TWICE).** TASK-BOARD-SPEC had reserved `m0088` and MODEL-LADDER-SPEC `m0087`; TASK-BOARD P2 correctly took `m0087` because neither existed in code, so **MODEL-LADDER-SPEC's claim is now VOID and it must re-allocate from the live head when it is built.** The rule beats the reservation: honouring a paper claim leaves a permanent hole for a spec that may never ship. |
| **Migration runner + idempotency toolkit** | `src/lib/server/db/migrate.ts` — `runMigrations`, `isApplied`, `defineFlagField`, `guardedScan`, `backfillValueField`. |
| **DB client** | `src/lib/server/db/client.ts` — `Db`, hard-bounded connect (`DEFAULT_CONNECT_TIMEOUT_MS=5000`). |
| **Table normalizers (`norm*`)** | **per-repo, not in schema.ts** — canonical set in `src/lib/server/projects/repo.ts` (`normProject/normSprint/…`, `isoOrUndef`). |
| **Task lifecycle** | `orchestrator/` — `workqueue.ts` (enqueue/claimNext + dedup), `orchestrator.ts`, `post-task.ts` (commit→test→heartbeat), `boot.ts`, `semaphore.ts`, `reaper.ts`. |
| **Session worktree isolation** | `sessions/worktree.ts` (`acquireSessionWorktree`), `sessions/merge-back.ts` (FF-or-preserve), composed in `sessions/launch.ts`. |
| **Config** | `config/orchestration.yaml` `agent-pool.yaml` `gates.yaml` `workforce.yaml`. |
| **Decisions ledger** | `docs/DECISIONS.md` (D-000..D-040, authoritative). The copy under `ai-playground-v2/docs` is STALE — use the `ai-playground` one. |
| **Failure log** | `docs/fails.md` (F-001..F-056). Scan it before starting; append when a gate fails first-try. |

---

## 1. Build & Verify

Run in the **v2 worktree** (`F:\code\ai-playground-v2`). Gates run with `CLAUDE_CODE_OAUTH_TOKEN`
**unset** — a stale token wedges the spawn path (F-029).

```bash
npm run dev          # vite dev @ 127.0.0.1:5173
npm run build        # vite build
npm test             # vitest run
npm run lint         # eslint .
npm run typecheck    # svelte-kit sync && svelte-check   (stricter form: svelte-check --threshold error)
npm run db:up        # provision + migrate the LIVE dev SurrealDB (idempotent; safe to re-run)
npm run verify       # build && vitest && playwright  (full)
```

**`db:up` runs SurrealDB in the FOREGROUND when it has to start it (F-059).** It does not return —
that is a foreground wait, not a hang (it returns promptly only when :8000 is already listening).
So launch it **detached** and confirm readiness by checking that **:8000 is LISTENING**
(`netstat -ano | findstr :8000`), never by waiting for the command to exit. Its exit code is not a
migration verdict either — read the log for `N/N migrations applied` before calling a non-zero exit
a failure. Don't kill the wrapper as routine cleanup; it can take the datastore with it.

**The green bar is four checks, zero-tolerance:** `npm run build`, `npm test`, `npm run lint` (0),
`svelte-check` (0 errors). That is necessary but **not sufficient** — see §5.

---

## 2. Workflow: Plan → Implement → Verify (no exceptions)

1. **PLAN** before touching code:
   - One sentence: what changes and why.
   - **Scope lock**: the exact file list. You touch nothing outside it. Note unrelated improvements as TODOs; don't fix them now.
   - **Reuse check**: grep for an existing util/repo/normalizer before writing one.
   - **Verification command**: how you'll prove it — down to the specific test/live-verify.
   - **Ground it (no guessing, D-039 spirit)**: every claim in a plan/spec traces to a verified fact — a `file:line`, a locked D-decision, or prior art. Never build on an audit-agent summary or an assumption. `grep`-negative ≠ absent.

2. **IMPLEMENT**:
   - Delegate exploration to subagents; get a summary back (keeps main context clean).
   - Read a file before editing it. Only edit files in the scope lock.
   - Match surrounding code — comment density, naming, idiom.

3. **VERIFY** with the command from step 1. Build+test+lint+svelte-check green, THEN the §5 live-verify for anything that touches data or a page.
   - Same failure twice = STOP. Root-cause per the Iron Law (§6), don't re-patch. Log to `docs/fails.md`.

---

## 2.5 Model roles (operator policy, 2026-07-07)

Split which model does what by TASK TYPE:
- **Plan / spec / create workflows → Fable 5 (`claude-fable-5`).** Brainstorming, specs, plans, roadmaps, decisions, authoring wave scripts / deciding wave structure — the thinking/design layer.
- **Build / code / research / large-context → Opus (`claude-opus-4-8`).** Implementation, coding, codebase scouts, tool/graph analysis, and a wave's build/fix/review/red-team (they read + verify real code = large-context execution). `push`/mechanical stays haiku.

Route spawned agents/waves accordingly: planning/spec/authoring subagents on `claude-fable-5`; build/research/large-context on `claude-opus-4-8`. Supersedes the 2026-06-13 "fable-5 retired / opus-everywhere" note.

## 3. Conventions

**The ones already in force here — follow them:**
- **Analytics is first-class.** Every agent/orchestrator event is logged with enough context to explain *how* and *why* a decision was made — never a flat event.
- **Async everywhere, reactive everywhere.** No blocking hangs; every page reflects live state via the SSE/event stream (D-005), not polling.
- **Live sources only (F-008).** Runtime data comes from a live source. When you don't have it, render an honest state — loading / empty / error / stale / unknown — never a plausible-looking fabricated value. Fixtures live in tests only.
- **Params, never string-interpolation (D-016).** All SurrealDB values go through SDK `$param` binding. Only validated table/record ids are ever interpolated.
- **Append-only for knowledge tables (D-015/D-028).** Extraction ADDs; dedup/supersession/contradiction happen downstream in a deterministic/graph pass — never an LLM mutating a row in place.
- **Untrusted content is DATA, not instructions (D-026).** Retrieved/tool/peer content is fenced. Only an `origin=operator` message bearing the D-025 token may act as an instruction (D-035a). Screen secrets/PII before storing.
- **Commit-before-finish for dispatched/worktree agents (F-007/F-012).** Uncommitted work in a worktree is lost.
- **Split commits by logical group** (operator preference) — not one mega-commit.
- **Devlog every session** — see §5.

**The ones I'm adding (hold yourself to these):**
- **One builder per worktree (F-052).** Never run two build/`svelte-kit sync`/dev processes in the same worktree at once — they race `.svelte-kit`. Serialize, or give each agent its own worktree.
- **A session-unique resource is keyed by session id, never a pool/slot id (F-046).**
- **A DB fault on the orchestrator drain path never crashes the server (F-014/F-048).** Every claim/enqueue/complete query absorbs UNIQUE/conflict as a no-op-retry.
- **fail-closed is for security boundaries ONLY (D-024/F-053).** An additive capability/provider branch is opt-in: engage only when wired, else fall through byte-identical. Never fail-closed on the un-wired case for something the routing ladder can send trivial traffic to.

---

## 4. Named traps in THIS codebase (the mistake → the rule)

A weaker model will hit these. Each is a real, logged failure. `docs/fails.md` has the full evidence.

**Data layer (the most recurrent family):**
- **Non-idempotent migration wedges `db:up` (F-015).** → Every `DEFINE` is `IF NOT EXISTS` / `OVERWRITE`. Assume a migration can die mid-apply and re-run. Test apply-twice AND apply-over-half-applied.
- **`ORDER BY`/`GROUP BY` field not in the `SELECT` (F-020, 3× recurrence).** → Every idiom field must be in the projection. A `stubDb()` unit test does NOT parse SurrealQL and will pass green while this is broken live — it needs a real-surreal test.
- **Raw SDK datetime returned from a `load` (F-013).** → Coerce every datetime to ISO in the repo `norm*` (`isoOrUndef`); absent → `null`/`—`, never `str(undefined)`. Unit tests where the field is `NONE` won't catch it — assert on a row where it's SET.
- **`dedup_key` VALUE keyed on mutable `status` collides at the TRANSITION, not just insert (F-048).** → Guard both the insert and the status flip.
- **A best-effort `catch` around a query masks a parse/developer bug (F-020 sweep).** → Never let a best-effort catch hide a developer error. Every best-effort loader needs a test asserting the happy path actually RETURNS rows.

**Svelte 5 / UI:**
- **Runes in a plain `.ts` don't compile as runes (F-009).** → `$state/$derived/$effect` live in `.svelte`/`.svelte.ts`.
- **`{@const}` outside an allowed block is a compile error (F-011).** → Only as an immediate child of `{#each}/{#if}/{#await}/{#snippet}`.
- **Playwright `networkidle` hangs on an open SSE stream (F-010).** → `waitUntil: 'load'`.

**Workflow host (`v2-wave.js`):**
- **Only the leading `export const meta` is tolerated — any other `export` is a load-time SyntaxError (F-016).** Also: escape every literal backtick inside a template-literal prompt (`` \` ``); never put `*/` (cron `*/5`, glob `**/*.ts`) inside a `/* */` comment (F-056). → After ANY template edit run `node --test .claude/workflows/v2-wave.test.mjs` — it re-runs the host's exact load pre-check.
- **Machine-parsed control flags in free prose false-trigger (F-019).** → Stop markers are honored ONLY as a sentinel prefix at the START of the deviation, all-caps: `BLOCKED:` / `CONFLICT:`.
- **`StructuredOutput retry cap` crashes the host AFTER work committed but BEFORE push (F-051).** → Don't re-run the wave or assume work is lost. `git log` for the on-green commits, re-run gates manually, `git push origin v2`. Resume needs the FULL original `args` with `resumeFromRunId`.

**Gates / security:**
- **A gate bypassed via a new call path (F-055).** → Route every gated state-change (arm/hire/publish/steer/spawn/config) through the EXISTING gate function. An exemption is valid only if the exempt handler carries its own auth. When a gate's premise changes (loopback→LAN), audit every path that relied on the old premise.
- **A capability id absent from the live synced catalog fail-closes every spawn of that intent (F-045).** → Never declare a `bundles.<intent>.capabilities` id that isn't in a SYNCED `.claude` scope's catalog. `code-write.capabilities` is intentionally empty.

**Concurrency / Windows:**
- **The Edit tool flips LF→CRLF here, breaking EOL-sensitive source-text tests (F-054).** → After editing, if a test regex-scans source, normalize `\r\n`→`\n` in it, or check `git diff --stat` for whole-file churn.
- **`process.kill(pid, 0)` is unreliable on Windows (F-001).** → `tasklist /FI "PID eq <pid>"`. Detached spawn breaks on paths with spaces (F-002) → `shell: true` + array args.

---

## 5. Quality bar per deliverable (checkable criteria, not adjectives)

**Definition of Done (D-038) — a feature ships only when ALL six hold.** "Build green" ≠ done.
Below, the DoD is made checkable per deliverable type. A box you can't tick is a blocker.

**Any data-layer change (migration / query / normalizer):**
- [ ] Migration is idempotent (`IF NOT EXISTS`/`OVERWRITE`); test covers apply-twice + half-applied.
- [ ] Every `ORDER BY`/`GROUP BY` field is in the `SELECT`.
- [ ] Every datetime field is ISO-coerced in the repo `norm*`; absent → `null`.
- [ ] There is a **real-surreal** test (not `stubDb`) that parses the actual query.
- [ ] `npm run db:up` runs clean on the LIVE dev DB (not only a fresh test DB).

**Any server `load` / aggregator:**
- [ ] Returns POJOs only (no raw SDK datetime/Date-like → devalue 500).
- [ ] Render-smoke: the page it feeds renders (loading/empty/error states honest, F-008).
- [ ] No best-effort `catch` that could silently drop rows without a happy-path test.

**Any Svelte page / component:**
- [ ] Runes in `.svelte`/`.svelte.ts`; `{@const}` placement legal; `svelte-check` 0.
- [ ] Matches the design system (teal/Lastik tokens, D-034) — not ad-hoc styling.
- [ ] Reactive off the live stream; no polling; no fabricated data.

**Any `v2-wave.js` / workflow edit:**
- [ ] `node --test .claude/workflows/v2-wave.test.mjs` passes (host load pre-check).
- [ ] No stray `export`; backticks escaped; no `*/` in block comments.

**A build wave / feature (the full D-038 gate):**
- [ ] Complete & fleshed-out (no stubs/TODOs left as "the feature").
- [ ] Fully tested against real SurrealDB where a query is involved.
- [ ] Design-system standard. Functional & **live-verified** (consolidated: `db:up` live + render every new `load`).
- [ ] Has a clear purpose. Honest (no fake states, no green-on-stub masking).
- [ ] Devlog written: `docs/devlog/YYYY-MM-DD[-slug].md` — `Theme` · `Shipped` (per-feature table with commit hashes) · `Migrations` (+live db:up counts) · `Decisions` · `Bugs/fails (F-NNN)` · `Docs/memory` · `End-gate PASS` · `Parked/next` (operator vs design-gated). Commit + push it.

---

## 6. When uncertain — exact escalation

- **Debugging (the Iron Law).** No fix without an instrumented root cause: form a testable hypothesis, confirm it with a log/assertion at the suspected cause + a deterministic repro, THEN fix. Scope-lock edits to the affected module. **3 failed hypotheses = STOP** — escalate with options (new named hypothesis / hand to operator / add instrumentation and catch next occurrence). Never grind out hypothesis #4. A recurring F-entry in the same files is an architectural smell, not bad luck.
- **Spec/facts unverified** → do not guess. Trace to `file:line` or a locked decision, or ask. A plan built on an assumption is a defect.
- **Anything that spends real tokens** (spawning sessions, running a wave) **without a recorded operator consent/confirm** → STOP and ask. Spend is doubly-capped (re-tick + D-021 200/day) but consent is separate.
- **`gate:operator` queue item, or any external/publish/release action (D-037)** → STOP. Publish is always operator-gated, even in autonomous-to-v1. Repo creation is private-first and never unilateral.
- **A wave deviation** → begin the deviation field with `BLOCKED:` / `CONFLICT:` (sentinel prefix, F-019) so the host stops cleanly.
- **A gate's environmental premise changed** (loopback→LAN, single→multi-user) → audit every path that relied on the old premise before proceeding.
- **fails.md recurrence** → 1st time document; 2nd add to the relevant SKILL.md; 3rd promote to a CLAUDE.md hard rule; still recurring → a hook. Mark stale/contradicting entries with a dated `> STALE-PROPOSED:` / `> CONFLICT:` line — **mark, never delete** (only the operator retires an entry).
- **Every autonomous stretch ends with a digest** (the devlog) — verdicts, commits, deviations.

---

## 7. Decisions you must not silently cross (quick ref — full text in `docs/DECISIONS.md`)

`D-001` one SurrealDB · `D-008/016` dedup via computed VALUE keys + `$param` binding · `D-021` background job queue + daily spawn cap · `D-024` safety gates fail CLOSED (security only) · `D-025` every listener loopback-only + per-boot token + anti-CSRF · `D-026` untrusted=data, screen secrets/PII, least-privilege DB user · `D-035a` only `origin=operator` steers; origin stamped server-side, immutable · `D-036` per-task capabilities allow-listed from catalog, unknown id fails closed · `D-037` publish/deploy operator-gated · `D-038` Definition of Done (§5) · `D-039` auto-created PM tasks born `proposed`, pass a validation panel; operator keeps approval · `D-040` self-hosting seam (`atelier_self`).

---

## 8. Skills (invoke on demand)

- **Atelier data layer** (migrations, queries, normalizers, live-verify) → `@.claude/skills/atelier-data-layer/SKILL.md`
- **Atelier live-verify / DoD end-gate** → `@.claude/skills/atelier-live-verify/SKILL.md`
- **v2-wave authoring & recovery** → `@.claude/skills/atelier-wave/SKILL.md`
- **Svelte 5 runes patterns** → `@.claude/skills/svelte5-patterns/SKILL.md`
- **Error learning protocol** → `@.claude/skills/error-learning/SKILL.md`

## 9. Stack (verify APIs before use)
- **App**: SvelteKit 2 + Svelte 5 runes (`$state`/`$derived`/`$effect` — NOT stores), Tailwind v4 (`@theme`, CSS-first), Vite 6, Vitest 3, Node ≥24. App at repo root.
- **Store**: SurrealDB 2.x (`surrealdb@2.0.3`), SurrealKV on loopback, 1024-dim embeddings (D-014). Target 2.x syntax (HNSW vectors, SEARCH ANALYZER FTS).
- **Runtime**: Claude Code via direct subprocess (`ClaudeCliBackend`). **OpenClaw is DROPPED (D-012)** — ignore any OpenClaw/gateway/TLS-pairing references; they are v1.
- **Local model**: Ollama `gpt-oss:20b` @ `http://127.0.0.1:11434` (NO `/v1` suffix), swappable behind the provider interface (D-003).
