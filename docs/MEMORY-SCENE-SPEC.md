# MEMORY-SCENE-SPEC — the living brain (animated graph of memory + workforce + jobs)

> Drafted 2026-06-17 (operator vision). An Obsidian-style force graph that visualizes the
> RUNNING system — active memory nodes, hires/PMs/ateliers, their connections, new-node
> spawns, and firing jobs — animated in real time. The platform's "brain," made visible.

## 1. What it is
A live, animated, force-directed (Obsidian-bubble-style) graph on a dedicated surface. Nodes
are the system's living entities; edges are their connections; the scene animates as the system
works — nodes spawn, jobs pulse, connections draw in, retired nodes fade. Real-time off the
existing SSE stream.

## 2. Nodes — DERIVED from live tables (F-008, never a denormalized copy)
The node/edge TRUTH is a live projection over existing tables — the scene does NOT keep its own
mutable copy of node state (that would re-create the stale-shown-as-live trap). Node classes:
- **memory** — `entity` (the knowledge-graph nodes; `/memory` already renders this) + `memory` rows.
- **skills** — `skill` (graduated/learned skills).
- **hires** — `role` + `role_version` (certified roles, lifecycle-colored) ; **PMs** — `pm`.
- **ateliers** — `project` (each managed project a node).
- **usage / jobs** — `session` (active/recent), `work_item` (queue depth / firing jobs),
  driven by `agent_event` activity.

## 3. Edges — DERIVED
- `references` (the memory-graph RELATION edges; already on `/memory`).
- `project_staff` → role↔project (a hire staffed on an atelier).
- pm↔project (a PM hired to a project).
- session↔{project, role, task} (who's working on what, now).
- memory↔entity / entity↔entity (knowledge links).
- job(work_item/session)↔target (what a firing job is acting on).

## 4. Animation — motion.dev IMPERATIVE API in Svelte 5 (NOT React `<motion.div>`)
Per `docs/skills/motion-framer/SKILL.md`: the React JSX components are React-only; Svelte uses
motion.dev's framework-agnostic core (`animate(el, keyframes, opts)`, `spring`, `stagger`,
`inView`). The skill's PRINCIPLES apply directly:
- **Node spawn** (the operator's "spawn of new nodes"): on a new row landing (via the live SSE
  `onDbChange`), the node enters with a spring scale+opacity (skill §7 spring presets — "wobbly"
  `stiffness:200,damping:10` for a lively pop), optional stagger when several land together
  (skill variants/stagger §5).
- **Job firing**: when a `session`/`work_item` activates (an `agent_event` lands), the node
  pulses/glows (transform+opacity keyframes; skill perf §1 — transform-only for 60fps).
- **Connection formed**: a new edge draws in (stroke-dashoffset/opacity spring).
- **Node exit/retire**: a retired role / ended session / archived memory fades+shrinks
  (AnimatePresence-equivalent: animate-out before DOM removal).
- **Layout**: a force simulation (d3-force, or a Svelte force-graph lib) for the bubble physics;
  motion.dev springs drive the per-node micro-animations layered on the force positions.
- **A11y**: respect `prefers-reduced-motion` (skill perf §3 — drop to instant/opacity-only);
  the scene is decorative-augmenting, never the only way to read state (honest text views stay).

## 5. The new table — `scene_event` (a DERIVED append-only viz feed, NOT a node-state copy)
The operator asked for "a new table in memory for visualization that reflects the jobs firing."
The honest shape: an **append-only `scene_event` projection** — `{id, kind, ref, project?, at,
meta}` where `kind ∈ {node_spawned, job_fired, job_done, connection_formed, node_retired,
memory_added, hire_staffed, …}`. A small writer appends a `scene_event` when a relevant row
changes (same trigger surface as the SSE), so the scene has ONE queryable, replayable activity
stream to drive the animation timeline (and a "what's happening now" feed / recent-activity
replay). It is DERIVED from real events (like `agent_event`), never authored/fabricated — so it
doesn't drift (append-only; the node/edge truth still derives live from §2/§3). New migration,
additive + idempotent (F-015). Added to `WATCHED_TABLES` (it's SSE-fed).
(Optional, LOW: a `scene_layout` position cache for perf — deferred unless the force sim is slow.)

## 6. Surface
A dedicated route — extend `/memory` with a "Scene" lens, or a new `/memory/scene` (decide at
build). Reuses the existing `/memory` graph (entity/references) as the base layer; adds the
hire/PM/atelier/job layers + the animation. SSE-driven (the dashboard's existing live stream).
Svelte 5 runes, Tailwind v4 tokens, design-system colors per node class (lifecycle-colored
roles, etc.).

## 7. Build shape (own waves, after HR + the file/memory data is solid)
1. `scene_event` table + the projection writer (append on relevant row changes) + WATCHED_TABLES.
2. The data-projection layer (live nodes/edges from §2/§3 — read-only aggregator, honest empties).
3. The animated graph component (force layout + motion.dev imperative springs + SSE spawn/fire).
4. The route/lens + the node-class styling + the activity feed.
Each: BUILD → D-038 review. Add `motion` (motion.dev) as a dep; force lib TBD at build.

## 8. ⚑ FORKS (operator)
1. **Surface**: a new `/memory/scene` route vs a "Scene" lens on `/memory`. (Recommend: a lens on
   `/memory` — it's the same graph, richer.)
2. **Scope of nodes v1**: memory+hires+PMs+ateliers+jobs all at once, or start with memory+jobs
   and layer hires/ateliers next. (Recommend: ship memory + usage/jobs first, layer the rest —
   it's the most dynamic + proves the animation; hires/ateliers are lower-churn.)
3. **`scene_event` retention**: keep-all (full replayable history) vs a rolling window. (Recommend:
   rolling window — it's a live scene feed, not an audit log; `agent_event` already audits.)

## 9. Non-goals (v1)
- Not the source of truth (derives live; `scene_event` is a derived feed, not node state).
- Not a replacement for the honest text views (decorative-augmenting; reduced-motion safe).
- Not React (motion.dev imperative API in Svelte; no `<motion.div>`).
