# 2026-08-04/05 — Atelier starts gating its own work, and a sha stops determining the bytes

**Theme:** the studio finally applies its own Definition of Done to itself. `4ba14c1` is the
first commit in this repo's history where **Atelier reviews and gates agent work BEFORE it
asserts that the work landed** — closing the only correctness finding of the 2026-07-26
operator review. The gate then spent the rest of the stretch catching *its own* defect class:
**a verdict that describes the ENVIRONMENT rather than the change.** Six instances, two of
them holes the gate was built to close (F-055 around it, F-007 through it). In the other lane,
the longest-running "it passes for me / it fails for me" argument on this project was
root-caused into **F-060**, whose real content is not CRLF — it is that **a red file which
collected zero tests is a MISSING suite, and the green count was overstating coverage.**

The stretch ends with lane A pushed and green, and **lane C four commits ahead of its remote
on a tip whose own review failed twice.**

> **Span.** Continues from
> [2026-07-26/27 — Two lanes to completion](2026-07-27-parallel-lanes-and-a-green-suite.md),
> which closed at PAUSE #5. Between the two: the lane-B merge and the 26-commit push that made
> `origin/v2` = `fbcb8d0` (`922c7e3`), then PAUSE #6. Everything from `4ba14c1` (08-04 17:18)
> onward is here.

## Shipped

Lane A = worktree `F:\code\ai-playground-v2`, branch `v2`, holds the migration slot.
Lane C = worktree `F:\code\ai-playground-v2b` (the lane-B worktree, re-pointed), branch
`v2-lane-c`, :5174, no `db:up`.

| task | lane | verdict | commits | headline |
|---|---|---|---|---|
| PCG-1 (the pre-commit gate) | A | ✅ gated + **PUSHED** | `4ba14c1` `5f43aeb` | build→lint→typecheck→test now run **before the terminal transition, the ok completion event, and merge-back** — and a red gate PRESERVES the branch instead of fast-forwarding it. Deliberately does NOT gate the *commit*: committing is preservation, **merging is the assertion** (F-007). Also wires `maybeEnqueueReview` (`review.ts:115`), fully built since TASK 2.8 with **zero production callers**. |
| RG-1 (the gate's own class) | A | ✅ review FAIL → fix ×2 | `bcb1bad` `6878d14` | Both of the gate's first verdicts **described the environment, not the change**: it ran `npm` in a worktree with no toolchain, and the review diffed HEAD *after its own commit had cleaned the tree*. Then the fix's own fix: the merge hold keyed on `'skipped'`, which the toolchain pre-flight had given a SECOND meaning one commit earlier — **every large npm change would be held forever**. |
| RG-1 close-out | A | ✅ four more sites, each proven by execution | `11baf72` | The follow-on review of the tip. Four more instances of the same defect, incl. **the one that defeated the feature** (below) and the cargo/go/dotnet ENOENT wedge. +17 tests, all against the real runner / real git / real SurrealDB. |
| RG-1c (the tip had never been re-reviewed) | A | ✅ review PASS | `64ec4a4` | Four more: the explicit-path exemption skipped the WHOLE pre-flight instead of just the PATH probe; **one `catch` spanning the entire post-task block spoke for all of it**, so a fault *downstream of a green gate* stamped "the gate produced NO verdict" with a verdict in hand. New `post-task-faulted` state; the decision extracted as the pure `resolveSessionExitState`. |
| TB-1 — TASK-BOARD P1 | A | ✅ build → review FAIL → fix ×2 | `3de12c4` `ab0e9b9` `93358a4` `55dd3a5` | Structured task context reaches the model: `## Objective` / `## Why this task` / `## Acceptance criteria` / `## Task metadata`, plus the widened launch SELECT so the brief exists to send. Review caught a **D-026 prompt-injection**: `escapeBriefText` anchored on `^\s*`, so `> ## Acceptance criteria` behind a container prefix bypassed all three escapes and **forged a section**. |
| TB-2 — TASK-BOARD P2 (**m0087**) | A | ✅ build → review FAIL → fix ×2 | `9e6f81d` `cdd1005` `6b5ed91` | `task.tags` as **prompt payload**, not decoration, with the operator authoring path shipped early (every live task predates the column). Review caught `retagTask` guarding its id with the **SHAPE-only `assertRecordId`**, so a bare `UPDATE $rid MERGE` **landed on whatever table the id named**; and `normalizeTags` enforcing its count bound as a POST-condition, running an O(n²) dedup over the entire unbounded input first. |
| TB-3 — TASK-BOARD P3 | A | ✅ build → review FAIL → fix ×2, **tip** | `a3766ee` `a21c626` `90b5748` `e26a1dc` `cd515c5` `80b6832` `b4f58f6` | The board at `/projects/[id]/tasks` + full-page detail + the a11y gate that measured it. Review caught a completeness panel making two false claims (the row→wire projection dropped `provenance.authority`; `proposed_by` shipped a bare `pm.id` with its name un-joined one FK away), then the action banner composed from **the write's own request instead of the live row**, and a disabled chip conveying state through an opacity the contrast gate structurally cannot see. |
| DS-2 + LC-1 — concierge stream | C | ✅ red-team FAIL → fix | `31813d8` `b226a9a` `46b078f` | The concierge LLM stream is cancellable — a wedged provider no longer leaks a suspended generator for the process lifetime. Red-team's find: the turn's teardown was **sequenced BEHIND an unbounded metering DB write**. |
| LC-2/3/4 — the hiring-honesty cluster | C | ✅ (reviewed later, in LC-C) | `be4fa6b` `f49e670` `beff950` `f55fe91` | A run-fetch cap dropped pointers **silently**, and each dropped row then rendered the honest-looking `run not found` — *an honest state produced by a dishonest cause*. A header counting **36** beside a list rendering **17**. And **the stranded paid run**: resolving the adjudication queue finalized an `interview_run` and never told the proposal, so the only route to a comparison was a SECOND real gauntlet spend for a verdict already on disk. |
| LC-C / LC-C2 / LC-D — the close-out | C | ✅ review + red-team, three passes | `5bcd5af` `e7bd1de` `c2873e5` `aac3cf0` `0ba5c2b` | The reconcile fix **re-created the harm it was built to prevent** — see below. Plus: the error ladder documented coverage it did not have (`ProposalStatusError` is a plain `Error`, so the most caller-facing refusal in the machine still answered "the server broke"), and an unguarded free path that could land an INCOMPARABLE verdict on the one-way `compared` status. |
| F-060 — the CRLF root cause | C | ✅ | `31d4ce3` `9a02d1a` | `.gitattributes` pinning `*.mjs`/`*.sh` to LF + a guard test naming any offending file with its repair command. **Recovered 53 tests that had been contributing zero.** |
| RB-1 — the honest baseline | C | ✅ review FAIL → fix ×2 | `cdd51d1` `6ecc350` | Settled the direct contradiction about the red test files. The new F-020 detector **parsed TypeScript as if it were SQL**; then it judged an UNRESOLVABLE projection as a violation (a projection it cannot resolve is *declined, not judged* — 260 files swept, 116 → 114 ordered statements). |
| V1R-1 — retire the v1 residue | C | ⛔ **NOT FINISHED**, tip unverified, unpushed | `a735078` `5a18a0b` `50166bc` `03f0d4d` | A whack-a-mole. Refuted its own queue entry's premise, then **authored a lying pointer while fixing lying pointers.** See below. |
| COUNCIL-SPEC | — | design only, no code | `c79a7d5` (docs) | The validation panel becomes a council. Externally researched, and the research **contradicted the obvious design**. |

### The one that defeated the feature

`orchestrator.ts` `#runItem`'s post-task `catch` is best-effort **by design** (F-014) — but
`gateFailed` and `reviewHeld` then stayed `false`. So merge-back computed exit state `done`
and **fast-forwarded the branch into the project branch with an ARMED gate that never returned
a verdict**: a gated state change reached by a path around the gate (F-055), firing precisely
when something had already gone wrong.

It is worse than that. The fault lands *before* the commit, so the branch carries no new
commits — and the `done` path reads that as `noop-empty` and **TEARS THE WORKTREE DOWN,
deleting the agent's uncommitted work** (F-007). Two of this repo's named traps, in one code
path, on the success route of the feature meant to prevent unverified merges.

Closed with a new `gate-unknown` exit state riding the **SAME** `exitState !== 'done'` preserve
branch — no second preserve path (F-055) — armed only when a gate actually ran, so the un-wired
case stays byte-identical (F-053). Proved by flipping the flag off and watching the new test
fail. `64ec4a4` then found that `gate-unknown` itself **asserted a fact it did not observe**,
because `postTaskFaulted` was set by a catch spanning gate + transition + commit + review +
completion-event + game-verify, and was read as "no gate verdict exists". The verdict now
arrives through a `gate.onVerdict` notification the moment it exists, so it survives a throw
from anything downstream.

### "The gate is npm-shaped, and the mechanism never was"

`execFileRunner` reports a spawn ENOENT for **any** program as `{code:1, stdout:'', stderr:''}`
— re-verified by execution, not by reading. So a `cargo`/`go`/`dotnet` project on a host
without that SDK got a **RED gate with an EMPTY reason**: task `failed`, branch preserved,
never merged, and **the change took the blame for a missing toolchain**. `cargo` is absent on
this host — this was live, not hypothetical. npm was simply the ecosystem someone looked at.
The PATH/shim question is answerable for every program by the same scan, so it is now asked of
every one.

Two smaller siblings rode along: `countChangedFiles` returned `0` for both "touched nothing"
and "git could not be asked" (it now returns the count **and** `measured`), and `branchExists`
was `code === 0`, so an unreadable repo root read as `noop-gone` — "already reconciled, nothing
to see" — about a gate-failed session. Instrumented first: `show-ref --verify --quiet` exits 1
for an absent ref and 128 for a repo fault, so the two **are** separable.

### The reconcile fix re-created the harm it was built to prevent

LC-4 gave `compared` a **second writer**, and the absorb branch under it silently discarded the
paid one. LC-C2 named a refusal for it — and the refusal fired only when the row was *already*
`compared` at `setProposalStatus`'s own read, while the write underneath it was unconditional.
A rival landing between that read and that write went straight through the refusal and was
overwritten in silence: a TOCTOU, with `regauntletChallenger` reading status once and then
**spending money**.

Closed with a compare-and-swap — the UPDATE now carries the observed status *plus the observed
value of every field it means to set*, so a rival that moved the row matches nothing, zero rows
come back, and the write is decided again, once, against real state. A second miss is sustained
contention, not a race (bounded, no spin, F-014). Who loses is decided deliberately: **paid
beats free, and the free path's loss is a named outcome (`superseded`) — nothing written,
nothing spent, never an exception the route turns into a server fault.**

**It was tested as a race, not as a sequence: the rival writer is fired from inside `db.query`
immediately before the UPDATE reaches a real SurrealDB — the exact window, every run.** That is
the standard for a concurrency fix here, the way `a4b36e7`'s mutation proof is the standard for
a guard test.

### F-060 — a sha does not determine the bytes on disk

The best diagnostic work of the stretch, and its lesson is not about line endings.

`core.autocrlf=true` with **no `.gitattributes`**: git stores LF, materialises **CRLF** into
the working tree on checkout, and normalises CRLF back to LF on the way in — so `git status` is
**clean in both states**. Git actively hides the difference. One worktree still held its
authored LF bytes because those files had never round-tripped through a checkout; the other was
created by `git worktree add`, whose checkout applied the conversion. **Two agents measured the
same commit and got opposite, both-correct answers**, and the three suites are byte-identical
*in the commit*.

It bites `.mjs` specifically because vite/vitest does **not** run esbuild over `.mjs`, and its
shebang strip does not survive a CRLF terminator — so `#!/usr/bin/env node\r\n` throws
`SyntaxError` at **collect** time, reported against the *importing test file*, which then
collects **zero tests**. `node --check` passes on both forms; nothing short of running vitest
could see it.

**The reporting lesson is the payload.** 9 of 18 tracked `.mjs` files were affected — 3
breaking, 6 latent — and the repair recovered **53 tests that had been contributing nothing**
while the reporter called them merely "failing files". A red file that collected no tests is a
**missing suite**, and the green count was overstating **coverage**, not just colour. When
reporting a baseline, "N failed" and "N never ran" are different facts.

The fix is narrow on purpose (`*.mjs`, `*.sh`) — a blanket `* text=auto eol=lf` would
renormalise the whole tree in one commit. **Residual: `.ts` source-text scanners still need the
F-054 normalisation.**

### V1R-1 — the fix that authored the defect it was fixing

Not finished, and honestly so. It **refuted its own queue entry's premise**: `.playground/` is
NOT dead v1 state and must not be deleted — `workforce/gauntlet.ts:553` uses it as the D-018
ephemeral confinement root and `scripts/browser-verify/*` keeps daemon discovery state there.
Deleting it would have broken the gauntlet.

Then the task was "fix pointers that lie" and the fix **authored a lying pointer** — a fresh
line calling `docs/fails.md` "still live and append-only in this worktree" when that copy is a
fork, planted by this same wave's `a735078`, inside the *Related pointers* section of a file
whose entire job is to point correctly. Each fix closed one instance; each re-review found it
verbatim in a file the fixer had not touched (a 4th, then a 5th). The root cause is stated
plainly in `03f0d4d`: **the fix commit searched for the two literal phrasings it had just
authored, rather than for the CLAIM** — and grep-negative on a symptom is not absence of the
class. The guard written to close the class was **fail-open on that very instance**, by a rule
the same commit authored.

It also produced the one genuinely useful measurement in the pile: the `fails.md` cross-branch
fork claim was **a range presented as a measurement**, and false for four ids. The true
only-local set is **28 ids** (F-017, F-018, F-021..F-044, F-047, F-057), now enumerated
id-by-id rather than as a span, because that list is the input to an operator-gated re-unification
and merging per the old range would re-create a logged failure (F-020's own Date line records
that duplicate F-019 numbering already bit here once).

### COUNCIL-SPEC — the research contradicted the obvious design

The operator asked for a council visualizer over the D-039 validation panel. Investigation split
it into a **modelling wave (this spec)** and a UI wave, because the panel's persisted shape must
change first: the validators **already** produce the qualified stance (`falsifier`, `evidence[]`,
`scope_findings`) and `foldVerdictReasons` immediately flattens it into prefixed prose, read back
by string-prefix parsing. Structure generated, then discarded. Worse, seat ordinal and panel size
are never persisted, and the panel legitimately runs with `validators: 1` — **a single verdict
renders identically to a full panel.**

The design deviates from the obvious debate loop, on cited external evidence:

- The operator's independent → debate → independent proposal is **Nominal Group Technique, not
  Delphi**. Delphi's defining middle step is anonymized *statistical* feedback — RAND built it as
  an **alternative** to discussion (Dalkey & Helmer 1963).
- **A competitive debate round measures NET-NEGATIVE on exactly this task class** (error
  detection — which is what a validation panel does): up to **−15pp vs a single agent at matched
  token budget**; only a non-zero-sum collaborative protocol beat single-agent, by ~4pp. So round
  2 is collaborative, and "restating your position unchanged" is an explicitly legitimate outcome.
- **More seats does not work.** Nine frontier judges across seven families collapse to a Kish
  effective sample size of **≈2.0–2.5**; the best single judge matches or beats the full panel;
  judges 6–9 add **+0.22 effective votes**. Seats cap at 5, and the marginal dollar goes to
  **evidence diversity** — a shared public core plus disjoint private slices — which is the thing
  that provably reduces inter-agent error correlation.
- **Anonymization is a BIAS lever, not an accuracy lever** (IBC 0.608 → 0.024), and the spec
  claims only the former. The tally is hidden in round 2 on purpose: the tally *is* the conformity
  trigger, and flip probability is highest when no peer agrees — i.e. the failure mode targets the
  dissenter the panel exists to hear.
- **Confidence routes, never weights.** Verbalized confidence is systematically overconfident;
  confidence-weighted aggregation recovers ≤11% of the independence gap and Dawid-Skene
  *underperformed* plain majority.

Status: **SPEC — DRAFT, operator-gated.** Migration id deliberately **not** allocated (§0), which
is the rule below applied in advance.

### toolPolicy is never enforced

A capability scout (2026-08-04, written up this stretch in `cbd6cab`) established that
`sessions/launch.ts:934-945` builds a `SpawnRequest` carrying `toolPolicy`, `runtime/index.ts:671`
passes it into `CcSpawnPlan` — **and then it is dropped**. `grep -c toolPolicy
src/lib/server/claude-code/cli-backend.ts` = **0**; the argv at `:568-593` has no
`--allowedTools`/`--disallowedTools` and emits no `permissions` block. The only thing between a
spawned seat and any built-in tool is `--permission-mode default` — Claude Code's own headless
behaviour, outside this repo and unprovable from repo code.

And the row lies about it: `launch.ts:431` persists `tool_allow` and the comment at `:585-586`
calls it "the ACTUAL composed/effective grant known at spawn". **A stored field asserting an
enforcement that never happened is the F-008 fabrication class** — the same shape as a surface
stating a score the run never produced. Queued `gate:operator`; it **blocks any researching
council**, because granting `WebSearch`/`WebFetch` on top of an unenforced allow-list yields an
unbounded seat, not a researching one.

## Migrations

**ONE: `m0087_task_tags`** — `DEFINE FIELD OVERWRITE tags ON task TYPE option<array<string>>;`
(`schema.ts:3133`, last entry of `schemaMigrations` at `:3259`). Verified on disk in the lane-A
worktree. **Head is `m0087`. Next free is `m0088`.**

- **Live `db:up` 87/87, run twice** (`cdd1005`), and again at `80b6832`/`b4f58f6` with the head
  unchanged. Before m0087 the same live DB reported **86/86** (`64ec4a4`, `9e6f81d` baseline).
  P3 consumed **no** migration id — re-verified on disk (`3ce6548`).
- Shape decided once and written into the migration: `array<string>` **SCHEMAFULL, not FLEXIBLE**
  — the m0086 trap (a plain `TYPE array<object>` silently discards nested keys on a SCHEMAFULL
  table) is specific to nested objects; `array<string>` has none to lose, so the strict form is
  exact **and** enforcing. `option<…>` so all 23 pre-existing live rows read as an honest absence,
  never an empty array claiming the operator considered tags and chose none. **No index,
  deliberately** — n≈23, reads already ride `task_by_project` (m0002); a guessed index is a
  guessed claim.
- **The allocation rule beat the paper reservation, second time of asking.** TASK-BOARD-SPEC §0
  had reserved `m0088` for this field and `m0087` for MODEL-LADDER-SPEC — written when the live
  head was `m0085`. By build time the head was `m0086` and **neither number existed in code**.
  Honouring the paper claim would have left a permanent hole for a spec that may never ship, so
  the build allocated from the LIVE head. **MODEL-LADDER-SPEC's claim on `m0087` is VOID and must
  re-allocate.** Recorded in the spec (`abe715f`) and in the migration's own header comment.

## Decisions

- **Committing is preservation; MERGING is the assertion** (PCG-1). The gate deliberately does
  not run before the git commit — a session's edits live in a worktree merge-back tears down, so
  refusing to commit would DESTROY the failing work (F-007). A red gate commits to the session
  branch and withholds the merge.
- **The gate verdict is tri-state, not a boolean** — `passed`/`failed`/`skipped`. "A two-valued
  flag is exactly how *we ran nothing* got laundered into *it's green*." A project with no
  detectable target is an honest `skipped` and is **not** blocked; a gate the machinery could not
  RUN is red-with-errored, never a fabricated pass.
- **A new exit state rides the EXISTING preserve branch**, never a second preserve path (F-055),
  and only the stamped note differs — because "the gate said no", "the gate never answered" and
  "the session crashed" send an operator to three different places.
- **Allocate a migration id from the LIVE head, never from a number a spec quotes** — now applied
  twice, and applied *pre-emptively* by COUNCIL-SPEC, which refuses to allocate at all.
- **A tag is prompt payload, not decoration** (m0087) — the vocabulary stays free-form strings on
  purpose; validation lives at the repo chokepoint, so a curated vocabulary can layer on later
  with no migration.
- **Paid beats free, and the free path yields VISIBLY** (LC-D) — the loser is a named outcome
  with nothing written and nothing spent, not an exception a route converts into a 500.
- **A concurrency fix is tested as a RACE, not a sequence** — the rival writer fires from inside
  `db.query`, hitting the exact window on every run.
- **A projection the F-020 detector cannot resolve is DECLINED, not judged** (`6ecc350`) — a
  guard that judges what it cannot see manufactures violations.
- **Pin EOL narrowly** (`31d4ce3`) — `*.mjs`/`*.sh` only; a blanket `* text=auto eol=lf` would
  renormalise the whole tree in one unreviewable commit.

## Bugs / fails

**One new entry this stretch: F-060** (`c00de11`) — checkout-time CRLF conversion silently
disabled three suites at a clean `git status`; **the failure is a property of the CHECKOUT, not
the COMMIT**, which falsifies the premise everyone was reasoning from. Filed separately from
F-054 on purpose: F-054 is an *editor* mutating a file you are working on; this is *checkout*
doing it to files nobody touched, with no diff to inspect and no dirty status to notice.

**F-058 and F-059 are dated 2026-08-04 but belong to the previous entry** — both landed in
`11ccd38`, which precedes `4e3747e` (the 07-26/27 devlog) in the docs history and is already
recorded there. Checked, as asked; not double-counted here.

Defects found and fixed in product code this stretch, for the record: Atelier committing agent
work with the test result discarded · an unverified branch fast-forwarded into the base · a
post-task fault merging **around** an armed gate and tearing down the worktree · a gate whose
two verdicts both described the environment · a merge hold keyed on an enum value that had just
acquired a second meaning · an ENOENT wedge that blamed the change for a missing SDK · a git
fault reported as "branch already gone" · a `gate-unknown` state asserting a fact it did not
observe · a forged `## Acceptance criteria` section behind a container prefix (D-026) · a
cross-table `UPDATE $rid MERGE` behind a shape-only id guard · an O(n²) dedup over unbounded
input · a completeness panel dropping stored `provenance.authority` and shipping a bare `pm.id`
· an action banner composed from the request instead of the live row · a concierge teardown
sequenced behind an unbounded DB write · a run-fetch cap that dropped pointers silently and
rendered `run not found` for each · a header counting 36 over a list of 17 · a paid adjudicated
run stranded behind a second real spend · a TOCTOU on `compared` that could discard the paid
verdict · an error ladder missing the class that produced its most caller-facing refusal · an
unguarded free path that could land an INCOMPARABLE verdict on a one-way status · 53 tests that
had never run while being counted · an F-020 detector parsing TypeScript as SQL.

> **Numbering, still open.** The `F-057` gap flagged in the previous entry is unchanged. The
> cross-branch divergence is now **measured rather than estimated** (`03f0d4d`): the two copies'
> F-045/F-046 are **entirely different failures**, the docs copy has the F-057 gap, and the v2
> copies lack F-049..F-055/F-058/F-059 outright — 28 ids only-local, enumerated. Re-unification
> remains an operator action. Marked, not merged.

## Docs / memory

All on `v2-main`: `docs/BUILD-QUEUE.md` **OPERATOR PAUSE #7** (`3c7e8e1`) — the contemporaneous
resume record and the primary source for this entry, superseding #6 (`a5aced9`).
`docs/COUNCIL-SPEC.md` (`c79a7d5`, new). `docs/fails.md` F-060 (`c00de11`).
`docs/TASK-BOARD-SPEC.md` P2 as-built + the void `m0087` reservation (`abe715f`) and P3 as-built
with its four deliberate departures (`3ce6548`). The `toolpolicy-enforcement` queue row
(`cbd6cab`).

## End-gate — PARTIAL, and honestly so

- **Lane A: PASS.** `origin/v2` = **`b4f58f6`**, 0/0 vs remote, worktree clean — **verified by me**
  (`git rev-parse`, `ls-remote`, `status --porcelain`). Every one of the 20 commits is review
  PASS + red-team PASS. Tip gate line, from `b4f58f6`'s own body: **build ok · eslint 0 ·
  svelte-check 1157 files 0 errors 0 warnings · vitest 351 files (350 passed / 1 skipped) / 6268
  passed / 0 failed / 7 skipped.** Live `db:up` 87/87.
- **Lane C: NOT COMPLETE.** HEAD = **`03f0d4d`**, `origin/v2-lane-c` = **`6ecc350`** — **4 commits
  unpushed** (the whole V1R-1 cluster), on a tip whose own review **failed twice**. Everything
  before those four is pushed and green. Tip gate line from `03f0d4d`: build 0 · lint 0 ·
  svelte-check 1141 files 0/0 · suite **6011 passed / 0 failed** (baseline `50166bc` 6008/0).
  Worktree clean.
- **`v2-lane-c` has NEVER been merged into `v2`.** It is `[ahead 20, behind 20]` of `origin/v2`.
  Neither lane has tested the combination; it must be `--no-ff` and the merge result independently
  re-gated.
- **A deferred HIGH is open and named**: `moveTask`
  (`routes/projects/[id]/+page.server.ts:1115`) still uses the shape-only `assertRecordId` — the
  **same hole `retagTask` just closed**, in the sibling function. Fix it first when the pause lifts.
- **Both suite claims are second-hand by necessity.** I ran no build, no test and no server this
  session; the numbers come from the commits' own gate lines. F-060 is precisely the reason to say
  so out loud — on this repo a suite result is a property of a worktree, not of a sha.
- SurrealDB (`:8000`, PID 1964) was left untouched by both lanes and by me.

## Parked / next

Order from PAUSE #7:

1. **Finish V1R-1 by asserting the CLASS**, not the instances — then push lane C.
2. **`moveTask`'s shape-only id guard** (the deferred HIGH).
3. **Merge `v2-lane-c` → `v2` `--no-ff` and RE-GATE the combination.**
4. **`toolpolicy-enforcement`** (operator-gated) — it blocks any researching council.
5. **`COUNCIL-SPEC` P1** (operator-gated).
6. The `fails.md` cross-branch numbering divergence — measured, unfixed, operator action.

**Open, recorded, not lost:** the `.gitattributes` pin covers `*.mjs`/`*.sh` only — `.ts`
source-text scanners still need the F-054 normalisation · the NAV-IA-MAP row (TB-9) deferred out
of P3 · a `fails.md` entry for the PowerShell 5.1 double-encoding trap that bit the P3 build,
named but not written · LC-D's deferred review findings ③④⑤ (+⑥⑦ advisory per G3) · everything
still open from the previous entry's list, none of which this stretch touched.

**Operator-gated, untouched:** arming a PM · per-hire souls · widening auto-adjudication past B3
· any publish/deploy/release · a live gauntlet run.

## Corrections to my own reporting (recorded, not quietly fixed)

- **The "four more" of the RG-1 close-out and the cargo/ENOENT wedge are not separate items** —
  the ENOENT wedge **is one of the four** in `11baf72`, alongside the `#runItem` merge-around, the
  `countChangedFiles` zero, and the `branchExists` fault. And it was not one sweep: `11baf72`
  found four, then `64ec4a4` found four **more** (the explicit-path exemption, the whole-block
  catch, the `gate-unknown` false assertion, and three thin tests). Six of the class in total
  after `bcb1bad`/`6878d14`, across **three** successive close-out reviews.
- **The compare-and-swap is `c2873e5` (LC-C2), not `0ba5c2b` (LC-D).** LC-D is the missing error
  class + the unguarded free path. The race test fired from inside `db.query` belongs to LC-C2.
- **`m0087` is not a "collision", second occurrence.** The 2026-07-26 event was a real collision
  (two specs both reaching for a number one wave was consuming). This was an *unclaimed
  reservation being voided* — neither `m0087` nor `m0088` existed in code, so nothing collided.
  The same rule resolves both, which is why they feel alike; recording it as a second collision
  would overstate the frequency of the failure.
- **PAUSE #7's "0 failing files, 6019 tests" is reconcilable but is not the tip number.** It is
  `6ecc350`'s measurement — **6002 passed / 17 skipped = 6019 collected, 0 failed**. The lane-C
  tip (`03f0d4d`) measured 6011 passed / 0 failed. Neither is wrong; they are different commits.
- **`orchestrator/review.ts:115` checks out exactly** — at `fbcb8d0` that line is
  `export async function maybeEnqueueReview(`, and its own doc comment says it "is meant to be
  called from the post-task loop AFTER the commit" while having no production caller.
  **`post-task.ts:376`/`:400` I could NOT confirm**: at `fbcb8d0` the file's relevant landmarks
  are `:289` (`followUpOnTestFail ?? true`), `:292` (the comment "tests only trigger a follow-up,
  they never change the terminal status") and `:411` (`wantFollowUp`). The *substance* — commit
  first, test after, result discarded, `followUpOnTestFail:false` wired in boot — is confirmed by
  `4ba14c1`'s own body. The two line numbers are inherited from the 2026-07-26 review and are not
  re-verified here.
- **Lane C's worktree is `ai-playground-v2b`** — the same directory lane B used, on a new branch.
  It is not a third worktree, and `v2-lane-c` tracks `origin/v2`, not `origin/v2-lane-c`, which is
  why `git status -sb` reports it `[ahead 20, behind 20]` rather than `[ahead 4]`.
