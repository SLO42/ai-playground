<script lang="ts">
  /**
   * CC-STATUS — the project command-center STATUS dashboard (the top of /projects/[id]).
   *
   * The ONE at-a-glance view of a single project's state, so the operator never hunts across
   * /projects/[id] · /claude-code · /atelier to answer "what's happening here?". Everything is
   * derived LIVE from real rows the loader already fetched (F-008 — no fabricated %/progress):
   *   (1) name + status + the DoD/version target
   *   (2) the TASK PIPELINE funnel (proposed→backlog→ready→in_progress→review→done) + blocked/failed
   *   (3) the AUTONOMOUS-LOOP state as a prominent colored badge (data.autonomousLoop)
   *   (4) today's spawn-cap usage (N / dailyCap, or "no cap enforced" — the honest live reality)
   *   (5) running sessions for THIS project + recently-failed (with the MC-4 honest reasons)
   *
   * Honest empties throughout: no PM → "no PM"; no tasks → an honest empty pipeline; the loop not
   * engaged → "not engaged", never a fake 'running'. Svelte 5 RUNES only; design TOKENS only.
   */
  import SessionFailureReason from '$lib/components/shell/SessionFailureReason.svelte';
  import {
    buildPipeline,
    loopBadge,
    summarizeSessions,
    type TaskLike,
    type SessionLike,
    type LoopStateLike
  } from './project-status-core';

  interface QueueLike {
    spawnsToday: number;
    capped: boolean;
    dailyCap?: number;
    capRemaining?: number;
    throttled: boolean;
  }

  interface PmLike {
    name: string;
    authority?: string;
  }

  interface Props {
    /** The project's display name (the headline). */
    name: string;
    /** The project's status column (DATA-MODEL §4.1) — rendered as the status pill. */
    status: string;
    /** The plan's Definition of Done text, or undefined (the DoD target line). */
    definitionOfDone?: string | undefined;
    /** The live task rows (loader TaskSummary[]) — drives the pipeline funnel. */
    tasks: readonly TaskLike[];
    /** The live session rows for THIS project (loader FleetSession[]). */
    sessions: readonly SessionLike[];
    /** The autonomous loop's honest last-state for this project, or null (not engaged). */
    loop: LoopStateLike | null;
    /** Headline work-queue stats (today's spawns vs the real D-021 cap), or null (degraded boot). */
    queue: QueueLike | null;
    /** The hired PM, or null (the honest "no PM" state). */
    pm: PmLike | null;
  }

  let {
    name,
    status,
    definitionOfDone = undefined,
    tasks,
    sessions,
    loop,
    queue,
    pm
  }: Props = $props();

  // All visual models are PURE derivations of the live rows (project-status-core) — no fabricated values.
  const pipeline = $derived(buildPipeline(tasks));
  const badge = $derived(loopBadge(loop));
  const sessionSummary = $derived(summarizeSessions(sessions));
</script>

<section class="status-board card" aria-label="project status">
  <!-- (1) name + status + DoD target -->
  <header class="board-head">
    <div class="head-id">
      <span class="eyebrow">status</span>
      <h2 class="board-name">{name}</h2>
      <span class="status" data-status={status}>{status}</span>
    </div>
    <p class="dod" class:muted={!definitionOfDone}>
      <span class="dod-label">Target (DoD)</span>
      {#if definitionOfDone}{definitionOfDone}{:else}<span class="dash">— not set</span>{/if}
    </p>
  </header>

  <div class="board-grid">
    <!-- (3) autonomous-loop state — the prominent colored badge -->
    <div class="tile loop-tile" data-tone={badge.tone}>
      <span class="tile-label">Autonomous loop</span>
      <span class="loop-badge" data-tone={badge.tone}>{badge.label}</span>
      {#if badge.notEngaged}
        <p class="tile-note muted">The PM is not driving this project autonomously.</p>
      {:else}
        <p class="tile-note">
          {#if badge.reason}{badge.reason}{:else}<span class="dash">no reason recorded</span>{/if}
        </p>
        {#if badge.ticksUsed !== null}
          <span class="tile-sub mono">{badge.ticksUsed} re-tick{badge.ticksUsed === 1 ? '' : 's'} this window</span>
        {/if}
      {/if}
    </div>

    <!-- (4) spawn-cap usage today (N / dailyCap) — the honest live reality -->
    <div class="tile budget-tile" data-throttled={queue?.throttled ? 'true' : 'false'}>
      <span class="tile-label">Spawn budget today</span>
      {#if !queue}
        <span class="tile-figure dash">—</span>
        <p class="tile-note muted">Queue stats unavailable.</p>
      {:else if queue.capped && queue.dailyCap != null}
        <span class="tile-figure mono">{queue.spawnsToday} <span class="of">/ {queue.dailyCap}</span></span>
        <p class="tile-note">
          {queue.capRemaining ?? 0} remaining
          {#if queue.throttled}<span class="throttle">· throttled</span>{/if}
        </p>
      {:else}
        <span class="tile-figure mono">{queue.spawnsToday}</span>
        <p class="tile-note muted">spawned today · no cap enforced</p>
      {/if}
    </div>

    <!-- (5) running + recently-failed sessions for THIS project -->
    <div class="tile sessions-tile">
      <span class="tile-label">Sessions</span>
      <div class="session-figs">
        <span class="fig">
          <span class="fig-n mono" data-tone={sessionSummary.running > 0 ? 'running' : 'idle'}>{sessionSummary.running}</span>
          <span class="fig-l">running</span>
        </span>
        <span class="fig">
          <span class="fig-n mono" data-tone={sessionSummary.failed > 0 ? 'blocked' : 'idle'}>{sessionSummary.failed}</span>
          <span class="fig-l">failed</span>
        </span>
      </div>
      {#if sessionSummary.failures.length > 0}
        <ul class="fail-list" aria-label="recent session failures">
          {#each sessionSummary.failures as f, i (i)}
            <li><SessionFailureReason status="failed" note={f.note} variant="row" /></li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- PM identity — honest "no PM" empty -->
    <div class="tile pm-tile">
      <span class="tile-label">Project manager</span>
      {#if pm}
        <span class="tile-figure pm-name">{pm.name}</span>
        {#if pm.authority}<span class="tile-sub mono">authority: {pm.authority}</span>{/if}
      {:else}
        <span class="tile-figure dash">no PM</span>
        <p class="tile-note muted">Hire a PM to plan + drive this project.</p>
      {/if}
    </div>
  </div>

  <!-- (2) the task pipeline funnel -->
  <div class="pipeline" aria-label="task pipeline">
    <div class="pipeline-head">
      <span class="tile-label">Task pipeline</span>
      <span class="tile-sub mono">{pipeline.total} task{pipeline.total === 1 ? '' : 's'}</span>
    </div>
    {#if pipeline.empty}
      <p class="tile-note muted">No tasks yet — the funnel is empty.</p>
    {:else}
      <div class="bar" role="img" aria-label={`Task funnel: ${pipeline.segments.map((s) => `${s.count} ${s.status}`).join(', ')}`}>
        {#each pipeline.segments as seg (seg.status)}
          {#if seg.count > 0}
            <span
              class="seg"
              data-status={seg.status}
              style={`flex-grow:${seg.count}`}
              title={`${seg.count} ${seg.status} (${seg.pct}%)`}
            ></span>
          {/if}
        {/each}
      </div>
      <ul class="legend">
        {#each pipeline.segments as seg (seg.status)}
          <li class:zero={seg.count === 0}>
            <span class="swatch" data-status={seg.status} aria-hidden="true"></span>
            <span class="leg-status">{seg.status}</span>
            <span class="leg-count mono">{seg.count}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if pipeline.exceptions.some((e) => e.count > 0)}
      <ul class="exceptions" aria-label="tasks needing attention">
        {#each pipeline.exceptions as ex (ex.status)}
          {#if ex.count > 0}
            <li>
              <span class="status" data-status={ex.status}>{ex.status}</span>
              <span class="mono">{ex.count}</span>
            </li>
          {/if}
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .status-board {
    display: flex;
    flex-direction: column;
    gap: var(--space-6, 20px);
  }

  /* ── header: name + status + DoD ─────────────────────────────────────── */
  .board-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4, 12px);
  }
  .head-id {
    display: flex;
    align-items: baseline;
    gap: var(--space-4, 12px);
    flex-wrap: wrap;
  }
  .eyebrow {
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  .board-name {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--color-text);
  }
  .dod {
    margin: 0;
    flex: 1 1 16rem;
    min-width: 12rem;
    font-size: 0.82rem;
    line-height: 1.4;
    color: var(--color-text-secondary, var(--color-text-muted));
  }
  .dod-label {
    display: block;
    font-size: 0.66rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-muted);
    margin-bottom: 0.1rem;
  }
  .dod.muted {
    color: var(--color-text-muted);
  }

  /* ── tile grid (loop / budget / sessions / pm) ───────────────────────── */
  .board-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: var(--space-4, 12px);
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 4px);
    padding: var(--space-4, 12px);
    border-radius: var(--radius-md, 8px);
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border-faint, var(--color-border));
  }
  .tile-label {
    font-size: 0.66rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }
  .tile-figure {
    font-size: 1.4rem;
    font-weight: 700;
    color: var(--color-text);
    line-height: 1.1;
  }
  .tile-figure .of {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--color-text-muted);
  }
  .tile-note {
    margin: 0;
    font-size: 0.76rem;
    line-height: 1.35;
    color: var(--color-text-secondary, var(--color-text-muted));
  }
  .tile-note.muted,
  .muted {
    color: var(--color-text-muted);
  }
  .tile-sub {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .dash {
    color: var(--color-text-muted);
  }

  /* ── autonomous-loop badge (the prominent colored signal) ────────────── */
  .loop-tile[data-tone='running'] {
    border-color: var(--color-running);
  }
  .loop-tile[data-tone='blocked'] {
    border-color: var(--color-blocked);
  }
  .loop-tile[data-tone='warning'] {
    border-color: var(--warn-500, var(--color-blocked));
  }
  .loop-tile[data-tone='done'] {
    border-color: var(--color-success);
  }
  .loop-badge {
    align-self: flex-start;
    font-size: 0.82rem;
    font-weight: 700;
    padding: 0.18rem 0.6rem;
    border-radius: var(--radius-sm, 6px);
    text-transform: lowercase;
    background: var(--color-surface-card);
    color: var(--color-text-muted);
  }
  .loop-badge[data-tone='running'] {
    color: var(--color-running-on-overlay, var(--color-running));
  }
  .loop-badge[data-tone='blocked'] {
    color: var(--color-blocked-on-overlay);
  }
  .loop-badge[data-tone='warning'] {
    color: var(--color-error-on-overlay);
  }
  .loop-badge[data-tone='done'] {
    color: var(--color-success-on-overlay, var(--color-success));
  }

  /* ── budget tile ─────────────────────────────────────────────────────── */
  .budget-tile[data-throttled='true'] {
    border-color: var(--color-blocked);
  }
  .throttle {
    color: var(--color-blocked-on-overlay);
    font-weight: 600;
  }

  /* ── sessions tile ───────────────────────────────────────────────────── */
  .session-figs {
    display: flex;
    gap: var(--space-6, 20px);
  }
  .fig {
    display: flex;
    flex-direction: column;
  }
  .fig-n {
    font-size: 1.4rem;
    font-weight: 700;
    line-height: 1.1;
    color: var(--color-text);
  }
  .fig-n[data-tone='running'] {
    color: var(--color-running-on-overlay, var(--color-running));
  }
  .fig-n[data-tone='blocked'] {
    color: var(--color-blocked-on-overlay);
  }
  .fig-l {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .fail-list {
    list-style: none;
    margin: var(--space-2, 4px) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 4px);
  }

  .pm-name {
    font-size: 1rem;
    font-weight: 700;
  }

  /* ── pipeline funnel ─────────────────────────────────────────────────── */
  .pipeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 8px);
  }
  .pipeline-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4, 12px);
  }
  .bar {
    display: flex;
    width: 100%;
    height: 0.85rem;
    border-radius: var(--radius-sm, 6px);
    overflow: hidden;
    background: var(--color-surface-overlay);
  }
  .seg {
    min-width: 3px;
    background: var(--color-text-muted);
  }
  .seg[data-status='proposed'] {
    background: var(--color-info-on-overlay);
  }
  .seg[data-status='backlog'] {
    background: var(--color-text-muted);
  }
  .seg[data-status='ready'] {
    background: var(--color-accent);
  }
  .seg[data-status='in_progress'] {
    background: var(--color-running);
  }
  .seg[data-status='review'] {
    background: var(--warn-500, var(--color-accent));
  }
  .seg[data-status='done'] {
    background: var(--color-success);
  }
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3, 8px) var(--space-5, 16px);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.74rem;
    color: var(--color-text-secondary, var(--color-text-muted));
  }
  .legend li.zero {
    opacity: 0.5;
  }
  .swatch {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 2px;
    background: var(--color-text-muted);
    flex: none;
  }
  .swatch[data-status='proposed'] {
    background: var(--color-info-on-overlay);
  }
  .swatch[data-status='backlog'] {
    background: var(--color-text-muted);
  }
  .swatch[data-status='ready'] {
    background: var(--color-accent);
  }
  .swatch[data-status='in_progress'] {
    background: var(--color-running);
  }
  .swatch[data-status='review'] {
    background: var(--warn-500, var(--color-accent));
  }
  .swatch[data-status='done'] {
    background: var(--color-success);
  }
  .leg-status {
    text-transform: lowercase;
  }
  .leg-count {
    color: var(--color-text);
    font-weight: 600;
  }
  .exceptions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4, 12px);
  }
  .exceptions li {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
  }

  /* reuse the page's status-pill tokens locally */
  .status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.12rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    white-space: nowrap;
    flex: none;
  }
  .status[data-status='active'],
  .status[data-status='in_progress'],
  .status[data-status='running'],
  .status[data-status='developing'] {
    color: var(--color-running-on-overlay, var(--color-running));
  }
  .status[data-status='done'],
  .status[data-status='shipped'],
  .status[data-status='released'] {
    color: var(--color-success-on-overlay, var(--color-success));
  }
  .status[data-status='failed'] {
    color: var(--color-error-on-overlay);
  }
  .status[data-status='blocked'] {
    color: var(--color-blocked-on-overlay);
  }

  @media (prefers-reduced-motion: reduce) {
    /* No animations here; declared for policy parity (the board has no motion to suppress). */
    .status-board * {
      transition: none;
    }
  }
</style>
