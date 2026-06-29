<script lang="ts">
  /**
   * LoopCard — one recurring autonomous loop, IDENTIFIED and reviewable (Loops Phase 1 = view +
   * identify; LOOP-ENGINEERING.md). Renders the stable identifier (name + per-kind icon + L1/L2/L3
   * phase badge + a live status dot via the LP-1 LoopTone), the cadence, the honest last-run (relative
   * or '—'/'not yet run'), the next cron fire, the tick window if any, and a collapsed-by-default
   * recent-run history. Every value comes from the honest LoopView (F-008) — an absent time renders
   * '—', never a fabricated one. The run details are ALREADY screened server-side by LP-1 (D-026);
   * this component only displays them. Svelte 5 runes; design tokens only; a11y (status text not color
   * alone, decorative glyphs aria-hidden, an explicit expander label + aria-expanded).
   */
  import type { LoopView } from '$lib/server/loops/read';
  import {
    kindMeta,
    phaseMeta,
    lastRunLabel,
    tracksRunHistory,
    ticksLabel,
    relativeTime,
    nextFireLabel
  } from './loop-card-core';
  import LoopControls from './LoopControls.svelte';

  // `editable` opts the card into the Phase-2 in-UI controls (cadence editor / pause toggle). Only the
  // Loops surfaces that host the matching `?/pmSchedule` + `?/pmAutonomous` form actions pass it true;
  // default false keeps the card a pure view everywhere else.
  let { loop, editable = false }: { loop: LoopView; editable?: boolean } = $props();

  let expanded = $state(false);

  const meta = $derived(kindMeta(loop.kind));
  const phase = $derived(phaseMeta(loop.phase));
  const ticks = $derived(ticksLabel(loop));
  const hasHistory = $derived(tracksRunHistory(loop));
  const runCount = $derived(loop.recentRuns.length);
  // Only the two NO-restart DB-MERGE loops have an editable control here (orchestrator/memory-review
  // show none — the orchestrator mode is the D-010 confirm flow on /settings).
  const hasControls = $derived(loop.kind === 'pm-cadence' || loop.kind === 'pm-autonomous');
</script>

<article class="loop-card" data-tone={loop.tone} aria-labelledby="loop-name-{loop.id}">
  <header class="lc-head">
    <span class="lc-icon" data-kind={meta.icon} role="img" aria-label={meta.srLabel}>
      <!-- decorative glyph; the role/label above carries the meaning -->
      {#if meta.icon === 'orchestrator'}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M13 4.5A6 6 0 1 0 14 8M13 1.5v3h-3" /></svg>
      {:else if meta.icon === 'pm-autonomous'}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6 4l6 4-6 4z" /></svg>
      {:else if meta.icon === 'pm-cadence'}
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" /><path stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M8 4.5V8l2.5 1.6" /></svg>
      {:else}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M8 2.5C5.5 2.5 4 4 4 6c0 1 .4 1.7 1 2.3C4.4 9 4 9.8 4 11c0 2 1.6 3 4 3s4-1 4-3c0-1.2-.4-2-1-2.7.6-.6 1-1.3 1-2.3 0-2-1.5-3.5-4-3.5Z" /></svg>
      {/if}
    </span>
    <div class="lc-titles">
      <h3 class="lc-name" id="loop-name-{loop.id}">{loop.name}</h3>
      <span class="lc-id mono">{loop.id}</span>
    </div>
    <span class="lc-phase" data-phase={loop.phase} title={phase.title} aria-label="maturity {phase.title}">
      {phase.text}
    </span>
  </header>

  <div class="lc-status">
    <span class="lc-dot" data-tone={loop.tone} aria-hidden="true"></span>
    <span class="lc-state" data-tone={loop.tone}>{loop.stateLabel}</span>
  </div>

  <dl class="lc-facts">
    <div class="lc-fact">
      <dt>cadence</dt>
      <dd>{loop.cadenceLabel}</dd>
    </div>
    <div class="lc-fact">
      <dt>last run</dt>
      <dd data-muted={!loop.lastRunAt}>{lastRunLabel(loop)}</dd>
    </div>
    {#if loop.nextFireAt}
      <div class="lc-fact">
        <dt>next fire</dt>
        <dd title={loop.nextFireAt}>{nextFireLabel(loop.nextFireAt)}</dd>
      </div>
    {/if}
    {#if ticks}
      <div class="lc-fact">
        <dt>re-ticks</dt>
        <dd class="tnum">{ticks}<span class="lc-unit"> this window</span></dd>
      </div>
    {/if}
  </dl>

  {#if hasHistory}
    <div class="lc-history">
      <button
        type="button"
        class="lc-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide recent runs' : `Show ${runCount} recent runs`}
        onclick={() => (expanded = !expanded)}
      >
        <span class="lc-toggle-caret" data-open={expanded} aria-hidden="true">›</span>
        recent runs
        <span class="lc-runcount mono" aria-hidden="true">{runCount}</span>
      </button>
      {#if expanded}
        {#if runCount === 0}
          <p class="lc-empty">No runs recorded yet.</p>
        {:else}
          <ul class="lc-runs">
            {#each loop.recentRuns as run, i (i)}
              <li class="lc-run">
                <span class="lc-run-outcome" data-outcome={run.outcome}>{run.outcome}</span>
                <span class="lc-run-detail" title={run.detailScreened || undefined}>
                  {#if run.detailScreened}{run.detailScreened}{:else}<span class="lc-run-none">no detail</span>{/if}
                </span>
                <span class="lc-run-when">{relativeTime(run.at)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}

  {#if editable && hasControls}
    <LoopControls {loop} />
  {/if}
</article>

<style>
  .loop-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card);
  }
  /* Tone tints the left edge — the text label/dot carry the meaning, color reinforces (never alone). */
  .loop-card[data-tone='running'] { border-left: 3px solid var(--color-running); }
  .loop-card[data-tone='done'] { border-left: 3px solid var(--color-success); }
  .loop-card[data-tone='blocked'] { border-left: 3px solid var(--color-blocked); }
  .loop-card[data-tone='warning'] { border-left: 3px solid var(--color-warn); }

  .lc-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }
  .lc-icon {
    flex: 0 0 auto;
    color: var(--color-text-muted);
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
  }
  .lc-icon svg { width: 100%; height: 100%; }
  .lc-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .lc-name {
    font: var(--type-h3);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lc-id {
    font-size: var(--text-xs, 0.7rem);
    color: var(--color-text-muted);
  }
  .lc-phase {
    flex: 0 0 auto;
    font-size: var(--text-xs, 0.7rem);
    font-weight: var(--weight-semibold, 600);
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
  }
  .lc-phase[data-phase='L3'] { color: var(--color-text-accent, var(--color-accent)); border-color: var(--color-accent); }
  .lc-phase[data-phase='L2'] { color: var(--color-text); }

  .lc-status { display: inline-flex; align-items: center; gap: var(--space-2); }
  .lc-dot {
    width: 8px; height: 8px; border-radius: var(--radius-pill);
    background: var(--color-neutral); flex: 0 0 auto;
  }
  .lc-dot[data-tone='running'] {
    background: var(--color-running);
    animation: lc-pulse var(--motion-slow, 1.6s) ease-in-out infinite;
  }
  .lc-dot[data-tone='done'] { background: var(--color-success); }
  .lc-dot[data-tone='blocked'] { background: var(--color-blocked); }
  .lc-dot[data-tone='warning'] { background: var(--color-warn); }
  @keyframes lc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .lc-dot { animation: none; } }
  .lc-state {
    font-size: var(--text-sm, 0.82rem);
    color: var(--color-text-2);
  }
  .lc-state[data-tone='running'] { color: var(--color-running-on-overlay, var(--color-running)); }
  .lc-state[data-tone='blocked'] { color: var(--color-blocked-on-overlay); }
  .lc-state[data-tone='warning'] { color: var(--color-error-on-overlay); }
  .lc-state[data-tone='done'] { color: var(--color-success-on-overlay, var(--color-success)); }

  .lc-facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--space-3);
    margin: 0;
  }
  .lc-fact { display: flex; flex-direction: column; gap: 2px; }
  .lc-fact dt {
    font-size: var(--text-xs, 0.68rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .lc-fact dd {
    margin: 0;
    font-size: var(--text-sm, 0.82rem);
    color: var(--color-text);
  }
  .lc-fact dd[data-muted='true'] { color: var(--color-text-muted); }
  .lc-unit { color: var(--color-text-muted); font-size: var(--text-xs, 0.7rem); }
  .mono { font-family: var(--font-mono); }

  .lc-history { border-top: 1px solid var(--color-border-faint, var(--color-border)); padding-top: var(--space-2); }
  .lc-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    background: none;
    border: none;
    padding: var(--space-1) 0;
    cursor: pointer;
    font-size: var(--text-xs, 0.72rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .lc-toggle:hover { color: var(--color-text); }
  .lc-toggle:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 2px; border-radius: var(--radius-sm); }
  .lc-toggle-caret { transition: transform var(--motion-fast, 120ms) var(--ease-out); }
  .lc-toggle-caret[data-open='true'] { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .lc-toggle-caret { transition: none; } }
  .lc-runcount { color: var(--color-text-muted); }

  .lc-empty { font-size: var(--text-sm, 0.82rem); color: var(--color-text-muted); margin: var(--space-2) 0 0; }
  .lc-runs { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: flex; flex-direction: column; }
  .lc-run {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
  }
  .lc-run:last-child { border-bottom: none; }
  .lc-run-outcome {
    font-size: var(--text-xs, 0.68rem);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text-muted);
    min-width: 5.5rem;
  }
  .lc-run-outcome[data-outcome='completion'] { color: var(--color-success); }
  .lc-run-outcome[data-outcome='spawn'] { color: var(--color-running); }
  .lc-run-outcome[data-outcome='error'],
  .lc-run-outcome[data-outcome='escalation'] { color: var(--color-error); }
  .lc-run-detail {
    flex: 1;
    min-width: 0;
    font-size: var(--text-xs, 0.74rem);
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lc-run-none { color: var(--color-text-muted); font-style: italic; }
  .lc-run-when {
    font-size: var(--text-xs, 0.7rem);
    color: var(--color-text-muted);
    margin-left: auto;
    white-space: nowrap;
  }
</style>
