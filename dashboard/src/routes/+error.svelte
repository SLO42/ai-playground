<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="flex items-center justify-center min-h-[60vh]">
	<div class="text-center">
		<p class="text-6xl font-bold font-mono text-accent-blue mb-2">{page.status}</p>
		<h1 class="text-xl font-bold text-text-primary mb-2">
			{#if page.status === 404}
				Page not found
			{:else if page.status === 500}
				Server error
			{:else}
				Something went wrong
			{/if}
		</h1>
		<p class="text-sm text-text-secondary mb-6">{page.error?.message ?? 'An unexpected error occurred.'}</p>
		<a
			href="/"
			class="inline-block px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
		>
			Back to Home
		</a>
	</div>
</div>
