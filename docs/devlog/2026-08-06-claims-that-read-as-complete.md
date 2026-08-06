# 2026-08-05/06 — Claims that read as complete, and a record id that was never table-scoped

**Theme:** PAUSE #7 lifted, and the stretch turned out to have one spine running through
almost everything: **a claim that reads as finished and is not.** V1R-1's whole defect class
is a file asserting a doc is live when it is frozen or forked. The `fails.md` fork turned out
to have four ids naming *different failures* depending on which copy you open — and, worse,
one entry (F-019) that was **silently truncated**, so a fork worktree taught the superseded
rule while looking complete. On the code side the same shape: a request-supplied record id
validated by SHAPE ONLY passed every check the codebase had and still reached a bare
`DELETE $rid` — a state machine that is not a table guard, seven times over (**F-062**).

The stretch also produced **three self-corrections**, which is the part worth keeping: an
orphaned-SurrealDB attribution that was correlation and never instrumented, a
"briefs weren't reaching the agents" claim, and the framing of the truncated F-019 as a *live*
hazard when it was a reading hazard only. Each was recorded rather than quietly patched.

The stretch ends with **lane C merged into `v2`, re-gated green, and PUSHED** — `origin/v2` =
`7d88a87` (`b4f58f6..7d88a87`), 357 test files / 6411 passed / 0 failed, every delta reconciled
to its source. (The gate was still in flight when the body below was first written; the End-gate
section records both states rather than rewriting history.)

> **Span.** Continues from
> [2026-08-04/05 — Atelier starts gating its own work](2026-08-05-the-self-gate-and-the-sha-that-lied.md),
> which closed at PAUSE #7 with lane C four commits ahead on a twice-failed tip. Everything
> from `a735078` onward is here. Commit dates read `2026-08-05` (local); the later work and
> the F-061/F-062 `Date` lines read `2026-08-06` (UTC) — same stretch, midnight crossed.

## Shipped

Lane A = worktree `F:\code\ai-playground-v2`, branch `v2`.
Lane C = worktree `F:\code\ai-playground-v2b`, branch `v2-lane-c`.

| task | lane | verdict | commits | headline |
|---|---|---|---|---|
| V1R-1 — retire the v1 residue | C | ✅ finished by asserting the CLASS | `a735078` `5a18a0b` `50166bc` `03f0d4d` `4defceb` `8e82bd4` | Reviewed and FAILED twice before this stretch. Closed not by fixing instance five but by rewriting the guard to scan a corpus. See below. |
| Record-id table scoping | A | ✅ 3 commits, 7 instances | `ef18498` `504c1e4` `3623142` | **F-062.** A well-formed `table:id` from a form reached bare `UPDATE $rid` / `DELETE $rid` / `SELECT … FROM ONLY $rid`. `removeTarget(db,'project:<slug>')` **deleted the project row** and answered `200 {ok:true}`. |
| `resolveProjectTask` lift | A | ✅ shared helper extracted | `3623142` | New `src/lib/server/tasks/scope.ts` (+59). The two red-team finds were fixed by *lifting the scoping into one helper* rather than patching two more call sites — the class fix, not the third and fourth instance. |
| F-019 propagation + self-dating marker | C | ✅ pushed | `c3423e1` `e009cce` | The fork's F-019 restored; fork marker re-measured and rewritten to state its own basis and falsifier. |
| `fails.md` divergence measurement | — | ✅ read-only, no code | `439ffd3` `4ec43b2` | `docs/FAILS-DIVERGENCE.md` (17.7 KB). Full per-id table, hazard, four reconciliation options. Operator-gated. |
| F-060 residual — `.ts` scanners | — | ✅ measured CLEAR, nothing changed | `5b7993b` | Swept every `.ts`/`.js` that reads source text and matches. **AT RISK set is empty.** Recommendation: leave `.gitattributes` alone. |
| Merge lane C → `v2` | A | ✅ **merged, re-gated GREEN, pushed** | `7d88a87` | Parents `3623142` + `e009cce`. Zero conflicts — zero file overlap, not luck. `origin/v2` = `7d88a87`. 357 files / 6411 passed / 0 failed. |

### V1R-1 — the guard skipped the seven files most likely to hold the defect

The task had been reviewed and failed twice, each time because a fix closed one instance and
the re-review found the same string verbatim in a file the fixer had not touched. The guard
written to close the class contained:

```js
if (frozen.has(file)) continue;   // declared history by CLAUDE.md, read as such
```

`frozen` is CLAUDE.md's frozen-snapshot bullet — the **seven planning docs**, i.e. the
highest-yield files in the corpus for a stale liveness claim. The guard skipped all of them
and reported green. Instance five was sitting inside that skip, at
`docs/DEVELOPMENT.md:63`: `docs/fails.md  # failure log — live, append-only`, verbatim the
string already corrected twice elsewhere.

The root cause is an **inversion**: CLAUDE.md calling a doc frozen is evidence *about the doc
being talked about* — it makes claims about that doc checkable. It is not a licence for the
doc *doing the talking*. The frozen list moved from the exempt side to the SUBJECT side, and
there is now no file-level exemption at all. Three further hits were fixed **in the predicate
rather than by exempting the files** — the pressure to exempt is what produced the blanket
`continue` in the first place.

All seven frozen docs also gained their own supersession banner. "This file is history" had
been a fact visible only to someone reading CLAUDE.md, which is the same inherited-claim shape
as the original defect.

### F-062 — a state machine is not a table guard

Seven instances, each found separately: `retagTask`, `moveTask`, `completeSprint`,
`removeTarget`, `launchSession`, `pmWithdraw`, `pmRevise`. The last two were found by the
red-team **on the page the first fix had just hardened** — which is why the third commit lifts
the check into `tasks/scope.ts` instead of patching call sites.

Three false premises, each of which looked like coverage. The load-bearing one: `canTransition`
(`tasks/repo.ts:77`) only asks whether the row's current status string is a key of
`ALLOWED_TRANSITIONS` — so *every* table whose rows carry a matching status string passed it.
Worst observed: `removeTarget` deleting a project row; `pmRevise` **creating a task row in
project B and withdrawing B's original, from project A's route**, reporting `ok:true`.

Promoted to a CLAUDE.md §3 hard rule per the §6 ladder (5th–7th occurrence of one class).

### The `fails.md` ids are ambiguous, and it had already reached code

Measured read-only across all copies. `v2` and `v2b` are byte-identical in id/title sets, so
it is a 2-way divergence: **authoritative 31 entries / head F-061** vs **fork 47 entries /
head F-057** (both measured 2026-08-06, before F-062 landed).

- **Four ids name entirely different failures** depending on the copy: `F-016`, `F-020`,
  `F-045`, `F-046`. PAUSE #7 had recorded two; F-016 and F-020 were unrecorded.
- Branches diverged at `e7828c4` (2026-06-07); each then allocated from **its own head**.
  The m0087 rule ("allocate from the LIVE head") is *unsatisfiable as written* with two live
  heads — each branch obeyed it faithfully and still collided.
- **It has already reached code**: ~240 citations of the four ambiguous ids, and the two
  systems are MIXED inside one worktree —
  `analytics/benchmark/gather.ts:62` cites **F-020** for the ORDER-BY rule while
  `projects/briefs.ts:238` and `workforce/drift.ts:144` cite **F-022** for the same rule.
  A blind id-based renumber would corrupt the citations already using the other system.
- Scale is 26 worktrees, not 3: 23 `atelier/session/*` worktrees carry the fork numbering.
  **25 of 26 copies on disk use the fork's ids; exactly one uses the authoritative ones.**

Precedent, from the fork's own F-020 `Date` line: on 2026-06-11 the fork **already renumbered**
its F-019→F-020 to dodge a collision — and that renumber created today's F-020 collision.
A one-sided renumber relocates a collision; it does not resolve one.

### F-019 was truncated, which is worse than a collision

Body-level diff of all 15 shared ids: 13 byte-identical, one cosmetic (F-056, a provenance
annotation on the `Date` line), and **F-019 missing its `Recurrence (2026-06-11)` bullet** —
~550 bytes, present upstream. That bullet is the one that escalates the stop-marker rule from
case-sensitive matching to a **sentinel PREFIX**. So a fork worktree taught the rule that had
already failed, and taught nothing about the one that replaced it — while the entry read as
complete, same title, same five bullets.

**A collision looks wrong the moment you read both copies. This looked finished.**

Propagated in `c3423e1`. The fork marker was rewritten to state its own basis — *measured
2026-08-06, upstream head F-061 (31 entries)* — plus the explicit consequence that if that head
has moved the list is a **lower bound**, and the admission that **no test in this worktree can
detect that drift**. `e009cce` adds what *is* checkable: the marker must state when/against-what
it was measured, its stated head must be consistent with its absent-list, and the prose list
must agree with `FORKED_ONLY_UPSTREAM`. Both new assertions caught real bugs while being
written (a missing zero-pad `F-61` vs `F-061`; a parser also picking up ids from the bullet's
explanatory prose).

### The damage question — settled, and it was smaller than feared

Whether the truncated F-019 ever *caused* a wave stop. Three independent lines say no, and the
mechanism makes it impossible:

1. `stopRegex` at `.claude/workflows/v2-wave.js:104` is `^`-anchored, landed in `2bd142e`
   (2026-06-11) — **70 seconds** after the only recurrence, and never reverted.
2. **The host exists only on `v2-main`.** `git show v2:.claude/workflows/v2-wave.js` →
   *"does not exist in 'v2'"*; same for `v2-lane-c`. No fork worktree has a host to
   mis-execute. The truncated doc could mislead a *reader*; it could not change what ran.
3. The transcript covering the window (79.5 MB, 40,459 lines, 2026-06-06 → 2026-07-08) shows
   exactly one incident — the known one: `2026-06-11T22:08:02.880Z`, task 16.6, commit
   `db5e280`, **`review: none`** on a `verify: true` build. All later hits are references.

## Migrations

**None this session.** No schema change was made; `src/lib/server/db/schema.ts` was not
touched by any commit in this stretch. Migration head remains **`m0087`** (`m0087_task_tags`,
2026-08-05); next free id is **`m0088`**. No `db:up` was run, and none was required.

## Decisions

- **A record id from a request is TABLE-SCOPED at the repo, never shape-only.** Promoted to a
  CLAUDE.md §3 hard rule (F-062, seven instances, per the §6 ladder). The check belongs
  *inside* the repo function via `assertRecordIdOfTable` (`db/validate.ts`), not at the callsite.
- **Allocate an F-id from the highest head across BOTH copies, never from a branch-local head.**
  The m0087 rule restated so it is *satisfiable* with two live heads. Recorded in CLAUDE.md §0.
- **Leave `.gitattributes` alone.** Pinning `*.ts text eol=lf` would rewrite 699 of 709 `.ts`
  files, would address the *smallest* part of the exposure (the scanners mostly read
  `.svelte`/`.css`/`.md` — 63/13/32 CRLF on disk), and would not retire per-scanner
  normalisation anyway, because the Edit tool's LF→CRLF flip (F-054) reintroduces CRLF *after*
  checkout. Pin where CRLF is fatal (`.mjs`/`.sh`); normalise at the read where it is semantic.
- **No guard for the "reads source text and matches" class.** It would flag four scanners on a
  clean tree, of which **two must not normalise** (`mjs-shebang-eol.test.js`, `env-presence.ts`)
  — a guard that pressures people toward breaking working code. Recommended nothing.
- **`.playground/` is NOT dead v1 state.** V1R-1's own queue entry premise, refuted and left
  refuted. Live readers verified: `workforce/gauntlet.ts:553` (D-018 confinement root),
  `scripts/browser-verify/cli.mjs:203`, `daemon.mjs:40`, `state-file.mjs:1`.
- **Reconciliation of the two ledgers stays operator-gated** (CLAUDE.md §6: mark, never delete).
  Recommended sequence is in `docs/FAILS-DIVERGENCE.md`: disclose everywhere → merge the fork's
  32 divergent entries upstream under NEW ids from the live head → then reduce the fork copies
  to pointers. Deleting fork content first would orphan ~200 citations.

## Bugs / fails

- **F-061** — a vitest run ending in `ERR_IPC_CHANNEL_CLOSED` with **no summary line** is
  UNMEASURED, not red. Logged `e47bbec`, then **corrected** in `b69204f`: sibling contention is
  **sufficient but not necessary** — the `v2` agent's first *solo* re-run died with the same
  signature. The keeper rule does not depend on the cause: *a run without a summary line is not
  a result; re-run it before believing it.*
- **F-062** — shape-only record ids reaching bare whole-record writes. Logged `4e56abe`,
  promoted to a CLAUDE.md hard rule.
- **F-060 residual — measured clear** (`5b7993b`). No `.ts` scanner in `v2b` would pass
  vacuously under CRLF. Four candidates surfaced, all four deliberate or harmless.
- **V1R-1's guard was fail-open by its own rule** — the `frozen.has(file)` skip, above. Not a
  new F-entry; it is an instance of the class F-019/F-060 already name (a check that reports
  green while catching nothing).

## Docs / memory

- **`docs/FAILS-DIVERGENCE.md`** (new, `439ffd3`, extended `4ec43b2` and `3ebc0ba`) — the
  measurement, hazard and reconciliation options. Explicitly supersedes PAUSE #7's smaller
  estimate, which under-counted on three of four axes.
- **`CLAUDE.md` §0** — the Failure-log row rewritten with the ambiguity warning and the
  cross-copy allocation rule. **§3** — the new record-id hard rule (line 101).
- **`docs/fails.md`** (authoritative) — header corrected: the *"synced to both branches so
  every agent sees the full set"* claim had been false since `e7828c4`, for two months.
- **`docs/BUILD-QUEUE.md`** — PAUSE #7 lifted (`02be0ac`), progress recorded against its own
  resume order.
- **Queued: `wave-verdict-retention`** — flagged as a dependency of the roadmap-changelog
  deliverable. Wave verdict payloads are **not persisted anywhere**: zero `"deviation":` fields
  across the whole transcript corpus. The 2026-06-11 deviation text survives only because
  someone ran a one-off `node` dump at the time. We cannot audit wave stops after the fact.

## End-gate — PARTIAL, and unresolved at time of writing

| gate | where | result |
|---|---|---|
| `npm run build` | `v2b` @ `8e82bd4` | ✅ clean |
| `npx eslint .` | `v2b` @ `e009cce` | ✅ **0** |
| `svelte-check` | `v2b` @ `e009cce` | ✅ **0 errors / 0 warnings** (1141 files) |
| `npx vitest run` (full) | `v2b` @ `03f0d4d` (baseline) | ✅ 334 files passed / 10 skipped; **6008 passed / 20 skipped**; exit 0 |
| `npx vitest run` (full) | `v2b`, working tree = `8e82bd4` content | ✅ 334 files passed / 10 skipped; **6013 passed / 20 skipped**; exit 0 |
| targeted | `v2b` @ `e009cce` | ✅ `docs-pointers.test.ts` 17/17; `launch-fixtures` + `edit-scope` 115/115 |
| **full suite on the merge** | `v2` @ `7d88a87` | ✅ **RESOLVED after this was written — GREEN and PUSHED.** `Test Files 357 passed \| 1 skipped (358)` · `Tests 6411 passed \| 10 skipped (6421)` · 0 failed · exit 0 · 116.95s. Plus `build` OK, `lint` **0**, `svelte-check` **1164 files / 0 errors / 0 warnings**. `origin/v2` = `7d88a87` (`b4f58f6..7d88a87`), worktree clean, 0 ahead — verified independently. |

The +5 between the two full runs is exactly this guard growing 9→14 tests; no pre-existing
failures existed to inherit. **Every count above is attributed to the commit it was measured
on** — per F-060, a count without its commit is not a result.

**Resolved after writing: the merge re-gate came back green and `v2` is pushed.** `origin/v2` =
`7d88a87`. **Every delta reconciled to its source with nothing left over** — +7 files / +146 tests
against `b4f58f6` (2 from the subject commits, 0 from `3623142` which appended to an existing file,
5 from the lane C merge; +146 = 20 + 4 + 57 from five new files + 65 from lane C's expanded existing
suites). **File count rose against BOTH baselines — no suite went missing**, which is the check that
matters after F-060. The 1 skipped file (`scripts/browser-verify/daemon.live.test.ts`) **collected
its 5 tests and skipped them** — an honest environment gate, not the zero-collection shape. And
lane C's `docs-pointers.test.ts` **passed against the `v2` docs copy on its first run there** (17/17),
so that guard does not find this copy wanting.

**One process note worth keeping.** The first full-suite attempt returned **exit 0 with a zero-byte
log** — piped through `tail`, which buffers to EOF. Reported as UNMEASURED, not green, and re-run
with a direct redirect. Then the re-armed watcher **fired a FALSE POSITIVE**: a case-insensitive
`FATAL` matched `fatal: Needed a single revision`, git output from *inside a test*. It was checked
against the log rather than trusted, and re-armed anchored and case-sensitive. **A watcher tuned too
broadly manufactures red exactly as a watcher tuned too narrowly manufactures green** — and this is
the same `fatal:`/git-fixture text that appears as the unexplained lead in F-061's log tail, which
is worth remembering before that lead is over-read.

## Parked / next

**Not operator-gated — can proceed:**
- Push `v2` once the merge re-gate lands green (28 commits, `b4f58f6..7d88a87`).
- `wave-verdict-retention` — persist each `buildStop` reason + verdict `deviation` to a run log.
  Named, not designed. Blocks after-the-fact auditing of wave stops today.
- The fork copy in `F:\code\ai-playground-v2` still carries the **pre-fix F-019** and no fork
  marker at all — its header still claims it is the full set. It inherits both when the merge
  lands and sessions are recreated; until then a builder there reads the superseded rule.
- `src/routes/projects/create/run-nav.test.ts:40` is CRLF-safe only *incidentally*. A one-line
  normalisation would make it safe by design. Deliberately not committed pre-merge.

**Operator-gated:**
- **`fails.md` reconciliation** — all four options in `docs/FAILS-DIVERGENCE.md`. Renumbering
  rewrites ids that ~440 code citations and several docs depend on; CLAUDE.md §6 reserves
  retirement to the operator.
- **`toolpolicy-enforcement`**, **`COUNCIL-SPEC` P1** — unchanged from PAUSE #7.
- The **roadmap-changelog** standing deliverable, whose sources this session materially
  extended (and whose one new dependency is the retention gap above).

## Corrections to the record (found while writing this, with evidence)

1. **`CLAUDE.md:28` is stale, and self-contradictory within one line.** It states the
   authoritative `fails.md` has *"31 entries, head **F-061**"* while the same line says
   *"Allocate a new id from the highest head across BOTH copies (today F-062+)"*. Measured now:
   **32 entries, head F-062** — `4e56abe` appended it after the Geography row was written. So
   the head claim is stale by one and the "today F-062+" clause is also wrong: the next free id
   is **F-063**. This is the m0087 rule biting the document that states the rule, and it is the
   same drift-by-one that hit the fork marker within a day.
2. **The suite count recorded for `03f0d4d` does not match a second measurement of the same
   commit.** `docs/BUILD-QUEUE.md:86-87` records *"the tip `03f0d4d` measured 6011 passed"*.
   I measured **6008 passed / 20 skipped** on that same commit. Both runs exited 0 with a
   summary line, so neither is UNMEASURED in the F-061 sense; the likely difference is
   skip-gated live tests (20 skipped vs the 17 recorded for `6ecc350`). Recorded rather than
   reconciled — I did not re-run to settle it, and per F-060 the honest form is *which
   measurement, on which commit, in which environment*, not a single number.
3. **This devlog's own fork-marker numbers are already one behind.** The marker in
   `v2b/docs/fails.md` says *upstream head F-061 (31 entries)*; upstream is now F-062 / 32.
   That is the marker's dated-basis design working as intended — it discloses that it may be a
   lower bound — and the guard's internal-consistency tests correctly do **not** fire, because
   they cannot see upstream. Noted so the next reader does not mistake it for a defect.

Three earlier self-corrections from this stretch are recorded at their source rather than here:
the orphaned-SurrealDB attribution (superseded inside F-061 itself), the "briefs weren't
reaching the agents" claim, and the F-019 live-hazard framing (`3ebc0ba`).
