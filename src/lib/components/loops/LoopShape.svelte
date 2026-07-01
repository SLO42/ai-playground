<script lang="ts">
  /**
   * LoopShape — the first-class loop-shape VISUAL for the per-loop detail page (/loops/[identifier];
   * operator directive 2026-06-29 "Loops = first-class · visuals"). Renders the loop's SHAPE as a cyclic
   * strip of its six primitives (goal → trigger → action → check → state → handoff, looping back) plus the
   * L1→L2→L3 maturity ladder. HONEST (F-008): a primitive is "satisfied" ONLY when its readiness item is
   * checked (derived in loop-shape-core), rendered as not-yet-satisfied otherwise — never fabricated as
   * done. Live details (cadence / tick window / state) come straight off the honest view, or show nothing.
   * A bounded CSS/token visual (no viz lib) — a richer canvas is a follow-up. Svelte 5 runes; tokens only;
   * reduced-motion safe (no essential motion); a11y (satisfied state carried by text + aria, not color).
   */
  import { loopPrimitives, loopLadder, shapeSatisfied, type ShapeSource } from './loop-shape-core';
  import type { ChecklistState } from './readiness-core';

  let {
    source,
    checklist = null
  }: { source: ShapeSource; checklist?: ChecklistState | null } = $props();

  const primitives = $derived(loopPrimitives(source, checklist));
  const ladder = $derived(loopLadder(source.phase));
  const satisfied = $derived(shapeSatisfied(primitives));
  const total = $derived(primitives.length);
</script>

<section class="ls" aria-label="loop shape">
  <div class="ls-head">
    <span class="ls-title">loop shape</span>
    <span class="ls-summary" data-tone={satisfied === total ? 'done' : satisfied === 0 ? 'idle' : 'partial'}>
      {satisfied}/{total} primitives satisfied
    </span>
  </div>

  <ol class="ls-strip" aria-label="loop primitives">
    {#each primitives as p, i (p.key)}
      <li class="ls-node" data-sat={p.satisfied} aria-label={`${p.label}: ${p.satisfied ? 'satisfied' : 'not yet satisfied'}`}>
        <span class="ls-badge" data-sat={p.satisfied} aria-hidden="true">{p.satisfied ? '✓' : '○'}</span>
        <span class="ls-node-label">{p.label}</span>
        <span class="ls-node-blurb">{p.blurb}</span>
        {#if p.detail}
          <span class="ls-node-detail" title={p.detail}>{p.detail}</span>
        {/if}
        <span class="ls-node-status" data-sat={p.satisfied}>{p.satisfied ? 'satisfied' : 'not yet'}</span>
        {#if i < primitives.length - 1}
          <span class="ls-arrow" aria-hidden="true">→</span>
        {:else}
          <span class="ls-arrow loopback" aria-hidden="true" title="loops back to goal">↩</span>
        {/if}
      </li>
    {/each}
  </ol>

  <div class="ls-ladder" aria-label="maturity ladder">
    <span class="ls-ladder-label">maturity</span>
    {#if ladder.applicable}
      <ol class="ls-rungs">
        {#each ladder.rungs as r (r.key)}
          <li
            class="ls-rung"
            data-active={r.active}
            data-reached={r.reached}
            title={r.title}
            aria-current={r.active ? 'step' : undefined}
            aria-label={`${r.label}${r.active ? ' — current' : r.reached ? ' — reached' : ''}`}
          >
            {r.label}
          </li>
        {/each}
      </ol>
    {:else}
      <span class="ls-ladder-na">ladder does not apply to this loop</span>
    {/if}
  </div>
</section>

<style>
  .ls {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card);
  }
  .ls-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .ls-title {
    font-size: var(--text-xs, 0.68rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .ls-summary {
    font-size: var(--text-xs, 0.72rem);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text-muted);
  }
  .ls-summary[data-tone='done'] { color: var(--color-success); }
  .ls-summary[data-tone='partial'] { color: var(--color-warn); }

  .ls-strip {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: var(--space-2);
  }
  .ls-node {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 8rem;
    min-width: 7.5rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-overlay);
  }
  .ls-node[data-sat='true'] {
    border-color: var(--color-success);
    background: var(--color-success-bg, var(--color-surface-overlay));
  }
  .ls-node[data-sat='false'] {
    border-style: dashed;
  }
  .ls-badge {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .ls-badge[data-sat='true'] { color: var(--color-success); }
  .ls-node-label {
    font-size: var(--text-sm, 0.82rem);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text);
  }
  .ls-node-blurb {
    font-size: var(--text-xs, 0.7rem);
    color: var(--color-text-muted);
  }
  .ls-node-detail {
    font-size: var(--text-xs, 0.72rem);
    font-family: var(--font-mono);
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ls-node-status {
    font-size: var(--text-xs, 0.66rem);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  .ls-node-status[data-sat='true'] { color: var(--color-success); }
  /* The connector between primitives — decorative; hidden on wrap-narrow via aria-hidden already. */
  .ls-arrow {
    position: absolute;
    right: calc(-1 * var(--space-2));
    top: 50%;
    transform: translate(50%, -50%);
    color: var(--color-text-muted);
    font-size: 0.8rem;
    pointer-events: none;
  }
  .ls-arrow.loopback { color: var(--color-text-link); }

  .ls-ladder {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    border-top: 1px solid var(--color-border-faint, var(--color-border));
    padding-top: var(--space-3);
  }
  .ls-ladder-label {
    font-size: var(--text-xs, 0.68rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .ls-rungs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: var(--space-2);
  }
  .ls-rung {
    font-size: var(--text-xs, 0.72rem);
    font-weight: var(--weight-semibold, 600);
    padding: 2px var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
  }
  .ls-rung[data-reached='true'] { color: var(--color-text); border-color: var(--color-text-muted); }
  .ls-rung[data-active='true'] {
    color: var(--color-text-accent, var(--color-accent));
    border-color: var(--color-accent);
    background: var(--color-surface-card);
  }
  .ls-ladder-na {
    font-size: var(--text-xs, 0.72rem);
    color: var(--color-text-muted);
  }
</style>
