---
name: plan-refine
description: Use BEFORE planning whenever the operator asks for a plan, spec, design, workflow, new feature, or any non-trivial "build X" — the prompt gets refined, up to 4 load-bearing questions are lifted to the operator, then a fresh-context planner subagent on the configured planning model (default claude-fable-5) drafts the plan/spec with a bounded second question round. Skip for trivial asks, pure information questions, bugfixes with obvious scope, or when the operator says "quick" / "no refine".
---

# Plan-Refine — refined prompt → operator questions → fable-5 planner

Operator directive (2026-07-23): every planning-shaped prompt goes through this loop
instead of being planned inline from the raw message. Purpose: (1) ambiguity is
surfaced as explicit questions *before* tokens are spent planning; (2) the heavy
design thinking always lands on the planning-tier model (model-roles policy,
CLAUDE.md §2.5) even when the main session runs Opus or another model.

## When NOT to engage

- Trivial/mechanical asks, pure questions, status requests.
- Debugging (that's systematic-debugging / Iron Law territory, not planning).
- Operator says "quick", "no refine", or is obviously mid-flow iterating on an
  existing plan.
- A wave is being *resumed* (args already exist — don't re-plan).

## The loop (2 bounded question rounds, never more)

### 1. REFINE — inline, in the main conversation (any model)

Refinement stays inline because conversation context is the asset: the main agent
has seen what the operator has been doing and catches ambiguity a fresh agent can't.
Restructure the raw prompt into:

```
GOAL: one sentence — what changes and why.
CONTEXT: only the conversation/repo facts the planner needs (distilled, not a dump).
CONSTRAINTS: locked decisions (D-numbers), scope limits, cost/model rules that apply.
GROUNDING POINTERS: file:line / spec docs the planner must verify against (no-guessing rule).
SUCCESS CRITERIA: how we'll know the plan worked — down to the verification command.
ASSUMPTIONS: what you're assuming because the prompt didn't say.
```

Then generate **≤4 load-bearing questions only** — questions whose answer changes
the plan's shape. No nice-to-know questions. Lift them via AskUserQuestion
(recommended options first, with "(Recommended)").

### 2. PLAN — fresh-context subagent on the planning model

Spawn a planner subagent (Agent tool, `model` per config below) whose prompt is
ONLY: the refined block + the operator's answers + house rules pointer
("Follow CLAUDE.md §2: scope lock, reuse check, grounding to file:line — verify
pointers yourself with reads, never trust summaries"). Not the chat transcript.

Planner deliverable:
- A plan/spec per house convention — spec docs to `docs/<NAME>-SPEC.md` (v2-main),
  small plans returned as text.
- OPTIONALLY, exactly once, a block starting `QUESTIONS:` (≤3 items) if something
  load-bearing is still ambiguous → main agent lifts to the operator
  (round 2), sends answers back via SendMessage, planner finalizes.
- Anything still unanswered → finalize anyway with an explicit
  `ASSUMED (unanswered):` section — stated assumptions, never silent guesses.

### 3. DELIVER

Main agent relays the final plan/spec, flags the assumed items, and stops —
implementation is a separate approval (waves need operator release; the D-037 /
spend gates are untouched by this skill).

## Model config

- Planner default: `claude-fable-5` (planning tier — model-roles policy 2026-07-07).
- Override per invocation: operator writes `model=opus` / `model=<id>` in the
  prompt, or asks for it.
- Wave-authoring (v2-wave args/structure) counts as planning → same loop, planner
  on the planning tier.

## Failure modes

- Planner subagent dies → report honestly, offer re-spawn; never quietly plan
  inline as a fallback without saying so.
- Operator doesn't answer round-2 questions (moves on) → finalize with
  `ASSUMED (unanswered):` — do not block.
- More than 2 rounds wanted → STOP; that means the prompt needs a conversation,
  not a pipeline. Say so.

## Atelier twin

The platform-side implementation of this same loop is specced in
`docs/PLAN-REFINE-SPEC.md` (PM-chat pre-step + `planning` session kind) and
queued in `docs/BUILD-QUEUE.md` as `plan-refine`.
