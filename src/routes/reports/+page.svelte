<script lang="ts">
  /**
   * /reports — analytics dashboards (UI-SPEC §6/§206/§207/§208; §8.1 chart design).
   *
   * The operator's core requirement: see HOW + WHY every routing decision was made. Plus the
   * daily activity rollups, the Maintain rollup (security + dep-health + UX), and the durable
   * incidents + notifications history (the RightTray "see all" target). All LIVE from the DB
   * (F-008 — no fabricated metric); four honest states (loading/empty/error/live, §1.3/§8).
   *
   * Filters (project / time range / model) are SERVER-driven: changing one navigates with an
   * updated ?query so the loader re-runs and every panel reflects the same filtered rows. Live
   * by default (§1.2): a routing_event / agent_event / security_finding / notification / incident
   * row change re-invalidates the matching loader key so the page updates in place. Runes only.
   */
  import { invalidate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const filters = $derived(data.filters);
  const projectOptions = $derived(data.projectOptions ?? []);
  const modelOptions = $derived(data.modelOptions ?? []);
  const dayOptions = $derived(data.dayOptions ?? [1, 7, 14, 30, 90]);
  const days = $derived(data.days ?? []);
  const anomalies = $derived(data.anomalies ?? []);
  const totals = $derived(data.totals);
  const usage = $derived(data.usage ?? []);
  const routing = $derived(data.routing ?? { decisions: [], aggregate: { total: 0, byTier: [], byModel: [], byMethod: [], overrideRate: null, overrides: 0 } });
  const decisions = $derived(routing.decisions);
  const agg = $derived(routing.aggregate);
  const findings = $derived(data.findings ?? []);
  const notifications = $derived(data.notifications ?? []);
  const incidents = $derived(data.incidents ?? []);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);
  const hasData = $derived(days.length > 0);
  const hasRouting = $derived(decisions.length > 0);

  // Maintain rollup: split findings into families + per-severity counts (UI-SPEC §207).
  const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
  const FAMILIES = [
    { key: 'security', label: 'security' },
    { key: 'dependency', label: 'dependency health' },
    { key: 'ux', label: 'UX' }
  ] as const;
  const byFamily = $derived(
    FAMILIES.map((fam) => ({ ...fam, items: findings.filter((f) => f.family === fam.key) }))
  );
  const severityCounts = $derived(
    SEVERITIES.map((sev) => ({ sev, n: findings.filter((f) => f.severity === sev).length }))
  );

  // Peak day metric for the bar chart scale.
  const peakRuns = $derived(Math.max(1, ...days.map((d) => d.spawns)));
  // Aggregate-bar scales (the largest bucket fills the bar).
  const peakTier = $derived(Math.max(1, ...agg.byTier.map((b) => b.count)));
  const peakModel = $derived(Math.max(1, ...agg.byModel.map((b) => b.count)));

  // History view: kind filter (all / notifications / incidents).
  let historyKind = $state<'all' | 'notification' | 'incident'>('all');
  const showNotifs = $derived(historyKind === 'all' || historyKind === 'notification');
  const showIncidents = $derived(historyKind === 'all' || historyKind === 'incident');
  const historyCount = $derived(
    (showNotifs ? notifications.length : 0) + (showIncidents ? incidents.length : 0)
  );

  // Live updates: each table change re-invalidates its loader key (UI-SPEC §1.2).
  $effect(() => {
    const offs = [
      stream.onDbChange('agent_event', () => void invalidate('app:analytics')),
      stream.onDbChange('routing_event', () => void invalidate('app:analytics')),
      stream.onDbChange('security_finding', () => void invalidate('app:findings')),
      stream.onDbChange('notification', () => void invalidate('app:shell')),
      stream.onDbChange('incident', () => void invalidate('app:incidents'))
    ];
    return () => offs.forEach((off) => off());
  });

  /** Navigate with an updated filter query (server-driven — the loader re-runs). */
  function setFilter(key: 'project' | 'days' | 'model', value: string) {
    const q = new URLSearchParams(page.url.searchParams);
    if (value === '' || value === 'all') q.delete(key);
    else q.set(key, value);
    const qs = q.toString();
    void goto(qs ? `/reports?${qs}` : '/reports', { keepFocus: true, noScroll: true });
  }

  /** Relative "time ago" for the history feeds (mirrors the tray/Home feed). */
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

  function shortProject(id: string | undefined | null): string {
    return id ? id.replace(/^project:/, '') : '—';
  }
  function shortId(id: string | null): string {
    return id ? (id.split(':').pop()?.slice(0, 8) ?? id) : '—';
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
  function fmtComplexity(c: number | null): string {
    return c == null ? '—' : c.toFixed(2);
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">analytics</span>
    <h1 class="title">Reports</h1>
    <p class="lede">
      Routing decisions with their rationale, daily agent activity, and outcomes — rolled up
      from real run events. No figure is fabricated: cost shows <span class="mono">—</span>
      until runs report a priced cost, and a decision with no run shows
      <span class="mono">pending</span>, never a guessed result.
    </p>
  </header>

  <!-- Server-driven filters (UI-SPEC §6: filter by project/time/model) -->
  <div class="card filters" aria-label="report filters">
    <label class="filter">
      <span class="filter-label">project</span>
      <select
        value={filters.project ?? 'all'}
        onchange={(e) => setFilter('project', e.currentTarget.value)}
        disabled={!connected}
      >
        <option value="all">All projects</option>
        {#each projectOptions as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label class="filter">
      <span class="filter-label">time range</span>
      <select
        value={String(filters.days)}
        onchange={(e) => setFilter('days', e.currentTarget.value)}
        disabled={!connected}
      >
        {#each dayOptions as d (d)}
          <option value={String(d)}>{d === 1 ? '24 hours' : `${d} days`}</option>
        {/each}
      </select>
    </label>
    <label class="filter">
      <span class="filter-label">model</span>
      <select
        value={filters.model ?? 'all'}
        onchange={(e) => setFilter('model', e.currentTarget.value)}
        disabled={!connected || modelOptions.length === 0}
      >
        <option value="all">All models</option>
        {#each modelOptions as m (m)}
          <option value={m}>{m}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no analytics rather than fabricated
        numbers. {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else}
    <!-- ── RoutingRationale (TASK 11.1a): the operator's core requirement ───────── -->
    <div class="card routing-card">
      <span class="eyebrow">routing · how &amp; why</span>
      <h2 class="chart-title">
        {agg.total} routing {agg.total === 1 ? 'decision' : 'decisions'}
        {#if filters.model}for <span class="mono">{filters.model}</span>{/if}
      </h2>

      {#if hasRouting}
        <!-- Aggregate panel: override rate + decisions by tier / model / method -->
        <div class="agg-grid">
          <div class="agg-kpi">
            <span class="agg-val" data-tone={(agg.overrideRate ?? 0) > 0.3 ? 'warn' : ''}>{pct(agg.overrideRate)}</span>
            <span class="agg-label">override rate</span>
            <span class="agg-sub">{agg.overrides} of {agg.total} explicit</span>
          </div>
          <div class="agg-bars">
            <span class="agg-cap">by tier</span>
            {#each agg.byTier as b (b.name)}
              <div class="agg-row">
                <span class="agg-name"><span class="tier-tag" data-tier={b.name}>{b.name}</span></span>
                <span class="agg-track"><span class="agg-fill" style={`width:${Math.round((b.count / peakTier) * 100)}%`}></span></span>
                <span class="agg-n mono">{b.count}</span>
              </div>
            {/each}
          </div>
          <div class="agg-bars">
            <span class="agg-cap">by model</span>
            {#each agg.byModel as b (b.name)}
              <div class="agg-row">
                <span class="agg-name mono" title={b.name}>{b.name}</span>
                <span class="agg-track"><span class="agg-fill" style={`width:${Math.round((b.count / peakModel) * 100)}%`}></span></span>
                <span class="agg-n mono">{b.count}</span>
              </div>
            {/each}
          </div>
          <div class="agg-bars">
            <span class="agg-cap">by method</span>
            {#each agg.byMethod as b (b.name)}
              <div class="agg-row">
                <span class="agg-name"><span class="method-tag" data-method={b.name}>{b.name}</span></span>
                <span class="agg-track"><span class="agg-fill" style={`width:${Math.round((b.count / agg.total) * 100)}%`}></span></span>
                <span class="agg-n mono">{b.count}</span>
              </div>
            {/each}
          </div>
        </div>

        <!-- Per-decision rationale: task → chosen + WHY + outcome -->
        <table class="rollup-table decisions">
          <thead>
            <tr><th>when</th><th>task</th><th>method</th><th>chosen</th><th>why</th><th>cx</th><th>outcome</th></tr>
          </thead>
          <tbody>
            {#each decisions as d (d.id)}
              <tr>
                <td class="mono nowrap">{ago(d.at)}</td>
                <td class="mono">{shortId(d.taskId)}</td>
                <td><span class="method-tag" data-method={d.method}>{d.method}</span></td>
                <td class="chosen-cell">
                  <span class="tier-tag" data-tier={d.tier ?? 'unknown'}>{d.tier ?? '—'}</span>
                  <span class="mono chosen-model">{d.provider}/{d.model}</span>
                </td>
                <td class="why-cell">
                  {d.reason}
                  {#if d.alternatives.length}
                    <span class="alt-note">· {d.alternatives.length} alt{d.alternatives.length === 1 ? '' : 's'} considered</span>
                  {/if}
                </td>
                <td class="mono">{fmtComplexity(d.complexity)}</td>
                <td><span class="outcome-tag" data-outcome={d.outcome}>{d.outcome}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="state-body">
          No routing decisions in this window yet{#if filters.model} for <span class="mono">{filters.model}</span>{/if}.
          Each decision the router makes — the model it chose and why — is recorded here the
          moment a task is routed.
        </p>
      {/if}
    </div>

    {#if !hasData}
      <div class="card state">
        <span class="eyebrow">empty</span>
        <p class="state-body">No agent activity in this window yet — run a task to populate the activity rollups.</p>
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
          <h2 class="chart-title">Cost &amp; volume by model tier (30 days)</h2>
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
    {/if}

    <!-- Maintain rollup: security + dependency-health + UX findings (UI-SPEC §207) -->
    <div class="card findings-card">
      <span class="eyebrow">maintain · findings</span>
      <h2 class="chart-title">
        {findings.length} open {findings.length === 1 ? 'finding' : 'findings'}
        {#if filters.project}for <span class="mono">{shortProject(filters.project)}</span>{:else}across all projects{/if}
      </h2>
      {#if findings.length}
        <ul class="sev-summary" aria-label="findings by severity">
          {#each severityCounts as s (s.sev)}
            <li class="sev-chip" data-sev={s.sev} data-empty={s.n === 0}>
              <span class="sev-n">{s.n}</span><span class="sev-label">{s.sev}</span>
            </li>
          {/each}
        </ul>
        {#each byFamily as fam (fam.key)}
          {#if fam.items.length}
            <div class="family-group">
              <h3 class="family-title">{fam.label} <span class="family-n">{fam.items.length}</span></h3>
              <table class="rollup-table">
                <thead>
                  <tr><th>severity</th><th>project</th><th>rule</th><th>location</th><th>detail</th></tr>
                </thead>
                <tbody>
                  {#each fam.items as f (f.id)}
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
            </div>
          {/if}
        {/each}
      {:else}
        <p class="state-body">
          No open findings{#if filters.project} for this project{/if} — every scanned project is
          clean, or none has been scanned yet. Security, dependency-health, and UX findings
          appear here the moment a scan writes them.
        </p>
      {/if}
    </div>

    <!-- Incidents + notifications history (UI-SPEC §208): the RightTray "see all" target. -->
    <div class="card" id="notifications">
      <div class="history-head">
        <div>
          <span class="eyebrow">history · incidents &amp; notifications</span>
          <h2 class="chart-title">
            {historyCount} {historyCount === 1 ? 'item' : 'items'}
          </h2>
        </div>
        <div class="kind-filter" role="group" aria-label="filter history by kind">
          <button type="button" class="kind-btn" class:active={historyKind === 'all'} onclick={() => (historyKind = 'all')}>All</button>
          <button type="button" class="kind-btn" class:active={historyKind === 'incident'} onclick={() => (historyKind = 'incident')}>Incidents</button>
          <button type="button" class="kind-btn" class:active={historyKind === 'notification'} onclick={() => (historyKind = 'notification')}>Notifications</button>
        </div>
      </div>

      {#if historyCount === 0}
        <p class="state-body">
          Nothing in this view yet. Gate-denial and anomaly incidents, plus operator notices,
          land here and in the right-hand tray.
        </p>
      {:else}
        <ul class="hist-list" aria-label="history">
          {#if showIncidents}
            {#each incidents as inc (inc.id)}
              <li class="hist-row" data-kind="incident">
                <span class="hist-dot" data-sev={inc.severity} aria-hidden="true"></span>
                <div class="hist-body">
                  <p class="hist-msg">
                    <span class="sev-tag" data-isev={inc.severity}>{inc.severity}</span>
                    {inc.title}
                  </p>
                  {#if inc.detail}<p class="hist-detail">{inc.detail}</p>{/if}
                </div>
                <time class="hist-when" datetime={inc.at}>{ago(inc.at)}</time>
              </li>
            {/each}
          {/if}
          {#if showNotifs}
            {#each notifications as n (n.id)}
              <li class="hist-row" class:unread={!n.read} data-kind="notification">
                <span class="hist-dot" data-kind="notification" aria-hidden="true"></span>
                <div class="hist-body">
                  <p class="hist-msg">{n.message || '—'}</p>
                </div>
                <time class="hist-when" datetime={n.at}>{ago(n.at)}</time>
              </li>
            {/each}
          {/if}
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
  .nowrap {
    white-space: nowrap;
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
  }

  /* Filters */
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4, 1rem);
    align-items: flex-end;
  }
  .filter {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    min-width: 160px;
  }
  .filter-label {
    font-size: 0.72rem;
    text-transform: lowercase;
    color: var(--color-text-muted);
  }
  .filter select {
    padding: var(--space-2, 0.5rem);
    border: var(--border-width) solid var(--color-border-strong, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-raised, var(--color-surface-card));
    color: var(--color-text);
    font: var(--type-body-sm);
  }
  .filter select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .state {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 72ch;
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

  /* RoutingRationale */
  .routing-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .agg-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-4, 1rem);
    align-items: start;
  }
  .agg-kpi {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .agg-val {
    font-size: 2rem;
    font-weight: 700;
    color: var(--color-text);
  }
  .agg-val[data-tone='warn'] {
    color: var(--color-warning, #d08200);
  }
  .agg-label {
    font-size: 0.72rem;
    text-transform: lowercase;
    color: var(--color-text-muted);
  }
  .agg-sub {
    font-size: 0.72rem;
    color: var(--color-text-2);
  }
  .agg-bars {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .agg-cap {
    font-size: 0.72rem;
    text-transform: lowercase;
    color: var(--color-text-muted);
    margin-bottom: 0.15rem;
  }
  .agg-row {
    display: grid;
    grid-template-columns: 5.5rem 1fr 1.6rem;
    align-items: center;
    gap: var(--space-2, 0.5rem);
  }
  .agg-name {
    font-size: 0.72rem;
    color: var(--color-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agg-track {
    height: 8px;
    border-radius: var(--radius-pill, 4px);
    background: var(--color-surface-overlay);
    overflow: hidden;
  }
  .agg-fill {
    display: block;
    height: 100%;
    background: var(--color-accent, #4f7cff);
    border-radius: var(--radius-pill, 4px);
  }
  .agg-n {
    font-size: 0.72rem;
    color: var(--color-text-2);
    text-align: right;
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
  @media (prefers-reduced-motion: reduce) {
    .bar {
      transition: none;
    }
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
    vertical-align: top;
  }
  .rollup-table td[data-tone='warn'] {
    color: var(--color-warning, #d08200);
    font-weight: 600;
  }
  .decisions .why-cell {
    max-width: 36ch;
    color: var(--color-text-2);
  }
  .alt-note {
    color: var(--color-text-muted);
    font-size: 0.72rem;
  }
  .chosen-cell {
    white-space: nowrap;
  }
  .chosen-model {
    margin-left: 0.35rem;
    color: var(--color-text-muted);
    font-size: 0.72rem;
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
  .method-tag {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    color: var(--color-text-2);
  }
  .method-tag[data-method='explicit'] {
    color: var(--color-warning, #d08200);
  }
  .method-tag[data-method='fallback'] {
    color: var(--color-danger, #d33b3b);
  }
  .method-tag[data-method='classify'] {
    color: var(--color-accent, #4f7cff);
  }
  .outcome-tag {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    color: var(--color-text-2);
  }
  .outcome-tag[data-outcome='done'] {
    color: var(--color-success, #2f9e44);
  }
  .outcome-tag[data-outcome='failed'] {
    color: var(--color-danger, #d33b3b);
  }
  .outcome-tag[data-outcome='running'] {
    color: var(--color-accent, #4f7cff);
  }
  .outcome-tag[data-outcome='pending'],
  .outcome-tag[data-outcome='cancelled'] {
    color: var(--color-text-muted);
  }

  .findings-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .family-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .family-title {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-text);
    text-transform: lowercase;
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
  }
  .family-n {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    font-weight: 400;
  }

  /* History (incidents + notifications) */
  .history-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-2);
  }
  .kind-filter {
    display: inline-flex;
    gap: 0;
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    overflow: hidden;
  }
  .kind-btn {
    padding: var(--space-1, 0.25rem) var(--space-3, 0.75rem);
    border: 0;
    background: transparent;
    color: var(--color-text-2);
    font: var(--type-body-sm);
    cursor: pointer;
    border-right: var(--border-width) solid var(--color-border);
  }
  .kind-btn:last-child {
    border-right: 0;
  }
  .kind-btn:hover {
    background: var(--color-surface-overlay);
  }
  .kind-btn.active {
    background: var(--color-accent, #4f7cff);
    color: var(--color-on-accent, #fff);
  }
  .hist-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .hist-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: var(--border-width) solid var(--color-border);
  }
  .hist-row:last-child {
    border-bottom: none;
  }
  .hist-dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    margin-top: 7px;
    border-radius: var(--radius-pill);
    background: var(--color-neutral);
  }
  .hist-dot[data-kind='notification'] {
    background: var(--color-accent);
  }
  .hist-dot[data-sev='warn'] {
    background: var(--color-warning, #d08200);
  }
  .hist-dot[data-sev='error'],
  .hist-dot[data-sev='critical'] {
    background: var(--color-danger, #d33b3b);
  }
  .hist-row:not(.unread)[data-kind='notification'] .hist-dot {
    background: var(--color-neutral);
  }
  .hist-body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .hist-msg {
    font: var(--type-body-sm);
    color: var(--color-text);
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .hist-detail {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .hist-when {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
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
  .sev-chip[data-sev='critical'] .sev-n,
  .sev-tag[data-isev='critical'] {
    color: var(--color-danger, #d33b3b);
  }
  .sev-tag[data-sev='high'],
  .sev-chip[data-sev='high'] .sev-n,
  .sev-tag[data-isev='error'] {
    color: var(--color-warning, #d08200);
  }
  .sev-tag[data-sev='medium'],
  .sev-chip[data-sev='medium'] .sev-n,
  .sev-tag[data-isev='warn'] {
    color: var(--color-accent, #4f7cff);
  }
  .sev-tag[data-sev='low'],
  .sev-chip[data-sev='low'] .sev-n,
  .sev-tag[data-isev='info'] {
    color: var(--color-text-muted);
  }
</style>
