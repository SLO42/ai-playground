<script lang="ts">
  /**
   * /projects/[id]/graph — LG-3: the live animated lifecycle node-graph
   * (LIFECYCLE-GRAPH-SPEC §LG-3). Renders the LG-2 read model (Continue → sessions → PM →
   * tasks) and animates it growing as live row changes land.
   *
   * Live (UI-SPEC §1.2): the SSE watchers for the contributing tables re-invalidate the loader
   * so the newest graph updates in place — REUSE of the ONE onDbChange surface the timeline/
   * command-center already use (no parallel change detector). Honest states (F-008): loading /
   * empty / DB-down / partial / disconnected. Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import LifecycleGraph from '$lib/components/graph/LifecycleGraph.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const graph = $derived(data.graph);
  const loadError = $derived('error' in data ? (data.error as string | undefined) : undefined);
  const slug = $derived(page.params.id);
  const projectName = $derived(data.projectName ?? slug);
  const backHref = $derived(`/projects/${slug}`);

  // The live connection state passed to the graph (honest badge — never faked 'live').
  const connection = $derived(stream.connection);

  // Live: a contributing-table row change re-invalidates the loader so the graph grows in
  // place. These are the LG-2 substrate tables (watched-tables.ts → the SSE fires). REUSE.
  $effect(() => {
    const offs = [
      stream.onDbChange('scene_event', () => void invalidate('app:lifecycle')),
      stream.onDbChange('session', () => void invalidate('app:lifecycle')),
      stream.onDbChange('task', () => void invalidate('app:lifecycle')),
      stream.onDbChange('agent_event', () => void invalidate('app:lifecycle'))
    ];
    return () => offs.forEach((off) => off());
  });
</script>

<svelte:head>
  <title>Lifecycle graph · {projectName}</title>
</svelte:head>

<div class="page">
  <header class="head">
    <div class="crumbs">
      <a class="link-inline" href={backHref}>← {projectName}</a>
    </div>
    <h1 class="title">Lifecycle graph</h1>
    <p class="lede">
      The causal chain of this project's work, live: a <strong>Continue</strong> spawns agent
      sessions, each finishes and reports to the <strong>PM</strong>, and the PM proposes the next
      tasks — the graph grows as it happens. Solid edges are real links; dashed edges are inferred.
    </p>
  </header>

  {#if !connected}
    <!-- DB-down / boot error — honest, never zero-dressed-as-real (D-019/F-008). -->
    <div class="card state" role="status">
      <h2 class="section-title">Live data unavailable</h2>
      <p class="state-body">
        {#if loadError}
          The lifecycle graph couldn't be read: {loadError}
        {:else}
          The database isn't connected. Start SurrealDB and this view resumes automatically.
        {/if}
      </p>
    </div>
  {:else}
    <div class="card">
      <LifecycleGraph {graph} {connection} />
    </div>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1.25rem);
    padding: var(--space-5, 1.5rem);
    width: 100%;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .crumbs {
    font-size: var(--text-sm, 0.875rem);
  }
  .link-inline {
    color: var(--color-text-link, var(--color-accent));
    text-decoration: none;
  }
  .link-inline:hover {
    text-decoration: underline;
  }
  .link-inline:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
    border-radius: var(--radius-xs, 3px);
  }
  .title {
    margin: 0;
    font-family: var(--font-display, var(--font-sans));
    font-size: var(--text-2xl, 1.5rem);
    color: var(--color-text);
  }
  .lede {
    margin: 0;
    color: var(--color-text-2);
    max-width: 70ch;
    font-size: var(--text-sm, 0.875rem);
  }
  .card {
    padding: var(--space-4, 1.25rem);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg, 12px);
    background: var(--color-surface-card, var(--color-surface));
  }
  .state {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .section-title {
    margin: 0;
    font-size: var(--text-md, 1rem);
    color: var(--color-text);
  }
  .state-body {
    margin: 0;
    color: var(--color-text-2);
    font-size: var(--text-sm, 0.875rem);
  }
</style>
