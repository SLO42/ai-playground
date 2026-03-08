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

The `BubbleGraph` component supports four visual states controlled via props:

| State | Props | What the User Sees |
|-------|-------|--------------------|
| **Loading** | `isLoading={true}` | Spinning icon with "Loading graph…" text (48px tall centered area) |
| **Empty** | `isEmpty={true}` | Cloud icon (40% opacity) with "No memory data to display" |
| **Error** | `hasError={true}` | Red alert icon, error message, and optional Retry button |
| **Graph** | (default) | Interactive SVG bubble graph sized by PageRank |

State priority: `hasError` > `isLoading` > `isEmpty` > normal graph.

At the **page level**, additional states exist:

| Condition | What the User Sees |
|-----------|-------------------|
| `memoryGraphEnabled` is `false` | "Graph feature is disabled" message (graph not rendered at all) |
| Server returns `null` graph | Empty state shown via `isEmpty` prop |
| Client-side refresh fails | Error state shown via `hasError` + `errorMessage` props |

---

## Component Props Reference

```typescript
interface Props {
  nodes: RankedGraphNode[];         // Required — the graph data
  edges?: GraphEdge[];              // Optional — connections between nodes (default: [])
  onNodeClick?: (nodeId: string) => void; // Optional — callback when a node is clicked/activated
  ariaLabel?: string;               // Optional — override the auto-generated aria-label
  isLoading?: boolean;              // Show loading spinner (default: false)
  isEmpty?: boolean;                // Show empty state (default: false)
  hasError?: boolean;               // Show error state (default: false)
  errorMessage?: string;            // Custom error text (default: "Failed to load memory graph")
  onRetry?: () => void;             // If provided, shows a Retry button in error state
}
```

---

## Usage Examples

### Basic usage with data

```svelte
<script lang="ts">
  import BubbleGraph from '$lib/components/BubbleGraph.svelte';
  import type { RankedGraphNode, GraphEdge } from '$lib/types/graph.js';

  let nodes: RankedGraphNode[] = [
    { id: 'auth', label: 'Authentication', category: 'core', pageRank: 0.8, confidence: 0.95, accessCount: 12, createdAt: Date.now() },
    { id: 'jwt', label: 'JWT Tokens', category: 'patterns', pageRank: 0.5, confidence: 0.9, accessCount: 7, createdAt: Date.now() },
  ];
  let edges: GraphEdge[] = [
    { sourceId: 'auth', targetId: 'jwt', type: 'causal', weight: 0.9 }
  ];
</script>

<BubbleGraph {nodes} {edges} onNodeClick={(id) => console.log('Selected:', id)} />
```

### Loading state (while fetching data)

```svelte
<BubbleGraph nodes={[]} isLoading={true} />
```

### Empty state (no data available)

```svelte
<BubbleGraph nodes={[]} isEmpty={true} />
```

### Error state with retry

```svelte
<BubbleGraph
  nodes={[]}
  hasError={true}
  errorMessage="Network error — could not load graph"
  onRetry={() => fetchGraph()}
/>
```

### Lazy-loaded (as used on the memory page)

```svelte
<script lang="ts">
  import type { Component } from 'svelte';
  import type { RankedGraphNode, GraphEdge } from '$lib/types/graph.js';

  let BubbleGraph = $state<Component | null>(null);
  $effect(() => {
    import('$lib/components/BubbleGraph.svelte').then(m => { BubbleGraph = m.default; });
  });

  let graphNodes: RankedGraphNode[] = $state([]);
  let graphEdges: GraphEdge[] = $state([]);
  let graphLoading = $state(true);
  let graphError = $state<string | null>(null);
</script>

{#if BubbleGraph}
  <svelte:component
    this={BubbleGraph}
    nodes={graphNodes}
    edges={graphEdges}
    isLoading={graphLoading}
    isEmpty={!graphLoading && graphNodes.length === 0 && !graphError}
    hasError={!!graphError}
    errorMessage={graphError ?? undefined}
    onRetry={() => refreshGraph()}
  />
{:else}
  <p>Loading component…</p>
{/if}
```

---

## Customization

### Node categories and colors

Nodes are colored by their `category` field:

| Category | Color | Hex |
|----------|-------|-----|
| `core` | Blue | `#3b82f6` |
| `insights` | Purple | `#a855f7` |
| `patterns` | Green | `#22c55e` |
| `security` | Red | `#ef4444` |
| Other | Slate | `#94a3b8` |

### Edge types and styles

| Type | Color | Style |
|------|-------|-------|
| `temporal` | Slate (`#475569`) | Solid, thin (0.8px) |
| `similar` | Purple (`#a855f7`) | Dashed (4,3), medium (1.5px) |
| `causal` | Green (`#22c55e`) | Solid, thin (0.8px) |

### Responsive behavior

- **Desktop** (≥500px): 18px base radius, 36px scale, 14-char labels
- **Mobile** (400–499px): 14px base radius, 26px scale, 11-char labels
- **Narrow** (<400px): 14px base radius, 26px scale, 8-char labels
- Max height caps at `420px` on desktop, `60vh` on mobile, `50vh` on narrow

### Accessibility

- Full keyboard navigation: Arrow keys move focus, Enter/Space activate nodes
- ARIA labels with PageRank score, hit count, category, and connection count
- Focus indicator: cyan drop-shadow ring on focused node
- High contrast mode: full opacity, bold labels, thicker strokes
- Reduced motion: transitions disabled
- Minimum 44px touch targets (invisible hit area for small nodes)

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
| `BubbleGraphProps` | Component props — `nodes`, `edges?`, `onNodeClick?`, `ariaLabel?`, `isLoading?`, `isEmpty?`, `hasError?`, `errorMessage?`, `onRetry?` |

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
