# LIFECYCLE-GRAPH-SPEC — live causal node-graph of a task/project lifecycle

**Status**: queued (2026-06-25). Operator: a node-graph animation — Continue → the agent
nodes it spawns (task name, role/title, hire, tool-call count, active skills) → on finish
they message the PM → a PM node (agent inputs, PM thinkings, decisions out) → new tasks/agents
extend the chain. Live + animated. Pairs with `command-center-ux`.

## Grounded substrate (verified — F:\code\ai-playground-v2, branch v2)

The events to build nodes already exist; this is mostly a VISUALIZATION layer + a few small
provenance additions to make the causal edges declarative.

- **`scene_event` projector** (`scene/projector.ts`, MEMORY-SCENE-SPEC §5/§7.1) — THE live
  substrate. Append-only, derived from real row-changes via the EventBus `db_change` stream
  (db-source.ts), capped (SCENE_EVENT_CAP=500). Kinds: `job_fired` (session/work_item CREATE),
  `job_done` (→terminal), `node_spawned`, `connection_formed`, `memory_added`; meta = screened
  bounded labels {status,kind,…}. Truth stays in source tables; scene_event is the animation feed.
- **Live mechanism**: `events/db-source.ts` opens one SurrealDB live query per watched table →
  republishes `{type:'db_change', topic, key, data}` on the EventBus; subscribers tap it
  (orchestrator/projector/PM-loop pattern). Self-healing on token loss (F-042). (SSE to the
  browser is the existing onDbChange surface the timeline/command-center already use.)
- **Node attributes — available:** session row carries `task` (→ task.title = task name),
  `role`/`role_version` (schema.ts:1216-1217 — the title/"hire"), `model`, `status`,
  `started_at`/`ended_at` (→ elapsed), `tool_iter_count` (tool-call count); UO-1 m0065 granted
  caps (`granted_skills/agents/mcp/reserved`, `tool_allow`) = the **active skills**; UO-2
  `observability/usage.ts` = per-tool breakdown. PM thinkings = `message` rows (thinking/text).
- **Edges — EXPLICIT (real links):** PM→new-task (`task.proposed_by` = PM session id +
  `task.provenance.kind='pm_proposal'`), task→follow-up/revision (`revision_of`/parent),
  session→task-outcome (`agent_event` type='completion', detail{ok,summary} links session+task).
- **Edges — INFERRED today (no marker):** Continue→sessions (continueReadyTasks enqueues
  task_run → orchestrator.drain → spawn agent_events; no Continue marker), session→PM (the
  pm-autonomous re-tick fires on a task-terminal db_change; the tick is NOT a persisted row —
  in-memory `lastOutcome` only).
- **MISSING provenance** (small additions make the chain fully declarative): a Continue marker,
  a PM-tick record, an agent_event parent link, and (for granular timeline) task-status-transition stamps.

## Design — scene_event-driven graph + the smallest provenance additions

- **LG-1 — provenance additions (backend, additive/F-015):**
  - emit a **Continue marker** scene_event (`kind:'continue'`/`batch_drained`, ref the project,
    meta{readyCount,spawned}) from `continueReadyTasks` → roots the "Continue" node.
  - emit a **PM-tick** scene_event from the AutonomousPmLoop re-tick (`kind:'pm_tick'`, meta{state,
    reason, ticksUsed, triggeredByTaskIds, proposedTaskIds}) → roots the PM node + its in/out edges.
  - add `agent_event.parent_event_id` (option) — link a spawn to the completion/tick that caused it
    (makes session→PM→new-session explicit instead of timestamp-inferred).
  - (optional, for granular timeline) a `task_event`/status-transition stamp so a node shows
    ready→in_progress→done with wall-clock times (today only created_at/updated_at).
  All emissions screened (D-026), bounded, best-effort (D-019 — never block the drain/PM).
- **LG-2 — lifecycle read model** (`observability/lifecycle.ts` NEW): assemble nodes+edges for a
  project (or a Continue-root) from scene_event + the explicit provenance links + session/task/UO
  rows. Node = {id, kind(continue|session|pm|task), label, role/title, hire, toolCount, skills[],
  status, started/elapsed}. Edge = {from, to, kind}. Bounded/paginated (F-014). Honest empties.
- **LG-3 — the animated node-graph UI** (a route or command-center panel): render the DAG growing
  left-to-right/top-down; nodes animate in as scene_events arrive (live via the existing onDbChange
  SSE the timeline uses); a session node shows task name + role/title + hire + live tool-count +
  active skills; finishing nodes draw an edge into the PM node; the PM node shows agent inputs +
  thinkings + the new task/agent nodes it extends. Design-system tokens, a11y, honest states
  (loading/empty/disconnected). Reuse a graph lib OR hand-rolled SVG/canvas (decide in the wave).

## Integrity invariants
- **Honest/live (F-008)**: nodes/edges derive from REAL rows + scene_events; never fabricated; a
  missing causal link renders as honest-unknown, not an invented edge.
- **D-026**: scene_event meta + node labels screened (bounded labels only — no raw transcript/secret).
- **Additive (F-015)**: the new field(s)/event-kinds apply idempotently; legacy rows render honestly.
- **Best-effort (D-019/F-014)**: a scene_event emission or graph read NEVER blocks the
  orchestrator/PM/drain or crashes the server (cf. F-048 — drain faults must be contained).
- **Reuse, don't rebuild**: the live stream (db-source/EventBus/onDbChange SSE) + the scene_event
  projector + the /atelier timeline merge logic are the substrate — extend, don't duplicate.

## Verification (DoD — D-038)
- Unit: the Continue + PM-tick scene_events emit with correct meta; the read model assembles the
  expected nodes+edges from seeded scene_event/agent_event/task rows; explicit edges (PM→task,
  session→outcome) resolve from real links; honest-empty for no data.
- Integration (live): drive one Continue → assert the graph shows Continue→N sessions→(on done)→PM
  →new tasks, live, with node attributes (task name/role/tool-count/skills) populated from real rows.
- Build + test + lint(0) + svelte-check(0). Live-verify the animation on a real ROUNDS drive.

## Scope notes
- Build as a frontend+backend wave (LG-1 provenance → LG-2 read model → LG-3 UI). It would
  HMR-thrash a live ROUNDS run, so build it while the live loop is PAUSED.
- Pairs with `command-center-ux` (timestamps/elapsed + declutter + surface PM/HR activity) — the
  graph is the "alive" visualization; the command-center is the at-a-glance status. Could share the
  read model (UO-2 + this lifecycle read model).
