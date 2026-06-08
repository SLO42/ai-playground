<script lang="ts">
  /**
   * Home — portfolio overview (UI-SPEC §6). Renders LIVE counts from the DB
   * (F-008 — no fabricated metrics); unknown values render as "—" when the DB is
   * disconnected (honest states, §1.3). Live by default: a project row change on
   * the one SSE stream re-invalidates the loader. Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const projectCount = $derived(data.projectCount);

  $effect(() => {
    const off = stream.onDbChange('project', () => {
      void invalidate('app:projects');
    });
    return off;
  });
</script>

<section class="home">
  <header class="page-head">
    <span class="eyebrow">portfolio</span>
    <h1 class="title">Dashboard</h1>
    <p class="lede">
      At-a-glance health of the portfolio and engine. Live from the database over
      one event stream — no manual refresh.
    </p>
  </header>

  <div class="metrics">
    <div class="card metric">
      <span class="eyebrow">projects</span>
      <span class="metric-value tnum mono" data-unknown={projectCount === null}>
        {projectCount ?? '—'}
      </span>
      <span class="metric-foot">
        {connected ? 'under management' : 'database disconnected'}
      </span>
    </div>
  </div>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — metrics show <span class="mono">—</span>
        instead of a fabricated number. Start SurrealDB and reload.
      </p>
    </div>
  {/if}
</section>

<style>
  .home {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    max-width: 760px;
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
  }
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    max-width: 60ch;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--space-4, 1rem);
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .metric-value {
    font-size: var(--text-3xl, 2rem);
    font-weight: 600;
    color: var(--color-text);
    line-height: 1;
  }
  .metric-value[data-unknown='true'] {
    color: var(--color-text-muted);
  }
  .metric-foot {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .state {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
</style>
