# PM Lifecycle — one-click "start the project's life" (operator 2026-06-20)

Operator ask: *"I want the PM to be able to start tasks as needed — under a project's
Overview, a way to have the PM automate the lifecycle of the project. A one-click
solution for the operator to start a project's life essentially."*

## What exists today (verified at file:line, v2 worktree `F:\code\ai-playground-v2`)

- **PM identity/management** — `src/lib/server/projects/pm-repo.ts`: `getPm`(449),
  `createPm`(476), `bootstrapPm`(618, idempotent scan-seed), `updatePmAuthority`(538),
  `addPmMemory`(245), `listPmMemory`(282), `addPmReview`(353).
- **PM hire** — `pm-hire.ts`: `hirePm`(177), `hireInterviewFor`(119).
- **PM review** — `pm-review.ts`: `runPmReview(db, runtime, projectId, opts)` (manual button +
  periodic). **PM proposal validation** — `pm-panel.ts`: `runValidationPanel`;
  `pm-proposals.ts`: `revisePmProposal`/`withdrawPmProposal`.
- **Tasks** — `tasks/repo.ts`: `createTask`(216, supports `origin='pm'` + proposal fields
  objective/purpose/acceptance_criteria/provenance), `setStatus`, `canTransition`(77).
  State machine: `proposed → [ready, withdrawn]`, `ready → in_progress …`.
- **Orchestrator** — `orchestrator/orchestrator.ts`: moving a task to **`ready`** fires
  `#onTrigger`(257) → `enqueueTask`(296) → `drain()` → `launchSession` → agent develops it.
  Spawn-ready statuses default `['ready']`(104). **Auto-develop of `ready` already works.**
- **Agent-backed generation seam precedent** — `create/agent.ts` injects a `ProposalGenerator`
  (real `launchSession` in prod, stub in tests → no spend). `create/execute.ts:393`
  `screenWriterText()` = the D-026 writer boundary for every DB-bound freetext field.
- **Live "watch the agent think"** — `SessionTranscript.svelte` + `transcript-core.ts` +
  `message` `onDbChange` SSE (the create-live-thinking / live-session-transcript infra).
- **PM authority** — `pm.authority ∈ {observe, propose, act}`. `act` = promotes on panel
  approval (existing, by design); `propose` = needs operator approval to promote; `observe`
  = never promotes.

## The verified GAP

The PM **validates** proposals but does **not GENERATE** them, and there is **no single
entry** that runs the loop. The operator wants one click that makes the PM review the
project, propose the next work, and start the approved work.

## Design — three pieces (build wave `pm-lifecycle`)

### PM-LC-1 — PM proposal generator (the missing GENERATE step)
`src/lib/server/projects/pm-propose.ts` → `generatePmProposals(db, runtime, projectId, opts)`.
- Reads plan (purpose/vision/role/dod), open tasks, `pm_memory` (risks/patterns/learnings),
  capability needs/gaps (`capability-match.ts recommendStaffing`).
- Runs a PM agent session through an **injected `PmProposalGenerator` seam** (prod =
  `launchSession`; tests = stub, **no spend**), mirroring `create/agent.ts`.
- Each proposal → `createTask(origin='pm', status='proposed', {objective, purpose,
  acceptance_criteria, provenance:{trigger:'pm_lifecycle', evidence}})`.
- **D-026**: screen every freetext field at the writer boundary (reuse `screenWriterText`).
- **F-008**: honest empties — generator returns nothing → zero tasks, honest "no gaps"
  summary, never fabricate. Bounded by a max-proposals cap. Grounded, no-guessing.

### PM-LC-2 — `startProjectLifecycle` + form action (the one-click tick)
`src/lib/server/projects/pm-lifecycle.ts` → `startProjectLifecycle(db, runtime, projectId, opts)`:
1. `getPm` → none ⇒ `{needsHire:true}` (NEVER auto-hire — hiring is its own gated flow).
2. `bootstrapPm` if unbootstrapped (idempotent).
3. `generatePmProposals` (PM-LC-1).
4. `runValidationPanel` on the new proposals.
5. **Promote per authority**: `act` → approved proposals `proposed→ready` (`setStatus`,
   which triggers orchestrator auto-develop); `propose` → leave `proposed` for operator
   approval; `observe` → promote nothing.
6. Return `{generated, validated, promoted, leftForOperator, sessionId, summary}`.
- Form action `startLifecycle` on `routes/projects/[id]/+page.server.ts`.

### PM-LC-3 — Overview UI (one-click + live + honest)
- No PM hired ⇒ a "Hire a PM first" CTA to the existing hire flow (no auto-hire).
- PM hired ⇒ a "Start the project's life" button → **confirm + real-spend cost label**
  ("spawns the PM agent to review, propose work, and start approved tasks — real model
  spend") → POST `startLifecycle`.
- **Live**: render the lifecycle session's transcript (reuse `SessionTranscript` + SSE) so
  the operator watches the PM think; then the tick result (generated / promoted /
  leftForOperator). On `authority='propose'`, surface "N proposals awaiting approval"
  linking the existing proposals panel. Honest states (F-008). a11y/tokens/watched-tables.

## Integrity boundaries (LOCKED — verify in committed code, red-team PM-LC-1/2)

- **No gate bypass.** The tick uses ONLY the existing PM `act` authority to promote on panel
  approval. `observe`/`propose` do not auto-promote. It does NOT auto-hire, does NOT
  auto-approve a hire-request (that stays HR/B4), does NOT touch D-039 operator gates.
- **Spend = the operator's click.** The action runs only on an explicit click behind a
  cost-labelled confirm. (One *tick*, not a daemon.)
- **D-026 / F-008 / F-014** hold throughout. No new fable-5 literals (opus-everywhere).

## Deferred (needs the operator's spend/safety call — NOT in this wave)
**Continuous autonomous mode (reading B):** arm `pm.cadence` so the PM re-runs the tick on a
schedule until the DoD, developing unsupervised. Requires a real `dailySpawnCap` (D-021 is
currently uncapped, BL-9-H1) and the operator's go. The one-click tick is the substrate;
this is the additive layer.
