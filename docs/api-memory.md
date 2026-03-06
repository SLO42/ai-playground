# Memory API

Endpoints for the memory subsystem: knowledge graph, auto-memory entries, ranked context, and bridge sync.

All endpoints return `Content-Type: application/json`. Error responses follow the shape `{ "error": "message" }` unless otherwise noted.

---

## Graph — `/api/memory/graph`

Manages the knowledge graph (nodes and edges) stored at `.playground/graph-state.json`.

### `GET /api/memory/graph`

Returns the full graph state. Responses are cached server-side (30s TTL) and include `Cache-Control` headers.

**Response** `200`
```json
{
  "version": 1,
  "updatedAt": 1741276800000,
  "nodeCount": 12,
  "nodes": {
    "node-1": {
      "id": "node-1",
      "category": "concept",
      "confidence": 0.95,
      "accessCount": 3,
      "createdAt": 1741276800000
    }
  },
  "edges": [
    {
      "sourceId": "node-1",
      "targetId": "node-2",
      "type": "similar",
      "weight": 1
    }
  ]
}
```

If the graph file does not exist, returns `null`.

**Error** `500`
```json
{ "error": "Unknown error reading graph state" }
```

---

### `POST /api/memory/graph`

Add nodes and/or edges to the graph. Duplicate nodes (same `id`) and duplicate edges (same `sourceId` + `targetId` + `type`) are silently skipped.

**Request Body**
```json
{
  "nodes": [
    {
      "id": "node-3",
      "category": "pattern",
      "confidence": 0.8,
      "accessCount": 0,
      "createdAt": 1741276800000
    }
  ],
  "edges": [
    {
      "sourceId": "node-1",
      "targetId": "node-3",
      "type": "causal",
      "weight": 0.9
    }
  ]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nodes` | GraphNode[] | No | `[]` | Nodes to add |
| `nodes[].id` | string | Yes | — | Unique node identifier |
| `nodes[].category` | string | Yes | — | Node category |
| `nodes[].confidence` | number | No | `1` | Confidence score (0–1) |
| `nodes[].accessCount` | number | No | `0` | Access counter |
| `nodes[].createdAt` | number | No | `Date.now()` | Unix timestamp (ms) |
| `edges` | GraphEdge[] | No | `[]` | Edges to add |
| `edges[].sourceId` | string | Yes | — | Source node ID |
| `edges[].targetId` | string | Yes | — | Target node ID |
| `edges[].type` | string | No | `"similar"` | One of: `temporal`, `similar`, `causal` |
| `edges[].weight` | number | No | `1` | Edge weight |

At least one node or edge must be provided.

**Response** `200`
```json
{
  "ok": true,
  "nodesAdded": 1,
  "edgesAdded": 1,
  "nodeCount": 13,
  "edgeCount": 5
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | No nodes or edges provided |
| `400` | Node missing `id` or `category` |
| `400` | Edge missing `sourceId` or `targetId` |
| `400` | Invalid edge type (not `temporal`, `similar`, or `causal`) |

---

### `PUT /api/memory/graph`

Update existing nodes and/or edges. Non-existent nodes/edges are silently skipped. Edges can be deleted by setting `_delete: true`.

**Request Body**
```json
{
  "nodes": [
    { "id": "node-1", "confidence": 0.99 }
  ],
  "edges": [
    { "sourceId": "node-1", "targetId": "node-2", "type": "similar", "weight": 2.0 },
    { "sourceId": "node-1", "targetId": "node-3", "type": "causal", "_delete": true }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `nodes` | Partial\<GraphNode\>[] | No | Node updates (only provided fields are changed) |
| `nodes[].id` | string | Yes | ID of node to update |
| `nodes[].category` | string | No | New category |
| `nodes[].confidence` | number | No | New confidence |
| `nodes[].accessCount` | number | No | New access count |
| `edges` | (Partial\<GraphEdge\> & { _delete? })[] | No | Edge updates or deletions |
| `edges[].sourceId` | string | Yes | Source node ID |
| `edges[].targetId` | string | Yes | Target node ID |
| `edges[].type` | string | No | Edge type to match (for lookup) or new type |
| `edges[].weight` | number | No | New weight |
| `edges[]._delete` | boolean | No | If `true`, delete the matched edge |

**Response** `200`
```json
{
  "ok": true,
  "nodesUpdated": 1,
  "edgesUpdated": 1,
  "edgesDeleted": 1,
  "nodeCount": 13,
  "edgeCount": 4
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | No node or edge updates provided |
| `400` | Node update missing `id` |
| `400` | Edge update missing `sourceId` or `targetId` |

---

## Entries — `/api/memory/entries`

Manages auto-memory entries stored at `.playground/auto-memory-store.json`.

### `DELETE /api/memory/entries`

Remove entries by ID.

**Request Body**
```json
{
  "ids": ["entry-1", "entry-2"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ids` | string[] | Yes | List of entry IDs to remove |

**Response** `200` (entries removed)
```json
{
  "removed": 2,
  "remaining": 15
}
```

**Response** `200` (no matches)
```json
{
  "removed": 0,
  "message": "no matching entries found"
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | `ids` is missing or not a non-empty array |

---

## Context — `/api/memory/context`

Returns the combined ranked context and auto-memory entries for display on the memory page.

### `GET /api/memory/context`

**Response** `200`
```json
{
  "context": {
    "rankedItems": [
      {
        "key": "pattern-auth",
        "value": "JWT with refresh tokens",
        "score": 0.95,
        "namespace": "patterns"
      }
    ]
  },
  "autoMemory": [
    {
      "id": "am-1",
      "content": "User prefers split commits",
      "source": "conversation",
      "timestamp": 1741276800000
    }
  ]
}
```

Either field may be `null` if the corresponding file does not exist.

---

## Sync — `/api/memory/sync`

Triggers a manual sync of the memory bridge (imports auto-memory files into the backend).

### `POST /api/memory/sync`

No request body required.

**Response** `200`
```json
{
  "imported": 3,
  "skipped": 1,
  "total": 4
}
```

The response shape depends on the `syncMemoryBridge()` implementation.

**Errors**

| Status | Condition |
|--------|-----------|
| `500` | Sync operation failed |

---

## Project Memory — `/api/projects/[id]/memory`

See `api-contracts.md` for project-scoped memory endpoints.
