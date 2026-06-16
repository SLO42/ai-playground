<script lang="ts">
  /**
   * /atelier/queue — the work-queue monitor (BL-9 WORK-QUEUE-MONITOR-SPEC §4). READ-ONLY: the
   * background work_item claim queue made visible — headline stats (pending depth · processing ·
   * today's spawns vs the D-021 cap · stale count), the active list (pending + processing, with a
   * derived STALE flag), and a paginated recent-completed list with terminal status + duration.
   * No enqueue/cancel/retry control (view-only). Honest states (F-008): loading/empty/error/live.
   * Bounded (F-014): the completed list pages via a ?before= cursor. Live (§4): a work_item row
   * change re-invalidates the loader. Svelte 5 runes, design tokens, a11y.
   */
  import { invalidate, goto } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const stats = $derived(data.stats);
  const active = $derived(data.active ?? []);
  const completed = $derived(data.completed ?? []);
  const completedBefore = $derived(data.completedBefore);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // Live: a work_item row change re-runs the loader (UI-SPEC §1.2).
  $effect(() => {
    const off = stream.onDbChange('work_item', () => void invalidate('app:work-queue'));
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
  function fmtDur(ms: number | undefined): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }
  function loadOlder(): void {
    if (completedBefore) void goto(`/atelier/queue?before=${encodeURIComponent(completedBefore)}`, { noScroll: true });
  }
</script>

<svelte:head>
  <title>Work queue — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <a class="back" href="/atelier">← Atelier timeline</a>
    <span class="eyebrow">orchestration · queue</span>
    <h1 class="title">Work queue</h1>
    <p class="lede">
      The background orchestrator queue — memory reviews, skill consolidations, re-interview
      proposals, and task re-runs. Read-only: backlog depth, daily-cap throttling, and stuck
      items, all from the live queue. Nothing here is enqueued, cancelled, or reaped.
    </p>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no queue rather than fabricated counts.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else}
    <!-- Headline stats -->
    <div class="stats" aria-label="queue headline stats">
      <div class="stat">
        <span class="stat-val mono">{stats.pendingDepth}</span>
        <span class="stat-label">pending</span>
      </div>
      <div class="stat">
        <span class="stat-val mono">{stats.processing}</span>
        <span class="stat-label">processing</span>
      </div>
      <div class="stat" data-flag={stats.throttled ? 'warn' : undefined}>
        <span class="stat-val mono">{stats.spawnsToday} / {stats.dailyCap}</span>
        <span class="stat-label">
          {#if stats.throttled}throttled{:else}{stats.capRemaining} remaining today{/if}
        </span>
      </div>
      <div class="stat" data-flag={stats.staleCount > 0 ? 'warn' : undefined}>
        <span class="stat-val mono">{stats.staleCount}</span>
        <span class="stat-label">stale</span>
      </div>
    </div>

    <!-- Active list -->
    <div class="card block">
      <span class="eyebrow">active · {active.length} {active.length === 1 ? 'item' : 'items'}</span>
      {#if active.length === 0}
        <p class="state-body">Queue is idle — no pending or processing work.</p>
      {:else}
        <ul class="item-list" aria-label="active work items">
          {#each active as it (it.id)}
            <li class="item" data-status={it.status} data-stale={it.stale}>
              <div class="item-head">
                <span class="kind-tag">{it.workType}</span>
                <span class="status-tag" data-status={it.status}>{it.status}</span>
                {#if it.stale}<span class="stale-tag" title="processing older than the stale window (derived; not reaped)">STALE</span>{/if}
                <span class="ref mono">{shortId(it.targetRef)}</span>
                <span class="age mono">
                  {#if it.status === 'processing'}claim {fmtDur(it.claimAgeMs)}{:else}prio {it.priority}{/if}
                </span>
              </div>
              <div class="item-foot mono">
                enqueued {fmtTime(it.enqueuedAt)}{#if it.attempts > 0} · {it.attempts} attempt{it.attempts === 1 ? '' : 's'}{/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- Recent completed -->
    <div class="card block">
      <span class="eyebrow">recently completed · {completed.length}</span>
      {#if completed.length === 0}
        <p class="state-body">No completed work in this window.</p>
      {:else}
        <ul class="item-list" aria-label="completed work items">
          {#each completed as it (it.id)}
            <li class="item" data-status={it.status}>
              <div class="item-head">
                <span class="kind-tag">{it.workType}</span>
                <span class="status-tag" data-status={it.status}>{it.status}</span>
                <span class="ref mono">{shortId(it.targetRef)}</span>
                <span class="age mono">{fmtDur(it.durationMs)}</span>
              </div>
              <div class="item-foot mono">
                enqueued {fmtTime(it.enqueuedAt)} · done {fmtTime(it.completedAt)}
              </div>
            </li>
          {/each}
        </ul>
        {#if completedBefore}
          <button type="button" class="load-older" onclick={loadOlder}>load older</button>
        {/if}
      {/if}
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
  .back {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    text-decoration: none;
    width: fit-content;
  }
  .back:hover {
    color: var(--color-accent, #8ab0ab);
  }
  .back:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 2px;
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
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
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
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-2, 0.5rem);
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
  }
  .stat[data-flag='warn'] {
    border-color: var(--color-warn, #c8a45c);
  }
  .stat-val {
    font: var(--type-h2, var(--type-h1));
    font-size: 1.4rem;
    color: var(--color-text);
  }
  .stat[data-flag='warn'] .stat-val {
    color: var(--color-warn, #c8a45c);
  }
  .stat-label {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .item-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--color-border-subtle, var(--color-border));
    border-left-width: 3px;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .item[data-status='processing'] {
    border-left-color: var(--color-accent, #8ab0ab);
  }
  .item[data-status='pending'] {
    border-left-color: var(--color-border);
  }
  .item[data-status='done'] {
    border-left-color: var(--color-success, #7fae7f);
  }
  .item[data-status='failed'] {
    border-left-color: var(--color-danger, #d08383);
  }
  .item[data-stale='true'] {
    border-left-color: var(--color-warn, #c8a45c);
  }
  .item-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .kind-tag {
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .status-tag {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .status-tag[data-status='failed'] {
    color: var(--color-danger, #d08383);
  }
  .status-tag[data-status='done'] {
    color: var(--color-success, #7fae7f);
  }
  .stale-tag {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 0.02rem 0.35rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-warn, #c8a45c);
    border: 1px solid var(--color-warn, #c8a45c);
  }
  .ref {
    font-size: 0.7rem;
    color: var(--color-text-2);
  }
  .age {
    margin-left: auto;
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .item-foot {
    font-size: 0.66rem;
    color: var(--color-text-muted);
  }
  .load-older {
    align-self: flex-start;
    font: var(--type-body-sm);
    font-size: 0.72rem;
    color: var(--color-accent, #8ab0ab);
    background: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .load-older:hover {
    border-color: var(--color-accent, #8ab0ab);
  }
  .load-older:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 1px;
  }
</style>
