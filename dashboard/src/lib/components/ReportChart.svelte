<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Chart,
		LineController,
		BarController,
		LineElement,
		BarElement,
		PointElement,
		LinearScale,
		CategoryScale,
		Filler,
		Tooltip,
		Legend
	} from 'chart.js';

	Chart.register(
		LineController,
		BarController,
		LineElement,
		BarElement,
		PointElement,
		LinearScale,
		CategoryScale,
		Filler,
		Tooltip,
		Legend
	);

	interface Dataset {
		label: string;
		data: number[];
		color?: string;
		type?: 'line' | 'bar';
		fill?: boolean;
		yAxisID?: string;
	}

	let {
		labels,
		datasets,
		title = '',
		height = 220,
		yLabel = '',
		y2Label = ''
	}: {
		labels: string[];
		datasets: Dataset[];
		title?: string;
		height?: number;
		yLabel?: string;
		y2Label?: string;
	} = $props();

	let canvas: HTMLCanvasElement;
	let chart: Chart | null = null;

	const defaultColors = ['#3b82f6', '#22c55e', '#a855f7', '#06b6d4', '#eab308', '#ef4444'];

	function buildChart() {
		if (chart) chart.destroy();
		if (!canvas) return;

		// Clone data to avoid Chart.js mutating Svelte $state proxies
		const plainLabels = [...labels];
		const plainDatasets = datasets.map(d => ({ ...d, data: [...d.data] }));
		const hasY2 = plainDatasets.some((d) => d.yAxisID === 'y2');

		chart = new Chart(canvas, {
			type: 'line',
			data: {
				labels: plainLabels,
				datasets: plainDatasets.map((ds, i) => ({
					label: ds.label,
					data: ds.data,
					type: ds.type ?? 'line',
					borderColor: ds.color ?? defaultColors[i % defaultColors.length],
					backgroundColor: ds.fill
						? (ds.color ?? defaultColors[i % defaultColors.length]) + '18'
						: (ds.color ?? defaultColors[i % defaultColors.length]) + '80',
					borderWidth: ds.type === 'bar' ? 0 : 2,
					pointRadius: ds.type === 'bar' ? 0 : 3,
					pointHoverRadius: ds.type === 'bar' ? 0 : 5,
					fill: ds.fill ?? false,
					tension: 0.3,
					yAxisID: ds.yAxisID ?? 'y'
				}))
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				interaction: { mode: 'index', intersect: false },
				plugins: {
					legend: {
						display: datasets.length > 1,
						position: 'bottom',
						labels: { color: '#94a3b8', boxWidth: 12, padding: 16, font: { size: 11 } }
					},
					tooltip: {
						backgroundColor: '#1e293b',
						titleColor: '#e2e8f0',
						bodyColor: '#cbd5e1',
						borderColor: '#334155',
						borderWidth: 1,
						padding: 10,
						cornerRadius: 8
					}
				},
				scales: {
					x: {
						ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 45 },
						grid: { color: '#1e293b' }
					},
					y: {
						beginAtZero: true,
						ticks: { color: '#64748b', font: { size: 10 } },
						grid: { color: '#1e293b' },
						title: yLabel ? { display: true, text: yLabel, color: '#64748b', font: { size: 10 } } : undefined
					},
					...(hasY2
						? {
								y2: {
									position: 'right' as const,
									beginAtZero: true,
									ticks: { color: '#64748b', font: { size: 10 } },
									grid: { drawOnChartArea: false },
									title: y2Label
										? { display: true, text: y2Label, color: '#64748b', font: { size: 10 } }
										: undefined
								}
							}
						: {})
				}
			}
		});
	}

	onMount(() => {
		buildChart();
		return () => chart?.destroy();
	});

	$effect(() => {
		void labels;
		void datasets;
		buildChart();
	});
</script>

<div class="bg-bg-secondary border border-border rounded-lg p-4">
	{#if title}
		<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">{title}</h3>
	{/if}
	<div style="height: {height}px">
		<canvas bind:this={canvas}></canvas>
	</div>
</div>
