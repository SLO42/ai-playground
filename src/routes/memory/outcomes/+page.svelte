<script lang="ts">
  /**
   * /memory/outcomes — the Utilization lens (BL-8 BRAIN-OBSERVABILITY-SPEC §4). READ-ONLY: the
   * D-030 signal per memory — recalled vs cited vs utilized + mean score — as a leaderboard, with
   * a "recalled but never cited" filter (the BL-7B low-value candidate view; view-only). Honest
   * (F-008): an un-cited memory reads "recalled, not yet cited", never a faked score. Content is
   * screened for display (D-026). Live (§4): a retrieval_outcome row change re-invalidates the
   * loader. Filter is server-driven (?filter=). Svelte 5 runes, design tokens, a11y.
   */
  import { invalidate, goto } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import MemoryTabs from '$lib/components/shell/MemoryTabs.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const rows = $derived(data.rows ?? []);
  const filter = $derived(data.filter);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);
  const hasRows = $derived(rows.length > 0);

  // Live: a retrieval_outcome row change re-runs the loader.
  $effect(() => {
    const off = stream.onDbChange('retrieval_outcome', () => void invalidate('app:memory-outcomes'));
    return off;
  });

  function setFilter(f: 'all' | 'uncited'): void {
    void goto(f === 'all' ? '/memory/outcomes' : '/memory/outcomes?filter=uncited', {
      keepFocus: true,
      noScroll: true
    });
  }
  function shortId(id: string): string {
    return id.replace(/^\w+:/, '');
  }
</script>

<svelte:head>
  <title>Memory utilization — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">knowledge · utilization</span>
    <h1 class="title">Memory utilization</h1>
    <p class="lede">
      How recalled memory actually gets used — for each memory, how often it was recalled, cited
      <span class="mono">[#N]</span>, and utilized. This is the live D-030 signal; "recalled, not
      yet cited" is reported honestly, never as a faked score.
    </p>
  </header>

  <MemoryTabs />

  <div class="controls" role="group" aria-label="Utilization filter">
    <button
      type="button"
      class="chip"
      data-active={filter === 'all'}
      aria-pressed={filter === 'all'}
      onclick={() => setFilter('all')}
    >
      all
    </button>
    <button
      type="button"
      class="chip"
      data-active={filter === 'uncited'}
      aria-pressed={filter === 'uncited'}
      onclick={() => setFilter('uncited')}
    >
      recalled, never cited
    </button>
  </div>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no utilization rather than fabricated metrics.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else if !hasRows}
    <div class="card state">
      <span class="eyebrow">empty</span>
      <p class="state-body">
        {#if filter === 'uncited'}
          No recalled-but-never-cited memories — every recalled memory has been cited at least
          once.
        {:else}
          No retrieval outcomes recorded yet — these accrue as memory is recalled into sessions
          and citations land.
        {/if}
      </p>
    </div>
  {:else}
    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">memory</th>
            <th scope="col" class="num">recalled</th>
            <th scope="col" class="num">cited</th>
            <th scope="col" class="num">utilized</th>
            <th scope="col" class="num">avg score</th>
            <th scope="col">signal</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.memory)}
            <tr data-uncited={r.recalledNeverCited}>
              <th scope="row" class="mem">
                <a class="mem-link mono" href={`/memory/history?memory=${r.memory}`} title="history for this memory">
                  {shortId(r.memory)}
                </a>
                {#if r.content}<span class="content">{r.content}</span>{/if}
              </th>
              <td class="num mono">{r.recalled}</td>
              <td class="num mono">{r.cited}</td>
              <td class="num mono">{r.utilized}</td>
              <td class="num mono">{r.avgScore.toFixed(2)}</td>
              <td class="signal">
                {#if r.recalledNeverCited}
                  <span class="badge warn">recalled, not yet cited</span>
                {:else if r.utilized > 0}
                  <span class="badge ok">in use</span>
                {:else}
                  <span class="badge">cited</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
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
  .controls {
    display: flex;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .chip {
    font: var(--type-body-sm);
    font-size: 0.74rem;
    color: var(--color-text-muted);
    background: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    transition: color 0.14s ease, border-color 0.14s ease, background 0.14s ease;
  }
  .chip:hover {
    color: var(--color-text);
    border-color: var(--color-accent, #8ab0ab);
  }
  .chip:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 1px;
  }
  .chip[data-active='true'] {
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border-color: var(--color-accent, #8ab0ab);
  }
  .table-wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font: var(--type-body-sm);
  }
  th,
  td {
    text-align: left;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
    vertical-align: top;
  }
  thead th {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .mem {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-width: 42ch;
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
  .content {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  tr[data-uncited='true'] {
    background: color-mix(in srgb, var(--color-warn, #c8a45c) 8%, transparent);
  }
  .badge {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }
  .badge.ok {
    color: var(--color-success, #7fae7f);
    border-color: var(--color-success, #7fae7f);
  }
  .badge.warn {
    color: var(--color-warn, #c8a45c);
    border-color: var(--color-warn, #c8a45c);
  }
</style>
