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
- **Holes in every copy:** F-003, F-004 — never existed anywhere.

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
   visible in every copy a reader can open. *(AUTH + CLAUDE.md done 2026-08-06; V2 pending —
   held only because a red-team is live in that worktree.)*
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

## 5. Open questions (what this measurement could NOT settle)

- **Whether the auth-sense citations inside fork worktrees were deliberate.** Strong inference
  (agents read the authoritative CLAUDE.md while sitting in a fork worktree) but not proof.
  Settle with `git log -S` per citation → authoring commit → whether that agent had AUTH in context.
- **`src/lib/server/config/load.test.ts:190`** — *"WI-4 regression (F-016 false-premise class)"*
  matches **neither** F-016 title cleanly. Settle by reading the WI-4 brief or its commit.
- **Whether 4 is the complete collision set.** The comparison was by *title* similarity; two
  entries could share an id and a similar title while documenting different failures. Settle
  with a body-level diff of the 15 "shared and consistent" ids.
- **Whether any *remote* branch carries a third numbering.** Only local worktrees and branches
  were enumerated; `grep`-negative ≠ absent.
