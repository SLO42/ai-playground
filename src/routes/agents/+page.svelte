<script lang="ts">
  /**
   * /agents — agent fleet + usage LENS (UI-SPEC §198–200).
   *
   * Tier-centric LENS: pool tier/role DEFINITIONS (config mirror), the LIVE fleet of
   * running/recent sessions (liveness from session.status — never agent_slot.busy,
   * §199), and per-tier usage analytics. All LIVE from the DB (F-008). Live by default
   * (§1.2): a `session` or `agent_event` row change on the one SSE stream re-invalidates
   * the loader so the fleet grid + usage update in place. Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const pool = $derived(data.pool ?? []);
  const fleet = $derived(data.fleet ?? []);
  const usage = $derived(data.usage ?? []);
  const catalog = $derived(data.catalog ?? []);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  const running = $derived(fleet.filter((f) => f.status === 'running'));
  const recent = $derived(fleet.filter((f) => f.status !== 'running'));

  // ── Status-transition motion (DESIGN-SYSTEM §7) ───────────────────────────────
  // When a fleet session's status changes (running → done/failed), flash its tile.
  // The flash is GPU-only (transform/opacity via a keyframe) and its duration rides
  // the `--motion-*` tokens — which collapse to 0ms under prefers-reduced-motion, so
  // reduced-motion users get an INSTANT swap (no animation), no layout thrash.
  // We track the last-seen status per session id; a change marks the tile for one
  // animation cycle, then clears so re-renders don't re-trigger it.
  let lastStatus = $state<Record<string, string>>({});
  let changed = $state<Record<string, number>>({}); // id → nonce; bumped on change

  $effect(() => {
    const next: Record<string, string> = { ...lastStatus };
    let touched = false;
    for (const f of fleet) {
      const prev = lastStatus[f.id];
      if (prev !== undefined && prev !== f.status) {
        changed = { ...changed, [f.id]: (changed[f.id] ?? 0) + 1 };
        // clear the flag after one animation cycle (token-bounded; instant under RM)
        const id = f.id;
        setTimeout(() => {
          const rest = { ...changed };
          delete rest[id];
          changed = rest;
        }, 600);
      }
      if (prev !== f.status) {
        next[f.id] = f.status;
        touched = true;
      }
    }
    if (touched) lastStatus = next;
  });

  // Group pool slots by tier for the definitions panel.
  const poolByTier = $derived.by(() => {
    const m = new Map<string, typeof pool>();
    for (const s of pool) {
      const arr = m.get(s.tier) ?? [];
      arr.push(s);
      m.set(s.tier, arr);
    }
    return [...m.entries()].map(([tier, slots]) => ({ tier, slots }));
  });

  $effect(() => {
    const off1 = stream.onDbChange('session', () => void invalidate('app:fleet'));
    const off2 = stream.onDbChange('agent_event', () => void invalidate('app:analytics'));
    const off3 = stream.onDbChange('cc_agent', () => void invalidate('app:claude-code'));
    return () => {
      off1();
      off2();
      off3();
    };
  });

  function fmtCost(c: number | null): string {
    return c == null ? '—' : `$${c.toFixed(2)}`;
  }
  function fmtTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  function fmtMs(ms: number | null): string {
    return ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }
  function shortId(id: string): string {
    return id.split(':').pop()?.slice(0, 8) ?? id;
  }
  // A project scope id is `project:<slug>` — surface the slug as the honest label.
  function scopeLabel(projectId: string): string {
    return projectId.split(':').pop() ?? projectId;
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">harness</span>
    <h1 class="title">Agents</h1>
    <p class="lede">
      The agent fleet — tier definitions, live sessions, and usage by tier. Liveness is
      read from running sessions, not a pool flag, so the grid always reflects real work.
    </p>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no fleet rather than fabricated agents.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else}
    <!-- Live fleet grid -->
    <div class="card">
      <div class="panel-head">
        <span class="eyebrow">live fleet</span>
        <span class="count mono">{running.length} running · {recent.length} recent</span>
      </div>
      {#if fleet.length === 0}
        <p class="state-body">No sessions yet — launch a task to populate the fleet.</p>
      {:else}
        <ul class="fleet-grid" aria-label="agent fleet">
          {#each running as s (s.id)}
            <li class="agent running" class:status-changed={changed[s.id]} data-status="running">
              <span class="agent-status" data-status="running">
                <span class="dot" aria-hidden="true"></span>running
              </span>
              <span class="agent-model mono">{s.provider}/{s.modelId}</span>
              {#if s.tier}<span class="tier-tag" data-tier={s.tier}>{s.tier}</span>{/if}
              <span class="agent-id mono">{shortId(s.id)}</span>
            </li>
          {/each}
          {#each recent as s (s.id)}
            <li class="agent" class:status-changed={changed[s.id]} data-status={s.status}>
              <span class="agent-status" data-status={s.status}>{s.status}</span>
              <span class="agent-model mono">{s.provider}/{s.modelId}</span>
              {#if s.tier}<span class="tier-tag" data-tier={s.tier}>{s.tier}</span>{/if}
              <span class="agent-id mono">{shortId(s.id)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- Usage by tier -->
    <div class="card">
      <span class="eyebrow">usage by tier (30 days)</span>
      {#if usage.length === 0}
        <p class="state-body">No usage recorded yet.</p>
      {:else}
        <table class="usage-table">
          <thead>
            <tr><th>tier</th><th>provider</th><th>runs</th><th>tokens</th><th>cost</th><th>avg dur</th></tr>
          </thead>
          <tbody>
            {#each usage as u (u.provider + ':' + u.tier)}
              <tr>
                <td><span class="tier-tag" data-tier={u.tier}>{u.tier}</span></td>
                <td class="mono">{u.provider}</td>
                <td>{u.runs}</td>
                <td class="mono">{fmtTokens(u.tokensIn + u.tokensOut)}</td>
                <td class="mono">{fmtCost(u.costUsd)}</td>
                <td class="mono">{fmtMs(u.avgDurationMs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Pool definitions (config mirror — not live allocation) -->
    <div class="card">
      <span class="eyebrow">pool (tier definitions)</span>
      {#if pool.length === 0}
        <p class="state-body">No pool slots configured.</p>
      {:else}
        <div class="pool">
          {#each poolByTier as group (group.tier)}
            <div class="pool-tier">
              <span class="tier-tag" data-tier={group.tier}>{group.tier}</span>
              <ul class="pool-slots">
                {#each group.slots as slot (slot.id)}
                  <li class="pool-slot mono">{slot.name}<span class="role">{slot.role}</span></li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Agent catalog (available agent TYPES from the cc_agent mirror — 11.3, UI-SPEC §198) -->
    <div class="card">
      <div class="panel-head">
        <span class="eyebrow">agent catalog (available types)</span>
        <span class="count mono">{catalog.length} {catalog.length === 1 ? 'type' : 'types'}</span>
      </div>
      {#if catalog.length === 0}
        <p class="state-body">
          No agent types synced yet — sync a project's <span class="mono">.claude/agents</span> on
          /claude-code to populate the catalog. Showing nothing rather than fabricated agents.
        </p>
      {:else}
        <ul class="catalog" aria-label="agent catalog">
          {#each catalog as a (a.name)}
            <li class="cat-row">
              <div class="cat-head">
                <span class="cat-name mono">{a.name}</span>
                {#if a.category}<span class="cat-cat">{a.category}</span>{/if}
              </div>
              <p class="cat-desc">{a.description ?? '—'}</p>
              <div class="cat-meta">
                <span class="cat-label">capabilities</span>
                {#if a.bundles.length > 0}
                  <span class="cat-bundles">
                    {#each a.bundles as b (b)}<span class="bundle-tag mono">{b}</span>{/each}
                  </span>
                {:else}
                  <span class="cat-none">— not in any capability bundle</span>
                {/if}
              </div>
              <div class="cat-meta">
                <span class="cat-label">defined in</span>
                <span class="cat-scopes">
                  {#each a.scopes as sc, i (sc.kind + ':' + (sc.projectId ?? '') + ':' + i)}
                    <span class="scope-tag" data-kind={sc.kind}>
                      {#if sc.kind === 'project' && sc.projectId}
                        {scopeLabel(sc.projectId)}
                      {:else}
                        {sc.kind}
                      {/if}
                    </span>
                  {/each}
                </span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    width: 100%; /* 14.2a: fluid full-width — the shell gutter (--page-gutter) frames it */
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
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }
  .state {
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .fleet-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-3, 0.75rem);
  }
  .agent {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .agent.running {
    border-color: var(--color-running, var(--color-success, #2a9d4a));
  }
  /* Status-transition motion (DESIGN-SYSTEM §7): a tile whose status just changed
     flashes once. GPU-only (transform/opacity), duration from the --motion-* tokens
     so prefers-reduced-motion (which zeroes those tokens) yields an INSTANT swap with
     no animation. No size change → no layout thrash; the grid never reflows. */
  .agent {
    transition:
      border-color var(--motion-normal) var(--ease-out),
      background var(--motion-normal) var(--ease-out);
    will-change: transform;
  }
  .agent.status-changed {
    animation: agent-status-flash var(--motion-slow) var(--ease-out);
  }
  @keyframes agent-status-flash {
    0% {
      transform: scale(1);
      opacity: 0.55;
    }
    35% {
      transform: scale(1.025);
      opacity: 1;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .agent.status-changed {
      animation: none;
    }
  }
  .agent-status .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill, 999px);
    background: var(--color-running, var(--color-success, #2a9d4a));
    margin-right: 0.3rem;
    vertical-align: middle;
    animation: ds-pulse 1.8s var(--ease-in-out) infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .agent-status .dot {
      animation: none;
    }
  }
  .agent-status {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: lowercase;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
  }
  .agent-status[data-status='running'] {
    color: var(--color-running, var(--color-success, #2a9d4a));
  }
  .agent-status[data-status='failed'] {
    color: var(--color-warning, #d08200);
  }
  .agent-model {
    font-size: 0.74rem;
    color: var(--color-text);
  }
  .agent-id {
    font-size: 0.66rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .usage-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .usage-table th {
    text-align: left;
    font-weight: 600;
    color: var(--color-text-muted);
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    text-transform: lowercase;
  }
  .usage-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
    color: var(--color-text-2);
  }
  .pool {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4, 1rem);
  }
  .pool-tier {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 130px;
  }
  .pool-slots {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .pool-slot {
    font-size: 0.74rem;
    color: var(--color-text-2);
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .role {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .tier-tag {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text);
    width: fit-content;
  }
  .tier-tag[data-tier='opus'] {
    color: var(--color-tier-opus, var(--color-accent));
  }
  .tier-tag[data-tier='sonnet'] {
    color: var(--color-tier-sonnet, var(--color-accent));
  }
  .tier-tag[data-tier='haiku'] {
    color: var(--color-tier-haiku, var(--color-text-muted));
  }
  .tier-tag[data-tier='local'] {
    color: var(--color-tier-local, var(--color-text-muted));
  }

  /* Agent catalog (11.3) */
  .catalog {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3, 0.75rem);
  }
  .cat-row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .cat-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .cat-name {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--color-text);
  }
  .cat-cat {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
  }
  .cat-desc {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .cat-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.7rem;
  }
  .cat-label {
    color: var(--color-text-muted);
    text-transform: lowercase;
    min-width: 5.5rem;
  }
  .cat-bundles,
  .cat-scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .bundle-tag {
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-accent, var(--color-text));
    border: 1px solid var(--color-border);
  }
  .scope-tag {
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text-2);
    border: 1px solid var(--color-border);
  }
  .scope-tag[data-kind='global'] {
    color: var(--color-text-muted);
  }
  .cat-none {
    color: var(--color-text-muted);
    font-style: italic;
  }
</style>
