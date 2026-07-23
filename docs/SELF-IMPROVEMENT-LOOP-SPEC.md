# SELF-IMPROVEMENT-LOOP-SPEC — one spine for measure → propose → validate → adopt

**Status**: PROPOSED (planning spec, no code)
**Date**: 2026-07-23
**Author**: Fable-5 planner session
**Reads with**: `docs/BRAIN-OBSERVER-LOOP-SPEC.md` (curation gate, rejection ledger, council readers) · `reference_skillopt` (validation-gated skill edits) · `docs/DECISIONS.md` (D-015/D-021/D-026/D-028/D-036/D-037/D-038/D-039) · `docs/fails.md` (F-008/F-045/F-048/F-055)

---

## 1. Thesis — one primitive, five consumers

The operator asked two questions that are the same missing capability:

1. *"Do we have anything that reviews CONVERSATIONS and finds things to learn from, and updates our SKILLS / WORKFLOWS / REJECTIONS effectively — ensuring nothing is missing and we don't derive the WRONG ideas?"*
2. *"Do we have TOOL-USE OPTIMIZERS ensuring we use the right tool for the job, and tools are updated as needed?"*

Both — plus three already-specced or half-built features — reduce to a single primitive:

> **measure effectiveness → propose an update → VALIDATE it for correctness → operator adopts, append-only.**

The five consumers that ride this one spine:

| # | Consumer | Today | The gap |
|---|---|---|---|
| 1 | **Skill edits** | Skills are hand-authored; SkillOpt pilot specced (`skillopt-pilot` BUILD-QUEUE row) | No measured, validation-gated path from "this skill underperforms" to "here is a better version, proven on held-out tasks" |
| 2 | **Workflow edits** | `v2-wave.js` edited by hand; load pre-check exists (`node --test .claude/workflows/v2-wave.test.mjs`, F-016) | No systematic mining of wave outcomes into workflow improvements |
| 3 | **Tool/capability choice** | `writeRoutingEvent` (`src/lib/server/routing/resolve.ts:464`, writes `routing_event` at `:487`) records intent/complexity/tier/alternatives/reason — the DECISION only | The OUTCOME quality of the choice is never recorded or joined back; no per-(intent, tool, model) effectiveness exists anywhere |
| 4 | **Rejection/rule curation** | Error-learning is fully manual: `docs/fails.md` + the error-learning skill escalation ladder (1st→document, 2nd→SKILL.md, 3rd→CLAUDE.md, 4th→hook). The brain-observer spec adds a rejection ledger | No automated miner feeds candidates into that ladder; nothing checks that lessons are *not missing* or *wrongly derived* |
| 5 | **Model-per-role** | Effectiveness is PROVIDER-only: `buildProviderUsage` (`src/lib/server/analytics/provider-usage.ts:75`) and the m0076/m0077 benchmark verdict store (`benchmark_verdict`, `src/lib/server/db/schema.ts:2755`) group by provider | Never by ROLE, never by tool-choice; the 2026-07-07 model-roles policy was set by operator intuition, not measurement |

**Why one spine beats five features.** Each consumer, built separately, grows its own proposal format, its own review path, its own adoption mechanics — five gates where F-055 demands one ("route every gated state-change through the EXISTING gate function"). Five gates means five places for a bypass, five UIs for the operator, five provenance disciplines that drift apart. One spine means: one `learning_candidate` table, one validation registry (per target type), one operator proposal queue shared with the brain-observer, one curation gate (`src/lib/server/brain/curation-gate.ts`, specced in BRAIN-OBSERVER-LOOP-SPEC — build once, both loops call it), one append-only adoption discipline. The consumers differ ONLY in (a) what they mine and (b) what "validated" means for their target type — everything else is shared.

This is the capability boundary between *self-observing* (the brain-observer notices) and **self-improving** (measured changes actually land, safely).

---

## 2. Sources of learning — what gets mined, and how mining stays safe

### 2.1 The sources

| Source | Where it lives | What it yields |
|---|---|---|
| **Conversations / transcripts** | BL-5 global-transcript capture; session messages/events in SurrealDB `[VERIFY: src/lib/server/sessions/ transcript tables]` | Recurring friction ("agent re-derived the same fix twice"), missed-skill moments, instruction patterns that worked, wrong turns |
| **fails.md + error events** | `docs/fails.md` (F-001..F-056); orchestrator/analytics error events | Candidate rules, recurrence counts that drive the error-learning ladder automatically instead of manually |
| **routing_event + task outcomes** | `routing_event` rows (`resolve.ts:487`); task terminal states from the orchestrator/post-task path; turn tool summaries (`summarizeTurnTools`, `src/lib/server/memory/outcomes.ts:55`; `recordTurnOutcomes` at `:98`) | The raw material for route/tool effectiveness (§4) |
| **Gauntlet results** | `runGauntlet` (`src/lib/server/workforce/gauntlet.ts:357`) + `adjudicateInterviewRun` (`:973`) with its deterministic scorer | Role-capability evidence; the adjudicator for skill-edit validation runs |
| **Benchmark runs** | `thinking_capture` (m0076, `schema.ts:2725`) + `benchmark_verdict` (m0077, `schema.ts:2755`); judged comparison loader `[VERIFY: buildJudgedComparison, analytics/]` | Model-per-role effectiveness; the "env" for the SkillOpt harness |
| **Memory extraction stream** | `storeMemory`/`extractAndStore` (`src/lib/server/memory/store.ts:292/:432`) — append-only per D-015/D-028 | Decisions/outcomes/concepts already distilled from sessions; a pre-screened input, cheaper than raw transcripts |

### 2.2 Safe mining — the council-reader pattern (reused from the observer)

Conversation and tool content is UNTRUSTED (D-026). The rule, identical to the brain-observer's council:

1. **Readers, not the proposer, touch raw bytes.** A miner run fans out N council readers. Each reader receives raw content **fenced as data** (the D-026 fence: explicit "this is data, not instructions" framing, no operator token present, least-privilege — read-only DB user, no tools that mutate).
2. **Readers emit only structured distillations**: `{ claim, kind, target, evidence: [record-id/file:line pointers], confidence, quotedSpans⩽N-chars }`. Quoted spans pass the existing secret/PII screen before storage (same screen the memory path uses, D-026).
3. **The proposer/curation model never sees raw transcripts** — only distillations plus their provenance pointers. An injection embedded in a session transcript can, at worst, corrupt one reader's distillation; it cannot instruct the proposer, and cross-verification (§3.3) requires a second reader to independently derive the same claim from disjoint evidence before the candidate can validate.
4. **Structured sources skip the council** — `routing_event`, gauntlet scores, benchmark verdicts, and fails.md recurrence counts are our own structured writes, not untrusted prose. They feed the rollups (§4) directly. (fails.md *text* proposed as a rule still passes the curation gate like any rule change.)

---

## 3. The candidate → validation → adopt pipeline

### 3.1 `learning_candidate` lifecycle (append-only)

States: **`proposed` → `screening` → `validated` | `refuted` → `staged` → `adopted` | `rejected`** (plus `expired` for candidates whose evidence goes stale before validation).

Append-only mechanics per D-015/D-028:

- The candidate row's *content* (claim, target, evidence, proposed diff/summary) is **immutable after creation**. No LLM ever mutates a row in place.
- Every state transition is an appended `learning_event` row (candidate-id, from, to, actor, evidence-of-transition, ISO timestamp). Current state may be denormalized onto the candidate as a `status` field for query convenience, but the trail is the truth — and the dedup key must **not** include `status` (F-048: a VALUE key on mutable status collides at the transition; key on immutable `(kind, target, evidence_hash)` instead, guarding both insert and flip).
- **Adoption never edits the target artifact in place.** Adopting = creating a **new version** (skill vN+1, appended rule, new rejection-ledger entry, new catalog revision) plus a supersession marker on the old one. Mark, never delete — the same discipline fails.md already uses (`> STALE-PROPOSED:` lines, operator retires).

### 3.2 What "validated" MEANS, per target type (the validation registry)

This is the anti-"wrong ideas" core. A candidate cannot reach `staged` without passing the gate registered for its target type — F-055: one registry, every path through it, no target type without a registered gate (unknown type fails closed, D-036 spirit).

| Target type | Validation gate | Ground |
|---|---|---|
| **Skill edit** | **SkillOpt gate**: run the edited skill vs the incumbent on a frozen model with train/val/test splits from the benchmark harness (m0076/m0077 as the "env"); accept only on measured **held-out** improvement, adjudicated by the deterministic gauntlet scorer (`adjudicateInterviewRun`, `gauntlet.ts:973`). The `skillopt-pilot` BUILD-QUEUE row proves the harness can inject an arbitrary skill first — this spec depends on that pilot | `reference_skillopt`; HR invariant "deterministic scorer untouched" |
| **Rejection / rule (CLAUDE.md, SKILL.md rule-lines, rejection ledger)** | **Two-phase curation gate** (`brain/curation-gate.ts`, shared with the observer): two separate confirmations to apply, PLUS **council cross-verification** — a second, independent reader must derive the same lesson from *disjoint* evidence (different sessions/rows) or the candidate stays `proposed`. Rejections inherit the observer's cooldown→permanent ladder (permanent unless new evidence) | BRAIN-OBSERVER-LOOP-SPEC; D-026 |
| **Tool/route change** (re-rank a tool/model for an intent, adjust a routing rule) | **Measured effectiveness delta** on the §4 rollup: the proposed route must beat the incumbent by ≥ the threshold delta over ≥ the minimum sample (default: N≥20 outcomes per arm, see operator Q3), computed from real outcomes only — never projected/fabricated (F-008) | §4; `resolve.ts:464` |
| **Workflow edit** (`v2-wave.js` and friends) | **Dry-run + review**: the host load pre-check (`node --test .claude/workflows/v2-wave.test.mjs`, F-016/F-056) must pass, plus a D-038 review verdict on the diff; where feasible, a shadow run on a synthetic task before staging | CLAUDE.md §4/§5 |
| **Model-per-role change** | **Benchmark delta grouped by role**: the m0076/m0077 harness run with `role` as the grouping key (the missing dimension, §1 row 5); judged verdicts honor the honest `insufficient_data` status — a NULL score is never a fake 0 (already the m0077 discipline, `schema.ts:2747`) | m0077 comment block; F-008 |

### 3.3 Adopt — always operator, always append-only

- Every `staged` candidate lands in the **same operator proposal queue** the brain-observer feeds (one queue, one UI surface). Born `proposed`, operator adopts — D-039, no exceptions, including "the validation gate passed with a huge margin" (see operator Q2 for the one debated carve-out).
- Adoption executes through the **curation gate** as the single chokepoint (F-055) and produces: the new artifact version, a supersession marker, and an `adopted` learning_event carrying full provenance (candidate → evidence → validation-run ids). Anything publish/external stays D-037-gated on top.
- Rejected candidates enter the **rejection ledger** with the observer's cooldown semantics — the same idea re-mined next week is auto-suppressed unless it arrives with *new* evidence (evidence-hash differs), which is exactly the "nothing is missing, nothing wrongly re-derived" balance.

---

## 4. Tool/capability effectiveness — answering Q2

### 4.1 The missing half of `writeRoutingEvent`

`writeRoutingEvent` (`resolve.ts:464`) already records the decision with rationale: intent, complexity, tier, alternatives, reason. Nothing records **how that decision turned out**. The fix is one append-only table and one join:

- **`route_outcome`** (new, append-only): written on the post-task path (`orchestrator/post-task.ts` — commit→test→heartbeat is already the natural terminal hook `[VERIFY: post-task.ts exposes the routing_event id on the task context]`), one row per completed routed unit: `routing_event` link · terminal status (done/failed/abandoned) · gate results (build/test/review verdict) · fix-loop iterations · duration · cost/tokens · tool-use summary (reuse `summarizeTurnTools`, `outcomes.ts:55`). Honest-only: if a signal is unknown, the field is NULL — never inferred (F-008).
- **Effectiveness rollup, compute-on-read**: per `(intent, tool/capability, model[, role])` — success rate, mean fix-loops, mean cost, sample count, window. Compute-on-read first (the S4 soul precedent — derive on read, no stale materialization); a cached nightly rollup table only if `/reports` latency demands it later.

"Right tool for the job" then becomes a queryable fact: *for `intent=X`, arm A succeeds 84% at cost c₁ over 41 samples, arm B 61% at c₂ over 28* — and a below-threshold arm auto-surfaces a tool-route learning_candidate (validated per §3.2 row 3).

### 4.2 "Tools updated as needed" — two drift detectors, one catalog discipline

- **Drift-from-DISK** (exists): `freshenCatalog` (`src/lib/server/cc-config/sync.ts:892`) already reconciles the synced catalog against disk at spawn time (D-036, tested in `freshen.live.test.ts`).
- **Drift-from-EFFECTIVENESS** (new): a capability/tool whose rollup win-rate for its declared intent falls below a floor over ≥N samples surfaces a `capability_review` learning_candidate proposing one of: **improve** (skill/prompt/config edit — cascades to the §3.2 skill gate), **reroute** (stop selecting it for that intent — tool-route gate), or **retire** (remove from bundles — operator-adopted catalog change).

Catalog integrity is non-negotiable:

- **F-045**: no proposal may ever result in a `bundles.<intent>.capabilities` id that is absent from a SYNCED scope's catalog. Retire/improve proposals are expressed as catalog-revision diffs that flow through the *existing* cc-config sync path — never a direct bundle edit that could orphan an id and fail-close every spawn of that intent.
- **D-036**: adopted changes re-enter via sync; the allow-list stays the single source; an unknown id still fails closed at spawn. The learning loop proposes ABOUT the catalog; it never writes AROUND it.

---

## 5. Data

New tables — all additive, idempotent (`OVERWRITE`/`IF NOT EXISTS` per F-015, apply-twice + half-applied tested), every datetime ISO-coerced in the repo `norm*` (F-013), every query real-surreal-tested (F-020, not `stubDb`), all values via `$param` (D-016). Migration ids are **symbolic** here — the head has advanced past `m0080_maintenance_loops` (`m0081_agent_event_supervision` exists at `schema.ts:2879`); renumber at build time.

| Table (symbolic mNNNN) | Purpose | Key fields (prose, not DDL) |
|---|---|---|
| `learning_candidate` (mNNNN_learning_candidate) | The immutable proposal: kind (skill_edit / workflow_edit / tool_route / rule_or_rejection / model_role / capability_review), target ref, claim, proposed-change summary, evidence links, confidence, miner provenance (which run, which readers), dedup VALUE key on immutable `(kind, target, evidence_hash)` — never status (F-048) | status (denormalized), created_at |
| `learning_event` (same migration) | Append-only transition trail: candidate link, from→to, actor (miner/validator/operator), transition evidence (validation-run id, operator consent record), ISO at | — |
| `route_outcome` (mNNNN_route_outcome) | §4.1 — the outcome half of routing: routing_event link, terminal status, gate results, fix-loops, duration, cost, tool summary; NULL for unknown, never inferred | indexed by routing_event and by (intent-denorm, at) for the rollup scan |
| `validation_run` (mNNNN_validation_run) | One row per gate execution: candidate link, gate type, config snapshot (splits, frozen model, thresholds), measured result, verdict, cost; the provenance every adopt cites | append-only; a re-validation is a NEW row |

Effectiveness rollups: **compute-on-read** in v1 (no table); revisit only with measured latency evidence. No new mutation of any existing table; the memory tables stay append-only sources (D-015/D-028).

---

## 6. Reuse map — net-new is small

| Capability | Reused from | Net-new |
|---|---|---|
| Two-phase curation gate + rejection ledger | `brain/curation-gate.ts` per BRAIN-OBSERVER-LOOP-SPEC (build once there; this loop is its second caller) | Registration of learning-loop change kinds |
| Council readers (fenced mining, D-026) | Observer's council pattern | Miner prompts per source; batch scheduling |
| Validation "env" + splits | Benchmark harness m0076/m0077 + `skillopt-pilot` row | Gate-registry glue; skill-injection config |
| Deterministic adjudication | `adjudicateInterviewRun` + gauntlet scorer (`gauntlet.ts:973`) | Scoring configs per gate type (scorer itself untouched — HR invariant) |
| Append-only extraction as input | `memory/store.ts` (`:292/:432`), `outcomes.ts` | Nothing |
| Routing decision record | `writeRoutingEvent` (`resolve.ts:464`) | `route_outcome` + rollup query |
| Catalog sync/integrity | `freshenCatalog` (`sync.ts:892`), D-036/F-045 paths | The drift-from-effectiveness detector feeding candidates |
| Operator proposal queue | Observer's queue (shared surface) | New candidate kinds rendered |
| Slow dedup/supersede tier | `memory-curator` (BL-7C) | Candidate-vs-candidate dedup rides the same tier |

Genuinely new: `learning_candidate`/`learning_event`/`route_outcome`/`validation_run` tables, the nightly harvest scheduler, the effectiveness rollup query, the gate registry. Everything else is composition.

---

## 7. Relationship to the brain-observer — the boundary

| | **Brain-observer** (specced) | **Self-improvement loop** (this spec) |
|---|---|---|
| Tempo | Real-time / near-real-time — watches live sessions, NOTICES | Slow, offline, batch — SkillOpt-Sleep shape: nightly harvest → mine → validate → stage |
| Evidence | What just happened (single-session salience) | Aggregates across many sessions/runs (statistical, held-out) |
| Can it validate? | **No.** It proposes from observation; it never runs validation gates | **Yes** — validation is its defining stage |
| Watches live sessions? | Yes | **No.** It reads captured/stored data only |
| Output | Proposals into the shared queue; rejection-ledger entries | Validated, staged candidates into the SAME queue |

Both feed **one** operator proposal queue and **one** curation gate — not two (F-055). Cross-loop dedup: the shared `(kind, target, evidence_hash)` dedup key means an observer proposal and a mined candidate about the same lesson collapse; a candidate refuted here informs the observer's rejection ledger, and a ledger rejection suppresses re-mining absent new evidence. Rule of thumb: **the observer is reflexes; this loop is sleep.**

---

## 8. Safety invariants (each testable)

1. **No raw untrusted content reaches the proposer** (D-026). Test: proposer inputs are structured distillations only; a transcript containing a canary injection string never appears in any proposer prompt or `learning_candidate` row unscreened.
2. **Every adopt is operator-gated and append-only** (D-039/D-015/D-028). Test: no code path writes an artifact version or catalog revision without an `adopted` learning_event carrying an operator consent record; no UPDATE-in-place on any target artifact row.
3. **No change applies without passing its registered validation gate** — the anti-wrong-ideas guarantee. Test: attempting to stage a candidate whose `validation_run` verdict is missing/failed is rejected; a candidate kind with no registered gate fails closed.
4. **Effectiveness signals are honest** (F-008). Test: every rollup number traces to real `route_outcome`/`benchmark_verdict` rows; unknown → NULL/`insufficient_data`, never a default score; rollups below minimum-N render as "insufficient sample", not a rate.
5. **Catalog integrity** (F-045/D-036). Test: applying any adopted tool/capability change, the resulting bundles reference only ids present in a synced catalog; the fail-closed spawn check still holds; no path bypasses `freshenCatalog`/sync.
6. **One gate** (F-055). Test: grep-level audit — every adopt path (observer's and this loop's, UI and API) calls the same curation-gate function; no second writer to the artifacts it guards.
7. **Spend is capped and consented** (D-021). Test: mining/validation runs draw from a bounded nightly budget; a validation run that would exceed it defers, never silently overspends; standing consent for the batch is a recorded operator decision.

---

## 9. Phasing — smallest valuable first

| Phase | Scope | DONE-WHEN |
|---|---|---|
| **v1 — measure (read-only)** | `route_outcome` write on post-task + compute-on-read effectiveness rollup per (intent, tool, model, role) + a `/reports` surface. No proposals, no gates | The operator can see, from live data, success/cost per route arm with honest sample counts — and `insufficient sample` where N is low |
| **v2 — mine rules & rejections** | Nightly harvest → council mining of transcripts/fails-recurrence → `learning_candidate`s of kind rule_or_rejection → curation gate → operator adopt; rejection ledger live | A real mined lesson lands in fails.md/a SKILL.md via the gate with full provenance, and a refuted candidate is auto-suppressed on re-mine |
| **v3 — validated skill edits** | SkillOpt gate on the m0076/m0077 harness (after `skillopt-pilot` proves injection); skill-edit candidates validate on held-out improvement, adjudicated deterministically | A skill version adopted through the pipeline measurably beats its predecessor on held-out tasks, and a non-improving edit was refuted, not adopted |
| **v4 — workflow edits + auto-retire proposals** | Workflow-edit gate (dry-run + review); drift-from-effectiveness `capability_review` candidates (improve/reroute/retire) through the catalog-sync path | An underperforming capability surfaced its own review candidate, and its adopted resolution round-tripped through cc-config sync with F-045 intact |

Each phase ships under D-038 (real-surreal tests, live db:up, honest UI states, devlog).

---

## 10. Risks

1. **Overfitting to recent conversations.** A loud week mints a "rule" that's noise. Mitigate: minimum evidence windows, cross-window requirement (evidence from ≥2 disjoint time windows/sessions for rule candidates), recency decay in mining salience, and the cross-verification reader requirement (§3.2).
2. **Validation gaming / Goodhart.** A skill edit that overfits the benchmark splits. Mitigate: frozen held-out test split rotated between runs, deterministic scorer never edited by the loop (HR invariant), val≠test discipline from SkillOpt, and periodic operator spot-audit of adopted edits against real-task outcomes (the v1 rollup closes this loop naturally).
3. **Effectiveness-signal noise.** Small-N route comparisons flip-flop. Mitigate: minimum-N floor before any proposal (operator Q3), report confidence alongside rates, `insufficient sample` as a first-class honest state (F-008), and hysteresis — a route change candidate requires the delta to hold across two consecutive rollup windows.
4. **The curation gate becoming a rubber stamp.** If the queue floods, the operator clicks through. Mitigate: hard weekly cap on staged candidates (small, ranked batch), diff-style one-screen proposals with the single best evidence pointer up front, and queue analytics (adopt/reject ratio surfaced — a ~100% adopt rate is itself a red flag the loop should report).
5. **Spend of mining/validation runs.** Nightly councils + benchmark runs cost real tokens. Mitigate: D-021 bounded nightly budget with deferral; first-pass mining on the local model (gpt-oss:20b — the local-brain hypothesis's natural first real workload) with cloud only for validation-grade runs; validation runs batched and skippable when no candidates are pending.

---

## QUESTIONS FOR OPERATOR:

1. **Mining cadence — nightly batch or event-triggered?** *Recommended default: nightly batch* (SkillOpt-Sleep shape; predictable spend under D-021, aggregates beat single-event noise). The brain-observer already covers the real-time reflex; event-triggered mining here would duplicate it.
2. **Does a validated skill edit ever auto-adopt, or always operator-gate?** *Recommended default: always operator-gated (D-039), no carve-out* — even on a large held-out win. Revisit only after ≥10 adopted edits show the gate is pure ceremony (the adopt/reject analytics from Risk 4 will tell us).
3. **Minimum effectiveness sample before a tool-route proposal?** *Recommended default: N≥20 completed outcomes per arm, delta held across 2 consecutive windows.* Below that, the rollup renders "insufficient sample" and no candidate is minted.
4. **Mine ALL conversations, or only flagged/failed ones?** *Recommended default: all, with salience weighting* (failures and flagged sessions weighted up). Success-only lessons ("this tool sequence worked") are half the value of Q2, and "ensure nothing is missing" argues against a failure-only filter — the budget cap, not the filter, bounds cost.
