<script lang="ts">
  /**
   * LoopDeclaredCard — a DECLARED loop with no live counterpart (reconcile status 'declared-not-running').
   * Honest (F-008): it is NOT styled as a running loop — it states plainly that the loop is declared in the
   * manifest but not currently running, and lets the operator review/configure its readiness checklist. For
   * a pm-autonomous declared loop it also offers the readiness-GATED arm control (the natural place to arm a
   * loop that is not yet running). Svelte 5 runes; design tokens; a11y.
   */
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { ReconciledLoop } from '$lib/server/loops/manifest';
  import { phaseMeta } from './loop-card-core';
  import LoopReadiness from './LoopReadiness.svelte';

  let { entry }: { entry: ReconciledLoop } = $props();

  const phase = $derived(phaseMeta((entry.manifest?.phase ?? 'L1') as 'L1' | 'L2' | 'L3'));
  const readiness = $derived(entry.readiness);
  const override = $derived(entry.manifest?.override === true);
  const armReady = $derived(override || readiness.green);
  const canArm = $derived(entry.kind === 'pm-autonomous' && entry.projectId != null);

  let wantOverride = $state(false);
  let overrideReason = $state('');
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);
  let blockedMissing = $state<string[]>([]);

  const submitter: SubmitFunction = () => {
    busy = true;
    errorMsg = null;
    blockedMissing = [];
    return async ({ update, result }) => {
      if (result.type === 'failure') {
        const d = result.data as { pm?: { error?: string; missing?: string[] } } | undefined;
        errorMsg = d?.pm?.error ?? 'The change was rejected.';
        blockedMissing = Array.isArray(d?.pm?.missing) ? (d!.pm!.missing as string[]) : [];
      } else if (result.type === 'error') {
        errorMsg = 'Something went wrong arming the loop.';
      } else {
        wantOverride = false;
      }
      await update({ reset: false });
      busy = false;
    };
  };
</script>

<article class="dc" aria-labelledby="dc-name-{entry.identifier}">
  <header class="dc-head">
    <div class="dc-titles">
      <h3 class="dc-name" id="dc-name-{entry.identifier}">{entry.label}</h3>
      <span class="dc-id mono">{entry.identifier}</span>
    </div>
    <span class="dc-phase" title={phase.title} aria-label="maturity {phase.title}">{phase.text}</span>
  </header>

  <p class="dc-state" role="status">Declared in the manifest · not currently running.</p>

  <LoopReadiness
    identifier={entry.identifier}
    kind={entry.kind}
    label={entry.label}
    projectId={entry.projectId}
    manifest={entry.manifest}
  />

  {#if canArm}
    <form class="dc-arm" method="POST" action="?/pmAutonomous" use:enhance={submitter}>
      <input type="hidden" name="projectId" value={entry.projectId ?? ''} />
      <input type="hidden" name="armed" value="true" />
      <input type="hidden" name="override" value={wantOverride ? 'true' : 'false'} />
      {#if wantOverride}<input type="hidden" name="overrideReason" value={overrideReason} />{/if}

      {#if !armReady}
        <div class="dc-gate" role="group" aria-label="Readiness gate">
          <p class="dc-gate-head">Not ready for autonomy — {readiness.missing.length} item{readiness.missing.length === 1 ? '' : 's'} left.</p>
          <label class="dc-override">
            <input type="checkbox" bind:checked={wantOverride} />
            <span>Override the gate (arm anyway — recorded)</span>
          </label>
          {#if wantOverride}
            <input
              class="dc-input"
              type="text"
              bind:value={overrideReason}
              placeholder="Reason for the override (recorded)"
              aria-label="override reason"
            />
          {/if}
        </div>
      {/if}

      <button class="dc-btn" type="submit" disabled={busy || (!armReady && !wantOverride)}>
        {busy ? 'Arming…' : wantOverride ? 'Override & arm' : 'Arm the autonomous drive'}
      </button>
      <p class="dc-note">
        {#if errorMsg}
          <span class="dc-err" role="alert">{errorMsg}</span>
          {#if blockedMissing.length}<span class="dc-err"> Missing: {blockedMissing.join(', ')}.</span>{/if}
        {:else}
          Arming requires the readiness checklist green, or an explicit override.
        {/if}
      </p>
    </form>
  {/if}
</article>

<style>
  .dc {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--color-surface-card);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--pad-card);
  }
  .dc-head { display: flex; align-items: flex-start; gap: var(--space-3); }
  .dc-titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .dc-name { font: var(--type-h3); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; }
  .dc-id { font-size: var(--text-xs, 0.7rem); color: var(--color-text-muted); }
  .mono { font-family: var(--font-mono); }
  .dc-phase {
    flex: 0 0 auto;
    font-size: var(--text-xs, 0.7rem);
    font-weight: var(--weight-semibold, 600);
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
  }
  .dc-state { margin: 0; font-size: var(--text-sm, 0.82rem); color: var(--color-text-muted); }

  .dc-arm { display: flex; flex-direction: column; gap: var(--space-2); border-top: 1px solid var(--color-border-faint, var(--color-border)); padding-top: var(--space-3); }
  .dc-gate {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--color-warn, var(--color-border));
    border-radius: var(--radius-sm);
    background: var(--color-warn-bg, var(--color-surface-overlay));
  }
  .dc-gate-head { margin: 0; font-size: var(--text-sm, 0.82rem); font-weight: var(--weight-semibold, 600); color: var(--color-text); }
  .dc-override { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs, 0.74rem); color: var(--color-text-2); cursor: pointer; }
  .dc-input {
    width: 100%;
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm, 0.82rem);
  }
  .dc-input:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 1px; }
  .dc-btn {
    align-self: flex-start;
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm, 0.82rem);
    font-weight: var(--weight-semibold, 600);
    cursor: pointer;
  }
  .dc-btn:hover:not(:disabled) { background: var(--color-surface-card); border-color: var(--color-text-muted); }
  .dc-btn:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 2px; }
  .dc-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .dc-note { margin: 0; font-size: var(--text-xs, 0.72rem); color: var(--color-text-muted); }
  .dc-err { color: var(--color-error-on-overlay, var(--color-blocked)); }
</style>
