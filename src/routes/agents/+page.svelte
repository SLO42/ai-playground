<script lang="ts">
  /**
   * /agents — agent fleet + usage LENS (UI-SPEC §198–200).
   *
   * Tier-centric LENS: pool tier/role DEFINITIONS (config mirror), the LIVE fleet of
   * running/recent sessions (liveness from session.status — never agent_slot.busy,
   * §199), and per-tier usage analytics. All LIVE from the DB (F-008). Live by default
   * (§1.2): a `session` or `agent_event` row change on the one SSE stream re-invalidates
   * the loader so the fleet grid + usage update in place. Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { enhance } from '$app/forms';
  import { stream } from '$lib/client/stream.svelte';
  import { isRunBusy, setRunBusy, type AdjBusyMap } from './adj-busy';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const pool = $derived(data.pool ?? []);
  const fleet = $derived(data.fleet ?? []);
  const usage = $derived(data.usage ?? []);
  const catalog = $derived(data.catalog ?? []);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // ── TASK 16.7b — W-D7c workforce surfaces (WORKFORCE-SPEC §8). Role cards + the §3.4
  //    adjudication queue. Live via the existing SSE onDbChange watchers (no second SSE
  //    source, D-035). Day-one reality: no interview data → every role is honest empty.
  const workforce = $derived(data.workforce ?? null);
  const roleCards = $derived(workforce?.roles ?? []);
  const adjudication = $derived(workforce?.adjudication ?? []);
  const wfFeedback = $derived(
    form && 'workforce' in form ? (form.workforce as Record<string, unknown>) : undefined
  );

  const running = $derived(fleet.filter((f) => f.status === 'running'));
  const recent = $derived(fleet.filter((f) => f.status !== 'running'));

  // ── Status-transition motion (DESIGN-SYSTEM §7) ───────────────────────────────
  // When a fleet session's status changes (running → done/failed), flash its tile.
  // The flash is GPU-only (transform/opacity via a keyframe) and its duration rides
  // the `--motion-*` tokens — which collapse to 0ms under prefers-reduced-motion, so
  // reduced-motion users get an INSTANT swap (no animation), no layout thrash.
  // We track the last-seen status per session id; a change marks the tile for one
  // animation cycle, then clears so re-renders don't re-trigger it.
  let lastStatus = $state<Record<string, string>>({});
  let changed = $state<Record<string, number>>({}); // id → nonce; bumped on change

  $effect(() => {
    const next: Record<string, string> = { ...lastStatus };
    let touched = false;
    for (const f of fleet) {
      const prev = lastStatus[f.id];
      if (prev !== undefined && prev !== f.status) {
        changed = { ...changed, [f.id]: (changed[f.id] ?? 0) + 1 };
        // clear the flag after one animation cycle (token-bounded; instant under RM)
        const id = f.id;
        setTimeout(() => {
          const rest = { ...changed };
          delete rest[id];
          changed = rest;
        }, 600);
      }
      if (prev !== f.status) {
        next[f.id] = f.status;
        touched = true;
      }
    }
    if (touched) lastStatus = next;
  });

  // Group pool slots by tier for the definitions panel.
  const poolByTier = $derived.by(() => {
    const m = new Map<string, typeof pool>();
    for (const s of pool) {
      const arr = m.get(s.tier) ?? [];
      arr.push(s);
      m.set(s.tier, arr);
    }
    return [...m.entries()].map(([tier, slots]) => ({ tier, slots }));
  });

  $effect(() => {
    const off1 = stream.onDbChange('session', () => void invalidate('app:fleet'));
    const off2 = stream.onDbChange('agent_event', () => void invalidate('app:analytics'));
    const off3 = stream.onDbChange('cc_agent', () => void invalidate('app:claude-code'));
    // TASK 16.7b — workforce surfaces re-derive live off the ONE SSE stream (D-035): a
    // role/version create, an interview_run finalize/adjudicate, a panel_verdict, or a
    // role_event all re-invalidate the workforce slice. No second SSE source.
    const wf = ['role', 'role_version', 'interview_run', 'panel_verdict', 'role_event'].map(
      (t) => stream.onDbChange(t, () => void invalidate('app:workforce'))
    );
    return () => {
      off1();
      off2();
      off3();
      wf.forEach((off) => off());
    };
  });

  function fmtCost(c: number | null): string {
    return c == null ? '—' : `$${c.toFixed(2)}`;
  }
  function fmtTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  function fmtMs(ms: number | null): string {
    return ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }
  function shortId(id: string): string {
    return id.split(':').pop()?.slice(0, 8) ?? id;
  }
  // A project scope id is `project:<slug>` — surface the slug as the honest label.
  function scopeLabel(projectId: string): string {
    return projectId.split(':').pop() ?? projectId;
  }

  // ── TASK 16.7b — workforce formatters (honest '—'; '—' is NEVER the digit 0, §4.5) ──
  /** Calendar date for the interview line ('2026-06-14'); '—' when absent. */
  function fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toISOString().slice(0, 10);
  }
  /** A percentage from a real ratio; null → '—' (never a fabricated 0%). */
  function pct(n: number | null): string {
    return n == null ? '—' : `${Math.round(n * 100)}%`;
  }
  /** A bare count where 0 IS an honest figure (e.g. false positives on a real run). */
  function count(n: number | null): string {
    return n == null ? '—' : String(n);
  }
  /** USD; null → '— (no completed reviews)' on cost cells (§8 degraded states). */
  function fmtCostHonest(c: number | null): string {
    return c == null ? '— (no completed reviews)' : `$${c.toFixed(2)}`;
  }

  // Adjudication: one resolution selector per ambiguous item, keyed by `${run}:${idx}`.
  // partial_match items may be confirmed as a HIT; everything else is FP or dismiss.
  let resChoice = $state<Record<string, 'confirm_hit' | 'false_positive' | 'dismiss'>>({});
  // Busy is scoped PER RUN (keyed by run id), not a single shared flag: submitting one
  // run's adjudication must disable ONLY that run's button, leaving every other queued
  // run resolvable (16.7b — shared-flag cross-form coupling fix). Transition/lookup via
  // the rune-free helpers in ./adj-busy (unit-tested for the isolation contract).
  let adjBusy = $state<AdjBusyMap>({});

  function itemType(item: Record<string, unknown>): string {
    return typeof item.type === 'string' ? item.type : 'unknown';
  }
  function canConfirmHit(item: Record<string, unknown>): boolean {
    return item.type === 'partial_match' && typeof item.plant === 'string';
  }
  function choiceFor(run: string, idx: number, item: Record<string, unknown>): string {
    const key = `${run}:${idx}`;
    // default: confirm_hit when legal (it carries a plant), else false_positive.
    return resChoice[key] ?? (canConfirmHit(item) ? 'confirm_hit' : 'false_positive');
  }
  function setChoice(run: string, idx: number, v: 'confirm_hit' | 'false_positive' | 'dismiss') {
    resChoice = { ...resChoice, [`${run}:${idx}`]: v };
  }
  /** Build the resolutions JSON payload for one adjudicating run (ALL items, §3.4). */
  function resolutionsJson(run: string, items: Array<Record<string, unknown>>): string {
    return JSON.stringify(
      items.map((item, idx) => ({ index: idx, resolution: choiceFor(run, idx, item) }))
    );
  }
  function compact(item: Record<string, unknown>): string {
    // A readable one-line summary of an ambiguous item (no key material; these are the
    // candidate's own finding fragments the scorer could not deterministically match).
    const parts: string[] = [];
    if (item.fixture) parts.push(String(item.fixture));
    if (item.file) parts.push(String(item.file));
    if (item.lines) parts.push(`L${String(item.lines)}`);
    if (item.class) parts.push(String(item.class));
    return parts.join(' · ') || itemType(item);
  }
</script>

<svelte:head>
  <title>Agents — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">harness</span>
    <h1 class="title">Agents</h1>
    <p class="lede">
      The agent fleet — tier definitions, live sessions, and usage by tier. Liveness is
      read from running sessions, not a pool flag, so the grid always reflects real work.
    </p>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no fleet rather than fabricated agents.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else}
    <!-- ── TASK 16.7b — WORKFORCE PANEL (WORKFORCE-SPEC §8 'Surfaces') ──────────────
         Role cards: version chip + lifecycle badge, the interview line (found N/T
         plants · k FP · <tier> (<model_id>) · <date>, linking the transcript), stale
         flag, track-record stats EACH with its inline sample size, '—' for no data.
         Day-one reality: no interview data → 'v1 · not yet interviewed' + NOT
         DEPLOYABLE + Run interview CTA. The honest empties ARE the surface. -->
    <div class="card workforce" aria-labelledby="wf-title">
      <div class="panel-head">
        <span class="eyebrow" id="wf-title">workforce (certified roles)</span>
        {#if roleCards.length > 0}
          <span class="count mono">
            {roleCards.filter((r) => r.deployable).length}/{roleCards.length} deployable
          </span>
        {/if}
      </div>
      {#if roleCards.length === 0}
        <p class="state-body">
          No catalog roles yet — the five launch roles seed during the day-0 bootstrap
          ceremony. Showing nothing rather than fabricated roles.
        </p>
      {:else}
        <ul class="role-cards" aria-label="workforce roles">
          {#each roleCards as r (r.role)}
            <li class="role-card" class:not-deployable={!r.deployable}>
              <div class="role-head">
                <span class="role-name">{r.name}</span>
                <span class="role-slug mono">{r.slug}</span>
                {#if r.version != null}
                  <span class="ver-chip mono" title="role version">v{r.version}</span>
                {/if}
                {#if r.lifecycle}
                  <span class="lifecycle-badge" data-lifecycle={r.lifecycle}>{r.lifecycle}</span>
                {/if}
              </div>
              <p class="role-purpose">{r.purpose || '—'}</p>

              <!-- Deployability badge: the §8 NOT DEPLOYABLE state with the named reason. -->
              {#if r.deployable}
                <span class="deploy-badge deployable">deployable{#if r.poolGeneration}<span class="pool-gen"> · {r.poolGeneration}</span>{/if}</span>
              {:else}
                <span class="deploy-badge blocked">NOT DEPLOYABLE</span>
                <!-- The 'not yet interviewed' reason is already carried by the interview
                     line below; suppress the duplicate and surface only richer reasons. -->
                {#if r.notDeployableReason && r.notDeployableReason !== 'not yet interviewed'}
                  <p class="deploy-reason">{r.notDeployableReason}</p>
                {/if}
              {/if}

              <!-- Interview line (§8): real data only; honest 'not yet interviewed'. -->
              {#if r.interview}
                <p class="interview-line" data-status={r.interview.status}>
                  {#if r.interview.status === 'error'}
                    <span class="iv-verdict">interview error</span>
                    <span class="iv-reason mono">{r.interview.errorReason ?? '—'}</span>
                  {:else}
                    <span class="iv-verdict">
                      found {r.interview.plantedFound}/{r.interview.plantedTotal} plants
                    </span>
                    <span class="iv-sep">·</span>
                    <span>{r.interview.falsePositives} FP</span>
                  {/if}
                  <span class="iv-sep">·</span>
                  <span class="tier-tag" data-tier={r.interview.tier}>{r.interview.tier}</span>
                  <!-- model_id rendered straight from the run row (never hardcoded). -->
                  <span class="iv-model mono">({r.interview.modelId})</span>
                  <span class="iv-sep">·</span>
                  <time datetime={r.interview.at ?? ''}>{fmtDate(r.interview.at)}</time>
                  {#if r.interview.session}
                    <a class="iv-transcript" href={`/claude-code?session=${r.interview.session}`}>
                      transcript →
                    </a>
                  {/if}
                  {#if r.interview.stale}
                    <span class="stale-flag" title="fixture pool changed since this run (§3.7)">stale</span>
                  {/if}
                </p>
              {:else}
                <p class="interview-line empty">
                  v{r.version ?? '?'} · not yet interviewed
                  {#if r.interviewRuns > 0}
                    <span class="iv-sub">· {r.interviewRuns} run(s) in flight</span>
                  {/if}
                </p>
                <form method="POST" action="/agents" class="run-interview-cta">
                  <!-- The day-0 interview runs via the bootstrap ceremony (operator-gated,
                       INERT until armed). The CTA points the operator at the PM ceremony;
                       it does not auto-spend (F-008 budget = null = nothing auto-runs). -->
                  <a class="cta-link" href="/?ceremony=bootstrap">Run interview</a>
                </form>
              {/if}

              <!-- Track-record stats — EACH with its inline sample size; '—' for no data. -->
              {#if r.track}
                <dl class="track" aria-label="track record">
                  <div class="track-row">
                    <dt>panel verdicts</dt>
                    <dd>
                      {#if r.track.panel.total > 0}
                        {r.track.panel.approve} approve / {r.track.panel.pushback} pushback
                        <span class="sample">over {r.track.panel.total} verdict(s)</span>
                      {:else}
                        <span class="empty-cell">— no track data</span>
                      {/if}
                    </dd>
                  </div>
                  <div class="track-row">
                    <dt>pushback upheld</dt>
                    <dd>
                      {#if r.track.panel.total > 0}
                        {r.track.panel.outcomes.upheld} upheld /
                        {r.track.panel.outcomes.overridden_by_operator} overridden
                        <span class="sample">
                          over {r.track.panel.total - r.track.panel.outcomes.open} closed
                        </span>
                      {:else}
                        <span class="empty-cell">— no track data</span>
                      {/if}
                    </dd>
                  </div>
                  <div class="track-row">
                    <dt>recall (latest)</dt>
                    <dd>
                      {#if r.track.interviews.length > 0}
                        {#each r.track.interviews as cell (cell.model_id)}
                          <span class="recall-cell">
                            <span class="mono">{cell.model_id}</span>
                            {pct(cell.recall)}
                            <span class="sample">{count(cell.falsePositives)} FP · {cell.runs} run(s)</span>
                          </span>
                        {/each}
                      {:else}
                        <span class="empty-cell">— no interviews yet</span>
                      {/if}
                    </dd>
                  </div>
                  <div class="track-row">
                    <dt>field cost</dt>
                    <dd>
                      {fmtCostHonest(r.track.field.costUsd)}
                      {#if r.track.field.sessions > 0}
                        <span class="sample">over {r.track.field.sessions} session(s)</span>
                      {/if}
                    </dd>
                  </div>
                  <!-- §2.5 pre-B2 metrics: declared null until v2.2b lands review_verdict.
                       Rendered as the honest '— (needs B2)' — NO placeholder math. -->
                  <div class="track-row b2">
                    <dt>refutation / fix-loop</dt>
                    <dd><span class="empty-cell">— (needs B2)</span></dd>
                  </div>
                </dl>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- ── §3.4 ambiguous-match adjudication queue (the operator is the judge) ────── -->
    {#if adjudication.length > 0}
      <div class="card adjudication" aria-labelledby="adj-title">
        <div class="panel-head">
          <span class="eyebrow" id="adj-title">adjudication queue</span>
          <span class="count mono">{adjudication.length} awaiting</span>
        </div>
        <p class="state-body">
          The scorer matched these findings deterministically except for the items below.
          Resolve EVERY item of a run in one ceremony — the run then finalizes against its
          snapshot pass bar (§3.4).
        </p>
        {#if wfFeedback?.error}
          <p class="brief-error" role="alert">{String(wfFeedback.error)}</p>
        {:else if wfFeedback?.ok}
          <p class="adj-ok" role="status">
            Run finalized as <span class="mono">{String(wfFeedback.status)}</span>.
          </p>
        {/if}
        <ul class="adj-runs" aria-label="adjudicating runs">
          {#each adjudication as a (a.run)}
            <li class="adj-run">
              <div class="adj-run-head">
                <span class="role-slug mono">{a.roleSlug}</span>
                <span class="tier-tag" data-tier={a.tier}>{a.tier}</span>
                <span class="iv-model mono">({a.modelId})</span>
                <span class="adj-progress mono">
                  {a.plantedFound}/{a.plantedTotal} found · {a.falsePositives} FP
                </span>
              </div>
              <form
                method="POST"
                action="?/adjudicate"
                use:enhance={() => {
                  adjBusy = setRunBusy(adjBusy, a.run, true);
                  return async ({ update }) => {
                    await update({ reset: false });
                    adjBusy = setRunBusy(adjBusy, a.run, false);
                  };
                }}
              >
                <input type="hidden" name="run" value={a.run} />
                <input
                  type="hidden"
                  name="resolutions"
                  value={resolutionsJson(a.run, a.ambiguous)}
                />
                <ul class="adj-items">
                  {#each a.ambiguous as item, idx (idx)}
                    <li class="adj-item">
                      <span class="adj-item-type mono" data-type={itemType(item)}>{itemType(item)}</span>
                      <span class="adj-item-desc">{compact(item)}</span>
                      <fieldset class="adj-choices">
                        <legend class="sr-only">resolution for item {idx + 1}</legend>
                        {#if canConfirmHit(item)}
                          <label>
                            <input
                              type="radio"
                              name={`r-${a.run}-${idx}`}
                              checked={choiceFor(a.run, idx, item) === 'confirm_hit'}
                              onchange={() => setChoice(a.run, idx, 'confirm_hit')}
                            />
                            confirm hit
                          </label>
                        {/if}
                        <label>
                          <input
                            type="radio"
                            name={`r-${a.run}-${idx}`}
                            checked={choiceFor(a.run, idx, item) === 'false_positive'}
                            onchange={() => setChoice(a.run, idx, 'false_positive')}
                          />
                          false positive
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={`r-${a.run}-${idx}`}
                            checked={choiceFor(a.run, idx, item) === 'dismiss'}
                            onchange={() => setChoice(a.run, idx, 'dismiss')}
                          />
                          dismiss
                        </label>
                      </fieldset>
                    </li>
                  {/each}
                </ul>
                <button type="submit" class="adj-submit" disabled={isRunBusy(adjBusy, a.run)}>
                  {isRunBusy(adjBusy, a.run) ? 'Resolving…' : 'Resolve all & finalize'}
                </button>
              </form>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Live fleet grid -->
    <div class="card">
      <div class="panel-head">
        <span class="eyebrow">live fleet</span>
        <span class="count mono">{running.length} running · {recent.length} recent</span>
      </div>
      {#if fleet.length === 0}
        <p class="state-body">No sessions yet — launch a task to populate the fleet.</p>
      {:else}
        <ul class="fleet-grid" aria-label="agent fleet">
          {#each running as s (s.id)}
            <li class="agent running" class:status-changed={changed[s.id]} data-status="running">
              <span class="agent-status" data-status="running">
                <span class="dot" aria-hidden="true"></span>running
              </span>
              <span class="agent-model mono">{s.provider}/{s.modelId}</span>
              {#if s.tier}<span class="tier-tag" data-tier={s.tier}>{s.tier}</span>{/if}
              <span class="agent-id mono">{shortId(s.id)}</span>
            </li>
          {/each}
          {#each recent as s (s.id)}
            <li class="agent" class:status-changed={changed[s.id]} data-status={s.status}>
              <span class="agent-status" data-status={s.status}>{s.status}</span>
              <span class="agent-model mono">{s.provider}/{s.modelId}</span>
              {#if s.tier}<span class="tier-tag" data-tier={s.tier}>{s.tier}</span>{/if}
              <span class="agent-id mono">{shortId(s.id)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- Usage by tier -->
    <div class="card">
      <span class="eyebrow">usage by tier (30 days)</span>
      {#if usage.length === 0}
        <p class="state-body">No usage recorded yet.</p>
      {:else}
        <table class="usage-table">
          <thead>
            <tr><th>tier</th><th>provider</th><th>runs</th><th>tokens</th><th>cost</th><th>avg dur</th></tr>
          </thead>
          <tbody>
            {#each usage as u (u.provider + ':' + u.tier)}
              <tr>
                <td><span class="tier-tag" data-tier={u.tier}>{u.tier}</span></td>
                <td class="mono">{u.provider}</td>
                <td>{u.runs}</td>
                <td class="mono">{fmtTokens(u.tokensIn + u.tokensOut)}</td>
                <td class="mono">{fmtCost(u.costUsd)}</td>
                <td class="mono">{fmtMs(u.avgDurationMs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Pool definitions (config mirror — not live allocation) -->
    <div class="card">
      <span class="eyebrow">pool (tier definitions)</span>
      {#if pool.length === 0}
        <p class="state-body">No pool slots configured.</p>
      {:else}
        <div class="pool">
          {#each poolByTier as group (group.tier)}
            <div class="pool-tier">
              <span class="tier-tag" data-tier={group.tier}>{group.tier}</span>
              <ul class="pool-slots">
                {#each group.slots as slot (slot.id)}
                  <li class="pool-slot mono">{slot.name}<span class="role">{slot.role}</span></li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Agent catalog (available agent TYPES from the cc_agent mirror — 11.3, UI-SPEC §198) -->
    <div class="card">
      <div class="panel-head">
        <span class="eyebrow">agent catalog (available types)</span>
        <span class="count mono">{catalog.length} {catalog.length === 1 ? 'type' : 'types'}</span>
      </div>
      {#if catalog.length === 0}
        <p class="state-body">
          No agent types synced yet — sync a project's <span class="mono">.claude/agents</span> on
          /claude-code to populate the catalog. Showing nothing rather than fabricated agents.
        </p>
      {:else}
        <ul class="catalog" aria-label="agent catalog">
          {#each catalog as a (a.name)}
            <li class="cat-row">
              <div class="cat-head">
                <span class="cat-name mono">{a.name}</span>
                {#if a.category}<span class="cat-cat">{a.category}</span>{/if}
              </div>
              <p class="cat-desc">{a.description ?? '—'}</p>
              <div class="cat-meta">
                <span class="cat-label">capabilities</span>
                {#if a.bundles.length > 0}
                  <span class="cat-bundles">
                    {#each a.bundles as b (b)}<span class="bundle-tag mono">{b}</span>{/each}
                  </span>
                {:else}
                  <span class="cat-none">— not in any capability bundle</span>
                {/if}
              </div>
              <div class="cat-meta">
                <span class="cat-label">defined in</span>
                <span class="cat-scopes">
                  {#each a.scopes as sc, i (sc.kind + ':' + (sc.projectId ?? '') + ':' + i)}
                    <span class="scope-tag" data-kind={sc.kind}>
                      {#if sc.kind === 'project' && sc.projectId}
                        {scopeLabel(sc.projectId)}
                      {:else}
                        {sc.kind}
                      {/if}
                    </span>
                  {/each}
                </span>
              </div>
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
    max-width: 72ch;
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
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }
  .state {
    gap: var(--space-2);
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .fleet-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-3, 0.75rem);
  }
  .agent {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .agent.running {
    border-color: var(--color-running, var(--color-success, #2a9d4a));
  }
  /* Status-transition motion (DESIGN-SYSTEM §7): a tile whose status just changed
     flashes once. GPU-only (transform/opacity), duration from the --motion-* tokens
     so prefers-reduced-motion (which zeroes those tokens) yields an INSTANT swap with
     no animation. No size change → no layout thrash; the grid never reflows. */
  .agent {
    transition:
      border-color var(--motion-normal) var(--ease-out),
      background var(--motion-normal) var(--ease-out);
    will-change: transform;
  }
  .agent.status-changed {
    animation: agent-status-flash var(--motion-slow) var(--ease-out);
  }
  @keyframes agent-status-flash {
    0% {
      transform: scale(1);
      opacity: 0.55;
    }
    35% {
      transform: scale(1.025);
      opacity: 1;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .agent.status-changed {
      animation: none;
    }
  }
  .agent-status .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: var(--radius-pill, 999px);
    background: var(--color-running, var(--color-success, #2a9d4a));
    margin-right: 0.3rem;
    vertical-align: middle;
    animation: ds-pulse 1.8s var(--ease-in-out) infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .agent-status .dot {
      animation: none;
    }
  }
  .agent-status {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: lowercase;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-text-muted);
  }
  .agent-status[data-status='running'] {
    color: var(--color-running, var(--color-success, #2a9d4a));
  }
  .agent-status[data-status='failed'] {
    /* failed = ERROR red (not amber); -on-overlay tint hits BODY AA on the
       overlay agent row (14.3). */
    color: var(--color-error-on-overlay);
  }
  .agent-model {
    font-size: 0.74rem;
    color: var(--color-text);
  }
  .agent-id {
    font-size: 0.66rem;
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .usage-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .usage-table th {
    text-align: left;
    font-weight: 600;
    color: var(--color-text-muted);
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    text-transform: lowercase;
  }
  .usage-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
    color: var(--color-text-2);
  }
  .pool {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4, 1rem);
  }
  .pool-tier {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 130px;
  }
  .pool-slots {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .pool-slot {
    font-size: 0.74rem;
    color: var(--color-text-2);
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .role {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .tier-tag {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text);
    width: fit-content;
  }
  .tier-tag[data-tier='opus'] {
    color: var(--color-tier-opus, var(--color-accent));
  }
  .tier-tag[data-tier='sonnet'] {
    color: var(--color-tier-sonnet, var(--color-accent));
  }
  .tier-tag[data-tier='haiku'] {
    color: var(--color-tier-haiku, var(--color-text-muted));
  }
  .tier-tag[data-tier='local'] {
    color: var(--color-tier-local, var(--color-text-muted));
  }

  /* Agent catalog (11.3) */
  .catalog {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3, 0.75rem);
  }
  .cat-row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .cat-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .cat-name {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--color-text);
  }
  .cat-cat {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
  }
  .cat-desc {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .cat-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.7rem;
  }
  .cat-label {
    color: var(--color-text-muted);
    text-transform: lowercase;
    min-width: 5.5rem;
  }
  .cat-bundles,
  .cat-scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .bundle-tag {
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-accent, var(--color-text));
    border: 1px solid var(--color-border);
  }
  .scope-tag {
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text-2);
    border: 1px solid var(--color-border);
  }
  .scope-tag[data-kind='global'] {
    color: var(--color-text-muted);
  }
  .cat-none {
    color: var(--color-text-muted);
    font-style: italic;
  }

  /* ── TASK 16.7b — workforce panel + adjudication queue ──────────────────────── */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .role-cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: var(--space-3);
  }
  .role-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-overlay);
  }
  .role-card.not-deployable {
    border-color: var(--color-warn, var(--color-border-strong));
  }
  .role-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }
  .role-name {
    font: var(--type-h3);
    color: var(--color-text);
  }
  .role-slug {
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
  .lifecycle-badge[data-lifecycle='passed'] {
    color: var(--color-success);
    border-color: var(--color-success);
  }
  .lifecycle-badge[data-lifecycle='failed'],
  .lifecycle-badge[data-lifecycle='error'] {
    color: var(--color-error);
    border-color: var(--color-error);
  }
  .lifecycle-badge[data-lifecycle='interviewing'] {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .role-purpose {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .deploy-badge {
    align-self: flex-start;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.04em;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
  }
  .deploy-badge.deployable {
    color: var(--color-success);
    background: var(--color-bg-inset);
  }
  .deploy-badge.blocked {
    color: var(--color-warn-on-overlay, var(--color-warn));
    background: var(--color-bg-inset);
    text-transform: uppercase;
  }
  .pool-gen {
    font-weight: var(--weight-regular);
    color: var(--color-text-muted);
  }
  .deploy-reason {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0;
  }
  .interview-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-2);
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--color-bg-inset);
    margin: 0;
  }
  .interview-line.empty {
    color: var(--color-text-muted);
    font-style: italic;
    background: transparent;
    padding: 0;
  }
  .interview-line[data-status='failed'] .iv-verdict,
  .interview-line[data-status='error'] .iv-verdict {
    color: var(--color-error-on-overlay);
    font-weight: var(--weight-semibold);
  }
  .interview-line[data-status='passed'] .iv-verdict {
    color: var(--color-success);
    font-weight: var(--weight-semibold);
  }
  .iv-sep {
    color: var(--color-text-muted);
  }
  .iv-model,
  .iv-reason {
    color: var(--color-text-muted);
  }
  .iv-sub {
    color: var(--color-text-muted);
  }
  .iv-transcript {
    color: var(--color-accent);
    text-decoration: none;
  }
  .iv-transcript:hover {
    text-decoration: underline;
  }
  .stale-flag {
    font-size: var(--text-xs);
    color: var(--color-warn-on-overlay, var(--color-warn));
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .run-interview-cta {
    margin: 0;
  }
  .cta-link {
    display: inline-block;
    font-size: var(--text-xs);
    color: var(--color-accent);
    text-decoration: none;
    padding: 0.15rem 0.5rem;
    border: var(--border-width) solid var(--color-accent);
    border-radius: var(--radius-sm);
  }
  .cta-link:hover {
    background: var(--color-surface-overlay);
  }
  .track {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin: var(--space-1) 0 0;
    padding-top: var(--space-2);
    border-top: var(--border-width) solid var(--color-border);
  }
  .track-row {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    font-size: var(--text-xs);
  }
  .track-row dt {
    flex: 0 0 7.5rem;
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .track-row dd {
    margin: 0;
    color: var(--color-text-2);
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.5rem;
    align-items: baseline;
  }
  .track-row.b2 dd {
    color: var(--color-text-muted);
  }
  .sample {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .empty-cell {
    color: var(--color-text-muted);
    font-style: italic;
  }
  .recall-cell {
    display: inline-flex;
    gap: 0.3rem;
    align-items: baseline;
  }

  /* Adjudication queue */
  .adj-runs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .adj-run {
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    background: var(--color-surface-overlay);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .adj-run-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
  }
  .adj-progress {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-left: auto;
  }
  .adj-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .adj-item {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: baseline;
    padding: var(--space-2);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg-inset);
  }
  .adj-item-type {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .adj-item-desc {
    font-size: var(--text-xs);
    color: var(--color-text-2);
    flex: 1 1 12rem;
    min-width: 0;
  }
  .adj-choices {
    display: flex;
    gap: var(--space-3);
    border: 0;
    margin: 0;
    padding: 0;
  }
  .adj-choices label {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
    font-size: var(--text-xs);
    color: var(--color-text-2);
  }
  .adj-submit {
    align-self: flex-start;
    padding: var(--space-1) var(--space-3);
    border: var(--border-width) solid var(--color-accent);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-accent);
    font: var(--type-body-sm);
    cursor: pointer;
  }
  .adj-submit:hover:not(:disabled) {
    background: var(--color-surface-overlay);
  }
  .adj-submit:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .brief-error {
    font: var(--type-body-sm);
    color: var(--color-error);
  }
  .adj-ok {
    font: var(--type-body-sm);
    color: var(--color-success);
  }
</style>
