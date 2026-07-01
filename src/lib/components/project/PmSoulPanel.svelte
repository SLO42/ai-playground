<script lang="ts">
  /**
   * PM SOUL — the per-PM identity panel for the project command-center (per-PM souls). It renders
   * the PROJECT-scoped derived self-model (maturity stage, dominant concepts, learned values, recall
   * competence, experience volume, next-gate evidence) + the PM's graduation timeline — mirroring
   * /brain's Atelier soul, but scoped to THIS project's slice of the brain.
   *
   * READ-ONLY + HONEST (F-008): every field is a projection of real project rows. A cold/new project
   * derives an honest `nascent` identity (empty knows-about/values), never a fabricated maturity;
   * DB-down / read-failure shows an honest unavailable state. The project-worded copy is composed
   * from the derived stage — the model's Atelier-worded `summary` string is deliberately NOT shown.
   * Svelte 5 runes, design tokens, a11y. F-013: graduation times are ISO strings, rendered '—' when
   * absent.
   */
  import type { SoulModel } from '$lib/server/memory/soul';
  import type { GraduationRow } from '$lib/server/memory/soul-graduation';

  let {
    connected,
    pmSoul,
    graduations
  }: { connected: boolean; pmSoul: SoulModel | null; graduations: GraduationRow[] } = $props();

  const STAGE_BLURB: Record<string, string> = {
    nascent:
      "The PM's identity is nascent — it richens automatically as this project accrues concepts, corrections, and sessions.",
    developing: "A cross-dimensional identity has begun to settle for this project's PM.",
    established: "A settled, load-bearing identity for this project's PM."
  };

  const metrics = $derived(
    pmSoul
      ? [
          { label: 'concepts', value: pmSoul.experience.concepts },
          { label: 'corrections', value: pmSoul.experience.corrections },
          { label: 'causal chains', value: pmSoul.experience.causalChains },
          { label: 'sessions', value: pmSoul.experience.sessions },
          { label: 'retrievals', value: pmSoul.experience.retrievalOutcomes },
          { label: 'utilized', value: pmSoul.experience.utilizedOutcomes }
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
</script>

<div class="card soul">
  <div class="soul-head">
    <span class="eyebrow">pm · identity</span>
    <h2 class="section-title">PM soul</h2>
  </div>

  {#if !connected}
    <p class="dim state-body">
      The database is not connected — showing no PM identity rather than a fabricated one.
    </p>
  {:else if !pmSoul}
    <p class="dim state-body">
      The PM identity is unavailable right now — the self-model could not be read. Reload to retry.
    </p>
  {:else}
    <div class="identity">
      <span class="stage" data-stage={pmSoul.maturityStage}>{pmSoul.maturityStage}</span>
      <p class="stage-blurb">{STAGE_BLURB[pmSoul.maturityStage] ?? ''}</p>
    </div>

    <div class="metrics" aria-label="experience volume">
      {#each metrics as m (m.label)}
        <div class="metric">
          <span class="metric-value mono">{m.value}</span>
          <span class="metric-label">{m.label}</span>
        </div>
      {/each}
      <div class="metric">
        <span class="metric-value mono">{competenceLabel(pmSoul.competence)}</span>
        <span class="metric-label">recall competence</span>
      </div>
    </div>

    <div class="soul-cols">
      <div class="soul-col">
        <span class="eyebrow">knows about</span>
        {#if pmSoul.knowsAbout.length}
          <ul class="chips">
            {#each pmSoul.knowsAbout as label (label)}
              <li class="chip">{label}</li>
            {/each}
          </ul>
        {:else}
          <p class="dim state-body">No dominant concepts yet — they accrue as this project's brain grows.</p>
        {/if}
      </div>

      <div class="soul-col">
        <span class="eyebrow">learned values</span>
        {#if pmSoul.values.length}
          <ul class="values">
            {#each pmSoul.values as v (v)}
              <li class="value">{v}</li>
            {/each}
          </ul>
        {:else}
          <p class="dim state-body">No learned corrections yet — "what NOT to do" accrues from corrections.</p>
        {/if}
      </div>
    </div>

    {#if pmSoul.gates.length}
      <div class="gates">
        <span class="eyebrow">
          {#if pmSoul.maturityStage === 'established'}established — gates met{:else}to graduate next{/if}
        </span>
        <ul class="gate-list">
          {#each pmSoul.gates as g (g.gate)}
            <li class="gate" data-pass={g.pass}>
              <span class="gate-mark" aria-hidden="true">{g.pass ? '✓' : '○'}</span>
              <span class="gate-name">{g.gate}</span>
              <span class="gate-detail mono dim">{g.detail}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Graduation timeline (per-PM identity provenance) -->
    <div class="timeline-block">
      <span class="eyebrow">identity provenance · graduation history</span>
      {#if graduations.length}
        <ol class="timeline">
          {#each graduations as g (g.id)}
            <li class="grad">
              <div class="grad-head">
                <span class="transition">
                  <span class="from">{g.fromStage}</span>
                  <span class="arrow" aria-hidden="true">→</span>
                  <span class="to" data-stage={g.toStage}>{g.toStage}</span>
                </span>
                <time class="ts mono dim" datetime={g.graduatedAt ?? undefined}>{fmtTime(g.graduatedAt)}</time>
              </div>
              <div class="snapshot dim mono" aria-label="metric snapshot at graduation">
                <span>{g.concepts} concepts</span>
                <span>{g.corrections} corrections</span>
                <span>{g.causalChains} causal chains</span>
                <span>{g.sessions} sessions</span>
                <span>competence {competenceLabel(g.competence)}</span>
              </div>
            </li>
          {/each}
        </ol>
      {:else}
        <p class="dim state-body">
          No graduations yet — the PM identity is <strong>{pmSoul.maturityStage}</strong>. The first
          crossing is recorded automatically as this project's brain accrues concepts, corrections,
          and sessions.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card {
    background: var(--color-surface-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .soul-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .section-title {
    font: var(--type-h3, var(--type-h2));
    color: var(--color-text);
  }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: lowercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .dim {
    color: var(--color-text-muted);
    opacity: 0.85;
  }
  .state-body {
    font: var(--type-body-sm);
    color: var(--color-text-2, var(--color-text-muted));
  }
  .identity {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .stage {
    align-self: flex-start;
    font-size: 0.75rem;
    font-weight: var(--weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }
  .stage[data-stage='developing'] {
    color: var(--color-text-accent, var(--color-accent));
    border-color: var(--color-accent);
  }
  .stage[data-stage='established'] {
    color: var(--color-accent);
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  }
  .stage-blurb {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    max-width: 72ch;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
    gap: var(--space-2, 0.5rem);
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: var(--space-2, 0.5rem);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 8px);
    background: var(--color-surface-overlay, transparent);
  }
  .metric-value {
    font-size: 1.1rem;
    color: var(--color-text);
  }
  .metric-label {
    font-size: 0.68rem;
    color: var(--color-text-muted);
    text-transform: lowercase;
  }
  .soul-cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-3, 0.75rem);
  }
  .soul-col {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .chip {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    color: var(--color-text);
    background: var(--color-surface-overlay, transparent);
  }
  .values {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .value {
    font: var(--type-body-sm);
    color: var(--color-text);
    border-left: 2px solid var(--color-border);
    padding-left: 0.5rem;
  }
  .gates,
  .timeline-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 0.25rem);
  }
  .gate-list,
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .gate {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font: var(--type-body-sm);
  }
  .gate[data-pass='true'] .gate-mark {
    color: var(--color-accent);
  }
  .gate-mark {
    color: var(--color-text-muted);
  }
  .gate-name {
    color: var(--color-text);
  }
  .gate-detail {
    margin-left: auto;
  }
  .grad {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: var(--space-2, 0.5rem);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 8px);
  }
  .grad-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .transition {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    font-weight: var(--weight-semibold, 600);
  }
  .to[data-stage='established'],
  .to[data-stage='developing'] {
    color: var(--color-text-accent, var(--color-accent));
  }
  .snapshot {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    font-size: 0.7rem;
  }
</style>
