<script lang="ts">
  /**
   * /brain — Atelier's view of ITSELF: the derived soul/identity (S4) + a high-level map of the
   * brain's sections. READ-ONLY. The SOUL is computed on-read from live brain rows (loadSoul) and
   * graduates a maturity stage on measurable thresholds — a cold brain reads honestly `nascent`,
   * never a fabricated identity (F-008). The consolidation sections surface recent architectural
   * decisions (a real source) and LINK to the existing /reports · /memory · /atelier surfaces
   * rather than rebuilding them. Four honest states (loading/empty/error/live). Live (§1.2): a
   * brain-row change re-invalidates the loader. Svelte 5 runes, design tokens, a11y.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const soul = $derived(data.soul);
  const decisions = $derived(data.decisions ?? []);
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);

  // Live: any brain-row change re-runs the loader (the soul is compute-on-read; UI-SPEC §1.2).
  $effect(() => {
    const tables = ['concept', 'memory', 'causal_chain', 'session', 'retrieval_outcome', 'decision'];
    const offs = tables.map((t) => stream.onDbChange(t, () => void invalidate('app:brain')));
    return () => offs.forEach((off) => off());
  });

  const STAGE_LABEL: Record<string, string> = {
    nascent: 'nascent',
    developing: 'developing',
    established: 'established'
  };
  const STAGE_BLURB: Record<string, string> = {
    nascent: 'Identity is nascent — it richens automatically as the heartbeat accrues concepts, corrections, and sessions.',
    developing: 'A cross-dimensional identity has begun to settle.',
    established: 'A settled, load-bearing identity.'
  };

  // The experience counts as a labelled grid (all real live counts; F-008).
  const metrics = $derived(
    soul
      ? [
          { label: 'concepts', value: soul.experience.concepts },
          { label: 'corrections', value: soul.experience.corrections },
          { label: 'causal chains', value: soul.experience.causalChains },
          { label: 'sessions', value: soul.experience.sessions },
          { label: 'retrievals', value: soul.experience.retrievalOutcomes },
          { label: 'utilized', value: soul.experience.utilizedOutcomes }
        ]
      : []
  );

  function competenceLabel(c: number | null | undefined): string {
    if (c == null) return 'unknown';
    return `${(c * 100).toFixed(0)}%`;
  }
  function fmtTime(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }
  function shortId(id: string | null): string {
    return id ? id.replace(/^\w+:/, '') : '—';
  }
</script>

<svelte:head>
  <title>Brain — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">cognitive · identity</span>
    <h1 class="title">Brain</h1>
    <p class="lede">
      Atelier's highest-level view of itself — a self-model DERIVED from what the brain has actually
      accumulated (dominant concepts, learned corrections, recall competence, experience volume),
      never an authored persona. Everything here traces to real rows; a cold brain reads honestly as
      nascent.
    </p>
  </header>

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no identity rather than a fabricated one.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else if soul}
    <!-- ── Soul / identity (S4) ─────────────────────────────────────────────── -->
    <div class="card soul">
      <div class="soul-head">
        <span class="stage" data-stage={soul.maturityStage}>{STAGE_LABEL[soul.maturityStage] ?? soul.maturityStage}</span>
        <p class="summary">{soul.summary}</p>
      </div>
      <p class="stage-blurb">{STAGE_BLURB[soul.maturityStage] ?? ''}</p>

      <div class="metrics" aria-label="experience volume">
        {#each metrics as m (m.label)}
          <div class="metric">
            <span class="metric-value mono">{m.value}</span>
            <span class="metric-label">{m.label}</span>
          </div>
        {/each}
        <div class="metric">
          <span class="metric-value mono">{competenceLabel(soul.competence)}</span>
          <span class="metric-label">recall competence</span>
        </div>
      </div>

      <div class="soul-cols">
        <div class="soul-col">
          <span class="eyebrow">knows about</span>
          {#if soul.knowsAbout.length}
            <ul class="chips">
              {#each soul.knowsAbout as label (label)}
                <li class="chip">{label}</li>
              {/each}
            </ul>
          {:else}
            <p class="dim state-body">No dominant concepts yet — they accrue as the brain ingests and consolidates.</p>
          {/if}
        </div>

        <div class="soul-col">
          <span class="eyebrow">learned values</span>
          {#if soul.values.length}
            <ul class="values">
              {#each soul.values as v (v)}
                <li class="value">{v}</li>
              {/each}
            </ul>
          {:else}
            <p class="dim state-body">No learned corrections yet — "what NOT to do" accrues from correction memories.</p>
          {/if}
        </div>
      </div>

      {#if soul.gates.length}
        <div class="gates">
          <span class="eyebrow">
            {#if soul.maturityStage === 'established'}established — gates met{:else}to graduate next{/if}
          </span>
          <ul class="gate-list">
            {#each soul.gates as g (g.gate)}
              <li class="gate" data-pass={g.pass}>
                <span class="gate-mark" aria-hidden="true">{g.pass ? '✓' : '○'}</span>
                <span class="gate-name">{g.gate}</span>
                <span class="gate-detail mono dim">{g.detail}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    <!-- ── Brain sections (consolidation) ───────────────────────────────────── -->
    <div class="card section">
      <div class="section-head">
        <span class="eyebrow">architectural decisions</span>
        <h2 class="section-title">Decisions</h2>
      </div>
      {#if decisions.length}
        <ul class="decisions">
          {#each decisions as d (d.id)}
            <li class="decision" data-status={d.status}>
              <div class="decision-head">
                <span class="decision-title">{d.title}</span>
                <span class="status-tag" data-status={d.status}>{d.status}</span>
                {#if d.project}<span class="mono dim decision-project">{shortId(d.project)}</span>{/if}
                <time class="ts mono dim" datetime={d.createdAt ?? undefined}>{fmtTime(d.createdAt)}</time>
              </div>
              {#if d.rationale}
                <p class="decision-body">{d.rationale}</p>
              {:else if d.context}
                <p class="decision-body dim">{d.context}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="dim state-body">
          No architectural decisions recorded yet — they accrue as PMs and the operator lock direction
          on projects.
        </p>
      {/if}
    </div>

    <div class="card section">
      <div class="section-head">
        <span class="eyebrow">explore the brain</span>
        <h2 class="section-title">Sections</h2>
      </div>
      <nav class="links" aria-label="brain sections">
        <a class="link-card" href="/memory">
          <span class="link-title">Memory &amp; recall</span>
          <span class="link-blurb dim">Explore the living memory scene, search, history, and utilization.</span>
        </a>
        <a class="link-card" href="/reports">
          <span class="link-title">Spend &amp; routing</span>
          <span class="link-blurb dim">Provider usage, cost, and how &amp; why every routing decision was made.</span>
        </a>
        <a class="link-card" href="/atelier">
          <span class="link-title">Global timeline</span>
          <span class="link-blurb dim">Every session's reasoning, actions, and communications on one timeline.</span>
        </a>
        <a class="link-card" href="/cannibalize">
          <span class="link-title">Grow the brain</span>
          <span class="link-blurb dim">Ingest external content — capture, distill, screen, and embed into the brain.</span>
        </a>
      </nav>
    </div>
  {:else}
    <div class="card state">
      <span class="eyebrow">empty</span>
      <p class="state-body">No self-model available yet.</p>
    </div>
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
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    max-width: 72ch;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .dim {
    color: var(--color-text-muted);
    opacity: 0.85;
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .card {
    background: var(--color-surface-card);
    border: 1px solid var(--color-border);
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

  /* ── Soul panel ─────────────────────────────────────────────────────────── */
  .soul {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .soul-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-3, 0.75rem);
    flex-wrap: wrap;
  }
  .stage {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
  }
  .stage[data-stage='developing'] {
    color: var(--color-accent, #8ab0ab);
    border-color: var(--color-accent, #8ab0ab);
  }
  .stage[data-stage='established'] {
    color: var(--color-text-accent, #8ab0ab);
    border-color: var(--color-text-accent, #8ab0ab);
  }
  .summary {
    font: var(--type-body);
    color: var(--color-text);
    flex: 1 1 30ch;
    min-width: 0;
  }
  .stage-blurb {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    margin-top: calc(-1 * var(--space-2));
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: var(--space-2);
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
  }
  .metric-value {
    font-size: 1.25rem;
    color: var(--color-text);
  }
  .metric-label {
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .soul-cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-3, 0.75rem);
  }
  .soul-col {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 0.5rem);
  }
  .chip {
    font-size: 0.75rem;
    padding: 0.15rem 0.55rem;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    background: var(--color-surface-overlay);
  }
  .values {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .value {
    font: var(--type-body-sm);
    color: var(--color-text);
    padding: 0.35rem 0.5rem;
    border-left: 3px solid var(--color-warn, #c8a45c);
    background: var(--color-surface-card);
    border-radius: var(--radius-sm, 6px);
  }
  .gates {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .gate-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .gate {
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
    font: var(--type-body-sm);
    flex-wrap: wrap;
  }
  .gate-mark {
    color: var(--color-text-muted);
  }
  .gate[data-pass='true'] .gate-mark {
    color: var(--color-accent, #8ab0ab);
  }
  .gate-name {
    color: var(--color-text);
  }
  .gate-detail {
    font-size: 0.72rem;
  }

  /* ── Sections ───────────────────────────────────────────────────────────── */
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .section-head {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .section-title {
    font: var(--type-h3, var(--type-h2));
    color: var(--color-text);
  }
  .decisions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .decision {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--color-border);
    border-left-width: 3px;
    border-left-color: var(--color-accent, #8ab0ab);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
  }
  .decision[data-status='rejected'],
  .decision[data-status='superseded'] {
    border-left-color: var(--color-warn, #c8a45c);
  }
  .decision-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2, 0.5rem);
    flex-wrap: wrap;
  }
  .decision-title {
    font: var(--type-body-sm);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text);
  }
  .status-tag {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.02rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }
  .decision-project {
    font-size: 0.68rem;
  }
  .ts {
    font-size: 0.68rem;
    margin-left: auto;
  }
  .decision-body {
    font: var(--type-body-sm);
    color: var(--color-text-2, var(--color-text-muted));
    max-width: 80ch;
  }
  .links {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: var(--space-2, 0.5rem);
  }
  .link-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    text-decoration: none;
    transition:
      background var(--motion-fast) var(--ease-out),
      border-color var(--motion-fast) var(--ease-out);
  }
  .link-card:hover {
    background: var(--color-surface-overlay);
    border-color: var(--color-accent, #8ab0ab);
  }
  .link-card:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 2px;
  }
  .link-title {
    font: var(--type-body-sm);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text-accent, var(--color-text));
  }
  .link-blurb {
    font-size: 0.72rem;
  }
</style>
