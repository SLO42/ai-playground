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

  // Open the one SSE stream once, in the browser only ($effect never runs on the
  // server). The Topbar/Statusbar read `stream.connection` reactively (D-019).
  $effect(() => {
    stream.start();
    return () => stream.stop();
  });
</script>

<div class="shell">
  <Sidebar {pathname} />
  <div class="shell-main">
    <Topbar {breadcrumb} connection={stream.connection} />
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
</style>
