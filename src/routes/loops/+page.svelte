<script lang="ts">
  /**
   * Loops — the first-class view of Atelier's REAL recurring autonomous loops (LOOP-ENGINEERING.md;
   * operator directive 2026-06-29). Phase 1 = VIEW + IDENTIFY only (config-editing is a later wave).
   * Surfaces the four real loops (orchestrator drain + GC backstop, per-project autonomous PM drive,
   * per-PM cadence trigger, the informational memory-review loop) as identified, reviewable cards
   * grouped by scope. ALL live from the DB (F-008): honest '—'/'not yet run'/'unknown' states, never a
   * fabricated count or time. Live by default (§1.2): a run event / PM arm change / session change
   * re-invalidates and the cards re-derive. Tokens-only · a11y. Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import LiveBadge from '$lib/components/shell/LiveBadge.svelte';
  import LoopList from '$lib/components/loops/LoopList.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const loops = $derived(data.loops ?? []);
  const projectNames = $derived(data.projectNames ?? {});

  // The run-history feed is agent_event — its liveness is the most representative health signal for
  // this surface; the LiveBadge stays silent while the feed is cleanly live and surfaces a degrade.
  const activityLiveness = $derived(stream.tableLiveness('agent_event'));

  // Live: each loop's state derives from agent_event (runs), pm (arm/cadence), session, project —
  // any of these changing re-invalidates the loader, which re-samples the live armed singletons.
  $effect(() => {
    const offs = [
      stream.onDbChange('agent_event', () => void invalidate('app:analytics')),
      stream.onDbChange('pm', () => void invalidate('app:pm')),
      stream.onDbChange('session', () => void invalidate('app:fleet')),
      stream.onDbChange('project', () => void invalidate('app:projects'))
    ];
    return () => offs.forEach((off) => off());
  });
</script>

<svelte:head>
  <title>Loops — Atelier</title>
</svelte:head>

<section class="loops">
  <header class="page-head">
    <div class="head-row">
      <div>
        <span class="eyebrow">autonomy</span>
        <h1 class="title">Loops</h1>
      </div>
      <LiveBadge phase={activityLiveness} />
    </div>
    <p class="lede">
      The recurring loops Atelier runs on its own — the orchestrator drain, each project's autonomous
      PM drive and cadence, and the memory review. Live from the database; states are honest ('—' /
      'not yet run' / 'unknown') rather than fabricated. View &amp; identify only — editing comes later.
    </p>
  </header>

  {#if !connected}
    <div class="card state" role="status">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — loops cannot be read, so none are shown instead of a fabricated
        list. Start SurrealDB and reload.
      </p>
    </div>
  {:else}
    <LoopList {loops} {projectNames} />
  {/if}
</section>

<style>
  .loops {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    width: 100%;
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .head-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
  }
  .eyebrow {
    font-size: var(--text-xs, 0.72rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    max-width: 72ch;
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card);
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
