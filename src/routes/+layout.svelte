<script lang="ts">
  import '$lib/styles/app.css';
  import Sidebar from '$lib/components/shell/Sidebar.svelte';
  import Topbar from '$lib/components/shell/Topbar.svelte';
  import Statusbar from '$lib/components/shell/Statusbar.svelte';
  import CommandPalette from '$lib/components/shell/CommandPalette.svelte';
  import ToastHost from '$lib/components/shell/ToastHost.svelte';
  import ConfirmDialog from '$lib/components/shell/ConfirmDialog.svelte';
  import GateBanner from '$lib/components/shell/GateBanner.svelte';
  import RightTray from '$lib/components/shell/RightTray.svelte';
  import { stream } from '$lib/client/stream.svelte';
  import { toasts } from '$lib/client/toast.svelte';
  import { confirm } from '$lib/client/confirm.svelte';
  import { tray } from '$lib/client/tray.svelte';
  import { goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let { children, data }: { children?: Snippet; data: LayoutData } = $props();
  const pathname = $derived(page.url.pathname);

  // Live project list for the CommandPalette "Open project" commands (real rows).
  const paletteProjects = $derived(data.paletteProjects ?? []);

  // RightTray feed + unread badge (TASK 10.2): real notification/agent_event rows from the
  // layout load, re-invalidated live over the one SSE stream (notification/agent_event).
  const trayData = $derived(data.tray ?? { items: [], unread: 0, briefs: [] });

  // App-root aria-live region (UI-SPEC §283): ONE always-mounted polite region,
  // debounced so SSE/toast bursts produce a single announcement per item without
  // focus theft. ToastHost calls announce() for each new toast.
  let liveMessage = $state('');
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  function announce(msg: string) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      // Clear then set so identical consecutive messages still re-announce.
      liveMessage = '';
      queueMicrotask(() => (liveMessage = msg));
    }, 150);
  }

  // Live shell tickers (TASK 7.1): real values from the layout loader, served over the
  // one SSE stream. Honest "—" sentinels (null) flow straight through to the components.
  const shell = $derived(data.shell);

  // Breadcrumb from the path (UI-SPEC §3). Root → "Home".
  const breadcrumb = $derived(
    pathname === '/' ? 'Home' : pathname.split('/').filter(Boolean).join(' / ')
  );

  // Drawer state for narrow viewports (task 6.3). The sidebar is a static rail
  // at >=768px; below that it collapses behind a hamburger and opens as an
  // overlay drawer. Closes on navigation so a tap-through never strands the
  // drawer open over the new page.
  let navOpen = $state(false);
  $effect(() => {
    // Re-runs when pathname changes — close the drawer after navigating.
    // `void` reads the rune so $effect tracks it without a bare-expression lint error.
    void pathname;
    // Navigation moves the reading context to the new page — drop the stored
    // trigger instead of yanking focus back to the hamburger (14.2c).
    navRestoreFocus = null;
    navOpen = false;
  });

  // 14.2c — drawer keyboard + focus contract (matches the RightTray pattern):
  // focus moves INTO the drawer on open, Esc closes it, focus RETURNS to the
  // trigger (the hamburger) on close, and Tab cycles within while it overlays.
  let navRestoreFocus: HTMLElement | null = null;
  const drawerActive = () =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;

  function sidebarFocusables(): HTMLElement[] {
    const el = document.getElementById('app-sidebar');
    if (!el) return [];
    return Array.from(
      el.querySelectorAll<HTMLElement>('a[href], button, [tabindex]:not([tabindex="-1"])')
    ).filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null);
  }

  $effect(() => {
    // Open transition: remember the trigger, then move focus in after paint.
    // Only when the sidebar actually overlays (narrow viewports) — at >=768px
    // it is a static rail and stealing focus would be wrong.
    if (navOpen && drawerActive()) {
      navRestoreFocus = (document.activeElement as HTMLElement) ?? null;
      queueMicrotask(() => sidebarFocusables()[0]?.focus());
    }
  });

  function closeNav() {
    const target = navRestoreFocus;
    navRestoreFocus = null;
    navOpen = false;
    queueMicrotask(() => target?.focus?.());
  }

  function onShellKeydown(e: KeyboardEvent) {
    if (!navOpen || !drawerActive()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeNav();
      return;
    }
    if (e.key === 'Tab') {
      const list = sidebarFocusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || !list.includes(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !list.includes(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Open the one SSE stream once, in the browser only ($effect never runs on the
  // server). The Topbar/Statusbar read `stream.connection` reactively (D-019).
  $effect(() => {
    stream.start();
    return () => stream.stop();
  });

  // Operator/devtools control bridge: expose the shell-primitive singletons so the
  // toast + confirm + gate channels can be driven programmatically (the same surface
  // pages/actions use). Purposeful — this app IS a control plane; it also lets the
  // e2e drive the blocking confirm + gate banners that have no dedicated page yet.
  $effect(() => {
    (window as unknown as { atelier?: unknown }).atelier = { toasts, confirm };
    return () => {
      delete (window as unknown as { atelier?: unknown }).atelier;
    };
  });

  // Live shell tickers (TASK 7.1): re-invalidate the layout load whenever a row that
  // moves a ticker changes — a session starting/ending (running-agent count), an
  // agent_event landing (today's tokens/cost), or a service health flip. All over the
  // ONE SSE stream (§2.11). The loader recomputes from real rows; no fabrication.
  $effect(() => {
    // decision_brief: the RightTray decisions inbox (TASK 16.4) re-derives live.
    const offs = [
      'session',
      'agent_event',
      'service',
      'project',
      'notification',
      'decision_brief'
    ].map((table) => stream.onDbChange(table, () => void invalidate('app:shell')));
    return () => offs.forEach((off) => off());
  });
</script>

<svelte:window onkeydown={onShellKeydown} />

<div class="shell" class:nav-open={navOpen}>
  <!-- Backdrop: only interactive while the drawer is open (narrow viewports). -->
  <button
    type="button"
    class="scrim"
    aria-label="Close navigation"
    tabindex={navOpen ? 0 : -1}
    hidden={!navOpen}
    onclick={closeNav}
  ></button>
  <Sidebar {pathname} open={navOpen} onnavigate={() => (navOpen = false)} />
  <div class="shell-main">
    <Topbar
      {breadcrumb}
      mode={shell.mode}
      runningAgents={shell.runningAgents}
      connection={stream.connection}
      navOpen={navOpen}
      unread={trayData.unread}
      ontoggleNav={() => (navOpen ? closeNav() : (navOpen = true))}
      ontoggletray={() => tray.toggle()}
    />
    <GateBanner />
    <main class="content">
      {@render children?.()}
    </main>
    <Statusbar
      services={shell.services}
      activeAgents={shell.runningAgents}
      tokensToday={shell.tokensToday}
      costToday={shell.costToday}
      mode={shell.mode}
    />
  </div>
</div>

<!-- Shell interaction primitives (TASK 10.1), mounted once at app root so they
     overlay every screen. Tokens-only, a11y, reduced-motion (per component). -->
<CommandPalette
  projects={paletteProjects}
  onstartrun={() => void goto('/projects')}
/>
<ConfirmDialog />
<RightTray items={trayData.items} unread={trayData.unread} briefs={trayData.briefs} />
<ToastHost {announce} />

<!-- Always-mounted polite live region (UI-SPEC §283) — never conditionally rendered. -->
<div class="sr-only" aria-live="polite" aria-atomic="true" role="status">{liveMessage}</div>

<style>
  .shell {
    display: flex;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .shell-main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .content {
    flex: 1 1 auto;
    overflow-y: auto;
    /* 14.2a: ONE consistent gutter token between fluid full-width pages and
       the shell edges (no per-page px caps — prose keeps ch-based measure). */
    padding: var(--page-gutter);
    /* Vertical fill: the page root stretches to the viewport height so short
       pages don't strand dead space under the last region — boards/tables can
       grow into it. Taller pages simply scroll as before. */
    display: flex;
    flex-direction: column;
  }
  .content > :global(*) {
    flex: 1 0 auto;
  }

  /* Drawer scrim — hidden (and non-interactive) at wide viewports, shown only
     when the drawer is open on narrow ones. `hidden` removes it from the a11y
     tree when closed. */
  .scrim {
    display: none;
  }

  /* Below the narrow breakpoint the sidebar leaves the flex flow and becomes a
     fixed overlay drawer, so the main column reflows to the full width and no
     content is pushed off-screen / no horizontal scroll is introduced. */
  @media (max-width: 767px) {
    .scrim {
      position: fixed;
      inset: 0;
      z-index: var(--z-overlay);
      display: block;
      padding: 0;
      border: 0;
      background: var(--color-overlay-scrim);
      cursor: pointer;
    }
    .shell-main {
      width: 100%;
    }
  }
</style>
