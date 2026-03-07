# Feature Flag: `memoryGraphEnabled`

Controls whether the knowledge graph visualization is rendered and refreshed on memory pages.

## Configuration

The flag is stored in `.playground/memory-settings.json`:

```json
{
  "memoryGraphEnabled": true
}
```

**Default**: `true` (graph enabled).

The file is read by `loadMemorySettings()` in `dashboard/src/lib/server/memory-settings.ts`. If the file is missing or the field is absent, the default (`true`) is used.

### Changing via Settings UI

The dashboard Settings page (`/settings`) exposes a toggle for this flag. Toggling it sends a `PUT` to `/api/settings/memory` with:

```json
{ "memoryGraphEnabled": false }
```

The API handler (`dashboard/src/routes/api/settings/memory/+server.ts`) validates the value is a boolean, falling back to the default if not.

### Changing Manually

Edit `.playground/memory-settings.json` directly. The server reads this file on each page load, so changes take effect on the next navigation or refresh.

## Behavioral Effects

### When `true` (enabled)

1. **Server-side loading** — `+page.server.ts` reads `GraphState` from `.playground/graph-state.json` and includes it in page data.
2. **Graph rendering** — The `BubbleGraph` component renders nodes (sized by PageRank) with edge connections.
3. **Auto-refresh timer** — A `setInterval` fires every **30 seconds**, calling the graph API endpoint to update `liveGraph`, `liveContext`, and `liveEntries` in place. The timer is managed inside a Svelte `$effect` and tears down on component destroy.
4. **Manual refresh** — A "Refresh" button fetches updated graph data on demand.

### When `false` (disabled)

1. **Server-side loading** — The graph file read is **skipped entirely**; `graph` is returned as `null`.
2. **Graph rendering** — The `BubbleGraph` component is not rendered. A "disabled" banner is shown instead, informing the user the feature is off.
3. **Auto-refresh timer** — The 30-second interval is **not started**. If the flag transitions from `true` to `false`, the existing timer is cleared.
4. **Manual refresh** — Graph data is excluded from refresh requests.

### Edge Cases

| Condition | UI State |
|-----------|----------|
| Flag is `true`, graph data exists | Full graph visualization |
| Flag is `true`, graph data is `null` (file missing) | Empty state — "No graph data yet" with a "Check Again" button |
| Flag is `false`, regardless of graph data | Disabled state — banner explaining the feature is off |
| Flag is `true`, graph load fails | Error state — error message with "Retry" button (via `loadErrors`) |

## Affected Files

| File | Role |
|------|------|
| `.playground/memory-settings.json` | Persisted setting |
| `dashboard/src/lib/server/memory-settings.ts` | Reads and parses the settings file |
| `dashboard/src/lib/types/memory.ts` | `MemorySettings` and `MemoryPageData` type definitions |
| `dashboard/src/routes/memory/+page.server.ts` | Conditionally loads graph based on flag |
| `dashboard/src/routes/memory/+page.svelte` | Conditionally renders graph and manages refresh timer |
| `dashboard/src/routes/projects/[id]/memory/+page.server.ts` | Project-scoped equivalent |
| `dashboard/src/routes/projects/[id]/memory/+page.svelte` | Project-scoped equivalent |
| `dashboard/src/routes/settings/+page.svelte` | Settings UI toggle |
| `dashboard/src/routes/api/settings/memory/+server.ts` | API handler for updating the flag |

## Related Documentation

- [Memory API](api-memory.md) — Full endpoint reference including graph CRUD
- [Memory Graph Data](memory-graph-data.md) — `GraphState` schema and example data
