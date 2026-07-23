# BRAIN-OBSERVER-LOOP-SPEC — Waking the Atelier Brain

**Status:** DRAFT for operator review · **Author:** Fable-5 planner · **Date:** 2026-07-23
**Verdict this spec implements:** CONDITIONAL-YES — a budgeted periodic tick, propose-only, never an always-on daemon.
**Depends on decisions:** D-021, D-024, D-026, D-035a, D-036, D-037, D-038, D-039, D-040, D-041, D-015/D-028, F-008, F-014, F-048, F-055.

---

## 1. Purpose & the gap

Atelier's brain is **reachable but passive**. The concierge module header says it outright: *"EVENT-TRIGGERED, NOT persistent … NOT a 24/7 process"* (`src/lib/server/concierge/concierge.ts:9-13`). It wakes on exactly two events:

1. An inbound `to_kind:'atelier'` peer message (`src/routes/api/peer/send/+server.ts:176-177` → `void triggerConcierge(db)`).
2. A PM-review consult emitted on a novel specialist need (`src/lib/server/projects/pm-concierge.ts:206-208`, `defaultTrigger` → dynamic-import `triggerConcierge`).

There is no scheduler, no observer, no self-initiated read anywhere in `concierge/wire.ts` — its only entry point is `triggerConcierge` (`wire.ts:255`). The atelier identity itself is a documented placeholder: `resolveAtelier` (`src/lib/server/peer/resolve.ts:131-170`) resolves to whatever short-lived session happens to carry the `ATELIER_SELF_PM = 'pm:atelier_self'` sentinel (m0074), and honestly inboxes as pending otherwise. D-040's composed durable self — with memory continuity — does not exist yet.

**What this costs us.** The operator's recurring pain is *invisible failure*: stuck queues, silently disarmed PMs, a heartbeat loop that was DEAD for weeks before anyone noticed. Every one of those was discoverable from data Atelier already had — nobody was looking. A brain that only answers when spoken to cannot notice that nobody is speaking to it *because the speaker is broken*.

**What unprompted observation buys:**
- Failures surface in minutes, not on the operator's next manual sweep.
- The PMs get a second pair of eyes with cross-project altitude (D-041: atelier is the sole cross-project broker — it is the *only* identity allowed this view).
- The "alive" north star: a platform that visibly notices, reasons, and suggests — with receipts.

**What it must never become:** an actor. This loop observes and proposes. It executes nothing, steers no one (D-035a), publishes nothing (D-037), and mutates no knowledge row in place (D-015/D-028).

---

## 2. Architecture

### 2.1 The loop shape

```
every N min (default 30):
  SENSE      deterministic health digest (pure queries, $0, no LLM)
  TRIAGE     local model (gpt-oss:20b) classifies digest -> nothing-notable | watch | anomaly
  [anomaly + cloud-cap available]
    ESCALATE cloud (Claude) wakes — the ONLY tier allowed to draft a proposal
    COUNCIL  reader sub-agents fan out over raw content, screen+fence, return
             distilled provenanced findings (v3; escalation-only)
    DRAFT    cloud composes proposal(s) with provenance
  ROUTE      pm-authority -> advisory peer message to that PM
             operator-authority -> brain_proposal (born 'proposed', D-039), cap 3 open
  JOURNAL    append one brain_tick row — ALWAYS, even "nothing notable" (F-008)
```

### 2.2 Two-tier model split (operator decision 1)

| Tier | Model | Allowed to | Never allowed to |
|---|---|---|---|
| **Sensor/triage** | local `gpt-oss:20b` via `OllamaProvider` (`src/lib/server/providers/index.ts:123`, `127.0.0.1:11434`, no `/v1`) | read the deterministic digest, emit a classification `{verdict, anomaly_class, evidence_refs}` | draft a proposal, send any peer message, trigger cloud directly (escalation is decided by *code* from its structured verdict, not by the model) |
| **Reasoner** | cloud Claude via `ClaudeProvider` (`providers/index.ts:221`), resolved through the existing `defaultProvider`-aware seam (`concierge/wire.ts:197-247`) | run the council, synthesize, DRAFT proposals/advisories | execute, steer, exceed the 4/day escalation cap |

The tier pin is enforced in code, not prompt: the sense/triage path constructs `OllamaProvider` directly and has **no cloud fallback** — Ollama down ⇒ journal `sensor-offline` (honest state, F-008) and end the tick. A silent local→cloud fallback would turn a $0 loop into a metered one without consent; that is exactly the F-053 additive-branch rule (opt-in when wired, byte-identical fall-through otherwise).

This is why **local-runtime-lifecycle is a hard dependency** (§6): `OllamaProvider` assumes the server is already up (no lifecycle management anywhere in `providers/index.ts` — verified, no `keep_alive` handling). A 30-min tick against a cold/absent Ollama is a loop that journals `sensor-offline` forever.

### 2.3 Tick host: reuse MaintenanceLoopEngine, don't build a scheduler

The tick is a **registered maintenance action** (`maint:brain-observer`) dispatched by the existing `MaintenanceLoopEngine` (`src/lib/server/loops/maintenance.ts:115`), driven by a `loop_manifest` row (`kind:'maintenance'`, m0072/m0080). This inherits, for free, the engine's five gates re-checked from the DB every tick (`maintenance.ts:14-23`):

1. orchestration mode permits automatic fires (manual mode arms no timer, D-004);
2. manifest row `enabled` — **this is the kill switch**, re-read per tick;
3. the readiness ARM gate (same `arm-gate.ts` policy as PM arming) [VERIFY: `src/lib/server/loops/arm-gate.ts` exact export];
4. the action id is registered;
5. the cadence parses and is due (unparseable ⇒ honestly never due).

Cadence lives on the manifest row and is read live each tick, so the UI edits cadence by updating the row — no restart, no new plumbing. Default cadence `*/30 * * * *`.

**One net-new gate, added inside the `maint:brain-observer` action itself (not the engine):** the §4 arming preconditions (nonzero brain token budget, backpressure cap configured, kill switch reachable). Precondition unmet ⇒ the action journals `not-armed: <reason>` and returns. The engine stays generic.

### 2.4 SENSE: the deterministic digest ($0, no LLM)

A pure aggregation pass over existing read paths — the same discipline as `loadFleetSnapshot` and the command-center loaders. Candidate signals (each a cheap SurrealQL aggregate; exact list finalized at build against real loaders):

- work_items: ready-but-unclaimed age, failed count, stuck in-flight (reaper view) [VERIFY: `orchestrator/reaper.ts` exposed stats]
- sessions: recent failures, null/error notes, worktree merge-back failures
- PM health: last pm_memory write per armed PM, disarmed-with-open-roadmap
- budget: rolling spend vs `dailyTokenBudget` / `dailySpawnCap` (`config/orchestration.yaml:53,73,81`)
- advisory backlog: unconsumed concierge advisories (`src/lib/server/projects/concierge-advisories.ts:196`)
- observer self: escalations used today, open operator proposals vs cap, consecutive-rejection counter

The digest is a **POJO with record-id references, not raw text**. No session transcript, no peer-message body, no retrieved content enters it — that is what keeps the cheap tick safely below the D-026 line: the local model only ever sees numbers, statuses, and ids produced by our own queries.

### 2.5 TRIAGE: one bounded local turn

Input: the digest + a static rubric. Output: structured JSON `{verdict: 'nothing-notable'|'watch'|'anomaly', anomaly_class?, evidence: RecordRef[], reasoning}`. Parse-or-honest-fail: unparseable model output journals `triage-unparseable` and ends the tick (never guess an anomaly into existence). `watch` = journal only, carry a watch note into the next digest so trends are visible.

### 2.6 ESCALATE + COUNCIL (cloud, capped 4/day)

Escalation fires only when code sees `verdict:'anomaly'` AND the rolling-24h escalation count < cap AND the brain token budget has headroom. The cap check uses a **durable anchor** (count `brain_tick` rows with `kind:'escalation'` in the window — restart-proof, same pattern as the CG-2 budget enforcement noted at `orchestration.yaml:76-79`).

**Council (v3, escalation-only — operator decision 3).** For anomaly classes whose diagnosis needs raw content (e.g. "why did these 3 sessions fail" needs their notes/logs):

- Cloud brain names 1–3 **reader domains** (e.g. `session-notes:<ids>`, `pm-memory:<project>`, `queue-items:<ids>`).
- Each reader runs as a bounded sub-agent spawned through the **D-021 background job queue** (so readers count against `dailySpawnCap` and the semaphore — no new spawn path, F-055 spirit).
- Each reader ingests its raw slice **through `memory/screen.ts` then wraps it in `memory/fence.ts` fences** (D-026: untrusted = data; secrets/PII screened before the model sees them) — the exact pattern the concierge already uses (`concierge.ts` imports `FENCE_OPEN/FENCE_CLOSE`, `screen`).
- A reader returns only a **distilled finding**: `{claim, confidence, concluded_from: RecordRef[]}`. Raw bytes are discarded with the reader's context.
- The main brain receives findings only. **Raw untrusted text never reaches the tier that drafts proposals.** Disagreeing readers ⇒ the disagreement itself is reported as the finding ("readers disagree: A says X citing p, B says Y citing q") — never silently averaged.

### 2.7 ROUTE: the authority split (operator decision 4)

Every draft carries an `authority` classification, assigned by a **deterministic rule table** (not by the model — the model proposes a classification, code validates it against the table; anything not matching a pm-authority pattern defaults UP to operator):

| Authority | Examples | Route |
|---|---|---|
| `pm` | "task X looks stuck, consider re-seeding", "this failure class matches F-020, suggest a real-surreal test", "roadmap item stale" | Advisory **peer message to that PM** via the existing send path (`src/lib/server/peer/send.ts`), screened+fenced, `origin` stamped server-side != operator ⇒ structurally non-steering (D-035a). Resolves through the PM's normal loop; **never queues on the operator.** |
| `operator` | hire, publish/release (D-037), budget raise, arming/disarming anything, cross-project strategy, anything touching rules/skills/workflows | `brain_proposal` row born `status:'proposed'` (D-039). **Hard cap: 3 open operator-facing proposals.** At cap the brain keeps observing and PM-routing but journals `proposal-suppressed: at-cap` instead of inserting. |

The observer **never calls a gated mutation** — it has no arm/hire/publish code path at all. Acceptance of a proposal happens in the UI by the operator, and the acceptance handler routes through the existing gate functions (F-055).

### 2.8 Reuse map

| Piece | Reuses | Net-new |
|---|---|---|
| Tick/cadence/kill/arm | `MaintenanceLoopEngine` + `loop_manifest` (m0072/m0080) | the registered action fn |
| Provider turns | `concierge/wire.ts:197-247` provider resolution; `OllamaProvider`/`ClaudeProvider` | tier-pinning wrapper |
| Advisory delivery | `peer/send.ts` + concierge reply/mailbox pattern (`pm-concierge.ts`) | authority rule table |
| Fencing/screening | `memory/fence.ts`, `memory/screen.ts` | reader-council harness |
| Analytics | `writeRoutingEvent` model (`routing/resolve.ts:464`) — first-class how/why | `brain_tick` journal (a sibling, not a replacement) |
| Spawn/spend governance | D-021 job queue, `dailySpawnCap`, CG-2 budget seam | brain-scoped budget + escalation cap |
| Read projections | `concierge-advisories.ts` read-only projection style | digest builder, effectiveness rollup |

---

## 3. Data

New migrations start at **m0081** (head is `m0080_maintenance_loops`, `src/lib/server/db/schema.ts:2848`). All per house data-layer DoD: every `DEFINE … IF NOT EXISTS`/`OVERWRITE`, apply-twice + half-applied tests, every `ORDER BY`/`GROUP BY` field in the `SELECT` (F-020), all datetimes ISO-coerced in a new `norm*` set (repo-local, `isoOrUndef` pattern from `projects/repo.ts`), real-surreal tests for every query, `npm run db:up` clean on the LIVE dev DB.

### m0081_brain_observer — `brain_tick` (the journal)

Append-only. One row per tick, **including empty ones** (F-008: "nothing notable" is a real, visible observation — never a skipped write).

```
brain_tick {
  id, at: datetime,
  kind: 'sense' | 'escalation',
  verdict: 'nothing-notable' | 'watch' | 'anomaly' | 'sensor-offline'
         | 'triage-unparseable' | 'not-armed' | 'error',
  anomaly_class: option<string>,
  digest_summary: object,            // the POJO digest (numbers/statuses/ids only)
  evidence: array<string>,           // record refs cited by triage
  action: 'none' | 'watch-noted' | 'escalated' | 'pm-advisory-sent'
        | 'operator-proposal' | 'proposal-suppressed-at-cap' | 'escalation-suppressed-at-cap',
  provider: string, model_id: string, tokens_in/out: number, duration_ms: number,
  note: option<string>               // honest reason on any suppressed/offline/error verdict
}
```

Escalation-cap query = `count(brain_tick WHERE kind='escalation' AND at > now-24h)` — durable, restart-proof.

### m0082_brain_proposal

```
brain_proposal {
  id, at: datetime,
  authority: 'pm' | 'operator',
  status: 'proposed' | 'routed' | 'accepted' | 'rejected' | 'expired' | 'withdrawn',
  title, body,                        // body is brain-authored prose (trusted tier output)
  provenance: array<{claim, concluded_from: array<string>}>,   // "concluded from: X, Y" — mandatory, non-empty
  anomaly_class: string,
  tick: record<brain_tick>,
  routed_to: option<string>,          // pm id for authority='pm'
  resolved_at: option<datetime>, resolved_by: option<string>,
  dedup_key: VALUE computed from (authority, anomaly_class, subject-ref)  // NOT status — F-048
}
```

Status transitions are the **one** allowed mutation (a lifecycle table, not a knowledge table — same standing as `work_item`). The dedup key excludes `status` and both insert and transition are guarded (F-048). Backpressure check = `count(status='proposed' AND authority='operator')` — real-surreal-tested, field in projection.

### m0083_brain_rejection (the rejection/curation ledger — operator decision 5)

**Strictly append-only** (D-015/D-028: no row is ever LLM- or code-mutated in place; state is derived by reading the ledger).

```
brain_rejection {
  id, at: datetime,
  scope_key: string,                  // same shape as proposal dedup subject — what is rejected
  proposal: record<brain_proposal>,
  phase: 'cooldown' | 'permanent',
  cooldown_until: option<datetime>,   // set when phase='cooldown'
  reason: string,                     // operator's or PM's stated reason, screened
  supersedes: option<record<brain_rejection>>,  // escalation cooldown->permanent = NEW row citing prior
  new_evidence: option<array<string>> // required non-empty if a proposal re-opens a rejected scope
}
```

Derived rule (pure function, unit-tested): a `scope_key` is **blocked** iff its latest ledger entry is `permanent`, or `cooldown` with `cooldown_until` in the future — unless the new draft cites `new_evidence` refs that post-date the rejection. Default ladder: first rejection ⇒ 14-day cooldown; second rejection of the same scope ⇒ append a `permanent` row.

### m0084_brain_curation_event (the two-confirmation gate)

Any change to the rejection ledger's *rules* (cooldown lengths, permanence, scope-key shape) **or** any brain-proposed change to rules/skills/workflows applies only after **two separate confirmations** recorded as append-only events:

```
brain_curation_event {
  id, at: datetime,
  target: string,                     // what would change
  change: object,                     // the exact diff, frozen at stage-1
  stage: 1 | 2,
  confirmed_by: string,               // operator identity (D-025 token session)
  applies: record<brain_curation_event> | none   // stage-2 points at its stage-1
}
```

Stage-2 must arrive in a **separate operator interaction** (enforced: different request, >=60s later) and must reference an unexpired stage-1 whose frozen `change` still matches (staleness ⇒ start over). This is the shared primitive with the SkillOpt validation-gate / memory-curator direction — build it as `src/lib/server/brain/curation-gate.ts` with no observer-specific imports so both consumers use the same function (F-055: one gate, every path through it).

### Effectiveness rollup — compute-on-read, no table

Acceptance rate = aggregate over `brain_proposal` statuses, computed on read (the soul/maturity compute-on-read precedent). A read-only projection `brainEffectiveness(db, window)` returns `{proposed, accepted, rejected, expired, acceptanceRate, consecutiveRejections}` — real-surreal-tested. No mutable rollup row to drift.

---

## 4. Safety invariants (each testable; each gets a named test)

- **BO-1 Propose-only.** The observer module graph contains no import of spawn/arm/hire/publish/config mutation functions. *Test: static import-graph assertion + grep-gate in CI.*
- **BO-2 Budget precondition.** With brain token budget = 0 (for the brain, 0 = NOT ARMED — inverse of the general `0 = uncapped` sentinel), tick journals `not-armed` and calls no provider. *Test: real config, assert zero provider calls.*
- **BO-3 Kill switch.** `loop_manifest.enabled=false` ⇒ next tick does not fire (engine gate 2, re-read per tick). UI toggle takes effect <=1 tick. *Test: engine tickOnce with disabled row.*
- **BO-4 Tier pin.** Sense/triage constructs only `OllamaProvider`; Ollama unreachable ⇒ `sensor-offline` journal, no cloud call. *Test: mock endpoint down, assert no ClaudeProvider instantiation.*
- **BO-5 Escalation cap.** 4 escalations exist in window ⇒ 5th anomaly journals `escalation-suppressed-at-cap`; counter survives restart (durable anchor). *Test: seed 4 rows, restart-simulate, assert suppression.*
- **BO-6 Backpressure.** 3 open operator proposals ⇒ no 4th insert; PM routing continues. *Test: seed 3, run an operator-authority draft, assert journal `proposal-suppressed`.*
- **BO-7 D-026 council fencing.** Every reader input passes `screen()` then fence-wraps; the drafting tier's prompt contains no unfenced raw content. *Test: seed a session note containing a secret marker + an injection string; assert marker screened and the injection appears nowhere in the cloud prompt.*
- **BO-8 Provenance mandatory.** A draft with empty `provenance[].concluded_from` is refused at insert (schema ASSERT + code check). *Test: attempted insert fails.*
- **BO-9 D-035a non-steering.** PM advisories go through `peer/send.ts` with server-stamped non-operator origin; a PM ignoring one changes nothing. *Test: origin assertion on the written peer_message row.*
- **BO-10 D-039 operator queue.** Operator-authority items are `brain_proposal` rows born `proposed`; nothing auto-transitions to `accepted`. Acceptance handlers route through existing gate fns (F-055). *Test: no code path writes `accepted` outside the authed UI handler.*
- **BO-11 Rejection ledger honored.** A draft whose `scope_key` is blocked and cites no post-rejection evidence is suppressed and journaled. *Test: seed rejection, re-draft, assert suppression; then with new evidence, assert it passes.*
- **BO-12 Curation two-phase.** A stage-1-only curation event applies nothing; stage-2 with mismatched frozen diff applies nothing. *Test: both paths.*
- **BO-13 Auto-demote.** N consecutive operator rejections (default N=5, §Q1) ⇒ observer self-demotes to observe-only (journals + PM advisories continue; operator proposals stop) until the operator re-arms. *Test: seed N rejections, assert demotion journal + no new proposals.*
- **BO-14 Journal honesty (F-008).** Every fired tick writes exactly one `brain_tick`, including `nothing-notable`, `sensor-offline`, `error`. A tick that crashes mid-way still writes its row (write-first, finalize under F-048 discipline). *Test: inject a mid-tick throw, assert a row exists.*
- **BO-15 D-041 wall.** Cross-project content appears only in atelier-tier context, never in a PM-routed advisory about another project. *Test: advisory to PM A contains no record refs from project B.*

---

## 5. UI — the brain control surface

Extends the existing `/brain` view [VERIFY: `src/routes/brain/+page.svelte`] with an **Observer** panel. Svelte 5 runes in `.svelte`/`.svelte.ts` only (F-009), `{@const}` placement legal (F-011), teal/Lastik tokens (D-034), reactive off the SSE/event stream (D-005) — no polling, and Playwright smoke uses `waitUntil:'load'` (F-010).

**Controls (all live-configurable — operator decision 2):**
- Cadence editor (writes the `loop_manifest` row's cron; invalid cron shown as "never fires" honestly — engine gate 5).
- Cloud-escalations/day cap; brain token budget (nonzero required to arm — the arm control is disabled with an explicit reason while any §4 precondition is unmet).
- **Kill switch** (manifest `enabled` toggle) — one click, no confirm needed to STOP (stopping is always safe); arming requires the precondition check.
- All config mutations route through the existing authed gate/settings path (F-055) — no new unauthenticated mutation endpoint; listener stays loopback + per-boot token (D-025).

**Live stats:** last tick time + verdict + action; next-tick countdown (derived from cadence + engine state via `maintenanceLoopArmed`, `maintenance.ts:88` — shows "not armed: <reason>" when any gate fails, never a fake countdown); escalations used today `n/4`; open operator proposals `n/3`.

**Journal feed:** reverse-chron `brain_tick` list — verdict badge, action, evidence links (each ref navigates to the real record), provider/model/tokens. "Nothing notable" rows render dim but *present*.

**Proposal queue:** operator-authority proposals with provenance expanded ("concluded from:" links), Accept / Reject (reason required — feeds the rejection ledger) / Snooze. PM-routed advisories shown read-only with their delivery state.

**Effectiveness:** acceptance-rate metric (compute-on-read), consecutive-rejection counter, demotion state banner when demoted.

**Honest states throughout:** loading / empty ("observer has never ticked") / `sensor-offline` / `not-armed: <reason>` / stale — never a fabricated value (F-008). Accessible: controls keyboard-reachable, state conveyed by text+icon not color alone.

---

## 6. Dependencies (separate specs to queue — this spec does not build them)

1. **`LOCAL-RUNTIME-LIFECYCLE-SPEC`** — Atelier owns the local model server lifecycle: ensure-up before a sense turn, on-demand model load, idle-unload (Ollama `keep_alive` tuning, or llama.cpp `llama-server` as the alternative backend). Today `OllamaProvider` assumes the server is already running (verified: no lifecycle code in `providers/index.ts`). **Blocking for v1's "always sensing" promise**; v1 can ship before it only with the honest `sensor-offline` degradation.
2. **`ATELIER-IDENTITY-COMPOSE-SPEC` (D-040)** — replace the `resolveAtelier` placeholder (`peer/resolve.ts:131-170`) with a composed durable `atelier_self`: stable identity record, append-only observation + rejection memory mounted into every brain turn (tick, consult, and peer-reply alike — one self, not three). **Blocking for v1** (operator decision 7: identity first). The journal/ledger tables in §3 ARE this identity's memory substrate — compose-identity is mostly wiring them into the concierge turn context. (Note: Stage-1 already stamps `session.pm='pm:atelier_self'`, m0074, on a short-lived session — what's missing is durability + memory continuity.)
3. **`PER-ROLE-MODEL-CONFIG-SPEC` + model-role-effectiveness analytics** — generalize the `defaultProvider auto|local|cloud` toggle into per-role assignments (sensor=local, reasoner=cloud, per-kind overrides) with `writeRoutingEvent`-style analytics per role-turn, so the local-brain hypothesis (see `MODEL-BENCHMARK-SPEC.md`) gets measured by the observer's own traffic. **Non-blocking** — v1 hard-codes the two-tier pin; this spec later replaces the hard-coding.

---

## 7. Phased build

**v1 — the eye (no mouth).** Compose identity (dep 2 minimal) · `m0081 brain_tick` · digest builder · local triage · journal + `/brain` Observer panel (stats, journal, cadence, kill switch) · §4 preconditions · BO-1..5, BO-14 tests. **No proposals of any kind — visible observation only.**
*DONE-WHEN: the operator watches ticks land in the journal on the live DB every 30 min for 48h, including honest `nothing-notable` and `sensor-offline` rows, with cloud spend = $0.*

**v2 — the quiet voice.** `m0082 brain_proposal` · cloud escalation (cap 4/day) · operator proposal queue UI + accept/reject · `m0083` rejection ledger · backpressure cap 3 · acceptance-rate metric · auto-demote · BO-5..6, BO-8, BO-10..11, BO-13 tests. Weeks 1–2 after arming = **calibration**: acceptance < ~1/3 ⇒ tune the rubric or demote (operator decision 8).
*DONE-WHEN: first real anomaly produces an operator proposal with clickable provenance, and a rejection provably suppresses its scope for the cooldown.*

**v3 — depth + delegation.** Reader council (screen+fence, distilled provenanced findings) · PM/hire advisory routing (authority table) · `m0084` curation two-phase gate · BO-7, BO-9, BO-12, BO-15 tests.
*DONE-WHEN: an escalation demonstrably diagnoses from raw content the digest alone could not, via council findings whose provenance the operator can audit, and a PM receives (and is free to ignore) an advisory.*

Each phase is a v2-wave with the full D-038 end-gate (live `db:up`, render-smoke every new load, devlog).

---

## 8. Risks & open questions

- **Alert fatigue is the failure mode that kills this feature.** Mitigations are structural (caps, backpressure, rejection ledger, auto-demote) but the *triage rubric* is the real dial — hence proposal-less v1 and the calibration window. Risk accepted, instrumented.
- **Local-model triage quality is unproven.** gpt-oss:20b classifying a structured digest is a far easier task than open reasoning, but if it hallucinates anomalies, cloud spend follows. Mitigation: escalation requires *code-validated* structured output + evidence refs that must resolve to real records; the benchmark harness (m0076/m0077) can score triage turns. Falsifiable in v1 (journal shows verdicts with zero cost of being wrong).
- **Digest blind spots.** The observer only sees what the digest aggregates; the invisible-failure class it was built for could recur *inside* it. Mitigation: the digest composition is itself journaled (`digest_summary`), so "the observer never looked at X" is auditable; extending the digest is a normal PR, not a schema change.
- **Council cost shape.** Readers are cloud sub-agent spawns; a pathological anomaly could name maximal domains every escalation. Bound: <=3 readers per escalation, readers count against `dailySpawnCap`, council total under the brain budget. (§Q4.)
- **Two ticking engines' interaction.** The observer observes queues the maintenance loops also touch; a mis-rubric could propose "fixes" for states another loop is mid-way through handling. Mitigation: digest includes loop-fire recency so triage sees "maintenance already acted Xm ago"; watch in calibration.
- **Open:** should `watch` verdicts decay (auto-drop after M quiet ticks) or require triage to re-affirm each tick? Default: carry <= 6 ticks then drop, journaled. Decide at build.
- **Open:** does the composed identity's observation memory feed S0 recall for *all* concierge turns immediately, or stay observer-scoped until judged clean? Default: observer-scoped in v1, promoted in v3. Decide in the identity spec.

---

## QUESTIONS FOR OPERATOR

1. **Auto-demote threshold N (consecutive operator rejections → observe-only)?** Recommended default: **N=5** consecutive, counting only *operator-facing* rejections (PM-ignored advisories don't count). Auto-demote resets on any acceptance.
2. **Confirm v1 ships proposal-less (journal-only) and runs ~1 week before v2 arms proposals?** Recommended: **yes** — zero-risk baseline of triage quality; front-loads identity + data + UI that v2/v3 stand on.
3. **Per-PM advisory rate limit for v3 routing?** Recommended: **max 2 advisories per PM per 24h, deduped by scope_key** (mirrors the pm-concierge consult dedup). Without it, a global anomaly (Ollama down) fans one root cause into an advisory per project.
4. **Council spend bound?** Recommended: **<=3 readers per escalation, cheapest adequate cloud model, whole council charged against the brain's own nonzero budget** (never the general pool). Tighter alternative: council disabled until acceptance-rate clears ⅓ in calibration.
