# 2026-07-26/27 — Two lanes to completion, and the suite goes honestly green

**Theme:** two build lanes ran in separate worktrees against disjoint file scopes and both
reached the end of their task lists. What actually shipped was not features — it was the
removal of three kinds of lie: **a score a run never produced**, **a guard test that could not
fail**, and **a test suite everyone had learned to route around**. Each was found by attacking
the CLASS after the point fixes stopped converging. The stretch ends honest but *unfinished*:
lane B is complete and pushed, lane A has **22 commits that exist only on this machine.**

> **Span.** This entry continues from
> [2026-07-26 — The operator review](2026-07-26-operator-review-and-wave-a.md), which closed at
> the first operator pause — right after the lane-B merge `5860b28` (07-26 13:52). Everything
> from `e077161` (07-26 15:39) onward is here, including FP-1 and LB-3, which that entry does
> not cover.

## Shipped

Lane A = worktree `F:\code\ai-playground-v2`, branch `v2`, :5173, holds the migration slot.
Lane B = worktree `F:\code\ai-playground-v2b`, branch `v2-lane-b`, :5174, no `db:up`.

| task | lane | verdict | commits | headline |
|---|---|---|---|---|
| FP-1 (`finish-small-polish`) | A | ✅ gated + **PUSHED** (`origin/v2` = `b035577`) | `e077161` `654fff2` `b035577` | `/brain` live-update was **DEAD** — `concept` + `soul_graduation` were subscribed but never watched (found by taking a census-drift test seriously instead of relaxing it) · `soul.ts` catalogued in the quarantine census, verified safe **live**, not by grep · the workspace render-smoke stopped pinning a magic `dailySpawnCap` and asserts the invariant — the stale expectation our own SD-1 wave created. |
| LB-3 | B | ✅ review + red-team PASS | `65adffd` `2fd4987` | The write half of the naming work: **a session row is BORN with an identity**, and the six non-drain spawn seams name themselves with a guard that keeps it that way. This is the root cause behind LB-2's partial label coverage. |
| LB-4 | B | ✅ 3 passes: feature → close-out → red-team close-out | `915293c` `d15a880` `1a2236d` → `7553ca7` → `e25738b` | The `/claude-code` fleet narrows (filter by project, filter by failure, collapse). Took three passes because **the fix-loop's own second fix introduced the regression** — see below. |
| FP-2 | A | ✅ review PASS → red-team FAIL → fix | `86696ee` `1d63b55` `58a57e9` `fe3aa24` | `/agents` chip wall grouped by purpose + the hiring-feed `interview_run` JOIN. Review caught score suppression gated on **one** of five enum values; red-team caught `recallPart()` printing the exact recall the header chips suppress. |
| FP-2v (close-out) | A | ✅ review FAIL → fix → PASS, then red-team FAIL | `ced89e4` `a4b36e7` | `ced89e4` closed the terminality defect **class** (one `$lib/shared/interview-status`, imported by all five surfaces, with a parity test that PARSES the schema ASSERT). `a4b36e7` fixed the parity test itself, which **could not fail** — see below. |
| TERM-1..5 | A | ⚠️ built + gated in-task; **review deferred to TERM-R** | `bdd299a` `48602bc` `101ea3e` `d403d65` `73046cd` | The class attacked at five depths at once, including the one path that **persists** a fabricated score and a structural inventory guard. |
| FP-3 + residue cluster | A | ✅ build → review FAIL → fix → review PASS → red-team FAIL → fix → re-review PASS | `d9e2865` `ee49461` `bb406e3` `9050d81` `c8451fc` `5bd38af` `944a054` `2d288ec` `63bb12d` `89807a9` | **`npm test` on `v2` is honestly green for the first time this stretch** — plus the residue cluster (gauntlet diagnosability, the F-048 `memory_review` dedup residue, the last `$app/stores` import, the SD-1 banner wording). |
| TERM-R | A | landed **2026-08-04 14:01**, while this entry was being written | `38eb9a8` | Independent review of the five orphaned TERM commits: the terminality gate withholds correctly but **has no reconcile path**, and the reason string pointed at the wrong exit. |

### The LB-4 close-out — the guarantee that could not exist

The feature landed in three commits, and the review **failed** it on a regression the fix-loop
itself had introduced: keying the re-seed on `href` made a *same-href real navigation* a no-op.
The close-out `7553ca7` did the right thing — it went and read SvelteKit 2.63.0's
`client.js` and found a genuine discriminator (`afterNavigate` fires only from hydration
`:724` and the tail of `navigate()` `:1987`, never from `_invalidate` `:405-488`), threaded it
into the pure seam as a **defaulted-false** argument so every prior test passed byte-unchanged,
and ran a **negative control** proving exactly 2 new tests fail without the fix.

**Review PASSED it. The red-team broke it anyway.** Kit commits the address bar at `:1833-1834`
and `page.url` at `:1894-1896` and only checks its abort token at `:1929-1932` — an early
return that never reaches the `afterNavigate` callbacks. So an aborted navigation moves the URL
without ever firing the callback: `afterNavigate` is **a sound negative and an incomplete
positive**, and the previous commit had asserted the positive half as kit-verified fact.
`e25738b` stops depending on a kit internal with an abort path and has the page **re-assert its
own mirror** — drift-triggered, measured at zero `replaceState` calls under a 20-invalidate
storm. It also closed the BACK-button case, which was the same URL-vs-UI desync by construction.

### The terminality defect class

**A surface that reads `interview_run` score fields without gating on terminal status states a
number the run never produced.** It was fixed five times. A sixth instance was still found —
inside a *scope-locked file* — `agents/ceremony/+page.svelte:961-962`, rendering
`found {plantedFound}/{plantedTotal} · {falsePositives} FP` completely ungated, three lines
above a branch on `status`. Point fixes do not converge on this shape, so TERM-1..5 attacked
the class:

- **`bdd299a` (TERM-1) — the one path that PERSISTS.** `workforce/resolution.ts`
  `regauntletChallenger` took `outcome.run` straight into `buildComparison` with no gate, wrote
  the fabricated comparison into `review_proposal.comparison`, and advanced the proposal to
  `compared`, where the surface offers the D-039 swap decision on it. Every other instance
  merely *rendered* a wrong number; **a reload corrects a render, it does not correct a row.**
  Fix writes nothing, returns an explicit unknown (`comparable:false`, null scores, a named
  `incomparableReason`), and widens `falsePositives` to `number|null` because typing it `number`
  made the honest answer unrepresentable.
- **`48602bc` (TERM-2) — the second definition.** `track-record.ts` kept its own
  `TERMINAL = {passed, failed, error}` and disagreed with the canonical set on exactly one
  value. **A duplicated rule is how this survived five point fixes**, so the set was deleted
  rather than corrected. Counts stay ungated on purpose — *a count is a fact about runs, not a
  score claim.*
- **`101ea3e` (TERM-3) — gated at the PAYLOAD, not the markup.** Both `outcomeResult()` twins
  omit the score keys entirely unless the run is scored, and emit adjudicating progress under
  *different names* (`progressFound`/`progressTotal`) so no template can mistake a lower bound
  for a verdict. A template cannot render a number that never arrives.
- **`d403d65` (TERM-4) — the structural guard.** Every file in `src/` that reads
  `planted_found`/`planted_total`/`false_positives` is inventoried with a verdict, and the test
  fails when the inventory drifts — including *a new read inside an already-listed file*, which
  is the sixth-instance shape that file-level membership alone would have missed. Its cost and
  its limits are written into the file: **it proves the decision gets MADE, not that it is right.**
- **`73046cd` (TERM-5)** — two render pins sliced `briefStart + 600` / `+ 900`, silently
  encoding "the brief must stay under 600 chars"; re-anchored to the block's real end.

### The guard test that could not fail

`ced89e4`'s single load-bearing guarantee was a parity test that parses the `interview_run`
status ASSERT out of `schema.ts` and fails by name on any unclassified status. The review found
**the anchor itself was blind**: `src/lib/shared/interview-status.test.ts:31` used
`String.prototype.match` **without `/g`**, which returns the FIRST occurrence — while SurrealDB
`OVERWRITE` makes the **LAST** applied DEFINE the one in force. Re-DEFINing a field in a later
migration is `schema.ts`'s dominant idiom, measured: `type ON agent_event` ×6,
`kind ON scene_event` ×4, `status ON task` ×2, `op ON role_event` ×2. The test would have stayed
green *forever* while a widening migration added an unclassified status.

`a4b36e7` fixed it in **one test file, zero runtime files**, and it was **mutation-proven**:
injecting a widening `DEFINE FIELD OVERWRITE status ON interview_run … "cancelled"` into m0086
now fails by name (`schema statuses with no classification: cancelled`); before the commit the
same mutation left 8/8 and 27/27 green. TERM-4 then closed two *further* silent-green modes of
the same parser (a later re-DEFINE that DROPS the ASSERT; a re-DEFINE without `OVERWRITE`, where
last-wins is not even true) and re-pointed the migration-order grounding at the exported
`schemaMigrations` **array** — the real authority — instead of declaration order.

**This is the standard to hold future guard tests to: a guard is not green, it is *mutation-proven*.**

### FP-3 — three root causes under one red suite

The full suite had been red all stretch, which is why wave after wave hard-stopped. It was never
one thing.

1. **`hooks.server.ts:201` runs `export const startup = bootstrap()` at MODULE SCOPE.**
   `/projects/[id]/+page.server.ts` and `/settings/+page.server.ts` imported the *pure* accessor
   `activeOrchestrator` from there — so any test importing those loaders booted the whole real
   server, claimed the process-wide `Db` singleton, and died at FILE level. Fixed by **reuse**: a
   side-effect-free registry already existed for exactly this purpose. **22 tests were recovered
   that had never actually run while being counted as skipped.** Ships a structural guard that
   asserts the eager boot still exists (so the guard keeps its premise).
2. **The rotating failure set had a shared cause.** 191 of ~330 suites call `startTestDb()`,
   each spawning a REAL SurrealDB with its own SurrealKV dir and 86 migrations. Vitest defaults
   to one fork per core, so a 24-core box ran **~23 SurrealDB servers at once**. Instrumented in
   the same commit: ~23 forks → 6 failed files / 145s; `maxForks=8` → 2 failed / 117s. Capping is
   **faster and stabler** — bounding concurrency honestly rather than marking a suite flaky.
3. **But capping forks only lowered the PROBABILITY.** Underneath was an **unretried
   optimistic-commit conflict** — SurrealDB says so itself in the error text ("This transaction
   can be retried"). New single-owner classifier + bounded retry at `src/lib/server/db/retry.ts`,
   applied to PRODUCTION `cc-config/sync.ts` (idempotent by construction, so a replay converges)
   **and to the bare `DELETE work_item;` helper in `orchestrator.test.ts` plus its two identical
   siblings** — fixing only the cited instance would have left the class alive in two files.

Result, measured in `89807a9`'s own gate line: **331 files / 5712 tests passed, 1 file / 7 tests
skipped, exit 0** (baseline immediately before: 331/5709 — the +3 are its own new tests).

### The single most consequential find of the stretch

Red-team, against FP-3's first fix. `diagnosticWindow` (the D-026 screen + F-014 bound) had been
applied at a **READ** site — but `streamErrored` has **four readers**, and the other three saw the
raw value: `session.note` head-only-unscreened (`gauntlet.ts:721`), `agent_event.detail`
unscreened **and unbounded** (`:736`). Windowing moved to **both CAPTURE sites**, so every reader
is downstream of the guard.

The impact was worse than the finding said. The same commit retired an `(err as Error).message`
cast in the classifying catch, which yielded `undefined` for a non-`Error` throw — and **both**
classifier branches read that. **A harness that threw right after a `done` event was finalized
as status `failed` — a TERMINAL capability verdict on the hire-adjudication path. An
ENVIRONMENT OUTAGE was being recorded as a real candidate REJECTION.** It is now
`error`/`spawn_failure`.

This bears directly on the 19 errored `interview_run` rows from the 2026-07-26 operator review —
but read the direction carefully: the defect wrote **`failed`**, not `error`, so the affected
runs are **not among the 19**. They are hidden inside the rows that currently read as real
rejections. Some "failed" candidates may never have failed. *(Stated from the code path; I did
not query the live DB for this entry.)*

Two smaller finds rode along: `gate-live.test.ts`'s `readToken` fell back to the worktree `.env`,
so running the gates under the mandated token-unset condition (F-029) did **not** skip — it
spawned a real CLI against a stale credential and reported a **credential** failure as a
**gate-wiring** failure. And the elision marker was never charged against the 2000-char budget
(measured overshoot 2030 at 5k input, 2031 at 50k) — while the existing test's `2000 + 64`
assertion **had been tuned to the defect.**

## Migrations

**NONE.** Verified against `F:\code\ai-playground-v2\src\lib\server\db\schema.ts`: the last
declared migration is `m0086_boot_skip_ledger` (`:3089`) and `schemaMigrations` ends at
`m0086_boot_skip_ledger` (`:3214`). Head is unchanged from the previous entry.

- `m0087` (MODEL-LADDER) and `m0088` (TASK-BOARD) remain **allocated on paper, unbuilt**.
  **`m0089` is the next free number.**
- `9050d81` explicitly ships **no migration** and says why: the F-048 dedup guard is a *record id
  computed in code*, not schema — no field, index or row changes shape.
- SurrealDB on `:8000` was up throughout (pid 30020, 86/86) and was used by real-surreal tests.
  It was not migrated this stretch.

## Decisions

- **A test suite is judged against a MEASURED BASELINE, not an absolute flag** (`502df2a`, wave
  host). Non-test gates (build/lint/svelte-check) stay absolute — a red one is always this
  build's own change. The suite is relative: `afterFailed <= baselineFailed` proceeds.
  *Unmeasured also stops* — the honesty is the number, not the flag. `args.stopOnAnyRed:true`
  restores absolute semantics for a wave that must land on a green tip.
- **Withhold, don't write** (TERM-1). On a non-terminal challenger the proposal stays
  `interviewing` and *nothing is persisted* — the reversible choice, because no row written is a
  state nothing downstream can misread.
- **Counts are not scores** (TERM-2). The passed/failed/error/adjudicating/running counts stay
  ungated deliberately.
- **Gate at the payload, not the markup** (TERM-3), and give in-progress figures *different
  names* so no template can promote a lower bound to a verdict.
- **A structural inventory guard is worth its rename cost** (TERM-4) — with its limits written
  into the file rather than implied.
- **The reconcile path is an operator decision** (TERM-R). Rather than invent a gate, the code
  now *states the limitation the operator pays for*: resolving the adjudication queue finalizes
  the run and never touches the proposal, so a comparison still costs a second real spend.
- **Bound concurrency honestly rather than mark suites flaky** (`ee49461`).

## Bugs / fails

Two entries landed on `v2-main` in `11ccd38` (which also escalated the first into
`.claude/skills/atelier-wave/SKILL.md` per the §6 ladder):

- **F-058** — `git checkout -- <file>` reverting a mutation-proof **also reverted the agent's own
  uncommitted fix**. Twice in one week, two agents (LB-4b and TC-1), two worktrees. Both
  self-detected and recovered, so nothing shipped broken. **The unlucky version of this ships a
  NO-OP fix while every test passes** — invisible to build/test/lint/svelte-check. 2nd occurrence
  → escalated to the wave skill; a 3rd promotes it to a CLAUDE.md hard rule.
- **F-059** — `npm run db:up` runs SurrealDB in the **foreground** by design, so waiting for it
  to exit reads as a hang; and a run that printed `86/86 migrations applied` still **exited 1**.
  Launch detached, verify by port, read the log for the count. Also written into CLAUDE.md §1
  (`cbb58bf`).

**A third harness finding was fixed rather than numbered:** `verifyPassed=false` conflated *"I
broke the gate"* with *"the gate was red when I arrived."* TC-1 built correctly, committed five
good commits, honestly reported a pre-existing red suite, and the host hard-stopped — **the
honest builder was penalised for the honesty**, and those five commits sat unreviewed for the
rest of the stretch. Fixed in `502df2a` (host pre-check 28/28 → 38/38, three mutation proofs run
against a **scratchpad copy**, never the live file — F-058 applied the same day it was written).

Defects found and fixed in product code this stretch, for the record: `/brain` live-update dead ·
score fabrication on six surfaces incl. one that persists · a duplicated terminality definition ·
`false_positives` rendered as a settled `0` on the very card where the operator decides it · the
`memory_review` F-048 dedup residue (dedup key on mutable `status` guards the insert, not the
transition) · the eager-boot Db-singleton claim · the unretried commit-race · `gate-live`
resurrecting a credential from `.env` · unscreened/unbounded error payloads on three of four
readers · env outage finalized as candidate rejection · a merge-back teardown race that waited on
the worktree when the branch delete is the true end-of-success signal.

> **Numbering gap, flagged not fixed:** `F-057` is cited in five places in the v2 code
> (`workqueue.ts:111,119`, `workqueue.test.ts:403,405,409`, `activation.test.ts:226`) but is
> **absent from `docs/fails.md`**, which jumps F-056 → F-058. Someone should reconcile that; I
> did not invent an entry for it.

## Docs / memory

`docs/BUILD-QUEUE.md` OPERATOR PAUSE **#3** (`8b84f16`), **#4** (`a800f2c`), **#5** (`b7bc61f`) —
three contemporaneous resume records, each superseding the last, written at the moment of each
stop rather than reconstructed afterwards. They are the primary source for this entry.
`docs/fails.md` + `atelier-wave/SKILL.md` (`11ccd38`). `CLAUDE.md` §1 (`cbb58bf`).
`.claude/workflows/v2-wave.js` + `.test.mjs` (`502df2a`).

## End-gate — PARTIAL, and honestly so

- **Lane B: PASS.** LB-3 and LB-4 each review PASS + red-team PASS; the LB-4 close-out was
  re-reviewed and re-red-teamed after the fix. `origin/v2-lane-b` = **`e25738b`**, worktree
  `ai-playground-v2b` clean, 0/0 vs remote. **Verified by me** (`git rev-parse`, `git status`).
- **Lane A: NOT COMPLETE.** HEAD = **`38eb9a8`**, **22 commits ahead of `origin/v2` (`b035577`),
  UNPUSHED.** FP-1 is the only lane-A work on the remote. FP-2v and FP-3 are fully gated with
  their gate numbers stated in-commit (build ✓ · lint 0 ✓ · svelte-check 1128 files 0/0 ✓ ·
  vitest 331 files/5712 passed, exit 0). TERM-1..5 were **unreviewed** at the pause.
- **The suite claim is second-hand by necessity.** I did not run `npm test` — a code wave holds
  that worktree and F-052 forbids a second builder in it. The numbers above come from
  `89807a9`'s own gate line and are corroborated in PAUSE #5 by a second agent measuring the same
  tree.
- **The lane-B merge into `v2` has NOT happened.** Neither lane has ever tested the combination;
  it must be `--no-ff` and the merge result independently re-gated.
- **State changed while this entry was being written.** At the start of this session lane A was
  at `89807a9` / 21 commits with `resolution.ts` + `resolution.test.ts` modified in the tree.
  Between two of my own `git` calls, **`38eb9a8` (TERM-R) landed at 2026-08-04 14:01** — the
  review of the five orphaned TERM commits. It produced one commit: a corrected `incomparableReason`
  string, a documented KNOWN LIMITATION replacing a claim the review found false, and ~60 lines of
  new tests. **I did not find a recorded overall PASS/FAIL verdict artifact for TERM-R**, so I am
  not asserting one — only that the review ran and landed a fix. The count is now 22 unpushed.

## Parked / next

Order from PAUSE #5, updated for what landed since:

1. ~~`TERM-R`~~ — landed `38eb9a8`. **Push all 22 lane-A commits** (`git push origin v2`).
2. **Merge `v2-lane-b` → `v2` `--no-ff` and RE-GATE the merge result.**
3. **`review-and-gate`** — still the only correctness finding of the 2026-07-26 review:
   `post-task.ts` commits agent work before the test runs, and `orchestrator/review.ts:115` has
   zero production callers.
4. **`TASK-BOARD-SPEC` P1** — structured task context to the model. Three files, no migration.

**Open, recorded, not lost:**
`HIRING_RUN_FETCH_CAP=200` truncates silently with no honest partial signal (`repo.ts:1374`) ·
the hiring header count is the UNFILTERED total while the list defaults to filtered · no render
test for the two honest-unknown `{:else}` branches (live data is 100% terminal, so a browser pass
never executes them) · the `str()`-over-`RecordId` join-key asymmetry · 3 of 36 `interview_run`
rows carry no `role_event` at all and can never reach the feed · `HIRE_LIFECYCLE_OPS` omits
`unstaffed` · a fourth spelling of the F-013 coercion at `usage.ts:231` · `concierge-stream-abort`
(deferral chain, still queued) · from LB-4: no component-render harness for `/claude-code` (adding
`@testing-library/svelte` needs `package.json`, outside lane B's scope lock) and route-wide token
drift in `claude-code/+page.svelte` (28 of 35 literal `font-size:` values pre-existing — one
lane-A sweep, not a per-commit trickle).

**Operator-gated, untouched:** arming a PM · per-hire souls · widening auto-adjudication past B3 ·
any publish/deploy/release · a live gauntlet run · the reconcile path behind the terminality gate
(it changes what the re-gauntlet button spends).

## Corrections to my own reporting (recorded, not quietly fixed)

- **PAUSE #5 says FP-3 was "8 commits, `bb406e3`..`89807a9`". It is 10** — `d9e2865`..`89807a9`.
  The two omitted are `d9e2865` (ITEM 4d, the Db-singleton boot leak) and `ee49461` (ITEM 4e, the
  fork cap) — the two *most* central to "make the suite green".
- **The 19-errored-rows link points the other way than stated.** The misfinalization wrote
  `failed`, not `error`, so affected runs are not inside the 19; they are inside the rows that
  read as genuine rejections.
- **A brief of mine claimed three `node:test` files needed excluding from vitest.** They were
  already vitest files and already passed. `scripts/memory-pull-mcp.test.js`,
  `scripts/peer-send-mcp.test.js`, `tests/verify-flows/lib/runner.test.ts` — corrected by the
  builder; FP-3 ITEM 4(d)'s node:test half did not exist.
- **`ced89e4`'s commit body asserted a green full suite (`vitest 323 files ✓`) that did not
  exist.** Caught by the review and **retracted in `a4b36e7`'s body**, which states the real
  measured numbers. A D-038 honesty defect in a commit message is still a D-038 honesty defect.
- **"Off-token literals in `SessionRefChips.svelte`" was a GHOST** — carried across two pause
  blocks, re-checked in `a4b36e7`, the file has no hex/rgb literals at all. Struck so no
  hardening wave chases it.
- **`track-record.ts` — unresolved discrepancy, flagged.** `48602bc`'s body states the duplicate
  `TERMINAL` set was "F-008, rendering live". The operator's later account is that the fix changed
  **0 of 15 live cells today** — real but LATENT. **I could not find that measurement anywhere in
  the written record** (BUILD-QUEUE, fails.md, or any commit message), so I am recording both and
  marking the commit body as the thing to reconcile, not silently believing either.
- **The migration-order grounding test asserted DECLARATION order** while the authority is the
  exported `schemaMigrations` array. Corrected in TERM-4.
