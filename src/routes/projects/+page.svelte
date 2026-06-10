<script lang="ts">
  /**
   * /projects — portfolio project list (UI-SPEC §6 v0.1).
   *
   * Renders LIVE `project` rows from the DB (F-008 — no fabricated cards) with the
   * four honest states (loading / empty / error / live, UI-SPEC §1.3/§8). Live by
   * default (§1.2): a `project` row change on the one SSE stream re-invalidates the
   * loader so the list updates in place — no manual refresh. Svelte 5 runes only.
   */
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const projects = $derived(data.projects ?? []);
  const connected = $derived(data.connected);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // Register form: live submit state + honest result (error / registered) from the action.
  let scanning = $state(false);
  let pathInput = $state('');
  const scanResult = $derived(form && 'scan' in form ? form.scan : undefined);
  const scanError = $derived(scanResult && 'error' in scanResult ? scanResult.error : undefined);
  const scanOk = $derived(scanResult && 'ok' in scanResult ? scanResult : undefined);

  // Live updates: when a `project` row changes, re-run the server loader. SSR-safe —
  // $effect runs only in the browser, and the handler is torn down on unmount.
  $effect(() => {
    const off = stream.onDbChange('project', () => {
      void invalidate('app:projects');
    });
    return off;
  });

  function statusOf(p: { status?: string }): string {
    return p.status ?? 'unknown';
  }

  // The detail route's [id] param is the bare slug (the loader re-prefixes `project:`).
  function detailHref(id: string): string {
    const i = id.indexOf(':');
    return `/projects/${i >= 0 ? id.slice(i + 1) : id}`;
  }
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">portfolio</span>
    <h1 class="title">Projects</h1>
    <p class="lede">
      Every project under management, served live from the database. Register a new
      one by scanning a path under <span class="mono">CODE_ROOT</span>.
    </p>
  </header>

  <form
    class="card register"
    method="POST"
    action="?/scan"
    use:enhance={() => {
      scanning = true;
      return async ({ update }) => {
        // Keep the typed value on validation errors; clear it on a successful register.
        await update({ reset: false });
        scanning = false;
      };
    }}
  >
    <label class="field">
      <span class="field-label">Register a project</span>
      <span class="field-help"
        >Scan a directory under <span class="mono">CODE_ROOT</span> to detect and register it.</span
      >
      <div class="field-row">
        <input
          class="input mono"
          type="text"
          name="path"
          bind:value={pathInput}
          placeholder="F:/code/my-project"
          autocomplete="off"
          spellcheck="false"
          aria-label="Project directory path under CODE_ROOT"
          aria-invalid={scanError ? 'true' : undefined}
        />
        <button class="btn" type="submit" disabled={scanning}>
          {scanning ? 'Scanning…' : 'Scan & register'}
        </button>
      </div>
    </label>

    <div class="status-line" aria-live="polite">
      {#if scanError}
        <p class="msg error" role="alert">{scanError}</p>
      {:else if scanOk}
        <p class="msg ok">
          Registered <span class="mono">{scanOk.name}</span> from
          <span class="mono">{scanOk.root_path}</span>.
        </p>
      {/if}
    </div>
  </form>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no projects rather than a fabricated
        list. {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and
        reload.{/if}
      </p>
    </div>
  {:else if projects.length === 0}
    <div class="card state">
      <span class="eyebrow">empty</span>
      <p class="state-body">No projects yet — register one by scanning a path.</p>
    </div>
  {:else}
    <ul class="grid" aria-label="projects">
      {#each projects as p (p.id)}
        <li class="project-item">
          <a class="card project" href={detailHref(p.id)} aria-label={`Open ${p.name}`}>
            <div class="project-head">
              <span class="name">{p.name}</span>
              <span class="status" data-status={statusOf(p)}>{statusOf(p)}</span>
            </div>
            <div class="path mono" title={p.root_path}>{p.root_path}</div>
            {#if p.ecosystem?.length}
              <ul class="eco">
                {#each p.ecosystem as e (e)}
                  <li class="tag mono">{e}</li>
                {/each}
              </ul>
            {/if}
            {#if p.purpose}
              <p class="purpose">{p.purpose}</p>
            {/if}
          </a>
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
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-4, 1rem);
  }
  .project-item {
    min-width: 0;
  }
  .project {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    min-width: 0;
    text-decoration: none;
    color: inherit;
    transition: border-color var(--motion-fast, 140ms) var(--ease-out, ease);
  }
  .project:hover {
    border-color: var(--color-accent);
  }
  .project:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .project-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
  }
  .name {
    font-weight: 600;
    color: var(--color-text);
  }
  .status {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.12rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
    text-transform: lowercase;
    white-space: nowrap;
  }
  .status[data-status='active'] {
    color: var(--color-running, var(--color-success));
  }
  .status[data-status='archived'] {
    color: var(--color-neutral, var(--color-text-muted));
  }
  .path {
    font-size: 0.78rem;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .eco {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .tag {
    font-size: 0.68rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, var(--color-surface-overlay));
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
  }
  .purpose {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .register {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .field-label {
    font-weight: 600;
    color: var(--color-text);
  }
  .field-help {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }
  .field-row {
    display: flex;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .input {
    flex: 1 1 18rem;
    min-width: 0;
    font-size: 0.85rem;
    color: var(--color-text);
    background: var(--color-surface-overlay, var(--color-bg));
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.5rem 0.65rem;
  }
  .input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
    border-color: var(--color-accent);
  }
  .input[aria-invalid='true'] {
    border-color: var(--color-error);
  }
  .btn {
    flex: 0 0 auto;
    min-height: 2.25rem;
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--color-text-inverse, var(--color-bg));
    background: var(--color-accent);
    border: var(--border-width, 1px) solid var(--color-accent);
    border-radius: var(--radius-sm, 6px);
    padding: 0 0.9rem;
    cursor: pointer;
    transition: opacity var(--motion-fast, 140ms) var(--ease-out, ease);
  }
  .btn:hover {
    opacity: 0.9;
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: progress;
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .status-line {
    min-height: 1.25rem;
  }
  .msg {
    font: var(--type-body-sm);
    margin: 0;
  }
  .msg.error {
    color: var(--color-error);
  }
  .msg.ok {
    color: var(--color-success, var(--color-running));
  }
</style>
