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
    unread = 0,
    ontoggleNav,
    ontoggletray
  }: {
    breadcrumb?: string;
    mode?: 'event' | 'periodic' | 'manual';
    /** Live count of running sessions; null ⇒ unknown ⇒ "—". */
    runningAgents?: number | null;
    connection?: 'live' | 'reconnecting' | 'offline' | 'unknown';
    // task 6.3: hamburger toggle, only shown at narrow viewports.
    navOpen?: boolean;
    /** Live count of UNREAD notifications — drives the bell badge (TASK 10.2). */
    unread?: number;
    ontoggleNav?: () => void;
    /** Toggle the RightTray (TASK 10.2). */
    ontoggletray?: () => void;
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
    <button
      type="button"
      class="bell"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      onclick={() => ontoggletray?.()}
    >
      <span class="bell-glyph" aria-hidden="true"></span>
      {#if unread > 0}
        <span class="bell-badge tnum" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
      {/if}
    </button>
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

  /* Notifications bell (TASK 10.2) — glyph drawn from currentColor (no icon font/asset). */
  .bell {
    position: relative;
    display: inline-flex;
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
  .bell:hover {
    background: var(--color-surface-overlay);
    color: var(--color-text);
  }
  /* A simple bell: a rounded body with a clapper underneath, both from currentColor. */
  .bell-glyph {
    position: relative;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-bottom: none;
    border-radius: 6px 6px 0 0;
  }
  .bell-glyph::before {
    content: '';
    position: absolute;
    left: -3px;
    bottom: -2px;
    width: 16px;
    height: 2px;
    background: currentColor;
    border-radius: 1px;
  }
  .bell-glyph::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -5px;
    width: 4px;
    height: 3px;
    transform: translateX(-50%);
    background: currentColor;
    border-radius: 0 0 2px 2px;
  }
  .bell-badge {
    position: absolute;
    top: -5px;
    right: -5px;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    background: var(--color-accent);
    color: var(--color-on-accent);
    font: var(--weight-semibold) 10px / 1 var(--font-sans);
  }
</style>
