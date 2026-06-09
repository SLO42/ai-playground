<script lang="ts">
  /**
   * /projects/[id]/sync — the GitHub task↔issue sync surface (TASK 9.4; D-037).
   *
   * Renders the project's sync state LIVE from the DB (F-008 — no fabricated mappings):
   * the honest probe (target repo + auth, or an honest "unavailable" reason), the existing
   * task↔issue mappings (real `task_sync` rows), and a form to run a push / pull / both
   * sync with a dry-run preview. The four honest states (loading / empty / error / live,
   * UI-SPEC §1.3/§8). Live by default (§1.2): a `task` / `task_sync` row change re-runs the
   * loader. Tokens-only, a11y AA, reduced-motion safe. Svelte 5 RUNES only.
   */
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let direction = $state<'push' | 'pull' | 'both'>('both');
  let dryRun = $state(false);
  let syncing = $state(false);
  let boardBusy = $state(false);
  let boardSyncing = $state(false);

  const connected = $derived(data.connected);
  const probe = $derived(data.probe);
  const mappings = $derived(data.mappings ?? []);
  const projectName = $derived(data.projectName ?? data.projectId);
  const repoUrl = $derived(data.repoUrl);
  const directions = $derived(data.directions ?? (['push', 'pull', 'both'] as const));
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);
  const available = $derived(probe?.available ?? false);

  // ── Board sync (TASK 11.4) ──────────────────────────────────────────────────────
  const taskStatuses = $derived(data.taskStatuses ?? []);
  const boardConfig = $derived(data.boardConfig);
  const boardProbe = $derived(data.boardProbe);
  const incidents = $derived(data.incidents ?? []);
  const boardAvailable = $derived(boardProbe?.available ?? false);
  // Local editable copies seeded from the persisted config (live rows, F-008).
  let boardEnabled = $state(false);
  let boardNumber = $state('');
  let boardMap = $state<Record<string, string>>({});
  $effect(() => {
    boardEnabled = boardConfig?.enabled ?? false;
    boardNumber = boardConfig?.boardNumber != null ? String(boardConfig.boardNumber) : '';
    boardMap = { ...(boardConfig?.mapping ?? {}) };
  });

  const slug = $derived(page.params.id);

  const result = $derived(form && 'sync' in form ? (form.sync as Record<string, unknown>) : undefined);
  const boardResult = $derived(
    form && 'board' in form ? (form.board as Record<string, unknown>) : undefined
  );

  function shortId(id: string): string {
    const i = id.indexOf(':');
    return i >= 0 ? id.slice(i + 1) : id;
  }
  function fmtTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // Live updates: a task or mapping change re-runs the server loader.
  $effect(() => {
    const offT = stream.onDbChange('task', () => void invalidate('app:tasks'));
    const offS = stream.onDbChange('task_sync', () => void invalidate('app:sync'));
    const offB = stream.onDbChange('board_sync_config', () => void invalidate('app:sync'));
    const offI = stream.onDbChange('sync_incident', () => void invalidate('app:sync'));
    return () => {
      offT();
      offS();
      offB();
      offI();
    };
  });
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">sync</span>
    <h1 class="title">GitHub sync — {projectName}</h1>
    <p class="lede">
      Reconcile this project's Atelier tasks with GitHub issues — idempotently (each task
      maps to one issue, never duplicated). Credentials are your own <span class="mono"
        >gh auth</span
      > / token, never stored. The reference sync adapter (D-037).
    </p>
    <a class="back" href={`/projects/${slug}`}>← back to project</a>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no sync state rather than a fabricated one.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else}
    <!-- The honest probe: target + auth, or the reason it's unavailable. -->
    <div class="card target">
      <div class="target-head">
        <h2 class="section-title">Target</h2>
        <span class="badge" data-on={available}>{available ? 'ready' : 'unavailable'}</span>
      </div>
      {#if available}
        <p class="target-repo mono">{probe?.target}</p>
        <p class="state-body">Authenticated via the GitHub CLI. A sync will reconcile tasks ↔ issues.</p>
      {:else}
        <p class="state-body" role="status">
          {probe?.reason ?? 'GitHub sync is not available for this project.'}
        </p>
        <p class="hint">
          Authenticate with <span class="mono">gh auth login</span> (or set
          <span class="mono">GH_TOKEN</span> in <span class="mono">.env</span>) and ensure the
          project has a GitHub remote{#if repoUrl} (<span class="mono">{repoUrl}</span>){/if}.
        </p>
      {/if}
    </div>

    <!-- Run a sync. -->
    <div class="card run">
      <h2 class="section-title">Run a sync</h2>
      <form
        method="POST"
        action="?/sync"
        class="run-form"
        use:enhance={() => {
          syncing = true;
          return async ({ update }) => {
            await update({ reset: false });
            syncing = false;
          };
        }}
      >
        <fieldset class="dir-field" disabled={!available || syncing}>
          <legend class="field-label">Direction</legend>
          <div class="dir-options">
            {#each directions as d (d)}
              <label class="radio">
                <input type="radio" name="direction" value={d} bind:group={direction} />
                <span class="radio-label">{d}</span>
              </label>
            {/each}
          </div>
        </fieldset>
        <label class="check">
          <input type="checkbox" name="dryRun" bind:checked={dryRun} disabled={!available || syncing} />
          <span class="check-label">Dry run (preview, no changes)</span>
        </label>
        <button class="btn primary" type="submit" disabled={!available || syncing}>
          {syncing ? 'Syncing…' : dryRun ? 'Preview sync' : 'Sync now'}
        </button>
      </form>

      {#if result}
        {#if 'error' in result}
          <p class="form-error" role="alert">{result.error}</p>
        {:else if 'ok' in result}
          <div class="result" role="status">
            <p class="result-head">
              {result.dryRun ? 'Preview' : 'Synced'} · <span class="mono">{result.target}</span> ·
              {result.direction}
            </p>
            <ul class="counts">
              <li><span class="count mono">{result.created}</span> created</li>
              <li><span class="count mono">{result.updated}</span> updated</li>
              <li><span class="count mono">{result.pulled}</span> pulled</li>
              <li><span class="count mono">{result.linked}</span> linked</li>
              <li><span class="count mono">{result.skipped}</span> skipped</li>
            </ul>
            {#if Array.isArray(result.errors) && result.errors.length > 0}
              <ul class="run-errors">
                {#each result.errors as e (e)}
                  <li class="run-error mono">{e}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      {/if}
    </div>

    <!-- Existing mappings (real task_sync rows). -->
    <div class="card">
      <h2 class="section-title">Mappings <span class="count mono">{mappings.length}</span></h2>
      {#if mappings.length === 0}
        <p class="state-body">
          No task↔issue mappings yet — run a sync and each task's issue will be tracked here.
        </p>
      {:else}
        <ul class="rows" aria-label="task to issue mappings">
          {#each mappings as m (m.taskId)}
            <li class="row mapping">
              <span class="mono task-id" title={m.taskId}>{shortId(m.taskId)}</span>
              <span class="arrow" aria-hidden="true">↔</span>
              {#if m.externalUrl}
                <a class="issue mono" href={m.externalUrl} target="_blank" rel="noopener noreferrer"
                  >#{m.externalId}</a
                >
              {:else}
                <span class="issue mono">#{m.externalId}</span>
              {/if}
              <span class="dir mono">{m.direction}</span>
              <span class="when mono">{fmtTime(m.lastSynced)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- ── Board sync (TASK 11.4): per-project opt-in status → column mapping ─────── -->
    <div class="card board">
      <div class="target-head">
        <h2 class="section-title">Project board sync</h2>
        <span class="badge" data-on={boardAvailable}>{boardAvailable ? 'ready' : 'unavailable'}</span>
      </div>
      <p class="state-body">
        One-way push: each synced task's <em>status</em> sets its issue's column on a GitHub
        Projects board. Per-project, opt-in. Requires the <span class="mono">project</span> gh scope
        and that the task↔issue sync above has run (the board item is the issue).
      </p>
      {#if boardProbe && !boardAvailable}
        <p class="hint" role="status">{boardProbe.reason}</p>
      {:else if boardProbe?.target}
        <p class="target-repo mono">{boardProbe.target}</p>
      {/if}

      <form
        method="POST"
        action="?/saveBoard"
        class="board-form"
        use:enhance={() => {
          boardBusy = true;
          return async ({ update }) => {
            await update({ reset: false });
            boardBusy = false;
          };
        }}
      >
        <label class="check">
          <input type="checkbox" name="enabled" bind:checked={boardEnabled} disabled={boardBusy} />
          <span class="check-label">Enable board sync for this project</span>
        </label>
        <label class="field board-num">
          <span class="field-label">Board number</span>
          <input
            class="pm-input mono"
            type="number"
            name="boardNumber"
            min="1"
            bind:value={boardNumber}
            placeholder="e.g. 3"
            disabled={boardBusy}
          />
        </label>
        <fieldset class="map-field" disabled={boardBusy}>
          <legend class="field-label">Status → board column</legend>
          <div class="map-grid">
            {#each taskStatuses as s (s)}
              <label class="map-row">
                <span class="map-status mono">{s}</span>
                <input
                  class="pm-input mono"
                  type="text"
                  name={`map_${s}`}
                  bind:value={boardMap[s]}
                  placeholder="column name (e.g. Todo)"
                />
              </label>
            {/each}
          </div>
        </fieldset>
        <button class="btn" type="submit" disabled={boardBusy}>
          {boardBusy ? 'Saving…' : 'Save board config'}
        </button>
      </form>

      <!-- Run the board push -->
      <form
        method="POST"
        action="?/syncBoard"
        use:enhance={() => {
          boardSyncing = true;
          return async ({ update }) => {
            await update({ reset: false });
            boardSyncing = false;
          };
        }}
      >
        <button class="btn primary" type="submit" disabled={!boardAvailable || boardSyncing}>
          {boardSyncing ? 'Pushing…' : 'Push to board'}
        </button>
      </form>

      <!-- Honest last-run status (F-008) -->
      {#if boardConfig?.lastStatus}
        <p class="board-status" data-status={boardConfig.lastStatus} role="status">
          Last sync:
          <span class="mono">{boardConfig.lastStatus}</span>
          {#if boardConfig.lastSynced}· {fmtTime(boardConfig.lastSynced)}{/if}
          {#if boardConfig.lastStatus === 'error' && boardConfig.lastError}
            — <span class="mono">{boardConfig.lastError}</span>
          {/if}
        </p>
      {:else}
        <p class="state-body">No board sync has run yet.</p>
      {/if}

      {#if boardResult}
        {#if 'error' in boardResult}
          <p class="form-error" role="alert">{boardResult.error}</p>
        {:else if boardResult.action === 'config'}
          <p class="result-head">Board config saved ({boardResult.enabled ? 'enabled' : 'disabled'}).</p>
        {:else if boardResult.action === 'sync'}
          <p class="result-head">
            Board push · <span class="mono">{boardResult.target}</span> —
            {boardResult.updated} updated, {boardResult.skipped} skipped.
          </p>
        {/if}
      {/if}

      <!-- Sync incidents (failures — never silent) -->
      {#if incidents.length > 0}
        <div class="incidents">
          <h3 class="incidents-title">Sync incidents <span class="count mono">{incidents.length}</span></h3>
          <ul class="rows" aria-label="sync incidents">
            {#each incidents as inc (inc.id)}
              <li class="row incident">
                <span class="when mono">{fmtTime(inc.at)}</span>
                <span class="inc-adapter mono">{inc.adapter}</span>
                <span class="inc-msg">{inc.message}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
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
  .back {
    align-self: flex-start;
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-accent);
    text-decoration: none;
  }
  .back:hover {
    text-decoration: underline;
  }
  .back:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm, 6px);
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
  .state {
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .hint {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }
  .section-title {
    font: var(--type-h2, var(--type-body));
    font-weight: 600;
    color: var(--color-text);
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .target-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }
  .target-repo {
    font-weight: 600;
    color: var(--color-text);
    font-size: 0.9rem;
  }
  .badge {
    font-size: 0.66rem;
    font-weight: 600;
    text-transform: lowercase;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .badge[data-on='true'] {
    color: var(--color-success, var(--color-running, var(--color-accent)));
    border-color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .run-form {
    display: flex;
    align-items: flex-end;
    gap: var(--space-4, 1rem);
    flex-wrap: wrap;
  }
  .dir-field {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .field-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 600;
    padding: 0;
  }
  .dir-options {
    display: flex;
    gap: var(--space-3, 0.75rem);
  }
  .radio,
  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font: var(--type-body-sm);
    color: var(--color-text);
    cursor: pointer;
  }
  .radio input,
  .check input {
    accent-color: var(--color-accent);
    min-width: 16px;
    min-height: 16px;
  }
  .radio input:focus-visible,
  .check input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .radio-label {
    text-transform: lowercase;
  }
  .check-label {
    color: var(--color-text-2);
  }
  .btn {
    appearance: none;
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.85rem;
    font: var(--type-body-sm);
    font-weight: 600;
    cursor: pointer;
    min-height: 24px;
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .btn.primary {
    color: var(--color-text-inverse, var(--color-bg, #03120e));
    background: var(--color-accent);
    border-color: var(--color-accent);
  }
  .btn:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error, var(--color-danger, crimson));
  }
  .result {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .result-head {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .counts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3, 0.75rem);
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .counts .count {
    color: var(--color-text);
    font-weight: 600;
    margin-right: 0.25rem;
  }
  .run-errors {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .run-error {
    font-size: 0.74rem;
    color: var(--color-error, var(--color-danger, crimson));
  }
  .count {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .mapping {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font: var(--type-body-sm);
    color: var(--color-text);
    flex-wrap: wrap;
  }
  .task-id {
    color: var(--color-text);
    font-size: 0.78rem;
  }
  .arrow {
    color: var(--color-text-muted);
  }
  .issue {
    color: var(--color-accent);
    text-decoration: none;
    font-size: 0.78rem;
  }
  a.issue:hover {
    text-decoration: underline;
  }
  a.issue:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm, 4px);
  }
  .dir {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .when {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }
  /* ── Board sync (TASK 11.4) ─────────────────────────────────────────────── */
  .board-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .board-num {
    max-width: 9rem;
  }
  .pm-input {
    appearance: none;
    border-radius: var(--radius-sm, 6px);
    padding: 0.35rem 0.55rem;
    font: var(--type-body-sm);
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
    min-height: 24px;
  }
  .pm-input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .map-field {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .map-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.4rem;
  }
  .map-row {
    display: grid;
    grid-template-columns: 7rem 1fr;
    align-items: center;
    gap: 0.6rem;
  }
  .map-status {
    font-size: 0.74rem;
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .board-status {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .board-status[data-status='ok'] {
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .board-status[data-status='error'] {
    color: var(--color-error, var(--color-danger, crimson));
  }
  .incidents {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-3, 0.75rem);
  }
  .incidents-title {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-text);
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .incident {
    align-items: baseline;
  }
  .inc-adapter {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .inc-msg {
    font-size: 0.78rem;
    color: var(--color-error, var(--color-danger, crimson));
    flex: 1;
  }
</style>
