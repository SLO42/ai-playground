<script lang="ts">
  /**
   * MemoryTabs — the shared tab bar for the Memory cluster (BL-8 BRAIN-OBSERVABILITY-SPEC §4).
   * Keeps the four memory surfaces discoverable from each other: the existing explorer plus the
   * three read-only observability lenses (History / Learned skills / Utilization). Plain links
   * (real navigation, no client state) so each tab is a reachable route. The active tab is
   * derived from the current path. Design tokens + a11y (aria-current, focus-visible). Svelte 5.
   */
  import { page } from '$app/state';

  interface Tab {
    label: string;
    href: string;
  }

  const tabs: Tab[] = [
    { label: 'Explorer', href: '/memory' },
    { label: 'History', href: '/memory/history' },
    { label: 'Learned skills', href: '/memory/skills' },
    { label: 'Utilization', href: '/memory/outcomes' }
  ];

  const current = $derived(page.url.pathname);
  function isActive(href: string): boolean {
    // Exact match for /memory; prefix-safe for the lens routes.
    return href === '/memory' ? current === '/memory' : current.startsWith(href);
  }
</script>

<nav class="tabs" aria-label="Memory views">
  {#each tabs as t (t.href)}
    <a class="tab" href={t.href} aria-current={isActive(t.href) ? 'page' : undefined} data-active={isActive(t.href)}>
      {t.label}
    </a>
  {/each}
</nav>

<style>
  .tabs {
    display: flex;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: var(--space-2, 0.5rem);
  }
  .tab {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    text-decoration: none;
    padding: 0.35rem 0.7rem;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid transparent;
    transition: color 0.14s ease, border-color 0.14s ease, background 0.14s ease;
  }
  .tab:hover {
    color: var(--color-text);
    border-color: var(--color-border);
  }
  .tab:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 1px;
  }
  .tab[data-active='true'] {
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border-color: var(--color-border);
  }
</style>
