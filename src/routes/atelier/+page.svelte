<script lang="ts">
  /**
   * /atelier — G-C: the atelier-wide reasoning/actions/communications timeline
   * (GLOBAL-TRANSCRIPT-SPEC). A READ-ONLY single pane of what the whole atelier is doing:
   * every session's turns + channel/peer communications + PM verdicts + role lifecycle, MERGED
   * on one timestamp-ordered timeline, scoped GLOBAL or per-PROJECT, paginated newest-first.
   *
   * Reuses the SHARED <SessionTranscript> renderer (transcript-core) so a turn looks identical
   * to the per-session view — each merged entry wraps ONE turn with its actor + project + source
   * + time metadata header (the cross-agent context the per-session view doesn't need).
   *
   * Honest states (F-008): loading / empty / DB-down / PARTIAL (a failing source is named, the
   * timeline is never silently complete). Bounded (F-014): the server pages newest-first; "load
   * older" appends the next page via a timestamp cursor — never an unbounded scan. Live (§1.2):
   * a contributing-table row change re-invalidates the loader so the newest page updates in
   * place. Server-driven scope (the toggle navigates with ?project=). Svelte 5 runes only.
   */
  import { invalidate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import SessionTranscript from '$lib/components/shell/SessionTranscript.svelte';
  import type { TimelineEntry } from '$lib/server/atelier';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const scope = $derived(data.scope);
  const projectOptions = $derived(data.projectOptions ?? []);
  const firstPage = $derived(data.page);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // The active scope value for the dropdown ('all' = global).
  const scopeValue = $derived(scope.kind === 'project' ? scope.project : 'all');

  // ── Appended older pages (client-side scrollback; the first page comes from the loader). ──
  // We hold the loader's first page as the head and append "load older" pages after it. When the
  // loader re-runs (scope change / live invalidation) the head resets and appended pages clear.
  let olderPages = $state<TimelineEntry[][]>([]);
  let nextBefore = $state<string | null>(null);
  let loadingMore = $state(false);
  let loadError = $state<string | null>(null);

  // Reset the scrollback whenever the first page (loader data) changes — keyed on its identity so
  // a scope switch or a live re-invalidation starts a fresh paged view (no stale appended pages).
  let lastHeadKey = $state('');
  $effect(() => {
    const key = `${scope.kind}:${scope.kind === 'project' ? scope.project : ''}:${firstPage.entries[0]?.id ?? ''}:${firstPage.entries.length}`;
    if (key !== lastHeadKey) {
      lastHeadKey = key;
      olderPages = [];
      nextBefore = firstPage.nextBefore;
      loadError = null;
    }
  });

  // The full merged list (head + appended older pages), newest-first. De-duped by id so a live
  // re-invalidation that re-fetches the head can't double an entry an older page also carried.
  const entries = $derived.by(() => {
    const seen = new Set<string>();
    const out: TimelineEntry[] = [];
    for (const e of [...firstPage.entries, ...olderPages.flat()]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  });

  const partial = $derived(connected && !firstPage.complete);
  const failed = $derived(firstPage.failedSources ?? []);
  const isEmpty = $derived(connected && entries.length === 0);

  // Live: a contributing-table row change re-invalidates the loader (newest page updates in
  // place). The tables are watched (watched-tables.ts) so the SSE actually fires.
  $effect(() => {
    const offs = [
      stream.onDbChange('message', () => void invalidate('app:atelier')),
      stream.onDbChange('peer_message', () => void invalidate('app:atelier')),
      stream.onDbChange('panel_verdict', () => void invalidate('app:atelier')),
      stream.onDbChange('role_event', () => void invalidate('app:atelier'))
    ];
    return () => offs.forEach((off) => off());
  });

  /** Navigate with an updated scope (server-driven — the loader re-runs). */
  function setScope(value: string) {
    const q = new URLSearchParams(page.url.searchParams);
    if (value === '' || value === 'all') q.delete('project');
    else q.set('project', value);
    const qs = q.toString();
    void goto(qs ? `/atelier?${qs}` : '/atelier', { keepFocus: true, noScroll: true });
  }

  /** Fetch the next (older) page via the JSON endpoint and append it. Bounded — one page. */
  async function loadOlder() {
    if (!nextBefore || loadingMore) return;
    loadingMore = true;
    loadError = null;
    try {
      const q = new URLSearchParams();
      if (scope.kind === 'project') q.set('project', scope.project);
      q.set('before', nextBefore);
      const res = await fetch(`/atelier/page?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        entries: TimelineEntry[];
        nextBefore: string | null;
      };
      olderPages = [...olderPages, body.entries ?? []];
      nextBefore = body.nextBefore ?? null;
    } catch (err) {
      loadError = (err as Error).message;
    } finally {
      loadingMore = false;
    }
  }

  /** Relative "time ago" for an entry's timestamp. */
  function ago(iso: string): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  const SOURCE_LABEL: Record<string, string> = {
    message: 'session',
    peer_message: 'comms',
    panel_verdict: 'verdict',
    role_event: 'workforce'
  };
</script>

<svelte:head>
  <title>Atelier — timeline</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">global timeline</span>
    <h1 class="title">Atelier</h1>
    <p class="lede">
      Everything the atelier is doing on one timeline — session reasoning + actions, agent
      communications, PM verdicts, and workforce lifecycle — merged newest-first and labelled by
      actor and project. Read-only: content is already screened at the source; nothing here is
      fabricated.
    </p>
  </header>

  <!-- Server-driven scope toggle (global vs per-project) -->
  <div class="card filters" aria-label="timeline scope">
    <label class="filter">
      <span class="filter-label">scope</span>
      <select
        value={scopeValue}
        onchange={(e) => setScope(e.currentTarget.value)}
        disabled={!connected}
      >
        <option value="all">Whole atelier</option>
        {#each projectOptions as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
    </label>
    {#if connected}
      <span class="scope-note mono">
        {scope.kind === 'project' ? 'project scope' : 'global scope'} · newest first
      </span>
    {/if}
  </div>

  {#if !connected}
    <!-- DB-down / error — honest, never zero-dressed-as-real (D-019). -->
    <div class="card state state-error" role="status">
      <p>The timeline source is unavailable.</p>
      {#if error}<p class="mono detail">{error}</p>{/if}
    </div>
  {:else}
    {#if partial}
      <!-- PARTIAL: one or more sources failed — named, never silently complete (F-008). -->
      <div class="card state state-partial" role="status">
        <p>
          Partial timeline — {failed.length}
          {failed.length === 1 ? 'source' : 'sources'} unavailable ({failed
            .map((f) => SOURCE_LABEL[f] ?? f)
            .join(', ')}). Showing what loaded.
        </p>
      </div>
    {/if}

    {#if isEmpty}
      <div class="card state state-empty" role="status">
        <p>
          No activity in this {scope.kind === 'project' ? 'project' : 'window'} yet. Sessions,
          communications, verdicts, and workforce events will appear here as they happen.
        </p>
      </div>
    {:else}
      <ol class="timeline" role="log" aria-label="atelier timeline, newest first">
        {#each entries as e (e.id)}
          <li class="entry">
            <div class="entry-meta">
              <span class="src" data-src={e.source}>{SOURCE_LABEL[e.source] ?? e.source}</span>
              {#if e.turn.actor}<span class="actor mono">{e.turn.actor}</span>{/if}
              {#if e.turn.project}<span class="proj mono">· {e.turn.project}</span>{/if}
              <time class="ago mono" datetime={e.at}>{ago(e.at)}</time>
            </div>
            <div class="entry-turn">
              <SessionTranscript turns={[e.turn]} />
            </div>
          </li>
        {/each}
      </ol>

      <!-- Bounded scrollback: load the next (older) page on demand. -->
      <div class="more">
        {#if nextBefore}
          <button
            class="more-btn"
            type="button"
            onclick={loadOlder}
            disabled={loadingMore}
          >
            {loadingMore ? 'loading…' : 'Load older'}
          </button>
        {:else}
          <span class="more-end mono">end of timeline window</span>
        {/if}
        {#if loadError}<span class="more-err mono">could not load: {loadError}</span>{/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-5, 1rem);
    max-width: var(--measure-wide, 64rem);
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.35rem);
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
  }
  .title {
    font: var(--type-title, 600 1.5rem/1.2 inherit);
    color: var(--color-text);
    margin: 0;
  }
  .lede {
    color: var(--color-text-2, var(--color-text-muted));
    max-width: var(--measure, 52rem);
    margin: 0;
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    padding: var(--space-4, 0.75rem);
  }
  .filters {
    display: flex;
    align-items: center;
    gap: var(--space-4, 0.85rem);
    flex-wrap: wrap;
  }
  .filter {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .filter-label {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .filter select {
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.3rem 0.5rem;
    font: inherit;
  }
  .filter select:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .scope-note {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .state {
    color: var(--color-text-2, var(--color-text-muted));
  }
  .state p {
    margin: 0 0 0.25rem;
  }
  .state .detail {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .state-error {
    border-color: var(--color-error-on-overlay);
  }
  .state-partial {
    border-color: var(--color-warn, var(--color-border-strong));
  }
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.6rem);
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.35rem);
  }
  .entry-meta {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.45rem;
  }
  .src {
    font-size: 0.62rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    flex: none;
  }
  .src[data-src='peer_message'] {
    color: var(--color-tier-sonnet, var(--color-accent));
  }
  .src[data-src='panel_verdict'] {
    color: var(--color-accent);
  }
  .actor {
    font-size: 0.72rem;
    color: var(--color-text);
    font-weight: 600;
  }
  .proj {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .ago {
    font-size: 0.66rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .more {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.6rem);
    padding: var(--space-2, 0.5rem) 0;
  }
  .more-btn {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem 0.8rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
  }
  .more-btn:hover:not(:disabled) {
    border-color: var(--color-accent);
  }
  .more-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .more-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .more-end {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .more-err {
    font-size: 0.7rem;
    color: var(--color-error-on-overlay);
  }
</style>
