<script lang="ts">
  /**
   * Topbar — breadcrumb · live-status pill (mode + running-agent count) ·
   * connection state (UI-SPEC §3). Wired to LIVE data via the root layout
   * (+layout.server.ts) over the one SSE stream. Connection + counts are honest
   * states — never fabricate a "live" badge or an agent count before a real
   * source exists (F-008); `runningAgents` null ⇒ "—".
   */
  let {
    breadcrumb = 'Home',
    mode = 'manual',
    runningAgents = null,
    connection = 'unknown',
    navOpen = false,
    ontoggleNav
  }: {
    breadcrumb?: string;
    mode?: 'event' | 'periodic' | 'manual';
    /** Live count of running sessions; null ⇒ unknown ⇒ "—". */
    runningAgents?: number | null;
    connection?: 'live' | 'reconnecting' | 'offline' | 'unknown';
    // task 6.3: hamburger toggle, only shown at narrow viewports.
    navOpen?: boolean;
    ontoggleNav?: () => void;
  } = $props();
</script>

<header class="topbar">
  <div class="topbar-left">
    <button
      type="button"
      class="nav-toggle"
      aria-label="Toggle navigation"
      aria-expanded={navOpen}
      aria-controls="app-sidebar"
      onclick={() => ontoggleNav?.()}
    >
      <span class="bars" aria-hidden="true"></span>
    </button>
    <div class="breadcrumb mono">{breadcrumb}</div>
  </div>
  <div class="topbar-right">
    <span class="pill" data-mode={mode}>
      <span class="eyebrow">mode</span>
      <span class="mono">{mode}</span>
      <span class="sep" aria-hidden="true">·</span>
      <span class="eyebrow">agents</span>
      <span class="mono tnum">{runningAgents ?? '—'}</span>
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
  .topbar-left {
    display: flex;
    align-items: center;
    gap: var(--gap-inline);
    min-width: 0;
  }
  .breadcrumb {
    font-size: var(--text-sm);
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Hamburger — hidden by default (static rail covers nav at wide viewports),
     revealed below the narrow breakpoint (task 6.3). */
  .nav-toggle {
    display: none;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text-2);
    cursor: pointer;
    flex: 0 0 auto;
  }
  .nav-toggle:hover {
    background: var(--color-surface-overlay);
    color: var(--color-text);
  }
  /* Hamburger glyph drawn from currentColor (no icon font / asset). */
  .bars,
  .bars::before,
  .bars::after {
    display: block;
    width: 16px;
    height: 2px;
    background: currentColor;
    border-radius: 1px;
  }
  .bars {
    position: relative;
  }
  .bars::before,
  .bars::after {
    content: '';
    position: absolute;
    left: 0;
  }
  .bars::before {
    top: -5px;
  }
  .bars::after {
    top: 5px;
  }
  @media (max-width: 767px) {
    .nav-toggle {
      display: inline-flex;
    }
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
  .pill .sep {
    opacity: 0.5;
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
