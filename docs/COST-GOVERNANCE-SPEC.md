# COST-GOVERNANCE-SPEC — measure, cap, and consent every real-money token

**Status:** DRAFT (2026-07-08) · implements D-020/D-021 + the CLAUDE.md §6 consent rule · carries F-005/F-008 · queued `cost-governance-1` (gate:operator)
**One-liner:** spend flows through exactly two chokepoints — `resolveRoute` decides the model, `launchSession` spawns it, `events.ts` records it — and the routing ladder + intent budgets already keep cheap things cheap. But governance has holes: **no dollar is ever measured** (`cost_usd` is never populated by any live backend), **the 200/day cap meters only the background drain** (interactive, ceremony, concierge, benchmark spend is uncounted), and **consent is action-shaped, never cost-labeled**. This spec states the model and scopes the fix: measure first, then meter everything at the chokepoint, then label consent.

Grounding: opus scout pass 2026-07-08 (file:line verified). Code on branch `v2`.

## 0. The spend topology (what exists)

### 0.1 Creation — one primitive, one decision
- **Every real-money session is born in `launchSession`** (sessions/launch.ts:67) — it takes `model`/`budgets`, it does NOT decide them.
- **The decision is `resolveRoute`** (routing/resolve.ts:251). Precedence: explicit operator override (:255) → staffing short-circuit (role-bound (version×model_id), :~291) → intent classify + `scoreComplexity` (:142) → cheapest-capable tier on the ladder local→haiku→sonnet→opus → D-020 `adaptiveConfigFor` → provider-health fallback walk (F-005, :~365–410). `defaultProvider auto|local|cloud` forces the fleet (boot.ts:274).
- Sub-sources (all reaching launchSession or the gauntlet runner): background drain (the main one) · PM autonomous re-ticks · ceremony/interview gauntlet runs (workforce/ceremony.ts:592 wraps runGauntlet) · concierge Stage-2 single bounded LLM turn (concierge.ts:596; Stage-1 is $0 deterministic) · benchmark runs · the launch.ts:229 cheap-tier skill-generator session.

### 0.2 Caps (what binds today)
| cap | value/unit | scope | at-cap behavior |
|---|---|---|---|
| `concurrency.dailySpawnCap` (D-021) | 200 claims/rolling-24h; 0=uncapped (normalizeCap boot.ts:105) | **background work_item drain ONLY** (gate orchestrator.ts:581–583; counter `spawnsSince` on `claimed_at`, workqueue.ts:478) | drain breaks, work PARKED |
| `concurrency.maxAgents` / `perProject` | 8 / 3 | interactive concurrency | queued |
| PM re-tick cap | 24 / rolling window (loops/read.ts:184) | pm-autonomous loop | blocked state |
| `SpawnBudgets` (D-020 bundles) | thinking/toolCalls/retrieval per intent | per session | bounds tools/context, NOT tokens/$ |
| recall/pull budgets | token-bounded context injection | memory | not a spend cap |

### 0.3 Consent (what's recorded today)
Action-shaped only: create ceremony confirm-token (sha256 of proposal, create/plan.ts:7, stale ⇒ StaleProposalError) · `setPmAutoPublishPreauthorized` (execute.ts:690) read by the release gate · adapter confirm tokens (driver.ts:37). **No cost-labeled consent exists** (grep-negative for costLabel/estimatedCost across create/release/workforce). `launchSession` itself has no consent check — D-025/D-035a govern STEERING, not spending; the spend-consent rule lives at the operator-gate layer (CLAUDE.md §6).

### 0.4 Measurement (what's honest today)
- `analytics/events.ts:155–157` writes tokens_in/tokens_out/cost_usd on completion; **cost_usd only when a price is known — never fabricated (F-008)** (:17–18).
- Backends emit TOKENS only (cli-backend.ts:308–309; ollama-backend.ts:101); the CLI's `total_cost_usd` is console-logged, never persisted (:646). **⇒ cost_usd is NULL in practice; measurement is token-denominated.**
- Aggregators: `buildProviderUsage` (provider-usage.ts:75 — per-provider, priced-rows-only Σcost, 'unknown' bucket honest), `buildTierUsage` (rollup.ts — per-day), trace.ts per-session. **Per-PROJECT attribution NOT built** (provider-usage.ts:13–14, honestly surfaced); no /usage or /cost route exists.

## 1. Normative invariants

1. **Meter at the chokepoints, never the call sites**: measurement hooks `events.ts` (the one completion write); decisions hook `resolveRoute`. New spend sources inherit governance by construction.
2. **F-008 pricing honesty**: unpriced model ⇒ NULL cost, never a fabricated $0 — EXCEPT local/ollama, which is genuinely $0 and must be recorded as 0 (not NULL) once pricing lands.
3. **Cap semantics are uniform** (the dailySpawnCap pattern): 0/absent = uncapped sentinel; positive = enforced; anchored on a DURABLE timestamp (survives restarts); at-cap PARKS work, never drops it; the gate check is cheap and precedes the spend.
4. **Consent and cap are separate and BOTH required for autonomous spend** (CLAUDE.md §6): a cap never substitutes for recorded operator consent; consent never removes the cap.
5. **The routing ladder is the first cost control**: cheapest-capable tier + $0 local floor + D-020 budgets; any governance layer sits ON TOP of, never instead of, the ladder.
6. **Every cap/budget breach is observable**: a parked/blocked/at-cap state emits an analytics event with the how/why — never a silent stall.

## 2. Gaps → the wave (`cost-governance-1`, gate:operator) — ordered: measure → meter → label

| id | gap (verified) | required behavior | shape |
|---|---|---|---|
| **CG-1 measure** | cost_usd never populated — all $ views null. | A pricing map (config: model_id → $/Mtok in/out; local ⇒ 0) consumed at the events.ts write chokepoint. Unlisted model ⇒ NULL + a once-per-model warning event. Backfill NOT attempted (historical rows stay honest-null). provider-usage/rollup need no change (already priced-rows-only). | build (small; config + one write-site) |
| **CG-2 meter-everything** | dailySpawnCap sees only the drain; ceremony/interactive/concierge/benchmark spend uncounted; the unit is a claim-count (200 trivial local = 200 deep opus). | A GLOBAL rolling-window TOKEN budget checked at the launchSession ingress (and the gauntlet runner): sum tokens over agent_event in the window vs `spend.dailyTokenBudget` (0=uncapped). At-cap: background sources park (drain gate already breaks); operator-explicit launches WARN + require an explicit override flag rather than hard-refuse (operator authority). Both the existing claim-cap and the new token-budget stay — count-cap bounds runaway spawning, token-budget bounds runaway spend. | build (red-team; the cap must be un-bypassable by new call sites — F-055 lesson: enforce INSIDE launchSession, not at callers) |
| **CG-3 per-project budget** | perProject bounds concurrency only; one project can eat the whole daily budget. | Optional `spend.perProjectTokenBudget` (0=uncapped default), same semantics, same chokepoint, keyed by the session's project. | build (rides CG-2's counter) |
| **CG-4 cost-labeled consent** | Operator confirms actions blind — no estimated-spend label on any gated confirm. | Gated confirms that trigger real spend (ceremony runs, autonomous arm, release publish) render an estimate line: recent-window per-source token average × CG-1 pricing → "~N tokens (~$X) expected". Estimate honesty: computed from measured history, labeled as estimate, absent (—) when no history — never invented (F-008). | build (UI + one estimator; after CG-1/2) |
| **CG-5 aggregate ceilings for side-loops** | Concierge Stage-2 + benchmark turns are per-turn bounded but have no aggregate ceiling. | They spend under the CG-2 global budget automatically (chokepoint placement). No separate cap unless data shows need. | resolved-by-CG-2 (verify with a test) |
| **CG-6 per-project attribution** | provider-usage can't attribute cost per project (session→provider join not built). | Extend the aggregator with the session→project join (real-surreal test; F-020 projection discipline); feeds CG-3 + a /usage surface later. | build (small) |

## 3. DoD (D-038)

- [ ] CG-1: pricing config validated at load (ConfigError on malformed); events write covered by a real-surreal test (priced/unpriced/local-zero).
- [ ] CG-2/3: budget gate INSIDE launchSession + gauntlet runner; red-team probes a new caller bypass + the 0-sentinel + window-boundary; parked states emit events; restart-survival test (durable anchor).
- [ ] CG-4: estimates render honest '—' with no history; no fabricated numbers (F-008).
- [ ] No regression to the routing ladder or D-020 budgets; `db:up` clean if any migration; gates green token-unset; devlog row.
