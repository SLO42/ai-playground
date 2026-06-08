<script lang="ts">
  /**
   * /claude-code — harness hub, v0.1 READ-ONLY config catalog (UI-SPEC §313).
   *
   * Lists the Claude Code config mirror per scope (hooks / skills / agents / MCP
   * servers) with each scope's synced / out-of-sync state (UI-SPEC §214). All data
   * is LIVE from the cc_* mirror (F-008 — no fabricated rows); honest empty states
   * when nothing is synced or the DB isn't connected yet. Svelte 5 runes only.
   */
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const scopes = $derived(data.scopes ?? []);
  const connected = $derived(data.connected);

  function statusLabel(s: string): string {
    if (s === 'synced') return 'synced';
    if (s === 'out_of_sync') return 'out of sync · edited on disk';
    return 'not synced';
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">harness</span>
    <h1 class="title">Claude Code</h1>
    <p class="lede">
      Read-only catalog of the Claude Code config mirror — hooks, skills, agents,
      and MCP servers per scope. The filesystem is authoritative; this view mirrors
      <span class="mono">.claude/</span> + <span class="mono">.mcp.json</span> and
      flags drift when a file is edited on disk.
    </p>
  </header>

  {#if !connected}
    <div class="card empty">
      <span class="eyebrow">offline</span>
      <p class="card-body">
        The database is not connected — no mirror to read yet. Run a config sync
        once the runtime is wired.
      </p>
    </div>
  {:else if scopes.length === 0}
    <div class="card empty">
      <span class="eyebrow">empty</span>
      <p class="card-body">
        No config scopes synced yet. Sync a project's
        <span class="mono">.claude/</span> directory to populate the catalog.
      </p>
    </div>
  {:else}
    <div class="scopes">
      {#each scopes as scope (scope.scopeId)}
        <article class="card scope">
          <div class="scope-head">
            <div class="scope-id">
              <span class="kind mono">{scope.kind}</span>
              <span class="path mono" title={scope.path}>{scope.path}</span>
            </div>
            <span class="status status-{scope.status}">{statusLabel(scope.status)}</span>
          </div>

          <div class="catalog">
            <!-- Hooks -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">hooks</span>
                <span class="count mono">{scope.hooks.length}</span>
              </div>
              {#if scope.hooks.length}
                <ul class="rows">
                  {#each scope.hooks as h (h.event + h.command)}
                    <li class="row">
                      <span class="tag mono">{h.event}</span>
                      {#if h.matcher}<span class="matcher mono">{h.matcher}</span>{/if}
                      <span class="cmd mono">{h.command}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- Skills -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">skills</span>
                <span class="count mono">{scope.skills.length}</span>
              </div>
              {#if scope.skills.length}
                <ul class="rows">
                  {#each scope.skills as k (k.file_path)}
                    <li class="row">
                      <span class="name mono">{k.name}</span>
                      {#if k.plugin}<span class="tag mono">{k.plugin}</span>{/if}
                      {#if k.description}<span class="desc">{k.description}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- Agents -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">agents</span>
                <span class="count mono">{scope.agents.length}</span>
              </div>
              {#if scope.agents.length}
                <ul class="rows">
                  {#each scope.agents as a (a.file_path)}
                    <li class="row">
                      <span class="name mono">{a.name}</span>
                      {#if a.category}<span class="tag mono">{a.category}</span>{/if}
                      {#if a.description}<span class="desc">{a.description}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>

            <!-- MCP servers -->
            <div class="cat">
              <div class="cat-head">
                <span class="eyebrow">mcp servers</span>
                <span class="count mono">{scope.mcpServers.length}</span>
              </div>
              {#if scope.mcpServers.length}
                <ul class="rows">
                  {#each scope.mcpServers as m (m.name)}
                    <li class="row">
                      <span class="name mono">{m.name}</span>
                      <span class="tag mono">{m.type}</span>
                      <span class="cmd mono">{m.command ?? m.url ?? ''}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="none">none</p>
              {/if}
            </div>
          </div>
        </article>
      {/each}
    </div>
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
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .card-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .scopes {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .scope {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .scope-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .scope-id {
    display: flex;
    align-items: baseline;
    gap: var(--space-3, 0.75rem);
    min-width: 0;
  }
  .kind {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-accent);
  }
  .path {
    font-size: 0.8rem;
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Sync-state chips (UI-SPEC §214). */
  .status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-sm, 6px);
    white-space: nowrap;
  }
  .status-synced {
    color: var(--color-success);
    background: var(--color-success-bg);
  }
  .status-out_of_sync {
    color: var(--color-warn);
    background: var(--color-warn-bg);
  }
  .status-unsynced {
    color: var(--color-blocked);
    background: var(--color-blocked-bg);
  }
  .catalog {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-4, 1rem);
  }
  .cat {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    min-width: 0;
  }
  .cat-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
    padding-bottom: var(--space-1, 0.25rem);
  }
  .count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.78rem;
    padding: 0.25rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    min-width: 0;
  }
  .name {
    color: var(--color-text);
    font-weight: 500;
  }
  .tag {
    font-size: 0.68rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, transparent);
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm, 6px);
  }
  .matcher {
    font-size: 0.7rem;
    color: var(--color-text-2);
  }
  .cmd {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1 1 auto;
  }
  .desc {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    flex: 1 1 100%;
  }
  .none {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    font-style: italic;
  }
</style>
