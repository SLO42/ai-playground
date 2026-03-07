# Memory Page — Graph Data Reference

## Overview

The memory page visualizes a knowledge graph built from the system's memory entries. The server loads graph state from a JSON file (`.playground/ui-analytics.json` path group) and passes it to the SvelteKit page via `+page.server.ts`.

## Data Flow

1. **Server** (`dashboard/src/routes/memory/+page.server.ts`) reads `GraphState` from disk using `readJsonFile<GraphState>(PATHS.graphState)`
2. Graph loading respects the `memoryGraphEnabled` setting — if disabled, `null` is returned
3. **Page** receives graph data via `PageServerLoad` as part of `MemoryPageData`
4. **BubbleGraph** component renders nodes as sized bubbles with optional edge connections

## GraphState (root object)

The file on disk must conform to the `GraphState` interface (defined in `dashboard/src/lib/types/graph.ts`):

```typescript
interface GraphState {
  version: number;       // Schema version (currently 1)
  updatedAt: number;     // Unix timestamp (ms) of last update
  nodeCount: number;     // Total node count (must match Object.keys(nodes).length)
  nodes: Record<string, GraphNode>;  // Keyed by node ID
  edges: GraphEdge[];    // Array of directed edges
  pageRanks?: Record<string, number>; // Optional pre-computed PageRank scores
}
```

## GraphNode

Each node represents a memory entry or concept:

```typescript
interface GraphNode {
  id: string;           // Unique identifier
  category: string;     // Grouping category (e.g. "pattern", "decision", "context")
  confidence: number;   // 0-1 confidence score
  accessCount: number;  // How many times this node has been accessed
  createdAt: number;    // Unix timestamp (ms) of creation
}
```

## GraphEdge

Edges connect related nodes:

```typescript
interface GraphEdge {
  sourceId: string;     // ID of the source node
  targetId: string;     // ID of the target node
  type: 'temporal' | 'similar' | 'causal';  // Relationship type
  weight: number;       // 0-1 strength of the relationship
}
```

### Edge Types

| Type | Meaning |
|------|---------|
| `temporal` | Nodes were created or accessed in temporal proximity |
| `similar` | Nodes share semantic similarity |
| `causal` | One node causally relates to another (source caused/led to target) |

## Example File

A minimal valid graph state JSON file:

```json
{
  "version": 1,
  "updatedAt": 1741267200000,
  "nodeCount": 3,
  "nodes": {
    "node-001": {
      "id": "node-001",
      "category": "pattern",
      "confidence": 0.92,
      "accessCount": 5,
      "createdAt": 1741180800000
    },
    "node-002": {
      "id": "node-002",
      "category": "decision",
      "confidence": 0.85,
      "accessCount": 2,
      "createdAt": 1741180900000
    },
    "node-003": {
      "id": "node-003",
      "category": "context",
      "confidence": 0.78,
      "accessCount": 1,
      "createdAt": 1741181000000
    }
  },
  "edges": [
    {
      "sourceId": "node-001",
      "targetId": "node-002",
      "type": "causal",
      "weight": 0.9
    },
    {
      "sourceId": "node-002",
      "targetId": "node-003",
      "type": "temporal",
      "weight": 0.6
    }
  ]
}
```

## Empty / Missing States

The UI handles these cases gracefully:
- **`graph` is `null`** — Graph file missing or `memoryGraphEnabled` is false. Shows: "No graph data. Memory graph populates as the system processes entries."
- **`graph.nodes` is `{}`** — Graph exists but has no nodes. Same empty-state message.
- **Load error** — File read fails. Error is captured in `loadErrors` array and can be displayed by the UI.

## API Endpoints

The graph can also be read and mutated via REST:

- **GET** `/api/memory/graph` — Returns `GraphState` or `{ error: string }`
- **POST** `/api/memory/graph` — Add new nodes/edges (`GraphPostBody`)
- **PUT** `/api/memory/graph` — Update existing nodes/edges, or delete edges with `_delete: true` (`GraphPutBody`)

## Server Population

The graph is populated by the heartbeat system (`dashboard/src/lib/server/heartbeat/`). As the system processes memory entries, it:
1. Creates nodes for new memory concepts with category and confidence
2. Computes edges based on temporal proximity, semantic similarity, and causal relationships
3. Optionally computes PageRank scores stored in `pageRanks`
4. Writes the updated `GraphState` to disk, where the page server loader picks it up
