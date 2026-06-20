<script lang="ts">
  /**
   * /memory — global knowledge-graph + recall explorer (UI-SPEC §43/§204; §5 KnowledgeGraph
   * + MemorySearch). Two surfaces: a recall LIST (recent memory rows, keyword-filterable)
   * and a knowledge-GRAPH view (entity nodes + typed edges). All LIVE from the DB (F-008 —
   * no fabricated node). Four honest states (loading/empty/error/live, §1.3/§8). Live by
   * default (§1.2): a `memory` or `entity` row change on the one SSE stream re-invalidates
   * the loader so both surfaces update in place. Archived/superseded rows render dimmed
   * (§155/§156). Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { page } from '$app/stores';
  import { stream } from '$lib/client/stream.svelte';
  import MemoryTabs from '$lib/components/shell/MemoryTabs.svelte';
  import MemoryScene from '$lib/components/scene/MemoryScene.svelte';
  import ActivityFeed from '$lib/components/scene/ActivityFeed.svelte';
  import type { SceneChange } from '$lib/client/scene/scene-graph';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const memories = $derived(data.memories ?? []);
  const graph = $derived(data.graph ?? { nodes: [], edges: [] });
  // MEMORY-SCENE-SPEC §4 — the derived node/edge TRUTH for the living-brain Scene lens.
  const scene = $derived(data.scene ?? { nodes: [], edges: [] });
  // MEMORY-SCENE-SPEC §5 — the recent scene_event activity slice (the "what's happening now"
  // feed). Derived live; honest empty handled in ActivityFeed.
  const activity = $derived(data.activity ?? []);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // Lens toggle (operator fork #1: a 'Scene' LENS on /memory, not a new route). The Scene
  // is decorative-augmenting — the honest Explorer text views stay the default + always
  // reachable. Seeded from ?lens=scene so the view is deep-linkable.
  let lens = $state<'explorer' | 'scene'>(
    $page.url.searchParams.get('lens') === 'scene' ? 'scene' : 'explorer'
  );

  // The live animation feed for the Scene (the ONE SSE). The component owns NO truth — this
  // only drives the animation timeline (which node spawned/fired/retired). The truth refresh
  // (loader re-invalidation above) is what actually adds/removes nodes. We bridge the SSE's
  // per-table onDbChange into the component's (topic, change) callback shape.
  function sceneFeed(onChange: (topic: string, change: SceneChange) => void): () => void {
    const topics = ['entity', 'memory', 'session', 'work_item', 'references'];
    const offs = topics.map((t) =>
      stream.onDbChange(t, (change) =>
        onChange(t, change as unknown as SceneChange)
      )
    );
    return () => offs.forEach((off) => off());
  }

  // Keyword recall filter (client-side over the live list — honest: filters real rows only).
  // Seeded from ?q= so a deep link (e.g. the /cannibalize "recall →" link, which passes a
  // memory row id) lands pre-filtered on the target finding. Matches content OR the row id.
  let query = $state($page.url.searchParams.get('q') ?? '');
  const filtered = $derived(
    query.trim()
      ? memories.filter((m) => {
          const q = query.trim().toLowerCase();
          return m.content.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
        })
      : memories
  );

  // Focused graph node → its 1-hop neighbours (UI-SPEC §155 node-focus).
  let focusId = $state<string | null>(null);
  const neighbours = $derived(
    focusId
      ? new Set(
          graph.edges
            .filter((e) => e.from === focusId || e.to === focusId)
            .map((e) => (e.from === focusId ? e.to : e.from))
        )
      : new Set<string>()
  );
  const focusedEdges = $derived(
    focusId ? graph.edges.filter((e) => e.from === focusId || e.to === focusId) : []
  );

  const hasMemories = $derived(memories.length > 0);
  const hasGraph = $derived(graph.nodes.length > 0);

  // Live updates: a memory/entity row change re-runs the loader (UI-SPEC §1.2). The scene
  // graph (MEMORY-SCENE-SPEC §7.2) derives off the SAME source tables plus the USAGE/JOBS
  // layer (session/work_item), so we also re-derive it on those — `app:scene` keeps the
  // living-brain data foundation live for the §7.3 UI wave.
  $effect(() => {
    const offs = [
      stream.onDbChange('memory', () => void invalidate('app:memory')),
      stream.onDbChange('entity', () => void invalidate('app:graph')),
      stream.onDbChange('references', () => void invalidate('app:graph')),
      stream.onDbChange('memory', () => void invalidate('app:scene')),
      stream.onDbChange('entity', () => void invalidate('app:scene')),
      stream.onDbChange('references', () => void invalidate('app:scene')),
      stream.onDbChange('session', () => void invalidate('app:scene')),
      stream.onDbChange('work_item', () => void invalidate('app:scene')),
      // MEMORY-SCENE-SPEC §5 — a new scene_event re-runs the loader so the activity feed
      // (the "what's happening now" panel) refreshes live off its derived truth.
      stream.onDbChange('scene_event', () => void invalidate('app:scene'))
    ];
    return () => offs.forEach((off) => off());
  });

  function shortId(id: string): string {
    return id.replace(/^\w+:/, '');
  }
  function shortProject(id: string | undefined): string {
    return id ? id.replace(/^project:/, '') : '—';
  }
  function focus(id: string): void {
    focusId = focusId === id ? null : id;
  }
</script>

<svelte:head>
  <title>Memory — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">knowledge</span>
    <h1 class="title">Memory</h1>
    <p class="lede">
      The portfolio's long-term memory — recalled rows and the knowledge graph of entities
      and their typed links. Everything here is real stored memory; nothing is fabricated.
    </p>
  </header>

  <MemoryTabs />

  <!-- Lens toggle (Explorer ↔ Scene) — the Scene is augmenting; Explorer stays the honest default. -->
  <div class="lens-toggle" role="tablist" aria-label="Memory lens">
    <button
      type="button"
      class="lens-tab"
      role="tab"
      aria-selected={lens === 'explorer'}
      data-active={lens === 'explorer'}
      onclick={() => (lens = 'explorer')}
    >
      Explorer
    </button>
    <button
      type="button"
      class="lens-tab"
      role="tab"
      aria-selected={lens === 'scene'}
      data-active={lens === 'scene'}
      onclick={() => (lens = 'scene')}
    >
      Scene
    </button>
  </div>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no memory rather than a fabricated graph.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else if lens === 'scene'}
    <!-- MEMORY-SCENE-SPEC §4 — the living-brain animated force graph (the Scene lens). The
         node/edge truth is the derived `scene` from the loader; the live feed drives the
         spawn/pulse/connect/retire micro-animations. Honest empty handled in the component. -->
    <div class="scene-grid">
      <div class="card scene-card">
        <div class="scene-head">
          <span class="eyebrow">
            living scene · {scene.nodes.length} {scene.nodes.length === 1 ? 'node' : 'nodes'} · {scene.edges.length} {scene.edges.length === 1 ? 'edge' : 'edges'}
          </span>
          <!-- Node-class legend (design tokens only) — explains the bubble colors. -->
          <ul class="legend-key" aria-label="Node class legend">
            <li><span class="key-dot" data-class="memory" aria-hidden="true"></span>memory</li>
            <li><span class="key-dot" data-class="job" data-status="active" aria-hidden="true"></span>job · active</li>
            <li><span class="key-dot" data-class="job" data-status="pending" aria-hidden="true"></span>job · pending</li>
            <li><span class="key-dot" data-class="job" data-status="done" aria-hidden="true"></span>job · done</li>
            <li><span class="key-dot" data-class="job" data-status="failed" aria-hidden="true"></span>job · failed</li>
          </ul>
        </div>
        <MemoryScene graph={scene} feed={sceneFeed} />
      </div>

      <!-- Activity feed (§5) — the "what's happening now" panel + the scene's text-equivalent. -->
      <aside class="card activity-card">
        <ActivityFeed {activity} />
      </aside>
    </div>
  {:else}
    <div class="grid">
      <!-- Recall list (MemorySearch, §5) -->
      <div class="card recall">
        <div class="recall-head">
          <span class="eyebrow">recall · {memories.length} {memories.length === 1 ? 'memory' : 'memories'}</span>
          <input
            class="search"
            type="search"
            placeholder="Filter recall…"
            bind:value={query}
            aria-label="Filter memories by keyword"
          />
        </div>

        {#if !hasMemories}
          <p class="state-body">
            No memories yet — they accrue as sessions run and the auto-memory import lands.
          </p>
        {:else if filtered.length === 0}
          <p class="state-body">No memories match “{query}” — clear the filter.</p>
        {:else}
          <ul class="recall-list">
            {#each filtered as m (m.id)}
              <li class="recall-row" data-status={m.status}>
                <div class="recall-meta">
                  <span class="kind-tag" data-kind={m.kind}>{m.kind}</span>
                  <span class="scope mono">{m.scope}</span>
                  {#if m.tier === 0}<span class="tier0">tier-0</span>{/if}
                  {#if m.status !== 'active'}<span class="status-flag">{m.status}</span>{/if}
                  <span class="imp mono" title="importance">{m.importance.toFixed(1)}</span>
                </div>
                <p class="recall-body">{m.content}</p>
                <div class="recall-foot">
                  <span class="cite mono">{shortId(m.id)}</span>
                  {#if m.project}<span class="proj mono">{shortProject(m.project)}</span>{/if}
                  {#if m.tags}{#each m.tags as t (t)}<span class="tag mono">{t}</span>{/each}{/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <!-- Knowledge graph (KnowledgeGraph, §5) -->
      <div class="card graph">
        <span class="eyebrow">
          knowledge graph · {graph.nodes.length} nodes · {graph.edges.length} edges
        </span>

        {#if !hasGraph}
          <p class="state-body">
            No graph yet — entities and links appear once auto-memory is imported.
          </p>
        {:else}
          <ul class="node-list" aria-label="graph entities">
            {#each graph.nodes as n (n.id)}
              {@const isFocus = focusId === n.id}
              {@const isNeighbour = neighbours.has(n.id)}
              <li>
                <button
                  type="button"
                  class="node"
                  data-status={n.status}
                  data-focus={isFocus}
                  data-neighbour={isNeighbour}
                  data-dim={focusId !== null && !isFocus && !isNeighbour}
                  onclick={() => focus(n.id)}
                  aria-pressed={isFocus}
                >
                  <span class="node-type" data-type={n.type}>{n.type}</span>
                  <span class="node-label">{n.label}</span>
                </button>
              </li>
            {/each}
          </ul>

          {#if focusId}
            <div class="focus-panel" aria-live="polite">
              <span class="eyebrow">
                {focusedEdges.length} {focusedEdges.length === 1 ? 'link' : 'links'} from
                <span class="mono">{shortId(focusId)}</span>
              </span>
              {#if focusedEdges.length}
                <ul class="edge-list">
                  {#each focusedEdges as e (e.from + e.kind + e.to)}
                    <li class="edge">
                      <span class="edge-kind mono">{e.kind}</span>
                      <span class="edge-target mono">
                        {e.from === focusId ? shortId(e.to) : shortId(e.from)}
                      </span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="state-body">No links from this node.</p>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    width: 100%; /* 14.2a: fluid full-width — the shell gutter (--page-gutter) frames it */
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
  }
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    max-width: 72ch;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
  }
  .state {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .lens-toggle {
    display: inline-flex;
    gap: var(--space-1, 0.25rem);
    padding: 0.2rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    background: var(--color-surface-card);
    width: fit-content;
  }
  .lens-tab {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 6px);
    padding: 0.3rem 0.8rem;
    cursor: pointer;
    transition: color 0.14s ease, background 0.14s ease, border-color 0.14s ease;
  }
  .lens-tab:hover {
    color: var(--color-text);
  }
  .lens-tab:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 1px;
  }
  .lens-tab[data-active='true'] {
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border-color: var(--color-border);
  }
  .scene-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
    gap: var(--space-3, 0.75rem);
    align-items: start;
  }
  @media (max-width: 1024px) {
    .scene-grid {
      grid-template-columns: 1fr;
    }
  }
  .scene-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .scene-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .legend-key {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .legend-key li {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .key-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex: none;
  }
  /* Token-driven legend swatches — mirror the scene node-class colors (NO literals). */
  .key-dot[data-class='memory'] {
    background: var(--color-accent);
  }
  .key-dot[data-class='job'][data-status='active'] {
    background: var(--color-running);
  }
  .key-dot[data-class='job'][data-status='pending'] {
    background: var(--color-info);
  }
  .key-dot[data-class='job'][data-status='done'] {
    background: var(--color-success);
  }
  .key-dot[data-class='job'][data-status='failed'] {
    background: var(--color-warn);
  }
  .activity-card {
    position: sticky;
    top: var(--space-3, 0.75rem);
  }
  @media (prefers-reduced-motion: reduce) {
    .lens-tab {
      transition: none;
    }
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: var(--space-3, 0.75rem);
    align-items: start;
  }
  @media (max-width: 1024px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  .recall,
  .graph {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .recall-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .search {
    flex: 1;
    min-width: 12ch;
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text);
    padding: 0.3rem 0.55rem;
    font: var(--type-body-sm);
  }
  .search:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 1px;
  }
  .recall-list,
  .node-list,
  .edge-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .recall-list {
    max-height: 70vh;
    overflow-y: auto;
  }
  .recall-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--color-border-subtle, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .recall-row[data-status='archived'],
  .recall-row[data-status='superseded'] {
    opacity: 0.5;
  }
  .recall-meta,
  .recall-foot {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .recall-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .kind-tag,
  .node-type {
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .scope,
  .imp,
  .cite,
  .proj,
  .tag {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .tag {
    padding: 0.02rem 0.35rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
  }
  .tier0 {
    font-size: 0.62rem;
    text-transform: uppercase;
    color: var(--color-accent, #8ab0ab);
  }
  .status-flag {
    font-size: 0.62rem;
    text-transform: uppercase;
    color: var(--color-warn);
  }
  .imp {
    margin-left: auto;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    padding: 0.35rem 0.55rem;
    border: 1px solid var(--color-border-subtle, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    color: var(--color-text-2);
    cursor: pointer;
    transition: border-color 0.14s ease, opacity 0.14s ease;
  }
  .node:hover {
    border-color: var(--color-accent, #8ab0ab);
  }
  .node:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 1px;
  }
  .node[data-focus='true'] {
    border-color: var(--color-accent, #8ab0ab);
    color: var(--color-text);
  }
  .node[data-neighbour='true'] {
    border-color: var(--color-accent-muted, var(--color-accent, #8ab0ab));
  }
  .node[data-dim='true'] {
    opacity: 0.4;
  }
  .node[data-status='archived'],
  .node[data-status='superseded'] {
    opacity: 0.45;
  }
  .node-label {
    font: var(--type-body-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .node-list {
    max-height: 50vh;
    overflow-y: auto;
  }
  .focus-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-2, 0.5rem);
  }
  .edge {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .edge-kind {
    font-size: 0.66rem;
    color: var(--color-accent, #8ab0ab);
    min-width: 9ch;
  }
  .edge-target {
    font-size: 0.72rem;
    color: var(--color-text-2);
  }
</style>
