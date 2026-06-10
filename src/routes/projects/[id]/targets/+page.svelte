<script lang="ts">
  /**
   * /projects/[id]/targets — the D-037 deploy/publish targets surface (TASK 12.1).
   *
   * Renders the project's adapter targets LIVE from the DB (F-008 — no fabricated rows):
   *   • the adapter CATALOG (registered built-ins + custom) with each adapter's honest probe +
   *     its named-secret PRESENCE (D-026 — never a value);
   *   • the project's DECLARED targets ({adapterId, config}) with a default/enabled badge;
   *   • a DRY-RUN runner that drives the chosen adapter through the gate and shows the plan +
   *     the gated CONFIRM (D-018) — a real publish/deploy is deferred to operator credentials;
   *   • the run HISTORY (real target_run rows — never silent).
   * Tokens-only, a11y AA, reduced-motion safe. Svelte 5 RUNES only.
   */
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const projectName = $derived(data.projectName ?? data.projectId);
  const kinds = $derived(data.kinds ?? (['publish', 'deploy', 'sync'] as const));
  const catalog = $derived(data.catalog ?? []);
  const targets = $derived(data.targets ?? []);
  const runs = $derived(data.runs ?? []);
  const incidents = $derived(data.incidents ?? []);
  const loadError = $derived('error' in data ? (data.error as string | undefined) : undefined);
  const slug = $derived(page.params.id);

  const declareResult = $derived(form && 'declare' in form ? (form.declare as Record<string, unknown>) : undefined);
  const runResult = $derived(form && 'run' in form ? (form.run as Record<string, unknown>) : undefined);
  const pkgResult = $derived(form && 'pkg' in form ? (form.pkg as Record<string, unknown>) : undefined);

  // Declare-form local state.
  let declareKind = $state<'publish' | 'deploy' | 'sync'>('publish');
  let declareAdapterId = $state('');
  let declareCustomId = $state('');
  let declareLabel = $state('');
  let declareConfig = $state('');
  let declareSecretRef = $state('');
  let declareDefault = $state(true);
  let declaring = $state(false);
  let running = $state(false);
  // CUSTOM-id mode: declare an adapter id the core does not ship (the D-037 scale story). When on,
  // the built-in picker is bypassed and the operator types a novel adapter id.
  let useCustom = $state(false);

  // The adapters selectable for the chosen kind (the registry catalog, filtered).
  const adaptersForKind = $derived(catalog.filter((a) => a.kind === declareKind));

  // The dry-run result's confirm token (held so the operator can confirm the same plan).
  const dryRunOk = $derived(runResult && 'ok' in runResult && runResult.dryRun === true);

  function fmtTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // Live updates: a target / run / sync-incident row change re-runs the server loader.
  $effect(() => {
    const offT = stream.onDbChange('project_target', () => void invalidate('app:targets'));
    const offR = stream.onDbChange('target_run', () => void invalidate('app:targets'));
    const offI = stream.onDbChange('sync_incident', () => void invalidate('app:targets'));
    return () => {
      offT();
      offR();
      offI();
    };
  });
</script>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">targets</span>
    <h1 class="title">Deploy &amp; publish targets — {projectName}</h1>
    <p class="lede">
      Declare how this project ships: choose an <em>adapter</em> per target ({'{'}adapterId,
      config{'}'}) and the release pipeline drives <em>that</em> adapter — not a fixed script.
      A novel per-project process plugs in without a core change. Credentials are referenced by
      name from <span class="mono">.env</span> (never stored). The D-037 adapter framework.
    </p>
    <a class="back" href={`/projects/${slug}`}>← back to project</a>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no target state rather than a fabricated one.
        {#if loadError}<span class="mono">{loadError}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else}
    <!-- The adapter catalog: registered adapters + honest probe + secret presence. -->
    <div class="card">
      <h2 class="section-title">Available adapters <span class="count mono">{catalog.length}</span></h2>
      {#if catalog.length === 0}
        <p class="state-body">No adapters registered.</p>
      {:else}
        <ul class="rows" aria-label="registered adapters">
          {#each catalog as a (a.kind + a.id)}
            <li class="adapter-row">
              <div class="adapter-head">
                <span class="adapter-label">{a.label}</span>
                <span class="kind-pill mono">{a.kind}</span>
                <span class="mono adapter-id">{a.id}</span>
                <span class="badge" data-on={a.probe.available}>{a.probe.available ? 'ready' : 'unavailable'}</span>
              </div>
              {#if a.probe.reason}
                <p class="hint" role="status">{a.probe.reason}</p>
              {/if}
              {#if a.secrets.length > 0}
                <ul class="secrets" aria-label="required credentials">
                  {#each a.secrets as s (s.envVar)}
                    <li class="secret">
                      <span class="secret-state" data-present={s.present} aria-hidden="true"></span>
                      <span class="mono secret-name">{s.envVar}</span>
                      <span class="secret-label">{s.label}{s.required ? ' (required)' : ''}</span>
                      <span class="secret-present">{s.present ? 'set' : 'unset'}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- Declare a target. -->
    <div class="card">
      <h2 class="section-title">Declare a target</h2>
      <form
        method="POST"
        action="?/declare"
        class="declare-form"
        use:enhance={() => {
          declaring = true;
          return async ({ update }) => {
            await update({ reset: false });
            declaring = false;
          };
        }}
      >
        <div class="field-row">
          <label class="field">
            <span class="field-label">Kind</span>
            <select class="pm-input" name="kind" bind:value={declareKind} disabled={declaring}>
              {#each kinds as k (k)}<option value={k}>{k}</option>{/each}
            </select>
          </label>
          {#if !useCustom}
            <label class="field grow">
              <span class="field-label">Adapter</span>
              <select class="pm-input mono" name="adapterId" bind:value={declareAdapterId} disabled={declaring}>
                <option value="" disabled selected>Choose an adapter…</option>
                {#each adaptersForKind as a (a.id)}<option value={a.id}>{a.label} ({a.id})</option>{/each}
              </select>
            </label>
          {:else}
            <label class="field grow">
              <span class="field-label">Custom adapter id</span>
              <input
                class="pm-input mono"
                type="text"
                name="customAdapterId"
                bind:value={declareCustomId}
                placeholder="my-cdn"
                pattern="[a-z0-9][a-z0-9_\-]*"
                disabled={declaring}
              />
            </label>
          {/if}
        </div>
        <label class="check custom-toggle">
          <input type="checkbox" bind:checked={useCustom} disabled={declaring} />
          <span class="check-label">
            Declare a <strong>custom</strong> adapter id (a novel process the core does not ship —
            the D-037 scale story). It will show <em>adapter not installed</em> until its adapter is
            registered.
          </span>
        </label>
        <label class="field">
          <span class="field-label">Label (optional)</span>
          <input class="pm-input" type="text" name="label" bind:value={declareLabel} placeholder="defaults to the adapter id" disabled={declaring} />
        </label>
        <label class="field">
          <span class="field-label">Config (JSON object — may reference secrets by NAME only)</span>
          <textarea class="pm-input mono config" name="config" rows="3" bind:value={declareConfig} placeholder={'{ "host": "static.example.com", "publishDir": "build" }'} disabled={declaring}></textarea>
        </label>
        <label class="field">
          <span class="field-label">Named-secret reference (env-var NAME only — never a value, D-026)</span>
          <input
            class="pm-input mono"
            type="text"
            name="secretRef"
            bind:value={declareSecretRef}
            placeholder="THUNDERSTORE_TOKEN"
            pattern="[A-Z][A-Z0-9_]*"
            disabled={declaring}
          />
        </label>
        <div class="field-row checks">
          <label class="check">
            <input type="checkbox" name="isDefault" bind:checked={declareDefault} disabled={declaring} />
            <span class="check-label">Default target for this kind</span>
          </label>
          <label class="check">
            <input type="checkbox" name="enabled" checked disabled={declaring} />
            <span class="check-label">Enabled</span>
          </label>
        </div>
        <button
          class="btn primary"
          type="submit"
          disabled={declaring || (useCustom ? !declareCustomId.trim() : !declareAdapterId)}
        >
          {declaring ? 'Declaring…' : 'Declare target'}
        </button>
      </form>
      {#if declareResult}
        {#if 'error' in declareResult}
          <p class="form-error" role="alert">{declareResult.error}</p>
        {:else if 'ok' in declareResult}
          <p class="result-head" role="status">
            Declared <span class="mono">{declareResult.adapterId}</span> ({declareResult.kind}).
            {#if declareResult.installed === false}
              <span class="not-installed-note">Adapter not installed — runs fail closed honestly until it is registered.</span>
            {/if}
          </p>
        {/if}
      {/if}
    </div>

    <!-- Declared targets + per-target dry-run / gated confirm. -->
    <div class="card">
      <h2 class="section-title">Configured targets <span class="count mono">{targets.length}</span></h2>
      {#if targets.length === 0}
        <p class="state-body">
          No targets configured yet — declare one above and the pipeline will drive its adapter.
        </p>
      {:else}
        <ul class="rows" aria-label="configured targets">
          {#each targets as t (t.id)}
            <li class="target-row">
              <div class="target-head">
                <span class="target-label">{t.label}</span>
                <span class="kind-pill mono">{t.kind}</span>
                <span class="mono adapter-id">{t.adapter_id}</span>
                {#if t.is_default}<span class="badge" data-on={true}>default</span>{/if}
                {#if !t.enabled}<span class="badge">disabled</span>{/if}
                {#if t.installed}
                  <span class="badge" data-on={true}>installed</span>
                {:else}
                  <span class="badge" data-warn={true} title="No adapter registered for this id — the D-037 scale story.">adapter not installed</span>
                {/if}
              </div>
              {#if Object.keys(t.config).length > 0}
                <pre class="config-view mono">{JSON.stringify(t.config, null, 2)}</pre>
              {/if}
              <!-- Per-target status: the most recent run + its honest result (F-008). -->
              {#if t.lastRun}
                <p class="target-status mono">
                  last run {fmtTime(t.lastRun.at)} ·
                  <span class="run-mode">{t.lastRun.dry_run ? 'dry-run' : 'real'}</span> ·
                  <span class="run-state" data-ok={t.lastRun.ok}>{t.lastRun.ok ? 'ok' : 'incomplete'}</span>
                </p>
              {:else}
                <p class="target-status mono muted">no runs yet</p>
              {/if}
              <div class="target-actions">
                {#if t.kind === 'sync'}
                  <!-- Sync dry-run / real run through the registry + the unified ledger (12.4a). -->
                  <form
                    method="POST"
                    action="?/syncRun"
                    use:enhance={() => {
                      running = true;
                      return async ({ update }) => {
                        await update({ reset: false });
                        running = false;
                      };
                    }}
                  >
                    <input type="hidden" name="targetId" value={t.id} />
                    <input type="hidden" name="dryRun" value="on" />
                    <button class="btn" type="submit" disabled={running || !t.enabled || !t.installed}>
                      {running ? 'Running…' : 'Dry-run sync'}
                    </button>
                  </form>
                  <form
                    method="POST"
                    action="?/syncRun"
                    use:enhance={() => {
                      running = true;
                      return async ({ update }) => {
                        await update({ reset: false });
                        running = false;
                      };
                    }}
                  >
                    <input type="hidden" name="targetId" value={t.id} />
                    <input type="hidden" name="dryRun" value="off" />
                    <button class="btn" type="submit" disabled={running || !t.enabled || !t.installed}>
                      {running ? 'Running…' : 'Run sync'}
                    </button>
                  </form>
                {/if}
                {#if t.kind === 'publish'}
                  <!-- Package & validate: preflight + assemble the zip; show its contents (no upload). -->
                  <form
                    method="POST"
                    action="?/packagePreview"
                    use:enhance={() => {
                      running = true;
                      return async ({ update }) => {
                        await update({ reset: false });
                        running = false;
                      };
                    }}
                  >
                    <input type="hidden" name="targetId" value={t.id} />
                    <button class="btn" type="submit" disabled={running || !t.enabled}>
                      {running ? 'Working…' : 'Package & validate'}
                    </button>
                  </form>
                {/if}
                {#if t.kind === 'publish' || t.kind === 'deploy'}
                  <!-- Dry-run: drive the gated driver in plan-only mode. -->
                  <form
                    method="POST"
                    action="?/dryRun"
                    use:enhance={() => {
                      running = true;
                      return async ({ update }) => {
                        await update({ reset: false });
                        running = false;
                      };
                    }}
                  >
                    <input type="hidden" name="kind" value={t.kind} />
                    <input type="hidden" name="targetId" value={t.id} />
                    <button class="btn" type="submit" disabled={running || !t.enabled}>
                      {running ? 'Running…' : `Dry-run ${t.kind}`}
                    </button>
                  </form>
                {/if}
                <form
                  method="POST"
                  action="?/remove"
                  use:enhance={() => {
                    return async ({ update }) => { await update({ reset: false }); };
                  }}
                >
                  <input type="hidden" name="targetId" value={t.id} />
                  <button class="btn danger" type="submit">Remove</button>
                </form>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      <!-- Package & validate result: the preflight verdict + the produced zip CONTENTS listing. -->
      {#if pkgResult}
        {#if 'error' in pkgResult}
          <p class="form-error" role="alert">{pkgResult.error}</p>
        {:else if 'ok' in pkgResult}
          <div class="run-result" role="status">
            <p class="result-head" data-bad={pkgResult.valid === false}>
              {pkgResult.valid ? 'Package valid' : 'Package has blockers'}
              · <span class="mono">{pkgResult.adapterId}</span> → <span class="mono">{pkgResult.target}</span>
            </p>
            <p class="state-body">{pkgResult.summary}</p>
            {#if Array.isArray(pkgResult.blockers) && pkgResult.blockers.length > 0}
              <ul class="blockers" aria-label="validation blockers">
                {#each pkgResult.blockers as b, i (i)}<li class="blocker">✗ {b}</li>{/each}
              </ul>
            {/if}
            {#if Array.isArray(pkgResult.steps) && pkgResult.steps.length > 0}
              <p class="contents-title">Package contents</p>
              <ol class="plan">
                {#each pkgResult.steps as step, i (i)}<li class="plan-step mono">{step}</li>{/each}
              </ol>
            {/if}
            {#if Array.isArray(pkgResult.warnings) && pkgResult.warnings.length > 0}
              <ul class="warnings">
                {#each pkgResult.warnings as w, i (i)}<li class="warning mono">{w}</li>{/each}
              </ul>
            {/if}
          </div>
        {/if}
      {/if}

      <!-- The dry-run plan + the gated confirm (D-018). -->
      {#if runResult}
        {#if 'error' in runResult}
          <p class="form-error" role="alert">{runResult.error}</p>
        {:else if 'ok' in runResult}
          <div class="run-result" role="status">
            <p class="result-head">
              {runResult.dryRun ? 'Dry-run plan' : runResult.ok ? 'Action complete' : 'Action did not complete'}
              · <span class="mono">{runResult.adapterId}</span> → <span class="mono">{runResult.target}</span>
            </p>
            <p class="state-body">{runResult.summary}</p>
            {#if Array.isArray(runResult.steps) && runResult.steps.length > 0}
              <ol class="plan">
                {#each runResult.steps as step, i (i)}<li class="plan-step">{step}</li>{/each}
              </ol>
            {/if}
            {#if Array.isArray(runResult.warnings) && runResult.warnings.length > 0}
              <ul class="warnings">
                {#each runResult.warnings as w, i (i)}<li class="warning mono">{w}</li>{/each}
              </ul>
            {/if}
            {#if dryRunOk && runResult.confirmToken}
              <form
                method="POST"
                action="?/confirm"
                class="confirm-form"
                use:enhance={() => {
                  running = true;
                  return async ({ update }) => {
                    await update({ reset: false });
                    running = false;
                  };
                }}
              >
                <input type="hidden" name="kind" value={runResult.kind} />
                <input type="hidden" name="confirmToken" value={runResult.confirmToken} />
                <p class="confirm-note">
                  This is a <strong>gated action</strong> (D-018). Confirm to perform the real
                  {runResult.kind}. Real external publish/deploy is deferred until you supply the
                  named credential in <span class="mono">.env</span> (D-026).
                </p>
                <button class="btn primary" type="submit" disabled={running}>
                  {running ? 'Confirming…' : `Confirm ${runResult.kind}`}
                </button>
              </form>
            {/if}
          </div>
        {/if}
      {/if}
    </div>

    <!-- Run history (real target_run rows — never silent). -->
    <div class="card">
      <h2 class="section-title">Run history <span class="count mono">{runs.length}</span></h2>
      {#if runs.length === 0}
        <p class="state-body">No runs yet — a dry-run or confirmed action will be recorded here.</p>
      {:else}
        <ul class="rows" aria-label="target run history">
          {#each runs as r (r.id)}
            <li class="run-row">
              <span class="when mono">{fmtTime(r.at)}</span>
              <span class="kind-pill mono">{r.kind}</span>
              <span class="mono adapter-id">{r.adapter_id}</span>
              <span class="run-mode mono">{r.dry_run ? 'dry-run' : 'real'}</span>
              <span class="run-state" data-ok={r.ok}>{r.ok ? 'ok' : 'incomplete'}</span>
              <span class="run-summary">{r.summary}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- Sync incidents (real sync_incident rows — failures, never silent, F-008). -->
    <div class="card">
      <h2 class="section-title">Incidents <span class="count mono">{incidents.length}</span></h2>
      {#if incidents.length === 0}
        <p class="state-body">No incidents — every sync run has completed cleanly, or none has run.</p>
      {:else}
        <ul class="rows" aria-label="sync incidents">
          {#each incidents as inc (inc.id)}
            <li class="run-row">
              <span class="when mono">{fmtTime(inc.at)}</span>
              <span class="mono adapter-id">{inc.adapter}</span>
              <span class="run-state" data-ok={false}>incident</span>
              <span class="run-summary">{inc.message}</span>
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
    max-width: 72ch;
  }
  .back {
    align-self: flex-start;
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-accent);
    text-decoration: none;
  }
  .back:hover { text-decoration: underline; }
  .back:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm, 6px);
  }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
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
  .state { gap: var(--space-2); }
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
    gap: var(--space-2, 0.5rem);
  }
  /* Adapter + target rows */
  .adapter-row,
  .target-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: var(--space-3, 0.6rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .adapter-head,
  .target-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .adapter-label,
  .target-label {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-text);
  }
  .adapter-id {
    font-size: 0.74rem;
    color: var(--color-text-muted);
  }
  .kind-pill {
    font-size: 0.66rem;
    font-weight: 600;
    text-transform: lowercase;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-2);
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .badge {
    font-size: 0.66rem;
    font-weight: 600;
    text-transform: lowercase;
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
  .not-installed-note {
    color: var(--color-blocked, var(--color-warn, var(--color-text-muted)));
    font-weight: 500;
  }
  .custom-toggle { align-items: flex-start; }
  .custom-toggle .check-label { color: var(--color-text-muted); }
  .target-status {
    font-size: 0.72rem;
    color: var(--color-text-2);
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .target-status.muted { color: var(--color-text-muted); }
  /* Secret presence (D-026 — presence only) */
  .secrets {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .secret {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font: var(--type-body-sm);
    color: var(--color-text-2);
    flex-wrap: wrap;
  }
  .secret-state {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--color-text-muted);
    border: var(--border-width, 1px) solid var(--color-border);
    flex: none;
  }
  .secret-state[data-present='true'] {
    background: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .secret-name { font-size: 0.74rem; color: var(--color-text); }
  .secret-label { font-size: 0.74rem; color: var(--color-text-muted); }
  .secret-present {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    margin-left: auto;
    text-transform: lowercase;
  }
  /* Forms */
  .declare-form,
  .config {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .field-row {
    display: flex;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .field.grow { flex: 1; min-width: 12rem; }
  .field-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 600;
  }
  .pm-input {
    appearance: none;
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.55rem;
    font: var(--type-body-sm);
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border: var(--border-width, 1px) solid var(--color-border);
    min-height: 24px;
  }
  textarea.config { resize: vertical; min-height: 3.5rem; }
  .pm-input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .checks { align-items: center; }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font: var(--type-body-sm);
    color: var(--color-text-2);
    cursor: pointer;
  }
  .check input {
    accent-color: var(--color-accent);
    min-width: 16px;
    min-height: 16px;
  }
  .check input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
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
  .btn.danger { color: var(--color-error, var(--color-danger, crimson)); }
  .btn:hover:not(:disabled) { filter: brightness(1.08); }
  .btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .target-actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .config-view {
    font-size: 0.72rem;
    color: var(--color-text-2);
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.5rem;
    margin: 0;
    overflow-x: auto;
  }
  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error, var(--color-danger, crimson));
  }
  .result-head {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .result-head[data-bad='true'] {
    color: var(--color-error, var(--color-danger, crimson));
  }
  .contents-title {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    color: var(--color-text-muted);
    margin: 0;
  }
  .blockers {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .blocker {
    font: var(--type-body-sm);
    color: var(--color-error, var(--color-danger, crimson));
  }
  .run-result {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-3, 0.75rem);
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
  .warning {
    font-size: 0.74rem;
    color: var(--color-warn, var(--color-text-muted));
  }
  .confirm-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3, 0.6rem);
    background: var(--color-surface-card);
  }
  .confirm-note {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  /* Run history */
  .run-row {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    font: var(--type-body-sm);
    color: var(--color-text-2);
    flex-wrap: wrap;
    padding-bottom: 0.35rem;
    border-bottom: var(--border-width, 1px) solid var(--color-border);
  }
  .when {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .run-mode {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .run-state {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .run-state[data-ok='true'] {
    color: var(--color-success, var(--color-running, var(--color-accent)));
  }
  .run-summary {
    font-size: 0.78rem;
    color: var(--color-text);
    flex: 1;
    min-width: 12rem;
  }
</style>
