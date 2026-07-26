# 2026-07-26 — The operator review: Wave A completed, 17 findings, and the parallel-lane mechanism

**Theme:** the operator ran a live review of the running dashboard and raised eleven observations
in sequence; each was scouted to a grounded `file:line` verdict rather than answered from memory.
In parallel the build chain finished COMPLETION-LEDGER **Wave A** and opened a second build lane.
Session ended on an operator pause, mid-LB-3, deliberately.

## Shipped — BUILD (code on v2, all pushed)

| wave | verdict | commits (origin/v2) | headline |
|---|---|---|---|
| deferral-sweep | ✅ 2/2 GREEN (redTeamAll) | `0ee5c38..9c1f023` | DS-1 `4678003` reconciled `db:up`'s printed operator handoff with the real SF2-1 least-priv seam — an operator following db:up's OWN output configured vars the runtime never reads and stayed silently on the ROOT path; handoff extracted into a testable pure builder + a RETAINED real-binary live test whose load-bearing assertion is that the connected identity CANNOT `DEFINE USER`. DS-2 `9c1f023` metered the ABORTED concierge turn on every terminal outcome (partial usage, else a bounded worst-case cap), estimated rows distinguishable in data + UI, no double-meter, late stream faults recorded as `type:'error'` rows. |
| analytics-visibility (Wave A) | ✅ 4/4 GREEN (redTeamAll) | `532b35a..e5274c6` | AV-1 `532b35a`+fix `5b9e1e5` hire/cert ledger (fix-loop caught a real 3.50:1 contrast defect — tone badges drew text from base-surface tokens while sitting on an overlay). AV-2 `1ad4afa` drain ledger — every swallowed orchestrator fault + queue hold is now a named, visible event. AV-3 `bd95e9b` (**m0085** vocabulary) + `18f233e` + `6784bdf` + `0ee313b` — concierge and PM thinking leave a trace, surfaced on `/brain` and the lifecycle graph. AV-4 `bb98584`+`e5274c6` (**m0086**) spend provenance + the boot-skip ledger. |
| shell-and-labels (lane B) | ⏸ 2/4 GREEN, merged | `e5274c6..5860b28` | LB-1 `82c00a0` the shell scroller owns its abspos descendants. LB-2 `5c67b74..a4da885`+fix `2d44387` one shared naming composer. Operator-stopped mid-LB-3. |

**AV-4 is the one worth reading twice.** The `/reports` opus tier rendered a confident `$0.00`;
live it was 18 rows of which **2 were priced** (Σ $0.000570) and 16 NULL by design. Real
arithmetic over a dishonest denominator — an F-008 *coverage* lie rather than a value lie. Every
cost aggregate now carries `spendEstimatedUsd`/`estimatedRowCount`/`pricedRowCount`/
`unpricedRowCount`; that cell reads `<$0.01` with `2/9 priced`, the untiered bucket reads `—`
with `0/8`, and the 90-day headline says *"only 4 of 147 metered runs resolved a price (3%) — a
FLOOR, not the full cost."* The coverage denominator is METERED rows, because a bare spawn is
legitimately un-meterable and counting it would have fabricated a bad ratio out of correct
behaviour. Adding `model.model_id` to the projection ended the `unknown`-tier opacity entirely.

> **The builder caught its own defect in live-verify.** Its new "done rate" column rendered
> **1175%** — a run spawned on day A completes on day B, so completions are not bounded by that
> bucket's spawns. That is precisely the dishonest-denominator class the task existed to remove.
> It cut the derived rate, kept raw counts, and asserted `not.toHaveProperty('completionRate')`.
> Build, lint and svelte-check were all green on it. Only a browser found it.

## Migrations
`m0083`/`m0084`/`m0085` (analytics-visibility AV-1..AV-3 event vocabularies) and **`m0086_boot_skip_ledger`**
(extends the SD-2 `autonomy_status` singleton with a per-subsystem boot ledger — FLEXIBLE, because a
plain `array<object>` on a SCHEMAFULL table silently drops nested keys and would render empty
objects, a green-looking lie). Live `db:up` 86/86 clean.

> **A real collision, and the rule that came out of it.** `m0086` was CONSUMED by AV-4 *while two
> specs were being authored in parallel*, both of which had claimed it on paper. Reallocated:
> **m0087 → MODEL-LADDER-SPEC, m0088 → TASK-BOARD-SPEC**. New rule in CLAUDE.md: **a spec
> allocates from the LIVE head, never from the next number it happens to see.**

## Shipped — the operator review (`docs/OPERATOR-REVIEW-2026-07-26.md`, 17 findings)

Five of the eleven observations turned out to be **one defect in different costumes: the UI
renders the weakest field it can reach.** ~30 identical `code-write` chips · `agent sonnet 1` in
the memory scene · raw `role:probe_fit_178…` ids · `recall —` on every hire row · `unknown` tier
and `$0.00`. In every case the meaningful value was already in the row or one join away.

The findings that were **not** presentation problems:

- **No review, and no gate, on Atelier's own runtime.** `post-task.ts` commits at `:376` and runs
  the project test at `:400` — *after* — with `followUpOnTestFail:false`, then mergeBack FF-merges
  the unreviewed branch. `orchestrator/review.ts:115` is fully built and tested with **zero
  production callers**. The only correctness finding of the day.
- **The agent library is a display.** No definition reaches the CLI (`capabilities` is stripped as
  `HARNESS_ONLY_SETTINGS_KEYS`; spawn argv has no `--agents`), the platform's own `.claude` scope
  is synced by nothing, `scanAgents` is flat while all 113 files sit in subdirectories, `cc_agent`
  is empty, and **~111 of 113 definitions are untracked claude-flow-generated files** a tool
  re-run would silently overwrite.
- **Cannibalize records WHEN, half of WHAT, and none of WHAT WE LEARNED** — no verdict field
  exists at all, and `ingest_source`/`memory` are **0 rows**: the tool has never run. Licence is
  optional and unenforced while kongcode (185 mentions, source of D-006/D-007/D-008) is documented
  as "code-lift needs consent".
- **Loops have no persisted topology** (`schema.ts:2495`: loops are DERIVED only) and **roadmaps
  have no future half** — nothing anywhere carries a planned date. Both are modelling jobs.
- **GitHub Projects v2 sync is already built** (one-way push, via the `gh` CLI which speaks v2
  GraphQL underneath) — but `task_sync`/`board_sync_config`/`sync_incident` are **all 0 rows.
  Nothing has ever synced live.**
- **The 19 errored `interview_run` rows are historical** (§13) — G1 predates its own fix
  `815c102`, G3 was F-033 and is fixed, G2 was an env outage; only G4's *diagnosability* is live
  (`gauntlet.ts:717` `slice(0,500)` truncates a payload whose meaning is at its tail). The honest
  caveat: it is not still happening because **nothing has run in 37 days**.

## Decisions
Operator locked five for `MODEL-LADDER-SPEC`: hard fail-closed fable-as-planner gate with **no
per-call operator bypass** (explicitly bending F-005 for this one tier, recorded and dated) ·
reuse the HR gauntlet as the model-trial engine rather than building an evaluation subsystem ·
local-Claude-Code spec-now/build-later · self-describing config + a live `/settings` ladder ·
and unpriced models ship honest-NULL **plus a research task/CTA to close the gap** (→ ML-12).

New standing rule saved to memory: **a display name must convey PURPOSE, never a tier/model/slot/id**
(`feedback_names-must-convey-purpose`).

## Corrections to my own reporting (recorded, not quietly fixed)
- "Task why/how NEVER reaches the agent" was **overstated**: `composeDescription`
  (`pm-proposals.ts:160-171`) already folds the §4.1 fields into `description` for pm-origin tasks
  — 17 of 23 live. The real gap is non-pm origins, `priority` on every origin, and structure.
- `normTask` **does** exist (`tasks/repo.ts:184`); the work is extend, not create.
- CLAUDE.md's subsystem list named 19 directories; disk has **41**. Replaced with the verified set.

## Docs / specs
`OPERATOR-REVIEW-2026-07-26.md` (17 findings + a 10-wave split) · `MODEL-LADDER-SPEC.md` (final,
ML-1..ML-12) · `TASK-BOARD-SPEC.md` (4 phases, prompt-context first) · BUILD-QUEUE + CLAUDE.md
brought back in line with disk.

## Infrastructure
**The wave host is now worktree/branch-parameterized** (`af235b5`) — `args.worktree`/`args.branch`
default to the canonical worktree so every existing invocation is byte-identical. Host load
pre-check re-run per the §5 rule: **28/28 pass**, including the F-016 regression. First use ran two
build lanes concurrently against disjoint file scopes, separate ports, and one shared DB with only
one lane permitted to migrate. It worked; the merge back was independently gated because neither
lane had tested the combination.

## End-gate
PASS for deferral-sweep (2/2) and analytics-visibility (4/4) — each task independently
D-038-reviewed, red-teamed, gates green in-wave, pushed. Lane B PARTIAL by operator choice: LB-1
and LB-2 fully gated and merged, with the merge result separately verified (build · lint 0 ·
svelte-check 1111/0/0 · 109 targeted tests).

## Parked / next (operator paused the auto-chain 2026-07-26)
1. **`review-and-gate`** — wire `maybeEnqueueReview` (built, zero callers) and reorder the
   pre-commit gate so build/lint/typecheck/test run BEFORE the commit and a failure is honored.
2. **`TASK-BOARD-SPEC` P1** — structured task context to the model. Three files, no migration.
3. **Resume LB-3** from `v2-lane-b` (10 files uncommitted in the v2b worktree, verify-don't-redo)
   then LB-4. Until LB-3 lands, LB-2's naming sits at partial coverage by design.
4. `finish-small-polish` — now carrying the chip wall, the hire-feed error filter,
   `gauntlet.ts:717`, and the stale `spendCaps` test expectation.

**Operator-gated, untouched:** arming a PM · per-hire souls · widening auto-adjudication past B3 ·
any publish/deploy/release · a live gauntlet run.
