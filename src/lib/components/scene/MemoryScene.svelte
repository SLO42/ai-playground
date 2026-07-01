<script lang="ts">
  /**
   * MemoryScene — the living-brain animated force graph (MEMORY-SCENE-SPEC §4), upgraded to a
   * FULL interactive graph: a free camera (pan / wheel+button zoom / node drag with pin-release),
   * a full-screen mode, click-to-inspect detail panel, project + agent node classes (distinct
   * color + shape per class), live status coloring/pulse, and a timeline scrubber that replays
   * recent activity by `at`.
   *
   * TRUTH vs FEED (F-008): this component does NOT fetch its own truth. The `graph` prop is the
   * aggregator's derived node/edge truth (re-derived live by the loader on every relevant row
   * change). The `feed` prop is the live DbChange stream — it ONLY drives the animation timeline;
   * it never adds a node the truth doesn't have, so a stale feed can never paint stale state.
   *
   * RAILS: design-system TOKENS only (color per class/status — no hard-coded colors); transform/
   * opacity-only animations for 60fps; prefers-reduced-motion → instant/opacity-only (no springs,
   * no status pulse); honest empty ('no active memory/jobs yet'); keyboard-navigable text-
   * equivalent (the scene is decorative-augmenting, never the only way to read state). Svelte 5 runes.
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
  import NodeInspector from './NodeInspector.svelte';

  interface Props {
    /** The derived node/edge TRUTH (aggregator). The component never fetches this. */
    graph: SceneGraph;
    /**
     * Subscribe to the live DbChange feed. Called once on mount with a callback the component
     * drives its animation timeline from; returns an unsubscribe. Decoupled as a prop so the
     * component owns NO truth and is trivially testable/mountable.
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
  let stageH = $state(0);
  let svgEl = $state<SVGSVGElement | null>(null);
  let stageEl = $state<HTMLDivElement | null>(null);
  const nodeEls = new Map<string, SVGGElement>();
  const edgeEls = new Map<string, SVGLineElement>();
  const exitEls = new Map<string, SVGGElement>();
  let exiting = $state<ForceNode[]>([]);
  const spawned = new Set<string>();

  // ── Camera (pan / zoom) + full-screen ─────────────────────────────────────────────────
  let tx = $state(0);
  let ty = $state(0);
  let k = $state(1);
  let fullscreen = $state(false);
  // One-shot auto-fit. Frames the node bbox during the bounded settle that follows an EXPLICIT
  // trigger only — initial mount, the Recenter button, and a full-screen toggle. It is cleared
  // on sim-settle ('end') and the instant the user pans/zooms/drags, and is NEVER re-armed by an
  // incidental resize, so it can neither fight a deliberate camera move (the 7550f2f regression
  // that killed panning) nor chase a still-spreading layout (the regression that drifted nodes
  // off-frame on full-screen). After it clears, the camera is authoritative until the next trigger.
  let pendingFit = $state(true);
  // Bounds a fit episode so it always ENDS (final fit, then hold) even if the sim never fires
  // 'end' — e.g. frequent live model reheats keep replacing the sim. Per-tick framing keeps the
  // bbox in view until this fires, so the bounded clear never leaves the camera mid-frame.
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  const MIN_K = 0.1;
  const MAX_K = 4;
  const clampK = (v: number): number => Math.min(MAX_K, Math.max(MIN_K, v));

  function dims(): { w: number; h: number } {
    return { w: width || 800, h: fullscreen ? stageH || height : height };
  }

  /**
   * Fit + center the camera so every node (respecting the timeline window) sits inside the
   * current viewport with a small margin. Sets the pan/zoom transform only — never touches the
   * simulation. Used by the recenter control and the auto-fit pass on viewport changes.
   */
  function fitToNodes(ns: ForceNode[] = positioned): void {
    if (!ns.length) return;
    const inWin = ns.filter(inWindow);
    const use = inWin.length ? inWin : ns;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of use) {
      const r = nodeVisual(n).radius + 4;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      if (x - r < minX) minX = x - r;
      if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r;
      if (y + r > maxY) maxY = y + r;
    }
    if (!Number.isFinite(minX)) return;
    const { w, h } = dims();
    const pad = 28;
    const cw = Math.max(1, maxX - minX);
    const ch = Math.max(1, maxY - minY);
    const nk = clampK(Math.min((w - 2 * pad) / cw, (h - 2 * pad) / ch));
    k = nk;
    tx = w / 2 - nk * ((minX + maxX) / 2);
    ty = h / 2 - nk * ((minY + maxY) / 2);
  }

  function clientToUser(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const ctm = svgEl?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }
  function clientToSim(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const u = clientToUser(e);
    return u ? { x: (u.x - tx) / k, y: (u.y - ty) / k } : null;
  }
  /** Zoom keeping the user-space point (ux,uy) fixed under the cursor. */
  function zoomAround(ux: number, uy: number, factor: number): void {
    const nk = clampK(k * factor);
    tx = ux - ((ux - tx) / k) * nk;
    ty = uy - ((uy - ty) / k) * nk;
    k = nk;
  }
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    cancelPendingFit();
    const u = clientToUser(e);
    if (!u) return;
    zoomAround(u.x, u.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }
  function zoomBtn(factor: number): void {
    cancelPendingFit();
    zoomAround(dims().w / 2, dims().h / 2, factor);
  }
  /** Cancel any in-flight one-shot fit (called the instant the user takes camera control). */
  function cancelPendingFit(): void {
    pendingFit = false;
    if (fitTimer) {
      clearTimeout(fitTimer);
      fitTimer = null;
    }
  }
  /**
   * Arm a bounded one-shot fit episode. The sim's tick/'end' handlers frame the bbox against the
   * live dims as the layout (and any full-screen resize) settles; this timer guarantees the episode
   * terminates — final fit, then hold — so it can never refit "forever" under continuous reheats.
   */
  function armFit(delay = 3500): void {
    pendingFit = true;
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      if (pendingFit) {
        fitToNodes();
        pendingFit = false;
      }
    }, delay);
  }
  /** Recenter: fit + center all nodes in the current viewport (one-shot, user-invoked). */
  function recenter(): void {
    cancelPendingFit();
    fitToNodes();
  }

  // ── Pan + node-drag (pointer) ───────────────────────────────────────────────────────────
  let panning = $state(false);
  let panMoved = false;
  let panStart = { cx: 0, cy: 0, tx: 0, ty: 0 };
  let dragId: string | null = null;
  let dragMoved = false;
  let pinned = $state(new Set<string>());

  function bgPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    cancelPendingFit();
    panning = true;
    panMoved = false;
    panStart = { cx: e.clientX, cy: e.clientY, tx, ty };
    svgEl?.setPointerCapture?.(e.pointerId);
  }
  function nodePointerDown(e: PointerEvent, id: string): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    cancelPendingFit();
    dragId = id;
    dragMoved = false;
    svgEl?.setPointerCapture?.(e.pointerId);
    if (!reducedMotion) sim?.alphaTarget(0.25).restart();
  }
  function onPointerMove(e: PointerEvent): void {
    if (dragId) {
      const c = clientToSim(e);
      if (!c) return;
      dragMoved = true;
      const n = positioned.find((x) => x.id === dragId);
      if (n) {
        n.fx = c.x;
        n.fy = c.y;
        n.x = c.x;
        n.y = c.y;
        positioned = [...positioned];
      }
    } else if (panning) {
      const dx = e.clientX - panStart.cx;
      const dy = e.clientY - panStart.cy;
      if (Math.abs(dx) + Math.abs(dy) > 2) panMoved = true;
      tx = panStart.tx + dx;
      ty = panStart.ty + dy;
    }
  }
  function onPointerUp(): void {
    if (dragId) {
      if (!dragMoved) {
        focus(dragId); // a tap (no drag) = inspect/focus
      } else {
        // dropped after a drag → keep it PINNED where placed (fx/fy retained).
        pinned = new Set(pinned).add(dragId);
      }
      if (!reducedMotion) sim?.alphaTarget(0);
      dragId = null;
    } else if (panning && !panMoved) {
      // a background tap (no drag) clears the selection.
      focusId = null;
    }
    panning = false;
  }
  /** Release a pinned node back into the simulation. */
  function unpin(id: string): void {
    const n = positioned.find((x) => x.id === id);
    if (n) {
      n.fx = null;
      n.fy = null;
      positioned = [...positioned];
    }
    const next = new Set(pinned);
    next.delete(id);
    pinned = next;
    if (!reducedMotion) sim?.alphaTarget(0.15).restart().alphaTarget(0);
  }

  /** (Re)build the d3-force simulation from the current model. Preserves position + pins. */
  function buildSim(): void {
    const { w, h } = dims();
    sim?.stop();
    const prev = new Map(positioned.map((n) => [n.id, n]));
    const nodes: ForceNode[] = model.nodes.map((n) => {
      const p = prev.get(n.id);
      return p
        ? { ...n, x: p.x, y: p.y, vx: p.vx, vy: p.vy, fx: p.fx, fy: p.fy }
        : { ...n, x: w / 2 + (Math.random() - 0.5) * 40, y: h / 2 + (Math.random() - 0.5) * 40 };
    });
    const lks: ForceLink[] = model.links.map((l) => ({ ...l }));

    sim = forceSimulation<ForceNode, ForceLink>(nodes)
      .force('charge', forceManyBody<ForceNode>().strength(-90))
      .force('link', forceLink<ForceNode, ForceLink>(lks).id((d) => d.id).distance(60).strength(0.4))
      .force('center', forceCenter(w / 2, h / 2))
      .force('collide', forceCollide<ForceNode>().radius((d) => nodeVisual(d).radius + 6))
      .alpha(0.9)
      .alphaDecay(0.045);

    if (reducedMotion) {
      for (let i = 0; i < 240 && sim.alpha() > sim.alphaMin(); i++) sim.tick();
      sim.stop();
      positioned = [...nodes];
      links = lks;
      if (pendingFit) {
        fitToNodes(nodes);
        pendingFit = false;
      }
      return;
    }

    sim.on('tick', () => {
      positioned = [...nodes];
      links = lks;
      // While a fit is pending (post-trigger settle only), keep the bbox framed against the LIVE
      // dims — this also tracks the full-screen resize as it lands. Cleared on 'end'/interaction.
      if (pendingFit) fitToNodes(nodes);
    });
    // Settled: final fit, then HOLD — clearing pendingFit so subsequent live model rebuilds (each
    // re-runs the sim) never refit and chase the camera, and a user pan/zoom/drag is never fought.
    sim.on('end', () => {
      if (pendingFit) {
        fitToNodes(nodes);
        pendingFit = false;
        if (fitTimer) {
          clearTimeout(fitTimer);
          fitTimer = null;
        }
      }
    });
  }

  // Rebuild the simulation only on STRUCTURAL change (node/edge model, or reduced-motion) — NOT
  // on resize/full-screen. Rebuilding on every resize re-ran the sim from a hot alpha repeatedly,
  // a reheat storm that kept the layout spreading and the camera chasing it (7550f2f drift). The
  // viewBox + the full-screen effect below handle viewport changes without a structural rebuild.
  $effect(() => {
    void model;
    void reducedMotion;
    untrack(() => buildSim());
  });

  // A full-screen toggle is a DELIBERATE viewport change: re-center the force on the new viewport,
  // gently reheat so the layout re-settles, and arm ONE pending fit (the tick/'end' handlers frame
  // it against the live dims as the resize lands, then hold). Depends ONLY on `fullscreen`, so an
  // incidental container resize never re-triggers it. The initial run (mount) is skipped — the
  // mount fit is owned by buildSim's pending fit.
  let fsReady = false;
  $effect(() => {
    void fullscreen;
    untrack(() => {
      if (!fsReady) {
        fsReady = true;
        return;
      }
      const { w, h } = dims();
      sim?.force('center', forceCenter(w / 2, h / 2));
      if (!reducedMotion) {
        armFit();
        sim?.alpha(0.5).restart();
      } else {
        pendingFit = true;
        // reduced-motion: no ticks will run — fit against the new viewport once the resize lands.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (pendingFit) {
              fitToNodes();
              pendingFit = false;
            }
          })
        );
      }
    });
  });

  // ── Timeline scrubber (replay recent activity by `at`) ──────────────────────────────────
  const times = $derived(
    model.nodes
      .map((n) => (n.at ? new Date(n.at).getTime() : NaN))
      .filter((t) => !Number.isNaN(t))
  );
  const minAt = $derived(times.length ? Math.min(...times) : 0);
  const maxAt = $derived(times.length ? Math.max(...times) : 0);
  const hasScrub = $derived(times.length > 1 && maxAt > minAt);
  // null cutoff = LIVE (show all); a number hides nodes whose `at` is older than it.
  let cutoff = $state<number | null>(null);
  function inWindow(n: ForceNode): boolean {
    if (cutoff === null || !n.at) return true; // structural nodes (no `at`) always show
    const t = new Date(n.at).getTime();
    return Number.isNaN(t) || t >= cutoff;
  }
  const cutoffLabel = $derived(cutoff === null ? 'live · all' : new Date(cutoff).toLocaleString());

  // ── Live feed → animation intents (the §4 micro-animations) ───────────────────────────
  function play(intent: AnimationIntent): void {
    if (intent.on === 'node') {
      if (intent.kind === 'retire') {
        retire(intent.target);
        return;
      }
      const el = nodeEls.get(intent.target);
      if (el) animateNode(el, intent);
    } else {
      const el = edgeEls.get(intent.target);
      if (el) animateEdge(el, intent);
    }
  }

  function retire(id: string): void {
    spawned.delete(id);
    if (exiting.some((n) => n.id === id)) return;
    const node = positioned.find((n) => n.id === id);
    if (!node) return;
    exiting = [...exiting, { ...node }];
  }

  function animateNode(el: SVGGElement, intent: AnimationIntent, onDone?: () => void): void {
    const kf = keyframesFor(intent.kind, reducedMotion);
    const tr = springFor(intent.kind, reducedMotion);
    const controls = animate(el, kf as Record<string, number[]>, tr as Parameters<typeof animate>[2]);
    if (onDone) void Promise.resolve(controls).then(onDone, onDone);
  }

  function animateEdge(el: SVGLineElement, intent: AnimationIntent): void {
    const kf = keyframesFor(intent.kind, reducedMotion);
    const tr = springFor(intent.kind, reducedMotion);
    animate(el, kf as Record<string, number[]>, tr as Parameters<typeof animate>[2]);
  }

  const exitPlayed = new Set<string>();
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

  // ── Spawn pass: pop any node newly in the truth (mount-time micro-animation) ──
  $effect(() => {
    void positioned;
    untrack(() => {
      for (const n of positioned) {
        if (spawned.has(n.id)) continue;
        markSpawn(n.id);
      }
    });
  });
  function markSpawn(id: string): void {
    spawned.add(id);
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

  // ── Focus / selection (text-equivalent + click-to-inspect) ──────────────────────────────
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
  const selected = $derived(focusId ? (positioned.find((n) => n.id === focusId) ?? null) : null);

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
  function edgeInWindow(l: ForceLink): boolean {
    const s = positioned.find((n) => n.id === srcId(l));
    const t = positioned.find((n) => n.id === tgtId(l));
    return (!s || inWindow(s)) && (!t || inWindow(t));
  }

  function focus(id: string): void {
    focusId = focusId === id ? null : id;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (focusId) focusId = null;
      else if (fullscreen) fullscreen = false;
    }
  }

  // ── Mount: reduced-motion, resize, feed subscription, teardown ─────────────────────────
  onMount(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const onMq = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', onMq);

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) {
        width = r.width;
        stageH = r.height;
      }
    });
    if (stageEl) ro.observe(stageEl);

    // Initial mount = the first explicit fit trigger: frame once after the layout settles, bounded.
    armFit();

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
      if (fitTimer) clearTimeout(fitTimer);
      sim?.stop();
      sim = null;
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="scene" class:fullscreen style:--scene-h="{height}px">
  {#if !hasNodes}
    <!-- Honest empty (F-008) — never a faked graph. -->
    <div class="empty" role="status">
      <span class="eyebrow">scene</span>
      <p class="empty-body">No active memory or jobs yet — the scene animates as entities, sessions, projects and agents land.</p>
    </div>
  {:else}
    <div class="stage" bind:this={stageEl}>
      <!-- Camera controls (overlay, top-right). -->
      <div class="controls" role="group" aria-label="Scene camera controls">
        <button type="button" class="ctl" onclick={() => zoomBtn(1.2)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" class="ctl" onclick={() => zoomBtn(1 / 1.2)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" class="ctl" onclick={recenter} aria-label="Recenter — fit all nodes" title="Recenter (fit all nodes)">⊙</button>
        <button
          type="button"
          class="ctl"
          onclick={() => (fullscreen = !fullscreen)}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          title={fullscreen ? 'Exit full screen' : 'Full screen'}
        >{fullscreen ? '✕' : '⛶'}</button>
      </div>

      <!-- The animated scene. aria-hidden so AT users get the text-equivalent list below;
           mouse users get pan (drag background), zoom (wheel/buttons) and node drag. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svg
        bind:this={svgEl}
        class="canvas"
        viewBox="0 0 {dims().w} {dims().h}"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        data-panning={panning}
        onwheel={onWheel}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <rect class="bg" x="0" y="0" width={dims().w} height={dims().h} onpointerdown={bgPointerDown} />
        <g class="camera" transform="translate({tx},{ty}) scale({k})">
          <g class="edges">
            {#each links as l (l.id)}
              <line
                use:registerEdge={l.id}
                class="edge"
                data-kind={l.kind}
                data-active={focusId !== null && (srcId(l) === focusId || tgtId(l) === focusId)}
                data-faded={!edgeInWindow(l)}
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
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <g
                use:registerNode={n.id}
                class="node"
                data-class={v.colorClass}
                data-status={v.statusClass}
                data-focus={focusId === n.id}
                data-neighbour={neighbours.has(n.id)}
                data-pinned={pinned.has(n.id)}
                data-dim={focusId !== null && focusId !== n.id && !neighbours.has(n.id)}
                data-faded={!inWindow(n)}
                transform="translate({n.x ?? 0},{n.y ?? 0})"
                onpointerdown={(e) => nodePointerDown(e, n.id)}
              >
                {#if n.class === 'self'}
                  <!-- S4 identity anchor: a maturity-ringed core (halo stroke = stage color). -->
                  <circle class="halo" r={v.radius + 4} />
                  <circle class="bubble" r={v.radius} />
                  <circle class="core" r={v.radius * 0.42} />
                {:else if n.class === 'project' || n.class === 'concept'}
                  <rect class="bubble" x={-v.radius} y={-v.radius} width={v.radius * 2} height={v.radius * 2} rx={n.class === 'concept' ? v.radius : 3} />
                {:else if n.class === 'agent' || n.class === 'skill'}
                  <polygon class="bubble" points="0,{-v.radius} {v.radius},0 0,{v.radius} {-v.radius},0" />
                {:else}
                  <circle class="bubble" r={v.radius} />
                {/if}
              </g>
            {/each}
            {#each exiting as n (n.id)}
              {@const v = nodeVisual(n)}
              <g use:registerExit={n.id} class="node exiting" data-class={v.colorClass} data-status={v.statusClass} transform="translate({n.x ?? 0},{n.y ?? 0})">
                {#if n.class === 'project' || n.class === 'concept'}
                  <rect class="bubble" x={-v.radius} y={-v.radius} width={v.radius * 2} height={v.radius * 2} rx={n.class === 'concept' ? v.radius : 3} />
                {:else if n.class === 'agent' || n.class === 'skill'}
                  <polygon class="bubble" points="0,{-v.radius} {v.radius},0 0,{v.radius} {-v.radius},0" />
                {:else}
                  <circle class="bubble" r={v.radius} />
                {/if}
              </g>
            {/each}
          </g>
        </g>
      </svg>

      <!-- Click-to-inspect detail panel (overlay; metadata only — D-026). -->
      {#if selected}
        <div class="inspector-wrap">
          <NodeInspector
            node={selected}
            {links}
            pinned={pinned.has(selected.id)}
            onclose={() => (focusId = null)}
            onunpin={() => unpin(selected.id)}
          />
        </div>
      {/if}
    </div>

    <!-- Timeline scrubber (replay recent activity by `at`). Reduced-motion safe: it only
         filters/repaints, no animation. Hidden when there's nothing to scrub. -->
    {#if hasScrub}
      <div class="scrubber">
        <span class="eyebrow">timeline</span>
        <input
          class="scrub-range"
          type="range"
          min={minAt}
          max={maxAt}
          step={Math.max(1, Math.round((maxAt - minAt) / 200))}
          value={cutoff ?? minAt}
          aria-label="Filter scene to activity after a time"
          oninput={(e) => (cutoff = Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="scrub-label mono">{cutoffLabel}</span>
        {#if cutoff !== null}
          <button type="button" class="scrub-live" onclick={() => (cutoff = null)}>live</button>
        {/if}
      </div>
    {/if}

    <!-- Text-equivalent: a keyboard-navigable list of the SAME nodes (a11y). -->
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
            data-faded={!inWindow(n)}
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
  .scene.fullscreen {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--color-bg);
    padding: var(--space-4, 1.25rem);
    gap: var(--space-2, 0.5rem);
  }
  .stage {
    position: relative;
    width: 100%;
    height: var(--scene-h, 520px);
  }
  .scene.fullscreen .stage {
    flex: 1;
    height: auto;
  }
  .canvas {
    width: 100%;
    height: 100%;
    display: block;
    background: radial-gradient(circle at 50% 40%, var(--color-surface-overlay), var(--color-surface) 70%);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    touch-action: none;
    cursor: grab;
  }
  .canvas[data-panning='true'] {
    cursor: grabbing;
  }
  .bg {
    fill: transparent;
  }
  .controls {
    position: absolute;
    top: var(--space-2, 0.5rem);
    right: var(--space-2, 0.5rem);
    z-index: 2;
    display: flex;
    gap: 0.25rem;
  }
  .ctl {
    width: 1.9rem;
    height: 1.9rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.95rem;
    color: var(--color-text-2);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
    transition: border-color 0.14s ease, color 0.14s ease;
  }
  .ctl:hover {
    border-color: var(--color-accent);
    color: var(--color-text);
  }
  .ctl:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .inspector-wrap {
    position: absolute;
    top: var(--space-2, 0.5rem);
    left: var(--space-2, 0.5rem);
    z-index: 2;
    width: min(20rem, calc(100% - 1rem));
    max-height: calc(100% - 1rem);
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
  .edge[data-kind='references'] { stroke: var(--color-accent-muted, var(--color-border)); }
  .edge[data-kind='agent'] { stroke-dasharray: 3 3; }
  /* S4 — the SELF node's "knows-about" links to its dominant concepts (identity → knowledge). */
  .edge[data-kind='knows'] { stroke: var(--color-accent); stroke-dasharray: 5 3; opacity: 0.7; }
  /* S3 cognitive edges — extracted-from (concept provenance), retrieved / grounded-on (recall),
     supersedes + the concept hierarchy kinds. Each gets a distinct token stroke + dash signature. */
  .edge[data-kind='extracted-from'] { stroke: var(--color-tier-opus); stroke-dasharray: 4 2; }
  .edge[data-kind='retrieved'] { stroke: var(--color-info); stroke-dasharray: 1 3; }
  .edge[data-kind='grounded-on'] { stroke: var(--color-success); }
  .edge[data-kind='supersedes'] { stroke: var(--color-warn); stroke-dasharray: 6 3; }
  .edge[data-kind='related_to'],
  .edge[data-kind='narrower'],
  .edge[data-kind='broader'] { stroke: var(--color-tier-opus); }
  .edge[data-active='true'] {
    stroke: var(--color-accent);
    opacity: 1;
  }
  .edge[data-faded='true'] {
    opacity: 0.08;
  }

  /* Nodes — color FAMILY + SHAPE by class, status by data-status (TOKENS only). */
  .node {
    transform-box: fill-box;
    cursor: pointer;
  }
  .bubble {
    stroke: var(--color-surface);
    stroke-width: 1;
  }
  /* memory family → accent; job family → status-colored (load-bearing); project → rust; agent → blue. */
  .node[data-class='memory'] .bubble { fill: var(--color-accent); }
  .node[data-class='job'][data-status='active'] .bubble { fill: var(--color-running); }
  .node[data-class='job'][data-status='pending'] .bubble { fill: var(--color-info); }
  .node[data-class='job'][data-status='done'] .bubble { fill: var(--color-success); }
  .node[data-class='job'][data-status='failed'] .bubble { fill: var(--color-warn); }
  .node[data-class='project'] .bubble { fill: var(--color-blocked); }
  .node[data-class='agent'] .bubble { fill: var(--color-info); }
  /* S3 cognitive families — concept → opus purple (semantic anchor); causal → amber; skill →
     green (graduated); correction → red (high-importance fix). Distinct from the four above. */
  .node[data-class='concept'] .bubble { fill: var(--color-tier-opus); }
  .node[data-class='causal'] .bubble { fill: var(--color-warn); }
  .node[data-class='skill'] .bubble { fill: var(--color-success); }
  .node[data-class='correction'] .bubble { fill: var(--color-error); }
  /* S4 SELF — the identity anchor. Accent core (the app's own colour) with a concentric maturity
     halo (stroke = stage: nascent→neutral, developing→running, established→success). */
  .node[data-class='self'] .bubble { fill: var(--color-accent); stroke: var(--color-surface); stroke-width: 1.5; }
  .node[data-class='self'] .core { fill: var(--color-on-accent); opacity: 0.85; }
  .node[data-class='self'] .halo { fill: none; stroke: var(--color-neutral); stroke-width: 2.5; }
  .node[data-class='self'][data-status='developing'] .halo { stroke: var(--color-running); }
  .node[data-class='self'][data-status='established'] .halo { stroke: var(--color-success); }
  /* A living identity gently breathes once it has begun to develop (reduced-motion disables it). */
  .node[data-class='self'][data-status='developing'] .halo,
  .node[data-class='self'][data-status='established'] .halo {
    animation: scene-node-pulse 2.4s ease-in-out infinite;
  }
  .node[data-status='dim'] .bubble {
    fill: var(--color-text-muted);
    opacity: 0.5;
  }

  /* Status ring (project/agent carry status via the stroke; job carries it via fill). */
  .node[data-class='project'][data-status='active'] .bubble,
  .node[data-class='agent'][data-status='active'] .bubble,
  .node[data-class='concept'][data-status='active'] .bubble {
    stroke: var(--color-running);
    stroke-width: 2;
  }
  .node[data-class='project'][data-status='idle'] .bubble,
  .node[data-class='agent'][data-status='idle'] .bubble {
    stroke: var(--color-neutral);
    stroke-width: 1.5;
  }
  .node[data-class='project'][data-status='dim'] .bubble {
    opacity: 0.5;
  }

  /* Live status pulse for running nodes (disabled under reduced-motion). */
  .node[data-status='active'] .bubble {
    animation: scene-node-pulse 1.9s ease-in-out infinite;
  }

  .node[data-focus='true'] .bubble {
    stroke: var(--color-accent);
    stroke-width: 2.5;
  }
  .node[data-neighbour='true'] .bubble {
    stroke: var(--color-accent-muted);
    stroke-width: 1.5;
  }
  .node[data-pinned='true'] .bubble {
    stroke-dasharray: 2 2;
  }
  .node[data-dim='true'] {
    opacity: 0.3;
  }
  .node[data-faded='true'] {
    opacity: 0.12;
    pointer-events: none;
  }

  @keyframes scene-node-pulse {
    0%, 100% { stroke-opacity: 0.85; }
    50% { stroke-opacity: 0.2; }
  }

  /* Timeline scrubber. */
  .scrubber {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .scrub-range {
    flex: 1;
    min-width: 10rem;
    accent-color: var(--color-accent);
  }
  .scrub-label {
    font-size: 0.66rem;
    color: var(--color-text-muted);
  }
  .scrub-live {
    font-size: 0.66rem;
    color: var(--color-text-2);
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }
  .scrub-live:hover {
    border-color: var(--color-accent);
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
  .scene.fullscreen .legend {
    max-height: 9rem;
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
  .legend-node[data-faded='true'] {
    opacity: 0.35;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: none;
  }
  .dot[data-class='memory'] { background: var(--color-accent); }
  .dot[data-class='job'][data-status='active'] { background: var(--color-running); }
  .dot[data-class='job'][data-status='pending'] { background: var(--color-info); }
  .dot[data-class='job'][data-status='done'] { background: var(--color-success); }
  .dot[data-class='job'][data-status='failed'] { background: var(--color-warn); }
  .dot[data-class='project'] { background: var(--color-blocked); border-radius: 2px; }
  .dot[data-class='agent'] { background: var(--color-info); border-radius: 2px; transform: rotate(45deg); }
  /* S3 cognitive legend dots — distinct color + shape echo of the scene bubbles. */
  .dot[data-class='concept'] { background: var(--color-tier-opus); border-radius: 3px; }
  .dot[data-class='causal'] { background: var(--color-warn); }
  .dot[data-class='skill'] { background: var(--color-success); border-radius: 2px; transform: rotate(45deg); }
  .dot[data-class='correction'] { background: var(--color-error); }
  /* S4 SELF legend dot — accent core with a maturity ring echo. */
  .dot[data-class='self'] { background: var(--color-accent); box-shadow: 0 0 0 1.5px var(--color-neutral); }
  .dot[data-class='self'][data-status='developing'] { box-shadow: 0 0 0 1.5px var(--color-running); }
  .dot[data-class='self'][data-status='established'] { box-shadow: 0 0 0 1.5px var(--color-success); }
  .dot[data-status='dim'] { background: var(--color-text-muted); }
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
    .node[data-status='active'] .bubble {
      animation: none;
    }
    .node[data-class='self'] .halo {
      animation: none;
    }
  }
</style>
