<script lang="ts">
  /**
   * /memory/history — the brain History lens (BL-8 BRAIN-OBSERVABILITY-SPEC §4). READ-ONLY:
   * the memory_history audit timeline (add/supersede/archive, before→after diff, screen_status,
   * timestamp). Global recent-activity feed by default; per-memory drill-down via ?memory=.
   * Every snapshot is already screened + fence-inert (server lister, D-026) — this view never
   * unscreens. Four honest states (loading/empty/error/live, F-008). Live (§4): a memory_history
   * row change re-invalidates the loader. Svelte 5 runes, design tokens, a11y.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import MemoryTabs from '$lib/components/shell/MemoryTabs.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const entries = $derived(data.entries ?? []);
  const memoryId = $derived(data.memoryId);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);
  const hasEntries = $derived(entries.length > 0);

  // Live: a memory_history row change re-runs the loader (UI-SPEC §1.2).
  $effect(() => {
    const off = stream.onDbChange('memory_history', () => void invalidate('app:memory-history'));
    return off;
  });

  function shortId(id: string | undefined): string {
    return id ? id.replace(/^\w+:/, '') : '—';
  }
  function fmtTime(iso: string | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }
  const OP_LABEL: Record<string, string> = { add: 'added', supersede: 'superseded', archive: 'archived' };
</script>

<svelte:head>
  <title>Memory history — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">knowledge · audit</span>
    <h1 class="title">Memory history</h1>
    <p class="lede">
      The append-only audit trail of every add, supersede, and archive on a memory row — the
      forensic "what changed and why / why was this forgotten" record. Snapshots are screened on
      display; nothing here is fabricated.
    </p>
  </header>

  <MemoryTabs />

  {#if memoryId}
    <div class="scope-note" aria-live="polite">
      <span class="eyebrow">scoped to memory</span>
      <span class="mono">{shortId(memoryId)}</span>
      <a class="clear" href="/memory/history">view all activity</a>
    </div>
  {/if}

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no history rather than a fabricated trail.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else if !hasEntries}
    <div class="card state">
      <span class="eyebrow">empty</span>
      <p class="state-body">
        {#if memoryId}
          No audit entries for this memory yet.
        {:else}
          No memory activity recorded yet — entries accrue as memories are added, superseded, or
          archived.
        {/if}
      </p>
    </div>
  {:else}
    <ul class="feed" aria-label="memory history timeline">
      {#each entries as e (e.id)}
        <li class="entry" data-op={e.op}>
          <div class="entry-head">
            <span class="op-tag" data-op={e.op}>{OP_LABEL[e.op] ?? e.op}</span>
            {#if e.memory}
              <a class="mem-link mono" href={`/memory/history?memory=${e.memory}`} title="drill into this memory">
                {shortId(e.memory)}
              </a>
            {:else}
              <span class="mono dim">memory removed</span>
            {/if}
            {#if e.displayStatus !== 'clean'}
              <span class="screen-flag" data-status={e.displayStatus} title="screened on display (D-026)">
                {e.displayStatus}
              </span>
            {/if}
            <time class="ts mono" datetime={e.at}>{fmtTime(e.at)}</time>
          </div>

          {#if e.before || e.after}
            <div class="diff">
              {#if e.before}
                <div class="snap before">
                  <span class="snap-label">before</span>
                  <p class="snap-body">{e.before}</p>
                </div>
              {/if}
              {#if e.after}
                <div class="snap after">
                  <span class="snap-label">after</span>
                  <p class="snap-body">{e.after}</p>
                </div>
              {/if}
            </div>
          {:else}
            <p class="snap-body dim">No content snapshot recorded for this entry.</p>
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
    width: 100%;
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
    max-width: 72ch;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .dim {
    color: var(--color-text-muted);
    opacity: 0.8;
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .card {
    background: var(--color-surface-card);
    border: 1px solid var(--color-border);
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
  .scope-note {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 0.78rem;
    color: var(--color-text-2);
  }
  .clear {
    color: var(--color-accent, #8ab0ab);
    text-decoration: none;
  }
  .clear:hover {
    text-decoration: underline;
  }
  .clear:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 2px;
  }
  .feed {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--color-border);
    border-left-width: 3px;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
  }
  .entry[data-op='archive'] {
    border-left-color: var(--color-warn, #c8a45c);
  }
  .entry[data-op='supersede'] {
    border-left-color: var(--color-accent, #8ab0ab);
  }
  .entry[data-op='add'] {
    border-left-color: var(--color-border);
  }
  .entry-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .op-tag {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    background: var(--color-surface-overlay);
  }
  .mem-link {
    font-size: 0.72rem;
    color: var(--color-text-2);
    text-decoration: none;
  }
  .mem-link:hover {
    color: var(--color-accent, #8ab0ab);
    text-decoration: underline;
  }
  .mem-link:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 2px;
  }
  .screen-flag {
    font-size: 0.62rem;
    text-transform: uppercase;
    padding: 0.02rem 0.35rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-warn, #c8a45c);
    border: 1px solid var(--color-warn, #c8a45c);
  }
  .screen-flag[data-status='quarantined'] {
    color: var(--color-danger, #d08383);
    border-color: var(--color-danger, #d08383);
  }
  .ts {
    margin-left: auto;
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2, 0.5rem);
  }
  @media (max-width: 720px) {
    .diff {
      grid-template-columns: 1fr;
    }
  }
  .snap {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--color-border-subtle, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .snap.before {
    opacity: 0.75;
  }
  .snap-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .snap-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
  }
</style>
