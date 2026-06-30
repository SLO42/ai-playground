<script lang="ts">
  /**
   * LoopControls — the in-UI, kind-aware EDIT affordance for the Loops surface (Loops Phase 2;
   * LOOP-ENGINEERING.md). Renders ONLY for the two NO-restart, DB-MERGE loops:
   *   • pm-cadence    → a cadence editor (cron + optional duration offset) → POST ?/pmSchedule
   *   • pm-autonomous → a pause/kill (disarm) toggle, gated behind a lightweight confirm → POST ?/pmAutonomous
   * Every other kind (orchestrator / memory-review) renders nothing here — the orchestrator's mode lives
   * behind the D-010 confirm ceremony on /settings, not here.
   *
   * The form POSTs to the CURRENT page's action (`?/pmSchedule` / `?/pmAutonomous`) and carries a hidden
   * projectId — so the SAME component works on the global /loops route (action reads projectId from the
   * form) and the per-project tab (action reads it from params; the hidden field is ignored). On success
   * `use:enhance` re-runs the loader (invalidateAll) so the card re-derives the new cadence/armed state.
   *
   * HONEST (F-008/F-029): these are DB-MERGE writes the orchestrator/trigger engine reads live — NO
   * restart needed, and the microcopy says so. Validation is authoritative at the route boundary
   * (parseCron/parseDurationMs); the client check here only gives instant feedback. Svelte 5 runes only;
   * design tokens only; components < 200 lines.
   */
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { LoopView } from '$lib/server/loops/read';
  import type { ReadinessResult } from './readiness-core';

  // `readiness` + `override` (pm-autonomous only) drive the ARM gate UI: arming a not-ready, non-overridden
  // loop is blocked server-side; here we pre-surface the gate so the operator sees what's required and can
  // record an explicit override. Disarm (kill switch) is never gated.
  let {
    loop,
    readiness = null,
    override = false
  }: { loop: LoopView; readiness?: ReadinessResult | null; override?: boolean } = $props();

  // Whether arming is permitted without an override (the gate is satisfied).
  const armReady = $derived(override === true || readiness == null || readiness.green === true);

  // Operator override controls (only used when arming a not-ready loop).
  let wantOverride = $state(false);
  let overrideReason = $state('');
  // Missing items returned by a blocked arm attempt (server is authoritative).
  let blockedMissing = $state<string[]>([]);

  // ── pm-cadence editor state ──────────────────────────────────────────────────────────────────────
  // Seed the editable fields ONCE from the loop's current values (untrack: capturing the initial value
  // is intentional — these become user-editable inputs; a live re-derive must NOT clobber in-progress
  // edits, and the card is keyed by stable loop.id so it never remounts).
  let cron = $state(untrack(() => loop.cadenceCron ?? ''));
  let offset = $state(untrack(() => loop.cadenceOffset ?? ''));
  let busy = $state(false);
  let errorMsg = $state<string | null>(null);

  // Client-side feedback ONLY (the server's parseCron/parseDurationMs is authoritative): an empty cron
  // clears the schedule (valid); a present one must be 5 whitespace-separated fields; an offset is valid
  // when empty or a duration like 5m / 90s / 1h30m. Never blocks a value the server would accept.
  const cronOk = $derived(cron.trim() === '' || cron.trim().split(/\s+/).length === 5);
  const offsetOk = $derived(offset.trim() === '' || /^(\d+(ms|s|m|h|d|w))+$/.test(offset.trim()));
  const cadenceValid = $derived(cronOk && offsetOk);

  // ── pm-autonomous toggle state ───────────────────────────────────────────────────────────────────
  let confirming = $state(false);

  const submitter: SubmitFunction = () => {
    busy = true;
    errorMsg = null;
    blockedMissing = [];
    return async ({ update, result }) => {
      if (result.type === 'failure') {
        const d = result.data as { pm?: { error?: string; missing?: string[] } } | undefined;
        errorMsg = d?.pm?.error ?? 'The change was rejected.';
        // A blocked arm surfaces the missing Design-Checklist items (server-authoritative).
        blockedMissing = Array.isArray(d?.pm?.missing) ? (d!.pm!.missing as string[]) : [];
      } else if (result.type === 'error') {
        errorMsg = 'Something went wrong applying the change.';
      } else {
        confirming = false;
        wantOverride = false;
      }
      // Re-run the loader either way so the cards reflect the live truth (a disarmed loop's card vanishes).
      await update({ reset: false });
      busy = false;
    };
  };
</script>

{#if loop.kind === 'pm-cadence'}
  <form class="lc-controls" method="POST" action="?/pmSchedule" use:enhance={submitter}>
    <input type="hidden" name="projectId" value={loop.projectId ?? ''} />
    <div class="lc-fields">
      <label class="lc-field">
        <span>cadence (cron)</span>
        <input
          class="lc-input mono"
          type="text"
          name="cadence"
          bind:value={cron}
          placeholder="0 9 * * 1-5"
          aria-invalid={!cronOk}
          aria-describedby="lc-cad-note-{loop.id}"
        />
      </label>
      <label class="lc-field">
        <span>offset (stagger)</span>
        <input
          class="lc-input mono"
          type="text"
          name="cadenceOffset"
          bind:value={offset}
          placeholder="5m"
          aria-invalid={!offsetOk}
          aria-describedby="lc-cad-note-{loop.id}"
        />
      </label>
      <button class="lc-btn" type="submit" disabled={busy || !cadenceValid}>
        {busy ? 'Saving…' : 'Save cadence'}
      </button>
    </div>
    <p class="lc-note" id="lc-cad-note-{loop.id}">
      {#if !cadenceValid}
        <span class="lc-err">{!cronOk ? 'Cron needs 5 fields (min hour day month weekday).' : 'Offset must be a duration like 5m, 90s or 1h30m.'}</span>
      {:else if errorMsg}
        <span class="lc-err" role="alert">{errorMsg}</span>
      {:else}
        Applies immediately — no restart needed. Empty cron clears the schedule.
      {/if}
    </p>
  </form>
{:else if loop.kind === 'pm-autonomous'}
  <form class="lc-controls" method="POST" action="?/pmAutonomous" use:enhance={submitter}>
    <input type="hidden" name="projectId" value={loop.projectId ?? ''} />
    {#if loop.armed !== false}
      <!-- Pause/kill: operationally sensitive (halts real unsupervised work) → lightweight confirm. -->
      <input type="hidden" name="armed" value="false" />
      {#if confirming}
        <div class="lc-confirm" role="group" aria-label="Confirm pause">
          <span class="lc-confirm-q">Pause the autonomous drive? This halts unsupervised work.</span>
          <div class="lc-confirm-row">
            <button class="lc-btn warn" type="submit" disabled={busy} aria-label="Confirm — pause the autonomous drive">
              {busy ? 'Pausing…' : 'Pause now'}
            </button>
            <button class="lc-btn ghost" type="button" disabled={busy} onclick={() => (confirming = false)}>Cancel</button>
          </div>
        </div>
      {:else}
        <button class="lc-btn warn" type="button" disabled={busy} aria-pressed="true" onclick={() => (confirming = true)}>
          Pause the autonomous drive
        </button>
      {/if}
    {:else}
      <!-- ARM — readiness-gated (LOOP-ENGINEERING step 5). The gate is server-authoritative; here we
           pre-surface it: a not-ready loop needs the checklist green OR an explicit operator override. -->
      <input type="hidden" name="armed" value="true" />
      <input type="hidden" name="override" value={wantOverride ? 'true' : 'false'} />
      {#if wantOverride}
        <input type="hidden" name="overrideReason" value={overrideReason} />
      {/if}

      {#if !armReady}
        <div class="lc-gate" role="group" aria-label="Readiness gate">
          <p class="lc-gate-head">
            Not ready for autonomy{readiness ? ` — ${readiness.missing.length} item${readiness.missing.length === 1 ? '' : 's'} left` : ''}.
          </p>
          {#if readiness && readiness.missing.length}
            <ul class="lc-gate-list">
              {#each readiness.missing as m (m.id)}<li>{m.label}</li>{/each}
            </ul>
          {/if}
          <label class="lc-override">
            <input type="checkbox" bind:checked={wantOverride} />
            <span>Override the gate (arm anyway — recorded)</span>
          </label>
          {#if wantOverride}
            <input
              class="lc-input"
              type="text"
              bind:value={overrideReason}
              placeholder="Reason for the override (recorded in the run log)"
              aria-label="override reason"
            />
          {/if}
        </div>
      {/if}

      <button class="lc-btn" type="submit" disabled={busy || (!armReady && !wantOverride)} aria-pressed="false">
        {busy ? 'Arming…' : wantOverride ? 'Override & arm' : 'Arm the autonomous drive'}
      </button>
    {/if}
    <p class="lc-note">
      {#if errorMsg}
        <span class="lc-err" role="alert">{errorMsg}</span>
        {#if blockedMissing.length}
          <span class="lc-gate-missing"> Missing: {blockedMissing.join(', ')}.</span>
        {/if}
      {:else}
        Applies immediately — no restart needed. Disarming halts the drive; the publish gate stays operator-gated.
      {/if}
    </p>
  </form>
{/if}

<style>
  .lc-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-top: 1px solid var(--color-border-faint, var(--color-border));
    padding-top: var(--space-3);
  }
  .lc-fields {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-2);
  }
  .lc-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 7rem;
    min-width: 0;
  }
  .lc-field span {
    font-size: var(--text-xs, 0.68rem);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .lc-input {
    width: 100%;
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-sm, 0.82rem);
  }
  .lc-input:focus-visible {
    outline: 2px solid var(--color-text-link);
    outline-offset: 1px;
    border-color: var(--color-text-link);
  }
  .lc-input[aria-invalid='true'] {
    border-color: var(--color-error, var(--color-blocked));
  }
  .mono { font-family: var(--font-mono); }

  .lc-btn {
    flex: 0 0 auto;
    background: var(--color-surface-overlay);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm, 0.82rem);
    font-weight: var(--weight-semibold, 600);
    cursor: pointer;
  }
  .lc-btn:hover:not(:disabled) { background: var(--color-surface-card); border-color: var(--color-text-muted); }
  .lc-btn:focus-visible { outline: 2px solid var(--color-text-link); outline-offset: 2px; }
  .lc-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .lc-btn.warn { color: var(--color-error-on-overlay, var(--color-blocked)); border-color: var(--color-blocked); }
  .lc-btn.ghost { background: none; color: var(--color-text-muted); }

  .lc-confirm { display: flex; flex-direction: column; gap: var(--space-2); }
  .lc-confirm-q { font-size: var(--text-sm, 0.82rem); color: var(--color-text); }
  .lc-confirm-row { display: flex; gap: var(--space-2); }

  .lc-note {
    margin: 0;
    font-size: var(--text-xs, 0.72rem);
    color: var(--color-text-muted);
  }
  .lc-err { color: var(--color-error-on-overlay, var(--color-blocked)); }
  .lc-gate-missing { color: var(--color-error-on-overlay, var(--color-blocked)); }

  .lc-gate {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--color-warn, var(--color-border));
    border-radius: var(--radius-sm);
    background: var(--color-warn-bg, var(--color-surface-overlay));
  }
  .lc-gate-head {
    margin: 0;
    font-size: var(--text-sm, 0.82rem);
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text);
  }
  .lc-gate-list {
    margin: 0;
    padding-left: 1.1rem;
    font-size: var(--text-xs, 0.72rem);
    color: var(--color-text-2);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .lc-override {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs, 0.74rem);
    color: var(--color-text-2);
    cursor: pointer;
  }
</style>
