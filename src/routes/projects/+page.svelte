<script lang="ts">
  /**
   * /projects — portfolio project list (UI-SPEC §6 v0.1).
   *
   * Renders LIVE `project` rows from the DB (F-008 — no fabricated cards) with the
   * four honest states (loading / empty / error / live, UI-SPEC §1.3/§8). Live by
   * default (§1.2): a `project` row change on the one SSE stream re-invalidates the
   * loader so the list updates in place — no manual refresh. Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const projects = $derived(data.projects ?? []);
  const connected = $derived(data.connected);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // Live updates: when a `project` row changes, re-run the server loader. SSR-safe —
  // $effect runs only in the browser, and the handler is torn down on unmount.
  $effect(() => {
    const off = stream.onDbChange('project', () => {
      void invalidate('app:projects');
    });
    return off;
  });

  function statusOf(p: { status?: string }): string {
    return p.status ?? 'unknown';
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">portfolio</span>
    <h1 class="title">Projects</h1>
    <p class="lede">
      Every project under management, served live from the database. Register a new
      one by scanning a path under <span class="mono">CODE_ROOT</span>.
    </p>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no projects rather than a fabricated
        list. {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and
        reload.{/if}
      </p>
    </div>
  {:else if projects.length === 0}
    <div class="card state">
      <span class="eyebrow">empty</span>
      <p class="state-body">No projects yet — register one by scanning a path.</p>
    </div>
  {:else}
    <ul class="grid" aria-label="projects">
      {#each projects as p (p.id)}
        <li class="card project">
          <div class="project-head">
            <span class="name">{p.name}</span>
            <span class="status" data-status={statusOf(p)}>{statusOf(p)}</span>
          </div>
          <div class="path mono" title={p.root_path}>{p.root_path}</div>
          {#if p.ecosystem?.length}
            <ul class="eco">
              {#each p.ecosystem as e (e)}
                <li class="tag mono">{e}</li>
              {/each}
            </ul>
          {/if}
          {#if p.purpose}
            <p class="purpose">{p.purpose}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    max-width: 980px;
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
    max-width: 70ch;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
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
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-4, 1rem);
  }
  .project {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    min-width: 0;
  }
  .project-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }
  .name {
    font-weight: 600;
    color: var(--color-text);
  }
  .status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.12rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    white-space: nowrap;
  }
  .status[data-status='active'] {
    color: var(--color-running, var(--color-success));
  }
  .status[data-status='archived'] {
    color: var(--color-neutral, var(--color-text-muted));
  }
  .path {
    font-size: 0.78rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .eco {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .tag {
    font-size: 0.68rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, var(--color-surface-overlay));
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
  }
  .purpose {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
</style>
