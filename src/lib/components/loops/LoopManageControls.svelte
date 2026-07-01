<script lang="ts">
  /**
   * LoopManageControls — the two lightweight, NO-restart, DB-MERGE loop controls the per-loop detail page
   * wires up (operator directive 2026-06-29 · "review/modify/configure"): a phase promote/demote (POSTs the
   * existing `loopPhase` action) and an enabled toggle (POSTs the new `loopEnabled` action). Reversible and
   * honest (F-008/F-029): the manifest is the declared layer — no engine reads it at boot, so both take
   * effect the moment the surface re-reads; the microcopy says so. Promotion to L3 alone does NOT arm the
   * loop — the arm path (LoopControls → pmAutonomous) still enforces the readiness gate. Svelte 5 runes;
   * design tokens only; a11y (state carried by text + aria, not color).
   */
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { DeclaredPhase } from './readiness-core';

  let {
    identifier,
    kind,
    label,
    projectId = null,
    phase,
    enabled
  }: {
    identifier: string;
    kind: string;
    label: string;
    projectId?: string | null;
    /** The DECLARED phase (manifest) — the promote/demote baseline. */
    phase: DeclaredPhase;
    /** The DECLARED enabled flag (manifest). */
    enabled: boolean;
  } = $props();

  const ORDER: DeclaredPhase[] = ['L1', 'L2', 'L3'];
  const idx = $derived(ORDER.indexOf(phase));
  const nextPhase = $derived(idx < 2 ? ORDER[idx + 1] : null);
  const prevPhase = $derived(idx > 0 ? ORDER[idx - 1] : null);

  let busy = $state<string | null>(null); // 'phase' | 'enabled'
  let errorMsg = $state<string | null>(null);

  const submitter = (which: string): SubmitFunction => () => {
    busy = which;
    errorMsg = null;
    return async ({ update, result }) => {
      if (result.type === 'failure') {
        const d = result.data as { loop?: { error?: string } } | undefined;
        errorMsg = d?.loop?.error ?? 'The change was rejected.';
      } else if (result.type === 'error') {
        errorMsg = 'Something went wrong applying the change.';
      }
      await update({ reset: false });
      busy = null;
    };
  };
</script>

<section class="lm" aria-label="loop configuration">
  <div class="lm-row">
    <div class="lm-block">
      <span class="lm-label">maturity phase</span>
      <div class="lm-phase">
        <form method="POST" action="?/loopPhase" use:enhance={submitter('phase')}>
          <input type="hidden" name="identifier" value={identifier} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="label" value={label} />
          <input type="hidden" name="projectId" value={projectId ?? ''} />
          <input type="hidden" name="phase" value={prevPhase ?? ''} />
          <button class="lm-btn" type="submit" disabled={!prevPhase || busy === 'phase'} aria-label="Demote one phase">
            − demote
          </button>
        </form>
        <span class="lm-current" aria-live="polite">{phase}</span>
        <form method="POST" action="?/loopPhase" use:enhance={submitter('phase')}>
          <input type="hidden" name="identifier" value={identifier} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="label" value={label} />
          <input type="hidden" name="projectId" value={projectId ?? ''} />
          <input type="hidden" name="phase" value={nextPhase ?? ''} />
          <button class="lm-btn" type="submit" disabled={!nextPhase || busy === 'phase'} aria-label="Promote one phase">
            promote +
          </button>
        </form>
      </div>
    </div>

    <div class="lm-block">
      <span class="lm-label">enabled</span>
      <form method="POST" action="?/loopEnabled" use:enhance={submitter('enabled')}>
        <input type="hidden" name="identifier" value={identifier} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="label" value={label} />
        <input type="hidden" name="projectId" value={projectId ?? ''} />
        <input type="hidden" name="enabled" value={(!enabled).toString()} />
        <button
          class="lm-toggle"
          type="submit"
          data-on={enabled}
          disabled={busy === 'enabled'}
          aria-pressed={enabled}
          aria-label={enabled ? 'Disable this loop' : 'Enable this loop'}
        >
          <span class="lm-dot" data-on={enabled} aria-hidden="true"></span>
          {enabled ? 'enabled' : 'disabled'}
        </button>
      </form>
    </div>
  </div>

  <p class="lm-note">
    {#if errorMsg}
      <span class="lm-err" role="alert">{errorMsg}</span>
    {:else}
      Applies immediately — no restart. Promotion to L3 does not arm the loop; the arm gate still enforces readiness.
    {/if}
  </p>
</section>

<style>
  .lm {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-top: 1px solid var(--color-border-faint, var(--color-border));
    padding-top: var(--space-3);
  }
  .lm-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    align-items: flex-start;
  }
  .lm-block { display: flex; flex-direction: column; gap: var(--space-2); }
  .lm-label {
    font-size: var(--text-xs, 0.68rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .lm-phase { display: inline-flex; align-items: center; gap: var(--space-2); }
  .lm-phase form { margin: 0; display: inline-flex; }
  .lm-current {
    font-family: var(--font-mono);
    font-size: var(--text-sm, 0.82rem);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text);
    min-width: 1.6rem;
    text-align: center;
  }
  .lm-btn {
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm, 0.82rem);
    cursor: pointer;
  }
  .lm-btn:hover:not(:disabled) { background: var(--color-surface-card); border-color: var(--color-text-muted); }
  .lm-btn:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 2px; }
  .lm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .lm-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm, 0.82rem);
    font-weight: var(--weight-semibold, 600);
    cursor: pointer;
  }
  .lm-toggle:hover:not(:disabled) { border-color: var(--color-text-muted); }
  .lm-toggle:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 2px; }
  .lm-toggle:disabled { opacity: 0.55; cursor: progress; }
  .lm-toggle[data-on='true'] { border-color: var(--color-success); color: var(--color-success); }
  .lm-dot {
    width: 8px; height: 8px; border-radius: var(--radius-pill);
    background: var(--color-neutral); flex: 0 0 auto;
  }
  .lm-dot[data-on='true'] { background: var(--color-success); }
  .lm-note { margin: 0; font-size: var(--text-xs, 0.72rem); color: var(--color-text-muted); }
  .lm-err { color: var(--color-error-on-overlay, var(--color-blocked)); }
</style>
