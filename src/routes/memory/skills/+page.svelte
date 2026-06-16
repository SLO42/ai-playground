<script lang="ts">
  /**
   * /memory/skills — the Learned-skills lens (BL-8 BRAIN-OBSERVABILITY-SPEC §4). READ-ONLY: the
   * graduated-skill list (title, graduation date, success/failure counts, last used, status);
   * expand a skill to view the causal_chain (trigger→outcome) that produced it. All content is
   * already screened + fence-inert (server lister, D-026). Honest "no skills graduated yet" when
   * empty (F-008). Live (§4): a skill row change re-invalidates the loader. Svelte 5, tokens, a11y.
   */
  import { invalidate } from '$app/navigation';
  import { stream } from '$lib/client/stream.svelte';
  import MemoryTabs from '$lib/components/shell/MemoryTabs.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const connected = $derived(data.connected);
  const skills = $derived(data.skills ?? []);
  const chains = $derived(data.chains ?? {});
  const error = $derived('error' in data ? (data.error as string | undefined) : undefined);
  const hasSkills = $derived(skills.length > 0);

  // Expanded skill ids (client-only — no server state).
  let expanded = $state<Set<string>>(new Set());
  function toggle(id: string): void {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  // Live: a skill (or its chain) row change re-runs the loader.
  $effect(() => {
    const off1 = stream.onDbChange('skill', () => void invalidate('app:memory-skills'));
    const off2 = stream.onDbChange('causal_chain', () => void invalidate('app:memory-skills'));
    return () => {
      off1();
      off2();
    };
  });

  function fmtDate(iso: string | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  }
  function rate(s: { successCount: number; failureCount: number }): string {
    const total = s.successCount + s.failureCount;
    if (total === 0) return '—';
    return `${Math.round((s.successCount / total) * 100)}%`;
  }
</script>

<svelte:head>
  <title>Learned skills — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">knowledge · learning</span>
    <h1 class="title">Learned skills</h1>
    <p class="lede">
      Skills the brain has graduated — a trigger→outcome chain that succeeded enough times to
      become reusable. Each shows its success record and the causal chain it came from. Real
      graduated skills only; nothing fabricated.
    </p>
  </header>

  <MemoryTabs />

  {#if !connected}
    <div class="card state">
      <span class="eyebrow">disconnected</span>
      <p class="state-body">
        The database is not connected — showing no skills rather than a fabricated list.
        {#if error}<span class="mono">{error}</span>{:else}Start SurrealDB and reload.{/if}
      </p>
    </div>
  {:else if !hasSkills}
    <div class="card state">
      <span class="eyebrow">empty</span>
      <p class="state-body">
        No skills graduated yet — the brain promotes a learned skill once a trigger→outcome chain
        has succeeded enough times. This stays empty until then; it is not a placeholder.
      </p>
    </div>
  {:else}
    <ul class="skill-list" aria-label="graduated skills">
      {#each skills as s (s.id)}
        {@const isOpen = expanded.has(s.id)}
        {@const chain = s.sourceCausalChain ? chains[s.sourceCausalChain] : undefined}
        <li class="skill" data-status={s.status}>
          <div class="skill-head">
            <div class="skill-title">
              <span class="name">{s.name || '(unnamed skill)'}</span>
              {#if s.status !== 'active'}<span class="status-flag">{s.status}</span>{/if}
              {#if s.displayStatus !== 'clean'}
                <span class="screen-flag" data-status={s.displayStatus} title="screened on display (D-026)">
                  {s.displayStatus}
                </span>
              {/if}
            </div>
            <div class="counts">
              <span class="count ok" title="successes">{s.successCount}✓</span>
              <span class="count fail" title="failures">{s.failureCount}✗</span>
              <span class="count rate mono" title="success rate">{rate(s)}</span>
            </div>
          </div>

          {#if s.description}<p class="desc">{s.description}</p>{/if}

          <div class="skill-foot">
            <span class="meta mono">graduated {fmtDate(s.graduatedAt)}</span>
            <span class="meta mono">
              {#if s.lastUsed}last used {fmtDate(s.lastUsed)}{:else}not yet used{/if}
            </span>
            {#if s.sourceCausalChain}
              <button
                type="button"
                class="expand"
                aria-expanded={isOpen}
                aria-controls={`chain-${s.id}`}
                onclick={() => toggle(s.id)}
              >
                {isOpen ? 'hide' : 'show'} source chain
              </button>
            {/if}
          </div>

          {#if isOpen}
            <div class="chain" id={`chain-${s.id}`}>
              {#if chain}
                <div class="chain-row">
                  <span class="chain-label">trigger</span>
                  <p class="chain-body">{chain.trigger || '—'}</p>
                </div>
                <div class="chain-row">
                  <span class="chain-label">outcome</span>
                  <p class="chain-body">{chain.outcome || '—'}</p>
                </div>
                <div class="chain-meta">
                  <span class="kind-tag">{chain.kind}</span>
                  <span class="mono" data-ok={chain.success}>{chain.success ? 'succeeded' : 'failed'}</span>
                  <span class="mono">confidence {chain.confidence.toFixed(2)}</span>
                </div>
              {:else}
                <p class="chain-body dim">Source chain referenced but no longer available.</p>
              {/if}
            </div>
          {/if}

          {#if s.steps.length}
            <details class="steps">
              <summary>steps ({s.steps.length})</summary>
              <ol>
                {#each s.steps as step, i (i)}<li>{step}</li>{/each}
              </ol>
            </details>
          {/if}
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
  .skill-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .skill {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
  }
  .skill[data-status='archived'],
  .skill[data-status='superseded'] {
    opacity: 0.6;
  }
  .skill-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .skill-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .name {
    font: var(--type-body);
    color: var(--color-text);
    font-weight: 600;
  }
  .status-flag {
    font-size: 0.62rem;
    text-transform: uppercase;
    color: var(--color-warn, #c8a45c);
  }
  .screen-flag {
    font-size: 0.62rem;
    text-transform: uppercase;
    padding: 0.02rem 0.35rem;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-warn, #c8a45c);
    border: 1px solid var(--color-warn, #c8a45c);
  }
  .screen-flag[data-status='quarantined'] {
    color: var(--color-danger, #d08383);
    border-color: var(--color-danger, #d08383);
  }
  .counts {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.74rem;
  }
  .count.ok {
    color: var(--color-success, #7fae7f);
  }
  .count.fail {
    color: var(--color-text-muted);
  }
  .count.rate {
    color: var(--color-text-2);
  }
  .desc {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
  }
  .skill-foot {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    flex-wrap: wrap;
  }
  .meta {
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .expand {
    margin-left: auto;
    font: var(--type-body-sm);
    font-size: 0.72rem;
    color: var(--color-accent, #8ab0ab);
    background: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }
  .expand:hover {
    border-color: var(--color-accent, #8ab0ab);
  }
  .expand:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 1px;
  }
  .chain {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--color-border-subtle, var(--color-border));
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-overlay);
  }
  .chain-row {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .chain-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .chain-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0;
  }
  .chain-meta {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.68rem;
    color: var(--color-text-muted);
  }
  .chain-meta [data-ok='true'] {
    color: var(--color-success, #7fae7f);
  }
  .chain-meta [data-ok='false'] {
    color: var(--color-warn, #c8a45c);
  }
  .kind-tag {
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm, 6px);
    background: var(--color-surface-card);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }
  .steps {
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .steps summary {
    cursor: pointer;
    font-size: 0.72rem;
    color: var(--color-text-muted);
  }
  .steps summary:focus-visible {
    outline: 2px solid var(--color-accent, #8ab0ab);
    outline-offset: 2px;
  }
  .steps ol {
    margin: 0.3rem 0 0;
    padding-left: 1.4rem;
  }
  .steps li {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
