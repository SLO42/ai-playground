<script lang="ts">
  /**
   * /reports — analytics dashboards (UI-SPEC §6 /reports; §8.1 chart design).
   *
   * Daily agent-activity rollups + anomaly flags + per-tier usage, all LIVE from the DB
   * (F-008 — no fabricated metric). Four honest states (loading/empty/error/live,
   * §1.3/§8). Live by default (§1.2): an `agent_event` row change on the one SSE stream
   * re-invalidates the loader so rollups + anomalies update in place. Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const days = $derived(data.days ?? []);
  const anomalies = $derived(data.anomalies ?? []);
  const totals = $derived(data.totals);
  const usage = $derived(data.usage ?? []);
  const findings = $derived(data.findings ?? []);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);
  const hasData = $derived(days.length > 0);

  // Maintain rollup: counts per severity for the header + the grouped list.
  const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
  const severityCounts = $derived(
    SEVERITIES.map((sev) => ({ sev, n: findings.filter((f) => f.severity === sev).length }))
  );

  // Peak day metric for the bar chart scale.
  const peakRuns = $derived(Math.max(1, ...days.map((d) => d.spawns)));

  // Live updates: an agent_event (or routing_event) row change re-runs the loader;
  // a security_finding row change re-runs the Maintain rollup in place (UI-SPEC §1.2).
  $effect(() => {
    const off1 = stream.onDbChange('agent_event', () => void invalidate('app:analytics'));
    const off2 = stream.onDbChange('routing_event', () => void invalidate('app:analytics'));
    const off3 = stream.onDbChange('security_finding', () => void invalidate('app:findings'));
    return () => {
      off1();
      off2();
      off3();
    };
  });

  function shortProject(id: string | undefined): string {
    return id ? id.replace(/^project:/, '') : '—';
  }

  function fmtCost(c: number | null): string {
    return c == null ? '—' : `$${c.toFixed(2)}`;
  }
  function fmtTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  function fmtMs(ms: number | null): string {
    return ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }
  function pct(r: number | null): string {
    return r == null ? '—' : `${(r * 100).toFixed(0)}%`;
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">analytics</span>
    <h1 class="title">Reports</h1>
    <p class="lede">
      Daily agent activity, cost, and outcomes — rolled up from real run events, with
      anomaly flags when a day departs from its trend. No figure is fabricated: cost
      shows <span class="mono">—</span> until runs report a priced cost.
    </p>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no analytics rather than fabricated
        numbers. {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else if !hasData}
    <div class="card state">
      <span class="eyebrow">empty</span>
      <p class="state-body">No agent activity in the last 14 days yet — run a task to populate reports.</p>
    </div>
  {:else}
    <!-- KPI row (window totals) -->
    <ul class="kpis" aria-label="window totals">
      <li class="card kpi"><span class="kpi-val">{totals.spawns}</span><span class="kpi-label">runs</span></li>
      <li class="card kpi"><span class="kpi-val">{totals.completions}</span><span class="kpi-label">completions</span></li>
      <li class="card kpi"><span class="kpi-val" data-tone={totals.errors > 0 ? 'warn' : ''}>{totals.errors}</span><span class="kpi-label">errors</span></li>
      <li class="card kpi"><span class="kpi-val">{totals.escalations}</span><span class="kpi-label">escalations</span></li>
      <li class="card kpi"><span class="kpi-val mono">{fmtTokens(totals.tokensIn + totals.tokensOut)}</span><span class="kpi-label">tokens</span></li>
      <li class="card kpi"><span class="kpi-val mono">{fmtCost(totals.costUsd)}</span><span class="kpi-label">cost</span></li>
    </ul>

    <!-- Anomaly flags -->
    {#if anomalies.length}
      <div class="card anomalies" aria-label="anomalies">
        <span class="eyebrow">anomaly flags</span>
        <ul class="anomaly-list">
          {#each anomalies as a (a.day + a.kind)}
            <li class="anomaly" data-kind={a.kind}>
              <span class="anomaly-kind mono">{a.kind}</span>
              <span class="anomaly-msg">{a.message}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Daily activity bar chart (runs/day) + table -->
    <div class="card chart-card">
      <span class="eyebrow">daily activity</span>
      <h2 class="chart-title">{totals.spawns} runs over {days.length} active days</h2>
      <div class="chart" role="img" aria-label="runs per day">
        {#each days as d (d.day)}
          <div class="bar-col" title={`${d.day}: ${d.spawns} runs, ${pct(d.errorRate)} errors`}>
            <div class="bar" style={`height:${Math.round((d.spawns / peakRuns) * 100)}%`} data-error={d.errors > 0}></div>
            <span class="bar-label mono">{d.day.slice(5)}</span>
          </div>
        {/each}
      </div>

      <table class="rollup-table">
        <thead>
          <tr><th>day</th><th>runs</th><th>done</th><th>errors</th><th>esc</th><th>tokens</th><th>cost</th><th>avg dur</th><th>err rate</th></tr>
        </thead>
        <tbody>
          {#each days as d (d.day)}
            <tr>
              <td class="mono">{d.day}</td>
              <td>{d.spawns}</td>
              <td>{d.completions}</td>
              <td data-tone={d.errors > 0 ? 'warn' : ''}>{d.errors}</td>
              <td>{d.escalations}</td>
              <td class="mono">{fmtTokens(d.tokensIn + d.tokensOut)}</td>
              <td class="mono">{fmtCost(d.costUsd)}</td>
              <td class="mono">{fmtMs(d.avgDurationMs)}</td>
              <td class="mono">{pct(d.errorRate)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Per-tier usage -->
    {#if usage.length}
      <div class="card chart-card">
        <span class="eyebrow">usage by tier</span>
        <h2 class="chart-title">Cost & volume by model tier (30 days)</h2>
        <table class="rollup-table">
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
      </div>
    {/if}

    <!-- Maintain rollup: security_finding rows across all projects (UI-SPEC §207/§315) -->
    <div class="card findings-card">
      <span class="eyebrow">maintain · security findings</span>
      <h2 class="chart-title">
        {findings.length} open {findings.length === 1 ? 'finding' : 'findings'} across all projects
      </h2>
      {#if findings.length}
        <ul class="sev-summary" aria-label="findings by severity">
          {#each severityCounts as s (s.sev)}
            <li class="sev-chip" data-sev={s.sev} data-empty={s.n === 0}>
              <span class="sev-n">{s.n}</span><span class="sev-label">{s.sev}</span>
            </li>
          {/each}
        </ul>
        <table class="rollup-table">
          <thead>
            <tr><th>severity</th><th>project</th><th>rule</th><th>location</th><th>detail</th></tr>
          </thead>
          <tbody>
            {#each findings as f (f.id)}
              <tr>
                <td><span class="sev-tag" data-sev={f.severity}>{f.severity}</span></td>
                <td class="mono">{shortProject(f.project)}</td>
                <td class="mono">{f.rule}</td>
                <td class="mono">{f.file ?? '—'}{#if f.line}:{f.line}{/if}</td>
                <td>{f.detail ?? '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="state-body">
          No open security findings — every scanned project is clean, or no project has been
          scanned yet. Findings appear here the moment a scan writes them.
        </p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    max-width: 1100px;
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
  .kpis {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--space-3, 0.75rem);
  }
  .kpi {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    align-items: flex-start;
  }
  .kpi-val {
    font-size: 1.6rem;
    font-weight: 700;
    color: var(--color-text);
  }
  .kpi-val[data-tone='warn'] {
    color: var(--color-warning, #d08200);
  }
  .kpi-label {
    font-size: 0.72rem;
    text-transform: lowercase;
    color: var(--color-text-muted);
  }
  .anomalies {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-color: var(--color-warning, #d08200);
  }
  .anomaly-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .anomaly {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
  }
  .anomaly-kind {
    font-size: 0.68rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    color: var(--color-warning, #d08200);
    white-space: nowrap;
  }
  .anomaly-msg {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .chart-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .chart-title {
    font: var(--type-h3, 1rem/1.3 sans-serif);
    color: var(--color-text);
  }
  .chart {
    display: flex;
    align-items: flex-end;
    gap: 0.3rem;
    height: 140px;
    padding-top: 0.5rem;
  }
  .bar-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    gap: 0.25rem;
    min-width: 0;
  }
  .bar {
    width: 70%;
    min-height: 2px;
    border-radius: 3px 3px 0 0;
    background: var(--color-accent, #4f7cff);
    transition: height 0.3s ease;
  }
  .bar[data-error='true'] {
    background: var(--color-warning, #d08200);
  }
  .bar-label {
    font-size: 0.6rem;
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .rollup-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .rollup-table th {
    text-align: left;
    font-weight: 600;
    color: var(--color-text-muted);
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    text-transform: lowercase;
  }
  .rollup-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
    color: var(--color-text-2);
  }
  .rollup-table td[data-tone='warn'] {
    color: var(--color-warning, #d08200);
    font-weight: 600;
  }
  .tier-tag {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    color: var(--color-text);
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
  .findings-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .sev-summary {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .sev-chip {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
  }
  .sev-chip[data-empty='true'] {
    opacity: 0.45;
  }
  .sev-n {
    font-weight: 700;
    color: var(--color-text);
  }
  .sev-label {
    font-size: 0.7rem;
    text-transform: lowercase;
    color: var(--color-text-muted);
  }
  .sev-tag {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    font-weight: 600;
  }
  .sev-tag[data-sev='critical'],
  .sev-chip[data-sev='critical'] .sev-n {
    color: var(--color-danger, #d33b3b);
  }
  .sev-tag[data-sev='high'],
  .sev-chip[data-sev='high'] .sev-n {
    color: var(--color-warning, #d08200);
  }
  .sev-tag[data-sev='medium'],
  .sev-chip[data-sev='medium'] .sev-n {
    color: var(--color-accent, #4f7cff);
  }
  .sev-tag[data-sev='low'],
  .sev-chip[data-sev='low'] .sev-n {
    color: var(--color-text-muted);
  }
</style>
