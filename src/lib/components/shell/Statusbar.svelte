<script lang="ts">
  /**
   * Statusbar — services health · active agents · token/cost ticker ·
   * orchestration mode (UI-SPEC §3, "always-on awareness" strip). Placeholder:
   * values render as `unknown`/`—` until real sources exist (F-008 — never
   * fabricate a plausible-looking number).
   */
  let {
    services = 'unknown',
    activeAgents = null,
    mode = 'manual'
  }: {
    services?: 'up' | 'degraded' | 'down' | 'unknown';
    activeAgents?: number | null;
    mode?: 'event' | 'periodic' | 'manual';
  } = $props();
</script>

<footer class="statusbar mono">
  <span class="stat" data-services={services}>
    <span class="stat-dot"></span>
    services {services}
  </span>
  <span class="stat tnum">
    agents {activeAgents ?? '—'}
  </span>
  <span class="stat tnum">tok — · $—</span>
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
