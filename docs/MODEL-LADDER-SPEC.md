# MODEL-LADDER-SPEC — a complete, legible model ladder + fable-as-planner-only + model fitness trials

> Drafted 2026-07-26 (planning agent, fresh-context, all claims verified by direct reads).
> Operator decisions locked before drafting: ① fable enforcement = hard gate, fail-closed at the
> routing chokepoint; ② model fitness = reuse the HR gauntlet, not a new subsystem; ③ local
> Claude-Code = spec now, build later; ④ ladder clarity = self-describing config + live `/settings`
> panel. Status: **SPEC — FINAL (operator answers 2026-07-26 folded in, §13).** Migration head at
> drafting time: `m0085` (`schema.ts:3174` — m0083/m0084/m0085 landed with the analytics-visibility
> wave; CLAUDE.md's `m0082` note is stale); anything here takes the next free number after m0085.

---

## 0. Corrections to the briefing (found during grounding — read these first)

1. **The codebase still enforces the SUPERSEDED "fable-5 retired" policy.** `config/load.ts:30-39`
   defines `MODEL_IDS = ['claude-opus-4-8','claude-sonnet-4-6','claude-haiku-4-5-20251001']` with the
   comment "claude-fable-5 is RETIRED (opus-everywhere) and is INTENTIONALLY excluded", and
   `loadAgentPool` fail-closes any `claude`-provider tier whose model is not in that set
   (`load.ts:929-948`, CA-H3). `load.test.ts:58-61` pins the rejection ("rejects a retired claude
   tier model id (fable-5) at the boundary"). This is **stale against the 2026-07-07 model-roles
   policy** (CLAUDE.md §2.5: fable-5 reinstated as the planning model). Consequence: a `planner`
   tier pinned to `claude-fable-5` **cannot boot today** — Phase 2 must update `MODEL_IDS`, the
   loader comment, and flip that test. (Note: explicit *overrides* bypass this loader check entirely
   — they never pass through `loadAgentPool` — which is exactly why live `routing_event` rows for
   fable-5 exist despite the allowlist. That bypass is itself a gap this spec closes, §3.4.)
2. **CLAUDE.md geography table is stale on the migration head** (says `m0082`; the codebase's
   `schemaMigrations` ends at `m0085_thinking_ledger`, `schema.ts:3089-3174`). Codebase wins.
3. **The briefing's "staffing path conditionally spreads a tier" is at `resolve.ts:298`, confirmed**
   (`...(staffed.tier ? { tier: staffed.tier } : {})`), and the override path writes
   `chosen: input.override` unchanged at `resolve.ts:262` — confirmed. But the boot-level
   defaultProvider override DOES carry a tier (`boot.ts:302` returns
   `{ provider, modelId, tier: tierName }`), so the tier-less explicit events come from *other*
   override callers. The fix (§3.3) is therefore placed at the chokepoint, not in any one caller.
4. **`VERSIONING-AUDIT-SPEC.md` §7 numbers its migrations `m0082/m0083` — stale** (head is m0085).
   Whichever spec builds later renumbers; this spec claims `m0087` (m0086 was CONSUMED by the shipped m0086_boot_skip_ledger) (§9).

Everything else in the briefing checked out against the code cited below.

---

## 1. Problem (ground truth, every claim traced)

1. **No model→tier map exists.** `agent_event.model.tier` is a verbatim caller-supplied string:
   `AgentEventModel.tier?` (`analytics/events.ts:62-67`) written unchanged at `events.ts:265`;
   schema `option<string>` (`schema.ts:189`). `routing_event.chosen.tier` likewise
   (`schema.ts:171`, written at `resolve.ts:470-474`).
2. **An explicit model pick is born tier-less.** `resolveRoute` step 1 writes
   `chosen: input.override` with no tier resolution (`resolve.ts:255-280`, the F-005 short-circuit).
   Analytics grouping by tier silently drops every explicitly-picked run.
3. **The ladder is real but undocumented and closed.** `config/agent-pool.yaml:11-23` defines tiers
   `local/haiku/sonnet/opus`; escalation order at `:44-45`; `opus` pins `claude-opus-4-8` (`:23`).
   No tier carries purpose/when-to-use text; nothing renders the ladder's *meaning*.
   `/settings` already renders a read-only `TierView` (name/provider/model —
   `src/routes/settings/+page.server.ts:57,88,118,154`) — the seam for §6 exists.
4. **The tier-name enum is hardcoded in FIVE places** — the drift trap for any new tier:
   `role.preferred_tier` ASSERT (`schema.ts:1069-1070`), `role_version.default_tier` ASSERT
   (`schema.ts:1086`), `interview_run.tier` ASSERT (`schema.ts:1107`), the TS union
   `workforce/repo.ts:52` (`type Tier = 'local'|'haiku'|'sonnet'|'opus'`), and the
   `allowed_auto_tiers` allowlist (`config/load.ts:759-770`).
5. **Pricing is honest-NULL for unknown models by design.** `config/pricing.yaml:23-35` lists only
   the four live ladder models; `resolveCostUsd` leaves `cost_usd` NONE and warns once per model per
   boot for an unpriced model (`analytics/events.ts:231-248`). Neither `claude-fable-5` nor any
   `claude-opus-5*` is priced.
6. **There is no fitness gate.** Any model id an override or config names is trusted immediately
   with whatever duty routing hands it. The machinery to trial a candidate ALREADY exists and is
   model-parameterized: `RunGauntletInput { roleVersionId, tier, provider, modelId, trigger }`
   (`gauntlet.ts:337-347`) — "model_id is the certification axis" is stated on the schema itself
   (`schema.ts:1100-1102`). The deterministic scorer (`workforce/scorer.ts`, `scoreFindings`
   ~`:254`), ambiguity queue + batch-or-nothing adjudication (`gauntlet.ts:959-974`; noted
   batch-or-nothing at `auto-adjudicate.ts` header, citing `gauntlet.ts:922`), the dismiss-only
   auto-adjudication layer (`auto-adjudicate.ts` header invariants), snapshot `pass_criteria`
   (`schema.ts:1126`), and the interview budget gate (`gauntlet.ts:104 checkInterviewBudget`,
   `trigger: 'operator'|'auto'`) are all live, tested machinery.
7. **A model benchmark harness already shipped and is NOT duplicated here.**
   `docs/MODEL-BENCHMARK-SPEC.md` — objective A/B (class A), thinking capture (m0076), judged
   LLM-eval (m0077, judge ≠ model-under-test). It measures *quality signals*; it does not issue a
   *certifying verdict*. §5.6 defines the relationship.

---

## 2. What this spec ships (one sentence each)

- **§3 The registry:** one config-owned model→tier map, self-describing tiers, and tier resolution
  at the routing chokepoint so no event is born tier-less.
- **§4 The planner gate:** fable is planner-only, enforced fail-closed at `resolveRoute`, with an
  honest recorded refusal and a deterministic fallback (planner→opus for plans; normal ladder for
  everything else).
- **§5 The duty trial:** a candidate model earns a duty by running the existing gauntlet against a
  frozen duty-probe role; the verdict is a D-042 versioned, server-stamped artifact.
- **§6 The live ladder panel:** `/settings` renders the real ladder from the real config —
  purpose, duties, price, fitness — so explanation cannot drift from behaviour.
- **§7 Local Claude-Code:** specified with grounded feasibility findings; build deferred,
  gate:operator.

---

## 3. Adding a new model — the operator checklist (first-class)

To take a brand-new model id — cloud or local — from "string" to "tiered, priced, routed, trialed,
explained", touch exactly these, in this order:

| # | Step | File / surface | Why this order |
|---|------|----------------|----------------|
| 1 | **Price it (or explicitly 0/0 for local).** Only a price you can verify; absent = honest NULL + once-per-boot warn (`events.ts:239-244`) **+ the system raises a research task / CTA to close the gap (§3c)**. Never guess (pricing.yaml header rule, `:13-15`). | `config/pricing.yaml` (loader `load.ts:78 loadPricing`) | Trials (step 5) spend real tokens; price FIRST so `cost_usd` meters from the first trial run (ML-10). |
| 2 | **Allowlist the id (claude provider only).** Add to `MODEL_IDS` (`config/load.ts:35-39`). Non-claude providers (ollama etc.) are intentionally NOT bound to this list (`load.ts:929-934`). | `config/load.ts` + its pin test `load.test.ts` | The pool loader fail-closes an unlisted claude id (`load.ts:943-948`) — nothing else works until this. |
| 3 | **Pin it to a tier.** Existing tier: change the tier's `model:`. New tier: add the tier block WITH its §3.2 doc fields, add it to `escalation.order` if it's on the general ladder (planner is NOT, §4.2), add a slot if role-mapping matters (`agent-pool.yaml:28-40`). | `config/agent-pool.yaml` | The pool is the ONLY model→tier authority (ML-1). |
| 4 | **New tier NAME only: widen the five hardcoded enums** via the §9 migration + TS edits (`schema.ts:1069,1086,1107`; `repo.ts:52`; `load.ts:763`). | migration `m0087`+ / two TS files | Skipping this wedges gauntlet runs (`interview_run.tier` ASSERT rejects the new name) and role staffing. |
| 5 | **Trial it before trusting it (§5).** Run the duty trial for each duty you intend to hand it. Operator approves the verdict (B4/D-039). | `/agents/ceremony` surface + `runModelTrial` (§5.3) | An untrialed model may exist in config; it must not be *staffed or duty-routed* until a `fit` verdict exists for that duty (ML-8; enforcement per §5.5). |
| 6 | **Restart + verify.** Config is boot-read (F-029 — `/settings` already shows the restart-needed banner, `+page.server.ts:294,320`). Then: `/settings` shows the tier documented+priced; drive one task; check its `routing_event.chosen.tier` is non-null and its completion `agent_event.cost_usd` is non-NULL (or genuine 0). | dev server + `/settings` + `/reports` | The green bar is behaviour, not config diff. |

**Local-model variant:** steps 1 (0/0), 3 (provider `ollama`, id free-form), 4 if a new tier name,
5, 6. Step 2 does not apply. Note the Stage-1 capability boundary: an ollama-backed tier runs a
single chat turn, no tools/interject (`ollama-backend.ts` header) — a duty trial that requires
tool-use will honestly fail for such a model until §7 lands. That failure is a finding, not a bug.

---

## 3b. The registry — self-describing tiers + chokepoint tier resolution

### 3.1 One authority

`agent-pool.yaml` **is** the model registry (reuse check: it already binds tier→provider+model and
the loader validates it fail-closed, `load.ts:919-967`; do not add a second file). This spec adds
per-tier documentation fields and derives, at load, the reverse map `modelId → tierName`.

### 3.2 New per-tier fields (agent-pool.yaml)

```yaml
tiers:
  opus:
    provider: claude
    model: claude-opus-4-8
    purpose: "Build / code / research / large-context execution."   # required-by-DoD
    when: "Implementation, debugging, codebase scouts, wave build/fix/review/red-team."
    escalates_to: null            # top of the general ladder
    duties: null                  # null/absent = UNRESTRICTED (any duty)
  planner:                        # NEW tier — §4
    provider: claude
    model: claude-fable-5
    purpose: "Plan / spec / workflow authoring ONLY (operator policy 2026-07-07)."
    when: "Planning-shaped tasks; PM plan requests; wave authoring."
    escalates_to: opus            # the planner FALLBACK, not a ladder rung
    duties: [plan]                # duty-restricted: the §4 gate enforces this
```

Loader rules (extend `loadAgentPool`, `load.ts:919`): `purpose`/`when` optional strings,
`escalates_to` optional and must name an existing tier, `duties` optional list drawn from the §4.1
duty vocabulary (unknown duty = ConfigError, fail-closed at boot — a typo'd duty would silently
un-restrict a restricted model). Absent doc fields do NOT fail the boot (this is legibility, not a
security boundary — F-053/D-024 scope discipline); the UI renders an explicit "undocumented tier"
state instead (F-008), and this spec's Phase 1 DoD requires all shipped tiers documented.

### 3.3 Tier resolution at the chokepoint (fixes the tier-less explicit pick)

In `resolveRoute`, before `writeRoutingEvent` on the **override** path (`resolve.ts:259`) and the
**staffed** path (`resolve.ts:295-299`): when `chosen.tier` is absent, resolve it from the pool
reverse map (`modelId → tierName`). A miss resolves to **absent (honest null)** plus a once-per-boot
named warning — mirror the `resolveCostUsd` warn-once idiom (`events.ts:238-244`), never a guessed
tier (ML-2). `events.ts` stays a verbatim recorder (single-owner discipline: routing derives,
analytics records — the same producer/owner split the file header declares, `resolve.ts:15-18`).

### 3.4 Overrides join the allowlist honestly

Today an explicit override is validated nowhere (§0.1). The chokepoint additionally checks a
`claude`-provider override's `modelId` against `MODEL_IDS`: an unknown/retired id is **refused with
the same mechanics as §4.4** (re-resolve through the normal ladder, honest reason recorded) — a
spawn on a nonexistent model is worse than a redirect (the same argument as CA-H3,
`load.ts:929-931`). Non-claude ids pass through (their provider validates, as at `load.ts:932-934`).

---

## 3c. Unpriced model → actionable research work (operator addition, 2026-07-26)

**Rule:** when a model id is routed or configured with NO verified pricing entry, the honest-NULL
path and the loud once-per-boot warning stay EXACTLY as they are (`events.ts:231-248`; pricing.yaml
`:13-15` — never guess a price) — **and** the system raises actionable work to close the gap
instead of tolerating a permanent silent hole. Generalized: this fires for ANY unknown/unpriced
model id, not just fable-5 — it is the missing half of the §3 checklist: the system ASKS for what
the checklist needs.

### 3c.1 Mechanism chosen: `proposeTask` + an always-on operator CTA (and why)

Three candidates were evaluated against the existing machinery:

- **`proposeTask` (`projects/pm-proposals.ts:187`) — CHOSEN for the durable work item.** It is the
  single `status='proposed'` chokepoint; it enforces the §4.1 contract (objective / purpose /
  acceptance_criteria / provenance with `kind` + ≥1 real evidence ref — `pm-proposals.ts:140-149`);
  and D-039 is a FEATURE here: the task is born `proposed` and the operator keeps approval —
  exactly right for "please go research a price". **Enum check, as asked:** `provenance.kind` is a
  free string, not an enum — `TaskProvenance { kind: string; evidence: string[]; … }`
  (`tasks/repo.ts:105-110`), and the schema column is `FLEXIBLE TYPE option<object>` with no ASSERT
  (`schema.ts:1250`). So the new value `kind: 'unpriced_model'` is a naming convention, **no type
  widening and no migration needed** — it must simply be documented here as the canonical kind
  string.
- **A decision brief (`proposal_gate`/`repo_create` pattern) — rejected.** Briefs gate a pending
  ACTION awaiting operator confirm; here the missing thing is *labor* (research a price), and the
  eventual "action" (editing pricing.yaml) is already operator-only by construction. A brief would
  add ceremony without adding a gate that doesn't already exist.
- **Plain UI CTA only — rejected as the sole mechanism, kept as the second layer.** A CTA alone is
  not durable work (closes the tab, loses the ask), but it is dependency-free and always honest —
  so it is ALWAYS rendered wherever the unpriced state shows (§3c.3), independent of whether a
  proposal could be raised.

### 3c.2 The proposal (shape, trigger, idempotency)

- **Shape:** title `"Research verified pricing for <model_id>"`; objective: supply verified
  per-1M-token list prices; purpose: unpriced spend is invisible to the 15M/5M budget meters
  (ML-10); acceptance_criteria: `config/pricing.yaml` entry added with a source the operator can
  verify · once-per-boot warning gone on next boot · `/settings` row shows priced;
  `provenance: { kind: 'unpriced_model', evidence: ['model:<model_id>', 'config/pricing.yaml'] }`.
- **Target project:** the D-040 self-hosting seam (`atelier_self`) — model pricing is a platform
  concern, not a per-project one. `proposeTask` hard-requires a hired PM with propose/act authority
  (`pm-proposals.ts:192-202`); when the self-project PM does not (yet) exist, the propose attempt
  is skipped with a named log line and the §3c.3 CTA remains the visible ask — an honest degraded
  state, never a shadow writer (`createTask` is not called directly; the chokepoint comment at
  `pm-proposals.ts:344` marks the revise path as the only sanctioned exception).
- **Trigger:** the existing once-per-boot unpriced-model warn chokepoint (`resolveCostUsd`'s
  `warnedUnpricedModels` set, `events.ts:238-244`) — when a model id first warns in a boot, a
  fire-and-forget propose attempt is enqueued. Best-effort: a propose failure never blocks or
  throws into the `agent_event` write, and (CLAUDE.md §4 rule) the best-effort path carries a
  happy-path test proving it actually proposes. Models that are configured but never routed are
  covered by the §3c.3 CTA (the `/settings` loader already computes the unpriced set for §6).
- **Idempotency / anti-spam (one open item per model id, never one per routing event):** three
  existing layers, no new mechanism —
  1. the warn-once set bounds the trigger to once per model per boot (`events.ts:239`);
  2. `proposal_fingerprint` — sha256 over (project, `'task'`, `provenance.kind`, sorted evidence),
     deliberately excluding free text (`pm-proposals.ts:90-100`) — is stable per model id, so a
     re-trigger absorbs into the standing open proposal (`outcome:'duplicate_open'`,
     `pm-proposals.ts:208-217`). **F-048 note, as asked:** the fingerprint is computed from
     immutable inputs only (kind + evidence), never from a mutable field like status — status is
     only the *filter* ("open proposals"), which is the wanted semantic: a gap that persists after
     a closed/rejected proposal may legitimately re-raise, subject to layer 3;
  3. the operator defer window + open-proposal cap (`pm-proposals.ts:220-260`) — "stop asking me
     about this model" is already a built, structural suppression.

### 3c.3 The CTA (always-on second layer)

Wherever the unpriced state renders — the §6 `/settings` ladder row and the `/reports` tier/spend
table — the warning carries the call-to-action inline: "unpriced — cost records NULL and is
invisible to budgets. [Research pricing for `<model_id>`]", linking to the open research proposal
when one stands, else offering the propose action (operator-clicked propose needs no PM-authority
path: the operator IS the authority; it goes through the same `proposeTask` chokepoint via the
existing form-action pattern). No fabricated urgency, no auto-editing of pricing.yaml — the write
stays a manual, verified operator edit per the file's own header rule.

---

## 4. Fable is planner-only — the hard gate

### 4.1 Duty model (minimal, additive)

A **duty** is a coarse task classification the gate can act on. Initial vocabulary: `plan`. (Room
to grow: `mechanical`, `judge` — NOT specified now; YAGNI until an operator decision restricts a
second model.) A task's duty is resolved at routing time, in precedence order:

1. **Explicit**: `RouteTask` (`resolve.ts:48-65`) gains optional `duty?: 'plan'` — set by callers
   that *know* (the plan-refine Atelier twin, a PM plan request). Server-side callers only; it is
   a routing hint, not a privilege (the gate never *grants* on duty — it only *restricts*).
2. **Staffed role**: a role whose `role_version.default_tier` is a duty-restricted tier implies
   that duty (the staffing ceremony is the vetting).
3. **Classified**: a new intent `plan` added to the five (`resolve.ts:39-45`, mirrored in the
   runtime `Intent` type and an `orchestration.yaml` D-020 bundle — the bundle MUST be added,
   `resolveAdaptiveConfig` is the config-validated lookup, `resolve.ts:177-186`). Classifier: a
   conservative title-leading pattern (`^\s*(plan|spec|draft a (plan|spec|roadmap))\b`-family),
   tested FIRST in `classifyIntent` order (order is load-bearing, `resolve.ts:107-127`).
   `INTENT_WEIGHT['plan'] = 0.85` (planning is a top-tier thinking job). Intent `plan` ⇒ duty
   `plan`; every other intent ⇒ duty unrestricted-general.

### 4.2 Routing a planning task (the happy path)

Duty `plan` short-circuits tier selection (the same shape as the staffing short-circuit,
`resolve.ts:282-329`): prefer the tier whose `duties` contains `plan` (i.e. `planner` → fable-5)
when configured AND its provider is healthy; else fall back to the tier named by the planner tier's
`escalates_to` (default `opus`); recorded `method:'classify'`, reason
`"duty plan → planner tier (fable) | planner unavailable → <fallback>"`. The `planner` tier is
**not** in `escalation.order` — general complexity-tiered work can never *land* on it by walking
the ladder (`tierLadder`, `resolve.ts:157-163`, only reads `escalation.order` + the `local` floor),
which makes the gate's job small.

> **On "ELSE opus-5":** no `claude-opus-5*` id exists anywhere in the codebase or pricing
> (`config/pricing.yaml:23-35`, `load.ts:35-39` — verified). The fallback is therefore specified as
> **the tier named in `planner.escalates_to`** — today that resolves to the `opus` tier's pinned
> model (`claude-opus-4-8`, `agent-pool.yaml:23`). The day the operator adds `claude-opus-5` via the
> §3 checklist and repins the `opus` tier (or points `escalates_to` at a new tier), the fallback
> follows automatically. No literal model id is hardcoded in the gate. **CONFIRMED by the operator
> 2026-07-26** — the tier indirection is exactly the intent.

### 4.3 The gate (every path, one function)

`enforceDutyPolicy(pool, duty, chosen)` — pure JS, called inside `resolveRoute` **after** each
candidate selection and **before** `writeRoutingEvent`, on ALL paths: explicit override (`:255`),
staffed (`:290`), classify/tier (`:391`), health-fallback (`:395`). F-055 is the reason for the
placement: a gate bypassed via a new call path is the named failure mode, and `resolveRoute` is the
single chokepoint every spawn's model decision already flows through (`boot.ts:313-323`). Rule: if
`chosen`'s tier (or, for a tier-less pick, the reverse-mapped tier of `chosen.modelId` — so an
override naming fable-5 directly cannot dodge the gate by omitting the tier) declares `duties`, and
the task's duty ∉ duties → the pick is **refused**.

### 4.4 What "refuse" means (the D-024 / F-053 reconciliation — read carefully)

Two different things fail in two different directions, and naming them separately is the whole
design:

- **The INVARIANT is fail-closed:** a duty-restricted model NEVER spawns for a foreign duty. No
  configuration outage, no health state, no caller identity makes fable run a build task. This is
  a policy invariant enforced with security-gate rigor (the operator locked it), even though it is
  not a D-024 *security* boundary.
- **The TASK is not fail-closed:** refusal of the *pick* never strands the *work* (that would be
  exactly the F-053 failure — an un-wired/misrouted branch bricking traffic the ladder can serve).
  On refusal, `resolveRoute` **re-resolves through the normal order** (classify → tier → health)
  with the refused tier excluded, and the task proceeds on that model. The only way a task gets no
  model remains the pre-existing "no healthy provider anywhere" honest state (`resolve.ts:385-389`).

**What the caller sees:** a normal `ResolvedPlan`, whose `method` is the new `'policy'` member of
`ROUTING_METHODS` (`resolve.ts:35` — TS-only widening; `routing_event.method` is un-ASSERTed
`TYPE string`, `schema.ts:172`, so no migration), whose `reason` is explicit
(`"policy: claude-fable-5 is planner-only (duties [plan]); task duty <d> → re-routed to <tier>"`)
and whose `alternatives` carries the refused pick as a structured entry — the same how/why contract
the health fallback already uses (`resolve.ts:352-366`). The routing-rationale surface
(`analytics/routing-rationale.ts`) then renders it with zero new plumbing. Nothing is silent;
nothing is fabricated; nothing stops.

**F-005 tension, stated loudly (operator decision, 2026-07-26):** this deliberately bends F-005's
"an explicit override MUST win" (`resolve.ts:10-13`) for duty-restricted tiers/models ONLY. The
operator confirmed there is **no per-call bypass — not even for an explicit operator pick**: an
operator routing fable onto a build task is re-routed like any other caller. The escape hatch is
editing `duties` in config (one knob, restart, no shadow path), never a per-call flag. The
non-negotiable compensation is honesty: every re-routed pick — operator picks included — is
recorded as `method:'policy'` with the refused selection in structured `alternatives` and an
explicit `reason`, surfaced through the routing-rationale view, so an overridden pick is never
silently swallowed: the operator can always see THAT their pick was re-routed and WHY. An override
naming any unrestricted model behaves exactly as today, byte-identical.

### 4.5 Tests that pin the gate (Phase 2 DoD)

Override→fable on a build task refused+re-routed with `method:'policy'`; staffed-to-fable non-plan
role refused (reason cites the staffing row id, as the staffed path already does for its chain,
`resolve.ts:301-304`); plan-duty task routes to planner when healthy; planner-provider-down falls
back to `escalates_to` tier; `duties`-free pool byte-identical to today (regression); real-surreal
write of a `method:'policy'` routing_event (F-020 class: `stubDb` does not parse SurrealQL).

---

## 5. Model fitness — the duty trial (reuse the gauntlet)

### 5.1 What a trial is

A **duty trial** = the existing gauntlet run where the SUBJECT is the model, not the role:
`runGauntlet(deps, { roleVersionId: <duty-probe role_version>, tier, provider, modelId: <candidate>,
trigger })` (`gauntlet.ts:337-358`). Everything downstream is untouched machinery: workspace
materialization, plants, the deterministic scorer, the ambiguity queue, snapshot `pass_criteria`,
the budget gate, the §3.6 retry. `interview_run` already stamps `provider`/`model_id`/`tier`
(`schema.ts:1107-1109`) with model_id as the certification axis (`schema.ts:1100-1102`) — the axis
inversion costs ZERO new run machinery.

### 5.2 Duty-probe roles

Per duty, ONE reference role (slug `duty-probe-<duty>`, first: `duty-probe-plan`) whose
`role_version` is **frozen** for comparability: same `prompt_sha`, and trials should run against the
same `fixture_set_sha` (both already stamped per run, `schema.ts:1106,1110`; the `stale` flag
`:1128` marks pool drift honestly). Plant design for the `plan` duty uses the detection modes the
scorer already speaks (`scorer.ts` header: `presence`/`absence`/`noncompliance`): fixtures embed a
planted contradiction the plan must surface (presence), a mandatory constraint the plan must not
drop (absence-of-omission via presence-of-treatment), and an embedded instruction the candidate must
refuse (noncompliance — the injection family the auto-adjudicator already recognizes). Probe
fixtures + keys are drafted by the recruiter and **approved as a SET by the operator** — the B2
ceremony verbatim (HR-RECRUITER-SPEC §3).

### 5.3 The thin wrapper (the only new code)

`runModelTrial(db, { modelId, provider, tier, duty, trigger })` in `workforce/` — resolves the duty
probe's active `role_version`, delegates to `runGauntlet`, and on a terminal run persists the §5.4
verdict. It adds NO scoring, NO adjudication, NO pass bar of its own (B3).

### 5.4 The verdict — a D-042 artifact, not a new mechanism

A fitness verdict ("model M is fit/unfit for duty D, on this evidence") is exactly the D-042
artifact class (D-042, `DECISIONS.md:571`: versioned, server-stamped source/reason/when/supersedes;
"a model-fitness verdict is exactly such an artifact" per the operator's constraint). Therefore:

- **Substrate:** `artifact_version` from `VERSIONING-AUDIT-SPEC.md` §2.1, with an **additive kind
  widening**: `artifact_kind: 'model_fitness'` (the spec itself sanctions additive kind widenings,
  §2.1 kind row). `artifact_key = '<model_id>|<duty>'` (immutable inputs only — F-048).
  Content = the verdict JSON `{ verdict: fit|unfit|insufficient_evidence, interview_run: <id>,
  recall, false_positives, pass_criteria_snapshot, judged_signals?: <m0077 refs> }`;
  `content_hash` over it; `source` server-stamped `'hr_recruiter'` (auto path) or `'operator'`;
  `reason = { kind: 'interview_run', ref: <id> }` — never NULL here, a verdict without evidence is
  not written (F-008). Supersession = re-trial appends; history never edited.
- **Dependency, stated honestly:** the `artifact_version` table is SPEC'D, NOT BUILT
  (D-042 consequences: "queued in BUILD-QUEUE, gate:operator"). Phase 3's verdict persistence is
  **blocked on versioning-audit v1**. D-042 forbids a parallel mechanism, so the interim is NOT a
  shadow table: until the substrate lands, the `interview_run` rows themselves are the queryable
  evidence and `/settings` §6 renders "trialed — verdict artifact pending substrate" (an honest
  state), with the pass/fail visible from the run.

### 5.5 What a verdict gates

A `fit` verdict is a **precondition for trust, not a router input**: (a) the §3 checklist requires
it before staffing/duty-routing a new model; (b) the workforce ceremony surface shows it beside the
role certification; (c) `allowed_auto_tiers` (`load.ts:759-770`) SHOULD only name tiers whose pinned
model holds a `fit` verdict for the duties auto-hiring exercises — enforced as a **warning surface
in the UI, not a boot failure** (F-053 scope discipline: today's four models predate the trial
system; hard-failing the boot on them would brick a working ladder). Operator may harden later.

### 5.6 Relationship to MODEL-BENCHMARK-SPEC (no duplication)

The benchmark harness measures *comparative quality signals* (objective A/B rollups, judged
confidence/reasoning per m0077) and remains on-demand. The duty trial issues a *certifying verdict*
against a deterministic bar. The trial MAY attach m0077 judged signals to the verdict JSON as
context (`judged_signals`), but they never move the pass bar (B3, ML-7). The benchmark's deferred
"real local-vs-cloud run" is untouched by this spec.

### 5.7 B1–B4, translated to a MODEL subject (the operator's explicit ask)

- **B1 — no self-certification.** The candidate model never judges its own trial. Holds by
  construction in the deterministic half: the scorer is product code running OUTSIDE any session
  ("answer keys never enter a transcript", `scorer.ts` header). Extended for the model subject:
  (i) any LLM-judge signal attached to a verdict must run on a model ≠ the candidate — prior art
  already enforces exactly this ("judge = cloud model read live from the pool (never the local
  model under test)", MODEL-BENCHMARK-SPEC step 4); (ii) the candidate model must not be the model
  that DRAFTS the duty-probe keys it will be trialed against (recruiter drafts on its own certified
  model; operator approves the set — B2); (iii) the auto-adjudication layer, if it runs, keeps its
  dismiss-only clear-case rule (`auto-adjudicate.ts` — only `dismiss` is ever auto-applied;
  `false_positive`/`confirm_hit` always escalate).
- **B2 — operator approves the key-SET, doesn't author it.** Unchanged; the duty-probe fixture set
  is one more key-set through the same approval ceremony.
- **B3 — the deterministic scorer stays untouched.** `scoreFindings` is reused verbatim; the trial
  wrapper adds no scoring layer; judged signals are annotations, never bar inputs; auto-adjudication
  remains the separate, audited, dismiss-only layer over the ambiguous queue.
- **B4 — operator keeps the gate.** The verdict is a proposal. The trust flip is the operator's:
  approving the verdict AND making the §3 config edits (which are operator file edits + restart by
  construction). D-039 intact — nothing auto-created escapes review.

### 5.8 Spend

Trials ride the existing double gate: `checkInterviewBudget` for `trigger:'auto'`
(`gauntlet.ts:104,337-346` — operator clicks bypass, the click IS the consent) and the armed
spend budgets (15M/day / 5M/project) which meter via `agent_event.cost_usd` — which is why the §3
checklist prices a model BEFORE trialing it (ML-10): an unpriced candidate's trial spend would be
honest-NULL and therefore invisible to the budget. **Pricing precedes trials, always.**

---

## 6. `/settings` — the live ladder panel

Extend the existing Routing view (reuse: `TierView` + `projectTiers`,
`src/routes/settings/+page.server.ts:57,118,154` — do not build a parallel loader). Each tier row
renders, FROM THE LIVE LOADED CONFIG (never prose duplicated into the page): tier name · provider ·
pinned model · `purpose` · `when` · `duties` (or "unrestricted") · `escalates_to` · effective
ladder position (computed by the same `tierLadder` logic — render the actual walk order, local floor
included) · priced? (pricing map lookup — "unpriced (cost will record NULL)" as an honest warning) ·
fitness (verdict per §5.4 when the substrate exists; else latest trial `interview_run` status; else
"untrialed"). Undocumented tier → explicit "undocumented" badge (F-008 — no filler text). The panel
is boot-config-backed, so it inherits the existing restart-needed banner behaviour
(`+page.server.ts:294,320`, F-029). Duty policy is shown on the planner row: "planner-only —
non-plan tasks are re-routed (see routing rationale)". POJOs only, ISO datetimes in the loader
(F-013); render-smoke in `page.live.test.ts` (file exists beside the route).

---

## 7. Local Claude-Code (spec now — BUILD LATER, gate:operator)

**Goal:** run the real CC harness (tools, gate hooks, interject/resume) against a local model, so a
local candidate can be trialed on tool-using duties instead of the Stage-1 chat-only boundary.

**Grounded findings (what actually exists):**
- The backend seam is already pluggable: `ClaudeCodeRuntime` routes a spawn to `ollamaBackend` when
  `plan.model.provider === 'ollama'`, else the default CLI backend, byte-identical
  (`runtime/index.ts:553-560,575-576`; F-053-clean opt-in branch).
- The CLI backend spawns `claudeBin` (default `'claude'`, option at `cli-backend.ts:288-296,424`)
  with `--model plan.model.modelId` (`cli-backend.ts:582-583`) and an env built from
  `process.env + plan.isolated.env + CLAUDE_CODE_OAUTH_TOKEN` (`cli-backend.ts:595-599`) — i.e. a
  **per-plan env injection seam already exists** (`plan.isolated.env`).
- The Ollama Stage-1 boundary is explicit and honest: no tool-gate/interject/resume, single chat
  turn (`ollama-backend.ts` header + `supportsInterject/supportsResume=false`).

**What would actually change (build-later work items):**
1. A `local-cc` execution mode selected per TIER, not per provider string: `agent-pool.yaml` tier
   gains optional `backend: cli|ollama|local-cli` (loader-validated), and the runtime's backend
   pick keys on it instead of the hardcoded `provider === 'ollama'` test (`runtime/index.ts:553`).
   Additive: absent field ⇒ today's behaviour byte-identical (F-053).
2. `LocalCliBackend` = the existing `CliBackend` pointed at a local Anthropic-API-compatible
   endpoint via per-plan env (the `cli-backend.ts:595-599` seam) — **the candidate mechanism
   (`ANTHROPIC_BASE_URL`-style env redirection of the `claude` CLI, or a local proxy translating to
   Ollama) is UNVERIFIED and must be proven by a spike before any build task is cut.** No claim is
   made here that the CLI supports it; that spike is the phase's first task and its kill-criterion.
3. Gate parity comes free IF (2) works: the gate hook rides the isolated settings the CLI already
   loads (`cli-backend.ts:538-542,586-587`) — the model changes, the harness doesn't.
4. The §5 duty trial is the acceptance gate: a local-CC candidate earns tool-using duties through
   the same trial as any cloud model. No trial, no trust.
5. Honest capability matrix stays law: whatever the spike finds unsupported is declared false on
   the backend (`runtime/index.ts:494-497` contract), never stubbed green.

---

## 8. Invariants (each testable; red-team these)

| ID | Invariant | Pinned by |
|----|-----------|-----------|
| ML-1 | `agent-pool.yaml` is the sole model→tier authority; every persisted `tier` is derived from it at the routing chokepoint, never caller-invented. | resolve.test: override with no tier → event carries pool-derived tier |
| ML-2 | Unknown model id ⇒ tier ABSENT (honest null) + once-per-boot warn — never a guessed tier. | resolve.test: unknown id → `chosen.tier` omitted |
| ML-3 | A duty-restricted model never spawns for a foreign duty — on any path (override / staffed / classify / fallback), tier-named or tier-less. Fail-closed, no bypass caller. | §4.5 test set; F-055 grep-gate: `enforceDutyPolicy` called before every `writeRoutingEvent` in resolve.ts |
| ML-4 | A refused pick never strands the task: re-resolution through the normal ladder always runs; refusal is always recorded (`method:'policy'`, structured `alternatives`). | resolve.test: refused → plan returned with fallback model + reason |
| ML-5 | Plan duty falls back deterministically: planner tier when healthy, else `escalates_to` tier. No hardcoded model literal in the gate. | resolve.test with planner provider down |
| ML-6 | B1: the candidate model never scores, adjudicates, or judges its own trial; any judge model ≠ candidate; probe keys are never drafted by the candidate. | trial wrapper test + key-set provenance check |
| ML-7 | B3: `scoreFindings` untouched; judged signals never move the pass bar; auto-adjudication stays dismiss-only. | diff-gate on scorer.ts in the build wave + existing auto-adjudicate tests |
| ML-8 | B2/B4: operator approves the duty-probe key-set and the trust flip; a verdict is a proposal (D-039). | ceremony surface test: no auto-staffing on `fit` |
| ML-9 | D-042: a fitness verdict is an append-only, server-stamped `artifact_version` (kind `model_fitness`); source from the closed vocabulary, stamped by the invoking code path, never from LLM payload; supersession only, no edits. No parallel verdict store, ever. | substrate invariant tests (VERSIONING-AUDIT-SPEC §8) + grep-gate for `CREATE` outside the chokepoint |
| ML-10 | Pricing precedes trials: the trial runner warns loudly (and the checklist orders) when the candidate is unpriced, because unpriced spend is invisible to the budget gates. | trial wrapper test: unpriced model → named warning recorded |
| ML-11 | The `/settings` ladder renders only live config + live verdicts — no prose that can drift, no fabricated fitness/price states (F-008). | render-smoke: undocumented/unpriced/untrialed states each render honestly |
| ML-12 | An unpriced routed/configured model never becomes a permanent silent hole: the honest-NULL cost + loud warn stand, AND actionable work is raised — at most ONE open research proposal per model id (structural `proposal_fingerprint` over immutable kind+evidence, `pm-proposals.ts:90-100`; never keyed on status, F-048), through the `proposeTask` chokepoint only (born `proposed`, D-039), with the CTA always rendered on every unpriced surface. No auto-edit of pricing.yaml, ever. | §3c tests: warn→propose happy path; double-trigger absorbs as `duplicate_open`; no-PM fallback renders CTA + named log; grep-gate: no direct `createTask` on this path |

---

## 9. Migrations

Head verified `m0085` (`schema.ts:3089-3174`). **Numbering coordination:** VERSIONING-AUDIT-SPEC §7
still says m0082/m0083 (stale); whichever build starts second takes the numbers after the first
lands. This spec needs exactly ONE migration:

| id | contents |
|----|----------|
| `m0087_model_ladder_tiers` | Widen the three tier ASSERT enums to include `planner`: re-`DEFINE FIELD OVERWRITE` `role.preferred_tier` (`schema.ts:1069-1070`), `role_version.default_tier` (`:1086`), `interview_run.tier` (`:1107`) with `["local","haiku","sonnet","opus","planner"]`. OVERWRITE-only, additive enum widening — the m0081/m0084 precedent explicitly relied on for idempotency (`schema.ts:2878-2879,2996-3005`); never touches existing rows. Covered by the generic `schemaMigrations` apply-twice + half-applied sweep in `migrate.test.ts`. |

Paired **non-migration** edits shipped in the same commit (the enum lives in five places, §1.4):
`workforce/repo.ts:52` Tier union += `'planner'`; `config/load.ts:763` allowed_auto_tiers allowlist
+= `'planner'` (with §5.5's warning-surface caveat); `config/load.ts:35-39` MODEL_IDS +=
`'claude-fable-5'` + the stale "RETIRED" comments corrected (`load.ts:30-32,929,990`) + flip
`load.test.ts:58` to pin the NEW policy. No verdict-table migration here — §5.4 rides the
versioning-audit substrate by design (D-042).

Live verify: `npm run db:up` against the LIVE dev DB, clean, twice (F-015).

---

## 10. Phased build (each independently shippable, each with its verification command)

**Phase 1 — Ladder legible (no routing-behaviour change).** §3.2 config fields + loader
validation, §3.3 chokepoint tier resolution, §6 `/settings` panel (documented/priced/ladder-walk;
fitness column renders "untrialed" honestly), **§3c unpriced-model research machinery** (warn-
chokepoint propose trigger + `/settings` and `/reports` CTA). No migration.
*Verify:* `npm run build && npm test && npm run lint && npx svelte-check --threshold error`;
`resolve.test.ts` new cases (ML-1/ML-2); render-smoke `/settings` (`page.live.test.ts`); one live
task's `routing_event.chosen.tier` non-null on an explicit override. **§3c (ML-12):** unit — first
unpriced completion in a boot yields exactly one propose attempt with
`provenance.kind='unpriced_model'` and the correct fingerprint inputs; second trigger (same boot or
re-boot) returns `duplicate_open` against the standing proposal; no-hired-PM path skips with the
named log and the CTA still renders (real-surreal where the proposal write is exercised — F-020);
happy-path test on the best-effort propose (a swallowed failure may not hide a dead path).

**Phase 2 — Planner tier + the gate.** §9 migration + the five enum edits; `planner` tier in
`agent-pool.yaml`; fable-5 into `MODEL_IDS`; pricing entry for fable-5 **only if the operator
supplies a verified price** (else honest-unpriced + warn, per pricing.yaml's own rule); `plan`
intent + orchestration bundle; `duty` resolution + `enforceDutyPolicy` + `method:'policy'`.
*Verify:* the §4.5 test set; `node --test` N/A (no wave edit); real-surreal routing_event test
(F-020); `npm run db:up` live, twice; regression: a `duties`-free pool routes byte-identical.

**Phase 3 — Duty trials + verdicts.** `duty-probe-plan` role + operator-approved key-set (B2
ceremony); `runModelTrial` wrapper; verdict persistence as `artifact_version` kind
`model_fitness` — **blocked on versioning-audit v1**; until then trials run and `/settings` shows
run-level evidence with the "verdict artifact pending substrate" state. Budget/pricing ordering
enforced (ML-10).
*Verify:* gauntlet.live.test pattern with a stubbed candidate backend; ML-6/7/8/10 tests;
render-smoke of the fitness column in all three states.

**Phase 4 — Local Claude-Code.** Queued, **gate:operator**, per §7 — first task is the
`ANTHROPIC_BASE_URL`/proxy spike with an explicit kill-criterion; no build tasks cut before the
spike reports.

---

## 11. Non-goals

- No new evaluation subsystem (operator decision 2 — the gauntlet is the trial engine).
- No change to `scoreFindings`, the adjudication flow, or `pass_criteria` semantics (B3).
- No automatic staffing/routing changes on a `fit` verdict (B4/D-039 — operator flips trust).
- No duplication of MODEL-BENCHMARK-SPEC's measurement classes (§5.6).
- No second model-registry file; `agent-pool.yaml` + `pricing.yaml` + `MODEL_IDS` remain the three
  existing touchpoints, now documented as one checklist (§3).

## 12. ASSUMED (unanswered — stated, not silent)

- **A1:** `claude-fable-5` is still served by the operator's Claude Code credential (the live
  `routing_event` evidence of explicit fable-5 picks, and CLAUDE.md §2.5 routing policy, both imply
  yes; the retirement in `load.ts` is treated as the stale side, per §0.1). If wrong, Phase 2's
  planner tier pins whatever planning model the operator names instead — the design is unchanged.
- **A2:** The live-DB observation in the briefing (`method:'explicit'` → `chosen.tier = null`,
  n=4 fable / n=7 opus) was NOT re-queried against the live DB; the *mechanism* was verified at
  `resolve.ts:262` instead, which is sufficient for the design and safer than poking the running
  datastore.
- **A3:** The `plan` classifier regex family in §4.1 is a starting shape; exact patterns are a
  Phase 2 build/test concern (order-in-`classifyIntent` is the load-bearing constraint, not the
  precise wording).

## 13. Operator resolutions (2026-07-26 — the draft's three questions, answered and folded in)

1. **Planner fallback: CONFIRMED.** `planner.escalates_to: opus` tier indirection is the intent —
   whatever the `opus` tier pins today (`claude-opus-4-8`), automatically `claude-opus-5` once it
   is added via the §3 checklist. No model literal in routing code. Folded into §4.2.
2. **fable-5 pricing: ship honest-NULL + loud unpriced warning, PLUS raise actionable work.**
   Operator's words: "ship honest-NULL + unpriced warning. but also allow research to cover the
   gaps with a research this model task or call to action." Designed as §3c (proposeTask-backed
   research proposal + always-on CTA), invariant ML-12, verified in Phase 1. Generalized to ANY
   unpriced/unknown model id.
3. **Gate strictness: CONFIRMED — no per-call operator bypass.** Even an explicit operator pick of
   fable on a build task is re-routed; the escape hatch is editing `duties` in config. The F-005
   tension is stated explicitly, with this decision and date recorded, in §4.4 — together with the
   honesty requirement that a re-routed operator pick is always visible (`method:'policy'` +
   structured `alternatives` + reason), never silently swallowed.
