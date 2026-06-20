<script lang="ts">
  /**
   * LiveBadge — an honest, tokens-only signal that a live region's feed is DEGRADED
   * (UI-SPEC §1.3/§7, F-008). The browser's SSE socket being open does NOT prove a
   * given table's server-side LIVE subscription is still feeding it; when that
   * subscription reconnects/dies the server emits `live_status` and
   * `stream.tableLiveness(table)` flips. This badge renders that phase so the operator
   * SEES "live: reconnecting / disconnected" instead of frozen rows shown as current.
   *
   * Silent when cleanly 'live' (no chrome on a healthy region). role="status" + a text
   * label (not color alone) for a11y. Svelte 5 runes only; design tokens only.
   */
  import { liveBadgeView, type LivenessPhase } from '$lib/client/live-badge-core';

  let { phase }: { phase: LivenessPhase } = $props();

  const view = $derived(liveBadgeView(phase));
</script>

{#if view.show}
  <span class="live-badge" data-variant={view.variant} role="status" aria-label={view.label}>
    <span class="dot" aria-hidden="true"></span>
    <span class="label">{view.label}</span>
  </span>
{/if}

<style>
  .live-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    line-height: 1;
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-pill);
    background: var(--color-neutral);
    flex: 0 0 auto;
  }
  /* Variant colors — token-backed; the text label carries the meaning, the dot/border
     reinforce it (never color alone). */
  .live-badge[data-variant='warn'] {
    color: var(--color-warn);
    border-color: var(--color-warn);
    background: var(--color-warn-bg);
  }
  .live-badge[data-variant='warn'] .dot {
    background: var(--color-warn);
  }
  .live-badge[data-variant='error'] {
    color: var(--color-error);
    border-color: var(--color-error);
    background: var(--color-error-bg);
  }
  .live-badge[data-variant='error'] .dot {
    background: var(--color-error);
  }
  .live-badge[data-variant='neutral'] .dot {
    background: var(--color-neutral);
  }
  /* A subtle pulse while reconnecting; zeroed under reduced-motion at the token layer
     (motion vars collapse to 0), and we also explicitly disable it for safety. */
  .live-badge[data-variant='warn'] .dot {
    animation: live-pulse var(--motion-slow, 1.6s) ease-in-out infinite;
  }
  @keyframes live-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live-badge .dot {
      animation: none;
    }
  }
</style>
