# BubbleGraph Component

SVG-based interactive bubble graph for visualizing the memory knowledge graph. Nodes are rendered as circles sized by PageRank, colored by category, and connected by typed edges.

## Location

- Component: `dashboard/src/lib/components/BubbleGraph.svelte`
- Types: `dashboard/src/lib/types/graph.ts`
- Tests: `dashboard/src/lib/components/BubbleGraph.test.ts`
- Usage: `dashboard/src/routes/memory/+page.svelte` (lazy-loaded)

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `nodes` | `RankedGraphNode[]` | Yes | Array of graph nodes to display as bubbles |
| `edges` | `GraphEdge[]` | No | Array of edges connecting nodes |
| `onNodeClick` | `(nodeId: string) => void` | No | Callback fired when a node bubble is clicked or activated via keyboard |

## Data Types

### `RankedGraphNode`

Extends `GraphNode` with computed display properties.

```typescript
interface GraphNode {
  id: string;          // Unique node identifier
  category: string;    // Category for color coding (see below)
  confidence: number;  // Confidence score (0-1)
  accessCount: number; // Number of times this node has been accessed
  createdAt: number;   // Unix timestamp of creation
}

interface RankedGraphNode extends GraphNode {
  pageRank: number;    // PageRank score (0-1), controls bubble radius
  label: string;       // Display label (truncated to 14 chars + ellipsis)
}
```

### `GraphEdge`

```typescript
interface GraphEdge {
  sourceId: string;                          // ID of source node
  targetId: string;                          // ID of target node
  type: 'temporal' | 'similar' | 'causal';  // Edge type (affects color/style)
  weight: number;                            // Edge weight
}
```

### `GraphState`

The full graph payload returned by the server. The Memory page transforms this into the props above.

```typescript
interface GraphState {
  version: number;
  updatedAt: number;
  nodeCount: number;
  nodes: Record<string, GraphNode>;   // Keyed by node ID
  edges: GraphEdge[];
  pageRanks?: Record<string, number>; // Optional precomputed PageRank map
}
```

## Visual Mapping

### Category Colors

| Category | Color | Hex |
|----------|-------|-----|
| `core` | Blue | `#3b82f6` |
| `insights` | Purple | `#a855f7` |
| `patterns` | Green | `#22c55e` |
| `security` | Red | `#ef4444` |
| _(other)_ | Slate | `#94a3b8` |

### Edge Styles

| Type | Color | Style |
|------|-------|-------|
| `temporal` | _(default)_ | Solid |
| `similar` | Purple (`#a855f7`) | Dashed (`4,3`) |
| `causal` | Green (`#22c55e`) | Solid |

### Node Sizing

Bubble radius scales with `pageRank` — higher PageRank produces larger circles.

Each node also displays a subtitle line showing `PR: {pageRank}` and `{accessCount} hits`.

## Integration Example

### Basic usage (static import)

```svelte
<script lang="ts">
  import BubbleGraph from '$lib/components/BubbleGraph.svelte';
  import type { RankedGraphNode, GraphEdge } from '$lib/types/graph.js';

  const nodes: RankedGraphNode[] = [
    { id: 'auth', category: 'core', confidence: 0.9, accessCount: 12,
      createdAt: Date.now(), pageRank: 0.8, label: 'Authentication' },
    { id: 'rbac', category: 'security', confidence: 0.7, accessCount: 5,
      createdAt: Date.now(), pageRank: 0.4, label: 'RBAC' }
  ];

  const edges: GraphEdge[] = [
    { sourceId: 'auth', targetId: 'rbac', type: 'causal', weight: 1 }
  ];

  function handleClick(nodeId: string) {
    console.log('Selected:', nodeId);
  }
</script>

<BubbleGraph {nodes} {edges} onNodeClick={handleClick} />
```

### Lazy-loaded (as used on the Memory page)

```svelte
<script lang="ts">
  import type { Component } from 'svelte';
  import type { RankedGraphNode, GraphEdge } from '$lib/types/graph.js';

  let BubbleGraph = $state<Component<{
    nodes: RankedGraphNode[];
    edges?: GraphEdge[];
    onNodeClick?: (nodeId: string) => void;
  }> | null>(null);

  $effect(() => {
    import('$lib/components/BubbleGraph.svelte').then(m => {
      BubbleGraph = m.default;
    });
  });
</script>

{#if BubbleGraph}
  <BubbleGraph {nodes} {edges} onNodeClick={handleClick} />
{:else}
  <p>Loading graph...</p>
{/if}
```

### Transforming `GraphState` into props

The Memory page converts the server's `GraphState` into `RankedGraphNode[]`:

```typescript
const ranked: RankedGraphNode[] = Object.values(graphState.nodes).map(node => ({
  ...node,
  pageRank: graphState.pageRanks?.[node.id] ?? 0,
  label: node.id
}));
```

## Accessibility

- Each node is wrapped in a `<g role="button" tabindex="0">` for keyboard navigation.
- Pressing **Enter** on a focused node fires `onNodeClick`.
- A legend is rendered at the bottom of the SVG showing edge type colors.

## Rendering Details

- The component renders a single `<svg>` element.
- Edges referencing non-existent node IDs are silently ignored.
- An empty `nodes` array renders an SVG with no circles.
- Labels longer than 14 characters are truncated with an ellipsis (`...`).
