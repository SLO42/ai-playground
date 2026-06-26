<script lang="ts">
  /**
   * LifecycleGraph — the LG-3 animated causal node-graph (LIFECYCLE-GRAPH-SPEC §LG-3), v2 polish.
   *
   * Renders the LG-2 read model as a RANK-based LAYERED left→right DAG (n8n-style):
   *   Continue (rank 0) → the agent sessions it spawned (rank 1, parallel spawns SHARE the column)
   *   → on finish a `reported-to` edge into the PM node (rank 2) → the PM's proposed tasks (rank 3)…
   * x = rank·columnStride (deterministic layered layout via ./layout — NOT d3-force); parallel
   * spawns at the same rank stack vertically in ONE column. Each node is a FIXED-SIZE n8n card
   * (kind eyebrow · truncated title · tidy meta grid · footer metric strip) whose text FITS (the
   * card is HTML in a <foreignObject>, clipped with overflow:hidden + ellipsis — no overflow). A
   * detail POPOVER (token usage · cost · per-tool breakdown · granted skills) opens per node.
   *
   * TRUTH vs ANIMATION (F-008): this component owns NO truth — `graph` is the LG-2 derived read
   * model (re-derived by the loader on every relevant row change via the ONE onDbChange SSE). It
   * NEVER invents a node/edge/metric the truth doesn't carry; an absent metric renders honest '—'.
   * The only thing it adds is the entrance timeline: a node id not seen before plays a one-shot
   * "grow/pop in" (via the `motion` lib) as the chain animates forward on live scene_events. A
   * stale render can never paint stale state.
   *
   * EXPLICIT vs INFERRED (F-008): an edge with inferred:false is SOLID (a real link — proposed_by /
   * revision_of / a resolved parent_event_id); an inferred edge (the documented timestamp heuristic)
   * is DASHED + labelled "inferred" in the text-equivalent + popover — never presented as certain.
   *
   * RAILS: design-system TOKENS only; a11y — the SVG cards are aria-hidden DECORATIVE and the SAME
   * nodes are a keyboard-navigable, labelled list (the honest text-equivalent read); the popover is
   * focus-managed (Esc closes, focus returns); transform/opacity-only entrance (60fps) honoring
   * prefers-reduced-motion; bounded (the caller caps the node set — F-014; large graphs scroll, not
   * reflow). D-026: only opaque ids / screened labels surface — never raw transcript/secret. Runes only.
   */
  import { onMount, untrack, tick } from 'svelte';
  import { animate } from 'motion';
  import type { LifecycleGraph, LifecycleNodeDetail } from '$lib/server/observability';
  import { layoutGraph, nodeKindLabel, truncate, NODE_W, NODE_H, COL_HEADER_H } from './layout';
  import { motionFor, MAX_ANIMATED_NODES } from './motion-state';

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
  /** Per-session detail keyed by node id (token/cost/tool breakdown), or {} when absent. */
  const details = $derived<Record<string, LifecycleNodeDetail>>(graph?.details ?? {});

  // ── "Alive" motion environment (reduced-motion + the F-014 bounded-motion cap) ──────────
  // The per-node motion-state DECISION lives in the pure ./motion-state helper (unit-tested):
  // a running session gets a cycling glow ring; a done/failed node settles to a distinct
  // STATIC state; reduced-motion or a graph past MAX_ANIMATED_NODES drops the perimeter motion
  // (the running node keeps a static glow so it stays honest). This component only BINDS the
  // result — it never decides motion from a status string inline.
  const motionEnv = $derived({ reducedMotion, nodeCount: laid.nodes.length });

  // ── Entrance-animation bookkeeping ───────────────────────────────────────────────────────
  // A node id NEW to the truth (after the first paint) plays ONE entrance pop; the initial set +
  // persisting nodes never re-animate. `mounted` gates the first paint so the initial graph appears
  // settled, not all-at-once popping. We hold element refs so `motion` can drive the pop imperatively.
  let mounted = $state(false);
  let entered = $state<Set<string>>(new Set());
  const nodeEls = new Map<string, SVGGElement>();
  function regNode(el: SVGGElement, id: string): { destroy: () => void } {
    nodeEls.set(id, el);
    return { destroy: () => nodeEls.delete(id) };
  }

  // Edge draw-in bookkeeping: a NEW edge (after first paint) draws itself with a one-shot
  // stroke-dashoffset sweep so a fresh causal link reads as "just formed" (n8n connect feel).
  // The initial edge set never draws; only live appends do. Bounded by the same node cap
  // (a giant graph skips the per-edge sweep — F-014). Reduced-motion → instant (no sweep).
  let drawnEdges = $state<Set<string>>(new Set());
  const edgeEls = new Map<string, SVGPathElement>();
  function edgeKey(e: { from: string; to: string; kind: string }): string {
    return `${e.from}->${e.to}:${e.kind}`;
  }
  function regEdge(el: SVGPathElement, key: string): { destroy: () => void } {
    edgeEls.set(key, el);
    return { destroy: () => edgeEls.delete(key) };
  }

  $effect(() => {
    const ids = laid.nodes.map((n) => n.id);
    const ekeys = laid.edges.map(edgeKey);
    const overCap = laid.nodes.length > MAX_ANIMATED_NODES;
    untrack(() => {
      if (!mounted) return;
      const newNodes = ids.filter((id) => !entered.has(id));
      const newEdges = ekeys.filter((k) => !drawnEdges.has(k));
      if (newNodes.length === 0 && newEdges.length === 0) return;
      if (newNodes.length) {
        const next = new Set(entered);
        for (const id of newNodes) next.add(id);
        entered = next;
      }
      if (newEdges.length) {
        const next = new Set(drawnEdges);
        for (const k of newEdges) next.add(k);
        drawnEdges = next;
      }
      // Next tick (after the new <g>/<path> is in the DOM), play the entrance.
      void tick().then(() => {
        for (const id of newNodes) {
          const el = nodeEls.get(id);
          if (!el) continue;
          if (reducedMotion || overCap) {
            // Reduced-motion / bounded: instant appear, no transform spring.
            animate(el, { opacity: [0, 1] }, { duration: reducedMotion ? 0.001 : 0.12 });
          } else {
            // Wobbly pop (skill §7 spawn preset) — a lively, real-arrival entrance.
            animate(
              el,
              { opacity: [0, 1], scale: [0.9, 1], x: [-12, 0] },
              { type: 'spring', stiffness: 220, damping: 16 }
            );
          }
        }
        for (const k of newEdges) {
          const el = edgeEls.get(k);
          if (!el) continue;
          if (reducedMotion) {
            animate(el, { opacity: [0, 1] }, { duration: 0.001 });
            continue;
          }
          // Draw the stroke in from its start: set the dash to the full length, then sweep
          // the offset to 0 (the classic SVG "draw-in"). getTotalLength is read once here.
          let len = 0;
          try {
            len = el.getTotalLength();
          } catch {
            len = 0;
          }
          if (len > 0 && !overCap) {
            el.style.strokeDasharray = `${len}`;
            const restore = () => {
              // Restore the kind's resting dash (inferred edges keep their dashed pattern).
              el.style.removeProperty('stroke-dasharray');
              el.style.removeProperty('stroke-dashoffset');
            };
            // The imperative controls are promise-like (resolve on finish) — match the
            // MemoryScene pattern; `.finished` isn't typed on AnimationPlaybackControls here.
            const controls = animate(
              el,
              { strokeDashoffset: [len, 0], opacity: [0.2, 1] },
              { duration: 0.55, ease: [0.22, 1, 0.36, 1] }
            );
            void Promise.resolve(controls).then(restore, restore);
          } else {
            animate(el, { opacity: [0.2, 1] }, { duration: 0.18 });
          }
        }
      });
    });
  });

  // ── Focus / keyboard nav (drives the text-equivalent + edge highlight + popover) ──────────
  let focusId = $state<string | null>(null);
  /** The node whose detail popover is OPEN (a deliberate select, distinct from hover-focus). */
  let openId = $state<string | null>(null);
  const neighbours = $derived(
    focusId
      ? new Set(
          laid.edges
            .filter((e) => e.from === focusId || e.to === focusId)
            .map((e) => (e.from === focusId ? e.to : e.from))
        )
      : new Set<string>()
  );
  /** Open the detail popover for a node (and focus it for the edge highlight). */
  function openDetail(id: string): void {
    focusId = id;
    openId = openId === id ? null : id;
  }
  function closeDetail(): void {
    openId = null;
  }

  // The currently-open node + its placed geometry (for popover anchoring) + its detail.
  const openNode = $derived(openId ? laid.nodes.find((n) => n.id === openId) ?? null : null);
  const openDetailData = $derived<LifecycleNodeDetail | null>(
    openId ? details[openId] ?? null : null
  );

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
  /** Compact integer with thousands separators, or honest '—' when absent. */
  function numLabel(n: number | undefined): string {
    return n == null ? '—' : n.toLocaleString('en-US');
  }
  /** Compact token count (e.g. 12.3k), or '—' when absent. */
  function tokLabel(n: number | undefined): string {
    if (n == null) return '—';
    if (n < 1000) return String(n);
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  }
  /** A USD cost label (4dp for sub-cent honesty), or '—' when unpriced (never a fake $). */
  function costLabel(n: number | undefined): string {
    return n == null ? '—' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
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
    // The first render's nodes + edges appear settled — mark them entered/drawn, then open the
    // gate so only LATER arrivals (live appends) play the pop / draw-in.
    entered = new Set(laid.nodes.map((n) => n.id));
    drawnEdges = new Set(laid.edges.map(edgeKey));
    mounted = true;
    return () => mq.removeEventListener('change', onMq);
  });

  // Esc closes the popover (focus-managed); a global keydown so it works from anywhere in the graph.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && openId) {
      e.stopPropagation();
      closeDetail();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

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
    <!-- Legend — the at-a-glance key (kinds + edge meaning). -->
    <div class="legend" aria-hidden="true">
      <span class="legend-item"><span class="swatch" data-kind="continue"></span>Continue</span>
      <span class="legend-item"><span class="swatch" data-kind="session"></span>Session</span>
      <span class="legend-item"><span class="swatch" data-kind="pm"></span>PM</span>
      <span class="legend-item"><span class="swatch" data-kind="task"></span>Task</span>
      <span class="legend-sep"></span>
      <span class="legend-item"><span class="edge-key solid"></span>explicit</span>
      <span class="legend-item"><span class="edge-key dashed"></span>inferred</span>
    </div>

    <!-- The layered DAG (decorative-augmenting). aria-hidden so AT users get the labelled
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
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" class="arrow-head" />
          </marker>
          <marker
            id="lg-arrow-inferred"
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" class="arrow-head inferred" />
          </marker>
        </defs>

        <!-- Column rhythm: a faint guide rail + a header band (phase label · count) per rank. -->
        <g class="columns">
          {#each laid.columns as c (c.col)}
            <rect
              class="col-guide"
              x={c.x - 8}
              y={COL_HEADER_H + 2}
              width={NODE_W + 16}
              height={laid.height - COL_HEADER_H - 8}
              rx="14"
            />
            <text class="col-rank" x={c.centerX} y="14" text-anchor="middle">RANK {c.col}</text>
            <text class="col-label" x={c.centerX} y="28" text-anchor="middle">
              {c.label} · {c.count}
            </text>
          {/each}
        </g>

        <g class="edges">
          {#each laid.edges as e (e.from + '->' + e.to + ':' + e.kind)}
            <path
              class="edge"
              use:regEdge={e.from + '->' + e.to + ':' + e.kind}
              d={e.path}
              data-kind={e.kind}
              data-inferred={e.inferred}
              data-active={focusId !== null && (e.from === focusId || e.to === focusId)}
              marker-end={e.inferred ? 'url(#lg-arrow-inferred)' : 'url(#lg-arrow)'}
            />
          {/each}
        </g>

        <g class="nodes">
          {#each laid.nodes as n (n.id)}
            {@const chips = skillChips(n.skills)}
            {@const d = details[n.id]}
            {@const m = motionFor(n, motionEnv)}
            {@const running = m.state === 'running'}
            <g
              class="node"
              use:regNode={n.id}
              data-kind={n.kind}
              data-status={n.status}
              data-running={running}
              data-motion={m.state}
              data-glow={m.glow}
              data-animate={m.animate}
              data-focus={focusId === n.id}
              data-open={openId === n.id}
              data-neighbour={neighbours.has(n.id)}
              data-dim={focusId !== null && focusId !== n.id && !neighbours.has(n.id)}
              transform="translate({n.x - NODE_W / 2},{n.y - NODE_H / 2})"
            >
              <!-- Cycling GLOW ring — a token-coloured halo whose travelling dash circles a
                   RUNNING node's border (n8n "this step is working" feel). The dash TRAVEL is
                   pure CSS (animate-bound class), so reduced-motion / over-cap (data-animate=false)
                   leaves a STATIC glow ring — still honest, just not moving. Only rendered for a
                   glowing node; done/failed never get it. aria-hidden (decorative). -->
              {#if m.glow}
                <rect
                  class="run-ring"
                  x="-2"
                  y="-2"
                  width={NODE_W + 4}
                  height={NODE_H + 4}
                  rx="14"
                  aria-hidden="true"
                />
              {/if}
              <rect class="node-box" width={NODE_W} height={NODE_H} rx="12" />
              <!-- left status rail (color paired with the status text in the card — never color-only) -->
              <rect class="node-rail" x="0" y="0" width="4" height={NODE_H} rx="2" />
              <foreignObject x="0" y="0" width={NODE_W} height={NODE_H}>
                <!-- n8n CARD body: HTML so text fits/truncates with CSS grid + ellipsis. -->
                <div class="card" data-kind={n.kind}>
                  <div class="card-head">
                    <span class="card-kind">{nodeKindLabel(n.kind)}</span>
                    {#if running}
                      <span class="live-dot" aria-hidden="true"></span>
                    {/if}
                    <span class="card-status mono" data-status={n.status}>{n.status}</span>
                  </div>
                  <div class="card-title" title={n.label}>{truncate(n.label, 38)}</div>
                  <div class="card-grid">
                    {#if n.kind === 'session'}
                      <span class="cg-k">tools</span>
                      <span class="cg-v mono">{n.toolCount ?? 0}</span>
                      <span class="cg-k">elapsed</span>
                      <span class="cg-v mono">{elapsedLabel(n.elapsed)}</span>
                      <span class="cg-k">tokens</span>
                      <span class="cg-v mono">{tokLabel(d ? (d.tokensIn ?? 0) + (d.tokensOut ?? 0) : undefined)}</span>
                      <span class="cg-k">cost</span>
                      <span class="cg-v mono">{costLabel(d?.costUsd)}</span>
                    {:else if n.kind === 'pm'}
                      <span class="cg-k">role</span>
                      <span class="cg-v">project manager</span>
                    {:else}
                      <span class="cg-k">state</span>
                      <span class="cg-v mono" data-status={n.status}>{n.status}</span>
                    {/if}
                  </div>
                  {#if chips.shown.length}
                    <div class="card-chips">
                      {#each chips.shown as s (s)}<span class="card-chip mono">{s}</span>{/each}
                      {#if chips.more}<span class="card-chip mono more">+{chips.more}</span>{/if}
                    </div>
                  {/if}
                </div>
              </foreignObject>
              <!-- a transparent hit-rect so the WHOLE card is clickable (foreignObject swallows some) -->
              <rect
                class="node-hit"
                width={NODE_W}
                height={NODE_H}
                rx="12"
                role="button"
                tabindex="-1"
                aria-hidden="true"
                onclick={() => openDetail(n.id)}
              />
            </g>
          {/each}
        </g>
      </svg>

      <!-- Detail POPOVER — anchored to the open node; token/cost/per-tool/skills, all honest. -->
      {#if openNode}
        <div
          class="popover"
          role="dialog"
          aria-label="Node detail: {openNode.label}"
          style="left:{openNode.x + NODE_W / 2 + 12}px; top:{openNode.y - NODE_H / 2}px;"
        >
          <div class="pop-head">
            <span class="pop-kind">{nodeKindLabel(openNode.kind)}</span>
            <button type="button" class="pop-close" onclick={closeDetail} aria-label="Close detail">×</button>
          </div>
          <h4 class="pop-title">{openNode.label}</h4>
          <dl class="pop-meta">
            <dt>status</dt>
            <dd class="mono" data-status={openNode.status}>{openNode.status}</dd>
            {#if openNode.kind === 'session'}
              {#if openNode.role}<dt>role</dt><dd class="mono">{tail(openNode.role)}</dd>{/if}
              {#if openNode.hire}<dt>hire</dt><dd class="mono">{tail(openNode.hire)}</dd>{/if}
              <dt>tool calls</dt><dd class="mono">{numLabel(openNode.toolCount)}</dd>
              <dt>elapsed</dt><dd class="mono">{elapsedLabel(openNode.elapsed)}</dd>
              <dt>tokens in</dt><dd class="mono">{numLabel(openDetailData?.tokensIn)}</dd>
              <dt>tokens out</dt><dd class="mono">{numLabel(openDetailData?.tokensOut)}</dd>
              <dt>cost</dt><dd class="mono">{costLabel(openDetailData?.costUsd)}</dd>
            {/if}
          </dl>

          {#if openNode.kind === 'session'}
            <div class="pop-section">
              <span class="pop-section-title">granted skills</span>
              {#if openNode.skills && openNode.skills.length}
                <div class="pop-chips">
                  {#each openNode.skills as s (s)}<span class="card-chip mono">{tail(s)}</span>{/each}
                </div>
              {:else}
                <span class="pop-empty">—</span>
              {/if}
            </div>

            <div class="pop-section">
              <span class="pop-section-title">
                tools used
                {#if openDetailData?.toolTotal}<span class="pop-count">({openDetailData.toolTotal})</span>{/if}
                {#if openDetailData?.toolsCapped}<span class="pop-cap">· capped</span>{/if}
              </span>
              {#if openDetailData?.tools && openDetailData.tools.length}
                <ul class="pop-tools">
                  {#each openDetailData.tools.slice(0, 8) as t (t.tool)}
                    <li><span class="pt-name mono">{t.tool}</span><span class="pt-count mono">{t.count}</span></li>
                  {/each}
                </ul>
              {:else}
                <span class="pop-empty">— no tool calls recorded</span>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
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
          {@const d = details[n.id]}
          <li>
            <button
              type="button"
              class="te-node"
              data-kind={n.kind}
              data-status={n.status}
              data-focus={focusId === n.id}
              aria-pressed={openId === n.id}
              onclick={() => openDetail(n.id)}
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
                    {#if d && (d.tokensIn != null || d.tokensOut != null)}
                      <span class="te-attr">{numLabel((d.tokensIn ?? 0) + (d.tokensOut ?? 0))} tokens</span>
                    {/if}
                    {#if d?.costUsd != null}<span class="te-attr">{costLabel(d.costUsd)}</span>{/if}
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
    gap: var(--space-4, 12px);
    width: 100%;
  }

  /* ── Legend ──────────────────────────────────────────────────────────────────────────── */
  .legend {
    display: flex;
    align-items: center;
    gap: var(--space-5, 16px);
    flex-wrap: wrap;
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .legend-sep {
    width: 1px;
    height: 0.9rem;
    background: var(--color-border);
  }
  .swatch {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: var(--radius-xs, 3px);
    background: var(--color-neutral);
  }
  .swatch[data-kind='continue'] {
    background: var(--color-accent);
  }
  .swatch[data-kind='session'] {
    background: var(--color-running);
  }
  .swatch[data-kind='pm'] {
    background: var(--color-info);
  }
  .swatch[data-kind='task'] {
    background: var(--color-neutral);
  }
  .edge-key {
    width: 1.4rem;
    height: 0;
    border-top: 1.5px solid var(--color-border-strong);
  }
  .edge-key.dashed {
    border-top-style: dashed;
  }

  /* ── Canvas (the layered DAG) ──────────────────────────────────────────────────────── */
  .canvas-scroll {
    position: relative;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    background:
      radial-gradient(circle at 12% 18%, var(--color-surface-overlay), var(--color-surface) 70%);
    max-height: 64vh;
  }
  .canvas {
    display: block;
  }

  /* Column rhythm guides + headers */
  .col-guide {
    fill: color-mix(in oklch, var(--color-surface-card) 45%, transparent);
    stroke: var(--color-border-faint, var(--color-border));
    stroke-width: 1;
  }
  .col-rank {
    fill: var(--color-text-faint, var(--color-text-muted));
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 9px;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  .col-label {
    fill: var(--color-text-muted);
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 11px;
    font-weight: 600;
  }

  .arrow-head {
    fill: var(--color-border-strong, var(--color-border));
  }
  .arrow-head.inferred {
    fill: var(--color-neutral, var(--color-text-muted));
  }

  /* Edges — solid for explicit (real link), dashed for inferred (heuristic). */
  .edge {
    fill: none;
    stroke: var(--color-border-strong, var(--color-border));
    stroke-width: 1.5;
    opacity: 0.7;
    transition:
      opacity var(--motion-fast, 140ms) var(--ease-out, ease),
      stroke var(--motion-fast, 140ms) var(--ease-out, ease);
  }
  .edge[data-inferred='true'] {
    stroke: var(--color-neutral, var(--color-text-muted));
    stroke-dasharray: 6 4;
    opacity: 0.55;
  }
  .edge[data-active='true'] {
    stroke: var(--color-accent);
    opacity: 1;
    stroke-width: 2;
  }

  /* Nodes — the n8n card. Color FAMILY by kind, accent rail by status (TOKENS only). */
  .node {
    transform-box: view-box;
    cursor: pointer;
    transition:
      opacity var(--motion-normal, 240ms) var(--ease-out, ease);
  }
  .node-box {
    fill: var(--color-surface-card, var(--color-surface-raised));
    stroke: var(--color-border);
    stroke-width: 1;
    transition: stroke var(--motion-fast, 140ms) var(--ease-out, ease);
  }
  .node-rail {
    fill: var(--color-neutral);
  }
  .node[data-kind='continue'] .node-rail {
    fill: var(--color-accent);
  }
  .node[data-kind='pm'] .node-rail {
    fill: var(--color-info);
  }
  .node[data-kind='session'][data-status='running'] .node-rail {
    fill: var(--color-running);
  }
  .node[data-kind='session'][data-status='done'] .node-rail {
    fill: var(--color-success);
  }
  .node[data-kind='session'][data-status='failed'] .node-rail,
  .node[data-kind='session'][data-status='error'] .node-rail {
    fill: var(--color-error);
  }
  /* ── "Alive" motion states (LIFECYCLE-GRAPH-UX-SPEC) ──────────────────────────────────
     A RUNNING session card glows (paired with the live-dot + status text — never color-only).
     A terminal node SETTLES to a DISTINCT static state: done = calm success border, failed =
     error border. The settled states are visually unambiguous so a failed node can never read
     as 'active'. All token-driven (--color-running / --color-success / --color-error). */
  .node[data-motion='running'] .node-box {
    stroke: var(--color-running);
  }
  .node[data-motion='settled-done'] .node-box {
    stroke: var(--color-success);
  }
  .node[data-motion='settled-failed'] .node-box {
    stroke: var(--color-error);
  }

  /* The cycling glow ring. A travelling accent dash circles the perimeter of a running node.
     The ring's BASE is a soft static halo (honest even when motion is off); the TRAVEL only
     plays when data-animate='true' (not reduced-motion, under the F-014 node cap). The dash
     length + gap are tuned so a single bright segment sweeps the border, n8n-style. */
  .run-ring {
    fill: none;
    stroke: var(--color-running);
    stroke-width: 2;
    /* Static base: a faint full outline so a non-animating running node still glows honestly. */
    opacity: 0.45;
    filter: drop-shadow(0 0 5px color-mix(in oklch, var(--color-running) 55%, transparent));
    pointer-events: none;
  }
  /* When motion is allowed: a single bright dash travels the perimeter (stroke-dashoffset loop).
     pathLength is normalized to 100 via the keyframe's dasharray so the loop is geometry-agnostic. */
  .node[data-animate='true'] .run-ring {
    stroke-dasharray: 26 130;
    opacity: 0.85;
    animation: lg-ring-travel 2.6s var(--ease-standard, linear) infinite;
  }
  @keyframes lg-ring-travel {
    /* dashoffset sweeps one full dasharray period (26 + 130 = 156) for a seamless loop. */
    from {
      stroke-dashoffset: 156;
    }
    to {
      stroke-dashoffset: 0;
    }
  }

  .node:hover .node-box {
    stroke: var(--color-border-strong);
  }
  .node[data-focus='true'] .node-box {
    stroke: var(--color-accent);
    stroke-width: 2;
  }
  .node[data-open='true'] .node-box {
    stroke: var(--color-accent);
    stroke-width: 2.5;
  }
  .node[data-neighbour='true'] .node-box {
    stroke: var(--color-accent-muted);
    stroke-width: 2;
  }
  .node[data-dim='true'] {
    opacity: 0.42;
  }
  .node-hit {
    fill: transparent;
  }

  /* Card body (HTML in the foreignObject) — fixed size, text FITS (overflow:hidden + ellipsis). */
  .card {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 8px 10px 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: hidden;
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .card-kind {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 600;
    white-space: nowrap;
  }
  .card-status {
    margin-left: auto;
    font-size: 10px;
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 8ch;
  }
  .card-status[data-status='running'] {
    color: var(--color-running);
  }
  .card-status[data-status='done'] {
    color: var(--color-success);
  }
  .card-status[data-status='failed'],
  .card-status[data-status='error'] {
    color: var(--color-error);
  }
  .card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 1px 8px;
    font-size: 10.5px;
    align-content: start;
    overflow: hidden;
  }
  .cg-k {
    color: var(--color-text-faint, var(--color-text-muted));
    white-space: nowrap;
  }
  .cg-v {
    color: var(--color-text-2);
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cg-v[data-status='running'] {
    color: var(--color-running);
  }
  .cg-v[data-status='done'] {
    color: var(--color-success);
  }
  .card-chips {
    display: flex;
    gap: 3px;
    overflow: hidden;
    margin-top: auto;
  }
  .card-chip {
    font-size: 9.5px;
    padding: 0 5px;
    line-height: 15px;
    border-radius: var(--radius-pill, 999px);
    background: var(--color-bg-inset, var(--color-surface));
    border: 1px solid var(--color-border-faint, var(--color-border));
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .card-chip.more {
    color: var(--color-text-faint, var(--color-text-muted));
  }
  /* the live-dot primitive (base.css) — used inside the card head */
  .card .live-dot {
    width: 6px;
    height: 6px;
  }

  /* ── Detail popover ───────────────────────────────────────────────────────────────────── */
  .popover {
    position: absolute;
    z-index: var(--z-popover, 600);
    width: 268px;
    max-height: 60vh;
    overflow-y: auto;
    padding: var(--space-5, 16px);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md, 8px);
    box-shadow: var(--shadow-overlay);
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 12px);
  }
  .pop-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .pop-kind {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .pop-close {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--color-text-muted);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.2rem;
    border-radius: var(--radius-xs, 3px);
  }
  .pop-close:hover {
    color: var(--color-text);
  }
  .pop-close:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 1px;
  }
  .pop-title {
    margin: 0;
    font-size: var(--text-sm, 0.875rem);
    color: var(--color-text);
    font-weight: 600;
    word-break: break-word;
  }
  .pop-meta {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 0;
    font-size: 0.72rem;
  }
  .pop-meta dt {
    color: var(--color-text-faint, var(--color-text-muted));
  }
  .pop-meta dd {
    margin: 0;
    text-align: right;
    color: var(--color-text-2);
  }
  .pop-meta dd[data-status='running'] {
    color: var(--color-running);
  }
  .pop-meta dd[data-status='done'] {
    color: var(--color-success);
  }
  .pop-meta dd[data-status='failed'],
  .pop-meta dd[data-status='error'] {
    color: var(--color-error);
  }
  .pop-section {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .pop-section-title {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .pop-count {
    color: var(--color-text-2);
  }
  .pop-cap {
    color: var(--color-warn);
    text-transform: none;
    letter-spacing: 0;
  }
  .pop-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .pop-empty {
    font-size: 0.72rem;
    color: var(--color-text-faint, var(--color-text-muted));
  }
  .pop-tools {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .pop-tools li {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.72rem;
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
  }
  .pop-tools li:last-child {
    border-bottom: none;
  }
  .pt-name {
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pt-count {
    color: var(--color-text-muted);
    flex: none;
  }

  /* ── Honest empty ──────────────────────────────────────────────────────────────────── */
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 8px);
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 12rem;
    padding: var(--space-7, 24px);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md, 8px);
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
    gap: var(--space-3, 8px);
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
    gap: var(--space-2, 4px);
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
    border-radius: var(--radius-sm, 5px);
    background: var(--color-surface-overlay);
    color: var(--color-text-2);
    cursor: pointer;
    transition: border-color var(--motion-fast, 140ms) var(--ease-out, ease);
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
    border-radius: var(--radius-sm, 5px);
    background: var(--color-warn-bg, var(--color-surface));
    color: var(--color-text-2);
    border: 1px solid var(--color-border);
  }
  .conn[data-conn='offline'] {
    background: var(--color-error-bg, var(--color-surface));
  }

  /* Reduced motion: no transform/transition entrance + NO cycling glow (a11y). The running
     ring degrades to its STATIC halo (still honest — the node IS running), never a moving
     dash. The motion-lib pop/draw-in already degrade to instant opacity tweens; this kills
     the CSS transitions + the perimeter travel too. Belt-and-braces with data-animate (the
     JS already sets it false under reduced-motion), so the ring is static even mid-stream. */
  @media (prefers-reduced-motion: reduce) {
    .node,
    .node-box,
    .edge,
    .te-node {
      transition: none;
    }
    .run-ring {
      animation: none !important;
      /* settle to the static full outline (drop the travelling dash) */
      stroke-dasharray: none !important;
      stroke-dashoffset: 0 !important;
    }
  }
</style>
