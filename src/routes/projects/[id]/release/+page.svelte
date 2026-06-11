<script lang="ts">
  /**
   * /projects/[id]/release — the Release tab (UI-SPEC §195 v0.3).
   *
   * Renders this project's release runs LIVE from the DB (F-008 — no fabricated runs):
   * each run is a tracked `workflow_run` of a "release <version>" workflow, driven by the
   * 2.17 runner, shown as the canonical dry-run → test → changelog → version → tag →
   * publish → verify stage chain with each stage's live status. The four honest states
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
  const targets = $derived(data.targets ?? []);
  const slug = $derived(shortId(data.projectId ?? ''));

  let targetBusy = $state(false);
  const targetResult = $derived(
    form && 'target' in form ? (form.target as Record<string, unknown>) : undefined
  );
  // The dry-run plan's confirm token is held so the operator can confirm the SAME plan (D-018).
  const targetDryOk = $derived(targetResult && 'ok' in targetResult && targetResult.dryRun === true);

  function fmtTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // Live updates: a `workflow_run` / target / run row change re-runs the server loader. SSR-safe —
  // $effect runs only in the browser, and the handler is torn down on unmount.
  $effect(() => {
    const off = stream.onDbChange('workflow_run', () => void invalidate('app:releases'));
    const offT = stream.onDbChange('project_target', () => void invalidate('app:targets'));
    const offR = stream.onDbChange('target_run', () => void invalidate('app:targets'));
    return () => {
      off();
      offT();
      offR();
    };
  });

  /** A stage's status for a run: the step_state value, defaulting to pending. */
  function stageStatus(run: { stepState: Record<string, string> }, stage: string): string {
    return run.stepState?.[stage] ?? 'pending';
  }

  /**
   * The stages THIS run actually has (honest, F-008): older runs were created before the
   * `verify` stage existed (14.7) — rendering the global stage list against them would show a
   * phantom forever-"pending" verify. step_state is fully initialized at run creation, so the
   * run's own keys are the truth; fall back to the global list only if step_state is absent.
   */
  function runStages(run: { stepState: Record<string, string> }): string[] {
    const own = stages.filter((s) => run.stepState && s in run.stepState);
    return own.length > 0 ? own : stages;
  }
</script>

<svelte:head>
  <title>Release · {projectName} — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">release</span>
    <h1 class="title">Release — {projectName}</h1>
    <p class="lede">
      Every release runs the same pipeline — <span class="mono">dry-run → test → changelog
      → version → tag → publish → verify</span> — as a tracked workflow, each stage a real
      Claude Code session. Served live from the database.
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

    <!-- Release targets (D-037) — what this project ships through + the gated dry-run → publish flow. -->
    <div class="card targets-card">
      <div class="targets-head">
        <h2 class="cut-title">Release targets</h2>
        <a class="manage-link" href={`/projects/${slug}/targets`}>manage targets →</a>
      </div>
      <p class="lede targets-lede">
        The release pipeline drives the project's <em>chosen</em> publish/deploy adapter — not a
        fixed script. Run a dry-run, review the plan, then confirm the gated publish. With the
        adapter's named credential set in <span class="mono">.env</span> (D-026) the confirm is a
        REAL external publish (Thunderstore runs its live 4-step upload); without it — or for
        adapters whose live execution isn't wired yet — it defers honestly.
      </p>
      {#if targets.length === 0}
        <p class="state-body">
          No publish or deploy target configured — <a class="inline-link" href={`/projects/${slug}/targets`}>declare one</a>
          and the pipeline will drive its adapter.
        </p>
      {:else}
        <ul class="target-list" aria-label="release targets">
          {#each targets as t (t.id)}
            <li class="target-item">
              <div class="target-head">
                <span class="target-label">{t.label}</span>
                <span class="kind-pill mono">{t.kind}</span>
                <span class="mono adapter-id">{t.adapter_id}</span>
                {#if t.is_default}<span class="badge" data-on={true}>default</span>{/if}
                {#if !t.installed}<span class="badge" data-warn={true}>adapter not installed</span>{/if}
              </div>
              {#if t.lastRun}
                <p class="target-status mono">
                  last run {fmtTime(t.lastRun.at)} ·
                  <span class="run-mode">{t.lastRun.dry_run ? 'dry-run' : 'real'}</span> ·
                  <span class="run-state" data-ok={t.lastRun.ok}>{t.lastRun.ok ? 'ok' : 'incomplete'}</span>
                </p>
              {/if}
              <div class="target-actions">
                <form
                  method="POST"
                  action="?/targetDryRun"
                  use:enhance={() => {
                    targetBusy = true;
                    return async ({ update }) => {
                      await update({ reset: false });
                      targetBusy = false;
                    };
                  }}
                >
                  <input type="hidden" name="kind" value={t.kind} />
                  <input type="hidden" name="targetId" value={t.id} />
                  <button class="btn outline" type="submit" disabled={targetBusy || !t.enabled || !t.installed}>
                    {targetBusy ? 'Running…' : `Dry-run ${t.kind}`}
                  </button>
                </form>
                {#if t.canVerify}
                  <!-- 14.7: poll the external target until the published version is visible
                       (read-only, bounded; an unconfirmed verify raises an incident). -->
                  <form
                    method="POST"
                    action="?/targetVerify"
                    use:enhance={() => {
                      targetBusy = true;
                      return async ({ update }) => {
                        await update({ reset: false });
                        targetBusy = false;
                      };
                    }}
                  >
                    <input type="hidden" name="targetId" value={t.id} />
                    <button class="btn outline" type="submit" disabled={targetBusy || !t.enabled || !t.installed}>
                      {targetBusy ? 'Running…' : 'Verify publish'}
                    </button>
                  </form>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      {#if targetResult}
        {#if 'error' in targetResult}
          <p class="form-error" role="alert">{targetResult.error}</p>
        {:else if 'ok' in targetResult}
          <div class="run-result" role="status">
            <p class="result-head" data-ok={targetResult.dryRun === true || targetResult.ok === true}>
              {targetResult.dryRun
                ? 'Dry-run plan'
                : targetResult.verify
                  ? targetResult.ok
                    ? 'Verify confirmed'
                    : 'Verify did not confirm'
                  : targetResult.ok
                    ? 'Action complete'
                    : 'Action did not complete'}
              · <span class="mono">{targetResult.adapterId}</span> → <span class="mono">{targetResult.targetRef}</span>
            </p>
            <p class="state-body">{targetResult.summary}</p>
            {#if Array.isArray(targetResult.steps) && targetResult.steps.length > 0}
              <ol class="plan">
                {#each targetResult.steps as step, i (i)}<li class="plan-step">{step}</li>{/each}
              </ol>
            {/if}
            {#if Array.isArray(targetResult.warnings) && targetResult.warnings.length > 0}
              <ul class="warnings">
                {#each targetResult.warnings as w, i (i)}<li class="warning mono">{w}</li>{/each}
              </ul>
            {/if}
            {#if targetDryOk && targetResult.confirmToken}
              <form
                method="POST"
                action="?/targetConfirm"
                class="confirm-form"
                use:enhance={() => {
                  targetBusy = true;
                  return async ({ update }) => {
                    await update({ reset: false });
                    targetBusy = false;
                  };
                }}
              >
                <input type="hidden" name="kind" value={targetResult.kind} />
                <input type="hidden" name="confirmToken" value={targetResult.confirmToken} />
                <p class="confirm-note">
                  This is a <strong>gated action</strong> (D-018). Confirm to perform the real
                  {targetResult.kind}. With the adapter's named credential set in
                  <span class="mono">.env</span> this EXECUTES the real external action
                  (Thunderstore: the live 4-step upload); without it — or for adapters whose live
                  execution isn't wired yet — it defers honestly (D-026).
                </p>
                <button class="btn primary" type="submit" disabled={targetBusy}>
                  {targetBusy ? 'Confirming…' : `Confirm ${targetResult.kind}`}
                </button>
              </form>
            {/if}
          </div>
        {/if}
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
            {#each runStages(run) as stage (stage)}
              <li class="stage" data-status={stageStatus(run, stage)}>
                <span class="dot" aria-hidden="true"></span>
                <span class="stage-name mono">{stage}</span>
                <span class="stage-status">{stageStatus(run, stage)}</span>
              </li>
            {/each}
          </ol>

          <!-- The REAL generated changelog (the changelog step's session output, rendered
               markdown → sanitized HTML at the server boundary). Honest empty when none. -->
          <div class="changelog">
            <span class="eyebrow">changelog</span>
            {#if run.changelogHtml}
              <!-- Safe: changelogHtml is escape-first server-rendered (renderMarkdown);
                   it contains only tags the renderer emits, never model-authored HTML. -->
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <div class="prose">{@html run.changelogHtml}</div>
            {:else}
              <p class="changelog-empty">
                No changelog yet — it appears here once the changelog step generates one.
              </p>
            {/if}
          </div>
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
    /* -on-overlay tint hits BODY AA on the overlay tag background (14.3) */
    color: var(--color-error-on-overlay);
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
    background: var(--color-error);
  }
  .stage-status {
    color: var(--color-text-2);
    text-transform: lowercase;
  }
  .changelog {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border-top: var(--border-width, 1px) solid var(--color-border-subtle, var(--color-border));
    padding-top: var(--space-3, 0.75rem);
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .changelog-empty {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }
  /* Prose: the rendered changelog. Tokens only; tight, readable vertical rhythm. */
  .prose {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    line-height: 1.5;
  }
  .prose :global(h1),
  .prose :global(h2),
  .prose :global(h3),
  .prose :global(h4),
  .prose :global(h5),
  .prose :global(h6) {
    color: var(--color-text);
    font-weight: 600;
    margin: var(--space-4, 0.75rem) 0 var(--space-2, 0.5rem);
    line-height: 1.3;
  }
  .prose :global(h1) { font-size: 1.05rem; }
  .prose :global(h2) { font-size: 0.98rem; }
  .prose :global(h3) { font-size: 0.9rem; }
  .prose :global(p) { margin: var(--space-2, 0.5rem) 0; }
  .prose :global(ul),
  .prose :global(ol) {
    margin: var(--space-2, 0.5rem) 0;
    padding-left: 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .prose :global(li) { color: var(--color-text-2); }
  .prose :global(strong) { color: var(--color-text); font-weight: 600; }
  .prose :global(a) {
    color: var(--color-text-link, var(--color-accent));
    text-decoration: underline;
  }
  .prose :global(a:hover) { color: var(--color-accent-hover, var(--color-accent)); }
  .prose :global(a:focus-visible) {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .prose :global(code) {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.82em;
    background: var(--color-surface-overlay);
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-sm, 6px);
  }
  .prose :global(pre) {
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3, 0.75rem);
    overflow-x: auto;
    margin: var(--space-2, 0.5rem) 0;
  }
  .prose :global(pre code) {
    background: none;
    padding: 0;
    font-size: 0.8rem;
  }
  .prose :global(blockquote) {
    border-left: 2px solid var(--color-border);
    margin: var(--space-2, 0.5rem) 0;
    padding-left: var(--space-3, 0.75rem);
    color: var(--color-text-muted);
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
    color: var(--color-error);
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  /* Release targets (D-037) */
  .targets-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .targets-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .manage-link,
  .inline-link {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-accent);
    text-decoration: none;
  }
  .manage-link:hover,
  .inline-link:hover { text-decoration: underline; }
  .manage-link:focus-visible,
  .inline-link:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm, 6px);
  }
  .targets-lede { max-width: 72ch; margin: 0; }
  .target-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .target-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.6rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .target-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .target-label {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-text);
  }
  .adapter-id { font-size: 0.74rem; color: var(--color-text-muted); }
  .kind-pill {
    font-size: 0.66rem;
    font-weight: 600;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-2);
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .badge {
    font-size: 0.66rem;
    font-weight: 600;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .badge[data-on='true'] {
    color: var(--color-success, var(--color-running, var(--color-accent)));
    border-color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .badge[data-warn='true'] {
    color: var(--color-blocked, var(--color-warn, var(--color-error, crimson)));
    border-color: var(--color-blocked, var(--color-warn, var(--color-error, crimson)));
  }
  .target-status {
    font-size: 0.72rem;
    color: var(--color-text-2);
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .run-mode { color: var(--color-text-muted); text-transform: lowercase; }
  .run-state { font-weight: 600; color: var(--color-text-muted); text-transform: lowercase; }
  .run-state[data-ok='true'] { color: var(--color-success, var(--color-running, var(--color-accent))); }
  .btn.outline {
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border-color: var(--color-border);
  }
  .run-result {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-3, 0.75rem);
  }
  .result-head {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  /* Honest tint: a failed real action / unconfirmed verify is never dressed as success. */
  .result-head[data-ok='false'] {
    color: var(--color-error);
  }
  .target-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .plan {
    margin: 0;
    padding-left: 1.25rem;
    font: var(--type-body-sm);
    color: var(--color-text-2);
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .warnings {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .warning { font-size: 0.74rem; color: var(--color-warn, var(--color-text-muted)); }
  .confirm-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3, 0.6rem);
    background: var(--color-surface-card);
  }
  .confirm-note { font: var(--type-body-sm); color: var(--color-text-2); }
</style>
