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
  import type { InboxItem, TimelineEntry } from '$lib/server/atelier';
  import type { PeerStatus } from '$lib/server/peer/repo';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const lens = $derived(data.lens);
  const scope = $derived(data.scope);
  const projectOptions = $derived(data.projectOptions ?? []);
  const firstPage = $derived(data.page);
  const inbox = $derived(data.inbox);
  const inboxStatus = $derived(data.inboxStatus);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // The active scope value for the dropdown ('all' = global).
  const scopeValue = $derived(scope.kind === 'project' ? scope.project : 'all');

  // The four inbox lifecycle states (the filter chips). 'all' clears the filter.
  const STATUSES: PeerStatus[] = ['pending', 'delivered', 'expired', 'quarantined'];
  const STATUS_LABEL: Record<PeerStatus, string> = {
    pending: 'pending',
    delivered: 'delivered',
    expired: 'expired',
    quarantined: 'quarantined'
  };

  // ── Appended older pages (client-side scrollback; the first page comes from the loader). ──
  // We hold the loader's first page as the head and append "load older" pages after it. When the
  // loader re-runs (lens/scope/status change or a live invalidation) the head resets and appended
  // pages clear. ONE scrollback state serves both lenses (only the active one is rendered).
  let olderPages = $state<TimelineEntry[][]>([]);
  let olderInbox = $state<InboxItem[][]>([]);
  let nextBefore = $state<string | null>(null);
  let loadingMore = $state(false);
  let loadError = $state<string | null>(null);

  // Reset the scrollback whenever the head (loader data) changes — keyed on lens+scope+status+head
  // identity so a lens/scope/status switch or a live re-invalidation starts a fresh paged view
  // (no stale appended pages from the other lens or a prior filter).
  let lastHeadKey = $state('');
  $effect(() => {
    const headId =
      lens === 'inbox' ? (inbox.items[0]?.id ?? '') : (firstPage.entries[0]?.id ?? '');
    const headLen = lens === 'inbox' ? inbox.items.length : firstPage.entries.length;
    const key = `${lens}:${scope.kind}:${scope.kind === 'project' ? scope.project : ''}:${inboxStatus ?? ''}:${headId}:${headLen}`;
    if (key !== lastHeadKey) {
      lastHeadKey = key;
      olderPages = [];
      olderInbox = [];
      nextBefore = lens === 'inbox' ? inbox.nextBefore : firstPage.nextBefore;
      loadError = null;
    }
  });

  // The full merged TIMELINE list (head + appended older pages), newest-first. De-duped by id so a
  // live re-invalidation that re-fetches the head can't double an entry an older page also carried.
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

  // The full INBOX list (head + appended older pages), newest-first, de-duped by id.
  const inboxItems = $derived.by(() => {
    const seen = new Set<string>();
    const out: InboxItem[] = [];
    for (const it of [...inbox.items, ...olderInbox.flat()]) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
    return out;
  });

  const counts = $derived(inbox.counts);

  const partial = $derived(connected && lens === 'timeline' && !firstPage.complete);
  const failed = $derived(firstPage.failedSources ?? []);
  const isEmpty = $derived(
    connected && (lens === 'inbox' ? inboxItems.length === 0 : entries.length === 0)
  );

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

  /** Navigate, preserving scope/status, with an updated single query key (server-driven — the
   *  loader re-runs for exactly the active lens). */
  function nav(mutate: (q: URLSearchParams) => void) {
    const q = new URLSearchParams(page.url.searchParams);
    mutate(q);
    const qs = q.toString();
    void goto(qs ? `/atelier?${qs}` : '/atelier', { keepFocus: true, noScroll: true });
  }

  /** Switch the active lens (timeline ↔ inbox). The status filter is lens-specific — drop it when
   *  leaving the inbox so a timeline URL never carries a stale ?status=. */
  function setLens(value: 'timeline' | 'inbox') {
    nav((q) => {
      if (value === 'timeline') {
        q.delete('lens');
        q.delete('status');
      } else {
        q.set('lens', 'inbox');
      }
    });
  }

  /** Navigate with an updated scope (server-driven — the loader re-runs). */
  function setScope(value: string) {
    nav((q) => {
      if (value === '' || value === 'all') q.delete('project');
      else q.set('project', value);
    });
  }

  /** Set (or clear, value='all') the inbox status filter. */
  function setStatus(value: PeerStatus | 'all') {
    nav((q) => {
      if (value === 'all') q.delete('status');
      else q.set('status', value);
    });
  }

  /** Fetch the next (older) page via the JSON endpoint and append it, for the ACTIVE lens. Bounded
   *  — one page, newest-first cursor. The endpoint returns the lens-appropriate body shape. */
  async function loadOlder() {
    if (!nextBefore || loadingMore) return;
    loadingMore = true;
    loadError = null;
    try {
      const q = new URLSearchParams();
      if (scope.kind === 'project') q.set('project', scope.project);
      if (lens === 'inbox') {
        q.set('lens', 'inbox');
        if (inboxStatus) q.set('status', inboxStatus);
      }
      q.set('before', nextBefore);
      const res = await fetch(`/atelier/page?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (lens === 'inbox') {
        const body = (await res.json()) as { items: InboxItem[]; nextBefore: string | null };
        olderInbox = [...olderInbox, body.items ?? []];
        nextBefore = body.nextBefore ?? null;
      } else {
        const body = (await res.json()) as { entries: TimelineEntry[]; nextBefore: string | null };
        olderPages = [...olderPages, body.entries ?? []];
        nextBefore = body.nextBefore ?? null;
      }
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
  <title>Atelier — {lens === 'inbox' ? 'inbox' : 'timeline'}</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">{lens === 'inbox' ? 'fleet inbox' : 'global timeline'}</span>
    <h1 class="title">Atelier</h1>
    {#if lens === 'inbox'}
      <p class="lede">
        The fleet's agent-to-agent comms bus — what is queued, delivered, expired, or quarantined.
        Each message shows sender → recipient, the already-screened body, and its age and remaining
        hops. Read-only: bodies are screened at the source; nothing here is fabricated.
      </p>
    {:else}
      <p class="lede">
        Everything the atelier is doing on one timeline — session reasoning + actions, agent
        communications, PM verdicts, and workforce lifecycle — merged newest-first and labelled by
        actor and project. Read-only: content is already screened at the source; nothing here is
        fabricated.
      </p>
    {/if}
  </header>

  <!-- Lens tabs (timeline ↔ inbox). A real tablist so a reader can switch panes by keyboard. -->
  <div class="lens-tabs" role="tablist" aria-label="atelier lens">
    <button
      type="button"
      role="tab"
      class="lens-tab"
      aria-selected={lens === 'timeline'}
      data-active={lens === 'timeline'}
      onclick={() => setLens('timeline')}
    >
      Timeline
    </button>
    <button
      type="button"
      role="tab"
      class="lens-tab"
      aria-selected={lens === 'inbox'}
      data-active={lens === 'inbox'}
      onclick={() => setLens('inbox')}
    >
      Inbox
    </button>
  </div>

  <!-- Server-driven scope toggle (global vs per-project) + (inbox lens) status filter chips. -->
  <div class="card filters" aria-label="{lens === 'inbox' ? 'inbox' : 'timeline'} filters">
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

    {#if lens === 'inbox'}
      <div class="filter status-filter" role="group" aria-label="filter by status">
        <span class="filter-label">status</span>
        <div class="chips">
          <button
            type="button"
            class="chip"
            data-active={inboxStatus === null}
            aria-pressed={inboxStatus === null}
            disabled={!connected}
            onclick={() => setStatus('all')}
          >
            all
          </button>
          {#each STATUSES as s (s)}
            <button
              type="button"
              class="chip"
              data-status={s}
              data-active={inboxStatus === s}
              aria-pressed={inboxStatus === s}
              disabled={!connected}
              onclick={() => setStatus(s)}
            >
              {STATUS_LABEL[s]}
              {#if counts}<span class="chip-count mono">{counts[s]}</span>{/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if connected}
      <span class="scope-note mono">
        {scope.kind === 'project' ? 'project scope' : 'global scope'} · newest first
      </span>
    {/if}
  </div>

  {#if !connected}
    <!-- DB-down / error — honest, never zero-dressed-as-real (D-019). -->
    <div class="card state state-error" role="status">
      <p>The {lens === 'inbox' ? 'inbox' : 'timeline'} source is unavailable.</p>
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
        {#if lens === 'inbox'}
          <p>
            No {inboxStatus ?? ''} comms in this {scope.kind === 'project' ? 'project' : 'window'}.
            Agent-to-agent messages will appear here as they are sent.
          </p>
        {:else}
          <p>
            No activity in this {scope.kind === 'project' ? 'project' : 'window'} yet. Sessions,
            communications, verdicts, and workforce events will appear here as they happen.
          </p>
        {/if}
      </div>
    {:else if lens === 'inbox'}
      <!-- §5b INBOX LENS: the peer_message bus, filterable by status. role=log so a reader
           announces new comms; each row names from→to, status, age, hops, and the screened body. -->
      <ol class="inbox" role="log" aria-label="fleet inbox, newest first">
        {#each inboxItems as it (it.id)}
          <li class="inbox-item">
            <div class="inbox-head">
              <span class="status" data-status={it.status}>{it.status}</span>
              <span class="route mono">
                <span class="from">{it.from}</span>
                <span class="arrow" aria-hidden="true">→</span>
                <span class="to" data-pending={it.recipientPending}>{it.to}</span>
              </span>
              {#if it.project !== '—'}<span class="proj mono">· {it.project}</span>{/if}
              <time class="ago mono" datetime={it.createdAt ?? ''}>{ago(it.createdAt ?? '')}</time>
            </div>
            {#if it.recipientPending}
              <!-- D-040 placeholder — pm/atelier have no concrete recipient session yet (honest). -->
              <p class="pending-note" role="note">
                awaiting recipient identity ({it.toKind} address — not yet routed)
              </p>
            {/if}
            <div class="inbox-body mono">
              {#if it.body.trim()}{it.body}{:else}<span class="empty">(empty body)</span>{/if}
            </div>
            <div class="inbox-foot mono">
              <span class="foot-item">hops {it.hops}</span>
              {#if it.deliveredAt}
                <span class="foot-item">delivered {ago(it.deliveredAt)}</span>
              {:else}
                <span class="foot-item muted">not delivered</span>
              {/if}
            </div>
          </li>
        {/each}
      </ol>

      <div class="more">
        {#if nextBefore}
          <button class="more-btn" type="button" onclick={loadOlder} disabled={loadingMore}>
            {loadingMore ? 'loading…' : 'Load older'}
          </button>
        {:else}
          <span class="more-end mono">end of inbox window</span>
        {/if}
        {#if loadError}<span class="more-err mono">could not load: {loadError}</span>{/if}
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

  /* ── Lens tabs (timeline ↔ inbox) ─────────────────────────────────────────────── */
  .lens-tabs {
    display: flex;
    gap: var(--space-2, 0.4rem);
    border-bottom: var(--border-width, 1px) solid var(--color-border);
  }
  .lens-tab {
    appearance: none;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--color-text-muted);
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    padding: 0.35rem 0.6rem;
    margin-bottom: -1px;
    cursor: pointer;
  }
  .lens-tab[data-active='true'] {
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
  }
  .lens-tab:hover:not([data-active='true']) {
    color: var(--color-text);
  }
  .lens-tab:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs, 3px);
  }

  /* ── Inbox status filter chips ─────────────────────────────────────────────────── */
  .status-filter {
    flex-direction: column;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.35rem);
  }
  .chip {
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: var(--color-surface-overlay);
    color: var(--color-text-muted);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-pill, 999px);
    padding: 0.2rem 0.6rem;
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .chip[data-active='true'] {
    color: var(--color-text);
    border-color: var(--color-accent);
    background: var(--color-accent-muted, var(--color-surface-card));
  }
  .chip:hover:not(:disabled):not([data-active='true']) {
    border-color: var(--color-border-strong);
  }
  .chip:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .chip-count {
    font-size: 0.66rem;
    color: var(--color-text-muted);
  }

  /* ── Inbox list ─────────────────────────────────────────────────────────────────── */
  .inbox {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.6rem);
  }
  .inbox-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.35rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    background: var(--color-surface-card);
    padding: var(--space-3, 0.6rem) var(--space-4, 0.75rem);
  }
  .inbox-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .status {
    font-size: 0.62rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
    flex: none;
  }
  /* Status hues from tokens — pending/expired/quarantined read as caution/error; delivered ok. */
  .status[data-status='delivered'] {
    color: var(--color-success, var(--color-running));
    border-color: var(--color-success, var(--color-running));
  }
  .status[data-status='pending'] {
    color: var(--color-warn, var(--color-text));
    border-color: var(--color-warn, var(--color-border-strong));
  }
  .status[data-status='expired'] {
    color: var(--color-text-muted);
    border-color: var(--color-border-strong);
  }
  .status[data-status='quarantined'] {
    color: var(--color-error-on-overlay);
    border-color: var(--color-error-on-overlay);
  }
  .route {
    font-size: 0.76rem;
    color: var(--color-text);
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .route .from,
  .route .to {
    font-weight: 600;
  }
  .route .arrow {
    color: var(--color-text-muted);
  }
  .route .to[data-pending='true'] {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .pending-note {
    margin: 0;
    font-size: 0.7rem;
    color: var(--color-text-muted);
    font-style: italic;
  }
  .inbox-body {
    font: var(--type-body-sm);
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--color-surface-overlay);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-2, 0.4rem) var(--space-3, 0.55rem);
  }
  .inbox-body .empty {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .inbox-foot {
    display: flex;
    gap: var(--space-3, 0.7rem);
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .inbox-foot .muted {
    opacity: 0.8;
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
