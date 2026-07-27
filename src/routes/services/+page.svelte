<script lang="ts">
  /**
   * /services — the managed-services control surface (UI-SPEC §45/§210).
   *
   * LIVE health + status for the local services (Ollama / SurrealDB / dashboard),
   * operator start/stop/restart on the controllable ones, and the durable incidents +
   * notifications history (the operational audit trail, §208). Live by default (§1.2): a
   * `service`/`notification` row change on the one SSE stream re-invalidates the loader so
   * health/status + the feed update in place — no poll. Honest states (loading/empty/error/
   * live, §1.3): a disconnected DB renders an honest error, a non-controllable service shows
   * WHY (no dead controls). Tokens-only, a11y, reduced-motion. Svelte 5 runes only.
   */
  import { invalidate } from '$app/navigation';
  import { enhance } from '$app/forms';
  import { stream } from '$lib/client/stream.svelte';
  import { describeBudgetRisk } from '$lib/shared/budget-risk';
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const services = $derived(data.services ?? []);
  const incidents = $derived(data.incidents ?? []);
  const notifications = $derived(data.notifications ?? []);

  // SD-1 — the budget-safety verdict (armed autonomous loop + an uncapped token ceiling = the
  // runaway hole made VISIBLE). Rendered as a loud, honest banner; silent when safe (F-008).
  const budgetSafety = $derived(data.budgetSafety);
  // Which caps are uncapped, in plain words, for the banner body.
  const uncappedList = $derived(
    [
      budgetSafety?.dailyUncapped ? 'the daily token budget' : null,
      budgetSafety?.perProjectUncapped ? 'the per-project token budget' : null
    ].filter((x): x is string => x !== null)
  );

  // SD-1 WORDING — severity-accurate copy from the pure `describeBudgetRisk` helper (unit-tested
  // there). The banner used to render the both-uncapped copy ("no token ceiling … without a
  // backstop") whenever EITHER ceiling was 0; with the shipped config the global daily ceiling IS
  // armed, so that claim was false. F-008 honesty cuts both ways — an alarm that overstates trains
  // the operator to discount it. null ⇒ safe ⇒ the banner renders nothing.
  const risk = $derived(budgetSafety ? describeBudgetRisk(budgetSafety) : null);


  // SD-2 — the persisted autonomy boot-status (armed | manual | config-error). A 'config-error'
  // is the silent-disarm hole made VISIBLE: a config file was unreadable so every engine is forced
  // OFF until restart — rendered as a LOUD, honest banner. 'manual'/'armed' render a calm honest
  // line. null (DB down / never persisted) → an honest "unknown", never a fabricated "armed" (F-008).
  const autonomy = $derived(data.autonomyStatus);

  // COMPLETION-LEDGER Wave A (m0086) — the per-subsystem BOOT-SKIP ledger on the SAME row. It
  // answers the question the autonomy line alone cannot: "what did NOT start, and why?". Three
  // distinct honest states, never collapsed (F-008):
  //   • null  — NOT REPORTED (a boot before the ledger existed, or one that died before sealing it).
  //   • []    — reported, but nothing recorded (should not happen; rendered as not-reported).
  //   • [...] — the real outcomes; entries that are off/degraded are surfaced FIRST.
  const subsystems = $derived(autonomy?.subsystems ?? null);
  const subsystemsReported = $derived(!!subsystems && subsystems.length > 0);
  const bootProblems = $derived((subsystems ?? []).filter((s) => s.severity !== 'ok'));
  const bootHealthy = $derived((subsystems ?? []).filter((s) => s.severity === 'ok'));
  const bootOffCount = $derived((subsystems ?? []).filter((s) => !s.started).length);

  const op = $derived(
    (form?.op ?? null) as
      | { name?: string; action?: string; ok?: boolean; error?: string; incidentTitle?: string }
      | null
  );

  // Which service has an action in flight (disables its controls + shows a pending label).
  let pending = $state<string | null>(null);

  // Live: a service or notification row change re-runs the loader so health/status + the
  // incident/notification feed update in place (UI-SPEC §1.2). Every operator action writes
  // BOTH an incident and a notification, so the notification watcher also refreshes incidents.
  $effect(() => {
    const off1 = stream.onDbChange('service', () => void invalidate('app:services'));
    const off2 = stream.onDbChange('notification', () => void invalidate('app:services'));
    // SD-1: arming/disarming a PM writes a `pm` row — re-run the loader so the budget-safety
    // banner appears/clears live the moment an autonomous loop is armed while a ceiling is uncapped.
    const off3 = stream.onDbChange('pm', () => void invalidate('app:services'));
    return () => {
      off1();
      off2();
      off3();
    };
  });

  /** Human label for a service status (paired with the color dot — never color-only, §9). */
  function statusLabel(s: string): string {
    if (s === 'running') return 'Running';
    if (s === 'stopped') return 'Stopped';
    if (s === 'crashed') return 'Crashed';
    return 'Unknown';
  }

  /** Severity label for an incident row (paired with the color tag). */
  function sevLabel(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** Relative "time ago" for the incident/notification feeds. */
  function ago(iso: string): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  /** Honest live-health text: probed true/false, or "—" when the adapter has no probe. */
  function healthText(h: boolean | null): string {
    if (h === true) return 'healthy';
    if (h === false) return 'unreachable';
    return '—';
  }
</script>

<svelte:head>
  <title>Services — Atelier</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <span class="eyebrow">system</span>
    <h1 class="title">Services</h1>
    <p class="lede">
      The local services the platform depends on — live health and status, with start, stop, and
      restart on the ones this control plane owns. Loopback/local only (D-025). Every action is
      recorded in the incident history below.
    </p>
  </header>

  {#if !connected}
    <div class="card error-card" role="alert">
      <span class="eyebrow">disconnected</span>
      <p class="card-body">
        The datastore is not connected, so service health and history are unavailable. Start the
        datastore (<span class="mono">npm run db:up</span>) — this page recovers live once it
        reconnects.
      </p>
    </div>
  {:else}
    <!-- ── SD-2 autonomy boot-status: is autonomy actually ON? A malformed config silently disarms
         every engine (mode=manual) with only a console line — surface it here, honest + persistent.
         'config-error' = the hole, rendered LOUD (role=alert). 'manual'/'armed' render a calm line.
         null = the DB is down / no boot has persisted it → honest "unknown", never a faked "armed". ── -->
    {#if autonomy && autonomy.state === 'config-error'}
      <div class="card autonomy-off" role="alert">
        <div class="card-head">
          <span class="eyebrow autonomy-off-eyebrow">autonomy · OFF</span>
          <h2 class="card-title">{autonomy.reason}</h2>
        </div>
        <p class="card-body autonomy-body">
          A configuration file could not be read at boot, so every autonomy engine (orchestrator, PM
          triggers, autonomous loop, maintenance) is forced to <strong>manual</strong> — no automatic
          work will run until this is fixed.
        </p>
        {#if autonomy.detail}
          <p class="card-body autonomy-detail mono">{autonomy.detail}</p>
        {/if}
        <p class="card-body autonomy-fix">
          Fix
          <span class="mono">{autonomy.configFile ?? 'config/orchestration.yaml'}</span>
          and restart the server to re-arm autonomy. This state is read once per boot (F-029).
        </p>
      </div>
    {:else}
      <div class="card autonomy-status" data-state={autonomy?.state ?? 'unknown'}>
        <div class="autonomy-line">
          <span class="dot" data-autonomy={autonomy?.state ?? 'unknown'} aria-hidden="true"></span>
          <span class="autonomy-label">Autonomy</span>
          <span class="autonomy-state" data-state={autonomy?.state ?? 'unknown'}>
            {#if autonomy?.state === 'armed'}Armed{:else if autonomy?.state === 'manual'}Manual{:else}Unknown{/if}
          </span>
          {#if autonomy?.mode}
            <span class="autonomy-mode mono" title="orchestration mode">{autonomy.mode} mode</span>
          {/if}
        </div>
        <p class="card-body autonomy-reason">
          {#if autonomy}{autonomy.reason}{:else}Autonomy status has not been reported yet — it is
            written once per boot. If the datastore was down at boot, restart the server once it is
            up.{/if}
        </p>
        {#if autonomy?.note}
          <p class="card-body autonomy-note" role="status">{autonomy.note}</p>
        {/if}
      </div>
    {/if}

    <!-- ── COMPLETION-LEDGER Wave A (m0086): the BOOT-SKIP ledger ────────────────────────────
         The autonomy line above says whether the MODE is armed. It cannot say whether the engines
         that mode depends on actually STARTED. Before this, a declined engine existed only as a
         `console.warn` in the server terminal — so a credential-less boot rendered a calm
         "Autonomy · Armed" while the orchestrator never started and the queue waited forever.
         This answers "what did not start, and why", persistently and in plain language. ── -->
    <div class="card boot-ledger" data-degraded={bootProblems.length > 0 ? 'true' : null}>
      <div class="card-head">
        <span class="eyebrow">boot · what started</span>
        <h2 class="card-title">
          {#if !subsystemsReported}
            Subsystem boot outcomes were not reported
          {:else if bootProblems.length === 0}
            All {bootHealthy.length} subsystems started cleanly
          {:else}
            {bootProblems.length} of {subsystems!.length}
            {bootProblems.length === 1 ? 'subsystem needs' : 'subsystems need'} attention
          {/if}
        </h2>
      </div>

      {#if !subsystemsReported}
        <p class="card-body">
          This boot recorded no per-subsystem outcomes — either it predates the boot ledger, or the
          server stopped before the engines finished starting. That is reported as
          <strong>unknown</strong>, not as "everything started". Restart the server to record a fresh
          ledger.
        </p>
      {:else}
        <ul class="boot-list">
          <!-- Problems first: the operator should never have to hunt for the failure. -->
          {#each [...bootProblems, ...bootHealthy] as sub (sub.key)}
            <li class="boot-item" data-severity={sub.severity}>
              <span class="boot-line">
                <span class="dot" data-severity={sub.severity} aria-hidden="true"></span>
                <span class="boot-label">{sub.label}</span>
                <span class="boot-state" data-severity={sub.severity}>
                  {#if sub.severity === 'ok'}started{:else if sub.severity === 'degraded'}degraded{:else}not started{/if}
                </span>
              </span>
              {#if sub.reason}
                <p class="boot-reason">{sub.reason}</p>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="card-body boot-foot">
          Recorded once per boot, when the server starts (F-029 — restart to refresh).
          {#if bootOffCount > 0}
            Work owned by a <strong>not started</strong> subsystem will not happen until the reason
            is fixed and the server is restarted.
          {/if}
        </p>
      {/if}
    </div>

    <!-- ── SD-1 budget-safety banner: an ARMED autonomous loop against an UNCAPPED token ceiling
         is the runaway-spend hole — make it LOUD, never silent (F-008). Silent when safe. ── -->
    {#if budgetSafety?.uncappedWhileArmed && risk}
      <div class="card budget-banner" role="alert">
        <div class="card-head">
          <span class="eyebrow budget-eyebrow">{risk.eyebrow}</span>
          <h2 class="card-title">
            {budgetSafety.armedLoops}
            {budgetSafety.armedLoops === 1 ? 'autonomous loop is' : 'autonomous loops are'} armed
            {risk.headline}
          </h2>
        </div>
        <p class="card-body budget-body">
          {budgetSafety.armedLoops === 1
            ? 'An autonomous loop is'
            : `${budgetSafety.armedLoops} autonomous loops are`}
          running unsupervised, but {uncappedList.join(' and ')}
          {uncappedList.length === 1 ? 'is' : 'are'} set to 0 (uncapped).
          {risk.risk}
        </p>
        <p class="card-body budget-fix">
          Arm a ceiling in <span class="mono">config/orchestration.yaml</span> —
          {#if budgetSafety.dailyUncapped}<span class="mono">spend.dailyTokenBudget</span>{/if}{#if budgetSafety.dailyUncapped && budgetSafety.perProjectUncapped}{' / '}{/if}{#if budgetSafety.perProjectUncapped}<span class="mono">spend.perProjectTokenBudget</span>{/if}
          — then restart the server to apply. Or disarm the loop on its project page.
        </p>
      </div>
    {/if}

    <!-- Action result banner (success/failure of the last operator action). -->
    {#if op?.error}
      <p class="form-error" role="alert">{op.error}</p>
    {:else if op}
      <p class="form-ok" role="status">
        {#if op.ok}
          <span class="mono">{op.name}</span> {op.action} succeeded — logged as “{op.incidentTitle}”.
        {:else}
          <span class="mono">{op.name}</span> {op.action} failed: {op.error ?? 'see incident history'}.
        {/if}
      </p>
    {/if}

    <!-- ── Managed services (ServiceRow list — UI-SPEC §163/§210) ──────────────────── -->
    <article class="card" aria-labelledby="svc-h">
      <div class="card-head">
        <span class="eyebrow">managed</span>
        <h2 id="svc-h" class="card-title">Services</h2>
      </div>

      <ul class="svc-rows" aria-label="managed services">
        {#each services as s (s.name)}
          <li class="svc-row">
            <div class="svc-main">
              <span
                class="dot"
                data-status={s.status}
                aria-hidden="true"
              ></span>
              <span class="svc-name">{s.name}</span>
              <span class="svc-status" data-status={s.status}>{statusLabel(s.status)}</span>
              <!-- 14.4b: a down service NEVER shows its old pid as if current — the read
                   model omits it (pid —) and we say when it was last seen instead. -->
              {#if s.pid != null}
                <span class="svc-pid mono" title="process id">pid {s.pid}</span>
              {:else if s.id !== null}
                <span class="svc-pid mono" title="no live process id">pid —</span>
              {/if}
              {#if s.status !== 'running' && s.lastSeenAt}
                <span class="svc-seen" title={s.lastSeenAt}>last seen {ago(s.lastSeenAt)}</span>
              {/if}
              {#if s.liveHealthy !== null}
                <span class="svc-health" data-healthy={s.liveHealthy}
                  >probe: {healthText(s.liveHealthy)}</span
                >
              {/if}
            </div>

            <div class="svc-controls">
              {#if s.controllable}
                {#each ['start', 'restart', 'stop'] as action (action)}
                  <form
                    method="POST"
                    action="?/operate"
                    use:enhance={() => {
                      pending = s.name;
                      return async ({ update }) => {
                        await update();
                        pending = null;
                      };
                    }}
                  >
                    <input type="hidden" name="name" value={s.name} />
                    <input type="hidden" name="action" value={action} />
                    <button
                      class="btn"
                      class:danger={action === 'stop'}
                      type="submit"
                      disabled={pending === s.name}
                    >
                      {action}
                    </button>
                  </form>
                {/each}
                {#if pending === s.name}
                  <span class="pending" role="status">working…</span>
                {/if}
              {:else}
                <span class="svc-note">{s.note}</span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </article>

    <!-- ── Incidents history (durable audit trail — UI-SPEC §208) ──────────────────── -->
    <article class="card" aria-labelledby="inc-h">
      <div class="card-head">
        <span class="eyebrow">history</span>
        <h2 id="inc-h" class="card-title">Incidents</h2>
      </div>
      <p class="card-body">
        Crash/recovery and operator-action records, newest first — the durable counterpart to the
        right-tray feed.
      </p>

      {#if incidents.length === 0}
        <p class="none">No incidents recorded yet — services have been healthy.</p>
      {:else}
        <ul class="inc-rows" aria-label="incident history">
          {#each incidents as inc (inc.id)}
            <li class="inc-row">
              <span class="sev" data-sev={inc.severity}>{sevLabel(inc.severity)}</span>
              <div class="inc-body">
                <span class="inc-title">{inc.title}</span>
                {#if inc.detail}<span class="inc-detail">{inc.detail}</span>{/if}
              </div>
              <time class="inc-at" datetime={inc.at}>{ago(inc.at)}</time>
            </li>
          {/each}
        </ul>
      {/if}
    </article>

    <!-- ── Unread notifications ────────────────────────────────────────────────────── -->
    <article class="card" aria-labelledby="note-h">
      <div class="card-head">
        <span class="eyebrow">notifications</span>
        <h2 id="note-h" class="card-title">Unread</h2>
      </div>
      {#if notifications.length === 0}
        <p class="none">No unread notifications.</p>
      {:else}
        <ul class="note-rows" aria-label="unread notifications">
          {#each notifications as n (n.id)}
            <li class="note-row">
              <span class="note-msg">{n.message}</span>
              <time class="note-at" datetime={n.at}>{ago(n.at)}</time>
            </li>
          {/each}
        </ul>
      {/if}
    </article>
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
  .eyebrow {
    font: var(--type-label);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
  }
  .title {
    font: var(--type-h1);
    color: var(--color-text);
  }
  .lede {
    font: var(--type-body);
    color: var(--color-text-muted);
    max-width: 70ch;
  }
  .mono {
    font-family: var(--font-mono);
  }

  .card {
    background: var(--color-surface-card);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    padding: var(--pad-card);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .error-card {
    border-color: var(--color-error);
  }
  /* SD-1 budget-safety banner — a loud warn-toned card (never color-only: the eyebrow + heading
     carry the meaning in words for a11y, the tint reinforces it). */
  .budget-banner {
    border-color: var(--color-warn);
    background: var(--color-warn-bg);
  }
  .budget-eyebrow {
    color: var(--color-warn-on-overlay);
    font-weight: 700;
  }
  .budget-body {
    color: var(--color-text);
  }
  .budget-fix {
    color: var(--color-text-2);
  }

  /* ── SD-2 autonomy status ─────────────────────────────────────────────────── */
  /* config-error: a LOUD error-toned card. Never color-only — the eyebrow + heading + fix copy
     carry the meaning in words for a11y; the tint reinforces it. */
  .autonomy-off {
    border-color: var(--color-error);
    background: var(--color-error-bg);
  }
  .autonomy-off-eyebrow {
    color: var(--color-error);
    font-weight: 700;
  }
  .autonomy-body {
    color: var(--color-text);
  }
  .autonomy-detail {
    color: var(--color-text-muted);
    word-break: break-word;
  }
  .autonomy-fix {
    color: var(--color-text-2);
  }
  /* armed/manual/unknown: a calm one-line honest status (not an alarm). */
  .autonomy-status {
    gap: var(--space-2);
  }
  .autonomy-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .autonomy-label {
    font: var(--type-mono);
    font-weight: 600;
    color: var(--color-text);
  }
  .autonomy-state {
    font: var(--type-label);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-overlay);
  }
  .autonomy-state[data-state='armed'] {
    color: var(--color-running);
    background: var(--color-running-bg);
  }
  .autonomy-mode {
    font: var(--type-mono-sm);
    color: var(--color-text-muted);
  }
  .autonomy-reason {
    color: var(--color-text-2);
  }
  .autonomy-note {
    color: var(--color-warn);
  }
  .dot[data-autonomy='armed'] {
    background: var(--color-running);
  }
  .dot[data-autonomy='manual'] {
    background: var(--color-neutral);
  }
  .dot[data-autonomy='unknown'] {
    background: var(--color-text-faint);
  }

  /* ── Boot-skip ledger (COMPLETION-LEDGER Wave A, m0086) ─────────────────────
     Design-system tokens only (D-034). Colour is never the sole signal: every row
     carries an explicit text state ("started" / "degraded" / "not started") and,
     where it is not healthy, a full-sentence reason. */
  .boot-ledger {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .boot-ledger[data-degraded='true'] {
    border-color: var(--color-warn);
  }
  .boot-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .boot-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-overlay);
  }
  .boot-item[data-severity='off'] {
    border-color: var(--color-error);
  }
  .boot-item[data-severity='degraded'] {
    border-color: var(--color-warn);
  }
  .boot-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .boot-label {
    font: var(--type-body-sm);
    font-weight: 600;
    color: var(--color-text);
  }
  .boot-state {
    font: var(--type-label);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface);
  }
  .boot-state[data-severity='ok'] {
    color: var(--color-running);
  }
  .boot-state[data-severity='degraded'] {
    color: var(--color-warn);
  }
  .boot-state[data-severity='off'] {
    color: var(--color-error);
  }
  .dot[data-severity='ok'] {
    background: var(--color-running);
  }
  .dot[data-severity='degraded'] {
    background: var(--color-warn);
  }
  .dot[data-severity='off'] {
    background: var(--color-error);
  }
  .boot-reason {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 90ch;
  }
  .boot-foot {
    color: var(--color-text-muted);
  }

  .card-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .card-title {
    font: var(--type-h2);
    color: var(--color-text);
  }
  .card-body {
    font: var(--type-body-sm);
    color: var(--color-text-2);
    max-width: 70ch;
  }

  /* ── Service rows ───────────────────────────────────────────────────────── */
  .svc-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .svc-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-overlay);
  }
  .svc-main {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    min-width: 0;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--radius-pill);
    background: var(--color-neutral);
    flex: none;
  }
  .dot[data-status='running'] {
    background: var(--color-running);
  }
  .dot[data-status='stopped'] {
    background: var(--color-neutral);
  }
  .dot[data-status='crashed'] {
    background: var(--color-error);
  }
  .dot[data-status='unknown'] {
    background: var(--color-text-faint);
  }
  .svc-name {
    font: var(--type-mono);
    font-weight: 600;
    color: var(--color-text);
    text-transform: capitalize;
  }
  .svc-status {
    font: var(--type-label);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-card);
  }
  .svc-status[data-status='running'] {
    color: var(--color-running);
    background: var(--color-running-bg);
  }
  .svc-status[data-status='crashed'] {
    color: var(--color-error);
    background: var(--color-error-bg);
  }
  .svc-pid {
    font: var(--type-mono-sm);
    color: var(--color-text-muted);
  }
  .svc-seen {
    font: var(--type-label);
    color: var(--color-text-muted);
  }
  .svc-health {
    font: var(--type-label);
    color: var(--color-text-muted);
  }
  .svc-health[data-healthy='true'] {
    color: var(--color-success);
  }
  .svc-health[data-healthy='false'] {
    color: var(--color-warn);
  }
  .svc-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .svc-note {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    font-style: italic;
    max-width: 42ch;
  }
  .pending {
    font: var(--type-label);
    color: var(--color-text-muted);
  }

  /* ── Buttons ────────────────────────────────────────────────────────────── */
  .btn {
    appearance: none;
    background: var(--color-surface-overlay);
    color: var(--color-text);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    font: var(--type-label);
    font-weight: 600;
    text-transform: capitalize;
    padding: var(--pad-control);
    cursor: pointer;
    min-height: 30px;
  }
  .btn:hover:not(:disabled) {
    background: var(--color-surface-card);
    border-color: var(--color-border-strong);
  }
  .btn:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn.danger {
    /* -on-overlay tint: 5.31:1 BODY AA on the overlay button face (14.3) */
    color: var(--color-error-on-overlay);
    border-color: var(--color-error);
  }
  .btn.danger:hover:not(:disabled) {
    background: var(--color-error-bg);
  }

  /* ── Incidents ──────────────────────────────────────────────────────────── */
  .inc-rows,
  .note-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .inc-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--color-surface-overlay);
  }
  .sev {
    font: var(--type-label);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-sm);
    flex: none;
    color: var(--color-text-muted);
    background: var(--color-neutral-bg);
  }
  .sev[data-sev='info'] {
    color: var(--color-info);
    background: var(--color-info-bg);
  }
  .sev[data-sev='warn'] {
    color: var(--color-warn);
    background: var(--color-warn-bg);
  }
  .sev[data-sev='error'] {
    color: var(--color-error);
    background: var(--color-error-bg);
  }
  .sev[data-sev='critical'] {
    color: var(--color-error);
    background: var(--color-error-bg);
    border: var(--border-width) solid var(--color-error);
  }
  .inc-body {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1 1 auto;
    min-width: 0;
  }
  .inc-title {
    font: var(--type-body-sm);
    color: var(--color-text);
  }
  .inc-detail {
    font: var(--type-mono-sm);
    color: var(--color-text-muted);
    word-break: break-word;
  }
  .inc-at,
  .note-at {
    font: var(--type-label);
    /* timestamps are READ, not decoration — faint (1.86:1) is decorative-only;
       muted reads at 4.68:1 on the overlay row (14.3) */
    color: var(--color-text-muted);
    flex: none;
    white-space: nowrap;
  }
  .note-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--color-surface-overlay);
  }
  .note-msg {
    font: var(--type-body-sm);
    color: var(--color-text);
    min-width: 0;
  }

  .none {
    font: var(--type-body-sm);
    color: var(--color-text-muted);
    font-style: italic;
  }
  .form-error {
    font: var(--type-body-sm);
    color: var(--color-error);
    margin: 0;
  }
  .form-ok {
    font: var(--type-body-sm);
    color: var(--color-success);
    margin: 0;
  }
</style>
