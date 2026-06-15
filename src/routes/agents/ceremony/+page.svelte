<script lang="ts">
  /**
   * /agents/ceremony — the DAY-0 BOOTSTRAP CEREMONY DRIVER, authoring half (WORKFORCE-SPEC
   * §8 steps ①+②). The operator-clickable flow that drives the existing ceremony.ts
   * MECHANISM. Three stages, all live off the ONE SSE stream (D-035):
   *   0. SEED      — 'Begin day-0 ceremony' → seedLaunchPool (idempotent): 5 launch roles +
   *                  DRAFT prompt cores + PROPOSED fixtures appear. The honest empty state.
   *   1. REVIEW    — each launch role's DRAFT prompt-core diff vs its harvested source.
   *   2. KEYS      — a D-010 diff+confirm editor per fixture: the operator authors the answer
   *                  key (plants + fp_tolerance + justification) and confirms via confirmLaunchKey.
   *                  The engine's operator guards (teethless reject, A8 bait affordance, malformed
   *                  plant reject) surface as UI affordances — not raw server errors.
   *
   * NO real spend (F-008): reference-runs / interviews (CER2) are NOT triggered here.
   * Svelte 5 runes only; design tokens only; a11y (focus-visible, labelled regions).
   */
  import { invalidate } from '$app/navigation';
  import { enhance } from '$app/forms';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const authoring = $derived(data.state);
  const seeded = $derived(authoring?.seeded ?? false);
  const roles = $derived(authoring?.roles ?? []);
  const keysOutstanding = $derived(authoring?.keysOutstanding ?? 0);
  const loadError = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // The action feedback (named, per-fixture where relevant).
  const fb = $derived(
    form && 'ceremony' in form ? (form.ceremony as Record<string, unknown>) : undefined
  );
  function fbFor(fixture: string): Record<string, unknown> | undefined {
    return fb && fb.fixture === fixture ? fb : undefined;
  }

  // Live re-derive off the ONE SSE stream (D-035): a seed (role/role_version/fixture create)
  // refreshes the flow in place. A key confirm re-loads via its own form action response (the
  // answer-key table is NEVER watched from the UI — §4.4 keeps that table server-internal).
  $effect(() => {
    const offs = ['role', 'role_version', 'gauntlet_fixture'].map((t) =>
      stream.onDbChange(t, () => void invalidate('app:workforce'))
    );
    return () => offs.forEach((off) => off());
  });

  // ── Step ① — prompt-core review: the operator marks each core 'reviewed' locally. The
  //    APPROVAL is a review act, not a write (the draft text is IMMUTABLE; §2.1) — we track
  //    it client-side so the operator can tick off the five cores as they read them.
  let reviewed = $state<Record<string, boolean>>({});
  const allReviewed = $derived(
    roles.length > 0 && roles.every((r) => !r.promptCore || reviewed[r.role])
  );

  // ── Step ② — per-fixture key editor open state + the teethless override toggle.
  let openKey = $state<Record<string, boolean>>({});
  let allowEmpty = $state<Record<string, boolean>>({});
  function toggleKey(fixture: string) {
    openKey = { ...openKey, [fixture]: !openKey[fixture] };
  }

  function kindLabel(kind: string): string {
    return kind.replace(/_/g, ' ');
  }
  /** A compact, scoreable starter plant for the operator to edit (NOT a key — a SHAPE
   *  hint). Bait fixtures get the A8 noncompliance shape; everything else a presence shape. */
  function plantHint(f: { isBait: boolean; slug: string }): string {
    if (f.isBait) {
      return JSON.stringify(
        [
          {
            id: 'no-injection-obedience',
            class: 'prompt-injection',
            detection: { mode: 'noncompliance', compliance_pattern: 'empty findings|file is clean' }
          }
        ],
        null,
        2
      );
    }
    return JSON.stringify(
      [
        {
          id: 'plant-1',
          class: 'committed-secret',
          severity: 'high',
          // detection is the machine-checkable part — a presence plant needs ≥1 of
          // file / lines / evidence_pattern (evidence_pattern is a regex source).
          detection: {
            mode: 'presence',
            file: 'path/to/file',
            lines: [1, 1],
            evidence_pattern: 'verbatim regex'
          }
        }
      ],
      null,
      2
    );
  }
</script>

<svelte:head>
  <title>Day-0 ceremony — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">workforce · day-0 bootstrap</span>
    <h1 class="title">Day-0 ceremony</h1>
    <p class="lede">
      Author the five launch roles into existence: seed the pool, review each prompt core
      against its harvested source, then author and confirm each fixture's answer key.
      Nothing here spends — reference runs and interviews are a later step.
    </p>
    <a class="back-link" href="/agents">← back to agents</a>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — the ceremony cannot run.
        {#if loadError}<span class="mono">{loadError}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else}
    <!-- ── Step 0 — ENTRY + SEED ──────────────────────────────────────────────── -->
    <div class="card" aria-labelledby="seed-title">
      <div class="panel-head">
        <span class="eyebrow" id="seed-title">step 0 · seed the launch pool</span>
        {#if seeded}
          <span class="count mono">{roles.length} role(s) · {keysOutstanding} key(s) outstanding</span>
        {/if}
      </div>

      {#if !seeded}
        <p class="state-body">
          No launch roles yet. Seeding creates the five roles, their draft prompt cores, and
          their proposed fixtures — all honest: nothing is keyed, interviewed, or certified.
          Seeding is idempotent; re-running absorbs any prior partial work.
        </p>
      {:else}
        <p class="state-body">
          The launch pool is seeded. Seeding again is safe (idempotent) — it only fills gaps.
        </p>
      {/if}

      {#if fb?.error && !fb?.fixture}
        <p class="brief-error" role="alert">{String(fb.error)}</p>
      {:else if fb?.seeded}
        <p class="brief-ok" role="status">
          Seeded {String(fb.rolesTotal)} role(s){#if Number(fb.rolesCreated) > 0}
            · {String(fb.rolesCreated)} newly created{:else} · all already present{/if}.
        </p>
      {/if}

      <form method="POST" action="?/seed" use:enhance>
        <button type="submit" class="btn primary">
          {seeded ? 'Re-seed (idempotent)' : 'Begin day-0 ceremony'}
        </button>
      </form>
    </div>

    {#if seeded}
      <!-- ── Step ① — REVIEW PROMPT CORES ─────────────────────────────────────── -->
      <div class="card" aria-labelledby="review-title">
        <div class="panel-head">
          <span class="eyebrow" id="review-title">step ① · review prompt cores (diff vs harvested source)</span>
          <span class="count mono" data-done={allReviewed}>
            {roles.filter((r) => !r.promptCore || reviewed[r.role]).length}/{roles.length} reviewed
          </span>
        </div>
        <p class="state-body">
          Each launch role's draft prompt core is the methodology the candidate will be
          interviewed against. Review it against its harvested source. The text is immutable
          (a revision is a new version) — this is a read + acknowledge.
        </p>
        <ul class="role-list" aria-label="launch roles">
          {#each roles as r (r.role)}
            <li class="role-item">
              <div class="role-head">
                <span class="role-name">{r.name}</span>
                <span class="role-slug mono">{r.roleSlug}</span>
                {#if r.promptCore}
                  <span class="ver-chip mono" title="role version">v{r.promptCore.version}</span>
                  <span class="lifecycle-badge" data-lifecycle={r.promptCore.lifecycle}>
                    {r.promptCore.lifecycle}
                  </span>
                {/if}
              </div>
              <p class="role-purpose">{r.purpose || '—'}</p>

              {#if !r.promptCore}
                <p class="empty-cell">— no draft version (re-seed to author one)</p>
              {:else}
                <p class="provenance">
                  <span class="prov-label">harvested source</span>
                  <span class="mono">{r.promptCore.provenance ?? '— (no provenance recorded)'}</span>
                </p>
                <details class="core-details">
                  <summary>view prompt core ({r.promptCore.prompt_sha.slice(0, 12)})</summary>
                  <pre class="core-text mono">{r.promptCore.promptCore}</pre>
                </details>
                <label class="review-check">
                  <input
                    type="checkbox"
                    checked={reviewed[r.role] ?? false}
                    onchange={(e) =>
                      (reviewed = {
                        ...reviewed,
                        [r.role]: (e.currentTarget as HTMLInputElement).checked
                      })}
                  />
                  I reviewed this prompt core against its harvested source
                </label>
              {/if}
            </li>
          {/each}
        </ul>
      </div>

      <!-- ── Step ② — AUTHOR / CONFIRM KEYS ───────────────────────────────────── -->
      <div class="card" aria-labelledby="keys-title">
        <div class="panel-head">
          <span class="eyebrow" id="keys-title">step ② · author &amp; confirm answer keys</span>
          <span class="count mono">{keysOutstanding} outstanding</span>
        </div>
        <p class="state-body">
          For each fixture, author the answer key — the machine-checkable plants the candidate
          must find, plus the false-positive tolerance and its justification — then confirm the
          diff. Keys are operator-authored only (§4.4) and immutable once confirmed.
        </p>

        {#each roles as r (r.role)}
          {#if r.fixtures.length > 0}
            <div class="key-role">
              <h2 class="key-role-title">
                <span class="role-name">{r.name}</span>
                <span class="role-slug mono">{r.roleSlug}</span>
              </h2>
              <ul class="fixture-list" aria-label={`${r.name} fixtures`}>
                {#each r.fixtures as f (f.fixture)}
                  {@const ffb = fbFor(f.fixture)}
                  <li class="fixture-item" class:keyed={f.keyed}>
                    <div class="fixture-head">
                      <span class="fix-slug mono">{f.slug}</span>
                      <span class="fix-kind" data-kind={f.kind}>{kindLabel(f.kind)}</span>
                      {#if f.keyed}
                        <span class="keyed-badge">keyed ✓</span>
                      {:else}
                        <span class="unkeyed-badge">no key</span>
                      {/if}
                    </div>

                    {#if f.provenance}
                      <p class="fix-prov mono">{f.provenance}</p>
                    {/if}

                    <!-- Operator guard affordances (NOT raw errors) ──────────── -->
                    {#if !f.keyed && f.requiresPlants}
                      <p class="guard-note" data-kind={f.isBait ? 'bait' : 'teeth'}>
                        {#if f.isBait}
                          A8 injection bait — its key needs a plant with
                          <span class="mono">detection.mode: "noncompliance"</span> + a
                          <span class="mono">compliance_pattern</span> (it is scored report-wide,
                          not by location).
                        {:else}
                          This fixture must carry ≥1 plant — a key with no plants is teethless
                          and can never catch anything.
                        {/if}
                      </p>
                    {/if}

                    <!-- The confirmed diff (work + key) once authored ───────── -->
                    {#if f.keyed && f.keyDiff}
                      <div class="key-diff" role="group" aria-label="confirmed key">
                        <span class="diff-label">confirmed key</span>
                        <dl class="diff-meta">
                          <div><dt>plants</dt><dd>{f.keyDiff.plants.length}</dd></div>
                          <div><dt>fp tolerance</dt><dd>{f.keyDiff.fp_tolerance}</dd></div>
                          <div>
                            <dt>justification</dt>
                            <dd>{f.keyDiff.fp_justification ?? '—'}</dd>
                          </div>
                          <div><dt>content_sha</dt><dd class="mono">{f.keyDiff.content_sha.slice(0, 12)}</dd></div>
                        </dl>
                        {#if ffb?.changed}
                          <p class="brief-warn" role="status">{String(ffb.reason)}</p>
                        {/if}
                      </div>
                    {/if}

                    {#if ffb?.error}
                      <p class="brief-error" role="alert">{String(ffb.error)}</p>
                    {:else if ffb?.ok && ffb?.created}
                      <p class="brief-ok" role="status">Key confirmed for {f.slug}.</p>
                    {/if}

                    {#if !f.keyed}
                      <button
                        type="button"
                        class="btn ghost small"
                        aria-expanded={openKey[f.fixture] ?? false}
                        onclick={() => toggleKey(f.fixture)}
                      >
                        {openKey[f.fixture] ? 'Hide key editor' : 'Author key'}
                      </button>

                      {#if openKey[f.fixture]}
                        <details class="work-details">
                          <summary>view fixture work (the diff's left side)</summary>
                          <pre class="work-text mono">{JSON.stringify(f.work, null, 2)}</pre>
                        </details>

                        <form
                          method="POST"
                          action="?/confirmKey"
                          class="key-form"
                          use:enhance
                        >
                          <input type="hidden" name="fixture" value={f.fixture} />

                          <label class="field">
                            <span class="field-label">plants (JSON array)</span>
                            <textarea
                              name="plants"
                              rows="8"
                              class="mono"
                              placeholder={plantHint(f)}
                              spellcheck="false"
                            ></textarea>
                            <span class="field-hint">
                              {f.requiresPlants
                                ? 'Each plant: {id, class, severity, detection}. The machine-checkable part is detection (file / lines / evidence_pattern). Leave empty only with the override below.'
                                : 'A control fixture may legitimately carry zero plants.'}
                            </span>
                          </label>

                          <div class="field-row">
                            <label class="field narrow">
                              <span class="field-label">fp tolerance</span>
                              <input
                                type="number"
                                name="fp_tolerance"
                                min="0"
                                step="1"
                                class="mono"
                                placeholder="engine default"
                              />
                            </label>
                            <label class="field grow">
                              <span class="field-label">fp justification</span>
                              <input
                                type="text"
                                name="fp_justification"
                                placeholder="why this tolerance is justified"
                              />
                            </label>
                          </div>

                          {#if f.requiresPlants}
                            <label class="override-check">
                              <input
                                type="checkbox"
                                name="allowEmptyPlants"
                                checked={allowEmpty[f.fixture] ?? false}
                                onchange={(e) =>
                                  (allowEmpty = {
                                    ...allowEmpty,
                                    [f.fixture]: (e.currentTarget as HTMLInputElement).checked
                                  })}
                              />
                              Override: confirm a teethless key (no plants) — on record
                            </label>
                            {#if allowEmpty[f.fixture]}
                              <label class="field">
                                <span class="field-label">override justification (required)</span>
                                <input
                                  type="text"
                                  name="emptyPlantsJustification"
                                  placeholder="why this planted fixture intentionally has no plants"
                                />
                              </label>
                            {/if}
                          {/if}

                          <label class="confirm-check">
                            <input type="checkbox" name="operatorConfirmed" />
                            I confirm this answer-key diff (D-010)
                          </label>

                          <button type="submit" class="btn primary small">Confirm key</button>
                        </form>
                      {/if}
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {/each}
      </div>

      <div class="card next-up">
        <span class="eyebrow">next</span>
        <p class="state-body">
          Once every prompt core is reviewed and every key confirmed, the admission
          reference-runs and bootstrap interviews (step ③/④) run at each role's tier/model —
          a later ceremony that does spend. This authoring step never does.
        </p>
      </div>
    {/if}
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
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
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
  .back-link {
    font-size: var(--text-xs);
    color: var(--color-accent);
    text-decoration: none;
    width: fit-content;
  }
  .back-link:hover {
    text-decoration: underline;
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
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .count {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .count[data-done='true'] {
    color: var(--color-success);
  }
  .state {
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 80ch;
  }

  /* Buttons (tokens only; focus-visible preserved) */
  .btn {
    align-self: flex-start;
    padding: var(--pad-control, 0.45rem) var(--space-5, 1.25rem);
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-sm);
    font: var(--weight-medium) var(--text-sm) / 1 var(--font-body, inherit);
    cursor: pointer;
  }
  .btn.primary {
    background: var(--color-accent);
    color: var(--color-on-accent);
  }
  .btn.primary:hover {
    background: var(--color-accent-hover, var(--color-accent));
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--color-border-strong);
    color: var(--color-text-2);
  }
  .btn.ghost:hover {
    background: var(--color-surface-overlay);
    color: var(--color-text);
  }
  .btn.small {
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }

  /* Step ① — role list */
  .role-list,
  .fixture-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .role-item,
  .fixture-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-overlay);
  }
  .role-head,
  .fixture-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }
  .role-name {
    font: var(--type-h3);
    color: var(--color-text);
  }
  .role-slug,
  .fix-slug {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .ver-chip {
    font-size: var(--text-xs);
    padding: 0.05rem 0.4rem;
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-2);
  }
  .lifecycle-badge {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    text-transform: lowercase;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    border: var(--border-width) solid var(--color-border);
  }
  .lifecycle-badge[data-lifecycle='draft'] {
    color: var(--color-text-muted);
  }
  .role-purpose {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .provenance {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    align-items: baseline;
    font-size: var(--text-xs);
    margin: 0;
  }
  .prov-label {
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .core-details,
  .work-details {
    font-size: var(--text-xs);
  }
  .core-details summary,
  .work-details summary {
    cursor: pointer;
    color: var(--color-accent);
  }
  .core-details summary:focus-visible,
  .work-details summary:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }
  .core-text,
  .work-text {
    margin: var(--space-2) 0 0;
    padding: var(--space-3);
    background: var(--color-bg-inset);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    color: var(--color-text-2);
    white-space: pre-wrap;
    overflow-x: auto;
    max-height: 22rem;
  }
  .review-check,
  .confirm-check,
  .override-check {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    font-size: var(--text-xs);
    color: var(--color-text-2);
    cursor: pointer;
  }
  .review-check input,
  .confirm-check input,
  .override-check input {
    margin-top: 0.15rem;
  }

  /* Step ② — fixtures + key editor */
  .key-role {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-3);
    border-top: var(--border-width) solid var(--color-border);
  }
  .key-role-title {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
  }
  .key-role-title .role-name {
    font: var(--type-h3);
  }
  .fixture-item.keyed {
    border-color: var(--color-success);
  }
  .fix-kind {
    font-size: var(--text-xs);
    text-transform: lowercase;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm);
    border: var(--border-width) solid var(--color-border);
    color: var(--color-text-muted);
  }
  .fix-kind[data-kind='hallucination_bait'] {
    color: var(--color-warn-on-overlay, var(--color-warn));
    border-color: var(--color-warn, var(--color-border-strong));
  }
  .keyed-badge {
    font-size: var(--text-xs);
    color: var(--color-success);
    font-weight: var(--weight-semibold);
  }
  .unkeyed-badge {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .fix-prov {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0;
  }
  .guard-note {
    font-size: var(--text-xs);
    margin: 0;
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--color-bg-inset);
    color: var(--color-text-2);
    border-left: 2px solid var(--color-warn, var(--color-border-strong));
  }
  .guard-note[data-kind='bait'] {
    border-left-color: var(--color-warn-on-overlay, var(--color-warn));
  }
  .key-diff {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg-inset);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
  }
  .diff-label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-success);
  }
  .diff-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }
  .diff-meta > div {
    display: flex;
    gap: var(--space-1);
    align-items: baseline;
    font-size: var(--text-xs);
  }
  .diff-meta dt {
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .diff-meta dd {
    margin: 0;
    color: var(--color-text-2);
  }

  .key-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-inset);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .field-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .field.narrow {
    flex: 0 0 9rem;
  }
  .field.grow {
    flex: 1 1 16rem;
  }
  .field-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .field-hint {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-style: italic;
  }
  textarea,
  .key-form input[type='text'],
  .key-form input[type='number'] {
    width: 100%;
    padding: var(--space-2);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-card);
    color: var(--color-text);
    font-size: var(--text-xs);
  }
  textarea {
    resize: vertical;
    line-height: 1.5;
  }
  textarea:focus-visible,
  .key-form input:focus-visible,
  input[type='checkbox']:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 1px;
  }

  .brief-error {
    font: var(--type-body-sm);
    color: var(--color-error);
    margin: 0;
  }
  .brief-ok {
    font: var(--type-body-sm);
    color: var(--color-success);
    margin: 0;
  }
  .brief-warn {
    font-size: var(--text-xs);
    color: var(--color-warn-on-overlay, var(--color-warn));
    margin: 0;
  }
  .empty-cell {
    color: var(--color-text-muted);
    font-style: italic;
    font-size: var(--text-xs);
    margin: 0;
  }
  .next-up {
    background: var(--color-surface-overlay);
  }
</style>
