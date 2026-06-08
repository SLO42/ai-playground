<script lang="ts">
  /**
   * /projects/[id]/release — the Release tab (UI-SPEC §195 v0.3).
   *
   * Renders this project's release runs LIVE from the DB (F-008 — no fabricated runs):
   * each run is a tracked `workflow_run` of a "release <version>" workflow, driven by the
   * 2.17 runner, shown as the canonical dry-run → test → changelog → version → tag →
   * publish stage chain with each stage's live status. The four honest states
   * (loading / empty / error / live, UI-SPEC §1.3/§8). Live by default (§1.2): a
   * `workflow_run` row change on the one SSE stream re-invalidates the loader so a running
   * release's step_state updates in place. Svelte 5 runes only.
   */
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let version = $state('');
  let releasing = $state(false);

  function shortId(id: string): string {
    const i = id.indexOf(':');
    return i >= 0 ? id.slice(i + 1) : id;
  }

  const runs = $derived(data.runs ?? []);
  const stages = $derived(data.stages ?? []);
  const connected = $derived(data.connected);
  const projectName = $derived(data.projectName ?? data.projectId);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // Live updates: when a `workflow_run` row changes, re-run the server loader. SSR-safe —
  // $effect runs only in the browser, and the handler is torn down on unmount.
  $effect(() => {
    const off = stream.onDbChange('workflow_run', () => {
      void invalidate('app:releases');
    });
    return off;
  });

  /** A stage's status for a run: the step_state value, defaulting to pending. */
  function stageStatus(run: { stepState: Record<string, string> }, stage: string): string {
    return run.stepState?.[stage] ?? 'pending';
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">release</span>
    <h1 class="title">Release — {projectName}</h1>
    <p class="lede">
      Every release runs the same pipeline — <span class="mono">dry-run → test → changelog
      → version → tag → publish</span> — as a tracked workflow, each stage a real Claude Code
      session. Served live from the database.
    </p>
  </header>

  {#if connected}
    <!-- Job 10: cut a release (PRODUCT §4.5/§4.10) — runs the pipeline as a tracked workflow. -->
    <div class="card cut">
      <h2 class="cut-title">Cut a release</h2>
      <form
        method="POST"
        action="?/run"
        class="cut-form"
        use:enhance={() => {
          releasing = true;
          return async ({ update }) => {
            await update({ reset: false });
            releasing = false;
          };
        }}
      >
        <label class="field">
          <span class="field-label">Target version</span>
          <input class="mono" name="version" bind:value={version} placeholder="v0.4" required />
        </label>
        <button class="btn primary" type="submit" disabled={releasing || !version.trim()}>
          {releasing ? 'Starting…' : 'Run release'}
        </button>
      </form>
      {#if form?.release && 'error' in form.release}
        <p class="form-error" role="alert">{form.release.error}</p>
      {:else if form?.release && 'ok' in form.release}
        <p class="form-ok">
          Release {form.release.version} started · run {shortId(form.release.runId)} · {form.release.status}
        </p>
      {/if}
    </div>
  {/if}

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no release runs rather than a fabricated
        list. {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else if runs.length === 0}
    <div class="card state">
      <span class="eyebrow">empty</span>
      <p class="state-body">
        No releases yet — when you cut a release it will appear here, stage by stage.
      </p>
    </div>
  {:else}
    <ul class="runs" aria-label="release runs">
      {#each runs as run (run.runId)}
        <li class="card run">
          <div class="run-head">
            <span class="version mono">{run.version}</span>
            <span class="run-status" data-status={run.status}>{run.status}</span>
          </div>
          <ol class="pipeline" aria-label="release stages">
            {#each stages as stage (stage)}
              <li class="stage" data-status={stageStatus(run, stage)}>
                <span class="dot" aria-hidden="true"></span>
                <span class="stage-name mono">{stage}</span>
                <span class="stage-status">{stageStatus(run, stage)}</span>
              </li>
            {/each}
          </ol>
        </li>
      {/each}
    </ul>
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
  .state {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .runs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .run {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .run-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }
  .version {
    font-weight: 600;
    color: var(--color-text);
  }
  .run-status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.12rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    white-space: nowrap;
  }
  .run-status[data-status='running'] {
    color: var(--color-running, var(--color-accent));
  }
  .run-status[data-status='done'] {
    color: var(--color-success, var(--color-running));
  }
  .run-status[data-status='failed'] {
    color: var(--color-error, var(--color-danger, crimson));
  }
  .pipeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
  }
  .stage {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.74rem;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    color: var(--color-text-muted);
  }
  .stage .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--color-neutral, var(--color-text-muted));
    flex: none;
  }
  .stage[data-status='running'] .dot {
    background: var(--color-running, var(--color-accent));
  }
  .stage[data-status='done'] .dot {
    background: var(--color-success, var(--color-running));
  }
  .stage[data-status='failed'] .dot {
    background: var(--color-error, var(--color-danger, crimson));
  }
  .stage-status {
    color: var(--color-text-2);
    text-transform: lowercase;
  }
  .cut {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .cut-title {
    font: var(--type-h2, var(--type-body));
    font-weight: 600;
    color: var(--color-text);
  }
  .cut-form {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    min-width: 0;
  }
  .field-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .field input {
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.6rem;
    font: var(--type-body-sm);
    min-height: 24px;
  }
  .field input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .btn {
    appearance: none;
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.85rem;
    font: var(--type-body-sm);
    font-weight: 600;
    cursor: pointer;
    min-height: 24px;
    color: var(--color-text-inverse, var(--color-bg, #03120e));
    background: var(--color-accent);
    border: var(--border-width, 1px) solid var(--color-accent);
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
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
</style>
