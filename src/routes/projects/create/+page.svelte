<script lang="ts">
  /**
   * /projects/create — Create-with-AI surface (CREATE-SPEC §2, §5.1-5.2).
   *
   * A three-stage flow on one page, all confirm-gated (D-010):
   *   1. BRIEF   — name + free-text description + optional hints. Submits ?/propose.
   *   2. REVIEW  — render the CA-1 structured proposal (clarifiers, dirLayout, stack, plan macro,
   *                founding tasks, targets, capability needs, optional charter) diff-style, with a
   *                D-010 confirm control. The validated envelope rides a hidden field; ?/create
   *                re-validates the confirmToken (assertProposalFresh) before any disk touch.
   *   3. DONE    — on confirm, CA-2 scaffolds the REAL project (F-008) and we land on its workspace.
   *
   * Honest states (F-008 / UI-SPEC §1.3): the brief form surfaces an up-front notice when the DB or
   * the runtime credential is unavailable, or no host project exists. Errors quote the real reason.
   * Svelte 5 runes only; design tokens only. Live: the SSE `project` watcher (already a WATCHED_TABLE
   * — no new subscription) re-invalidates nothing here, but the new row appears on /projects after we
   * navigate. clarifiers/anti-sycophancy positions are rendered as the agent authored them (§3).
   */
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // ── availability (honest up-front notices) ──
  const connected = $derived(data.connected);
  const runtimeAvailable = $derived(data.runtimeAvailable);
  const runtimeReason = $derived(data.runtimeReason);
  const hasHostProject = $derived(data.hostProjectCount > 0);
  const canPropose = $derived(connected && runtimeAvailable && hasHostProject);
  // The direct template scaffold needs only the DB (deterministic — no AI credential, no spend).
  const canScaffold = $derived(connected);

  // ── template picker (CT-2 / CT-4) ──
  const templates = $derived(data.templates ?? []);
  // '' = the pure-AI 'No template (blank brief)' path (exactly as today).
  let selectedTemplateId = $state('');
  const selectedTemplate = $derived(templates.find((t) => t.id === selectedTemplateId));
  // Per-param values keyed by `${templateId}.${key}` so switching templates keeps each one's edits.
  let paramValues = $state<Record<string, string | boolean>>({});

  function paramKey(tid: string, key: string): string {
    return `${tid}.${key}`;
  }
  /** The current value of a template param (operator edit, else its declared default). */
  function paramVal(tid: string, p: { key: string; default: string | boolean }): string | boolean {
    const k = paramKey(tid, p.key);
    return k in paramValues ? paramValues[k] : p.default;
  }

  /** Pick a template (or '' for blank): pre-fill the brief hints (CT-4), seed nothing fabricated. */
  function selectTemplate(id: string) {
    selectedTemplateId = id;
    const tpl = templates.find((t) => t.id === id);
    if (tpl) {
      // CT-4 pre-fill: only fields the template genuinely maps (honest absence otherwise).
      ecosystem = tpl.hints.ecosystem ?? ecosystem;
      targetPlatform = tpl.hints.targetPlatform ?? targetPlatform;
    }
  }

  // ── action results ──
  const propose = $derived(form && 'propose' in form ? form.propose : undefined);
  const proposeError = $derived(propose && 'error' in propose ? propose.error : undefined);
  const envelope = $derived(propose && 'ok' in propose ? propose.envelope : undefined);
  const proposal = $derived(envelope?.proposal);

  const createRes = $derived(form && 'create' in form ? form.create : undefined);
  const createError = $derived(createRes && 'error' in createRes ? createRes.error : undefined);
  const createOk = $derived(createRes && 'ok' in createRes ? createRes : undefined);

  // ── live submit state ──
  let proposing = $state(false);
  let scaffolding = $state(false);
  let creating = $state(false);

  // ── brief field bindings (preserved across a propose round-trip) ──
  let name = $state('');
  let description = $state('');
  let ecosystem = $state('');
  let refRepoUrl = $state('');
  let targetPlatform = $state('');

  // ── PM hand-off (fork 3, default ON) ──
  let hirePm = $state(true);
  let pmName = $state('');

  // ── client-only field persistence (operator convenience — NOT server state) ──
  // The brief fields, the chosen template, and the per-template param edits survive a reload AND
  // navigating away+back so nothing is re-typed. This is sessionStorage-backed convenience ONLY
  // (F-008: it never becomes server state); the generated proposal envelope is NEVER persisted — it
  // stays ephemeral (D-010), regenerated fresh from the restored brief on the next propose.
  const STORAGE_KEY = 'atelier:create:brief:v1';

  /** SSR-safe sessionStorage handle (null on the server, in tests, or when storage is unavailable). */
  function storage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.sessionStorage;
    } catch {
      // Private-mode / disabled storage — persistence silently no-ops (still fully usable).
      return null;
    }
  }

  // Restore runs exactly once, before the write-back effect is allowed to persist (so a partial
  // restore can never clobber a good snapshot). `restored` gates the write effect below.
  let restored = $state(false);

  $effect(() => {
    if (restored) return;
    const store = storage();
    if (store) {
      try {
        const raw = store.getItem(STORAGE_KEY);
        if (raw) {
          const snap = JSON.parse(raw) as Partial<{
            name: string;
            description: string;
            ecosystem: string;
            refRepoUrl: string;
            targetPlatform: string;
            selectedTemplateId: string;
            paramValues: Record<string, string | boolean>;
          }>;
          if (typeof snap.name === 'string') name = snap.name;
          if (typeof snap.description === 'string') description = snap.description;
          if (typeof snap.ecosystem === 'string') ecosystem = snap.ecosystem;
          if (typeof snap.refRepoUrl === 'string') refRepoUrl = snap.refRepoUrl;
          if (typeof snap.targetPlatform === 'string') targetPlatform = snap.targetPlatform;
          if (typeof snap.selectedTemplateId === 'string')
            selectedTemplateId = snap.selectedTemplateId;
          if (snap.paramValues && typeof snap.paramValues === 'object')
            paramValues = { ...snap.paramValues };
        }
      } catch {
        // Corrupt/foreign snapshot — drop it, start clean. Persistence stays disabled until a fresh write.
      }
    }
    restored = true;
  });

  // Write-back: any field/template/param change re-persists the snapshot. Gated on `restored` so the
  // first paint (pre-restore empty state) never overwrites a stored snapshot.
  $effect(() => {
    // Touch every persisted field so the effect re-runs on any change.
    const snap = {
      name,
      description,
      ecosystem,
      refRepoUrl,
      targetPlatform,
      selectedTemplateId,
      paramValues
    };
    if (!restored) return;
    const store = storage();
    if (!store) return;
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // Quota/serialise failure — drop this write (next change retries). Never throws to the UI.
    }
  });

  /** Reset every brief field + the selected template + params, and clear the stored snapshot. */
  function clearAll() {
    name = '';
    description = '';
    ecosystem = '';
    refRepoUrl = '';
    targetPlatform = '';
    selectedTemplateId = '';
    paramValues = {};
    const store = storage();
    if (store) {
      try {
        store.removeItem(STORAGE_KEY);
      } catch {
        // ignore — the in-memory reset above already cleared the form.
      }
    }
  }

  // The serialized envelope the confirm step re-submits (the confirmToken binds it).
  const envelopeJson = $derived(envelope ? JSON.stringify(envelope) : '');

  // On a successful create, land on the new project workspace (§2.5 hand-off).
  $effect(() => {
    if (createOk?.redirectTo) {
      const to = createOk.redirectTo;
      // Let the success summary paint a frame, then navigate.
      const t = setTimeout(() => void goto(to), 600);
      return () => clearTimeout(t);
    }
  });
</script>

<svelte:head>
  <title>Create — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">create with AI</span>
    <h1 class="title">Create a project</h1>
    <p class="lede">
      Describe what you want to build. Atelier proposes a real scaffold — directory layout, stack,
      plan, founding tasks, and deploy targets — for you to review before anything touches disk.
    </p>
  </header>

  {#if createOk}
    <!-- ── STAGE 3: DONE ───────────────────────────────────────────── -->
    <div class="card state ok" role="status" aria-live="polite">
      <span class="eyebrow">created</span>
      <p class="state-body">
        Created <span class="mono">{createOk.projectId}</span>{#if createOk.commitSha}
          at commit <span class="mono">{createOk.commitSha}</span>{/if} —
        {createOk.taskCount} founding task{createOk.taskCount === 1 ? '' : 's'} ({createOk.taskStatus}),
        {createOk.targetCount} target{createOk.targetCount === 1 ? '' : 's'} declared.
      </p>
      {#if createOk.pm}
        <p class="state-body">
          {#if createOk.pm.alreadyHired}
            PM <span class="mono">{createOk.pm.name}</span> was already in place.
          {:else}
            Hired PM <span class="mono">{createOk.pm.name}</span> — managed from day 0.
          {/if}
        </p>
      {/if}
      <p class="state-body muted">Opening the project workspace…</p>
      <a class="btn" href={createOk.redirectTo}>Open now</a>
    </div>
  {:else}
    <!-- ── STAGE 1: BRIEF ──────────────────────────────────────────── -->
    {#if !connected}
      <div class="card notice warn" role="alert">
        The database is not connected — start SurrealDB and reload before creating a project.
      </div>
    {:else if !runtimeAvailable}
      <div class="card notice warn" role="alert">
        Cannot refine with AI — {runtimeReason ?? 'the Claude Code credential is not configured'}.
        You can still scaffold directly from a template below.
      </div>
    {:else if !hasHostProject}
      <div class="card notice warn" role="alert">
        Register at least one project first to refine with AI — the read-only proposal agent needs an
        existing project as its working directory. Scaffolding directly from a template still works.
      </div>
    {/if}

    <form
      class="card brief"
      method="POST"
      action="?/propose"
      use:enhance={({ action }) => {
        // The single brief form drives BOTH actions via the buttons' formaction; flag which is running.
        if (action.search.includes('scaffoldTemplate')) scaffolding = true;
        else proposing = true;
        return async ({ update }) => {
          await update({ reset: false });
          proposing = false;
          scaffolding = false;
        };
      }}
    >
      <!-- ── TEMPLATE PICKER (CT-2/CT-4) ── -->
      <fieldset class="picker">
        <legend class="field-label">Start from a template</legend>
        <span class="field-help">
          Pick a template to scaffold a real project directly (no AI), or refine it with AI. Or choose
          “No template” for a pure-AI brief.
        </span>
        <div class="template-grid" role="radiogroup" aria-label="Project template">
          <button
            type="button"
            class="template-card"
            class:selected={selectedTemplateId === ''}
            role="radio"
            aria-checked={selectedTemplateId === ''}
            onclick={() => selectTemplate('')}
          >
            <span class="tpl-icon" aria-hidden="true">✎</span>
            <span class="tpl-name">No template</span>
            <span class="tpl-desc">Blank brief — pure AI proposal</span>
          </button>
          {#each templates as t (t.id)}
            <button
              type="button"
              class="template-card"
              class:selected={selectedTemplateId === t.id}
              role="radio"
              aria-checked={selectedTemplateId === t.id}
              onclick={() => selectTemplate(t.id)}
            >
              <span class="tpl-icon" aria-hidden="true">{t.icon || '📦'}</span>
              <span class="tpl-name">{t.name}</span>
              <span class="tpl-desc">{t.description}</span>
              {#if t.language}<span class="tpl-lang mono">{t.language}</span>{/if}
            </button>
          {/each}
        </div>
      </fieldset>

      <!-- The chosen template id rides every submit (propose carries it as CT-2 seed; scaffold uses it). -->
      <input type="hidden" name="templateId" value={selectedTemplateId} />

      <!-- ── TEMPLATE PARAMS (rendered when a template with params is selected) ── -->
      {#if selectedTemplate && selectedTemplate.params.length > 0}
        <fieldset class="params">
          <legend class="field-label">{selectedTemplate.name} options</legend>
          {#each selectedTemplate.params as p (p.key)}
            {#if p.type === 'boolean'}
              <label class="checkbox param">
                <input
                  type="checkbox"
                  name={`param.${p.key}`}
                  checked={paramVal(selectedTemplate.id, p) === true}
                  onchange={(e) =>
                    (paramValues[paramKey(selectedTemplate.id, p.key)] = e.currentTarget.checked)}
                  aria-label={p.label}
                />
                <span>{p.label}<span class="field-help param-help">{p.description}</span></span>
              </label>
            {:else if p.type === 'select'}
              <label class="field param">
                <span class="field-help">{p.label}</span>
                <select
                  class="input"
                  name={`param.${p.key}`}
                  value={String(paramVal(selectedTemplate.id, p))}
                  onchange={(e) =>
                    (paramValues[paramKey(selectedTemplate.id, p.key)] = e.currentTarget.value)}
                  aria-label={p.label}
                >
                  {#each p.options ?? [] as opt (opt)}
                    <option value={opt}>{opt}</option>
                  {/each}
                </select>
                {#if p.description}<span class="field-help param-help">{p.description}</span>{/if}
              </label>
            {:else}
              <label class="field param">
                <span class="field-help">{p.label}</span>
                <input
                  class="input mono"
                  type="text"
                  name={`param.${p.key}`}
                  value={String(paramVal(selectedTemplate.id, p))}
                  oninput={(e) =>
                    (paramValues[paramKey(selectedTemplate.id, p.key)] = e.currentTarget.value)}
                  placeholder={String(p.default)}
                  maxlength="1000"
                  autocomplete="off"
                  spellcheck="false"
                  aria-label={p.label}
                />
                {#if p.description}<span class="field-help param-help">{p.description}</span>{/if}
              </label>
            {/if}
          {/each}
        </fieldset>
      {/if}

      <label class="field">
        <span class="field-label">Project name</span>
        <input
          class="input"
          type="text"
          name="name"
          bind:value={name}
          placeholder="ROUNDS Tempo mod"
          maxlength="200"
          autocomplete="off"
          spellcheck="false"
          aria-label="Project name"
          aria-invalid={proposeError ? 'true' : undefined}
          required
        />
      </label>

      <label class="field">
        <span class="field-label">What do you want to create?</span>
        <span class="field-help">Plain language — the agent takes positions on what will and won't work.</span>
        <textarea
          class="input textarea"
          name="description"
          bind:value={description}
          rows="4"
          placeholder="A ROUNDS mod that adds a tempo mechanic where…"
          maxlength="8000"
          spellcheck="false"
          aria-label="Project description"
          required
        ></textarea>
      </label>

      <fieldset class="hints">
        <legend class="field-label">Optional hints</legend>
        <label class="field">
          <span class="field-help">Ecosystem</span>
          <input class="input mono" type="text" name="ecosystem" bind:value={ecosystem}
            placeholder="node · rust · python" maxlength="1000" autocomplete="off" spellcheck="false"
            aria-label="Ecosystem hint" />
        </label>
        <label class="field">
          <span class="field-help">Reference repo (read-only prior art)</span>
          <input class="input mono" type="url" name="refRepoUrl" bind:value={refRepoUrl}
            placeholder="https://github.com/owner/repo" maxlength="1000" autocomplete="off" spellcheck="false"
            aria-label="Reference repository URL" />
        </label>
        <label class="field">
          <span class="field-help">Target platform</span>
          <input class="input mono" type="text" name="targetPlatform" bind:value={targetPlatform}
            placeholder="web · cli · github-pages" maxlength="1000" autocomplete="off" spellcheck="false"
            aria-label="Target platform hint" />
        </label>
      </fieldset>

      <!-- PM hand-off (fork 3, default ON) — used by the DIRECT template scaffold (the AI path collects
           it again at the confirm step). The brief form's checkbox seeds both. -->
      {#if selectedTemplateId}
        <fieldset class="pm-fieldset">
          <legend class="field-label">Project management</legend>
          <label class="checkbox">
            <input type="checkbox" name="hirePm" bind:checked={hirePm} />
            <span>Hire a PM for this project (managed from day 0)</span>
          </label>
          {#if hirePm}
            <label class="field pm-name">
              <span class="field-help">PM name (optional)</span>
              <input class="input" type="text" name="pmName" bind:value={pmName}
                placeholder={`${name || 'Project'} PM`} maxlength="200"
                autocomplete="off" aria-label="PM name" />
            </label>
          {/if}
        </fieldset>
      {/if}

      <div class="actions">
        {#if selectedTemplateId}
          <button
            class="btn confirm-btn"
            type="submit"
            formaction="?/scaffoldTemplate"
            disabled={proposing || scaffolding || !canScaffold}
          >
            {scaffolding ? 'Scaffolding…' : 'Scaffold from template'}
          </button>
          <button
            class="btn secondary"
            type="submit"
            formaction="?/propose"
            disabled={proposing || scaffolding || !canPropose}
          >
            {proposing ? 'Refining…' : 'Refine with AI'}
          </button>
          <span class="field-help">
            Scaffolding writes the real project on disk now. Refining runs the AI proposal first (review before disk).
          </span>
        {:else}
          <button class="btn" type="submit" formaction="?/propose" disabled={proposing || !canPropose}>
            {proposing ? 'Generating proposal…' : 'Generate proposal'}
          </button>
        {/if}
        <button
          class="btn ghost"
          type="button"
          onclick={clearAll}
          disabled={proposing || scaffolding}
        >
          Clear all
        </button>
      </div>

      <div class="status-line" aria-live="polite">
        {#if proposeError}
          <p class="msg error" role="alert">{proposeError}</p>
        {/if}
        {#if createError && !proposal}
          <!-- A direct-scaffold (?/scaffoldTemplate) error — the AI path surfaces createError in STAGE 2. -->
          <p class="msg error" role="alert">{createError}</p>
        {/if}
      </div>
    </form>

    <!-- ── STAGE 2: REVIEW + CONFIRM ───────────────────────────────── -->
    {#if proposal}
      <article class="card proposal" aria-label="Creation proposal">
        <header class="proposal-head">
          <span class="eyebrow">proposal</span>
          <h2 class="section-title">Review before anything is created</h2>
          <p class="field-help">
            Nothing touches disk until you confirm (D-010). The scaffold is generated fresh from your
            brief, then registered from what's actually on disk (F-008).
          </p>
        </header>

        {#if proposal.clarifiers.length > 0}
          <section class="block">
            <h3 class="block-title">Clarifiers</h3>
            <ul class="clarifiers">
              {#each proposal.clarifiers as c, i (i)}
                <li class="clarifier">
                  <p class="clarifier-q">{c.question}</p>
                  <p class="clarifier-pos"><span class="tag-inline">position</span> {c.position}</p>
                  <p class="clarifier-fal"><span class="tag-inline">would change if</span> {c.falsifier}</p>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="block">
          <h3 class="block-title">Plan</h3>
          <dl class="plan">
            <dt>Purpose</dt><dd>{proposal.planMacro.purpose}</dd>
            <dt>Vision</dt><dd>{proposal.planMacro.vision}</dd>
            <dt>Role</dt><dd>{proposal.planMacro.role}</dd>
            <dt>Definition of Done</dt><dd>{proposal.planMacro.definition_of_done}</dd>
          </dl>
        </section>

        <div class="block-grid">
          <section class="block">
            <h3 class="block-title">Directory layout</h3>
            <ul class="diff" aria-label="directory layout">
              {#each proposal.dirLayout as entry (entry)}
                <li class="diff-add mono"><span class="diff-mark" aria-hidden="true">+</span>{entry}</li>
              {/each}
            </ul>
          </section>

          <section class="block">
            <h3 class="block-title">Stack</h3>
            <ul class="chips" aria-label="stack">
              {#each proposal.stack as s (s)}
                <li class="chip mono">{s}</li>
              {/each}
            </ul>
          </section>
        </div>

        <section class="block">
          <h3 class="block-title">Founding tasks</h3>
          <ol class="tasks">
            {#each proposal.foundingTasks as t, i (i)}
              <li class="task">
                <p class="task-obj">{t.objective}</p>
                <p class="task-purpose"><span class="tag-inline">why</span> {t.purpose}</p>
              </li>
            {/each}
          </ol>
        </section>

        <div class="block-grid">
          <section class="block">
            <h3 class="block-title">Deploy / publish targets</h3>
            {#if proposal.targetDrafts.length === 0}
              <p class="field-help">None proposed.</p>
            {:else}
              <ul class="targets">
                {#each proposal.targetDrafts as tg, i (i)}
                  <li class="target">
                    <span class="target-kind">{tg.kind}</span>
                    <span class="mono">{tg.adapterId}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>

          <section class="block">
            <h3 class="block-title">Capability needs</h3>
            {#if proposal.capabilityNeeds.languages.length === 0 && proposal.capabilityNeeds.frameworks.length === 0 && proposal.capabilityNeeds.defect_classes.length === 0}
              <p class="field-help">None declared.</p>
            {:else}
              <ul class="chips" aria-label="capability needs">
                {#each proposal.capabilityNeeds.languages as l (l)}<li class="chip mono">{l}</li>{/each}
                {#each proposal.capabilityNeeds.frameworks as f (f)}<li class="chip mono">{f}</li>{/each}
                {#each proposal.capabilityNeeds.defect_classes as d (d)}<li class="chip mono dc">{d}</li>{/each}
              </ul>
            {/if}
          </section>

          {#if proposal.capabilityNeeds.proposed_defect_classes.length > 0}
            <section class="block hire-signal">
              <h3 class="block-title">Needs a new certified role <span class="hire-tag">hire signal</span></h3>
              <p class="field-help">
                These defect classes are not yet in the certified vocabulary. They are captured as
                proposed needs — none of your existing roles can prove coverage of them, so closing
                this gap requires hiring and certifying a new specialized role.
              </p>
              <ul class="chips" aria-label="proposed defect classes (hire signal)">
                {#each proposal.capabilityNeeds.proposed_defect_classes as p (p)}<li class="chip mono proposed">{p}</li>{/each}
              </ul>
            </section>
          {/if}
        </div>

        {#if proposal.pmCharterDraft}
          <section class="block">
            <h3 class="block-title">PM charter draft</h3>
            <p class="charter">{proposal.pmCharterDraft}</p>
          </section>
        {/if}

        <!-- ── CONFIRM CONTROL (D-010) ── -->
        <form
          class="confirm"
          method="POST"
          action="?/create"
          use:enhance={() => {
            creating = true;
            return async ({ update }) => {
              await update({ reset: false });
              creating = false;
            };
          }}
        >
          <input type="hidden" name="envelope" value={envelopeJson} />

          <label class="checkbox">
            <input type="checkbox" name="hirePm" bind:checked={hirePm} />
            <span>Hire a PM for this project (managed from day 0)</span>
          </label>
          {#if hirePm}
            <label class="field pm-name">
              <span class="field-help">PM name (optional)</span>
              <input class="input" type="text" name="pmName" bind:value={pmName}
                placeholder={`${envelope?.brief.name ?? 'Project'} PM`} maxlength="200"
                autocomplete="off" aria-label="PM name" />
            </label>
          {/if}

          <div class="actions">
            <button class="btn confirm-btn" type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Confirm & create'}
            </button>
            <span class="field-help">This scaffolds the project on disk and registers it.</span>
          </div>

          <div class="status-line" aria-live="polite">
            {#if createError}
              <p class="msg error" role="alert">{createError}</p>
            {/if}
          </div>
        </form>
      </article>
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
  .title {
    font: var(--type-h1);
    color: var(--color-text);
  }
  .section-title {
    font: var(--type-h2);
    color: var(--color-text);
  }
  .block-title {
    font: var(--type-h3);
    color: var(--color-text);
    margin-bottom: var(--space-2);
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
  .notice {
    font: var(--type-body-sm);
  }
  .notice.warn {
    color: var(--color-text);
    border-color: var(--color-error);
    background: var(--color-error-bg, var(--color-surface-overlay));
  }
  .state {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
  }
  .state.ok {
    border-color: var(--color-success);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .state-body.muted {
    color: var(--color-text-muted);
  }

  /* ── brief form ── */
  .brief {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
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
  .hints,
  .picker,
  .params,
  .pm-fieldset {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3, 0.75rem);
    margin: 0;
  }
  .hints legend,
  .picker legend,
  .params legend,
  .pm-fieldset legend {
    padding: 0 var(--space-2, 0.5rem);
  }

  /* ── template picker ── */
  .template-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--space-2, 0.5rem);
  }
  .template-card {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    text-align: left;
    padding: var(--space-3, 0.75rem);
    background: var(--color-surface-overlay, var(--color-bg));
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
    color: var(--color-text);
    transition:
      border-color var(--motion-fast, 140ms) var(--ease-out, ease),
      background var(--motion-fast, 140ms) var(--ease-out, ease);
  }
  .template-card:hover {
    border-color: var(--color-accent);
  }
  .template-card.selected {
    border-color: var(--color-accent);
    background: var(--color-accent-muted, var(--color-surface-overlay));
  }
  .template-card:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
  .tpl-icon {
    font-size: 1.1rem;
  }
  .tpl-name {
    font-weight: 600;
    font-size: 0.85rem;
  }
  .tpl-desc {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
  }
  .tpl-lang {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-accent);
    margin-top: 0.15rem;
  }

  /* ── template params ── */
  .param {
    gap: 0.25rem;
  }
  .param-help {
    display: block;
    margin-top: 0.1rem;
  }
  select.input {
    appearance: auto;
  }
  .btn.secondary {
    color: var(--color-text);
    background: transparent;
    border-color: var(--color-border);
  }
  .btn.secondary:hover {
    border-color: var(--color-accent);
    opacity: 1;
  }
  .btn.ghost {
    color: var(--color-text-muted);
    background: transparent;
    border-color: var(--color-border);
  }
  .btn.ghost:hover {
    color: var(--color-text);
    border-color: var(--color-accent);
    opacity: 1;
  }
  .input {
    width: 100%;
    min-width: 0;
    font-size: 0.85rem;
    color: var(--color-text);
    background: var(--color-surface-overlay, var(--color-bg));
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.5rem 0.65rem;
  }
  .textarea {
    resize: vertical;
    font: var(--type-body-sm);
    line-height: 1.5;
  }
  .input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
    border-color: var(--color-accent);
  }
  .input[aria-invalid='true'] {
    border-color: var(--color-error);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
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
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    transition: opacity var(--motion-fast, 140ms) var(--ease-out, ease);
  }
  .btn:hover {
    opacity: 0.9;
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
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

  /* ── proposal review ── */
  .proposal {
    display: flex;
    flex-direction: column;
    gap: var(--space-5, 1.25rem);
  }
  .proposal-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .block {
    display: flex;
    flex-direction: column;
  }
  .block-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--space-5, 1.25rem);
  }
  .clarifiers,
  .tasks,
  .targets,
  .diff,
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .clarifiers {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .clarifier {
    border-left: 2px solid var(--color-accent);
    padding-left: var(--space-3, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .clarifier-q {
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }
  .clarifier-pos,
  .clarifier-fal,
  .task-purpose {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .tag-inline {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 700;
    color: var(--color-accent);
    margin-right: 0.4rem;
  }
  .plan {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-2, 0.5rem) var(--space-4, 1rem);
    margin: 0;
  }
  .plan dt {
    font-weight: 600;
    color: var(--color-text-muted);
    font-size: 0.78rem;
  }
  .plan dd {
    margin: 0;
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .diff {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.78rem;
  }
  .diff-add {
    color: var(--color-success);
    display: flex;
    gap: 0.5rem;
  }
  .diff-mark {
    color: var(--color-success);
    font-weight: 700;
    flex: 0 0 auto;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .chip {
    font-size: 0.7rem;
    color: var(--color-accent);
    background: var(--color-accent-muted, var(--color-surface-overlay));
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
  }
  .chip.dc {
    color: var(--color-text-2);
  }
  .hire-signal {
    border-left: 2px solid var(--color-warn);
    padding-left: var(--space-3, 0.75rem);
  }
  .hire-tag {
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-warn-on-overlay);
    background: var(--color-warn-bg);
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    vertical-align: middle;
  }
  .chip.proposed {
    color: var(--color-warn-on-overlay);
    background: var(--color-warn-bg);
  }
  .tasks {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    counter-reset: t;
    padding-left: 0;
  }
  .task {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .task-obj {
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }
  .targets {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .target {
    display: flex;
    align-items: center;
    gap: var(--space-3, 0.75rem);
    font-size: 0.8rem;
  }
  .target-kind {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 700;
    color: var(--color-accent);
  }
  .charter {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    white-space: pre-wrap;
    margin: 0;
  }

  /* ── confirm control ── */
  .confirm {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
    border-top: var(--border-width, 1px) solid var(--color-border);
    padding-top: var(--space-4, 1rem);
  }
  .checkbox {
    display: flex;
    align-items: center;
    gap: var(--space-2, 0.5rem);
    font: var(--type-body-sm);
    color: var(--color-text);
  }
  .checkbox input {
    accent-color: var(--color-accent);
    width: 1rem;
    height: 1rem;
  }
  .pm-name {
    max-width: 24rem;
  }
  .confirm-btn {
    background: var(--color-success);
    border-color: var(--color-success);
  }
</style>
