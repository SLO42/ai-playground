<script lang="ts">
	interface Props {
		lines?: number;
		height?: string;
		width?: string;
		variant?: 'text' | 'card' | 'metric' | 'table';
	}
	let { lines = 3, height = '1rem', width = '100%', variant = 'text' }: Props = $props();

	const lineWidths = ['100%', '92%', '76%', '85%', '60%', '88%', '70%', '95%'];
</script>

{#if variant === 'text'}
	<div class="space-y-2" style="width: {width}">
		{#each Array(lines) as _, i}
			<div
				class="animate-pulse rounded bg-bg-tertiary"
				style="height: {height}; width: {lineWidths[i % lineWidths.length]}"
			></div>
		{/each}
	</div>

{:else if variant === 'card'}
	<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3" style="width: {width}">
		<div class="animate-pulse rounded bg-bg-tertiary h-4 w-2/5"></div>
		<div class="space-y-2">
			{#each Array(lines) as _, i}
				<div
					class="animate-pulse rounded bg-bg-tertiary"
					style="height: {height}; width: {lineWidths[i % lineWidths.length]}"
				></div>
			{/each}
		</div>
	</div>

{:else if variant === 'metric'}
	<div class="bg-bg-secondary border border-border rounded-lg p-4" style="width: {width}">
		<div class="animate-pulse rounded bg-bg-tertiary h-3 w-24 mb-2"></div>
		<div class="animate-pulse rounded bg-bg-tertiary h-8 w-16 mb-1"></div>
		<div class="animate-pulse rounded bg-bg-tertiary h-3 w-20 mt-1"></div>
	</div>

{:else if variant === 'table'}
	<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden" style="width: {width}">
		<!-- Header -->
		<div class="flex gap-4 px-4 py-3 border-b border-border">
			<div class="animate-pulse rounded bg-bg-tertiary h-3 w-28"></div>
			<div class="animate-pulse rounded bg-bg-tertiary h-3 w-20"></div>
			<div class="animate-pulse rounded bg-bg-tertiary h-3 w-16 ml-auto"></div>
			<div class="animate-pulse rounded bg-bg-tertiary h-3 w-20"></div>
		</div>
		<!-- Rows -->
		{#each Array(lines) as _, i}
			<div class="flex gap-4 px-4 py-3 {i < lines - 1 ? 'border-b border-border' : ''}">
				<div class="animate-pulse rounded bg-bg-tertiary h-3 w-32"></div>
				<div class="animate-pulse rounded bg-bg-tertiary h-3 w-16"></div>
				<div class="animate-pulse rounded bg-bg-tertiary h-3 w-12 ml-auto"></div>
				<div class="animate-pulse rounded bg-bg-tertiary h-3 w-16"></div>
			</div>
		{/each}
	</div>
{/if}
