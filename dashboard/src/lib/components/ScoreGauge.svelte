<script lang="ts">
	interface ScoreBreakdown {
		label: string;
		score: number;
		weight: number;
		detail: string;
	}

	interface Props {
		label: string;
		score: number;
		grade: string;
		breakdown: ScoreBreakdown[];
		accent?: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'cyan';
	}

	let { label, score, grade, breakdown, accent = 'blue' }: Props = $props();

	const gradeColors: Record<string, string> = {
		A: 'text-accent-green',
		B: 'text-accent-cyan',
		C: 'text-accent-yellow',
		D: 'text-accent-red',
		F: 'text-accent-red'
	};

	const barColors: Record<string, string> = {
		A: 'bg-accent-green',
		B: 'bg-accent-cyan',
		C: 'bg-accent-yellow',
		D: 'bg-accent-red',
		F: 'bg-accent-red'
	};

	function scoreColor(s: number): string {
		if (s >= 80) return 'bg-accent-green';
		if (s >= 60) return 'bg-accent-yellow';
		return 'bg-accent-red';
	}

	// SVG arc for the gauge ring
	const radius = 54;
	const circumference = 2 * Math.PI * radius;
	$effect(() => { void score; });
	let dashOffset = $derived(circumference - (score / 100) * circumference);
</script>

<div class="bg-bg-secondary border border-border rounded-lg p-4">
	<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">{label}</h3>

	<!-- Gauge + Grade -->
	<div class="flex items-center gap-4 mb-4">
		<div class="relative w-[128px] h-[128px] shrink-0" role="img" aria-label="{label}: score {score} out of 100, grade {grade}">
			<svg viewBox="0 0 128 128" aria-hidden="true" class="w-full h-full -rotate-90">
				<!-- Background ring -->
				<circle cx="64" cy="64" r={radius} fill="none" stroke="currentColor" stroke-width="8"
					class="text-bg-primary" />
				<!-- Score arc -->
				<circle cx="64" cy="64" r={radius} fill="none" stroke-width="8"
					stroke-linecap="round"
					class={score >= 80 ? 'stroke-accent-green' : score >= 60 ? 'stroke-accent-yellow' : 'stroke-accent-red'}
					stroke-dasharray={circumference}
					stroke-dashoffset={dashOffset} />
			</svg>
			<div class="absolute inset-0 flex flex-col items-center justify-center">
				<span class="text-3xl font-bold font-mono {gradeColors[grade] ?? 'text-text-primary'}">{score}</span>
				<span class="text-xs text-text-secondary">/ 100</span>
			</div>
		</div>
		<div>
			<span class="text-4xl font-bold font-mono {gradeColors[grade] ?? 'text-text-primary'}">{grade}</span>
			<p class="text-xs text-text-secondary mt-1">
				{score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Fair' : score >= 40 ? 'Needs Work' : 'Critical'}
			</p>
		</div>
	</div>

	<!-- Breakdown bars -->
	<div class="space-y-2.5">
		{#each breakdown as item}
			<div>
				<div class="flex items-center justify-between text-xs mb-1">
					<span class="text-text-secondary">{item.label} <span class="text-text-secondary/50">({(item.weight * 100).toFixed(0)}%)</span></span>
					<span class="font-mono text-text-primary">{item.score}</span>
				</div>
				<div class="w-full h-1.5 rounded-full bg-bg-primary overflow-hidden">
					<div class="h-full rounded-full transition-all {scoreColor(item.score)}"
						style="width: {item.score}%"></div>
				</div>
				<p class="text-[10px] text-text-secondary/60 mt-0.5">{item.detail}</p>
			</div>
		{/each}
	</div>
</div>
