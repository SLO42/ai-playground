<script lang="ts">
  /**
   * MemoryScene — the living-brain animated force graph (MEMORY-SCENE-SPEC §4).
   *
   * An Obsidian-bubble-style force-directed scene of the RUNNING system: memory + job
   * nodes (the MS-2 aggregator's derived TRUTH) positioned by a d3-force simulation, with
   * motion.dev imperative springs LAYERED on the force positions for the live micro-
   * animations — node SPAWN (wobbly pop), job FIRING (pulse/glow), CONNECTION (edge draw),
   * node RETIRE (fade+shrink before removal).
   *
   * TRUTH vs FEED (F-008): this component does NOT fetch its own truth. The `graph` prop is
   * the aggregator's derived node/edge truth (re-derived live by the loader on every
   * relevant row change). The `feed` prop is the live DbChange stream (off the ONE SSE) —
   * it ONLY drives the animation timeline (which node just spawned / fired / retired); it
   * never adds a node the truth doesn't have. So a stale feed can never paint stale state.
   *
   * RAILS: design-system TOKENS only (node color per class/status — no hard-coded colors);
   * transform/opacity-only animations for 60fps; prefers-reduced-motion → instant/opacity-
   * only (no springs); honest empty ('no active memory/jobs yet'); keyboard-navigable +
   * a text-equivalent (the scene is decorative-augmenting, never the only way to read state).
   * Svelte 5 runes only.
   */
  import { onMount, untrack } from 'svelte';
  import { animate } from 'motion';
  import {
    forceSimulation,
    forceManyBody,
    forceLink,
    forceCenter,
    forceCollide,
    type Simulation
  } from 'd3-force';
  import type { SceneGraph } from '$lib/server/scene';
  import type { SceneChange } from '$lib/client/scene/scene-graph';
  import {
    toForceModel,
    animationIntent,
    springFor,
    keyframesFor,
    nodeVisual,
    type ForceNode,
    type ForceLink,
    type AnimationIntent
  } from '$lib/client/scene/scene-graph';

  interface Props {
    /** The derived node/edge TRUTH (MS-2 aggregator). The component never fetches this. */
    graph: SceneGraph;
    /**
     * Subscribe to the live DbChange feed (the ONE SSE). Called once on mount with a
     * callback the component drives its animation timeline from; returns an unsubscribe.
     * Decoupled as a prop so the component owns NO truth and is trivially testable/mountable.
     */
    feed?: (onChange: (topic: string, change: SceneChange) => void) => () => void;
    /** Optional fixed height (px) for the canvas; defaults to a responsive 520. */
    height?: number;
  }

  let { graph, feed, height = 520 }: Props = $props();

  // ── Reduced motion (a11y) ───────────────────────────────────────────────────────────
  let reducedMotion = $state(false);

  // ── Layout model, derived from the truth ──────────────────────────────────────────────
  const model = $derived(toForceModel(graph));
  const hasNodes = $derived(model.nodes.length > 0);

  // The simulation owns the live positions; we render off these reactive snapshots.
  let positioned = $state<ForceNode[]>([]);
  let links = $state<ForceLink[]>([]);
  let sim: Simulation<ForceNode, ForceLink> | null = null;

  let width = $state(0);
  let svgEl = $state<SVGSVGElement | null>(null);
  // node id → its <g> element (for imperative motion.dev animation).
  const nodeEls = new Map<string, SVGGElement>();
  // link id → its <line> element.
  const edgeEls = new Map<string, SVGLineElement>();
  // exiting node id → its <g> element (the retire-fade DOM layer).
  const exitEls = new Map<string, SVGGElement>();
  // nodes currently animating OUT (retire) — held in the DOM until the fade completes.
  let exiting = $state<ForceNode[]>([]);
  // ids we've already played a spawn for (so a truth refresh doesn't re-pop everything).
  const spawned = new Set<string>();

  function dims(): { w: number; h: number } {
    return { w: width || 800, h: height };
  }

  /** (Re)build the d3-force simulation from the current model. */
  function buildSim(): void {
    const { w, h } = dims();
    sim?.stop();
    // Preserve positions of nodes that persist across a truth refresh (no teleport-replay).
    const prev = new Map(positioned.map((n) => [n.id, n]));
    const nodes: ForceNode[] = model.nodes.map((n) => {
      const p = prev.get(n.id);
      return p ? { ...n, x: p.x, y: p.y, vx: p.vx, vy: p.vy } : { ...n, x: w / 2 + (Math.random() - 0.5) * 40, y: h / 2 + (Math.random() - 0.5) * 40 };
    });
    const lks: ForceLink[] = model.links.map((l) => ({ ...l }));

    sim = forceSimulation<ForceNode, ForceLink>(nodes)
      .force('charge', forceManyBody<ForceNode>().strength(-90))
      .force('link', forceLink<ForceNode, ForceLink>(lks).id((d) => d.id).distance(60).strength(0.4))
      .force('center', forceCenter(w / 2, h / 2))
      .force('collide', forceCollide<ForceNode>().radius((d) => nodeVisual(d).radius + 6))
      .alpha(0.9)
      .alphaDecay(0.045);

    // Reduced motion: settle the layout synchronously (no animated physics tick stream).
    if (reducedMotion) {
      for (let i = 0; i < 240 && sim.alpha() > sim.alphaMin(); i++) sim.tick();
      sim.stop();
      positioned = [...nodes];
      links = lks;
      return;
    }

    sim.on('tick', () => {
      // Reassign for $state reactivity (the array identity changes each tick).
      positioned = [...nodes];
      links = lks;
    });
  }

  // Rebuild whenever the truth model changes (node/edge set). Position is preserved above.
  $effect(() => {
    // Track the model + reducedMotion; rebuild in an untracked block so the sim's own state
    // writes don't loop the effect.
    void model;
    void reducedMotion;
    void width;
    untrack(() => buildSim());
  });

  // ── Live feed → animation intents (the §4 micro-animations) ───────────────────────────
  function play(intent: AnimationIntent): void {
    if (intent.on === 'node') {
      if (intent.kind === 'retire') {
        retire(intent.target);
        return;
      }
      const el = nodeEls.get(intent.target);
      // pulse on a live node; spawn is driven by the mount pass (the node may not exist yet).
      if (el) animateNode(el, intent);
    } else {
      const el = edgeEls.get(intent.target);
      if (el) animateEdge(el, intent);
    }
  }

  /**
   * Retire a node: fade+shrink it BEFORE DOM removal (AnimatePresence-equivalent). We snapshot
   * the live node into `exiting` (its own DOM layer) so the fade survives the truth refresh
   * that drops it from the simulation; when the fade finishes we remove the snapshot. If the
   * node isn't currently rendered we no-op (nothing to fade). Re-allowing a future re-spawn:
   * its id is cleared from `spawned` so a later CREATE pops it again.
   */
  function retire(id: string): void {
    spawned.delete(id);
    if (exiting.some((n) => n.id === id)) return; // already exiting
    const node = positioned.find((n) => n.id === id);
    if (!node) return; // not on screen — nothing to fade
    exiting = [...exiting, { ...node }];
  }

  function animateNode(el: SVGGElement, intent: AnimationIntent, onDone?: () => void): void {
    const kf = keyframesFor(intent.kind, reducedMotion);
    const tr = springFor(intent.kind, reducedMotion);
    // motion.dev imperative core — transform/opacity only.
    const controls = animate(el, kf as Record<string, number[]>, tr as Parameters<typeof animate>[2]);
    // The imperative controls are promise-like (`.then` resolves when the animation finishes);
    // we await that to remove the node only AFTER its retire fade completes (AnimatePresence-
    // equivalent — animate-out then DOM removal).
    if (onDone) void Promise.resolve(controls).then(onDone, onDone);
  }

  function animateEdge(el: SVGLineElement, intent: AnimationIntent): void {
    const kf = keyframesFor(intent.kind, reducedMotion);
    const tr = springFor(intent.kind, reducedMotion);
    animate(el, kf as Record<string, number[]>, tr as Parameters<typeof animate>[2]);
  }

  // exiting-node ids whose fade has already been started (so the effect plays each once).
  const exitPlayed = new Set<string>();
  // Play the retire fade on each exiting node's element, then drop it from the DOM.
  $effect(() => {
    void exiting;
    untrack(() => {
      for (const n of exiting) {
        if (exitPlayed.has(n.id)) continue;
        exitPlayed.add(n.id);
        requestAnimationFrame(() => {
          const el = exitEls.get(n.id);
          const done = () => {
            exiting = exiting.filter((x) => x.id !== n.id);
            exitPlayed.delete(n.id);
            exitEls.delete(n.id);
          };
          if (el) animateNode(el, { kind: 'retire', target: n.id, on: 'node' }, done);
          else done();
        });
      }
    });
  });

  // ── Spawn pass: pop any node that is newly in the truth (mount-time micro-animation) ──
  $effect(() => {
    void positioned;
    untrack(() => {
      if (reducedMotion) {
        // Still honor opacity-only spawn for newcomers (no transform).
        for (const n of positioned) if (!spawned.has(n.id)) markSpawn(n.id);
        return;
      }
      for (const n of positioned) {
        if (spawned.has(n.id)) continue;
        markSpawn(n.id);
      }
    });
  });
  function markSpawn(id: string): void {
    spawned.add(id);
    // Defer one frame so the <g> exists, then play the spawn pop.
    requestAnimationFrame(() => {
      const el = nodeEls.get(id);
      if (el) animateNode(el, { kind: 'spawn', target: id, on: 'node' });
    });
  }

  function registerNode(el: SVGGElement, id: string): { destroy: () => void } {
    nodeEls.set(id, el);
    return { destroy: () => nodeEls.delete(id) };
  }
  function registerEdge(el: SVGLineElement, id: string): { destroy: () => void } {
    edgeEls.set(id, el);
    return { destroy: () => edgeEls.delete(id) };
  }
  function registerExit(el: SVGGElement, id: string): { destroy: () => void } {
    exitEls.set(id, el);
    return { destroy: () => exitEls.delete(id) };
  }

  // ── Focus / keyboard nav (text-equivalent + a11y) ─────────────────────────────────────
  let focusId = $state<string | null>(null);
  const neighbours = $derived(
    focusId
      ? new Set(
          links
            .filter((l) => srcId(l) === focusId || tgtId(l) === focusId)
            .map((l) => (srcId(l) === focusId ? tgtId(l) : srcId(l)))
        )
      : new Set<string>()
  );

  function srcId(l: ForceLink): string {
    return typeof l.source === 'string' ? l.source : (l.source as ForceNode).id;
  }
  function tgtId(l: ForceLink): string {
    return typeof l.target === 'string' ? l.target : (l.target as ForceNode).id;
  }
  function nx(l: ForceLink, end: 'source' | 'target'): number {
    const n = l[end];
    return typeof n === 'object' ? ((n as ForceNode).x ?? 0) : 0;
  }
  function ny(l: ForceLink, end: 'source' | 'target'): number {
    const n = l[end];
    return typeof n === 'object' ? ((n as ForceNode).y ?? 0) : 0;
  }

  function focus(id: string): void {
    focusId = focusId === id ? null : id;
  }

  // ── Mount: reduced-motion, resize, feed subscription, teardown ─────────────────────────
  onMount(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const onMq = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', onMq);

    const ro = new ResizeObserver((entries) => {
      width = entries[0]?.contentRect.width ?? width;
    });
    if (svgEl?.parentElement) ro.observe(svgEl.parentElement);

    // Subscribe the live feed → animation timeline. The component owns NO truth; this only
    // animates. A throwing/absent feed is tolerated (the static graph still renders).
    let offFeed: (() => void) | undefined;
    if (feed) {
      try {
        offFeed = feed((topic, change) => {
          const intent = animationIntent(topic, change);
          if (intent) play(intent);
        });
      } catch {
        /* a feed that fails to subscribe leaves the scene static, never broken */
      }
    }

    return () => {
      mq.removeEventListener('change', onMq);
      ro.disconnect();
      offFeed?.();
      sim?.stop();
      sim = null;
    };
  });
</script>

<div class="scene" style:--scene-h="{height}px">
  {#if !hasNodes}
    <!-- Honest empty (F-008) — never a faked graph. -->
    <div class="empty" role="status">
      <span class="eyebrow">scene</span>
      <p class="empty-body">No active memory or jobs yet — the scene animates as entities, sessions and work items land.</p>
    </div>
  {:else}
    <!-- The animated scene (decorative-augmenting). aria-hidden so AT users get the
         text-equivalent below instead of an unlabelled SVG soup. -->
    <svg
      bind:this={svgEl}
      class="canvas"
      viewBox="0 0 {dims().w} {dims().h}"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <g class="edges">
        {#each links as l (l.id)}
          <line
            use:registerEdge={l.id}
            class="edge"
            data-kind={l.kind}
            data-active={focusId !== null && (srcId(l) === focusId || tgtId(l) === focusId)}
            x1={nx(l, 'source')}
            y1={ny(l, 'source')}
            x2={nx(l, 'target')}
            y2={ny(l, 'target')}
          />
        {/each}
      </g>
      <g class="nodes">
        {#each positioned as n (n.id)}
          {@const v = nodeVisual(n)}
          <g
            use:registerNode={n.id}
            class="node"
            data-class={v.colorClass}
            data-status={v.statusClass}
            data-focus={focusId === n.id}
            data-neighbour={neighbours.has(n.id)}
            data-dim={focusId !== null && focusId !== n.id && !neighbours.has(n.id)}
            transform="translate({n.x ?? 0},{n.y ?? 0})"
          >
            <circle class="bubble" r={v.radius} />
          </g>
        {/each}
        {#each exiting as n (n.id)}
          {@const v = nodeVisual(n)}
          <g use:registerExit={n.id} class="node exiting" data-class={v.colorClass} data-status={v.statusClass} transform="translate({n.x ?? 0},{n.y ?? 0})">
            <circle class="bubble" r={v.radius} />
          </g>
        {/each}
      </g>
    </svg>

    <!-- Text-equivalent: a keyboard-navigable list of the SAME nodes. This is the honest,
         non-decorative read of the scene (a11y) — every node reachable + focusable. -->
    <ul class="legend" aria-label="Scene nodes ({positioned.length})">
      {#each positioned as n (n.id)}
        {@const v = nodeVisual(n)}
        <li>
          <button
            type="button"
            class="legend-node"
            data-class={v.colorClass}
            data-status={v.statusClass}
            data-focus={focusId === n.id}
            data-dim={focusId !== null && focusId !== n.id && !neighbours.has(n.id)}
            aria-pressed={focusId === n.id}
            onclick={() => focus(n.id)}
          >
            <span class="dot" data-class={v.colorClass} data-status={v.statusClass} aria-hidden="true"></span>
            <span class="legend-label">{n.label}</span>
            <span class="legend-status mono">{n.status}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .scene {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    width: 100%;
  }
  .canvas {
    width: 100%;
    height: var(--scene-h, 520px);
    display: block;
    background:
      radial-gradient(circle at 50% 40%, var(--color-surface-overlay), var(--color-surface) 70%);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 10px);
  }
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
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 44ch;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }

  /* Edges — token stroke, dimmed when a focus is active and they're off-path. */
  .edge {
    stroke: var(--color-border);
    stroke-width: 1;
    opacity: 0.55;
    transition: opacity 0.16s ease, stroke 0.16s ease;
  }
  .edge[data-active='true'] {
    stroke: var(--color-accent);
    opacity: 1;
  }

  /* Nodes — color FAMILY by class, status by data-status (TOKENS only, no literals). */
  .node {
    /* transform is owned by d3 (translate) + motion (scale layered via the element's
       transform); transform-origin center so the spring scales about the bubble. */
    transform-box: fill-box;
  }
  .bubble {
    stroke: var(--color-surface);
    stroke-width: 1;
  }
  /* memory family → accent; job family → status-colored. */
  .node[data-class='memory'] .bubble {
    fill: var(--color-accent);
  }
  .node[data-class='job'][data-status='active'] .bubble {
    fill: var(--color-running);
  }
  .node[data-class='job'][data-status='pending'] .bubble {
    fill: var(--color-info);
  }
  .node[data-class='job'][data-status='done'] .bubble {
    fill: var(--color-success);
  }
  .node[data-class='job'][data-status='failed'] .bubble {
    fill: var(--color-warn);
  }
  .node[data-status='dim'] .bubble {
    fill: var(--color-text-muted);
    opacity: 0.5;
  }
  .node[data-focus='true'] .bubble {
    stroke: var(--color-accent);
    stroke-width: 2;
  }
  .node[data-neighbour='true'] .bubble {
    stroke: var(--color-accent-muted);
    stroke-width: 1.5;
  }
  .node[data-dim='true'] {
    opacity: 0.3;
  }

  /* Legend / text-equivalent — keyboard-navigable list of the same nodes. */
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
    max-height: 14rem;
    overflow-y: auto;
  }
  .legend-node {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.55rem;
    border: 1px solid var(--color-border-subtle, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    color: var(--color-text-2);
    cursor: pointer;
    font: var(--type-body-sm);
    transition: border-color 0.14s ease, opacity 0.14s ease;
  }
  .legend-node:hover {
    border-color: var(--color-accent);
  }
  .legend-node:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .legend-node[data-focus='true'] {
    border-color: var(--color-accent);
    color: var(--color-text);
  }
  .legend-node[data-dim='true'] {
    opacity: 0.45;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: none;
  }
  .dot[data-class='memory'] {
    background: var(--color-accent);
  }
  .dot[data-class='job'][data-status='active'] {
    background: var(--color-running);
  }
  .dot[data-class='job'][data-status='pending'] {
    background: var(--color-info);
  }
  .dot[data-class='job'][data-status='done'] {
    background: var(--color-success);
  }
  .dot[data-class='job'][data-status='failed'] {
    background: var(--color-warn);
  }
  .dot[data-status='dim'] {
    background: var(--color-text-muted);
  }
  .legend-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
  .legend-status {
    font-size: 0.66rem;
    color: var(--color-text-muted);
  }

  @media (prefers-reduced-motion: reduce) {
    .edge {
      transition: none;
    }
    .legend-node {
      transition: none;
    }
  }
</style>
