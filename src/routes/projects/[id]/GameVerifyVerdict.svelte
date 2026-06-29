<script lang="ts">
  /**
   * GAME-VERIFY GV-4 — render ONE persisted game_verify verdict in the project command-center
   * (operator visibility — docs/GAME-VERIFY-SPEC.md §"Orchestrator integration", last bullet).
   *
   * The verdict was produced by the runner (GV-2) and persisted by the orchestrator step (GV-3) as
   * an agent_event; the loader (+page.server.ts) reads + normalizes it into a GameVerifyVerdictRow.
   * This component is PURE DISPLAY: the logTail / stackTraces were ALREADY screened by the runner
   * before persistence (D-026) — it NEVER re-fetches a raw log and NEVER re-screens. Svelte escapes
   * the text content, so no markup can inject here.
   *
   * HONEST states (F-008):
   *   • outcome ∈ pass | errors | not_ready | crashed | timeout | unknown — each gets a distinct,
   *     token-only colored badge (pass=success, errors/crashed=error, timeout/not_ready=warn,
   *     unknown=muted). not_ready / timeout / crashed / unknown are NEVER shown as a pass.
   *   • the log tail + stack traces are COLLAPSED by default behind native <details> (keyboard-
   *     operable, focus-visible) — expanded on demand; nothing is hidden, nothing fabricated.
   */
  import { relativeTime, absoluteTime } from '$lib/client/time-format';
  import type { GameVerifyVerdictRow } from '$lib/server/orchestrator/game-verify-read';

  interface Props {
    verdict: GameVerifyVerdictRow;
    /** Live clock (ms) for the relative timestamp — the parent already maintains it. */
    now: number;
  }

  let { verdict, now }: Props = $props();

  // pass is the ONLY success; everything else is an honest non-pass. The badge label is the raw
  // outcome (lowercased by the .status token style) so the operator reads exactly what was recorded.
  const isPass = $derived(verdict.outcome === 'pass');
  // by_pattern → a stable sorted entry list for rendering (counts the runner recorded per pattern).
  const patternEntries = $derived(Object.entries(verdict.byPattern).sort((a, b) => a[0].localeCompare(b[0])));
  const hasLogTail = $derived(verdict.logTail.trim().length > 0);
  const hasStacks = $derived(verdict.stackTraces.length > 0);
</script>

<div class="gv-verdict" data-outcome={verdict.outcome}>
  <div class="gv-head">
    <span class="status" data-outcome={verdict.outcome}>{verdict.outcome}</span>
    <span class="gv-meta mono">
      {#if verdict.ready}ready{:else}not&nbsp;ready{/if}
      · {#if verdict.loaded}loaded{:else}not&nbsp;loaded{/if}
      · {verdict.errorCount} error{verdict.errorCount === 1 ? '' : 's'}
    </span>
    <span class="gv-when mono" title={absoluteTime(verdict.at)}>
      {verdict.at ? relativeTime(verdict.at, now) : '—'}
    </span>
  </div>

  {#if patternEntries.length > 0}
    <ul class="gv-patterns" aria-label="pattern match counts">
      {#each patternEntries as [pattern, count] (pattern)}
        <li class="gv-pattern">
          <span class="gv-pattern-name mono">{pattern}</span>
          <span class="gv-pattern-count mono">{count}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if verdict.note}
    <p class="gv-note">{verdict.note}</p>
  {/if}

  {#if hasStacks}
    <details class="gv-detail">
      <summary>stack traces ({verdict.stackTraces.length})</summary>
      {#each verdict.stackTraces as trace, i (i)}
        <pre class="gv-trace mono">{trace}</pre>
      {/each}
    </details>
  {/if}

  {#if hasLogTail}
    <details class="gv-detail">
      <summary>log tail</summary>
      <pre class="gv-log mono">{verdict.logTail}</pre>
    </details>
  {/if}

  {#if !hasStacks && !hasLogTail && !isPass}
    <p class="gv-empty">No log captured for this run.</p>
  {/if}
</div>

<style>
  .gv-verdict {
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    background: var(--color-surface-overlay);
    border-left: 3px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    margin-top: var(--space-2, 0.5rem);
  }
  /* Outcome → honest tone (design tokens only — no invented colors). */
  .gv-verdict[data-outcome='pass'] {
    border-left-color: var(--color-success);
  }
  .gv-verdict[data-outcome='errors'],
  .gv-verdict[data-outcome='crashed'] {
    border-left-color: var(--color-error);
  }
  .gv-verdict[data-outcome='timeout'],
  .gv-verdict[data-outcome='not_ready'] {
    border-left-color: var(--color-warn);
  }
  .gv-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
  }
  /* The badge: mirror the page .status chip, with the on-overlay (BODY-AA) tone per outcome. */
  .status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.12rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-bg);
    text-transform: lowercase;
    white-space: nowrap;
    flex: none;
  }
  .status[data-outcome='pass'] {
    color: var(--color-success);
  }
  .status[data-outcome='errors'],
  .status[data-outcome='crashed'] {
    color: var(--color-error-on-overlay);
  }
  .status[data-outcome='timeout'],
  .status[data-outcome='not_ready'] {
    color: var(--color-warn-on-overlay);
  }
  .gv-meta {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .gv-when {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .gv-patterns {
    list-style: none;
    margin: var(--space-2, 0.5rem) 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
  }
  .gv-pattern {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1, 0.25rem);
    font-size: 0.72rem;
  }
  .gv-pattern-name {
    color: var(--color-text-muted);
  }
  /* Per-pattern counts stay neutral: byPattern mixes success + error patterns, so coloring any
     nonzero as an error would be misleading (F-008). The outcome badge + errorCount carry the
     error signal honestly. */
  .gv-pattern-count {
    font-weight: 700;
    color: var(--color-text);
  }
  .gv-note {
    margin: var(--space-2, 0.5rem) 0 0;
    font-size: 0.72rem;
    color: var(--color-text);
    word-break: break-word;
  }
  .gv-detail {
    margin-top: var(--space-2, 0.5rem);
  }
  .gv-detail > summary {
    cursor: pointer;
    width: fit-content;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    border-radius: var(--radius-sm, 6px);
  }
  .gv-detail > summary:hover {
    color: var(--color-text);
  }
  .gv-detail > summary:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }
  .gv-trace,
  .gv-log {
    margin: var(--space-1, 0.25rem) 0 0;
    padding: var(--space-2, 0.5rem);
    background: var(--color-bg);
    border-radius: var(--radius-sm, 6px);
    font-size: 0.7rem;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
  .gv-empty {
    margin: var(--space-2, 0.5rem) 0 0;
    font-size: 0.72rem;
    color: var(--color-text-muted);
    font-style: italic;
  }
</style>
