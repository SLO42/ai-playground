# PLAN-REFINE — refined prompts + operator question loop in front of planning

**Status:** SPEC'd 2026-07-23 (fable-5, operator-approved design). Queued as BUILD-QUEUE `plan-refine`, gate:operator (new feature; launches only after the operator lifts the 2026-07-11 pause and releases it).
**Session-side twin:** `.claude/skills/plan-refine/SKILL.md` — same loop for Claude Code sessions, shipped 2026-07-23.

## 1. Purpose

Today an operator prompt reaches planning raw: the PM acts on the message as-is, and D-039's validation panel checks *tasks after creation*, not *prompts before planning*. Ambiguity is discovered mid-build, the expensive way. Plan-refine inserts a bounded loop in front of every planning-shaped operator prompt:

```
operator prompt
  → REFINE: restructure + extend (goal/context/constraints/grounding/success/assumptions)
  → QUESTIONS round 1: ≤4 load-bearing questions surfaced to the operator
  → PLAN: planner turn on the configured planning model (default claude-fable-5)
  → QUESTIONS round 2 (optional, exactly once): planner asks ≤3, operator answers
  → FINALIZE: plan/spec, unanswered items as explicit "ASSUMED (unanswered)" — never silent guesses
```

Operator decisions locked (2026-07-23): **auto-trigger** on planning-shaped prompts; **both seams** (PM-chat pre-step AND a dedicated `planning` session kind) so no planning path escapes refinement; **2 bounded rounds** max; skill ships now, platform build waits for release.

## 2. Grounding (verified against v2 worktree 2026-07-23)

- Planning-shaped detection seam: `src/lib/server/routing/resolve.ts:114` `classifyIntent(task)` + `ROUTING_METHODS` (`resolve.ts:35`) — the existing intent classifier is the pattern (and partial reuse) for detecting a planning-shaped prompt.
- LLM-turn seam: `src/lib/server/providers/index.ts:60` `Provider` interface (`ChatMessage` at `:24`, `OllamaProvider` at `:123`); the concierge Stage-2 turn (`src/lib/server/projects/pm-concierge.ts` + its wire) is the prior art for a provider-backed, metered LLM turn — the planner turn follows the same shape **including its cost-governance metering** (do not repeat the CG2-1 un-metered-turn defect).
- PM chat substrate: `src/lib/server/projects/pm-session.ts` (durable per-project PM peer-identity session), `pm-propose.ts` / `pm-review.ts` (where refined prompts land afterwards).
- Session kinds are free-form string literals (`'task'`, `'role'`, `'briefing'`, … — grep across `sessions/` + `orchestrator/`); adding `'planning'` is additive, no enum migration.
- Operator answer authority: D-035a — only `origin=operator` messages steer; origin stamped server-side. Answers to refine questions ARE steering, so they ride the existing operator-message path, no new authority surface.

## 3. Design

### 3.1 Shared module — `src/lib/server/planning/refine.ts`

Both seams call the same two functions; neither seam re-implements the loop.

- `refinePrompt(db, { projectId, source, rawPrompt })` → runs one provider turn that returns `{ refined: {goal, context, constraints, grounding, success, assumptions}, questions: [{id, text, options?}] }` (≤4 questions, schema-validated). Persists a `plan_refinement` row.
- `runPlanner(db, refinementId, { answers })` → provider turn on the configured planner model with ONLY the refined block + answers; returns either `{ plan }` or, at most once per refinement (server-enforced), `{ questions }` for round 2. Second call with round-2 answers always finalizes; unanswered questions become `assumed[]` on the row.
- Round bound + finalize-on-timeout enforced server-side: a refinement that waits on answers past its deadline finalizes with assumptions — the pipeline never hangs a project (async-everywhere rule).

### 3.2 Data — migration `m0081_plan_refinement`

`plan_refinement`: `project`, `source: 'pm-chat' | 'planning-session'`, `raw_prompt`, `refined` (object), `questions`, `answers`, `assumed`, `round: 0|1|2`, `status: 'refining'|'awaiting-operator'|'planning'|'final'|'timeout-final'`, `planner_model`, `session` (FK when source is a planning session), datetimes. Idempotent DEFINEs, ISO-coerced in a `normPlanRefinement`, real-surreal test — full §5 data-layer DoD applies (F-013/F-015/F-020).

### 3.3 Seam 1 — PM-chat pre-step

In the PM chat turn handler: operator message → planning-shaped check (reuse/extend `classifyIntent`; conservative — plan/spec/design/feature/build verbs; anything not planning-shaped passes through byte-identical, opt-in branch per D-024/F-053). Planning-shaped → `refinePrompt` runs, questions surface **in the chat thread** as an operator question card; operator's reply messages (already `origin=operator`) are parsed as answers → `runPlanner` → the final plan lands in the thread and feeds the normal PM proposal path (D-039 panel untouched downstream).

### 3.4 Seam 2 — `planning` session kind

A dedicated session whose whole lifecycle is the loop: created from the command center ("Plan with refinement"), `kind: 'planning'`, states mirror `plan_refinement.status`, pending-questions rendered honestly (loading/awaiting/final — F-008), answers submitted through the existing operator message path. Command center card shows: round, questions outstanding, model used.

### 3.5 Model config

`planner_model` per project, default `claude-fable-5` (model-roles policy 2026-07-07), resolved through the existing provider/routing ladder — no new provider plumbing. Local-provider selection allowed (it's how the benchmark seam gets planning samples) but default stays cloud planning tier.

### 3.6 Analytics + security

- Every transition logged with why: prompt classified planning-shaped (score/verbs), questions generated, answered vs assumed, rounds used, planner model + metered cost.
- Refined prompt is built from operator text = instruction-grade; any retrieved/repo context injected into the planner turn is fenced as DATA (D-026). Questions never echo secrets; screening applies before persist.
- No new gates crossed: refinement never spawns work sessions, never spends beyond its two metered turns; D-021 caps and budget gate apply to those turns like any other.

## 4. Wave shape (author at release via v2-wave)

- **PR-1** `planning/refine.ts` + `m0081` + norm + real-surreal tests (data-layer DoD).
- **PR-2** PM-chat pre-step: classifier branch + question card + answer parse (opt-in branch byte-identical when not planning-shaped; red-team flag — it touches the operator steering path).
- **PR-3** `planning` session kind + command center surface (F-008 honest states, design-system).
- **PR-4** metering + analytics + timeout-finalize sweep (ties into cost-governance; verify against CG2-1 class).

Tier: PR-2 red-team mandatory (steering-path adjacency). Models per §2.5: build on opus, wave authored by planning tier.

## 5. Out of scope

- Auto-executing the finalized plan (operator/PM decides; D-039 unchanged).
- Refining agent-to-agent messages (operator prompts only — the wall of D-041/D-026 stands).
- More than 2 question rounds (a prompt needing 3+ rounds needs a conversation, not a pipeline).
