<script lang="ts">
  /**
   * /cannibalize — the Ingest front door (CANNIBALIZE-SPEC §5). The operator capability that
   * grows the brain's ecosystem: a natural-language INTENT + one INPUT (URL · CODE_ROOT-confined
   * repo path · file · pasted text) → "Ingest" → the server runs CB1 capture + CB2 pipeline
   * (distill→screen→fence→embed→ingest). Each run walks its status enum LIVE (the `ingest_source`
   * SSE watcher re-invalidates the loader) and surfaces RESULTS: the findings ingested, each with
   * provenance (the source) + license + a link to recall it.
   *
   * Honest states throughout (F-008/§1.3): DB down → disconnected card; no runs → empty card;
   * a run can end done · quarantined (every finding screened out — nothing reached the brain) ·
   * failed (distill error — nothing partial). Read-only beyond the ingest trigger. Svelte 5 runes
   * only; design TOKENS only; a11y (labelled regions, focus-visible, status/alert live regions).
   */
  import { enhance } from '$app/forms';
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const sources = $derived(data.sources ?? []);
  const codeRoot = $derived(data.codeRoot ?? '');

  // The last ingest action's result (success banner + the per-finding result list).
  const result = $derived(form && 'ingest' in form ? form.ingest : undefined);
  // Narrowed views: the typed error (fail branch) and the typed success (ok branch). The
  // action returns a union ({error} | {ok,…}); split it once so the template stays simple.
  const resultError = $derived(result && 'error' in result ? result.error : undefined);
  const resultOk = $derived(result && 'ok' in result && result.ok ? result : undefined);

  // Controlled inputs (Svelte 5 runes) — one chosen input KIND at a time.
  let intent = $state('');
  let kind = $state<'url' | 'repo' | 'file' | 'text'>('url');
  let value = $state('');
  let license = $state('');
  let submitting = $state(false);

  // Live: an ingest_source row change (a new run, a status step) re-runs the loader so the
  // runs feed + each run's stage progress update in place (UI-SPEC §1.2) — no poll.
  $effect(() => {
    const off = stream.onDbChange('ingest_source', () => void invalidate('app:ingest'));
    return () => off();
  });

  // The ordered pipeline stages (§4). For a live (non-terminal) run we light the bar up to the
  // current stage; a terminal run shows its terminal label.
  const STAGES = ['capturing', 'distilling', 'ingesting'] as const;
  function stageIndex(status: string): number {
    const i = (STAGES as readonly string[]).indexOf(status);
    return i === -1 ? STAGES.length : i; // terminal → all stages behind it are done
  }
  function isTerminal(status: string): boolean {
    return status === 'done' || status === 'failed' || status === 'quarantined' || status === 'dropped';
  }

  /** Human label for a run status (paired with the color tag — never color-only, §9). */
  function statusLabel(s: string): string {
    if (s === 'done') return 'Done';
    if (s === 'quarantined') return 'Quarantined';
    // 'dropped' is the all-noise terminal (CB2 §7): nothing worth keeping, NO secret/PII fired —
    // honest + NEUTRAL, never the security 'Quarantined' badge (F-008).
    if (s === 'dropped') return 'Nothing kept';
    if (s === 'failed') return 'Failed';
    if (s === 'capturing') return 'Capturing';
    if (s === 'distilling') return 'Distilling';
    if (s === 'ingesting') return 'Ingesting';
    return 'Unknown';
  }

  function kindLabel(k: string): string {
    if (k === 'url') return 'URL';
    if (k === 'repo') return 'Repo';
    if (k === 'file') return 'File';
    if (k === 'text') return 'Text';
    return k;
  }

  /** Relative "time ago" for the runs feed. Honest '—' for an absent/unparseable time. */
  function ago(iso: string | null): string {
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

  /** A deep link to recall a finding on the global memory explorer (§5 "link to recall"). */
  function recallHref(memoryId: string): string {
    return `/memory?q=${encodeURIComponent(memoryId)}`;
  }

  const placeholder = $derived(
    kind === 'url'
      ? 'https://example.com/docs'
      : kind === 'text'
        ? ''
        : kind === 'repo'
          ? 'relative/path/under/CODE_ROOT'
          : 'relative/path/under/CODE_ROOT/file.md'
  );
</script>

<svelte:head>
  <title>Cannibalize — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">knowledge &amp; system</span>
    <h1 class="title">Cannibalize</h1>
    <p class="lede">
      Grow the brain's ecosystem — absorb external content (a URL, a repo file, or pasted text)
      into the global memory, where every project recalls it. Each source is captured safely
      (bounded, SSRF-safe, read-only under <span class="mono">CODE_ROOT</span>), screened and
      fenced as untrusted DATA, and ingested with its provenance and license. Operator-driven.
    </p>
  </header>

  {#if !connected}
    <div class="card error-card" role="alert">
      <span class="eyebrow">disconnected</span>
      <p class="card-body">
        The datastore is not connected, so ingest is unavailable. Start the datastore
        (<span class="mono">npm run db:up</span>) — this page recovers live once it reconnects.
      </p>
    </div>
  {:else}
    <!-- ── Ingest front door (the one mutating surface) ────────────────────────────── -->
    <article class="card" aria-labelledby="ingest-h">
      <div class="card-head">
        <span class="eyebrow">ingest</span>
        <h2 id="ingest-h" class="card-title">Ingest a source</h2>
      </div>

      {#if resultError}
        <p class="form-error" role="alert">{resultError}</p>
      {:else if resultOk}
        <p class="form-ok" role="status">
          {#if resultOk.status === 'done'}
            Ingested {resultOk.ingestedCount} of {resultOk.findingCount} finding{resultOk.findingCount === 1 ? '' : 's'}
            from <span class="mono">{resultOk.ref}</span>.
          {:else if resultOk.status === 'quarantined'}
            Nothing ingested — every finding from <span class="mono">{resultOk.ref}</span> was
            screened out (secret/PII). The source was quarantined; the brain is untouched.
          {:else if resultOk.status === 'dropped'}
            Nothing kept — no durable findings from <span class="mono">{resultOk.ref}</span> were
            worth ingesting (nothing useful to extract). No secret or PII was detected; the brain is untouched.
          {:else}
            Run {resultOk.status} for <span class="mono">{resultOk.ref}</span>.
          {/if}
        </p>
      {/if}

      <form
        method="POST"
        action="?/ingest"
        class="ingest-form"
        use:enhance={() => {
          submitting = true;
          return async ({ update }) => {
            await update();
            submitting = false;
          };
        }}
      >
        <div class="field">
          <label class="field-label" for="intent">Intent</label>
          <input
            id="intent"
            class="text-input"
            name="intent"
            type="text"
            bind:value={intent}
            placeholder="what do you want to learn from this source?"
            required
          />
        </div>

        <fieldset class="kind-field">
          <legend class="field-label">Input type</legend>
          <div class="kind-options">
            {#each ['url', 'repo', 'file', 'text'] as k (k)}
              <label class="radio">
                <input type="radio" name="kind" value={k} bind:group={kind} />
                <span>{kindLabel(k)}</span>
              </label>
            {/each}
          </div>
        </fieldset>

        <div class="field">
          <label class="field-label" for="value">
            {#if kind === 'text'}Pasted text{:else if kind === 'url'}URL{:else}Path (under CODE_ROOT){/if}
          </label>
          {#if kind === 'text'}
            <textarea
              id="value"
              class="text-input area mono"
              name="value"
              rows="6"
              bind:value
              placeholder="paste content to ingest…"
              required
            ></textarea>
          {:else}
            <input
              id="value"
              class="text-input mono"
              name="value"
              type="text"
              bind:value
              {placeholder}
              required
            />
          {/if}
          {#if kind === 'repo' || kind === 'file'}
            <p class="field-hint">
              Read-only, confined to <span class="mono">{codeRoot}</span> (D-018). A
              <span class="mono">..</span> or symlink escape is refused.
            </p>
          {/if}
        </div>

        <div class="field">
          <label class="field-label" for="license">License / consent <span class="opt">(optional)</span></label>
          <input
            id="license"
            class="text-input"
            name="license"
            type="text"
            bind:value={license}
            placeholder="e.g. CC-BY-4.0 — required to lift code"
          />
        </div>

        <div class="actions">
          <button class="btn primary" type="submit" disabled={submitting}>
            {submitting ? 'Ingesting…' : 'Ingest'}
          </button>
        </div>
      </form>
    </article>

    <!-- ── Result detail (per-finding outcome of the last run — honest) ──────────────── -->
    {#if resultOk && resultOk.findings && resultOk.findings.length > 0}
      <article class="card" aria-labelledby="findings-h">
        <div class="card-head">
          <span class="eyebrow">{kindLabel(resultOk.kind)} · {resultOk.findings.length} finding{resultOk.findings.length === 1 ? '' : 's'}</span>
          <h2 id="findings-h" class="card-title">Findings</h2>
        </div>
        <ul class="finding-rows" aria-label="ingested findings">
          {#each resultOk.findings as f (f.memoryId)}
            <li class="finding-row">
              <span class="tag" data-state={f.ingested ? 'ingested' : 'blocked'}>
                {f.ingested ? 'Ingested' : f.screenStatus === 'quarantined' ? 'Quarantined' : 'Dropped'}
              </span>
              <span class="finding-prov mono" title="provenance source">{resultOk.ref}</span>
              {#if !f.ingested && f.dropReason}
                <span class="finding-reason">{f.dropReason}</span>
              {/if}
              {#if f.ingested}
                <a class="recall-link" href={recallHref(f.memoryId)}>recall →</a>
              {/if}
            </li>
          {/each}
        </ul>
      </article>
    {/if}

    <!-- ── Recent runs (live via the ingest_source watcher) ──────────────────────────── -->
    <article class="card" aria-labelledby="runs-h">
      <div class="card-head">
        <span class="eyebrow">runs · {sources.length}</span>
        <h2 id="runs-h" class="card-title">Recent ingest runs</h2>
      </div>

      {#if sources.length === 0}
        <p class="card-body empty">
          No sources ingested yet. Ingest a URL, a repo file, or some pasted text above — runs
          appear here and update live as they move through the pipeline.
        </p>
      {:else}
        <ul class="run-rows" aria-label="recent ingest runs">
          {#each sources as s (s.id)}
            <li class="run-row">
              <div class="run-main">
                <span class="tag" data-state={s.status}>{statusLabel(s.status)}</span>
                <span class="run-kind">{kindLabel(s.kind)}</span>
                <span class="run-ref mono" title={s.ref}>{s.ref || '—'}</span>
              </div>
              <div class="run-meta">
                {#if s.intent}<span class="run-intent" title="intent">{s.intent}</span>{/if}
                <span class="run-count" title="findings ingested">
                  {s.findingCount} finding{s.findingCount === 1 ? '' : 's'}
                </span>
                {#if s.license}<span class="run-license mono" title="license/consent">{s.license}</span>{/if}
                <time class="run-at" datetime={s.createdAt ?? ''}>{ago(s.createdAt)}</time>
              </div>
              <!-- Live stage progress (§4): lit up to the current stage; terminal shows its label. -->
              <ol class="stages" aria-label="pipeline stages">
                {#each STAGES as st, i (st)}
                  <li
                    class="stage"
                    data-done={isTerminal(s.status) ? true : i < stageIndex(s.status)}
                    data-active={!isTerminal(s.status) && i === stageIndex(s.status)}
                  >
                    {st}
                  </li>
                {/each}
                <li class="stage terminal" data-state={s.status} data-done={isTerminal(s.status)}>
                  {isTerminal(s.status) ? statusLabel(s.status).toLowerCase() : '…'}
                </li>
              </ol>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="card-body footnote">
        TODO (§5): per-source utilization stats — “this source's findings have helped N times”
        (the <span class="mono">applied_count</span> mark-applied loop is recorded; surfacing it here is a follow-up).
      </p>
    </article>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
    width: 100%;
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .eyebrow {
    font: var(--type-label);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
  }
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    max-width: 78ch;
  }
  .mono {
    font-family: var(--font-mono);
  }

  .card {
    background: var(--color-surface-card);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .error-card {
    border-color: var(--color-error);
  }
  .card-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .card-title {
    font: var(--type-h2);
    color: var(--color-text);
  }
  .card-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 78ch;
  }
  .card-body.empty {
    color: var(--color-text-muted);
  }
  .footnote {
    color: var(--color-text-muted);
    border-top: var(--border-width) solid var(--color-border);
    padding-top: var(--space-2);
  }

  /* ── Ingest form ────────────────────────────────────────────────────────── */
  .ingest-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .field-label {
    font: var(--type-label);
    color: var(--color-text-2);
  }
  .opt {
    color: var(--color-text-muted);
    font-weight: normal;
  }
  .field-hint {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    margin: 0;
  }
  .text-input {
    appearance: none;
    border-radius: var(--radius-sm);
    padding: 0.45rem 0.6rem;
    font: var(--type-body-sm);
    color: var(--color-text);
    background: var(--color-surface-overlay);
    border: var(--border-width) solid var(--color-border);
    width: 100%;
  }
  .text-input.area {
    resize: vertical;
    min-height: 6rem;
  }
  .text-input:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }
  .kind-field {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .kind-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .radio {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font: var(--type-body-sm);
    color: var(--color-text);
    cursor: pointer;
  }
  .radio input:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }
  .actions {
    display: flex;
    gap: var(--space-2);
  }
  .btn {
    appearance: none;
    cursor: pointer;
    font: var(--type-label);
    padding: 0.5rem 1rem;
    border-radius: var(--radius-sm);
    border: var(--border-width) solid var(--color-border);
    background: var(--color-surface-overlay);
    color: var(--color-text);
  }
  .btn.primary {
    background: var(--color-accent);
    color: var(--color-on-accent, var(--color-bg));
    border-color: var(--color-accent);
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }

  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error);
    margin: 0;
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }

  /* ── Findings + runs lists ──────────────────────────────────────────────── */
  .finding-rows,
  .run-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .finding-row,
  .run-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-overlay);
  }
  .run-row {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
  }
  .run-main,
  .run-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .run-meta {
    color: var(--color-text-muted);
    font: var(--type-body-sm);
  }
  .run-ref,
  .finding-prov {
    overflow-wrap: anywhere;
    color: var(--color-text-2);
  }
  .run-kind,
  .run-count,
  .run-intent,
  .run-license {
    font: var(--type-body-sm);
  }
  .run-at {
    margin-left: auto;
  }
  .finding-reason {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }

  .tag {
    font: var(--type-label);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-sm);
    border: var(--border-width) solid var(--color-border);
    color: var(--color-text-2);
  }
  .tag[data-state='ingested'],
  .tag[data-state='done'] {
    color: var(--color-success, var(--color-text));
    border-color: var(--color-success, var(--color-border));
  }
  .tag[data-state='blocked'],
  .tag[data-state='quarantined'],
  .tag[data-state='failed'] {
    color: var(--color-error);
    border-color: var(--color-error);
  }
  /* 'dropped' (all-noise, NO secret) is NEUTRAL — explicitly NOT the security/error styling
     (CB2 §7, F-008). Muted text + default border, distinct from the quarantined security badge. */
  .tag[data-state='dropped'] {
    color: var(--color-text-muted);
    border-color: var(--color-border);
  }

  .recall-link {
    margin-left: auto;
    font: var(--type-label);
    color: var(--color-accent);
    text-decoration: none;
  }
  .recall-link:hover {
    text-decoration: underline;
  }
  .recall-link:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }

  /* ── Pipeline stage progress ────────────────────────────────────────────── */
  .stages {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    align-items: center;
  }
  .stage {
    font: var(--type-label);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-card);
    border: var(--border-width) solid var(--color-border);
  }
  .stage[data-done='true'] {
    color: var(--color-text-2);
    border-color: var(--color-text-2);
  }
  .stage[data-active='true'] {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .stage.terminal[data-state='done'] {
    color: var(--color-success, var(--color-text));
    border-color: var(--color-success, var(--color-border));
  }
  .stage.terminal[data-state='quarantined'],
  .stage.terminal[data-state='failed'] {
    color: var(--color-error);
    border-color: var(--color-error);
  }
  /* 'dropped' terminal stage chip — NEUTRAL, never the security/error color (CB2 §7, F-008). */
  .stage.terminal[data-state='dropped'] {
    color: var(--color-text-2);
    border-color: var(--color-text-2);
  }

  @media (prefers-reduced-motion: reduce) {
    .btn,
    .recall-link {
      transition: none;
    }
  }
</style>
