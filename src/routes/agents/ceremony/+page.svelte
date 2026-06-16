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

  // ── CER2 — the EXECUTION half (steps ③/④/⑤). Real-spend triggers + readiness/flip.
  const execution = $derived(data.execution);
  const execRoles = $derived(execution?.roles ?? []);
  const allCertified = $derived(execution?.allCertified ?? false);
  const certifiedCount = $derived(execution?.certifiedCount ?? 0);
  const runtimeAvailable = $derived(data.runtimeAvailable);
  const runtimeReason = $derived(data.runtimeReason);

  /** A human effort/cost label for a real-spend trigger at a tier — the operator sees what
   *  the click costs before confirming (F-008: no fabricated figure; effort by tier). */
  function effortLabel(tier: string | null): string {
    if (!tier) return 'unknown tier';
    return `runs a real gauntlet at the ${tier} tier`;
  }
  function fmtUsd(v: unknown): string {
    return typeof v === 'number' ? `$${v.toFixed(4)}` : '—';
  }
  function fmtDate(at: string | null): string {
    if (!at) return '—';
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
  }

  // Per-role confirm-tick state for the real-spend triggers (the click IS the budget
  // decision — the button stays disabled until the operator ticks the spend confirm).
  let spendConfirm = $state<Record<string, boolean>>({});
  let activateConfirm = $state<Record<string, boolean>>({});
  let reversionConfirm = $state<Record<string, boolean>>({});
  let flipConfirm = $state(false);
  function setSpend(rv: string, v: boolean) {
    spendConfirm = { ...spendConfirm, [rv]: v };
  }
  function setActivate(fx: string, v: boolean) {
    activateConfirm = { ...activateConfirm, [fx]: v };
  }
  function setReversion(role: string, v: boolean) {
    reversionConfirm = { ...reversionConfirm, [role]: v };
  }

  // Per-role busy guard: a submitted trigger disables that role's buttons until the action
  // returns (no double-spend on a slow gauntlet). Cleared by enhance's completion callback.
  let busy = $state<Record<string, boolean>>({});
  function busyEnhance(key: string) {
    return () => {
      busy = { ...busy, [key]: true };
      return async ({ update }: { update: () => Promise<void> }) => {
        await update();
        busy = { ...busy, [key]: false };
      };
    };
  }

  // The action feedback (named, per-fixture where relevant).
  const fb = $derived(
    form && 'ceremony' in form ? (form.ceremony as Record<string, unknown>) : undefined
  );
  function fbFor(fixture: string): Record<string, unknown> | undefined {
    return fb && fb.fixture === fixture ? fb : undefined;
  }
  /** CER2 — per-role execution feedback, keyed by the role version the action carried. */
  function execFb(roleVersion: string): Record<string, unknown> | undefined {
    return fb && fb.roleVersion === roleVersion ? fb : undefined;
  }
  /** CER2 — per-role RE-VERSION feedback (recovery), keyed by the role id the action carried. */
  function reversionFb(role: string): Record<string, unknown> | undefined {
    return fb && fb.reversion === true && fb.role === role ? fb : undefined;
  }
  /** The panel-flip feedback (no fixture / no roleVersion — keyed by the flip flag). */
  const flipFb = $derived(fb && fb.flip === true ? fb : undefined);

  // Live re-derive off the ONE SSE stream (D-035): a seed (role/role_version/fixture create)
  // refreshes the flow in place. A key confirm re-loads via its own form action response (the
  // answer-key table is NEVER watched from the UI — §4.4 keeps that table server-internal).
  // CER2 adds interview_run (live results from the EXISTING SSE watcher — NO 2nd source,
  // D-035) and role_event (activation/fixture events) so steps ③/④ update in place.
  $effect(() => {
    const offs = ['role', 'role_version', 'gauntlet_fixture', 'interview_run', 'role_event'].map(
      (t) => stream.onDbChange(t, () => void invalidate('app:workforce'))
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

      <!-- ── Steps ③/④ — ADMISSION REFERENCE-RUNS + BOOTSTRAP INTERVIEWS (REAL SPEND) ── -->
      <div class="card" aria-labelledby="exec-title">
        <div class="panel-head">
          <span class="eyebrow" id="exec-title">step ③/④ · reference-runs &amp; bootstrap interviews</span>
          <span class="count mono" data-done={allCertified}>{certifiedCount}/{execRoles.length} certified</span>
        </div>
        <p class="state-body">
          For each role: activate its fixture pool (injects the leak sentinel, flips fixtures
          live), then run the admission reference-run (proves every plant findable at the
          role's tier/model) and the bootstrap interview (the certification gauntlet). These
          spend real tokens — every run is operator-confirmed; the click is the budget decision
          (§3.7). An ambiguous interview routes to the adjudication queue on
          <a href="/agents">/agents</a>.
        </p>

        {#if !runtimeAvailable}
          <p class="guard-note" data-kind="teeth" role="status">
            Live spend unavailable — {runtimeReason ?? 'Claude Code credential not configured'}.
            Activation and the readiness gate still work; reference-runs and interviews are
            disabled until the credential is set (F-008: no fake runs).
          </p>
        {/if}

        <ul class="role-list" aria-label="execution roles">
          {#each execRoles as r (r.role)}
            {@const xfb = r.roleVersion ? execFb(r.roleVersion) : undefined}
            <li class="role-item">
              <div class="role-head">
                <span class="role-name">{r.name}</span>
                <span class="role-slug mono">{r.roleSlug}</span>
                {#if r.version != null}<span class="ver-chip mono">v{r.version}</span>{/if}
                {#if r.defaultTier}<span class="tier-tag mono" data-tier={r.defaultTier}>{r.defaultTier}</span>{/if}
                {#if r.certified}
                  <span class="deploy-badge ok">CERTIFIED</span>
                {:else}
                  <span class="deploy-badge blocked">NOT CERTIFIED</span>
                {/if}
              </div>

              <!-- Fixture-pool activation state (the §3.8 precondition for ③/④). -->
              <p class="exec-line">
                <span class="exec-label">fixtures</span>
                <span>{r.fixturesActive} active</span>
                {#if r.fixturesProposed > 0}<span class="warn-text">· {r.fixturesProposed} proposed</span>{/if}
                {#if r.fixturesUnkeyed > 0}<span class="warn-text">· {r.fixturesUnkeyed} unkeyed</span>{/if}
              </p>

              <!-- Latest interview line (real data only; honest 'not yet interviewed'). -->
              {#if r.interview}
                <p class="interview-line" data-status={r.interview.status}>
                  {#if r.interview.status === 'error'}
                    <span class="iv-verdict">interview error</span>
                    <span class="iv-reason mono">{r.interview.errorReason ?? '—'}</span>
                  {:else if r.interview.status === 'running'}
                    <span class="iv-verdict" data-status="running">running…</span>
                  {:else if r.interview.status === 'adjudicating'}
                    <span class="iv-verdict" data-status="adjudicating">adjudicating</span>
                    <span>found {r.interview.plantedFound}/{r.interview.plantedTotal} plants</span>
                    <span class="iv-resolve">· resolve on /agents</span>
                  {:else}
                    <span class="iv-verdict" data-status={r.interview.status}>{r.interview.status}</span>
                    <span>found {r.interview.plantedFound}/{r.interview.plantedTotal} plants</span>
                    <span>· {r.interview.falsePositives} FP</span>
                  {/if}
                  <span class="tier-tag mono" data-tier={r.interview.tier}>{r.interview.tier}</span>
                  <span class="iv-model mono">({r.interview.model_id})</span>
                  <time datetime={r.interview.at ?? ''}>{fmtDate(r.interview.at)}</time>
                  {#if r.interview.session}
                    <a class="iv-transcript" href={`/claude-code?session=${r.interview.session}`}>transcript →</a>
                  {/if}
                  {#if r.interview.stale}<span class="stale-flag">stale</span>{/if}
                </p>
              {:else}
                <p class="interview-line empty">
                  {#if r.version != null}v{r.version} · {/if}not yet interviewed
                  {#if r.interviewRuns > 0}<span class="iv-sub">· {r.interviewRuns} run(s) in flight</span>{/if}
                </p>
              {/if}

              <!-- Admission reference-run proofs recorded on the keys (§3.8). -->
              {#if r.referenceProofs.length > 0}
                <div class="proofs" role="group" aria-label="admission reference-run proofs">
                  <span class="exec-label">admission proofs</span>
                  <ul class="proof-list">
                    {#each r.referenceProofs as p (p.fixtureSlug + p.interview_run)}
                      <li class="proof-item">
                        <span class="mono">{p.fixtureSlug}</span>
                        <span class="tier-tag mono" data-tier={p.tier}>{p.tier}</span>
                        <span class="iv-model mono">({p.model_id})</span>
                        <time datetime={p.at ?? ''}>{fmtDate(p.at)}</time>
                        {#if p.provisional}
                          <span class="provisional-flag" title="plants proven findable by the draft itself — the recall floor's justification is only as strong as its prover (§3.8)">
                            provisional
                          </span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              <!-- Activation gate (no real spend — flips fixtures live). Per-proposed fixture. -->
              {#if r.fixturesProposed > 0 || r.fixturesUnkeyed > 0}
                <p class="guard-note" data-kind="teeth">
                  {#if r.fixturesUnkeyed > 0}
                    {r.fixturesUnkeyed} fixture key(s) outstanding — finish step ② above before activating.
                  {:else}
                    {r.fixturesProposed} fixture(s) still proposed — activate the pool to make it
                    interviewable (injects the §4.2 leak sentinel).
                  {/if}
                </p>
              {/if}

              {#if xfb?.error}
                <p class="brief-error" role="alert">{String(xfb.error)}</p>
              {:else if xfb?.ok && xfb?.activated}
                <p class="brief-ok" role="status">
                  Fixture activated{#if Number(xfb.staleMarked) > 0} · {String(xfb.staleMarked)} run(s) marked stale{/if}.
                </p>
              {:else if xfb?.ok && xfb?.kind === 'reference'}
                <p class="brief-ok" role="status">
                  Reference-run {String(xfb.status)}{#if xfb.provisional} (provisional){/if}
                  {#if Array.isArray(xfb.recordedFor) && xfb.recordedFor.length > 0}
                    · proof recorded for {(xfb.recordedFor as string[]).length} fixture(s){/if}
                  {#if xfb.costUsd != null} · {fmtUsd(xfb.costUsd)}{/if}.
                </p>
              {:else if xfb?.ok && xfb?.kind === 'interview'}
                <p class="brief-ok" role="status">
                  Interview {String(xfb.status)} · found {String(xfb.plantedFound)}/{String(xfb.plantedTotal)}
                  · {String(xfb.falsePositives)} FP{#if xfb.costUsd != null} · {fmtUsd(xfb.costUsd)}{/if}.
                  {#if xfb.status === 'adjudicating'}Routed to the adjudication queue on /agents.{/if}
                </p>
              {:else if xfb?.queued}
                <p class="brief-warn" role="status">Queued (budget gate): {String(xfb.reason)}</p>
              {/if}

              <!-- RECOVERY — re-version & retry a role whose newest version FAILED (§2.2). -->
              {#if r.reversionable}
                {@const rfb = reversionFb(r.role)}
                <div class="reversion" role="group" aria-label="re-version and retry">
                  <p class="guard-note" data-kind="teeth">
                    The latest version{#if r.reversionFrom} (v{r.reversionFrom.version}){/if} failed
                    its interview — and a failed version is terminal (§2.2): it can never be un-failed
                    or flipped to certified. Re-versioning creates a NEW draft version cloning the same
                    prompt core, which must earn its own passing run. The failed version stays on record,
                    unchanged.
                  </p>

                  {#if rfb?.error}
                    <p class="brief-error" role="alert">{String(rfb.error)}</p>
                  {:else if rfb?.ok && rfb?.reversioned}
                    <p class="brief-ok" role="status">
                      Re-versioned: new draft v{String(rfb.newVersion)} created from the failed
                      v{String(rfb.fromVersion)}. Activate its fixtures, then run the reference-run
                      and bootstrap interview against the new version.
                    </p>
                  {:else if rfb?.ok && !rfb?.reversioned}
                    <p class="brief-warn" role="status">No re-version: {String(rfb.reason)}</p>
                  {/if}

                  <form method="POST" action="?/reversion" class="trigger-form" use:enhance={busyEnhance(`rev-${r.role}`)}>
                    <input type="hidden" name="role" value={r.role} />
                    <input type="hidden" name="operatorConfirmed" value={reversionConfirm[r.role] ? 'on' : ''} />
                    <label class="confirm-check inline">
                      <input
                        type="checkbox"
                        checked={reversionConfirm[r.role] ?? false}
                        onchange={(e) => setReversion(r.role, (e.currentTarget as HTMLInputElement).checked)}
                      />
                      confirm re-version (new draft; the failed version is not touched)
                    </label>
                    <button
                      type="submit"
                      class="btn primary small"
                      disabled={!reversionConfirm[r.role] || busy[`rev-${r.role}`]}
                    >
                      {busy[`rev-${r.role}`] ? 'Re-versioning…' : 'Re-version & retry'}
                    </button>
                  </form>
                </div>
              {/if}

              <!-- Real-spend trigger row (operator-gated, confirm + effort label). -->
              {#if r.roleVersion}
                {@const rv = r.roleVersion}
                {@const tier = r.defaultTier ?? ''}
                <div class="trigger-row">
                  <!-- Activate proposed fixtures (no spend). One control per role; activates the
                       first still-proposed candidate fixture; re-click to activate the next. -->
                  {#if r.fixturesProposed > 0 && r.fixturesUnkeyed === 0}
                    <form method="POST" action="?/activate" class="trigger-form" use:enhance={busyEnhance(`act-${rv}`)}>
                      <!-- The server activates by fixture id; we surface a role-level control that
                           activates each proposed candidate fixture in turn via its hidden id. -->
                      <input type="hidden" name="fixture" value={r.firstProposedFixture ?? ''} />
                      <!-- The confirm checkbox drives client state only; this hidden input is what
                           actually posts the gate to the action (mirrors the spend-confirm forms). -->
                      <input type="hidden" name="operatorConfirmed" value={activateConfirm[rv] ? 'on' : ''} />
                      <label class="confirm-check inline">
                        <input
                          type="checkbox"
                          checked={activateConfirm[rv] ?? false}
                          onchange={(e) => setActivate(rv, (e.currentTarget as HTMLInputElement).checked)}
                        />
                        confirm activation
                      </label>
                      <button
                        type="submit"
                        class="btn ghost small"
                        disabled={!activateConfirm[rv] || busy[`act-${rv}`] || !r.firstProposedFixture}
                      >
                        Activate fixture
                      </button>
                    </form>
                  {/if}

                  {#if r.runnable}
                    <div class="spend-group">
                      <label class="confirm-check inline">
                        <input
                          type="checkbox"
                          checked={spendConfirm[rv] ?? false}
                          onchange={(e) => setSpend(rv, (e.currentTarget as HTMLInputElement).checked)}
                        />
                        confirm spend — {effortLabel(tier)}
                      </label>
                      <div class="spend-buttons">
                        <form method="POST" action="?/referenceRun" use:enhance={busyEnhance(`ref-${rv}`)}>
                          <input type="hidden" name="roleVersion" value={rv} />
                          <input type="hidden" name="tier" value={tier} />
                          <input type="hidden" name="operatorConfirmed" value={spendConfirm[rv] ? 'on' : ''} />
                          <button
                            type="submit"
                            class="btn ghost small"
                            disabled={!spendConfirm[rv] || !runtimeAvailable || busy[`ref-${rv}`]}
                            title={!runtimeAvailable ? (runtimeReason ?? 'credential not configured') : ''}
                          >
                            {busy[`ref-${rv}`] ? 'Running…' : 'Reference-run'}
                          </button>
                        </form>
                        <form method="POST" action="?/interview" use:enhance={busyEnhance(`iv-${rv}`)}>
                          <input type="hidden" name="roleVersion" value={rv} />
                          <input type="hidden" name="tier" value={tier} />
                          <input type="hidden" name="operatorConfirmed" value={spendConfirm[rv] ? 'on' : ''} />
                          <button
                            type="submit"
                            class="btn primary small"
                            disabled={!spendConfirm[rv] || !runtimeAvailable || busy[`iv-${rv}`]}
                            title={!runtimeAvailable ? (runtimeReason ?? 'credential not configured') : ''}
                          >
                            {busy[`iv-${rv}`] ? 'Interviewing…' : 'Bootstrap interview'}
                          </button>
                        </form>
                      </div>
                    </div>
                  {:else if r.notRunnableReason}
                    <p class="empty-cell">— not runnable: {r.notRunnableReason}</p>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </div>

      <!-- ── Step ⑤ — PANEL-FLIP gate (operator-confirmed, never automatic) ──────────── -->
      <div class="card" aria-labelledby="flip-title">
        <div class="panel-head">
          <span class="eyebrow" id="flip-title">step ⑤ · panel composition flip</span>
        </div>
        <p class="state-body">
          When all five launch roles pass their bootstrap interviews, the PM panel composition
          flips from inline-prompt validators to the certified catalog roles (§9). It NEVER
          flips automatically — the operator confirms (D-010).
        </p>

        {#if flipFb?.error}
          <p class="brief-error" role="alert">{String(flipFb.error)}</p>
        {:else if flipFb?.ok}
          <p class="brief-ok" role="status">
            Panel-flip confirmed ({String(flipFb.certifiedCount)}/5 certified) — the composition
            switch to catalog roles lands with the v2.1 panel work.
          </p>
        {/if}

        {#if allCertified}
          <form method="POST" action="?/flip" use:enhance={busyEnhance('flip')}>
            <label class="confirm-check">
              <input
                type="checkbox"
                name="operatorConfirmed"
                checked={flipConfirm}
                onchange={(e) => (flipConfirm = (e.currentTarget as HTMLInputElement).checked)}
              />
              I confirm the panel composition flip to certified catalog roles (D-010)
            </label>
            <button type="submit" class="btn primary" disabled={!flipConfirm || busy.flip}>
              Confirm panel flip
            </button>
          </form>
        {:else}
          <p class="empty-cell">
            — precondition not met: {certifiedCount}/{execRoles.length} roles certified. The flip
            unlocks once all five pass.
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
  /* ── CER2 — execution (steps ③/④/⑤) ─────────────────────────────────────────── */
  .tier-tag {
    font-size: var(--text-xs);
    padding: 0.05rem 0.4rem;
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-2);
  }
  .deploy-badge {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm);
    border: var(--border-width) solid var(--color-border);
  }
  .deploy-badge.ok {
    color: var(--color-success);
    border-color: var(--color-success);
  }
  .deploy-badge.blocked {
    color: var(--color-text-muted);
  }
  .exec-line,
  .interview-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-2);
    margin: 0;
  }
  .exec-label {
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .warn-text {
    color: var(--color-warn-on-overlay, var(--color-warn));
  }
  .interview-line.empty {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .iv-sub {
    color: var(--color-text-muted);
  }
  .iv-verdict {
    font-weight: var(--weight-semibold);
    text-transform: lowercase;
  }
  .iv-verdict[data-status='passed'] {
    color: var(--color-success);
  }
  .iv-verdict[data-status='failed'] {
    color: var(--color-error);
  }
  /* Non-terminal latest run: honest, NOT error-styled (the stale-error fix). */
  .iv-verdict[data-status='adjudicating'] {
    color: var(--color-warn-on-overlay, var(--color-warn));
  }
  .iv-verdict[data-status='running'] {
    color: var(--color-text-muted);
  }
  .iv-resolve {
    color: var(--color-warn-on-overlay, var(--color-warn));
  }
  .interview-line[data-status='error'] .iv-verdict {
    color: var(--color-warn-on-overlay, var(--color-warn));
  }
  .iv-reason,
  .iv-model {
    color: var(--color-text-muted);
  }
  .iv-transcript {
    color: var(--color-accent);
    text-decoration: none;
  }
  .iv-transcript:hover {
    text-decoration: underline;
  }
  .iv-transcript:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }
  .stale-flag,
  .provisional-flag {
    font-size: var(--text-xs);
    color: var(--color-warn-on-overlay, var(--color-warn));
    border: var(--border-width) solid var(--color-warn, var(--color-border-strong));
    border-radius: var(--radius-sm);
    padding: 0 0.35rem;
  }
  .proofs {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2);
    background: var(--color-bg-inset);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
  }
  .proof-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .proof-item {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
  }
  .trigger-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: var(--border-width) solid var(--color-border);
  }
  .reversion {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: var(--border-width) solid var(--color-border);
  }
  .trigger-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .spend-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .spend-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .spend-buttons form {
    margin: 0;
  }
  .confirm-check.inline {
    align-items: center;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
