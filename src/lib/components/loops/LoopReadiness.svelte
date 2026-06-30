<script lang="ts">
  /**
   * LoopReadiness — the per-loop Loop Design Checklist, reviewable + configurable in-UI (LOOP-ENGINEERING
   * step 5; operator directive 2026-06-29). Renders the 9 readiness items as toggle rows the operator
   * ticks; each toggle DECLARES the loop on first use (idempotent upsert) then sets the item via the
   * `loopChecklist` action. Shows the honest green/missing summary so the operator sees exactly what the
   * arm gate will require. NO restart (the gate reads the manifest live). Honest (F-008): an undeclared
   * loop shows every item unchecked — never assumed-ready. Svelte 5 runes; design tokens; a11y (each
   * toggle is a button with aria-pressed; the status text carries meaning, not color alone).
   */
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { LoopManifestRow } from '$lib/server/loops/manifest';
  import { READINESS_CHECKLIST, evaluateReadiness } from './readiness-core';

  // A minimal loop identity (works for a running LoopView OR a declared-only manifest row).
  let {
    identifier,
    kind,
    label,
    projectId = null,
    manifest
  }: {
    identifier: string;
    kind: string;
    label: string;
    projectId?: string | null;
    manifest: LoopManifestRow | null;
  } = $props();

  const checklist = $derived(manifest?.checklist ?? {});
  const readiness = $derived(evaluateReadiness(checklist));
  const overridden = $derived(manifest?.override === true);

  let busy = $state<string | null>(null); // the itemId currently saving
  let errorMsg = $state<string | null>(null);

  const submitter = (itemId: string): SubmitFunction => () => {
    busy = itemId;
    errorMsg = null;
    return async ({ update, result }) => {
      if (result.type === 'failure') {
        const d = result.data as { loop?: { error?: string } } | undefined;
        errorMsg = d?.loop?.error ?? 'The change was rejected.';
      } else if (result.type === 'error') {
        errorMsg = 'Something went wrong saving the checklist.';
      }
      await update({ reset: false });
      busy = null;
    };
  };
</script>

<section class="lr" aria-label="readiness checklist for {label}">
  <div class="lr-head">
    <span class="lr-title">readiness</span>
    <span
      class="lr-summary"
      data-tone={readiness.green ? 'done' : overridden ? 'warning' : 'idle'}
    >
      {#if readiness.green}
        ✓ ready ({readiness.checked}/{readiness.total})
      {:else if overridden}
        overridden · {readiness.checked}/{readiness.total} checked
      {:else}
        {readiness.checked}/{readiness.total} checked
      {/if}
    </span>
  </div>

  <ul class="lr-items">
    {#each READINESS_CHECKLIST as item (item.id)}
      {@const on = checklist[item.id] === true}
      <li class="lr-item">
        <form method="POST" action="?/loopChecklist" use:enhance={submitter(item.id)}>
          <input type="hidden" name="identifier" value={identifier} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="label" value={label} />
          <input type="hidden" name="projectId" value={projectId ?? ''} />
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="checked" value={(!on).toString()} />
          <button
            type="submit"
            class="lr-toggle"
            data-on={on}
            disabled={busy === item.id}
            aria-pressed={on}
          >
            <span class="lr-box" aria-hidden="true">{on ? '✓' : ''}</span>
            <span class="lr-label">
              <span class="lr-item-name">{item.label}</span>
              <span class="lr-item-hint">{item.hint}</span>
            </span>
          </button>
        </form>
      </li>
    {/each}
  </ul>

  {#if errorMsg}
    <p class="lr-err" role="alert">{errorMsg}</p>
  {:else if !readiness.green && !overridden}
    <p class="lr-note">
      All items must be checked before this loop can arm for autonomy — or the operator can override the
      gate when arming.
    </p>
  {/if}
</section>

<style>
  .lr {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-top: 1px solid var(--color-border-faint, var(--color-border));
    padding-top: var(--space-3);
  }
  .lr-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .lr-title {
    font-size: var(--text-xs, 0.68rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .lr-summary {
    font-size: var(--text-xs, 0.72rem);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text-muted);
  }
  .lr-summary[data-tone='done'] { color: var(--color-success); }
  .lr-summary[data-tone='warning'] { color: var(--color-warn); }

  .lr-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lr-item form { margin: 0; }
  .lr-toggle {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-1);
    cursor: pointer;
    color: var(--color-text-2);
  }
  .lr-toggle:hover:not(:disabled) { background: var(--color-surface-overlay); }
  .lr-toggle:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 1px; }
  .lr-toggle:disabled { opacity: 0.55; cursor: progress; }
  .lr-box {
    flex: 0 0 auto;
    width: 1rem;
    height: 1rem;
    margin-top: 1px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    color: var(--color-success);
    background: var(--color-surface-overlay);
  }
  .lr-toggle[data-on='true'] .lr-box {
    border-color: var(--color-success);
    background: var(--color-success-bg, var(--color-surface-overlay));
  }
  .lr-label { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .lr-item-name {
    font-size: var(--text-sm, 0.82rem);
    color: var(--color-text);
  }
  .lr-toggle[data-on='true'] .lr-item-name { color: var(--color-text-muted); }
  .lr-item-hint {
    font-size: var(--text-xs, 0.7rem);
    color: var(--color-text-muted);
  }
  .lr-note {
    margin: 0;
    font-size: var(--text-xs, 0.72rem);
    color: var(--color-text-muted);
  }
  .lr-err {
    margin: 0;
    font-size: var(--text-xs, 0.72rem);
    color: var(--color-error-on-overlay, var(--color-blocked));
  }
</style>
