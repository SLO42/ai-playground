<script lang="ts">
  /**
   * Statusbar — services health · active agents · token/cost ticker ·
   * orchestration mode (UI-SPEC §3, "always-on awareness" strip). Wired to LIVE
   * data via the root layout (+layout.server.ts → analytics rollup, over the one
   * SSE stream). A metric with no real source yet renders an honest "—" (F-008 —
   * never fabricate a plausible-looking number); `null` is the unknown sentinel.
   */
  let {
    services = 'unknown',
    activeAgents = null,
    tokensToday = null,
    costToday = null,
    mode = 'manual'
  }: {
    services?: 'up' | 'degraded' | 'down' | 'unknown';
    activeAgents?: number | null;
    /** Σ tokens (in+out) today; null ⇒ unknown ⇒ "—". */
    tokensToday?: number | null;
    /** Σ priced cost today; null ⇒ no priced run ⇒ "$—" (never a fake $0). */
    costToday?: number | null;
    mode?: 'event' | 'periodic' | 'manual';
  } = $props();

  // Compact token formatting (e.g. 1.2k / 3.4M) so the strip stays terse; null ⇒ "—".
  const tokDisplay = $derived(
    tokensToday == null
      ? '—'
      : tokensToday >= 1_000_000
        ? `${(tokensToday / 1_000_000).toFixed(1)}M`
        : tokensToday >= 1_000
          ? `${(tokensToday / 1_000).toFixed(1)}k`
          : String(tokensToday)
  );
  // Cost: honest "—" when no priced row exists today (F-008), never a fabricated $0.
  const costDisplay = $derived(costToday == null ? '—' : `$${costToday.toFixed(2)}`);
</script>

<footer class="statusbar mono">
  <span class="stat" data-services={services}>
    <span class="stat-dot"></span>
    services {services}
  </span>
  <span class="stat tnum">
    agents {activeAgents ?? '—'}
  </span>
  <span class="stat tnum">tok {tokDisplay} · {costDisplay}</span>
  <span class="stat">mode {mode}</span>
</footer>

<style>
  .statusbar {
    height: var(--shell-statusbar-h);
    flex: 0 0 var(--shell-statusbar-h);
    display: flex;
    align-items: center;
    gap: var(--pad-panel);
    padding: 0 var(--pad-panel);
    background: var(--color-bg-inset);
    border-top: var(--border-width) solid var(--color-border);
    font-size: var(--text-2xs);
    color: var(--color-text-subtle);
  }
  .stat {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .stat-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill);
    background: var(--color-neutral);
  }
  .stat[data-services='up'] .stat-dot {
    background: var(--color-success);
  }
  .stat[data-services='degraded'] .stat-dot {
    background: var(--color-warn);
  }
  .stat[data-services='down'] .stat-dot {
    background: var(--color-error);
  }
</style>
