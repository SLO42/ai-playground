# Dashboard Architecture

The dashboard is the user-facing application for ai-playground — a project lifecycle platform for creating, developing, maintaining, and releasing software projects. **Claw** is the automation engine that powers autonomous agent execution underneath.

Quick reference for navigating the codebase. Read specific files — don't explore directories.

## Route → File Map

| Route | Page | Server Data |
|-------|------|-------------|
| `/` | `routes/+page.svelte` | `routes/+page.server.ts` |
| `/chat` | `routes/chat/+page.svelte` | `routes/chat/+page.server.ts` |
| `/inbox` | `routes/inbox/+page.svelte` | `routes/inbox/+page.server.ts` |
| `/tasks` | `routes/tasks/+page.svelte` | (client-side fetch) |
| `/models` | `routes/models/+page.svelte` | `routes/models/+page.server.ts` |
| `/projects` | `routes/projects/+page.svelte` | `routes/projects/+page.server.ts` |
| `/projects/[id]` | `routes/projects/[id]/+layout.svelte` | `routes/projects/[id]/+layout.server.ts` |
| `/projects/[id]/releases` | `routes/projects/[id]/releases/+page.svelte` | `routes/projects/[id]/releases/+page.server.ts` |
| `/projects/[id]/reports` | (page.svelte — not yet created) | `routes/projects/[id]/reports/+page.server.ts` — task stats (total/completed/in-progress/pending), recent completions, tag distribution, priority breakdown for a single project |
| `/services` | `routes/services/+page.svelte` | `routes/services/+page.server.ts` |
| `/settings` | `routes/settings/+page.svelte` | `routes/settings/+page.server.ts` — heartbeat config load converts disk format (`phases` as object, from `shared.ts`) to UI format (`phases` as `HeartbeatPhase[]`); both formats accepted |
| `/reports` | `routes/reports/+page.svelte` | (uses `lib/server/reports.ts`) |
| `/sessions` | `routes/sessions/+page.svelte` | `routes/sessions/+page.server.ts` |
| `/agents` | `routes/agents/+page.svelte` | `routes/agents/+page.server.ts` — loads `agentProjectMap` (agent filename → project IDs) via `buildAgentProjectMap()` alongside pool stats and analytics |
| `/apps` | `routes/apps/+page.svelte` | `routes/apps/+page.server.ts` |
| `/memory` | `routes/memory/+page.svelte` | (client-side — see `docs/api-memory.md`, `docs/memory-graph-guide.md`) |
| `/security` | `routes/security/+page.svelte` | (client-side) |
| `/notifications` | `routes/notifications/+page.svelte` | `routes/notifications/+page.server.ts` |
| `/hooks` | `routes/hooks/+page.svelte` | `routes/hooks/+page.server.ts` |
| `/about` | `routes/about/+page.server.ts` | (server only) |
| `/demo` | `routes/demo/+page.svelte` | `routes/demo/+page.server.ts` — agent lifecycle visualizer; groups `AgentEvent`s by `taskId`, filters to lifecycle-relevant event types (classified → spawned → completed → committed → review → follow-up), and returns `LifecycleTask[]` sorted by most recent. Exports `LifecycleTask` interface. |

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chat` | POST | Multi-provider chat streaming (SSE) |
| `/api/chat/history` | GET/POST | Chat session CRUD |
| `/api/services` | GET | Service status polling |
| `/api/services/[id]` | POST | Start/stop/restart service |
| `/api/health` | GET | Detailed health check — per-service probes with latency, DB connectivity (`.swarm/memory.db`), daemon PID validation, system memory/CPU |
| `/api/projects` | GET/POST | Project CRUD |
| `/api/projects/[id]/tasks` | GET/POST | Task CRUD per project |
| `/api/projects/[id]/memory` | GET | Project memory snapshot (entries, context, graph). Optional `?range=1h\|24h\|7d` filters by `createdAt`; cached 30 s per (project, range). |
| `/api/projects/[id]/releases` | GET/POST | Release listing and creation per project |
| `/api/notifications` | GET | Notification polling |
| `/api/settings` | GET/POST | Settings read/write |
| `/api/sessions` | GET | Session listing |
| `/api/reports` | GET/POST | Report generation |
| `/api/routing` | GET | Routing telemetry |
| `/api/agents` | GET | Active agent listing |
| `/api/agents/pool` | GET/POST | Session pool stats and management. POST actions: `populate` (project-aware, iterates all projects via `populateFromProjects`), `populate-config` (config-only legacy populate), `reset`, `remove-slot` |
| `/api/github` | Various | GitHub sync operations |
| `/api/memory/graph` | GET/POST/PUT | Knowledge graph CRUD (nodes + edges) |
| `/api/memory/entries` | DELETE | Remove auto-memory entries by ID |
| `/api/memory/context` | GET | Ranked context + auto-memory entries |
| `/api/memory/sync` | POST | Trigger memory bridge sync |

## Server Modules (`src/lib/server/`)

| Module | Purpose |
|--------|---------|
| `heartbeat/` | Claw automation engine — handles the autonomous task execution loop (scan tasks across all projects → spawn agents → commit changes → follow-up). Split into shared, spawn, tracking, review, discussion, session-pool, pid-registry. Round-robin scheduling ensures fair agent allocation across projects. `pid-registry.ts` persists all child PIDs to `.playground/pid-registry.json` and reaps orphaned processes on startup. During task scanning, each task is annotated with `_sourceProjectId` and `_sourceProjectPath` (runtime-only, not persisted) so agent completion callbacks update the correct project's task file. `session-pool.ts` exports `suggestAgentPreset(maxAgents)` (returns agent type list) and `populateFromProjects(scanFn, loadMaxAgentsFn)` (project-aware pool seeding that reads/writes `.playground/agents.json` per project). `agent-analytics.ts` records `projectId` on every `AgentEvent` and exposes `AgentAnalytics.byProject` — a per-project breakdown of task counts, completion/failure counts, total cost, and total duration derived from completion events. |
| `constants.ts` | Paths, service definitions, polling intervals |
| `notifications.ts` | Push notifications (desktop + in-app) |
| `session-manager.ts` | Server-side SSE streaming engine |
| `task-store.ts` | Task CRUD (reads/writes `.playground/tasks/`) |
| `project-scanner.ts` | Project discovery and scanning |
| `reports.ts` | Analytics report generation |
| `chat-tools.ts` | LLM tool definitions (list_projects, create_task, etc.) |
| `routing-telemetry.ts` | Model routing decision logging |
| `github-sync.ts` | GitHub repository synchronization |
| `providers/` | Chat provider adapters (ollama, claude, openclaw) |
| `ollama-client.ts` | Ollama API client |
| `file-reader.ts` | Safe JSON/text file reading helpers |
| `agent-defaults.ts` | Agent configuration defaults |
| `memory-bridge.ts` | Aggregates memory from multiple sources (auto-memory files, claude-flow MCP) for the `/api/memory/*` endpoints. Fetches claude-flow entries via MCP HTTP at `http://127.0.0.1:3577/mcp` — requires the claude-flow daemon to be running; skips silently if offline. |

## Key Types (`src/lib/types/`)

| File | Key Types |
|------|-----------|
| `chat.ts` | `ChatSession`, `ChatMessage`, `ChatSender`, `ChatToolCall` |
| `tasks.ts` | `Task`, `TaskStatus`, `TaskPriority` |
| `services.ts` | `Service`, `ServiceAction` |
| `projects.ts` | `Project`, `ProjectConfig` |
| `memory.ts` | `MemoryEntry`, `MemorySearchResult`, `MemoryConfig`, `MemoryPageData` (includes `loadErrors: string[] \| null`), `RankedContext`, `AutoMemoryEntry`, `BreakdownEntry`, `ProjectMemorySummary`, `ProjectMemoryPageData` (includes `memoryGraphEnabled: boolean` from memory settings) |
| `graph.ts` | `GraphNode`, `GraphEdge`, `GraphState`, `RankedGraphNode`, `BubbleGraphProps`, `GraphGetResponse`, `GraphPostBody`, `GraphPutBody`, `GraphMutationResponse` |
| `daemon.ts` | `DaemonState`, `DaemonWorker` |

## Components (`src/lib/components/`)

| Component | Used By |
|-----------|---------|
| `Sidebar.svelte` | `+layout.svelte` — main navigation |
| `StatusBar.svelte` | `+layout.svelte` — sticky top bar showing service status pills (Ollama, Gateway, Daemon) and last-sync label. Accepts `services: { label, status }[]` (no `text` field) and `lastSync: string`. Derives `allOnline` to show "All systems operational" / "Degraded" summary. |
| `MetricCard.svelte` | Dashboard, services, models pages |
| `BubbleGraph.svelte` | Memory knowledge graph visualization — responsive SVG (mobile ≤320 px width, desktop ≥500 px), 1 circle per node sized by PageRank, category colour-coded fills via CSS custom property `--node-fill` (no hardcoded SVG `fill` attributes, so `prefers-contrast: more` overrides work correctly), keyboard navigation (arrow keys, Enter/Space), and screen-reader ARIA descriptions. Controlled by the `memoryGraphEnabled` feature flag (see `docs/feature-flag-memory-graph.md`). Accepts `isLoading`, `isEmpty`, `hasError`, `errorMessage`, and `onRetry` props so parent components control UI state without duplicating logic. Resize updates are RAF-batched via `ResizeObserver`; node/edge data changes are also RAF-batched to avoid redundant recomputation when both props update in the same frame. |
| `Markdown.svelte` | Chat messages rendering |

## Project Memory Page (`/projects/[id]/memory`)

### Overview
Displays HNSW-indexed memory entries for a specific project. Shows auto-memory entries (from `.playground/auto-memory-store.json`), ranked context entries (from `.playground/ranked-context.json`), and an interactive memory graph (from `.playground/graph-state.json`).

### Data Sources
| File | Type | Description |
|------|------|-------------|
| `PATHS.autoMemoryStore` | `AutoMemoryEntry[]` | Raw memory entries with key, content, namespace, metadata |
| `PATHS.rankedContext` | `RankedContext` | Entries ranked by confidence, pageRank, and access count |
| `PATHS.graphState` | `GraphState \| null` | Nodes and edges for the BubbleGraph visualization. Set to `null` when the file is missing, returns a non-object value, or lacks a `nodes` property. |

### Entry Format (`AutoMemoryEntry`)
```ts
{
  key: string;           // Unique identifier (e.g. "pattern-auth-jwt")
  content: string;       // Full memory content
  summary?: string;      // Short display label
  namespace?: string;    // Grouping: patterns | decisions | context | errors | dependencies | user-prefs
  type?: string;         // Entry type badge
  metadata?: {
    sourceFile?: string; // Used for project filtering (matches on projectId/projectName)
  };
}
```

### Ranked Context Entry (`RankedEntry`)
```ts
{
  id: string;
  summary?: string;
  category: string;      // preference | architecture | convention | decision | pattern | bug
  confidence: number;    // 0–1 relevance score
  pageRank: number;      // 0–1 graph centrality
  accessCount: number;   // Hit counter
}
```

### Page Sections
1. **Summary Metrics** — Total nodes, namespaces, categories, avg confidence, auto-memory count
2. **Memory Graph** — Lazy-loaded `BubbleGraph` visualization (node size = pageRank). Shows a "disabled" banner when `data.memoryGraphEnabled === false`; shows the empty-state message when the flag is unset/true but no graph data is available.
3. **Namespace Distribution** — Horizontal bar chart of entries per namespace
4. **Category Distribution** — Horizontal bar chart of entries per category
5. **Search** — Client-side filter across key, summary, content, namespace
6. **Namespace Grid** — Color-coded cards per namespace with entry counts
7. **Memory Entries** — Expandable list of all auto-memory entries
8. **Top Context Entries** — Top 10 ranked context entries with confidence/pageRank/hits

### Time-Range Selector
A segmented control above the graph lets users filter memory entries by creation time: **All time** (default), **1 hour**, **24 hours**, **7 days**. Selecting a range appends `?range=<value>` to the refresh request. The selector is rendered as a `role="radiogroup"` for accessibility.

- Auto-memory entries are filtered server-side by `e.createdAt >= cutoff`.
- Graph nodes/edges are filtered by `node.createdAt`; orphaned edges are dropped.
- Ranked-context entries have no timestamps and are kept in full whenever any range is active.
- Changing the range triggers an automatic re-fetch via a `$effect` that compares `selectedRange` to `_prevRange`.
- Each (project, range) combination is cached independently for 30 s.

### Client-Side Refresh
The Refresh button (and the automatic range-change effect) calls `GET /api/projects/{id}/memory[?range=…]` to reload entries, context, and graph without a full page navigation.

In addition to manual refresh, when `data.memoryGraphEnabled` is `true` a `setInterval` timer fires every 30 s and calls the same endpoint (`refreshGraph()`), updating `liveGraph`, `liveContext`, and `liveEntries` in place. The timer is started and cleared inside a `$effect` — it is torn down automatically on component destroy or if the flag becomes `false`.

> **Note — `/memory` page (global, non-project):** The Refresh button on the top-level `/memory` route calls both `GET /api/memory/context` and `GET /api/memory/graph` in parallel. Graph data updates client-side on each refresh; a full page navigation is not required.

### Troubleshooting
| Symptom | Cause | Fix |
|---------|-------|-----|
| "Failed to load memory" error | JSON files missing or malformed | Ensure `.playground/` contains valid `auto-memory-store.json` and `ranked-context.json` |
| "No memory data yet" | No entries stored for this project | Memory populates as agents store patterns — run `npx @claude-flow/cli@latest memory store --key test --value test` |
| Graph shows "No graph data" | `graph-state.json` missing, empty, or lacks a `nodes` property | Graph populates after memory processing; check `PATHS.graphState` — the server validates the object has `nodes` before using it |
| Entries show but no context | `ranked-context.json` missing | Context is generated by the scoring engine — run a memory search to trigger ranking |
| Wrong project's entries shown | Filtering falls back to all entries when none match | Check `metadata.sourceFile` contains the project path |

## Error Handling (`routes/+error.svelte`)

SvelteKit's catch-all error boundary. Handles all unmatched routes (404) and server errors (500).

- **404** — "Page Not Found" with the requested path, Back to Dashboard + Go Back buttons. SEO: `noindex, nofollow`.
- **500** — "Something went wrong" with a Sentry event ID reference and Try Again + Go Back + Dashboard links.
- **Other** — Generic fallback with error message and Back to Dashboard link.
- All variants set `<title>` and `<meta name="description">` via `<svelte:head>`.

### Route-Scoped Error Pages

Several routes have their own `+error.svelte` that renders inline (within the app shell) instead of replacing the full page. Each captures the error to Sentry with a route-specific tag and shows a Retry + Back to Home option.

| Route | File | Sentry tag |
|-------|------|------------|
| `/models` | `routes/models/+error.svelte` | `models-page` |
| `/notifications` | `routes/notifications/+error.svelte` | `notifications-page` |
| `/projects` | `routes/projects/+error.svelte` | `projects-page` |
| `/security` | `routes/security/+error.svelte` | `security-page` |

## Data Flow

```
User action → +page.svelte (client)
  → API endpoint or +page.server.ts (server)
  → lib/server/ module
  → .playground/ files or external service

Claw automation loop (every 60s):
  heartbeat/index.ts → health checks → task scan (all projects, round-robin)
  → agent spawn (per-project limits enforced) → commit changes → follow-ups
  → pid-registry.ts tracks all child PIDs on disk (reaps orphans on restart)
  → Writes to .playground/chats/, .playground/tasks/
  → Pushes notifications via notifications.ts
```
