# `fails.md` cross-branch divergence — measurement, hazard, and reconciliation options

**Measured 2026-08-06** (read-only; nothing was modified to produce this). Supersedes the
smaller estimate recorded in `docs/BUILD-QUEUE.md` PAUSE #7, which under-counted on three
of four axes. **Reconciliation is operator-gated** — CLAUDE.md §6 is explicit that entries
are *marked, never deleted*, and only the operator retires one.

---

## 1. The divergence, enumerated

Three on-disk copies, but only **two** numbering systems:

| copy | path | entries | head |
|---|---|---|---|
| **AUTH** | `F:\code\ai-playground\docs\fails.md` (`v2-main`) | 31 | F-061 |
| **V2** | `F:\code\ai-playground-v2\docs\fails.md` (`v2`) | 47 | F-057 |
| **V2B** | `F:\code\ai-playground-v2b\docs\fails.md` (`v2-lane-c`) | 47 | F-057 |

V2 and V2B have **identical id+title sets** — 0 differences. They differ only by the ~1.5 KB
fork marker lane C added to V2B. So this is a **2-way** divergence, not 3-way.

59 distinct ids across both systems: 15 shared-and-consistent + 4 colliding + 12 AUTH-only
+ 28 FORK-only. (AUTH 15+4+12 = 31 ✓; FORK 15+4+28 = 47 ✓.) No duplicate ids *within* a copy.

- **Shared and consistent (15):** F-001, F-002, F-005, F-006, F-007, F-008, F-009, F-010,
  F-011, F-012, F-013, F-014, F-015, F-019, F-056.
- **AUTH-only (12):** F-048, F-049, F-050, F-051, F-052, F-053, F-054, F-055, F-058, F-059,
  F-060, F-061.
- **FORK-only (28):** F-017, F-018, F-021–F-044 (24 contiguous), F-047, F-057.
- **F-003, F-004 are NOT holes** (corrected 2026-08-06). They exist in the **v1 lineage** on
  `origin/dev` — F-003 *"Deleted module without tracing all imports"*, F-004 *"Daemon `--quiet`
  flag causes silent crash"*. They were simply never carried into v2, even though both v2 copies
  state that F-001..F-012 are "carried from v1": **ten of twelve came across.** The v1 numbering
  is the **ancestor** of the v2 shared core (F-001/F-002/F-005..F-012 are the same failures, some
  retitled), not a competing system.

### Worse than a collision: same id, same failure, DIVERGED prevention rule

A body-level diff of all 15 shared ids (AUTH vs V2B) confirms **4 is the complete collision
set** — 13 are byte-identical, F-056 differs only by a provenance annotation on its `Date` line.
But it surfaced a defect class the id-level comparison could not see:

**F-019 is not a collision** — same title, same failure, all five shared bullets byte-identical —
**yet AUTH carries a sixth bullet the fork does not have**: `Recurrence (2026-06-11)`, ~550 bytes.
It records that the case-sensitive fix false-matched again on a **negated** caps mention ("No
BLOCKED/CONFLICT items" in a green build's deviation stopped wave v2.1), and escalates to the
structural fix: **markers count only as a sentinel PREFIX at the start of the deviation**
(`/^\s*(CONFLICT|BLOCKED|...)/`), with builders instructed to BEGIN the deviation with
`BLOCKED:`/`CONFLICT:`. Its lesson — *substring presence is never intent; only position plus
convention is.*

**A builder in a fork worktree who opens F-019 gets the superseded guidance and no signal that
the entry is truncated.** The sentinel-prefix form is what CLAUDE.md §4/§6 states as the hard
rule and what our own briefs use. **A collision at least looks wrong when you read it; this reads
as complete and is not.** Consequence for the plan: **the merge step must be body-level, not
id-level** — "same id, same title" does not imply "same guidance", so the 15 shared entries
cannot be assumed safe and skipped.

**Propagating F-019's recurrence bullet to the fork copies is worth doing on its own merits,
independent of the renumbering decision** — it is additive, retires nothing, and closes a live
hazard.

### The headline: FOUR ids name different failures

| id | AUTH means | FORK means |
|---|---|---|
| **F-016** | workflow host tolerates ONLY a leading `export const meta`; any other export is a load-time SyntaxError | an unhandled ChildProcess `'error'` event crashed the whole dev server |
| **F-020** | seeding SCHEMAFULL tables in tests trips three SurrealDB write-path gotchas — **carries the ORDER-BY-in-projection rule** | dev-server keyboard/SSE assertions race client hydration |
| **F-045** | `orchestration.yaml` declared code-write capabilities absent from the live catalog → every code-write spawn fail-closed (D-036) | `DEFINE FIELD … TYPE bool DEFAULT false` does not backfill existing rows |
| **F-046** | isolated `CLAUDE_CONFIG_DIR` keyed by agent SLOT not session → concurrent same-slot sessions corrupt `.claude.json` | Svelte 5 `$effect` reading the `$state` it wrote self-loops → `effect_update_depth_exceeded` |

### Corrections to what the queue recorded

| queue said | measured |
|---|---|
| F-045/F-046 are different failures per copy | **4 collisions, not 2** — F-016 and F-020 were unrecorded |
| forks lack F-049..F-055, F-058, F-059 (9) | forks lack **12** — F-048 was also missing, plus F-060/F-061 |
| docs copy has a gap at F-057 | **confirmed** (AUTH jumps F-056 → F-058) |
| — | V2B's fork marker was **already stale by one** within a day (names F-060, not F-061) |

### Two disclosure asymmetries nobody had recorded

- **V2 carries NO fork marker at all.** Its line 9 read *"synced to both branches so every
  agent sees the full set."* Any agent building in that worktree is reading a copy that
  actively asserts its own completeness.
- **AUTH disclosed nothing either** until this measurement. Only V2B told the truth, and only
  because lane C put the marker there.

### Scale: the authoritative copy is the rare one

`git worktree list` shows **26 worktrees**. The 23 `atelier/session/*` session worktrees each
carry a `fails.md`, all byte-identical to the FORK numbering. **25 of 26 worktrees on disk
carry the fork numbering; exactly one carries the authoritative numbering.**

---

## 2. How it happened

`git merge-base v2 v2-main` = **`e7828c4` (2026-06-07)**. Shared history, then independent
appends, each branch allocating the next free id **from its own copy's head**, with no shared
registry:

| id | one side | other side |
|---|---|---|
| F-016 | `v2-main` `3cd2755` (2026-06-10) | `v2` `16e8283` (2026-06-10) — same day |
| F-045 | `v2` `9d77cb0` (2026-06-20) | `v2-main` `93eb4e3` (2026-06-22) |
| F-046 | `v2-main` `b027717` (2026-06-22) | `v2` `3add9b6` (2026-06-22) — same day |

**This is the m0087 paper-reservation shape with one extra twist that makes it worse.** For
migrations there is one file on one branch, so "allocate from the LIVE head" is well-defined.
Here there are **two live heads**, so the rule as written is *unsatisfiable* — each branch
obeyed it faithfully and still collided. The rule has been restated in CLAUDE.md §0 to be
satisfiable: allocate from the highest head **across both copies**.

**The precedent is the strongest argument in this analysis**, and it is recorded in the fork's
own F-020 `Date` line: on **2026-06-11 the fork already hit this and already renumbered** — its
F-019 became F-020 because `v2-main` had taken F-019 on 2026-06-10. That local renumber fixed
F-019 and **immediately created today's F-020 collision** when `v2-main` later took F-020 on
2026-06-19. **A one-sided renumber does not resolve a collision; it moves it.**

---

## 3. The hazard has already reached code

The four colliding ids are cited in `v2` source/config/tests **~240 times**: F-016 15×,
F-020 142×, F-045 40×, F-046 43×. Worse, **the code mixes both numbering systems inside one
worktree**:

| citation | sense used |
|---|---|
| `claude-code/channel.ts:457`, `channel.test.ts:129`, `cli-backend.proto.test.ts:243` | **FORK** F-016 (spawn failure must be an honest event, not a crash) |
| `config/orchestration.yaml:125`, `agent/tool-catalog.ts:178` | **AUTH** F-045 (catalogued-capability rule) |
| `config/orchestration.yaml:40` | **AUTH** F-046 (supersedes the perProject=1 stopgap) |
| `analytics/benchmark/gather.ts:62` | **AUTH** F-020 — the ORDER-BY rule |
| `projects/briefs.ts:238`, `workforce/drift.ts:144` | **FORK** F-022 — *the same ORDER-BY rule* |

**One rule is cited in one worktree under two different ids.** That is the doc divergence
having already become a code-level ambiguity, and it is why **any id-based mechanical fix is
unsafe**: a blind renumber would corrupt the citations already using the other system. Every
citation must be audited **by meaning, not by id**.

### Nobody made an error — the chronology explains the mix

A 7-citation sample (5 auth-sense, 2 fork-sense) traced to authoring commits shows **perfectly
clean branch containment**: all 7 citation commits are on `v2`; both `fails.md` logging commits
are on `v2-main` only. And the dates separate the two senses without appealing to intent:

**every fork-sense citation PREDATES the corresponding AUTH entry, and every auth-sense citation
POSTDATES it.** F-022 was cited on 06-11 and 06-16; AUTH F-020 was logged 06-19. `296dd86` cites
F-045 on **2026-06-22 — the same day** `93eb4e3` logged AUTH F-045 on `v2-main`, and cannot have
meant the fork's F-045 (bool DEFAULT), which had existed since 06-20.

**Mechanism:** CLAUDE.md is authoritative, lives on `v2-main`, and cites ids in AUTH numbering.
Agents read it, then write those ids into fork-worktree code where the local ledger means
something else. Fork-native ids survive from before the AUTH entry existed. **The id space simply
is not global** — which is the thing to fix, not the agents.

Confirming case: `src/lib/server/config/load.test.ts:190` — *"WI-4 regression (F-016 false-premise
class)"* — is **auth-sense and correct**, not a miscitation. Authoring commit `7dabe12`
(2026-06-24) matches AUTH F-016's `Fix` bullet phrase *"corrected the comments that encoded the
false premise"*; the fork's F-016 (ChildProcess crash) contains no occurrence of "premise" or
"comment" anywhere in its body. It is a correct citation that is **unresolvable in the worktree it
lives in**.

### No third numbering exists

`git ls-remote --heads origin` → 7 heads. `origin/v2-lane-b` carries fork numbering and is an
ancestor of `origin/v2` (no independent numbering). `origin/main` has no `docs/fails.md`.
`origin/dev` (12 entries) and `origin/feature/real-data` (7) are v1-era. **No third v2-era
numbering.**

---

## 4. Reconciliation options

**(a) Renumber the colliding ids on the fork side; leave AUTH untouched.**
Breaks the 240 citations *unevenly* — F-016's are fork-sense and would need updating;
F-020/F-045/F-046's are auth-sense and must NOT be touched. The 2026-06-11 precedent shows a
one-sided renumber relocates the collision. Leaves the 28 fork-only entries still absent
upstream. **Not sufficient alone.**

**(b) Make the v2 copies pure pointers; delete their content.**
Breaks catastrophically **if done first**: the 28 fork-only entries are heavily cited
(F-022 16×, F-025 21×, F-026 35×, F-029 35×, F-040 20×, F-042 34×, F-057 9×, …). Deleting them
orphans ~200 citations, and it violates CLAUDE.md §6 *mark, never delete*.
**Correct as an END STATE, never as step 1.**

**(c) Keep the fork; make the marker machine-checkable.**
Cheap and non-destructive, and partly exists — but the V1R-1 guard deliberately does not read
the docs checkout (portability), so it validates the marker's *internal* consistency only,
which is why it went stale by one within a day. Leaves 4 collisions ambiguous forever and
leaves code citing two systems. **A safety net, not a fix.**

### Recommended: sequenced (c) → merge-with-reallocation → (b)

1. **Now, cheap, non-destructive.** Propagate a fork marker to V2 (which currently claims
   completeness), disclose the fork in AUTH, refresh V2B's marker. Makes the divergence
   visible in every copy a reader can open.

   **Status 2026-08-06 — DONE except V2.**
   - **AUTH** — fork disclosed in the header; `CLAUDE.md` §0 restates id allocation satisfiably
     (`439ffd3`, `4ec43b2`).
   - **V2B** (`v2-lane-c` `c3423e1`, `e009cce`) — **F-019's `Recurrence (2026-06-11)` bullet
     propagated**, so the fork copy now teaches the sentinel-prefix rule instead of the
     case-sensitive one it superseded. Marker re-based: absent-id list corrected to 12, and it
     now **states its own basis** (measured 2026-08-06 against upstream head F-061) **and its own
     falsifier** — if that head has moved, the list is a LOWER BOUND, re-measure. It also states
     its blind spot in the file: *no test in this worktree can detect that drift*, because the
     guard deliberately does not read the docs checkout. An honestly-dated claim beats a
     confidently-wrong one.
   - **Staleness assertion — added for what is actually checkable, and nothing more.** Upstream
     drift is undetectable without reading the other copy, which would break the guard's
     portability *and* repeat the "assume the other copy" mistake this whole file documents. What
     *is* checkable is the marker contradicting **itself**, which is how a re-measure really goes
     wrong — half-finished. Three assertions: the marker must state when and against which head;
     the stated head must be consistent with the absent list (no id above it; the head itself
     accounted for); and the prose list must agree with the `FORKED_ONLY_UPSTREAM` constant.
     **Both new checks caught real bugs while being written** (a missing zero-pad `F-61`, and ids
     named twice in one bullet) — they bite.
   - **V2 — still pending**, held only because a red-team was live in that worktree.

   **Standing consequence until the merge lands:** the F-019 truncation is still present in
   `F:\code\ai-playground-v2` and in all 23 `atelier/session/*` worktrees. They inherit the fix
   when `v2-lane-c` merges into `v2` and sessions are recreated. **Until then a builder in any of
   those worktrees is reading the superseded stop-marker rule** — the one that false-matched on a
   negated caps mention and stopped a green wave.
2. **The fix.** Merge the fork's 32 divergent entries (28 fork-only + the fork's 4 collision
   meanings) into the authoritative copy under **NEW ids allocated from the live head
   (F-062+)**. Do not renumber on the AUTH side — it is the smaller set and the one CLAUDE.md
   cites. Keep a permanent, machine-checkable old→new redirect table in the fork copies
   (mark, never delete).
3. **Then (b).** Reduce the v2 copies to pointers once every entry exists upstream.
4. **Prevent recurrence.** A guard asserting global id-uniqueness across copies, plus the
   CLAUDE.md §0 rule (already added): ids come from the highest head across both copies, never
   from a branch-local head.

### What a renumber would require updating — state this before approving one

- ~240 code/config/test citations of F-016/F-020/F-045/F-046, **audited by meaning, not id**,
  plus ~200 more citing fork-only ids.
- `CLAUDE.md` §3/§4 — lines 101, 113, 116, 124, 130 cite all four colliding ids.
- The fork marker itself; `docs/BUILD-QUEUE.md` PAUSE blocks; `docs/devlog/*`.
- The `FORKED_ONLY_UPSTREAM` / `FORKED_ONLY_LOCAL` constants in `src/docs-pointers.test.ts`.
- The 23 session worktrees — these pick it up naturally as they are recreated from `v2`.

---

## 5. Open questions

**Closed 2026-08-06** (all four of the original items — see §1 and §3 above): 4 IS the complete
collision set; `load.test.ts:190` is auth-sense and correct; the auth-sense citations are
explained by chronology, not error; no third numbering exists. The body diff also *added* the
F-019 finding, which is why it was worth running.

**Still open:**

- **Whether the other 28 fork-only and 12 auth-only entries carry recurrence bullets that were
  never propagated the way F-019's was.** Only the 15 *shared* ids were body-diffed. Settling this
  needs **semantic** matching of subject matter across entries that exist in one copy only — not
  id matching — so it is not cheap. **This is the residual risk in the whole analysis**: F-019
  proves at least one live hazard of this shape exists, and nothing rules out others.
- **Whether F-019's missing recurrence has already caused a wave stop in a fork worktree.** Settle
  by grepping wave-run logs for a non-sentinel `BLOCKED`/`CONFLICT` false-trigger after
  2026-06-11. Not looked at.
