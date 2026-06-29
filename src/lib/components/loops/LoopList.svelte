<script lang="ts">
  /**
   * LoopList — the grouped grid of LoopCards for the Loops surface (LOOP-ENGINEERING.md). Groups the
   * honest LoopView[] by scope via the pure groupLoops() helper: System loops first, then one block
   * per project. Reusable by the global /loops page AND a future per-project loops tab (LP-3) — it
   * takes the views + an optional project-name map and renders; it owns no fetching. Honest empty
   * state when there are no loops at all (F-008). Svelte 5 runes; design tokens only.
   */
  import type { LoopView } from '$lib/server/loops/read';
  import { groupLoops } from './loop-card-core';
  import LoopCard from './LoopCard.svelte';

  let {
    loops,
    projectNames = {},
    editable = false
  }: { loops: LoopView[]; projectNames?: Record<string, string>; editable?: boolean } = $props();

  const groups = $derived(groupLoops(loops, projectNames));
</script>

{#if groups.length === 0}
  <p class="loop-empty" role="status">
    No recurring loops are defined yet. Atelier's autonomous loops appear here once the orchestrator
    is running and a project has an armed PM.
  </p>
{:else}
  <div class="loop-groups">
    {#each groups as group (group.key)}
      <section class="loop-group" aria-labelledby="lg-{group.key}">
        <h2 class="lg-title" id="lg-{group.key}" data-scope={group.scope}>
          {group.title}
          <span class="lg-count" aria-hidden="true">{group.loops.length}</span>
        </h2>
        <div class="lg-grid">
          {#each group.loops as loop (loop.id)}
            <LoopCard {loop} {editable} />
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}

<style>
  .loop-empty {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    max-width: 60ch;
  }
  .loop-groups {
    display: flex;
    flex-direction: column;
    gap: var(--gap-stack);
  }
  .loop-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .lg-title {
    font: var(--type-h2);
    color: var(--color-text);
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }
  .lg-count {
    font-family: var(--font-mono);
    font-size: var(--text-sm, 0.82rem);
    color: var(--color-text-muted);
    font-weight: var(--weight-regular, 400);
  }
  .lg-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--space-4);
  }
</style>
