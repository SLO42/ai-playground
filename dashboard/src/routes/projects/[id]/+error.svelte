<script lang="ts">
	import { page } from '$app/state';

	const is404 = $derived(page.status === 404);
	const heading = $derived(is404 ? 'Page not found' : 'This project page encountered an error');
	const statusColor = $derived(is404 ? 'text-accent-cyan' : 'text-accent-red');
</script>

<div class="flex items-center justify-center min-h-[40vh]">
	<div
		class="max-w-md w-full mx-4 p-8 bg-bg-secondary border border-border rounded-2xl text-center"
	>
		<p class="text-7xl font-bold font-mono {statusColor} mb-4">{page.status}</p>

		<h1 class="text-xl font-semibold text-text-primary mb-2">{heading}</h1>

		<p class="text-sm text-text-secondary mb-8">
			{page.error?.message ?? 'An unexpected error occurred.'}
		</p>

		<div class="flex items-center justify-center gap-3">
			<a
				href="/projects"
				class="px-5 py-2 text-sm font-medium bg-accent-cyan text-bg-primary rounded-lg hover:bg-accent-cyan/85 transition-colors"
			>
				Back to Projects
			</a>
			<button
				onclick={() => location.reload()}
				class="px-5 py-2 text-sm font-medium border border-border text-text-primary rounded-lg hover:bg-bg-primary transition-colors"
			>
				Try Again
			</button>
		</div>
	</div>
</div>
