<script lang="ts">
  /**
   * /agents/catalog — the "Available Agents" LIBRARY view (operator brain).
   *
   * Browse every specialist agent definition with its CONTEXT (when-to-use body, capabilities,
   * type/color/priority, raw file) + best-effort USAGE metrics (calls / last-used / success-fail
   * / avg duration). The LISTING is filesystem-authoritative (read from the platform repo's
   * .claude/agents); USAGE is bridged honestly by name === role.slug ⋈ session (F-008 — an agent
   * with no matching role is UNMAPPED "no runs yet", never a fabricated zero). The full
   * when-to-use body + raw file are lazy-loaded per agent on select (bounded — F-014). Live off
   * the SSE `session` stream. Svelte 5 runes; design tokens; a11y.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const agents = $derived(data.agents ?? []);
  const types = $derived(data.types ?? []);
  const connected = $derived(data.connected);
  const libraryFound = $derived(data.libraryFound);
  const libraryDir = $derived(data.libraryDir);
  const mapped = $derived(data.mapped ?? 0);
  const unmapped = $derived(data.unmapped ?? 0);
  const loadError = $derived('error' in data ? (data.error as string | undefined) : undefined);

  let query = $state('');
  let typeFilter = $state<string | null>(null);
  let selected = $state<string | null>(null); // relPath

  type Content = { status: 'loading' | 'ok' | 'error'; whenToUse?: string; raw?: string; message?: string };
  let contentCache = $state<Record<string, Content>>({});
  let rawOpen = $state<Record<string, boolean>>({});

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (typeFilter && a.type !== typeFilter) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q) ||
        (a.category ?? '').toLowerCase().includes(q) ||
        a.capabilities.some((c) => c.toLowerCase().includes(q))
      );
    });
  });

  const selectedAgent = $derived(selected ? (agents.find((a) => a.relPath === selected) ?? null) : null);

  async function selectAgent(relPath: string) {
    selected = relPath;
    if (contentCache[relPath]?.status === 'ok') return;
    contentCache = { ...contentCache, [relPath]: { status: 'loading' } };
    try {
      const res = await fetch(`/agents/catalog/content?path=${encodeURIComponent(relPath)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { whenToUse: string; raw: string };
      contentCache = {
        ...contentCache,
        [relPath]: { status: 'ok', whenToUse: body.whenToUse, raw: body.raw }
      };
    } catch (e) {
      contentCache = { ...contentCache, [relPath]: { status: 'error', message: (e as Error).message } };
    }
  }

  // Live: a session/role row change refreshes the usage bridge in place (D-035).
  $effect(() => {
    const offs = ['session', 'role', 'role_version'].map((t) =>
      stream.onDbChange(t, () => void invalidate('app:fleet'))
    );
    return () => offs.forEach((off) => off());
  });

  function fmtWhen(iso: string | null): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const diff = Date.now() - t;
    const m = Math.floor(diff / 60000),
      h = Math.floor(m / 60),
      d = Math.floor(h / 24);
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    if (m > 0) return `${m}m ago`;
    return 'just now';
  }
  function fmtDur(ms: number | null): string {
    if (ms == null) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">harness · available agents</span>
    <h1 class="title">Agent library</h1>
    <p class="lede">
      Every specialist agent the harness can spawn, read straight from its definition file —
      with its when-to-use, capabilities, and the usage it has seen. Usage is bridged by agent
      name ⋈ <span class="mono">role.slug</span>; an agent with no matching certified role shows
      <strong>no runs yet</strong> rather than a fabricated count.
    </p>
    <p class="crumbs"><a class="inline-link" href="/agents">← Agents (fleet &amp; usage)</a></p>
  </header>

  {#if !libraryFound}
    <p class="empty" role="status">
      Agent library not found on disk. Set <span class="mono">AGENT_LIBRARY_CLAUDE_DIR</span> to a
      <span class="mono">.claude</span> directory (its <span class="mono">agents/</span> subfolder
      holds the definitions), then restart. Showing nothing rather than fabricated agents.
    </p>
  {:else if agents.length === 0}
    <p class="empty" role="status">
      The library resolved{libraryDir ? ` (${libraryDir})` : ''} but holds no agent
      <span class="mono">.md</span> files. Showing nothing rather than fabricated agents.
    </p>
  {:else}
    <div class="meta-bar">
      <span class="count mono">{agents.length} agents</span>
      <span class="dot">·</span>
      {#if connected}
        <span class="cov" title="agents whose name matched a certified role.slug">
          <span class="ok-mark">{mapped} mapped</span> / {unmapped} no runs
        </span>
      {:else}
        <span class="cov degraded">usage unavailable — DB not connected{loadError ? ` (${loadError})` : ''}</span>
      {/if}
      {#if libraryDir}<span class="dot">·</span><span class="dir mono" title={libraryDir}>{libraryDir}</span>{/if}
    </div>

    <div class="toolbar">
      <input
        class="search"
        type="search"
        placeholder="Search name, description, capability…"
        bind:value={query}
        aria-label="search agents"
      />
      <div class="chips" role="group" aria-label="filter by type">
        <button class="chip" class:active={typeFilter === null} onclick={() => (typeFilter = null)}>
          all types
        </button>
        {#each types as t (t)}
          <button class="chip" class:active={typeFilter === t} onclick={() => (typeFilter = t)}>{t}</button>
        {/each}
      </div>
    </div>

    <div class="split">
      <ul class="list" aria-label="agent library">
        {#if filtered.length === 0}
          <li class="no-match" role="status">No agents match the current search/filter.</li>
        {/if}
        {#each filtered as a (a.relPath)}
          <li>
            <button
              class="row"
              class:selected={selected === a.relPath}
              onclick={() => selectAgent(a.relPath)}
              aria-pressed={selected === a.relPath}
            >
              <span class="swatch" style={`--swatch:${a.color ?? 'var(--color-border)'}`}></span>
              <span class="row-main">
                <span class="row-top">
                  <span class="row-name mono">{a.name}</span>
                  {#if a.type}<span class="type-tag">{a.type}</span>{/if}
                </span>
                <span class="row-desc">{a.description ?? '—'}</span>
              </span>
              <span class="row-usage">
                {#if a.usage}
                  <span class="calls" title="sessions run as this role">{a.usage.calls}×</span>
                  <span class="lastused">{fmtWhen(a.usage.lastUsedAt)}</span>
                {:else}
                  <span class="noruns">no runs</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>

      <div class="detail card" aria-live="polite">
        {#if !selectedAgent}
          <p class="state-body">Select an agent to see its when-to-use, capabilities, and usage.</p>
        {:else}
          {@const a = selectedAgent}
          {@const c = contentCache[a.relPath]}
          {@const u = a.usage}
          <div class="d-head">
            <span class="swatch lg" style={`--swatch:${a.color ?? 'var(--color-border)'}`}></span>
            <div class="d-title">
              <h2 class="d-name mono">{a.name}</h2>
              <p class="d-desc">{a.description ?? '—'}</p>
              <div class="d-badges">
                {#if a.type}<span class="badge">type: {a.type}</span>{/if}
                {#if a.priority}<span class="badge">priority: {a.priority}</span>{/if}
                {#if a.category}<span class="badge">category: {a.category}</span>{/if}
                {#if a.color}<span class="badge mono">{a.color}</span>{/if}
              </div>
              <p class="d-path mono" title={a.relPath}>{a.relPath}</p>
            </div>
          </div>

          <!-- USAGE (best-effort bridge — honest about confidence) -->
          <div class="d-section">
            <span class="d-label">usage</span>
            {#if !connected}
              <p class="state-body small">DB not connected — usage cannot be computed.</p>
            {:else if u}
              <div class="usage-grid">
                <div><span class="u-n">{u.calls}</span><span class="u-k">calls</span></div>
                <div><span class="u-n">{u.done}</span><span class="u-k">done</span></div>
                <div><span class="u-n">{u.failed}</span><span class="u-k">failed</span></div>
                <div><span class="u-n">{u.running}</span><span class="u-k">running</span></div>
                <div><span class="u-n">{fmtWhen(u.lastUsedAt)}</span><span class="u-k">last used</span></div>
                <div><span class="u-n">{fmtDur(u.avgDurationMs)}</span><span class="u-k">avg duration</span></div>
              </div>
              <p class="mapnote">
                Mapped by slug <span class="mono">{u.slug}</span>{#if u.roleName} ({u.roleName}){/if}.
              </p>
            {:else}
              <p class="state-body small">
                No certified role matches this agent's name — <strong>no runs recorded</strong>.
                The definition exists, but no session has run as it (unmapped).
              </p>
            {/if}
          </div>

          <!-- CAPABILITIES -->
          <div class="d-section">
            <span class="d-label">capabilities</span>
            {#if a.capabilities.length}
              <div class="caps">
                {#each a.capabilities as cap (cap)}<span class="cap mono">{cap}</span>{/each}
              </div>
            {:else}
              <p class="state-body small">None declared in frontmatter.</p>
            {/if}
          </div>

          <!-- WHEN-TO-USE (the md body) + raw file (lazy-loaded) -->
          <div class="d-section">
            <span class="d-label">when to use / instructions</span>
            {#if !c || c.status === 'loading'}
              <p class="state-body small">Loading definition…</p>
            {:else if c.status === 'error'}
              <p class="state-body small">Could not read the file{c.message ? ` (${c.message})` : ''}.</p>
            {:else if c.whenToUse && c.whenToUse.trim()}
              <pre class="when">{c.whenToUse}</pre>
            {:else}
              <p class="state-body small">This definition has no body text beyond its frontmatter.</p>
            {/if}
          </div>

          {#if c?.status === 'ok' && c.raw}
            <div class="d-section">
              <button
                class="raw-toggle"
                onclick={() => (rawOpen = { ...rawOpen, [a.relPath]: !rawOpen[a.relPath] })}
                aria-expanded={!!rawOpen[a.relPath]}
              >
                {rawOpen[a.relPath] ? '▾' : '▸'} raw file
              </button>
              {#if rawOpen[a.relPath]}
                <pre class="raw mono">{c.raw}</pre>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack, 1.5rem);
    padding: var(--space-5, 1.25rem);
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .eyebrow {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-accent);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
    margin: 0;
  }
  .lede {
    max-width: 70ch;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    margin: 0;
  }
  .crumbs {
    margin: 0;
    font-size: var(--text-sm);
  }
  .inline-link {
    color: var(--color-accent);
    text-decoration: none;
  }
  .inline-link:hover {
    text-decoration: underline;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .empty {
    color: var(--color-text-muted);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 0.5rem);
    padding: var(--space-4, 1rem);
    font-size: var(--text-sm);
  }

  .meta-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .dot {
    opacity: 0.5;
  }
  .ok-mark {
    color: var(--color-success, #3fb950);
  }
  .cov.degraded {
    color: var(--color-warning, #d29922);
  }
  .dir {
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 38ch;
    white-space: nowrap;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3, 0.75rem);
    align-items: center;
  }
  .search {
    flex: 1 1 16rem;
    min-width: 12rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 0.5rem);
    color: var(--color-text);
    padding: 0.4rem 0.6rem;
    font-size: var(--text-sm);
  }
  .search:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .chip {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-text-muted);
    padding: 0.2rem 0.6rem;
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .chip.active {
    background: var(--color-accent);
    color: var(--color-bg, #0d1117);
    border-color: var(--color-accent);
  }
  .chip:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  .split {
    display: grid;
    grid-template-columns: minmax(18rem, 22rem) 1fr;
    gap: var(--space-4, 1rem);
    align-items: start;
  }
  @media (max-width: 56rem) {
    .split {
      grid-template-columns: 1fr;
    }
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-height: 75vh;
    overflow-y: auto;
  }
  .no-match {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    padding: var(--space-3, 0.75rem);
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    text-align: left;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 0.5rem);
    padding: 0.5rem 0.65rem;
    cursor: pointer;
    color: var(--color-text);
  }
  .row:hover {
    border-color: var(--color-accent);
  }
  .row.selected {
    border-color: var(--color-accent);
    box-shadow: inset 0 0 0 1px var(--color-accent);
  }
  .row:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .swatch {
    width: 0.6rem;
    height: 1.6rem;
    border-radius: 3px;
    background: var(--swatch);
    flex: 0 0 auto;
  }
  .swatch.lg {
    height: 2.6rem;
    width: 0.5rem;
  }
  .row-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .row-top {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .row-name {
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .type-tag {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
    flex: 0 0 auto;
  }
  .row-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-usage {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.1rem;
    font-size: var(--text-xs);
  }
  .calls {
    font-weight: 600;
    color: var(--color-text);
  }
  .lastused,
  .noruns {
    color: var(--color-text-muted);
  }
  .noruns {
    opacity: 0.7;
    font-style: italic;
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 0.5rem);
    padding: var(--space-4, 1rem);
  }
  .detail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
    min-height: 12rem;
  }
  .state-body {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    margin: 0;
  }
  .state-body.small {
    font-size: var(--text-xs);
  }
  .d-head {
    display: flex;
    gap: var(--space-3, 0.75rem);
  }
  .d-title {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0;
  }
  .d-name {
    font: var(--type-h2, 600 1.1rem/1.3 inherit);
    margin: 0;
    color: var(--color-text);
  }
  .d-desc {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }
  .d-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .badge {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
  }
  .d-path {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    opacity: 0.8;
  }
  .d-section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-3, 0.75rem);
  }
  .d-label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-accent);
  }
  .usage-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(5rem, 1fr));
    gap: 0.5rem;
  }
  .usage-grid div {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    background: var(--color-bg, rgba(0, 0, 0, 0.15));
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.4rem 0.5rem;
  }
  .u-n {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
  }
  .u-k {
    font-size: 0.65rem;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .mapnote {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .caps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .cap {
    font-size: var(--text-xs);
    background: var(--color-bg, rgba(0, 0, 0, 0.15));
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    color: var(--color-text);
  }
  .when {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--color-text);
    max-height: 32rem;
    overflow-y: auto;
  }
  .raw-toggle {
    background: none;
    border: none;
    color: var(--color-accent);
    cursor: pointer;
    font-size: var(--text-xs);
    padding: 0;
    text-align: left;
  }
  .raw-toggle:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .raw {
    margin: 0.4rem 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--text-xs);
    line-height: 1.45;
    color: var(--color-text-muted);
    background: var(--color-bg, rgba(0, 0, 0, 0.2));
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.6rem;
    max-height: 28rem;
    overflow: auto;
  }
</style>
