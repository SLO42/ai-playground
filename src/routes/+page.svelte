<script lang="ts">
  /**
   * Home — portfolio + engine overview (UI-SPEC §6). The real dashboard: four headline
   * MetricCards, a recent-activity feed, a portfolio task summary, the LIVE AgentFleetGrid
   * (running/recent sessions — the SAME liveness source as /agents), and a "start a manual
   * run" entry point. All LIVE from the DB (F-008) — unknown values render as "—" (honest,
   * §1.3), never a fabricated number. Live by default (§1.2): a row change on the one SSE
   * stream re-invalidates the matching region. Tokens-only · a11y · reduced-motion (motion
   * vars are zeroed under prefers-reduced-motion at the token layer). Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  // The known task statuses, in board order (mirrors TASK_STATUSES in the tasks repo —
  // kept inline so this client component never imports server-only code). Drives a stable
  // summary board: every status shows, 0 when absent.
  const TASK_STATUSES = [
    'backlog',
    'ready',
    'in_progress',
    'review',
    'blocked',
    'done',
    'failed'
  ] as const;

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const projectCount = $derived(data.projectCount);
  const metrics = $derived(data.metrics);
  const services = $derived(data.services);
  const activity = $derived(data.activity ?? []);
  const taskSummary = $derived(data.taskSummary);
  const fleet = $derived(data.fleet ?? []);

  const running = $derived(fleet.filter((f) => f.status === 'running'));
  const recent = $derived(fleet.filter((f) => f.status !== 'running'));

  // Live: each region re-invalidates on its own table's SSE watcher (the one stream).
  $effect(() => {
    const offs = [
      stream.onDbChange('project', () => void invalidate('app:projects')),
      stream.onDbChange('session', () => void invalidate('app:fleet')),
      stream.onDbChange('agent_event', () => void invalidate('app:analytics')),
      stream.onDbChange('service', () => void invalidate('app:services')),
      stream.onDbChange('task', () => void invalidate('app:tasks'))
    ];
    return () => offs.forEach((off) => off());
  });

  // ── formatters (honest "—" for unknowns; F-008) ──────────────────────────────────
  const fmtInt = (n: number | null | undefined): string =>
    n == null ? '—' : n.toLocaleString('en-US');
  const fmtTokens = (n: number | null | undefined): string =>
    n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const fmtCost = (c: number | null | undefined): string =>
    c == null ? '—' : `$${c.toFixed(2)}`;
  const fmtServices = (s: typeof services): string =>
    !s || s.total === 0 ? '—' : `${s.up}/${s.total}`;
  const shortId = (id: string): string => id.split(':').pop()?.slice(0, 8) ?? id;

  // Relative "time ago" for the activity feed (deterministic, tokens-free copy).
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

  // Portfolio task summary: render every KNOWN status (0 when absent) for a stable board.
  const summaryRows = $derived(
    taskSummary
      ? TASK_STATUSES.map((s) => ({ status: s, count: taskSummary.byStatus[s] ?? 0 }))
      : []
  );
</script>

<svelte:head>
  <title>Dashboard — Atelier</title>
</svelte:head>

<section class="home">
  <header class="page-head">
    <span class="eyebrow">portfolio</span>
    <h1 class="title">Dashboard</h1>
    <p class="lede">
      At-a-glance health of the portfolio and engine. Live from the database over one
      event stream — no manual refresh.
    </p>
  </header>

  {#if !connected}
    <div class="card state" role="status">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — metrics show <span class="mono">—</span> instead of
        a fabricated number. Start SurrealDB and reload.
      </p>
    </div>
  {/if}

  <!-- Region 1 — headline MetricCards -->
  <ul class="metrics" aria-label="portfolio metrics">
    <li class="card metric">
      <span class="eyebrow">projects</span>
      <span class="metric-value tnum mono" data-unknown={projectCount == null}>
        {fmtInt(projectCount)}
      </span>
      <span class="metric-foot">under management</span>
    </li>
    <li class="card metric">
      <span class="eyebrow">active sessions</span>
      <span class="metric-value tnum mono" data-unknown={metrics == null}>
        {fmtInt(metrics?.runningAgents)}
      </span>
      <span class="metric-foot">agents running now</span>
    </li>
    <li class="card metric">
      <span class="eyebrow">today's tokens</span>
      <span class="metric-value tnum mono" data-unknown={metrics == null}>
        {fmtTokens(metrics?.tokensToday)}
      </span>
      <span class="metric-foot">cost {fmtCost(metrics?.costToday)}</span>
    </li>
    <li class="card metric">
      <span class="eyebrow">services up</span>
      <span class="metric-value tnum mono" data-unknown={!services || services.total === 0}>
        {fmtServices(services)}
      </span>
      <span class="metric-foot">self-reported health</span>
    </li>
  </ul>

  <!-- Region 2 — manual run entry point -->
  <div class="card run-cta">
    <div class="run-copy">
      <span class="eyebrow">start a manual run</span>
      <p class="state-body">
        Kick off a workflow run — each step is a tracked, live-streamed session.
      </p>
    </div>
    <a class="btn" href="/workflows">Start a run →</a>
  </div>

  <!-- Region 3+4 — two columns: recent activity · portfolio task summary -->
  <div class="cols">
    <section class="card col" aria-labelledby="activity-head">
      <span class="eyebrow" id="activity-head">recent activity</span>
      {#if activity.length === 0}
        <p class="state-body">
          {connected
            ? 'No agent activity yet — start a run to populate the feed.'
            : 'Activity is unavailable while the database is disconnected.'}
        </p>
      {:else}
        <ul class="feed">
          {#each activity as ev (ev.id)}
            <li class="feed-item">
              <span class="ev-type" data-type={ev.type}>{ev.type}</span>
              <span class="ev-model mono">{ev.model ?? '—'}</span>
              <span class="ev-when">{ago(ev.at)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card col" aria-labelledby="tasks-head">
      <div class="panel-head">
        <span class="eyebrow" id="tasks-head">portfolio tasks</span>
        <span class="count mono">
          {taskSummary ? `${taskSummary.total} total` : '—'}
        </span>
      </div>
      {#if !taskSummary || taskSummary.total === 0}
        <p class="state-body">
          {connected
            ? 'No tasks yet across the portfolio.'
            : 'Task summary is unavailable while the database is disconnected.'}
        </p>
      {:else}
        <ul class="task-summary">
          {#each summaryRows as row (row.status)}
            <li class="ts-row">
              <span class="ts-status" data-status={row.status}>{row.status}</span>
              <span class="ts-count tnum mono">{row.count}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <!-- Region 5 — LIVE AgentFleetGrid (same liveness source as /agents) -->
  <section class="card" aria-labelledby="fleet-head">
    <div class="panel-head">
      <span class="eyebrow" id="fleet-head">agent fleet</span>
      <span class="count mono">{running.length} running · {recent.length} recent</span>
    </div>
    {#if fleet.length === 0}
      <p class="state-body">
        {connected
          ? 'No sessions yet — launch a task to populate the fleet.'
          : 'The fleet is unavailable while the database is disconnected.'}
      </p>
    {:else}
      <ul class="fleet-grid" aria-label="agent fleet">
        {#each running as s (s.id)}
          <li class="agent running">
            <span class="agent-status" data-status="running">running</span>
            <span class="agent-model mono">{s.provider}/{s.modelId}</span>
            {#if s.tier}<span class="tier-tag" data-tier={s.tier}>{s.tier}</span>{/if}
            <span class="agent-id mono">{shortId(s.id)}</span>
          </li>
        {/each}
        {#each recent as s (s.id)}
          <li class="agent">
            <span class="agent-status" data-status={s.status}>{s.status}</span>
            <span class="agent-model mono">{s.provider}/{s.modelId}</span>
            {#if s.tier}<span class="tier-tag" data-tier={s.tier}>{s.tier}</span>{/if}
            <span class="agent-id mono">{shortId(s.id)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

<style>
  .home {
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
    max-width: 64ch;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card);
  }

  /* Region 1 — metrics */
  .metrics {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: var(--space-4);
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .metric-value {
    font-size: var(--text-3xl);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text);
    line-height: 1;
  }
  .metric-value[data-unknown='true'] {
    color: var(--color-text-muted);
  }
  .metric-foot {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }
  .eyebrow {
    font-size: var(--text-xs, 0.72rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

  /* Region 2 — run CTA */
  .run-cta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    flex-wrap: wrap;
  }
  .run-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .btn {
    font: var(--type-body-sm);
    font-weight: var(--weight-medium, 500);
    color: var(--color-text-inverse);
    background: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: var(--radius-sm);
    padding: var(--space-3) var(--space-5);
    text-decoration: none;
    white-space: nowrap;
    transition: filter var(--motion-fast, 120ms) ease;
  }
  .btn:hover {
    filter: brightness(1.08);
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-text-link);
    outline-offset: 2px;
  }

  /* Region 3+4 — two columns */
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: var(--gap-stack);
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .count {
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-muted);
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

  /* activity feed */
  .feed {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .feed-item {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
  }
  .feed-item:last-child {
    border-bottom: none;
  }
  .ev-type {
    font-size: var(--text-xs, 0.68rem);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text-muted);
    min-width: 5.5rem;
  }
  .ev-type[data-type='completion'] {
    color: var(--color-success);
  }
  .ev-type[data-type='spawn'] {
    color: var(--color-running);
  }
  .ev-type[data-type='error'] {
    color: var(--color-error);
  }
  .ev-model {
    font-size: var(--text-xs, 0.74rem);
    color: var(--color-text-2);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ev-when {
    font-size: var(--text-xs, 0.7rem);
    color: var(--color-text-muted);
    margin-left: auto;
    white-space: nowrap;
  }

  /* portfolio task summary */
  .task-summary {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .ts-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
  }
  .ts-row:last-child {
    border-bottom: none;
  }
  .ts-status {
    font-size: var(--text-sm, 0.8rem);
    color: var(--color-text-2);
    text-transform: capitalize;
  }
  .ts-status[data-status='done'] {
    color: var(--color-success);
  }
  .ts-status[data-status='in_progress'] {
    color: var(--color-running);
  }
  .ts-status[data-status='failed'],
  .ts-status[data-status='blocked'] {
    color: var(--color-error);
  }
  .ts-count {
    font-size: var(--text-sm, 0.85rem);
    color: var(--color-text);
    font-weight: var(--weight-medium, 500);
  }

  /* Region 5 — fleet grid */
  .fleet-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-4);
    margin-top: var(--space-4);
  }
  .agent {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-overlay);
  }
  .agent.running {
    border-color: var(--color-running);
  }
  .agent-status {
    font-size: var(--text-xs, 0.68rem);
    font-weight: var(--weight-semibold, 600);
    text-transform: lowercase;
    color: var(--color-text-muted);
  }
  .agent-status[data-status='running'] {
    color: var(--color-running);
  }
  .agent-status[data-status='failed'] {
    color: var(--color-error);
  }
  .agent-status[data-status='done'] {
    color: var(--color-success);
  }
  .agent-model {
    font-size: var(--text-xs, 0.74rem);
    color: var(--color-text);
  }
  .agent-id {
    font-size: var(--text-xs, 0.66rem);
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .tier-tag {
    font-size: var(--text-xs, 0.68rem);
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--color-surface-card);
    color: var(--color-text);
  }
  .tier-tag[data-tier='opus'] {
    color: var(--color-text-accent, var(--color-accent));
  }
</style>
