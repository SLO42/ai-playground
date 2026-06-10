<script lang="ts">
  /**
   * /services — the managed-services control surface (UI-SPEC §45/§210).
   *
   * LIVE health + status for the local services (Ollama / SurrealDB / engine / dashboard),
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
  import type { PageData, ActionData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const connected = $derived(data.connected);
  const services = $derived(data.services ?? []);
  const incidents = $derived(data.incidents ?? []);
  const notifications = $derived(data.notifications ?? []);

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
    return () => {
      off1();
      off2();
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
