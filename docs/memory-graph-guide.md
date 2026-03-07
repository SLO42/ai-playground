# Memory Graph — Usage & Configuration Guide

How the memory page knowledge graph works, the APIs it consumes, and how to enable or disable it.

---

## Overview

The memory page displays an interactive knowledge graph that visualizes relationships between memory entries (patterns, decisions, context). Nodes appear as sized bubbles (scaled by PageRank), colored by category, and connected by typed edges. The graph is rendered by the `BubbleGraph` component.

## Enabling / Disabling the Graph

The graph is controlled by the `memoryGraphEnabled` feature flag.

### Via the Settings UI

1. Navigate to **Settings > Memory**
2. Toggle the **Memory Graph** switch
3. Click **Save**

The setting is persisted to `.playground/memory-settings.json`.

### Via the Settings API

```bash
# Read current settings
curl http://localhost:5173/api/settings/memory

# Enable the graph
curl -X POST http://localhost:5173/api/settings/memory \
  -H 'Content-Type: application/json' \
  -d '{"memoryGraphEnabled": true}'

# Disable the graph
curl -X POST http://localhost:5173/api/settings/memory \
  -H 'Content-Type: application/json' \
  -d '{"memoryGraphEnabled": false}'
```

### Default

The graph is **enabled by default** (`memoryGraphEnabled: true`). The default is defined in `dashboard/src/lib/server/memory-settings.ts`.

---

## How It Works

### Data Flow

```
.claude-flow/data/graph-state.json
        |
        v
+page.server.ts (reads GraphState via readJsonFile)
        |
        |  checks memoryGraphEnabled flag
        |  validates: must be object with .nodes
        |
        v
+page.svelte (receives graph as prop)
        |
        |  transforms GraphState -> RankedGraphNode[]
        |  lazy-loads BubbleGraph component
        |
        v
BubbleGraph.svelte (renders SVG bubbles + edges)
```

1. **Server loader** reads the graph state JSON from disk
2. If `memoryGraphEnabled` is `false`, the graph is returned as `null` (skipped entirely)
3. If the file is missing or malformed, `null` is returned with an error captured in `loadError`
4. The **page component** transforms `GraphState.nodes` into `RankedGraphNode[]` using PageRank scores
5. The **BubbleGraph** component renders an accessible, interactive SVG

### Graph Population

The heartbeat system populates the graph automatically:
- Creates nodes for new memory concepts with category and confidence scores
- Computes edges based on temporal proximity, semantic similarity, and causal relationships
- Optionally computes PageRank scores stored in `pageRanks`
- Writes the updated `GraphState` to disk

### Client-Side Refresh

The memory page supports refreshing graph data without a full page reload. It fetches from `GET /api/memory/graph` with exponential backoff (up to 3 retries). When `memoryGraphEnabled` is `false`, the refresh button does not fetch graph data.

---

## UI States

| Condition | What the User Sees |
|-----------|-------------------|
| `memoryGraphEnabled` is `false` | "Graph feature is disabled" message |
| Graph loading in progress | "Loading memory graph..." skeleton |
| Graph file missing / no data | "No graph data yet" with a refresh button |
| Graph load error | Error message with a "Retry" button |
| Graph loaded successfully | Interactive bubble graph visualization |

---

## API Reference

The graph data is available at `/api/memory/graph`. All responses are JSON.

### `GET /api/memory/graph`

Returns the full `GraphState` object. Cached server-side with 30s TTL.

**Success (200):**
```json
{
  "version": 1,
  "updatedAt": 1741276800000,
  "nodeCount": 12,
  "nodes": { "node-1": { "id": "node-1", "category": "core", "confidence": 0.95, "accessCount": 3, "createdAt": 1741276800000 } },
  "edges": [{ "sourceId": "node-1", "targetId": "node-2", "type": "similar", "weight": 1 }],
  "pageRanks": { "node-1": 0.6, "node-2": 0.4 }
}
```

Returns `null` if the graph file does not exist.

### `POST /api/memory/graph`

Add new nodes and/or edges. Duplicates are silently skipped.

```json
{
  "nodes": [{ "id": "new-node", "category": "pattern", "confidence": 0.8, "accessCount": 0, "createdAt": 1741276800000 }],
  "edges": [{ "sourceId": "node-1", "targetId": "new-node", "type": "causal", "weight": 0.9 }]
}
```

### `PUT /api/memory/graph`

Update existing nodes/edges, or delete edges with `"_delete": true`.

```json
{
  "nodes": [{ "id": "node-1", "confidence": 0.99 }],
  "edges": [{ "sourceId": "node-1", "targetId": "node-3", "type": "causal", "_delete": true }]
}
```

For full request/response schemas, see [api-memory.md](api-memory.md).

---

## Data Types

All types are defined in `dashboard/src/lib/types/graph.ts`.

| Type | Description |
|------|-------------|
| `GraphState` | Root object read from disk — contains `nodes`, `edges`, `pageRanks`, `version`, `updatedAt` |
| `GraphNode` | A single memory node — `id`, `category`, `confidence`, `accessCount`, `createdAt` |
| `GraphEdge` | A directed edge — `sourceId`, `targetId`, `type` (temporal/similar/causal), `weight` |
| `RankedGraphNode` | `GraphNode` + `pageRank` + `label` — used by `BubbleGraph` for rendering |
| `BubbleGraphProps` | Component props — `nodes`, `edges?`, `onNodeClick?`, `ariaLabel?` |

---

## Key Files

| File | Purpose |
|------|---------|
| `dashboard/src/lib/server/memory-settings.ts` | Reads/writes `memoryGraphEnabled` flag |
| `dashboard/src/lib/types/graph.ts` | All graph type definitions |
| `dashboard/src/routes/memory/+page.server.ts` | Server loader (reads graph, checks flag) |
| `dashboard/src/routes/memory/+page.svelte` | Page UI with lazy-loaded BubbleGraph |
| `dashboard/src/lib/components/BubbleGraph.svelte` | SVG graph renderer |
| `dashboard/src/routes/api/memory/graph/` | REST API endpoints |
| `dashboard/src/routes/api/settings/memory/` | Settings API (enable/disable) |
| `dashboard/src/routes/settings/+page.svelte` | Settings UI (Memory tab) |

---

## Related Documentation

- [api-memory.md](api-memory.md) — Full API contract for all memory endpoints
- [memory-graph-data.md](memory-graph-data.md) — GraphState schema reference and example JSON
- [components/bubble-graph.md](components/bubble-graph.md) — BubbleGraph component reference
