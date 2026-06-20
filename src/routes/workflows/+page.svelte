<script lang="ts">
  /**
   * /workflows — headless CC pipeline list + run history + run detail (UI-SPEC §47/§218;
   * §5 WorkflowBuilder/RunView). Three surfaces: workflow DEFINITIONS, run HISTORY, and a
   * selected run's DETAIL (per-step session records, §4.11). All LIVE from the DB (F-008 —
   * no fabricated run). Four honest states (loading/empty/error/live, §1.3/§8). Live by
   * default (§1.2): a `workflow`/`workflow_run`/`session` row change on the one SSE stream
   * re-invalidates the loader so list + detail update in place. Svelte 5 runes only.
   */
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import LiveBadge from '$lib/components/shell/LiveBadge.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Which workflow row is mid-run (disables its button + shows progress).
  let runningId = $state<string | null>(null);

  const connected = $derived(data.connected);
  const workflows = $derived(data.workflows ?? []);
  const runs = $derived(data.runs ?? []);
  const detail = $derived(data.detail);
  const selectedRun = $derived(data.selectedRun);
  // A query/load failure while the DB is still connected — distinct from the
  // disconnected state below (honest operator messaging, not "database disconnected").
  const queryError = $derived('queryError' in data ? (data.queryError as string | undefined) : undefined);

  const hasWorkflows = $derived(workflows.length > 0);
  const hasRuns = $derived(runs.length > 0);

  // Honest live-feed health for the run-history region (F-008): silent when cleanly
  // live, surfaces "live: reconnecting/disconnected" when the server-side `workflow_run`
  // LIVE subscription degrades, so a stalled run list is never shown as current.
  const runLiveness = $derived(stream.tableLiveness('workflow_run'));

  // Live updates: workflow/run/session row changes re-run the loader (UI-SPEC §1.2).
  $effect(() => {
    const off1 = stream.onDbChange('workflow', () => void invalidate('app:workflows'));
    const off2 = stream.onDbChange('workflow_run', () => void invalidate('app:workflows'));
    const off3 = stream.onDbChange('session', () => void invalidate('app:workflows'));
    return () => {
      off1();
      off2();
      off3();
    };
  });

  function shortId(id: string): string {
    return id.replace(/^\w+:/, '');
  }
  function shortProject(id: string | undefined): string {
    return id ? id.replace(/^project:/, '') : '—';
  }
  function fmtTime(iso: string | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }
  function runHref(id: string): string {
    return `${page.url.pathname}?run=${encodeURIComponent(id)}`;
  }
  /**
   * Build the REAL transcript link for a step's session: the project-scoped Sessions route
   * `/projects/<slug>?session=<id>` (the same surface openSession uses). The slug is the bare
   * project record id. Returns null when the session has no resolvable project — the row then
   * shows the id as plain text rather than a DEAD link (the /claude-code dead-click FAIL).
   */
  function sessionHref(s: { sessionId?: string; sessionProject?: string }): string | null {
    if (!s.sessionId || !s.sessionProject) return null;
    const slug = s.sessionProject.replace(/^project:/, '');
    return `/projects/${encodeURIComponent(slug)}?session=${encodeURIComponent(s.sessionId)}`;
  }
</script>

<svelte:head>
  <title>Workflows — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">harness</span>
    <h1 class="title">Workflows</h1>
    <p class="lede">
      Headless Claude Code pipelines — multi-step workflow definitions and the history of
      their runs, each step a real session. Live from the engine; no run is fabricated.
    </p>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no workflows rather than fabricated runs.
        Start SurrealDB and reload.
      </p>
    </div>
  {:else}
    {#if queryError}
      <!-- DB IS connected; a query/load failed. Say THAT — not "disconnected". -->
      <div class="card state" data-state="query-error">
        <span class="eyebrow">query failed</span>
        <p class="state-body">
          The database is connected, but loading workflows failed. Retry, or check the
          query logs. <span class="mono">{queryError}</span>
        </p>
      </div>
    {/if}
    <!-- Workflow definitions -->
    <div class="card">
      <span class="eyebrow">definitions · {workflows.length}</span>
      {#if !hasWorkflows}
        <p class="state-body">
          No workflows defined yet — pipelines appear here once a workflow is created.
        </p>
      {:else}
        <table class="rollup-table">
          <thead>
            <tr><th>name</th><th>trigger</th><th>steps</th><th>project</th><th>created</th><th></th></tr>
          </thead>
          <tbody>
            {#each workflows as w (w.id)}
              <tr>
                <td>{w.name}</td>
                <td><span class="trigger-tag" data-trigger={w.trigger}>{w.trigger}</span></td>
                <td class="mono">{w.stepCount}</td>
                <td class="mono">{shortProject(w.project)}</td>
                <td class="mono">{fmtTime(w.createdAt)}</td>
                <td>
                  <!-- Job 10: run this workflow (PRODUCT §4.10). -->
                  <form
                    method="POST"
                    action="?/run"
                    use:enhance={() => {
                      runningId = w.id;
                      return async ({ update }) => {
                        await update({ reset: false });
                        runningId = null;
                      };
                    }}
                  >
                    <input type="hidden" name="workflowId" value={w.id} />
                    <button class="run-btn" type="submit" disabled={runningId === w.id}>
                      {runningId === w.id ? 'running…' : 'run'}
                    </button>
                  </form>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#if form?.run && 'error' in form.run}
        <p class="form-error" role="alert">{form.run.error}</p>
      {:else if form?.run && 'ok' in form.run}
        <p class="form-ok">Run {shortId(form.run.runId)} started · {form.run.status}</p>
      {/if}
    </div>

    <!-- Run history -->
    <div class="card">
      <div class="region-head">
        <span class="eyebrow">run history · {runs.length}</span>
        <LiveBadge phase={runLiveness} />
      </div>
      {#if !hasRuns}
        <p class="state-body">No runs yet — a run appears here the moment a workflow executes.</p>
      {:else}
        <table class="rollup-table">
          <thead>
            <tr><th>run</th><th>workflow</th><th>status</th><th>steps</th><th>started</th><th></th></tr>
          </thead>
          <tbody>
            {#each runs as r (r.id)}
              {@const stepN = Object.keys(r.stepState).length}
              {@const doneN = Object.values(r.stepState).filter((s) => s === 'done').length}
              <tr data-selected={selectedRun === r.id}>
                <td class="mono">{shortId(r.id)}</td>
                <td>{r.workflowName ?? shortId(r.workflow)}</td>
                <td><span class="status-tag" data-status={r.status}>{r.status}</span></td>
                <td class="mono">{doneN}/{stepN}</td>
                <td class="mono">{fmtTime(r.startedAt)}</td>
                <td><a class="detail-link" href={runHref(r.id)}>detail</a></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Run detail (RunView §5): per-step session records -->
    {#if selectedRun}
      <div class="card detail">
        {#if detail}
          <div class="detail-head">
            <span class="eyebrow">run detail</span>
            <h2 class="chart-title">
              {detail.run.workflowName ?? shortId(detail.run.workflow)}
              <span class="status-tag" data-status={detail.run.status}>{detail.run.status}</span>
            </h2>
            <span class="mono detail-id">{shortId(detail.run.id)}</span>
            <span class="mono detail-time">
              {fmtTime(detail.run.startedAt)}{#if detail.run.endedAt} → {fmtTime(detail.run.endedAt)}{/if}
            </span>
          </div>

          {#if detail.steps.length}
            <table class="rollup-table">
              <thead>
                <tr><th>step</th><th>status</th><th>session</th><th>session status</th><th>model</th></tr>
              </thead>
              <tbody>
                {#each detail.steps as s (s.stepId)}
                  {@const href = sessionHref(s)}
                  <tr>
                    <td class="mono">{s.stepId}</td>
                    <td><span class="status-tag" data-status={s.status}>{s.status}</span></td>
                    <td class="mono">
                      {#if s.sessionId}
                        {#if href}
                          <!-- Real transcript link: the project-scoped Sessions route. -->
                          <a class="detail-link" href={href}>{shortId(s.sessionId)} →</a>
                        {:else}
                          <!-- Session exists but has no resolvable project — show the id as
                               plain text, never a dead click (honest degrade). -->
                          <span title="no project — transcript not linkable">{shortId(s.sessionId)}</span>
                        {/if}
                      {:else}—{/if}
                    </td>
                    <td>
                      {#if s.sessionStatus}
                        <span class="status-tag" data-status={s.sessionStatus}>{s.sessionStatus}</span>
                      {:else}—{/if}
                    </td>
                    <td class="mono">
                      {#if s.provider}{s.provider}/{s.modelId}{#if s.tier} · {s.tier}{/if}{:else}—{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <p class="state-body">This run has no recorded steps.</p>
          {/if}
        {:else}
          <span class="eyebrow">run detail</span>
          <p class="state-body">
            Run <span class="mono">{shortId(selectedRun)}</span> not found — it may have been removed.
          </p>
        {/if}
      </div>
    {/if}
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
  .region-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
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
  .state {
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .chart-title {
    font: var(--type-h3, 1rem/1.3 sans-serif);
    color: var(--color-text);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .detail-head {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .detail-id,
  .detail-time {
    font-size: 0.72rem;
    color: var(--color-text-muted);
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
  .rollup-table tr[data-selected='true'] td {
    background: var(--color-surface-overlay);
  }
  .detail-link {
    color: var(--color-accent, #8ab0ab);
    text-decoration: none;
    font-size: 0.76rem;
  }
  .detail-link:hover {
    text-decoration: underline;
  }
  .detail-link:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 2px;
  }
  .trigger-tag,
  .status-tag {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    font-weight: 600;
    color: var(--color-text);
  }
  .status-tag[data-status='running'] {
    color: var(--color-running, var(--color-accent, #8ab0ab));
  }
  .status-tag[data-status='done'] {
    color: var(--color-success, #6fae6f);
  }
  .status-tag[data-status='failed'] {
    /* ONE failed red app-wide: --color-error; the -on-overlay tint hits
       BODY AA on the overlay tag background (14.3). */
    color: var(--color-error-on-overlay);
  }
  .status-tag[data-status='cancelled'],
  .status-tag[data-status='pending'] {
    color: var(--color-text-muted);
  }
  .run-btn {
    appearance: none;
    background: var(--color-accent);
    color: var(--color-text-inverse, var(--color-bg, #03120e));
    border: var(--border-width, 1px) solid var(--color-accent);
    border-radius: var(--radius-sm, 6px);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.2rem 0.7rem;
    cursor: pointer;
    min-height: 24px;
  }
  .run-btn:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .run-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .run-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error);
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
</style>
