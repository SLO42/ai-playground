<script lang="ts">
  /**
   * /settings — the operator control surface (UI-SPEC §220). Three panels:
   *   1. Orchestration mode (D-004) — switch manual | event | periodic, diff + confirm (D-010),
   *      with an HONEST "restart needed" note when the configured mode ≠ the running mode.
   *   2. Routing config (D-020) — VIEW the tier ladder + intent→config bundles (read-only).
   *   3. API keys (D-026) — credential PRESENCE (set | unset) + a set form. The value is NEVER
   *      shown; the input clears on submit. Tokens-only, a11y, reduced-motion. Svelte 5 runes.
   */
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const configuredMode = $derived(data.configuredMode);
  const runningMode = $derived(data.runningMode);
  const orchestratorRunning = $derived(data.orchestratorRunning);
  const tiers = $derived(data.tiers ?? []);
  const escalationOrder = $derived(data.escalationOrder ?? []);
  const bundles = $derived(data.bundles ?? []);
  const configuredProvider = $derived(data.defaultProvider ?? 'auto');
  const defaultProviders = $derived(data.defaultProviders ?? ['auto', 'local', 'cloud']);
  const keys = $derived(data.keys ?? []);
  const configError = $derived(data.configError);

  // The mode the operator is choosing in the form (defaults to the configured mode).
  let pickedMode = $state<string>('');
  $effect(() => {
    // Seed the picker from the configured mode once it's known (no overwrite while editing).
    if (pickedMode === '' && configuredMode) pickedMode = configuredMode;
  });

  // The orchestration action result (planMode → confirming; applyMode → saved; or an error).
  interface OrchView {
    phase?: 'confirming' | 'saved';
    error?: string;
    mode?: string;
    proposed?: string;
    confirmToken?: string;
    unchanged?: boolean;
    hunks?: Array<{ op: string; line: string }>;
    bytesWritten?: number;
    restartNeeded?: boolean;
    runningMode?: string | null;
    orchestratorRunning?: boolean;
  }
  const orch = $derived((form?.orch ?? null) as OrchView | null);

  // The global default-provider toggle action result (planProvider → confirming; applyProvider → saved).
  interface ProvView {
    phase?: 'confirming' | 'saved';
    error?: string;
    defaultProvider?: string | null;
    proposed?: string;
    confirmToken?: string;
    unchanged?: boolean;
    hunks?: Array<{ op: string; line: string }>;
    bytesWritten?: number;
    restartNeeded?: boolean;
    orchestratorRunning?: boolean;
  }
  const prov = $derived((form?.prov ?? null) as ProvView | null);

  // The provider the operator is choosing in the form (seeded from the configured value).
  let pickedProvider = $state<string>('');
  $effect(() => {
    if (pickedProvider === '' && configuredProvider) pickedProvider = configuredProvider;
  });

  function describeProvider(p: string): string {
    if (p === 'auto') return 'route normally — local floor, escalate on complexity (default)';
    if (p === 'local') return 'force the local tier (Ollama, free) for every routed spawn';
    if (p === 'cloud') return 'force a cloud tier (Claude) for every routed spawn';
    return p;
  }
  const keyset = $derived(
    (form?.keyset ?? null) as { key?: string; present?: boolean; restartNeeded?: boolean; error?: string } | null
  );

  // Honest live-reflect: when an orchestrator is running and its booted mode differs from the
  // configured mode, the running engine has NOT yet picked up the file change (it reads mode
  // per-boot). Say so plainly (D-004 / boot.ts contract).
  const modeDrift = $derived(
    orchestratorRunning && runningMode !== null && configuredMode !== null && runningMode !== configuredMode
  );

  // Per-key "set" panel open state (so the value input is only mounted when actively setting).
  let openKey = $state<string | null>(null);
  let keyValue = $state('');

  function describeMode(m: string): string {
    if (m === 'event') return 'react to task lifecycle triggers — no idle loop (default)';
    if (m === 'periodic') return 'also sweep on a fixed interval (safety net)';
    if (m === 'manual') return 'drain only on an explicit run';
    return m;
  }
</script>

<svelte:head>
  <title>Settings — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">system</span>
    <h1 class="title">Settings</h1>
    <p class="lede">
      Control the running engine: switch orchestration mode, inspect routing, and manage
      provider credentials. Sensitive writes diff-and-confirm; secret values are never shown.
    </p>
  </header>

  {#if configError}
    <div class="card warn-card" role="alert">
      <span class="eyebrow">config error</span>
      <p class="card-body">
        A config file is unreadable — <span class="mono">{configError}</span>. Fix the file on
        disk; settings below fall back to honest empty states.
      </p>
    </div>
  {/if}

  <!-- ── 1. ORCHESTRATION MODE (D-004 / D-010 diff+confirm) ─────────────────────────── -->
  <article class="card" aria-labelledby="orch-h">
    <div class="card-head">
      <span class="eyebrow">orchestration</span>
      <h2 id="orch-h" class="card-title">Mode</h2>
    </div>
    <p class="card-body">
      How the orchestrator drains the task queue (D-004). The running engine reads this once at
      boot, so a change takes effect on the next restart.
    </p>

    <!-- Live state row: configured vs running (honest — F-008). -->
    <dl class="state-grid">
      <div class="state-cell">
        <dt class="state-label">Configured</dt>
        <dd class="state-val mono">{configuredMode ?? '—'}</dd>
      </div>
      <div class="state-cell">
        <dt class="state-label">Running orchestrator</dt>
        <dd class="state-val mono">
          {#if orchestratorRunning}{runningMode}{:else}<span class="muted">not running</span>{/if}
        </dd>
      </div>
    </dl>

    {#if modeDrift}
      <p class="note" role="status">
        The running orchestrator booted in <b class="mono">{runningMode}</b> mode but the config now
        says <b class="mono">{configuredMode}</b>. Restart the server for the change to take effect.
      </p>
    {/if}

    {#if orch?.error}
      <p class="form-error" role="alert">{orch.error}</p>
    {/if}

    {#if orch?.phase === 'saved'}
      <p class="form-ok" role="status">
        Saved — {orch.bytesWritten} bytes written to orchestration.yaml.
        {#if orch.restartNeeded}
          The running orchestrator is still in <b class="mono">{orch.runningMode}</b> mode; restart
          to apply <b class="mono">{orch.mode}</b>.
        {:else if orch.orchestratorRunning}
          The running orchestrator is already in <b class="mono">{orch.mode}</b> mode.
        {:else}
          It will take effect when the orchestrator next starts.
        {/if}
      </p>
    {/if}

    <!-- Step 1: choose mode + knobs → plan (diff). -->
    {#if orch?.phase !== 'confirming'}
      <form method="POST" action="?/planMode" use:enhance class="orch-form">
        <fieldset class="mode-set">
          <legend class="sr-only">Orchestration mode</legend>
          {#each data.modes as m (m)}
            <label class="mode-opt" class:picked={pickedMode === m}>
              <input
                type="radio"
                name="mode"
                value={m}
                checked={pickedMode === m}
                onchange={() => (pickedMode = m)}
              />
              <span class="mode-name mono">{m}</span>
              <span class="mode-desc">{describeMode(m)}</span>
            </label>
          {/each}
        </fieldset>

        <div class="knobs">
          <label class="knob">
            <span class="knob-label">Triggers</span>
            <input
              class="knob-input mono"
              type="text"
              name="triggers"
              value={data.triggers.join(', ')}
              placeholder="task_created, task_unblocked"
            />
          </label>
          <label class="knob">
            <span class="knob-label">Interval (ms) — periodic only</span>
            <input
              class="knob-input mono"
              type="number"
              name="intervalMs"
              min="1"
              value={data.intervalMs ?? ''}
              placeholder="60000"
            />
          </label>
        </div>

        <div class="actions">
          <button class="btn primary" type="submit">Review change</button>
        </div>
      </form>
    {/if}

    <!-- Step 2: review diff + confirm (D-010). -->
    {#if orch?.phase === 'confirming'}
      <div class="confirm" aria-label="orchestration change diff">
        {#if orch.unchanged}
          <p class="state-body">No changes — the proposed config matches disk.</p>
        {:else}
          <pre class="diff-pre mono">{#each orch.hunks ?? [] as h, i (i)}<span class="hunk" data-op={h.op}>{h.op} {h.line}
</span>{/each}</pre>
        {/if}
      </div>
      <form method="POST" action="?/applyMode" use:enhance class="actions">
        <input type="hidden" name="proposed" value={orch.proposed ?? ''} />
        <input type="hidden" name="confirmToken" value={orch.confirmToken ?? ''} />
        <button class="btn primary" type="submit" disabled={orch.unchanged}>Confirm &amp; save</button>
        <a class="btn" href="/settings" data-sveltekit-reload>Cancel</a>
      </form>
    {/if}
  </article>

  <!-- ── 2. ROUTING CONFIG (D-020) — read-only view ─────────────────────────────────── -->
  <article class="card" aria-labelledby="route-h">
    <div class="card-head">
      <span class="eyebrow">routing</span>
      <h2 id="route-h" class="card-title">Tiers &amp; intent bundles</h2>
    </div>
    <p class="card-body">
      The model ladder routing selects from (cheapest capable tier, escalating on a sick
      provider) and the per-intent config bundles (D-020). Edit the YAML in
      <span class="mono">config/</span> to retune; this is the live window onto how routing is shaped.
    </p>

    <!-- Global default-provider toggle (MODEL-BENCHMARK-SPEC step 1 — local ↔ cloud A/B). -->
    <div class="provider-toggle" aria-labelledby="prov-h">
      <h3 id="prov-h" class="sub">Default model provider</h3>
      <p class="card-body">
        Force every orchestrator-routed spawn onto one provider so the local-vs-cloud benchmark can
        A/B a pure sample. <b class="mono">auto</b> is normal routing (no change to existing builds).
        The running engine reads this once at boot — a change takes effect on the next restart.
      </p>

      <dl class="state-grid">
        <div class="state-cell">
          <dt class="state-label">Configured</dt>
          <dd class="state-val mono">{configuredProvider}</dd>
        </div>
      </dl>

      {#if prov?.error}
        <p class="form-error" role="alert">{prov.error}</p>
      {/if}

      {#if prov?.phase === 'saved'}
        <p class="form-ok" role="status">
          Saved — {prov.bytesWritten} bytes written to orchestration.yaml.
          {#if prov.restartNeeded}
            The running orchestrator is still using its boot-time provider; restart to apply
            <b class="mono">{prov.defaultProvider}</b>.
          {:else}
            It will take effect when the orchestrator next starts.
          {/if}
        </p>
      {/if}

      <!-- Step 1: choose provider → plan (diff). -->
      {#if prov?.phase !== 'confirming'}
        <form method="POST" action="?/planProvider" use:enhance class="orch-form">
          <fieldset class="mode-set">
            <legend class="sr-only">Default model provider</legend>
            {#each defaultProviders as p (p)}
              <label class="mode-opt" class:picked={pickedProvider === p}>
                <input
                  type="radio"
                  name="defaultProvider"
                  value={p}
                  checked={pickedProvider === p}
                  onchange={() => (pickedProvider = p)}
                />
                <span class="mode-name mono">{p}</span>
                <span class="mode-desc">{describeProvider(p)}</span>
              </label>
            {/each}
          </fieldset>
          <div class="actions">
            <button class="btn primary" type="submit">Review change</button>
          </div>
        </form>
      {/if}

      <!-- Step 2: review diff + confirm (D-010). -->
      {#if prov?.phase === 'confirming'}
        <div class="confirm" aria-label="provider change diff">
          {#if prov.unchanged}
            <p class="state-body">No changes — the proposed provider matches disk.</p>
          {:else}
            <pre class="diff-pre mono">{#each prov.hunks ?? [] as h, i (i)}<span class="hunk" data-op={h.op}>{h.op} {h.line}
</span>{/each}</pre>
          {/if}
        </div>
        <form method="POST" action="?/applyProvider" use:enhance class="actions">
          <input type="hidden" name="proposed" value={prov.proposed ?? ''} />
          <input type="hidden" name="confirmToken" value={prov.confirmToken ?? ''} />
          <input type="hidden" name="defaultProvider" value={prov.defaultProvider ?? ''} />
          <button class="btn primary" type="submit" disabled={prov.unchanged}>Confirm &amp; save</button>
          <a class="btn" href="/settings" data-sveltekit-reload>Cancel</a>
        </form>
      {/if}
    </div>

    <div class="route-cols">
      <div class="route-col">
        <h3 class="sub">Tier ladder</h3>
        {#if tiers.length}
          <ul class="rows" aria-label="routing tiers">
            {#each tiers as t (t.name)}
              <li class="row">
                <span class="tag mono" data-tier={t.name}>{t.name}</span>
                <span class="provider mono">{t.provider}</span>
                <span class="model mono">{t.model}</span>
              </li>
            {/each}
          </ul>
          {#if escalationOrder.length}
            <p class="route-note">
              Escalation: <span class="mono">local → {escalationOrder.join(' → ')}</span>
            </p>
          {/if}
        {:else}
          <p class="none">No tiers configured — check <span class="mono">agent-pool.yaml</span>.</p>
        {/if}
      </div>

      <div class="route-col">
        <h3 class="sub">Intent → config bundles</h3>
        <ul class="rows" aria-label="intent config bundles">
          {#each bundles as b (b.intent)}
            <li class="row bundle" class:unconfigured={!b.configured}>
              <span class="tag mono">{b.intent}</span>
              {#if b.configured}
                <span class="knobs-inline mono">
                  {#if b.thinking}think:{b.thinking} {/if}{#if b.retrievalDepth !== undefined}recall:{b.retrievalDepth} {/if}{#if b.toolCalls !== undefined}tools:{b.toolCalls} {/if}{#if b.tokenBudget !== undefined}tok:{b.tokenBudget}{/if}
                </span>
                {#if b.capabilities}
                  {@const caps = [
                    ...(b.capabilities.skills ?? []),
                    ...(b.capabilities.agents ?? []),
                    ...(b.capabilities.mcp ?? [])
                  ]}
                  {#if caps.length}
                    <span class="caps mono" title="capabilities (D-036)">caps: {caps.join(', ')}</span>
                  {/if}
                {/if}
              {:else}
                <span class="muted">defaults (no bundle)</span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    </div>
  </article>

  <!-- ── 3. API KEYS (D-026) — presence only, never a value ─────────────────────────── -->
  <article class="card" aria-labelledby="keys-h">
    <div class="card-head">
      <span class="eyebrow">credentials</span>
      <h2 id="keys-h" class="card-title">API keys</h2>
    </div>
    <p class="card-body">
      Provider credentials, stored in <span class="mono">.env</span> (gitignored — never committed).
      Only presence is shown; the value is never displayed, returned, or logged (D-026). A new
      value takes effect on the next server restart.
    </p>

    {#if keyset?.error}
      <p class="form-error" role="alert">{keyset.error}</p>
    {/if}
    {#if keyset && !keyset.error}
      <p class="form-ok" role="status">
        <span class="mono">{keyset.key}</span> is now {keyset.present ? 'set' : 'unset'}.
        {#if keyset.restartNeeded}Restart the server to use the new value.{/if}
      </p>
    {/if}

    <ul class="key-rows" aria-label="provider credentials">
      {#each keys as k (k.key)}
        <li class="key-row">
          <div class="key-main">
            <span class="key-name mono">{k.key}</span>
            <span class="key-state" data-present={k.present}>{k.present ? 'set' : 'unset'}</span>
            <span class="key-label">{k.label}</span>
          </div>
          <p class="key-purpose">{k.purpose}</p>

          <div class="key-actions">
            <button
              class="btn"
              type="button"
              aria-expanded={openKey === k.key}
              onclick={() => {
                openKey = openKey === k.key ? null : k.key;
                keyValue = '';
              }}>{openKey === k.key ? 'Cancel' : k.present ? 'Replace' : 'Set'}</button
            >
          </div>

          {#if openKey === k.key}
            <form
              method="POST"
              action="?/setKey"
              use:enhance={() =>
                async ({ update }) => {
                  // Clear the secret from the DOM as soon as the request is in flight.
                  keyValue = '';
                  openKey = null;
                  await update({ reset: true });
                }}
              class="key-set"
            >
              <input type="hidden" name="key" value={k.key} />
              <label class="sr-only" for={`val-${k.key}`}>{k.label} value</label>
              <input
                id={`val-${k.key}`}
                class="knob-input mono"
                type="password"
                name="value"
                bind:value={keyValue}
                autocomplete="off"
                placeholder="Paste the secret (never displayed back)"
              />
              <button class="btn primary" type="submit">Save</button>
            </form>
            <p class="key-hint">Leave blank and save to clear (unset) this credential.</p>
          {/if}
        </li>
      {/each}
    </ul>
  </article>
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
  .muted {
    color: var(--color-text-muted);
    font-style: italic;
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
  .warn-card {
    border-color: var(--color-warn, orange);
  }
  .card-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .card-title {
    font: var(--type-h2, var(--type-h1));
    color: var(--color-text);
  }
  .card-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 70ch;
  }

  /* Live state row (configured vs running). */
  .state-grid {
    display: flex;
    gap: var(--space-4, 1rem);
    margin: 0;
    flex-wrap: wrap;
  }
  .state-cell {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    min-width: 11rem;
  }
  .state-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
    margin: 0;
  }
  .state-val {
    font-size: 0.95rem;
    color: var(--color-text);
    margin: 0;
  }
  .note {
    font: var(--type-body-sm);
    color: var(--color-warn, orange);
    background: var(--color-warn-bg, transparent);
    border-left: 3px solid var(--color-warn, orange);
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border-radius: var(--radius-sm, 6px);
    margin: 0;
  }

  .orch-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .mode-set {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .mode-opt {
    display: grid;
    grid-template-columns: auto 6rem 1fr;
    align-items: baseline;
    gap: var(--space-3, 0.75rem);
    padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    cursor: pointer;
  }
  .mode-opt.picked {
    border-color: var(--color-accent);
  }
  .mode-opt:focus-within {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .mode-name {
    font-weight: 600;
    color: var(--color-text);
  }
  .mode-desc {
    font-size: 0.78rem;
    color: var(--color-text-muted);
  }
  .knobs {
    display: flex;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .knob {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    flex: 1 1 16rem;
    min-width: 0;
  }
  .knob-label {
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .knob-input {
    appearance: none;
    background: var(--color-bg, #03120e);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.4rem 0.6rem;
    font-size: 0.8rem;
    min-height: 30px;
    width: 100%;
    box-sizing: border-box;
  }
  .knob-input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  .actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
    align-items: center;
    flex-wrap: wrap;
  }
  .btn {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.35rem 0.85rem;
    cursor: pointer;
    min-height: 30px;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }
  .btn:hover:not(:disabled) {
    background: var(--color-surface-card);
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.primary {
    background: var(--color-accent);
    color: var(--color-text-inverse, var(--color-bg, #03120e));
    border-color: var(--color-accent);
  }

  .confirm {
    max-height: 18rem;
    overflow: auto;
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-bg, #03120e);
  }
  .diff-pre {
    margin: 0;
    padding: 0.5rem 0.7rem;
    font-size: 0.76rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .hunk[data-op='+'] {
    color: var(--color-success, #6fae6f);
  }
  .hunk[data-op='-'] {
    color: var(--color-error);
  }
  .hunk[data-op=' '] {
    color: var(--color-text-muted);
  }

  /* Global default-provider toggle (benchmark A/B). */
  .provider-toggle {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    padding-bottom: var(--space-3, 0.75rem);
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
  }

  /* Routing view. */
  .route-cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--space-4, 1rem);
  }
  .route-col {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    min-width: 0;
  }
  .sub {
    /* h3 = heading → display face (Lastik), never mono (14.3 / D-034 §4) */
    font: var(--weight-semibold) var(--text-md) / var(--leading-snug) var(--font-display);
    color: var(--color-text);
    border-bottom: 1px solid var(--color-border-faint, var(--color-border));
    padding-bottom: var(--space-1, 0.25rem);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.78rem;
    padding: 0.3rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
    min-width: 0;
  }
  .row.bundle.unconfigured {
    opacity: 0.7;
  }
  .tag {
    font-size: 0.7rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, transparent);
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
  }
  .tag[data-tier='opus'] {
    color: var(--color-tier-opus, var(--color-accent));
  }
  .tag[data-tier='sonnet'] {
    color: var(--color-tier-sonnet, var(--color-accent));
  }
  .tag[data-tier='haiku'] {
    color: var(--color-tier-haiku, var(--color-text-muted));
  }
  .tag[data-tier='local'] {
    color: var(--color-tier-local, var(--color-text-muted));
  }
  .provider {
    font-size: 0.74rem;
    color: var(--color-text-2);
  }
  .model {
    font-size: 0.74rem;
    color: var(--color-text-muted);
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .route-note {
    font-size: 0.74rem;
    color: var(--color-text-muted);
    margin: 0;
  }
  .knobs-inline {
    font-size: 0.72rem;
    color: var(--color-text-2);
  }
  .caps {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    flex: 1 1 100%;
  }
  .none {
    font-size: 0.78rem;
    color: var(--color-text-muted);
    font-style: italic;
  }

  /* API keys. */
  .key-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .key-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
    padding: var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .key-main {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .key-name {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--color-text);
  }
  .key-state {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
    background: var(--color-surface-card);
  }
  .key-state[data-present='true'] {
    color: var(--color-success, #6fae6f);
  }
  .key-state[data-present='false'] {
    color: var(--color-text-muted);
  }
  .key-label {
    font-size: 0.78rem;
    color: var(--color-text-2);
  }
  .key-purpose {
    font-size: 0.74rem;
    color: var(--color-text-muted);
    margin: 0;
    max-width: 70ch;
  }
  .key-actions {
    display: flex;
    gap: var(--space-2, 0.5rem);
  }
  .key-set {
    display: flex;
    gap: var(--space-2, 0.5rem);
    align-items: center;
    flex-wrap: wrap;
    margin-top: var(--space-1, 0.25rem);
  }
  .key-set .knob-input {
    flex: 1 1 18rem;
  }
  .key-hint {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error);
    margin: 0;
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success, var(--color-running, var(--color-accent)));
    margin: 0;
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  /* `.sr-only` is NOT redeclared here — this page's three visually-hidden
     legends/labels (:177, :290, :442) defer to the ONE shared definition in
     src/lib/styles/tokens/base.css:76, loaded app-wide from +layout.svelte:2.
     Per-page copies of a design-system primitive drift; this one had already
     diverged into a second source of truth for the same clip-rect pattern. */
</style>
