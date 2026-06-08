<script lang="ts">
  /**
   * Sidebar — global nav clustered by the product's two pillars
   * (Portfolio · Harness · Knowledge & system) per UI-SPEC §3 / design-system
   * Gestalt "proximity". Placeholder content; real nav wires in at task 1.5.
   */
  import { navGroups as groups } from './nav';

  // `open` drives the drawer state at narrow viewports (task 6.3); it is inert
  // at >=768px where the sidebar is a static rail. `onnavigate` lets the shell
  // close the drawer when a link is followed.
  let {
    pathname = '/',
    open = false,
    onnavigate
  }: {
    pathname?: string;
    open?: boolean;
    onnavigate?: () => void;
  } = $props();
</script>

<aside id="app-sidebar" class="sidebar" class:open>
  <div class="brand">
    <span class="brand-mark mono">Atelier</span>
  </div>
  <nav class="nav">
    {#each groups as group (group.title)}
      <div class="nav-group">
        <div class="eyebrow nav-group-title">{group.title}</div>
        {#each group.items as item (item.href)}
          <a
            class="nav-item"
            class:active={pathname === item.href}
            href={item.href}
            aria-current={pathname === item.href ? 'page' : undefined}
            onclick={() => onnavigate?.()}
          >
            {item.label}
          </a>
        {/each}
      </div>
    {/each}
  </nav>
</aside>

<style>
  .sidebar {
    width: var(--shell-sidebar-w);
    flex: 0 0 var(--shell-sidebar-w);
    background: var(--color-surface);
    border-right: var(--border-width) solid var(--color-border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  /* Narrow viewports (task 6.3): the rail leaves the flex flow and becomes a
     fixed off-canvas drawer. Closed = translated fully off the left edge so it
     never reserves width or pushes content off-screen; `.open` slides it in
     above the scrim. */
  @media (max-width: 767px) {
    .sidebar {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: var(--z-overlay);
      transform: translateX(-100%);
      box-shadow: var(--shadow-overlay);
      transition: transform var(--motion-normal) var(--ease-out);
    }
    .sidebar.open {
      transform: translateX(0);
    }
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: var(--gap-inline);
    padding: var(--pad-control) var(--pad-card);
    height: var(--shell-topbar-h);
    border-bottom: var(--border-width) solid var(--color-border);
  }
  .brand-mark {
    font-size: var(--text-sm);
    color: var(--color-text-accent);
  }
  .nav {
    padding: var(--pad-card);
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
  }
  .nav-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .nav-group-title {
    margin-bottom: var(--space-2);
  }
  .nav-item {
    display: block;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    font: var(--type-body-sm);
    transition: background var(--motion-fast) var(--ease-out),
      color var(--motion-fast) var(--ease-out);
  }
  .nav-item:hover {
    background: var(--color-surface-overlay);
    color: var(--color-text);
  }
  .nav-item.active {
    background: var(--color-surface-selected);
    color: var(--color-text-accent);
  }
</style>
