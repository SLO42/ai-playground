# LIFECYCLE-GRAPH-UX-SPEC — v2 polish: n8n-style alive lifecycle graph

**Status**: queued (2026-06-25). Operator feedback after viewing the LG-3 graph
(`/projects/[id]/graph`). Make it read at a glance + feel ALIVE like an n8n workflow.

## Grounded (verified — F:\code\ai-playground-v2, branch v2)
- Current render: `src/lib/components/graph/LifecycleGraph.svelte` (used by the graph route),
  positioned by **d3-force** (`d3-force` dep; `src/lib/client/scene/scene-graph.ts` toForceModel
  → {nodes,links}) — organic float, NOT columnar. **`motion`** (^11.18) is ALREADY a dep (use it).
- Data: LG-2 read model `observability/lifecycle.ts` (nodes {task name, role/title, hire, toolCount,
  skills, status, startedAt, elapsed} + edges explicit/inferred); per-node DETAIL available to thread
  in — token usage from `agent_event` (tokens_in/out, cost_usd, duration_ms), per-tool breakdown from
  UO-2 `observability/usage.ts`, granted skills from UO-1 (m0065). Live via the scene_event/SSE stream.

## Operator requirements → tasks

- **GUX-1 — layered left-to-right layout + node text-fit + connectors.** Replace the force float
  with a RANK-based layered DAG: each node gets a causal RANK (depth) — Continue=0 → its spawned
  sessions=1 → PM=2 → PM's new tasks=3 → their sessions=4 … ; **x = rank·columnWidth** (left→right),
  **parallel spawns share a rank → same column** (y distributed within the column). Keep d3-force but
  PIN x by rank (fx) and let y settle (or use a layered layout) — no node overlap. Node = a fixed-size
  **n8n-style card** that FITS its text (title truncates with ellipsis + full on hover/popover; role/
  status/counts in a tidy grid — no overflow). Edges are clear CONNECTORS (bezier/orthogonal, arrowed),
  solid=explicit / dashed=inferred, routed cleanly between columns.
- **GUX-2 — alive: active-node effect + nodes pop in.** A RUNNING node gets a cycling glow — a ring
  that animates around the node border (e.g. a rotating conic-gradient / pulsing halo), via `motion`
  or CSS keyframes. New nodes POP IN (scale/fade enter) as scene_events arrive; edges draw in. Respect
  `prefers-reduced-motion` (static state, no animation). Terminal nodes (done/failed) read distinctly
  (color family + a settled state). The whole thing should feel live, like an n8n run.
- **GUX-3 — clickable nodes → detail popover/modal.** Click a node → a popover/panel with the node's
  detail: **tools used** (UO-2 per-tool breakdown), **token usage** (agent_event tokens_in/out + cost +
  duration), **active/granted skills** (UO-1), task name/description, role/title/hire, status + start +
  elapsed, and the node's PATH (its parent → it → children). Thread the per-node detail into the LG-2
  read model (or a per-node detail endpoint). Keyboard-accessible (focus a node, open on Enter), honest
  empties (no tokens recorded → '—', F-008). D-026 — screened labels only, no raw secret.
- **GUX-4 — paths, data-flow, funnel, focus.** Surface: the lifecycle at a glance (column = phase);
  **data shared between nodes** = peer_message edges (a distinct edge style "messaged"); the **multi-node
  funnel into the PM** (several session→PM edges converging on the PM node, visually emphasized);
  **focus a session** — click/hover a node highlights its full causal PATH (ancestors+descendants) and
  dims the rest. The funnel + peer edges come from the existing substrate (peer_message, the LG-2 edges).

## Use the design skills
The build should invoke the available design skills for the visual/motion quality: **impeccable**
(UX/visual-hierarchy audit), **ui-ux-pro-max** (layout/color/interaction), **frontend-design**, and
**motion** (the animation lib). Apply them to the node-card design, the glow/pop motion, the popover,
and the at-a-glance information hierarchy.

## Integrity invariants
- **Honest/live (F-008)**: nodes/edges/detail from REAL rows (LG-2 + agent_event + UO); never a
  fabricated node/edge/metric; honest '—'/empty/disconnected; inferred edges stay visually marked.
- **D-026**: popover/labels screened; no raw transcript/secret.
- **Bounded (F-014)**: large graphs virtualize/cap (don't render thousands of nodes unbounded); the
  live SSE is the existing one — no parallel change detector.
- **a11y**: not mouse-only — nodes keyboard-reachable + labelled; popover focus-managed;
  reduced-motion honored; design-system tokens only.
- Reuse LG-1/LG-2 substrate; don't rebuild the read model or the live stream.

## Verification (DoD — D-038)
- Component: layered layout assigns correct ranks (Continue=0, parallel sessions same column, PM next);
  node card fits text (truncation + popover full); running node animates, reduced-motion static;
  click → popover shows tools/tokens/skills/path (honest '—' when absent); peer/funnel edges render.
- Integration: a seeded Continue→3-parallel-sessions→PM→2-tasks chain renders columned, the 3 sessions
  funnel into the PM node, a peer_message shows as a data-shared edge.
- Build + test + lint(0) + svelte-check(0). Live-verify on the real ROUNDS graph.

## Timing
Frontend wave — HMR-thrashes a live server. Build while the loop is PAUSED (or with the operator's
viewing session stopped). Pairs with the planned next-session work (BL-R1 + headroom → go-live).
