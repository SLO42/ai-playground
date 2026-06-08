<script lang="ts">
  import '$lib/styles/app.css';
  import Sidebar from '$lib/components/shell/Sidebar.svelte';
  import Topbar from '$lib/components/shell/Topbar.svelte';
  import Statusbar from '$lib/components/shell/Statusbar.svelte';
  import { stream } from '$lib/client/stream.svelte';
  import { page } from '$app/state';

  let { children } = $props();
  const pathname = $derived(page.url.pathname);

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
    pathname;
    navOpen = false;
  });

  // Open the one SSE stream once, in the browser only ($effect never runs on the
  // server). The Topbar/Statusbar read `stream.connection` reactively (D-019).
  $effect(() => {
    stream.start();
    return () => stream.stop();
  });
</script>

<div class="shell" class:nav-open={navOpen}>
  <!-- Backdrop: only interactive while the drawer is open (narrow viewports). -->
  <button
    type="button"
    class="scrim"
    aria-label="Close navigation"
    tabindex={navOpen ? 0 : -1}
    hidden={!navOpen}
    onclick={() => (navOpen = false)}
  ></button>
  <Sidebar {pathname} open={navOpen} onnavigate={() => (navOpen = false)} />
  <div class="shell-main">
    <Topbar
      {breadcrumb}
      connection={stream.connection}
      navOpen={navOpen}
      ontoggleNav={() => (navOpen = !navOpen)}
    />
    <main class="content">
      {@render children?.()}
    </main>
    <Statusbar />
  </div>
</div>

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
    padding: var(--pad-panel);
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
