# Dashboard Architecture

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
| `/services` | `routes/services/+page.svelte` | `routes/services/+page.server.ts` |
| `/settings` | `routes/settings/+page.svelte` | `routes/settings/+page.server.ts` |
| `/reports` | `routes/reports/+page.svelte` | (uses `lib/server/reports.ts`) |
| `/sessions` | `routes/sessions/+page.svelte` | `routes/sessions/+page.server.ts` |
| `/agents` | `routes/agents/+page.svelte` | (client-side) |
| `/apps` | `routes/apps/+page.svelte` | `routes/apps/+page.server.ts` |
| `/memory` | `routes/memory/+page.svelte` | (client-side — see `docs/api-memory.md`) |
| `/security` | `routes/security/+page.svelte` | (client-side) |
| `/notifications` | `routes/notifications/+page.svelte` | `routes/notifications/+page.server.ts` |
| `/hooks` | `routes/hooks/+page.svelte` | `routes/hooks/+page.server.ts` |
| `/about` | `routes/about/+page.server.ts` | (server only) |

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chat` | POST | Multi-provider chat streaming (SSE) |
| `/api/chat/history` | GET/POST | Chat session CRUD |
| `/api/services` | GET | Service status polling |
| `/api/services/[id]` | POST | Start/stop/restart service |
| `/api/health` | GET | Quick health check (ollama, gateway, daemon) |
| `/api/projects` | GET/POST | Project CRUD |
| `/api/projects/[id]/tasks` | GET/POST | Task CRUD per project |
| `/api/notifications` | GET | Notification polling |
| `/api/settings` | GET/POST | Settings read/write |
| `/api/sessions` | GET | Session listing |
| `/api/reports` | GET/POST | Report generation |
| `/api/routing` | GET | Routing telemetry |
| `/api/agents` | GET | Active agent listing |
| `/api/github` | Various | GitHub sync operations |
| `/api/memory/graph` | GET/POST/PUT | Knowledge graph CRUD (nodes + edges) |
| `/api/memory/entries` | DELETE | Remove auto-memory entries by ID |
| `/api/memory/context` | GET | Ranked context + auto-memory entries |
| `/api/memory/sync` | POST | Trigger memory bridge sync |

## Server Modules (`src/lib/server/`)

| Module | Purpose |
|--------|---------|
| `heartbeat/` | Claw autonomous agent system (split into shared, spawn, tracking, review, discussion) |
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

## Key Types (`src/lib/types/`)

| File | Key Types |
|------|-----------|
| `chat.ts` | `ChatSession`, `ChatMessage`, `ChatSender`, `ChatToolCall` |
| `tasks.ts` | `Task`, `TaskStatus`, `TaskPriority` |
| `services.ts` | `Service`, `ServiceAction` |
| `projects.ts` | `Project`, `ProjectConfig` |
| `memory.ts` | `MemoryEntry`, `MemorySearchResult` |
| `graph.ts` | `GraphNode`, `GraphEdge`, `GraphState`, `RankedGraphNode`, `BubbleGraphProps`, `GraphPostBody`, `GraphPutBody`, `GraphMutationResponse` |
| `daemon.ts` | `DaemonState`, `DaemonWorker` |

## Components (`src/lib/components/`)

| Component | Used By |
|-----------|---------|
| `Sidebar.svelte` | `+layout.svelte` — main navigation |
| `MetricCard.svelte` | Dashboard, services, models pages |
| `BubbleGraph.svelte` | Dashboard overview visualization |
| `Markdown.svelte` | Chat messages rendering |

## Project Memory Page (`/projects/[id]/memory`)

### Overview
Displays HNSW-indexed memory entries for a specific project. Shows auto-memory entries (from `.playground/auto-memory-store.json`), ranked context entries (from `.playground/ranked-context.json`), and an interactive memory graph (from `.playground/graph-state.json`).

### Data Sources
| File | Type | Description |
|------|------|-------------|
| `PATHS.autoMemoryStore` | `AutoMemoryEntry[]` | Raw memory entries with key, content, namespace, metadata |
| `PATHS.rankedContext` | `RankedContext` | Entries ranked by confidence, pageRank, and access count |
| `PATHS.graphState` | `GraphState` | Nodes and edges for the BubbleGraph visualization |

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
2. **Memory Graph** — Lazy-loaded `BubbleGraph` visualization (node size = pageRank)
3. **Namespace Distribution** — Horizontal bar chart of entries per namespace
4. **Category Distribution** — Horizontal bar chart of entries per category
5. **Search** — Client-side filter across key, summary, content, namespace
6. **Namespace Grid** — Color-coded cards per namespace with entry counts
7. **Memory Entries** — Expandable list of all auto-memory entries
8. **Top Context Entries** — Top 10 ranked context entries with confidence/pageRank/hits

### Client-Side Refresh
The Refresh button calls `GET /api/projects/{id}/memory` to reload entries and context without a full page navigation.

### Troubleshooting
| Symptom | Cause | Fix |
|---------|-------|-----|
| "Failed to load memory" error | JSON files missing or malformed | Ensure `.playground/` contains valid `auto-memory-store.json` and `ranked-context.json` |
| "No memory data yet" | No entries stored for this project | Memory populates as agents store patterns — run `npx @claude-flow/cli@latest memory store --key test --value test` |
| Graph shows "No graph data" | `graph-state.json` missing or empty | Graph populates after memory processing; check `PATHS.graphState` |
| Entries show but no context | `ranked-context.json` missing | Context is generated by the scoring engine — run a memory search to trigger ranking |
| Wrong project's entries shown | Filtering falls back to all entries when none match | Check `metadata.sourceFile` contains the project path |

## Data Flow

```
User action → +page.svelte (client)
  → API endpoint or +page.server.ts (server)
  → lib/server/ module
  → .playground/ files or external service

Heartbeat cycle (every 60s):
  heartbeat/index.ts → health check → task scan → agent spawn → review
  → Writes to .playground/chats/, .playground/tasks/
  → Pushes notifications via notifications.ts
```
