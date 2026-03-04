<script lang="ts">
	interface Props {
		columns: { key: string; label: string; mono?: boolean }[];
		rows: Record<string, unknown>[];
		onRowClick?: (row: Record<string, unknown>) => void;
	}

	let { columns, rows, onRowClick }: Props = $props();
</script>

<div class="overflow-x-auto">
	<table class="w-full text-sm">
		<thead>
			<tr class="border-b border-border">
				{#each columns as col}
					<th class="text-left px-3 py-2 text-xs text-text-secondary uppercase tracking-wider font-medium">
						{col.label}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row}
				<tr
					class="border-b border-border/50 hover:bg-bg-tertiary/30 transition-colors {onRowClick ? 'cursor-pointer' : ''}"
					onclick={() => onRowClick?.(row)}
				>
					{#each columns as col}
						<td class="px-3 py-2.5 {col.mono ? 'font-mono text-xs' : ''}">
							{row[col.key] ?? '—'}
						</td>
					{/each}
				</tr>
			{/each}
			{#if rows.length === 0}
				<tr>
					<td colspan={columns.length} class="px-3 py-8 text-center text-text-secondary text-sm">
						No data available
					</td>
				</tr>
			{/if}
		</tbody>
	</table>
</div>
