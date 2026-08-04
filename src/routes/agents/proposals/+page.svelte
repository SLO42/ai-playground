<script lang="ts">
  /**
   * /agents/proposals — the WORKFORCE-SPEC §5 OPERATOR-GATED PROPOSAL RESOLUTION surface.
   * Lists open review_proposals (auto-raised by drift, or operator-initiated) with the drift
   * evidence, the prompt-core DIFF (D-010), the re-gauntlet comparison, and the resolution
   * controls — one per stage:
   *   review_diff → author the challenger (D-010 diff+confirm)
   *   regauntlet  → run the challenger gauntlet at the incumbent's certified tier×model (spend)
   *   decide_swap → the one-click D-039 swap confirm (or reject)
   * Reject/withdraw is available at every open stage. NO auto-swap, NO auto-author — every
   * spending or pointer-moving act needs an explicit operator confirm. Honest empties; live
   * off the ONE app:workforce SSE stream (D-035). Svelte 5 runes; design tokens; a11y.
   */
  import { invalidate } from '$app/navigation';
  import { enhance } from '$app/forms';
  import { stream } from '$lib/client/stream.svelte';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const proposals = $derived(data.proposals ?? []);
  const tierGrids = $derived(data.tierGrids ?? {});
  const tierGates = $derived(data.tierGates ?? {});
  const runtimeAvailable = $derived(data.runtimeAvailable);
  const runtimeReason = $derived(data.runtimeReason);
  const loadError = $derived('error' in data ? (data.error as string | undefined) : undefined);

  const fb = $derived(
    form && 'proposals' in form ? (form.proposals as Record<string, unknown>) : undefined
  );
  function fbFor(proposal: string): Record<string, unknown> | undefined {
    return fb && fb.proposal === proposal ? fb : undefined;
  }

  // Live re-derive off the ONE SSE stream (D-035): an author/regauntlet/swap/reject writes
  // review_proposal/role_version/role/role_event/interview_run rows — re-invalidate in place.
  $effect(() => {
    const offs = ['review_proposal', 'role_version', 'role', 'role_event', 'interview_run'].map(
      (t) => stream.onDbChange(t, () => void invalidate('app:workforce'))
    );
    return () => offs.forEach((off) => off());
  });

  // Per-proposal draft challenger text (the operator authors the prompt core in-place).
  let draft = $state<Record<string, string>>({});
  function setDraft(p: string, v: string) {
    draft = { ...draft, [p]: v };
  }
  // Per-proposal confirm ticks (the click IS the gate — buttons stay disabled until ticked).
  let authorConfirm = $state<Record<string, boolean>>({});
  let spendConfirm = $state<Record<string, boolean>>({});
  let swapConfirm = $state<Record<string, boolean>>({});
  let rejectReason = $state<Record<string, string>>({});
  // §7 tier-change confirm ticks (interview at target / tier swap) + the propose-tier note.
  let tierSpendConfirm = $state<Record<string, boolean>>({});
  let tierSwapConfirm = $state<Record<string, boolean>>({});
  function setTick(map: 'author' | 'spend' | 'swap' | 'tierSpend' | 'tierSwap', p: string, v: boolean) {
    if (map === 'author') authorConfirm = { ...authorConfirm, [p]: v };
    else if (map === 'spend') spendConfirm = { ...spendConfirm, [p]: v };
    else if (map === 'swap') swapConfirm = { ...swapConfirm, [p]: v };
    else if (map === 'tierSpend') tierSpendConfirm = { ...tierSpendConfirm, [p]: v };
    else tierSwapConfirm = { ...tierSwapConfirm, [p]: v };
  }

  // §7 grid formatters — every figure honest ('—' for null, never a dressed-up 0; F-008).
  function gridFor(proposal: string) {
    return tierGrids[proposal] ?? null;
  }
  function gateFor(proposal: string) {
    return tierGates[proposal] ?? null;
  }
  function fp(v: number | null | undefined): string {
    return typeof v === 'number' ? String(v) : '—';
  }

  // Per-proposal busy guard: a submitted action disables that proposal's controls until it
  // returns (no double-spend on a slow gauntlet). Cleared in enhance's completion callback.
  let busy = $state<Record<string, boolean>>({});
  function busyEnhance(key: string) {
    return () => {
      busy = { ...busy, [key]: true };
      return async ({ update }: { update: () => Promise<void> }) => {
        await update();
        busy = { ...busy, [key]: false };
      };
    };
  }

  function signalLabel(trigger: Record<string, unknown>): string {
    const s = trigger?.signal;
    return typeof s === 'string' ? s.replace(/_/g, ' ') : 'operator-initiated';
  }
  function evidenceCount(trigger: Record<string, unknown>): number {
    return Array.isArray(trigger?.evidence) ? (trigger.evidence as unknown[]).length : 0;
  }
  function pct(n: number | null | undefined): string {
    return typeof n === 'number' ? `${(n * 100).toFixed(0)}%` : '—';
  }
  function delta(n: number | null | undefined): string {
    if (typeof n !== 'number') return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n}`;
  }
  function fmtUsd(v: unknown): string {
    return typeof v === 'number' ? `$${v.toFixed(4)}` : '—';
  }
  function fmtDate(at: string | null): string {
    if (!at) return '—';
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
  }
  function statusLabel(s: string): string {
    return s.replace(/_/g, ' ');
  }
  // The comparison object is FLEXIBLE — read it defensively (honest '—' on any gap).
  function comp(c: Record<string, unknown> | null): {
    comparable: boolean;
    reason: string | null;
    chalRecall: number | null;
    chalFp: number | null;
    chalCost: number | null;
    incRecall: number | null;
    incFp: number | null;
    incCost: number | null;
    dRecall: number | null;
    dFp: number | null;
    dCost: number | null;
  } | null {
    if (!c) return null;
    const challenger = (c.challenger ?? {}) as Record<string, unknown>;
    const incumbent = (c.incumbent ?? null) as Record<string, unknown> | null;
    const d = (c.delta ?? null) as Record<string, unknown> | null;
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    return {
      comparable: c.comparable === true,
      reason: typeof c.incomparableReason === 'string' ? c.incomparableReason : null,
      chalRecall: num(challenger.recall),
      chalFp: num(challenger.falsePositives),
      chalCost: num(challenger.costUsd),
      incRecall: incumbent ? num(incumbent.recall) : null,
      incFp: incumbent ? num(incumbent.falsePositives) : null,
      incCost: incumbent ? num(incumbent.costUsd) : null,
      dRecall: d ? num(d.recall) : null,
      dFp: d ? num(d.falsePositives) : null,
      dCost: d ? num(d.costUsd) : null
    };
  }
</script>

<svelte:head>
  <title>Performance-review proposals — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">workforce · §5 performance review</span>
    <h1 class="title">Review proposals</h1>
    <p class="lede">
      Drift-raised and operator-initiated role revisions await your decision. Review the
      prompt-core diff, run the challenger through the gauntlet at the incumbent's certified
      tier/model, then confirm the swap — or reject. Nothing swaps without your confirmation
      and the challenger's own passing gauntlet.
    </p>
    {#if !runtimeAvailable && connected}
      <p class="warn" role="status">
        Live gauntlet runs unavailable: {runtimeReason ?? 'credential not configured'}. Diff
        review, swap, and reject still work; the re-gauntlet step is disabled until a
        credential is configured.
      </p>
    {/if}
  </header>

  {#if !connected}
    <p class="empty" role="status">
      Database not connected{loadError ? ` — ${loadError}` : ''}. Reconnect to load proposals.
    </p>
  {:else if proposals.length === 0}
    <p class="empty" role="status">
      No open proposals. Drift signals auto-raise a proposal when a role's high-confidence
      verdicts trend wrong, an escaped defect lands, or you request a review.
    </p>
  {:else}
    <ul class="proposals" aria-label="open review proposals">
      {#each proposals as p (p.proposal)}
        {@const f = fbFor(p.proposal)}
        {@const c = comp(p.comparison)}
        {@const grid = gridFor(p.proposal)}
        {@const gate = gateFor(p.proposal)}
        <li class="proposal card" data-status={p.status}>
          <div class="p-head">
            <div class="p-id">
              <span class="role-name">{p.roleName}</span>
              <span class="kind-tag">{statusLabel(p.kind)}</span>
              <span class="status-badge" data-status={p.status}>{statusLabel(p.status)}</span>
            </div>
            <span class="p-meta mono">
              {#if p.incumbentVersion !== null}v{p.incumbentVersion}{/if}
              {#if p.challengerVersion !== null}→ v{p.challengerVersion}{/if}
              · {fmtDate(p.createdAt)}
            </span>
          </div>

          <!-- Drift evidence (the §4.1 trigger provenance — read verbatim). -->
          <p class="trigger">
            <span class="trigger-signal">{signalLabel(p.trigger)}</span>
            {#if typeof p.trigger?.reason === 'string'}
              <span class="trigger-reason">{p.trigger.reason}</span>
            {/if}
            <span class="trigger-ev">{evidenceCount(p.trigger)} evidence row(s)</span>
          </p>

          <!-- §7 — the tier-hiring grid (two evidence planes, null-honest) + recommendation. -->
          {#if grid}
            <details class="stage tier-grid-stage">
              <summary>Tier evidence grid (§7) · current: {grid.currentTier}</summary>
              {#if grid.recommendation.emit}
                <p class="tier-rec" role="note">{grid.recommendation.sentence}</p>
              {:else}
                <p class="tier-norec mono">No tier recommendation — {grid.recommendation.reason}.</p>
              {/if}
              <table class="tier-table" aria-label="tier evidence grid">
                <thead>
                  <tr>
                    <th scope="col">tier</th>
                    <th scope="col">model</th>
                    <th scope="col">recall</th>
                    <th scope="col">FP</th>
                    <th scope="col">gauntlet $</th>
                    <th scope="col">field $</th>
                    <th scope="col">deployable</th>
                  </tr>
                </thead>
                <tbody>
                  {#each grid.cells as cell (cell.tier)}
                    <tr class:current={cell.current}>
                      <th scope="row">
                        {cell.tier}{#if cell.current} <span class="cur-tag">current</span>{/if}
                      </th>
                      <td class="mono">{cell.modelId ?? '— unmapped'}</td>
                      <td>{pct(cell.gauntlet?.recall)}</td>
                      <td>{fp(cell.gauntlet?.falsePositives)}</td>
                      <td class="mono">{fmtUsd(cell.gauntlet?.costUsd)}</td>
                      <td class="mono">{fmtUsd(cell.field?.costUsd)}</td>
                      <td>
                        {#if cell.deployable}
                          <span class="ok-mark" title="passing (prompt_sha × model_id) interview">✓ certified</span>
                        {:else}
                          <span class="no-mark" title={cell.notDeployableReason ?? ''}>—</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <!-- Propose-tier-change affordance: only for a NON-tier_change proposal (a
                   tier_change already owns this; §5 anti-spam allows one open per role+incumbent).
                   The operator picks a target tier; STRICT gate is resolved on the new proposal. -->
              {#if p.kind !== 'tier_change' && p.incumbent}
                <form method="POST" action="?/proposeTier" use:enhance={busyEnhance(p.proposal)} class="propose-tier">
                  <input type="hidden" name="roleVersion" value={p.incumbent} />
                  <label class="tier-pick">
                    <span class="field-label">Propose tier change to</span>
                    <select name="targetTier">
                      {#each grid.cells as cell (cell.tier)}
                        {#if !cell.current}<option value={cell.tier}>{cell.tier}</option>{/if}
                      {/each}
                    </select>
                  </label>
                  <button class="btn ghost" type="submit" disabled={busy[p.proposal]}>Propose tier change</button>
                </form>
              {/if}
            </details>
          {/if}

          <!-- §7 — the STRICT tier-change gate (only for tier_change proposals). -->
          {#if p.kind === 'tier_change'}
            <div class="stage tier-gate" data-state={gate?.state ?? 'unknown'}>
              {#if !gate}
                <p class="stage-note">Tier-change gate unavailable (the proposal carries no valid target tier).</p>
              {:else}
                <p class="gate-msg" role="status">
                  Target tier <strong>{gate.targetTier}</strong>
                  {#if gate.targetModelId}<span class="mono">({gate.targetModelId})</span>{/if}
                  — {gate.message}
                </p>
                {#if gate.state === 'needs_interview'}
                  <form method="POST" action="?/tierInterview" use:enhance={busyEnhance(p.proposal)}>
                    <input type="hidden" name="proposal" value={p.proposal} />
                    <label class="confirm">
                      <input
                        type="checkbox"
                        name="operatorConfirmed"
                        checked={tierSpendConfirm[p.proposal] ?? false}
                        onchange={(e) => setTick('tierSpend', p.proposal, (e.currentTarget as HTMLInputElement).checked)}
                      />
                      Confirm the spend — run a real gauntlet at {gate.targetTier} to satisfy the strict gate.
                    </label>
                    <button
                      class="btn primary"
                      type="submit"
                      disabled={!tierSpendConfirm[p.proposal] || busy[p.proposal] || !runtimeAvailable}
                      title={runtimeAvailable ? '' : (runtimeReason ?? 'credential not configured')}
                    >
                      Run interview at {gate.targetTier}
                    </button>
                  </form>
                {:else if gate.state === 'ready_to_swap'}
                  <form method="POST" action="?/tierSwap" use:enhance={busyEnhance(p.proposal)} class="swap-form">
                    <input type="hidden" name="proposal" value={p.proposal} />
                    <label class="confirm">
                      <input
                        type="checkbox"
                        name="operatorConfirmed"
                        checked={tierSwapConfirm[p.proposal] ?? false}
                        onchange={(e) => setTick('tierSwap', p.proposal, (e.currentTarget as HTMLInputElement).checked)}
                      />
                      Confirm the tier swap — {p.roleName} will operate at {gate.targetTier} (D-039).
                    </label>
                    <button class="btn primary" type="submit" disabled={!tierSwapConfirm[p.proposal] || busy[p.proposal]}>
                      Swap to {gate.targetTier}
                    </button>
                  </form>
                {:else}
                  <p class="incomparable" role="note">This tier change is blocked: {gate.message}</p>
                {/if}
              {/if}
            </div>
          {/if}

          <!-- Stage 1: review the D-010 prompt-core diff + author the challenger.
               (prompt_revision proposals only; a tier_change has no challenger prompt.) -->
          {#if p.kind !== 'tier_change' && p.nextAction === 'review_diff'}
            <details class="stage">
              <summary>Review prompt-core diff & author challenger (D-010)</summary>
              <!-- Live D-010 preview: the operator inspects the REAL incumbent-vs-draft delta
                   BEFORE authoring. At review_diff there is no challenger yet, so the only honest
                   diff is the one computed from the draft via the previewDiff action. -->
              {#if f?.previewDiff}
                {@const pv = f.previewDiff as { lines: { op: string; text: string }[]; added: number; removed: number; unchanged: number }}
                <pre class="diff" aria-label="prompt-core diff preview">{#each pv.lines as l, i (l.op + '·' + i)}<span class="dl" data-op={l.op}>{l.op === 'add' ? '+' : l.op === 'del' ? '-' : ' '} {l.text}
</span>{/each}</pre>
                <p class="diff-sum mono">+{pv.added} −{pv.removed} · {pv.unchanged} unchanged</p>
              {:else if p.diff}
                <pre class="diff" aria-label="prompt-core diff">{#each p.diff.lines as l, i (l.op + '·' + i)}<span class="dl" data-op={l.op}>{l.op === 'add' ? '+' : l.op === 'del' ? '-' : ' '} {l.text}
</span>{/each}</pre>
                <p class="diff-sum mono">+{p.diff.added} −{p.diff.removed} · {p.diff.unchanged} unchanged</p>
              {:else}
                <p class="diff-hint">
                  Enter the challenger prompt core below, then preview the diff to see exactly what
                  changes vs the incumbent before you approve (D-010).
                </p>
              {/if}
              <!-- ① PREVIEW the diff (read-only, no write, no gate) — wires the previewDiff action. -->
              <form method="POST" action="?/previewDiff" use:enhance={busyEnhance(p.proposal)} class="preview-form">
                <input type="hidden" name="proposal" value={p.proposal} />
                <input type="hidden" name="promptCore" value={draft[p.proposal] ?? ''} />
                <button
                  class="btn ghost"
                  type="submit"
                  disabled={busy[p.proposal] || !((draft[p.proposal] ?? '').trim())}
                >
                  Preview diff
                </button>
              </form>
              <form
                method="POST"
                action="?/author"
                use:enhance={busyEnhance(p.proposal)}
              >
                <input type="hidden" name="proposal" value={p.proposal} />
                <label class="field">
                  <span class="field-label">Challenger prompt core</span>
                  <textarea
                    name="promptCore"
                    rows="8"
                    placeholder="The revised methodology text the challenger will be certified on…"
                    value={draft[p.proposal] ?? ''}
                    oninput={(e) => setDraft(p.proposal, (e.currentTarget as HTMLTextAreaElement).value)}
                  ></textarea>
                </label>
                <label class="confirm">
                  <input
                    type="checkbox"
                    name="operatorConfirmed"
                    checked={authorConfirm[p.proposal] ?? false}
                    onchange={(e) => setTick('author', p.proposal, (e.currentTarget as HTMLInputElement).checked)}
                  />
                  I have reviewed the diff and approve this challenger prompt core (D-010).
                </label>
                <button
                  class="btn primary"
                  type="submit"
                  disabled={!authorConfirm[p.proposal] || busy[p.proposal] || !((draft[p.proposal] ?? '').trim())}
                >
                  Author challenger
                </button>
              </form>
            </details>

          <!-- Stage 2: re-gauntlet the challenger (real spend). -->
          {:else if p.kind !== 'tier_change' && p.nextAction === 'regauntlet'}
            <div class="stage">
              <p class="stage-note">
                The challenger (v{p.challengerVersion}) is authored. Run it through the gauntlet
                at the incumbent's certified tier/model — apples-to-apples — to earn its own
                certification before any swap.
              </p>
              {#if p.diff}
                <p class="diff-sum mono">prompt delta: +{p.diff.added} −{p.diff.removed}</p>
              {/if}
              <form method="POST" action="?/regauntlet" use:enhance={busyEnhance(p.proposal)}>
                <input type="hidden" name="proposal" value={p.proposal} />
                <label class="confirm">
                  <input
                    type="checkbox"
                    name="operatorConfirmed"
                    checked={spendConfirm[p.proposal] ?? false}
                    onchange={(e) => setTick('spend', p.proposal, (e.currentTarget as HTMLInputElement).checked)}
                  />
                  Confirm the spend — this runs a real gauntlet (the click is the budget decision).
                </label>
                <button
                  class="btn primary"
                  type="submit"
                  disabled={!spendConfirm[p.proposal] || busy[p.proposal] || !runtimeAvailable}
                  title={runtimeAvailable ? '' : (runtimeReason ?? 'credential not configured')}
                >
                  Run re-gauntlet
                </button>
              </form>

              <!-- ②b RECONCILE — the free alternative to spending again. Rendered ONLY when a run
                   this proposal already paid for actually exists, so it can never look like a
                   second way to start one. `ready:false` is SHOWN, not hidden: "there is a run,
                   here is why its verdict is not usable yet" beats an unexplained absence beside
                   a button that costs money. -->
              {#if p.reconcilable}
                <div class="reconcile" class:pending={!p.reconcilable.ready}>
                  <p class="stage-note">
                    A gauntlet run for this challenger already exists —
                    <span class="mono">{p.reconcilable.run}</span> ·
                    <span class="mono">{p.reconcilable.status}</span>.
                    {p.reconcilable.reason}
                  </p>
                  {#if p.reconcilable.ready}
                    <form method="POST" action="?/reconcile" use:enhance={busyEnhance(p.proposal)}>
                      <input type="hidden" name="proposal" value={p.proposal} />
                      <!-- No confirm tick: this spends nothing and moves no role. It records the
                           comparison and lands on 'compared', which IS where D-039 asks for the
                           operator's confirm. -->
                      <button class="btn" type="submit" disabled={busy[p.proposal]}>
                        Use this run’s verdict (no new spend)
                      </button>
                    </form>
                  {/if}
                </div>
              {/if}
            </div>

          <!-- Stage 3: the comparison + the D-039 swap (or reject). -->
          {:else if p.kind !== 'tier_change' && p.nextAction === 'decide_swap'}
            <div class="stage">
              {#if c}
                <table class="comparison" aria-label="challenger vs incumbent">
                  <thead>
                    <tr><th></th><th>recall</th><th>FP</th><th>cost</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">challenger</th>
                      <td>{pct(c.chalRecall)}</td>
                      <td>{c.chalFp ?? '—'}</td>
                      <td class="mono">{fmtUsd(c.chalCost)}</td>
                    </tr>
                    <tr>
                      <th scope="row">incumbent</th>
                      <td>{c.incRecall !== null ? pct(c.incRecall) : '—'}</td>
                      <td>{c.incFp ?? '—'}</td>
                      <td class="mono">{c.incCost !== null ? fmtUsd(c.incCost) : '—'}</td>
                    </tr>
                    {#if c.comparable}
                      <tr class="delta-row">
                        <th scope="row">Δ</th>
                        <td>{c.dRecall !== null ? delta(Math.round(c.dRecall * 100)) + '%' : '—'}</td>
                        <td>{delta(c.dFp)}</td>
                        <td class="mono">{typeof c.dCost === 'number' ? fmtUsd(c.dCost) : '—'}</td>
                      </tr>
                    {/if}
                  </tbody>
                </table>
                {#if !c.comparable}
                  <p class="incomparable" role="note">Not directly comparable: {c.reason ?? 'see comparison'}.</p>
                {/if}
              {/if}
              <form method="POST" action="?/swap" use:enhance={busyEnhance(p.proposal)} class="swap-form">
                <input type="hidden" name="proposal" value={p.proposal} />
                <input
                  type="hidden"
                  name="modelId"
                  value={(p.comparison?.challenger as Record<string, unknown> | undefined)?.modelId ?? ''}
                />
                <label class="confirm">
                  <input
                    type="checkbox"
                    name="operatorConfirmed"
                    checked={swapConfirm[p.proposal] ?? false}
                    onchange={(e) => setTick('swap', p.proposal, (e.currentTarget as HTMLInputElement).checked)}
                  />
                  Confirm the swap — v{p.challengerVersion} becomes {p.roleName}'s active version (D-039).
                </label>
                <button class="btn primary" type="submit" disabled={!swapConfirm[p.proposal] || busy[p.proposal]}>
                  Swap in challenger
                </button>
              </form>
            </div>
          {/if}

          <!-- Reject / withdraw — available at every open stage. -->
          <form method="POST" action="?/reject" use:enhance={busyEnhance(p.proposal)} class="reject-form">
            <input type="hidden" name="proposal" value={p.proposal} />
            <input
              type="text"
              name="reason"
              class="reason"
              placeholder="Reason (optional — screened, feeds cooldown)"
              value={rejectReason[p.proposal] ?? ''}
              oninput={(e) => (rejectReason = { ...rejectReason, [p.proposal]: (e.currentTarget as HTMLInputElement).value })}
            />
            <button class="btn ghost" type="submit" disabled={busy[p.proposal]}>Reject</button>
          </form>

          {#if f?.error}
            <p class="action-err" role="alert">{f.error}</p>
          {:else if f?.ok && (f.authored || f.regauntlet || f.reconciled || f.swapped || f.rejected || f.proposedTier || f.tierInterview || f.tierSwapped)}
            <p class="action-ok" role="status">
              {#if f.authored}Challenger authored{f.created === false ? ' (already existed)' : ''}.{/if}
              {#if f.regauntlet}{f.ran ? `Re-gauntlet ${f.status}` : 'Re-gauntlet queued'}{f.comparable === true ? ' · comparable' : ''}.{#if f.comparable === false && f.incomparableReason}
                  <!-- The re-gauntlet ran but produced no comparison — say WHY rather than
                       leaving the operator to wonder where the swap stage went. -->
                  <span class="incomparable-inline">{String(f.incomparableReason)}</span>{/if}{/if}
              {#if f.reconciled}Comparison recorded from run <span class="mono">{String(f.run)}</span> — no new spend{f.comparable === true ? ' · comparable' : ''}.{#if f.comparable === false && f.incomparableReason}<span class="incomparable-inline">{String(f.incomparableReason)}</span>{/if}{/if}
              {#if f.swapped}Swapped — challenger is now active.{/if}
              {#if f.proposedTier}Tier-change proposed{f.created === false ? ' (already open)' : ''} → {String(f.targetTier)}.{/if}
              {#if f.tierInterview}{f.alreadyReady ? 'Target tier already certified' : f.ran ? `Tier interview ${f.status}` : 'Tier interview queued'}.{/if}
              {#if f.tierSwapped}Tier swapped — role now operates at {String(f.tier)}.{/if}
              {#if f.rejected}Closed: {statusLabel(String(f.status))}.{/if}
              {#if Array.isArray(f.screened) && f.screened.length}<span class="screened"> (screened: {f.screened.join(', ')})</span>{/if}
            </p>
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
    gap: var(--gap-stack, 1.5rem);
    padding: var(--space-5, 1.25rem);
    max-width: 64rem;
  }
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 0.5rem);
  }
  .eyebrow {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-accent);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
    margin: 0;
  }
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    margin: 0;
    max-width: 52rem;
  }
  .warn {
    font: var(--type-body-sm);
    color: var(--color-warn);
    margin: 0;
  }
  .empty {
    font: var(--type-body);
    color: var(--color-text-muted);
    padding: var(--space-5);
    border: var(--border-width, 1px) dashed var(--color-border);
    border-radius: var(--radius-md, 10px);
  }
  .proposals {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }
  .card {
    background: var(--color-surface-card);
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-md, 10px);
    padding: var(--space-4, 1rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }
  .p-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .p-id {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .role-name {
    font: var(--weight-medium) var(--text-sm) / 1.2 var(--font-body, inherit);
    color: var(--color-text);
  }
  .kind-tag,
  .status-badge {
    font-size: var(--text-xs);
    padding: var(--space-1, 0.2rem) var(--space-2, 0.5rem);
    border-radius: var(--radius-sm, 6px);
    border: var(--border-width, 1px) solid var(--color-border);
    color: var(--color-text-2);
  }
  .status-badge[data-status='compared'] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .status-badge[data-status='interviewing'] {
    color: var(--color-text-muted);
  }
  .p-meta {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .trigger {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    align-items: baseline;
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  .trigger-signal {
    font-weight: var(--weight-medium, 600);
    color: var(--color-text);
  }
  .trigger-ev {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .stage {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--color-surface-overlay, transparent);
    border-radius: var(--radius-sm, 6px);
  }
  summary {
    cursor: pointer;
    font: var(--type-body-sm);
    color: var(--color-text);
  }
  summary:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }
  .stage-note {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  /* ②b RECONCILE — set apart from the spending control above it so the free path is never
     mistaken for a second way to start a paid run. Accent border when the verdict is ready to
     consume; muted when the run is still pending (a state, not a fault — no error ramp). */
  .reconcile {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: var(--border-width, 1px) solid var(--color-accent);
    border-radius: var(--radius-sm, 6px);
  }
  .reconcile.pending {
    border-color: var(--color-border);
  }
  .diff {
    font-family: var(--font-mono, monospace);
    font-size: var(--text-xs);
    background: var(--color-surface-code, var(--color-surface-overlay));
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-3);
    margin: 0;
    overflow-x: auto;
    max-height: 22rem;
    white-space: pre;
  }
  .dl[data-op='add'] {
    color: var(--color-success, #2e7d32);
  }
  .dl[data-op='del'] {
    color: var(--color-error);
  }
  .diff-sum {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0;
  }
  .diff-hint {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    margin: 0;
  }
  .preview-form {
    display: flex;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .field-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  textarea,
  .reason {
    font: var(--type-body-sm);
    color: var(--color-text);
    background: var(--color-surface-input, var(--color-surface-card));
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-2) var(--space-3);
    width: 100%;
    resize: vertical;
  }
  textarea:focus-visible,
  .reason:focus-visible,
  .confirm input:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 1px;
  }
  .confirm {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font: var(--type-body-sm);
    color: var(--color-text-2);
  }
  .comparison {
    border-collapse: collapse;
    font: var(--type-body-sm);
    color: var(--color-text);
  }
  .comparison th,
  .comparison td {
    text-align: right;
    padding: var(--space-1) var(--space-3);
    border-bottom: var(--border-width, 1px) solid var(--color-border);
  }
  .comparison th[scope='row'] {
    text-align: left;
    color: var(--color-text-2);
  }
  .delta-row td,
  .delta-row th {
    font-weight: var(--weight-medium, 600);
    border-bottom: none;
  }
  .incomparable {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0;
  }
  /* The same "no comparison, and here is why" voice, inline in the action-feedback line. */
  .incomparable-inline {
    display: block;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-top: var(--space-1, 0.25rem);
  }
  .reject-form,
  .swap-form {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .btn {
    padding: var(--pad-control, 0.45rem) var(--space-5, 1.25rem);
    border: var(--border-width, 1px) solid transparent;
    border-radius: var(--radius-sm, 6px);
    font: var(--weight-medium) var(--text-sm) / 1 var(--font-body, inherit);
    cursor: pointer;
  }
  .btn.primary {
    background: var(--color-accent);
    color: var(--color-on-accent);
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--color-accent-hover, var(--color-accent));
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--color-border-strong, var(--color-border));
    color: var(--color-text-2);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 2px;
  }
  .action-err {
    font: var(--type-body-sm);
    color: var(--color-error);
    margin: 0;
  }
  .action-ok {
    font: var(--type-body-sm);
    color: var(--color-success, #2e7d32);
    margin: 0;
  }
  .screened {
    color: var(--color-text-muted);
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
  .tier-grid-stage summary {
    font-weight: var(--weight-medium, 600);
  }
  .tier-rec {
    font: var(--type-body-sm);
    color: var(--color-success, #2e7d32);
    margin: 0;
    font-weight: var(--weight-medium, 600);
  }
  .tier-norec {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0;
  }
  .tier-table {
    border-collapse: collapse;
    font: var(--type-body-sm);
    color: var(--color-text);
    width: 100%;
  }
  .tier-table th,
  .tier-table td {
    text-align: right;
    padding: var(--space-1) var(--space-3);
    border-bottom: var(--border-width, 1px) solid var(--color-border);
  }
  .tier-table th[scope='col'] {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tier-table th[scope='row'] {
    text-align: left;
    color: var(--color-text-2);
  }
  .tier-table tr.current {
    background: var(--color-surface-overlay, transparent);
  }
  .cur-tag {
    font-size: var(--text-xs);
    color: var(--color-accent);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ok-mark {
    color: var(--color-success, #2e7d32);
  }
  .no-mark {
    color: var(--color-text-muted);
  }
  .propose-tier,
  .tier-pick {
    display: flex;
    gap: var(--space-2);
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .tier-pick {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
  }
  select {
    font: var(--type-body-sm);
    color: var(--color-text);
    background: var(--color-surface-input, var(--color-surface-card));
    border: var(--border-width, 1px) solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    padding: var(--space-1) var(--space-2);
  }
  select:focus-visible {
    outline: 2px solid var(--color-focus-ring, var(--color-accent));
    outline-offset: 1px;
  }
  .tier-gate {
    border: var(--border-width, 1px) solid var(--color-border);
  }
  .tier-gate[data-state='ready_to_swap'] {
    border-color: var(--color-accent);
  }
  .tier-gate[data-state='blocked'] {
    border-color: var(--color-error);
  }
  .gate-msg {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    margin: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
    }
  }
</style>
