<script lang="ts">
  /**
   * LifecycleGraph — the LG-3 animated causal node-graph (LIFECYCLE-GRAPH-SPEC §LG-3).
   *
   * Renders the LG-2 read model as a layered DAG growing LEFT→RIGHT by causal depth:
   *   Continue → the agent/session nodes it spawned (task name · role/title · hire · LIVE
   *   tool-call count · active skills) → on finish a `reported-to` edge into the PM node →
   *   the PM node → the new task nodes it `proposed`. Live + animated.
   *
   * TRUTH vs ANIMATION (F-008): this component owns NO truth — `graph` is the LG-2 derived
   * read model (re-derived by the loader on every relevant row change via the ONE onDbChange
   * SSE). It NEVER invents a node/edge the truth doesn't carry. The only thing it adds is the
   * entrance animation timeline: a node id not seen before plays a one-shot "grow in" (the
   * chain animates forward as scene_events land). A stale render can never paint stale state.
   *
   * EXPLICIT vs INFERRED (F-008): an edge with inferred:false is drawn SOLID (a real link —
   * proposed_by / revision_of / a resolved parent_event_id); an inferred edge (the documented
   * timestamp heuristic — Continue→session / session→PM) is drawn DASHED + labelled "inferred"
   * in the text-equivalent, never presented as certain.
   *
   * RAILS: design-system TOKENS only (node color by kind + status — no literals); a11y — the
   * SVG is aria-hidden DECORATIVE and the SAME nodes are a keyboard-navigable, labelled list
   * (the honest text-equivalent read); transform/opacity-only entrance for 60fps; reduced-
   * motion → no transform, instant; bounded (the caller caps the node set — F-014). Runes only.
   */
  import { onMount, untrack } from 'svelte';
  import type { LifecycleGraph } from '$lib/server/observability';
  import { layoutGraph, nodeKindLabel, NODE_W, NODE_H } from './layout';

  interface Props {
    /** The LG-2 derived node/edge TRUTH. The component never fetches this. */
    graph: LifecycleGraph;
    /** Live connection state for the disconnected badge (honest — F-008). */
    connection?: 'live' | 'reconnecting' | 'offline' | 'unknown';
  }

  let { graph, connection = 'unknown' }: Props = $props();

  // ── Reduced motion (a11y) ────────────────────────────────────────────────────────────
  let reducedMotion = $state(false);

  // ── Layout (pure, deterministic) ───────────────────────────────────────────────────────
  const laid = $derived(layoutGraph(graph?.nodes, graph?.edges));
  const hasNodes = $derived(laid.nodes.length > 0);

  // ── Entrance-animation bookkeeping: which node ids have already played their grow-in ──────
  // A node id NEW to the truth (after the first render) plays ONE entrance; the initial set +
  // persisting nodes never re-animate (a live append grows only the newcomer forward — F-008:
  // the animation reflects real arrival, not a re-layout). `mounted` gates the first paint so
  // the initial graph appears settled, not all-at-once popping.
  let mounted = $state(false);
  let entered = $state<Set<string>>(new Set());
  // Track ids in a from-state (data-new=true); a rAF flips them so the CSS transition fires.
  let pending = $state<Set<string>>(new Set());
  $effect(() => {
    const ids = laid.nodes.map((n) => n.id);
    untrack(() => {
      if (!mounted) return; // the initial set is marked entered on mount (no pop)
      const newcomers = ids.filter((id) => !entered.has(id));
      if (newcomers.length === 0) return;
      // Mount the newcomer in its from-state, then flip to entered next frame → transition runs.
      pending = new Set([...pending, ...newcomers]);
      const next = new Set(entered);
      for (const id of newcomers) next.add(id);
      requestAnimationFrame(() => {
        entered = next;
        pending = new Set([...pending].filter((id) => !newcomers.includes(id)));
      });
    });
  });
  /** A node is in its entrance from-state only while pending the rAF flip (post-mount arrivals). */
  function isNew(id: string): boolean {
    return pending.has(id);
  }

  // ── Focus / keyboard nav (drives the text-equivalent + edge highlight) ───────────────────
  let focusId = $state<string | null>(null);
  const neighbours = $derived(
    focusId
      ? new Set(
          laid.edges
            .filter((e) => e.from === focusId || e.to === focusId)
            .map((e) => (e.from === focusId ? e.to : e.from))
        )
      : new Set<string>()
  );
  function focus(id: string): void {
    focusId = focusId === id ? null : id;
  }

  // ── Honest presentation helpers ──────────────────────────────────────────────────────────
  /** A short id tail (drop the `table:` prefix) for skills/role display — never a fabricated name. */
  function tail(id: string): string {
    const i = id.indexOf(':');
    return i >= 0 ? id.slice(i + 1) : id;
  }
  /** Active-skill chips, capped so a node box stays bounded; the rest collapse to "+N". */
  function skillChips(skills: string[] | undefined, cap = 3): { shown: string[]; more: number } {
    if (!skills || skills.length === 0) return { shown: [], more: 0 };
    const shown = skills.slice(0, cap).map(tail);
    return { shown, more: Math.max(0, skills.length - cap) };
  }
  /** Elapsed ms → a compact human label (e.g. "3m 12s", "1h 04m"); honest "—" when absent. */
  function elapsedLabel(ms: number | undefined): string {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  // The text-equivalent description of an edge (for screen readers + the legend).
  function edgeDesc(kind: string, inferred: boolean): string {
    const verb =
      kind === 'spawned'
        ? 'spawned'
        : kind === 'reported-to'
          ? 'reported to'
          : kind === 'proposed'
            ? 'proposed'
            : 'follow-up of';
    return inferred ? `${verb} (inferred)` : verb;
  }

  onMount(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const onMq = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', onMq);
    // The first render's nodes appear settled (no all-at-once pop) — mark them entered, then
    // open the gate so only LATER arrivals (live appends) animate in.
    entered = new Set(laid.nodes.map((n) => n.id));
    mounted = true;
    return () => mq.removeEventListener('change', onMq);
  });
</script>

<div class="lifecycle" data-reduced={reducedMotion}>
  {#if !hasNodes}
    <!-- Honest empty (F-008) — never a fabricated chain. -->
    <div class="empty" role="status">
      <span class="eyebrow">lifecycle</span>
      <p class="empty-body">
        No lifecycle activity yet. The graph grows as Continue spawns sessions, sessions finish
        and report to the PM, and the PM proposes new work.
      </p>
    </div>
  {:else}
    <!-- The animated DAG (decorative-augmenting). aria-hidden so AT users get the labelled
         text-equivalent below instead of unlabelled SVG. -->
    <div class="canvas-scroll">
      <svg
        class="canvas"
        width={laid.width}
        height={laid.height}
        viewBox="0 0 {laid.width} {laid.height}"
        aria-hidden="true"
      >
        <defs>
          <marker
            id="lg-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 Z" class="arrow-head" />
          </marker>
        </defs>

        <g class="edges">
          {#each laid.edges as e (e.from + '->' + e.to + ':' + e.kind)}
            <path
              class="edge"
              d={e.path}
              data-kind={e.kind}
              data-inferred={e.inferred}
              data-active={focusId !== null && (e.from === focusId || e.to === focusId)}
              marker-end="url(#lg-arrow)"
            />
          {/each}
        </g>

        <g class="nodes">
          {#each laid.nodes as n (n.id)}
            {@const chips = skillChips(n.skills)}
            <g
              class="node"
              data-kind={n.kind}
              data-status={n.status}
              data-new={isNew(n.id)}
              data-focus={focusId === n.id}
              data-neighbour={neighbours.has(n.id)}
              data-dim={focusId !== null && focusId !== n.id && !neighbours.has(n.id)}
              transform="translate({n.x - NODE_W / 2},{n.y - NODE_H / 2})"
            >
              <rect class="node-box" width={NODE_W} height={NODE_H} rx="10" />
              <text class="node-kind" x="12" y="18">{nodeKindLabel(n.kind)}</text>
              <text class="node-label" x="12" y="38">{n.label}</text>
              <text class="node-meta" x="12" y="56">
                {#if n.kind === 'session'}
                  {n.toolCount ?? 0} tools · {elapsedLabel(n.elapsed)}
                {:else}
                  {n.status}
                {/if}
              </text>
              {#if chips.shown.length}
                <text class="node-skills" x="12" y="72">
                  {chips.shown.join(' · ')}{chips.more ? ` +${chips.more}` : ''}
                </text>
              {/if}
            </g>
          {/each}
        </g>
      </svg>
    </div>

    <!-- Text-equivalent: the honest, non-decorative read of the SAME nodes + edges. Every node
         keyboard-reachable + labelled; the focused node's causal edges are spelled out. -->
    <div class="text-equiv">
      <h3 class="te-title" id="lg-te-title">
        Lifecycle nodes ({laid.nodes.length})
        {#if graph?.capped}<span class="te-flag">· showing most recent</span>{/if}
        {#if graph && !graph.complete}
          <span class="te-flag te-warn">· partial ({graph.failedSources.join(', ')} unavailable)</span>
        {/if}
      </h3>
      <ul class="te-list" aria-labelledby="lg-te-title">
        {#each laid.nodes as n (n.id)}
          {@const chips = skillChips(n.skills, 6)}
          {@const outEdges = laid.edges.filter((e) => e.from === n.id)}
          <li>
            <button
              type="button"
              class="te-node"
              data-kind={n.kind}
              data-status={n.status}
              data-focus={focusId === n.id}
              aria-pressed={focusId === n.id}
              onclick={() => focus(n.id)}
            >
              <span class="te-dot" data-kind={n.kind} data-status={n.status} aria-hidden="true"></span>
              <span class="te-body">
                <span class="te-head">
                  <span class="te-kind">{nodeKindLabel(n.kind)}</span>
                  <span class="te-label">{n.label}</span>
                </span>
                <span class="te-attrs">
                  <span class="te-status mono" data-status={n.status}>{n.status}</span>
                  {#if n.kind === 'session'}
                    <span class="te-attr">{n.toolCount ?? 0} tool calls</span>
                    <span class="te-attr">elapsed {elapsedLabel(n.elapsed)}</span>
                    {#if n.role}<span class="te-attr">role {tail(n.role)}</span>{/if}
                    {#if n.hire}<span class="te-attr">hire {tail(n.hire)}</span>{/if}
                  {/if}
                </span>
                {#if chips.shown.length}
                  <span class="te-skills">
                    skills:
                    {#each chips.shown as s (s)}<span class="te-chip mono">{s}</span>{/each}
                    {#if chips.more}<span class="te-chip mono">+{chips.more}</span>{/if}
                  </span>
                {/if}
                {#if outEdges.length}
                  <span class="te-edges">
                    {#each outEdges as e (e.to + ':' + e.kind)}
                      <span class="te-edge" data-inferred={e.inferred}>
                        {edgeDesc(e.kind, e.inferred)} →
                        {laid.nodes.find((m) => m.id === e.to)?.label ?? e.to}
                      </span>
                    {/each}
                  </span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Live connection badge (honest — never fakes 'live'; F-008/D-019). -->
  {#if connection !== 'live'}
    <p class="conn" data-conn={connection} role="status" aria-live="polite">
      {#if connection === 'reconnecting'}
        Live updates reconnecting — the graph will resume growing automatically.
      {:else if connection === 'offline'}
        Live updates offline — showing the last known graph.
      {:else}
        Connecting to the live stream…
      {/if}
    </p>
  {/if}
</div>

<style>
  .lifecycle {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    width: 100%;
  }

  /* ── Canvas (the animated DAG) ──────────────────────────────────────────────────────── */
  .canvas-scroll {
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    background:
      radial-gradient(circle at 12% 28%, var(--color-surface-overlay), var(--color-surface) 72%);
    max-height: 60vh;
  }
  .canvas {
    display: block;
  }

  .arrow-head {
    fill: var(--color-border-strong, var(--color-border));
  }

  /* Edges — solid for explicit (real link), dashed for inferred (heuristic). */
  .edge {
    fill: none;
    stroke: var(--color-border-strong, var(--color-border));
    stroke-width: 1.5;
    opacity: 0.7;
    transition:
      opacity var(--motion-fast, 0.16s) var(--ease-out, ease),
      stroke var(--motion-fast, 0.16s) var(--ease-out, ease);
  }
  .edge[data-inferred='true'] {
    stroke-dasharray: 5 4;
    opacity: 0.55;
  }
  .edge[data-active='true'] {
    stroke: var(--color-accent);
    opacity: 1;
  }

  /* Nodes — color FAMILY by kind, accent by status (TOKENS only). */
  .node {
    transform-box: view-box;
  }
  .node-box {
    fill: var(--color-surface-card, var(--color-surface-raised));
    stroke: var(--color-border);
    stroke-width: 1;
  }
  .node[data-kind='continue'] .node-box {
    stroke: var(--color-accent);
    stroke-width: 1.5;
  }
  .node[data-kind='pm'] .node-box {
    stroke: var(--color-info);
    stroke-width: 1.5;
  }
  .node[data-kind='session'][data-status='running'] .node-box {
    stroke: var(--color-running);
  }
  .node[data-kind='session'][data-status='failed'] .node-box,
  .node[data-kind='session'][data-status='error'] .node-box {
    stroke: var(--color-error);
  }
  .node[data-kind='session'][data-status='done'] .node-box {
    stroke: var(--color-success);
  }
  .node[data-focus='true'] .node-box {
    stroke: var(--color-accent);
    stroke-width: 2.5;
  }
  .node[data-neighbour='true'] .node-box {
    stroke: var(--color-accent-muted);
    stroke-width: 2;
  }
  .node[data-dim='true'] {
    opacity: 0.4;
  }

  .node-kind {
    fill: var(--color-text-muted);
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .node-label {
    fill: var(--color-text);
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 13px;
    font-weight: 600;
  }
  .node-meta {
    fill: var(--color-text-2);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
  }
  .node-skills {
    fill: var(--color-text-faint, var(--color-text-muted));
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
  }
  /* SVG text isn't auto-clipped — labels are bounded short strings (screened, capped) so they
     fit the box; no overflow rule needed. */

  /* Entrance animation — transform + opacity only (60fps). Newcomers grow in from the left. */
  .node[data-new='true'] {
    opacity: 0;
    transform: translateX(-14px) scale(0.96);
  }
  .node {
    transition:
      opacity var(--motion-normal, 0.28s) var(--ease-out, ease),
      transform var(--motion-normal, 0.28s) var(--ease-out, ease);
  }

  /* ── Honest empty ──────────────────────────────────────────────────────────────────── */
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 12rem;
    padding: var(--space-4, 1.25rem);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md, 10px);
    background: var(--color-surface);
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .empty-body {
    color: var(--color-text-2);
    max-width: 52ch;
    font-size: var(--text-sm, 0.875rem);
  }

  /* ── Text-equivalent (the a11y read) ──────────────────────────────────────────────────── */
  .text-equiv {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .te-title {
    margin: 0;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text-2);
    font-weight: 600;
  }
  .te-flag {
    color: var(--color-text-muted);
    font-weight: 400;
  }
  .te-flag.te-warn {
    color: var(--color-warn);
  }
  .te-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    max-height: 22rem;
    overflow-y: auto;
  }
  .te-node {
    display: flex;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--color-border-faint, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    color: var(--color-text-2);
    cursor: pointer;
    transition: border-color var(--motion-fast, 0.14s) var(--ease-out, ease);
  }
  .te-node:hover {
    border-color: var(--color-accent);
  }
  .te-node:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 1px;
  }
  .te-node[data-focus='true'] {
    border-color: var(--color-accent);
    background: var(--color-surface-selected, var(--color-surface-overlay));
  }
  .te-dot {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 3px;
    flex: none;
    margin-top: 0.2rem;
    background: var(--color-text-muted);
  }
  .te-dot[data-kind='continue'] {
    background: var(--color-accent);
  }
  .te-dot[data-kind='pm'] {
    background: var(--color-info);
  }
  .te-dot[data-kind='session'][data-status='running'] {
    background: var(--color-running);
  }
  .te-dot[data-kind='session'][data-status='done'] {
    background: var(--color-success);
  }
  .te-dot[data-kind='session'][data-status='failed'],
  .te-dot[data-kind='session'][data-status='error'] {
    background: var(--color-error);
  }
  .te-dot[data-kind='task'] {
    background: var(--color-neutral, var(--color-text-muted));
  }
  .te-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .te-head {
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .te-kind {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  .te-label {
    color: var(--color-text);
    font-weight: 600;
    font-size: var(--text-sm, 0.875rem);
  }
  .te-attrs {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
    color: var(--color-text-2);
  }
  .te-status {
    color: var(--color-text-muted);
  }
  .te-status[data-status='running'] {
    color: var(--color-running);
  }
  .te-status[data-status='done'] {
    color: var(--color-success);
  }
  .te-status[data-status='failed'],
  .te-status[data-status='error'] {
    color: var(--color-error);
  }
  .te-skills {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
    align-items: center;
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .te-chip {
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-pill, 999px);
    background: var(--color-bg-inset, var(--color-surface));
    border: 1px solid var(--color-border-faint, var(--color-border));
    font-size: 0.66rem;
  }
  .te-edges {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    font-size: 0.7rem;
    color: var(--color-text-2);
  }
  .te-edge[data-inferred='true'] {
    color: var(--color-text-muted);
    font-style: italic;
  }

  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  /* ── Connection badge ─────────────────────────────────────────────────────────────────── */
  .conn {
    margin: 0;
    font-size: 0.78rem;
    padding: 0.35rem 0.6rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-warn-bg, var(--color-surface));
    color: var(--color-text-2);
    border: 1px solid var(--color-border);
  }
  .conn[data-conn='offline'] {
    background: var(--color-error-bg, var(--color-surface));
  }

  /* Reduced motion: no transform/transition entrance (a11y). */
  .lifecycle[data-reduced='true'] .node,
  .lifecycle[data-reduced='true'] .node[data-new='true'] {
    transition: none;
    transform-origin: center;
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .node,
    .edge,
    .te-node {
      transition: none;
    }
    .node[data-new='true'] {
      opacity: 1;
      transform: none;
    }
  }
</style>
