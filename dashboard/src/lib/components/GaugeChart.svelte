<script lang="ts">
	interface Props {
		value: number;
		max?: number;
		label: string;
		color?: string;
		size?: number;
	}

	let { value, max = 100, label, color = '#3b82f6', size = 120 }: Props = $props();

	let pct = $derived(Math.min(value / max, 1));
	let radius = $derived((size - 12) / 2);
	let circumference = $derived(Math.PI * radius);
	let offset = $derived(circumference * (1 - pct));
	let displayValue = $derived(Math.round(pct * 100));
</script>

<div class="flex flex-col items-center gap-1">
	<svg width={size} height={size / 2 + 10} viewBox="0 0 {size} {size / 2 + 10}">
		<path
			d="M 6 {size / 2 + 4} A {radius} {radius} 0 0 1 {size - 6} {size / 2 + 4}"
			fill="none"
			stroke="#2a2a4a"
			stroke-width="8"
			stroke-linecap="round"
		/>
		<path
			d="M 6 {size / 2 + 4} A {radius} {radius} 0 0 1 {size - 6} {size / 2 + 4}"
			fill="none"
			stroke={color}
			stroke-width="8"
			stroke-linecap="round"
			stroke-dasharray="{circumference}"
			stroke-dashoffset="{offset}"
		/>
		<text x="{size / 2}" y="{size / 2 - 2}" text-anchor="middle" fill={color} font-size="20" font-weight="bold" font-family="monospace">
			{displayValue}%
		</text>
	</svg>
	<span class="text-xs text-text-secondary">{label}</span>
</div>
