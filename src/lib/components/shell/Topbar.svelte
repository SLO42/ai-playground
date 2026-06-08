<script lang="ts">
  /**
   * Topbar — breadcrumb · live-status pill · command-palette · connection state
   * (UI-SPEC §3). Placeholder; live wiring lands with the SSE stream (1.5/2.1).
   * Connection state defaults to `unknown` — honest states are first-class,
   * never fabricate a "live" badge before a stream exists (F-008).
   */
  let {
    breadcrumb = 'Home',
    mode = 'manual',
    connection = 'unknown'
  }: {
    breadcrumb?: string;
    mode?: 'event' | 'periodic' | 'manual';
    connection?: 'live' | 'reconnecting' | 'offline' | 'unknown';
  } = $props();
</script>

<header class="topbar">
  <div class="breadcrumb mono">{breadcrumb}</div>
  <div class="topbar-right">
    <span class="pill" data-mode={mode}>
      <span class="eyebrow">mode</span>
      <span class="mono">{mode}</span>
    </span>
    <span class="conn" data-conn={connection} aria-label={`connection ${connection}`}>
      <span class="conn-dot"></span>
      <span class="mono">{connection}</span>
    </span>
  </div>
</header>

<style>
  .topbar {
    height: var(--shell-topbar-h);
    flex: 0 0 var(--shell-topbar-h);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--pad-panel);
    background: var(--color-bg-inset);
    border-bottom: var(--border-width) solid var(--color-border);
  }
  .breadcrumb {
    font-size: var(--text-sm);
    color: var(--color-text-2);
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: var(--gap-inline);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .conn-dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-pill);
    background: var(--color-neutral);
  }
  .conn[data-conn='live'] .conn-dot {
    background: var(--color-success);
  }
  .conn[data-conn='reconnecting'] .conn-dot {
    background: var(--color-warn);
  }
  .conn[data-conn='offline'] .conn-dot {
    background: var(--color-error);
  }
</style>
