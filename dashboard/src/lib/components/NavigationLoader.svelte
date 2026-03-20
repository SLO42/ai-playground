<script lang="ts">
	import { navigating } from '$app/state';
</script>

{#if navigating.to}
	<div class="fixed top-0 left-0 right-0 z-[100] h-0.5 bg-accent-cyan/30">
		<div class="h-full bg-accent-cyan animate-pulse" style="width: 70%"></div>
	</div>
{/if}
