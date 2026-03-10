<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let activeTab = $state<'experiments' | 'assets' | 'knowledge' | 'generate'>('experiments');

	// Generate form state
	let genDescription = $state('');
	let genStyle = $state('');
	let genLoading = $state(false);
	let genResult = $state<{ positive: string; negative: string; params: Record<string, unknown> } | null>(null);

	// Experiment form state
	let expName = $state('');
	let expPositive = $state('');
	let expNegative = $state('low quality, blurry, deformed, ugly, bad anatomy');
	let expCheckpoint = $state('');
	let expVariableField = $state('params.cfg');
	let expVariableValues = $state('5, 7, 9, 12');
	let expRunning = $state(false);

	// Asset search state
	let searchQuery = $state('');
	let searchType = $state('');
	let searchResults = $state<unknown[]>([]);
	let searchLoading = $state(false);
	let downloading = $state<string | null>(null);

	async function generatePrompt() {
		genLoading = true;
		try {
			const res = await fetch('/api/art/generate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'prompt', description: genDescription, style: genStyle || undefined })
			});
			genResult = await res.json();
		} catch (e) {
			console.error('Prompt gen failed:', e);
		}
		genLoading = false;
	}

	async function runExperiment() {
		if (!expPositive || !expCheckpoint) return;
		expRunning = true;
		try {
			const values = expVariableValues.split(',').map(v => {
				const trimmed = v.trim();
				const num = Number(trimmed);
				return isNaN(num) ? trimmed : num;
			});

			await fetch('/api/art/experiments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: expName || 'Quick Experiment',
					positive: expPositive,
					negative: expNegative,
					checkpoint: expCheckpoint,
					variables: [{ field: expVariableField, values }],
					autoRun: true,
					autoEvaluate: true
				})
			});
			// Refresh data
			window.location.reload();
		} catch (e) {
			console.error('Experiment failed:', e);
		}
		expRunning = false;
	}

	async function searchAssets() {
		searchLoading = true;
		try {
			const res = await fetch('/api/art/assets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'search-civitai',
					query: searchQuery,
					type: searchType || undefined,
					limit: 12
				})
			});
			searchResults = await res.json();
		} catch (e) {
			console.error('Search failed:', e);
		}
		searchLoading = false;
	}

	async function downloadAsset(modelId: number, type: string) {
		downloading = String(modelId);
		try {
			await fetch('/api/art/assets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'download-civitai', modelId, type })
			});
			window.location.reload();
		} catch (e) {
			console.error('Download failed:', e);
		}
		downloading = null;
	}

	function formatSize(kb: number): string {
		if (kb > 1_000_000) return `${(kb / 1_000_000).toFixed(1)} GB`;
		if (kb > 1_000) return `${(kb / 1_000).toFixed(1)} MB`;
		return `${kb} KB`;
	}

	function scoreColor(score: number): string {
		if (score >= 4) return 'text-accent-green';
		if (score >= 3) return 'text-accent-yellow';
		return 'text-accent-red';
	}
</script>

<svelte:head>
	<title>Art Lab | ai-playground</title>
</svelte:head>

<div class="p-6 space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-text-primary">Art Lab</h1>
			<p class="text-sm text-text-secondary mt-1">
				AI-driven image generation research with ComfyUI
			</p>
		</div>
		<div class="flex items-center gap-3">
			<span class="flex items-center gap-1.5 text-sm {data.comfyOnline ? 'text-accent-green' : 'text-accent-red'}">
				<span class="w-2 h-2 rounded-full {data.comfyOnline ? 'bg-accent-green' : 'bg-accent-red'}"></span>
				ComfyUI {data.comfyOnline ? 'Online' : 'Offline'}
			</span>
			{#if data.comfyStats?.devices?.[0]}
				{@const dev = data.comfyStats.devices[0]}
				<span class="text-xs text-text-secondary">
					VRAM: {((dev.vram_total - dev.vram_free) / 1e9).toFixed(1)}/{(dev.vram_total / 1e9).toFixed(1)} GB
				</span>
			{/if}
		</div>
	</div>

	<!-- Stats row -->
	<div class="grid grid-cols-4 gap-4">
		<div class="bg-bg-secondary rounded-lg p-4 border border-border">
			<div class="text-2xl font-bold text-text-primary">{data.experiments.length}</div>
			<div class="text-xs text-text-secondary">Experiments</div>
		</div>
		<div class="bg-bg-secondary rounded-lg p-4 border border-border">
			<div class="text-2xl font-bold text-text-primary">{data.summary.totalGenerations}</div>
			<div class="text-xs text-text-secondary">Generations</div>
		</div>
		<div class="bg-bg-secondary rounded-lg p-4 border border-border">
			<div class="text-2xl font-bold text-text-primary">{data.assets.length}</div>
			<div class="text-xs text-text-secondary">Assets</div>
		</div>
		<div class="bg-bg-secondary rounded-lg p-4 border border-border">
			<div class="text-2xl font-bold text-text-primary">{data.knowledge.keywordIndex.length}</div>
			<div class="text-xs text-text-secondary">Keywords Indexed</div>
		</div>
	</div>

	<!-- Tab navigation -->
	<div class="flex gap-1 border-b border-border">
		{#each ['experiments', 'generate', 'assets', 'knowledge'] as tab}
			<button
				class="px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer
					{activeTab === tab
						? 'border-accent-cyan text-accent-cyan'
						: 'border-transparent text-text-secondary hover:text-text-primary'}"
				onclick={() => activeTab = tab as typeof activeTab}
			>
				{tab.charAt(0).toUpperCase() + tab.slice(1)}
			</button>
		{/each}
	</div>

	<!-- Experiments tab -->
	{#if activeTab === 'experiments'}
		<div class="space-y-4">
			<!-- New experiment form -->
			<div class="bg-bg-secondary rounded-lg p-4 border border-border space-y-3">
				<h3 class="text-sm font-semibold text-text-primary">New Experiment</h3>
				<div class="grid grid-cols-2 gap-3">
					<input bind:value={expName} placeholder="Experiment name" class="bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary" />
					<input bind:value={expCheckpoint} placeholder="Checkpoint filename" class="bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary" />
				</div>
				<textarea bind:value={expPositive} placeholder="Positive prompt" rows="2" class="w-full bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary"></textarea>
				<textarea bind:value={expNegative} placeholder="Negative prompt" rows="1" class="w-full bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary"></textarea>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="text-xs text-text-secondary block mb-1">Variable field</label>
						<select bind:value={expVariableField} class="w-full bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary">
							<option value="params.cfg">CFG Scale</option>
							<option value="params.steps">Steps</option>
							<option value="params.sampler">Sampler</option>
							<option value="params.scheduler">Scheduler</option>
							<option value="positive">Positive Prompt</option>
							<option value="checkpoint">Checkpoint</option>
						</select>
					</div>
					<div>
						<label class="text-xs text-text-secondary block mb-1">Values (comma-separated)</label>
						<input bind:value={expVariableValues} placeholder="5, 7, 9, 12" class="w-full bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary" />
					</div>
				</div>
				<button
					onclick={runExperiment}
					disabled={expRunning || !expPositive || !expCheckpoint}
					class="px-4 py-2 bg-accent-cyan text-bg-primary rounded text-sm font-medium hover:opacity-90 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
				>
					{expRunning ? 'Running...' : 'Run Experiment'}
				</button>
			</div>

			<!-- Experiment list -->
			{#if data.experiments.length === 0}
				<div class="text-center py-12 text-text-secondary">
					<p>No experiments yet. Create one above or use the Generate tab to plan one.</p>
				</div>
			{:else}
				<div class="space-y-3">
					{#each data.experiments.toReversed() as exp}
						<div class="bg-bg-secondary rounded-lg p-4 border border-border">
							<div class="flex items-center justify-between mb-2">
								<h3 class="font-medium text-text-primary">{exp.name}</h3>
								<span class="px-2 py-0.5 rounded text-xs font-medium
									{exp.status === 'complete' ? 'bg-accent-green/20 text-accent-green' :
									 exp.status === 'running' ? 'bg-accent-cyan/20 text-accent-cyan' :
									 exp.status === 'failed' ? 'bg-accent-red/20 text-accent-red' :
									 'bg-accent-yellow/20 text-accent-yellow'}">
									{exp.status}
								</span>
							</div>
							<p class="text-xs text-text-secondary mb-2">{exp.hypothesis}</p>
							<div class="flex items-center gap-4 text-xs text-text-secondary">
								<span>{exp.generations.length} generations</span>
								<span>{exp.variables.length} variable{exp.variables.length !== 1 ? 's' : ''}</span>
								{#if exp.generations.length > 0}
									{@const avgScore = exp.generations.reduce((s, g) => s + (g.autoScore ?? g.score ?? 0), 0) / exp.generations.filter(g => g.autoScore ?? g.score).length || 0}
									{#if avgScore > 0}
										<span class={scoreColor(avgScore)}>avg score: {avgScore.toFixed(1)}/5</span>
									{/if}
								{/if}
								<span>{new Date(exp.createdAt).toLocaleDateString()}</span>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Generate tab -->
	{#if activeTab === 'generate'}
		<div class="space-y-4">
			<div class="bg-bg-secondary rounded-lg p-4 border border-border space-y-3">
				<h3 class="text-sm font-semibold text-text-primary">AI Prompt Generator</h3>
				<p class="text-xs text-text-secondary">Describe what you want in natural language. Ollama will generate an optimized SD prompt.</p>
				<textarea bind:value={genDescription} placeholder="e.g. a majestic dragon perched on a crystal mountain at sunset" rows="3" class="w-full bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary"></textarea>
				<div class="flex gap-3">
					<input bind:value={genStyle} placeholder="Style (optional): anime, photorealistic, oil painting..." class="flex-1 bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary" />
					<button
						onclick={generatePrompt}
						disabled={genLoading || !genDescription}
						class="px-4 py-2 bg-accent-purple text-white rounded text-sm font-medium hover:opacity-90 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
					>
						{genLoading ? 'Generating...' : 'Generate Prompt'}
					</button>
				</div>
			</div>

			{#if genResult}
				<div class="bg-bg-secondary rounded-lg p-4 border border-border space-y-3">
					<h3 class="text-sm font-semibold text-accent-green">Generated Prompt</h3>
					<div>
						<label class="text-xs text-text-secondary block mb-1">Positive</label>
						<div class="bg-bg-primary rounded p-3 text-sm text-text-primary font-mono">{genResult.positive}</div>
					</div>
					<div>
						<label class="text-xs text-text-secondary block mb-1">Negative</label>
						<div class="bg-bg-primary rounded p-3 text-sm text-text-secondary font-mono">{genResult.negative}</div>
					</div>
					{#if genResult.params}
						<div class="flex gap-4 text-xs text-text-secondary">
							{#each Object.entries(genResult.params) as [k, v]}
								<span>{k}: <strong class="text-text-primary">{v}</strong></span>
							{/each}
						</div>
					{/if}
					<button
						onclick={() => {
							expPositive = genResult?.positive ?? '';
							expNegative = genResult?.negative ?? '';
							activeTab = 'experiments';
						}}
						class="px-3 py-1.5 bg-accent-cyan/20 text-accent-cyan rounded text-xs font-medium hover:bg-accent-cyan/30 cursor-pointer"
					>
						Use in Experiment
					</button>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Assets tab -->
	{#if activeTab === 'assets'}
		<div class="space-y-4">
			<!-- Search CivitAI -->
			<div class="bg-bg-secondary rounded-lg p-4 border border-border space-y-3">
				<h3 class="text-sm font-semibold text-text-primary">Search CivitAI</h3>
				<div class="flex gap-3">
					<input bind:value={searchQuery} placeholder="Search models, LoRAs..." class="flex-1 bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary" />
					<select bind:value={searchType} class="bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary">
						<option value="">All Types</option>
						<option value="Checkpoint">Checkpoints</option>
						<option value="LORA">LoRAs</option>
						<option value="VAE">VAE</option>
						<option value="TextualInversion">Embeddings</option>
					</select>
					<button
						onclick={searchAssets}
						disabled={searchLoading || !searchQuery}
						class="px-4 py-2 bg-accent-blue text-white rounded text-sm font-medium hover:opacity-90 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
					>
						{searchLoading ? 'Searching...' : 'Search'}
					</button>
				</div>
			</div>

			<!-- Search results -->
			{#if searchResults.length > 0}
				<div class="grid grid-cols-2 lg:grid-cols-3 gap-3">
					{#each searchResults as result}
						{@const r = result as { id: number; name: string; type: string; baseModel: string; triggerWords: string[]; downloadUrl: string; fileName: string; sizeKB: number }}
						<div class="bg-bg-secondary rounded-lg p-3 border border-border">
							<div class="font-medium text-sm text-text-primary truncate">{r.name}</div>
							<div class="flex items-center gap-2 mt-1 text-xs text-text-secondary">
								<span class="px-1.5 py-0.5 rounded bg-bg-primary">{r.type}</span>
								<span>{r.baseModel}</span>
								<span>{formatSize(r.sizeKB)}</span>
							</div>
							{#if r.triggerWords?.length > 0}
								<div class="mt-1 text-xs text-accent-purple truncate">
									{r.triggerWords.join(', ')}
								</div>
							{/if}
							<button
								onclick={() => downloadAsset(r.id, r.type)}
								disabled={downloading === String(r.id)}
								class="mt-2 px-3 py-1 bg-accent-green/20 text-accent-green rounded text-xs font-medium hover:bg-accent-green/30 cursor-pointer disabled:opacity-50"
							>
								{downloading === String(r.id) ? 'Downloading...' : 'Download'}
							</button>
						</div>
					{/each}
				</div>
			{/if}

			<!-- Registered assets -->
			<div>
				<h3 class="text-sm font-semibold text-text-primary mb-3">Registered Assets ({data.assets.length})</h3>
				{#if data.assets.length === 0}
					<p class="text-sm text-text-secondary">No assets registered. Search CivitAI above or place models in F:\models\image\</p>
				{:else}
					<div class="space-y-2">
						{#each data.assets as asset}
							<div class="bg-bg-secondary rounded-lg p-3 border border-border flex items-center justify-between">
								<div>
									<span class="text-sm font-medium text-text-primary">{asset.name}</span>
									<div class="flex items-center gap-2 text-xs text-text-secondary mt-0.5">
										<span class="px-1.5 py-0.5 rounded bg-bg-primary">{asset.type}</span>
										<span>{asset.source}</span>
										<span class="font-mono">{asset.filePath}</span>
										{#if asset.tested}
											<span class="text-accent-green">tested</span>
										{/if}
									</div>
								</div>
								{#if asset.triggerWords.length > 0}
									<div class="text-xs text-accent-purple">{asset.triggerWords.join(', ')}</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Knowledge tab -->
	{#if activeTab === 'knowledge'}
		<div class="space-y-4">
			<!-- Top keywords -->
			{#if data.summary.topKeywords.length > 0}
				<div class="bg-bg-secondary rounded-lg p-4 border border-border">
					<h3 class="text-sm font-semibold text-text-primary mb-3">Top Keywords (by score impact)</h3>
					<div class="flex flex-wrap gap-2">
						{#each data.summary.topKeywords as kw}
							<span class="px-2 py-1 rounded bg-accent-green/10 text-accent-green text-xs font-mono">
								{kw.keyword} <span class="opacity-60">+{kw.impact.toFixed(2)}</span>
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Model profiles -->
			{#if data.knowledge.modelProfiles.length > 0}
				<div class="bg-bg-secondary rounded-lg p-4 border border-border">
					<h3 class="text-sm font-semibold text-text-primary mb-3">Model Profiles</h3>
					<div class="space-y-2">
						{#each data.knowledge.modelProfiles as model}
							<div class="bg-bg-primary rounded p-3">
								<div class="flex items-center justify-between">
									<span class="text-sm font-medium text-text-primary">{model.displayName}</span>
									<span class={scoreColor(model.avgScore)}>{model.avgScore.toFixed(1)}/5 ({model.testCount} tests)</span>
								</div>
								<div class="text-xs text-text-secondary mt-1">
									Best samplers: {model.bestSamplers.join(', ')} | CFG: {model.optimalCfg} | Steps: {model.optimalSteps}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- LoRA profiles -->
			{#if data.knowledge.loraProfiles.length > 0}
				<div class="bg-bg-secondary rounded-lg p-4 border border-border">
					<h3 class="text-sm font-semibold text-text-primary mb-3">LoRA Profiles</h3>
					<div class="space-y-2">
						{#each data.knowledge.loraProfiles as lora}
							<div class="bg-bg-primary rounded p-3">
								<div class="flex items-center justify-between">
									<span class="text-sm font-medium text-text-primary">{lora.displayName}</span>
									<span class={scoreColor(lora.avgScore)}>{lora.avgScore.toFixed(1)}/5 ({lora.testCount} tests)</span>
								</div>
								<div class="text-xs text-text-secondary mt-1">
									Best strength: {lora.bestStrength.toFixed(2)} | Models: {lora.bestModels.join(', ')}
								</div>
								{#if lora.triggerWords.length > 0}
									<div class="text-xs text-accent-purple mt-1">Triggers: {lora.triggerWords.join(', ')}</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Prompt templates -->
			{#if data.knowledge.promptTemplates.length > 0}
				<div class="bg-bg-secondary rounded-lg p-4 border border-border">
					<h3 class="text-sm font-semibold text-text-primary mb-3">Top Prompt Templates</h3>
					<div class="space-y-2">
						{#each data.knowledge.promptTemplates.slice(0, 10) as tmpl}
							<div class="bg-bg-primary rounded p-3">
								<div class="flex items-center justify-between mb-1">
									<span class="text-xs px-1.5 py-0.5 rounded bg-accent-purple/10 text-accent-purple">{tmpl.style}</span>
									<span class={scoreColor(tmpl.avgScore)}>{tmpl.avgScore.toFixed(1)}/5</span>
								</div>
								<p class="text-xs text-text-primary font-mono leading-relaxed">{tmpl.positive}</p>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if data.knowledge.modelProfiles.length === 0 && data.knowledge.loraProfiles.length === 0 && data.knowledge.promptTemplates.length === 0}
				<div class="text-center py-12 text-text-secondary">
					<p>No knowledge yet. Run experiments to build the knowledge base.</p>
				</div>
			{/if}
		</div>
	{/if}
</div>
