<script lang="ts">
  /**
   * Sidebar — global nav clustered by the product's two pillars
   * (Portfolio · Harness · Knowledge & system) per UI-SPEC §3 / design-system
   * Gestalt "proximity". Placeholder content; real nav wires in at task 1.5.
   */
  import { navGroups as groups } from './nav';

  let { pathname = '/' }: { pathname?: string } = $props();
</script>

<aside class="sidebar">
  <div class="brand">
    <span class="brand-mark mono">ai-playground</span>
    <span class="eyebrow">v2</span>
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
