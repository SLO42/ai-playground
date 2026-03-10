/**
 * Art Knowledge Base — distills experiment results into actionable
 * knowledge about prompts, keywords, LoRAs, and models.
 *
 * After each experiment batch completes, this module analyzes scores
 * and updates the knowledge base with learned patterns.
 */
import { loadKnowledge, saveKnowledge, loadExperiments } from './art-experiments.js';
import type {
	ArtKnowledge, PromptTemplate, KeywordEntry,
	LoraProfile, ModelProfile, Experiment, Generation
} from '$lib/types/art.js';

// ── Keyword extraction ───────────────────────────────────────────────

/** Extract individual prompt keywords from a comma-separated prompt string. */
function extractKeywords(prompt: string): string[] {
	return prompt
		.split(',')
		.map(k => k.trim().toLowerCase())
		.filter(k => k.length > 1);
}

// ── Knowledge distillation ───────────────────────────────────────────

/** Analyze a completed experiment and update the knowledge base. */
export async function distillExperiment(experiment: Experiment): Promise<ArtKnowledge> {
	if (experiment.status !== 'complete' || experiment.generations.length === 0) {
		return loadKnowledge();
	}

	const knowledge = await loadKnowledge();
	const scored = experiment.generations.filter(g => g.autoScore != null || g.score != null);
	if (scored.length === 0) return knowledge;

	// Update keyword index
	updateKeywordIndex(knowledge, scored);

	// Update model profiles
	updateModelProfiles(knowledge, scored);

	// Update LoRA profiles
	updateLoraProfiles(knowledge, scored);

	// Update prompt templates (top-scoring prompts become templates)
	updatePromptTemplates(knowledge, scored);

	await saveKnowledge(knowledge);
	return knowledge;
}

function getScore(gen: Generation): number {
	return gen.score ?? gen.autoScore ?? 3;
}

// ── Keyword analysis ─────────────────────────────────────────────────

function updateKeywordIndex(knowledge: ArtKnowledge, generations: Generation[]): void {
	// Calculate baseline avg score
	const avgScore = generations.reduce((s, g) => s + getScore(g), 0) / generations.length;

	// Extract keywords and their score impacts
	const keywordScores = new Map<string, { total: number; count: number; models: Set<string> }>();

	for (const gen of generations) {
		const score = getScore(gen);
		const keywords = extractKeywords(gen.positive);

		for (const kw of keywords) {
			const entry = keywordScores.get(kw) ?? { total: 0, count: 0, models: new Set() };
			entry.total += score;
			entry.count++;
			entry.models.add(gen.checkpoint);
			keywordScores.set(kw, entry);
		}
	}

	// Merge into existing knowledge
	for (const [keyword, stats] of keywordScores) {
		const kwAvg = stats.total / stats.count;
		const impact = kwAvg - avgScore;
		const effect: KeywordEntry['effect'] =
			impact > 0.3 ? 'positive' : impact < -0.3 ? 'negative' : 'neutral';

		const existing = knowledge.keywordIndex.find(k => k.keyword === keyword);
		if (existing) {
			// Weighted merge
			const totalSamples = existing.sampleCount + stats.count;
			existing.avgScoreImpact =
				(existing.avgScoreImpact * existing.sampleCount + impact * stats.count) / totalSamples;
			existing.sampleCount = totalSamples;
			existing.effect = existing.avgScoreImpact > 0.3 ? 'positive'
				: existing.avgScoreImpact < -0.3 ? 'negative' : 'neutral';
			for (const m of stats.models) {
				if (!existing.models.includes(m)) existing.models.push(m);
			}
		} else {
			knowledge.keywordIndex.push({
				keyword,
				effect,
				models: [...stats.models],
				avgScoreImpact: impact,
				sampleCount: stats.count
			});
		}
	}

	// Sort by impact
	knowledge.keywordIndex.sort((a, b) => b.avgScoreImpact - a.avgScoreImpact);
}

// ── Model profiling ──────────────────────────────────────────────────

function updateModelProfiles(knowledge: ArtKnowledge, generations: Generation[]): void {
	const byModel = new Map<string, Generation[]>();
	for (const gen of generations) {
		const list = byModel.get(gen.checkpoint) ?? [];
		list.push(gen);
		byModel.set(gen.checkpoint, list);
	}

	for (const [checkpoint, gens] of byModel) {
		const avgScore = gens.reduce((s, g) => s + getScore(g), 0) / gens.length;
		const samplerCounts = new Map<string, number>();
		const cfgValues: number[] = [];
		const stepValues: number[] = [];

		for (const gen of gens) {
			samplerCounts.set(gen.params.sampler, (samplerCounts.get(gen.params.sampler) ?? 0) + 1);
			cfgValues.push(gen.params.cfg);
			stepValues.push(gen.params.steps);
		}

		// Find best sampler
		const bestSamplers = [...samplerCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([s]) => s);

		const existing = knowledge.modelProfiles.find(m => m.name === checkpoint);
		if (existing) {
			const totalTests = existing.testCount + gens.length;
			existing.avgScore =
				(existing.avgScore * existing.testCount + avgScore * gens.length) / totalTests;
			existing.testCount = totalTests;
			existing.bestSamplers = bestSamplers;
			existing.optimalCfg = median(cfgValues);
			existing.optimalSteps = median(stepValues);
		} else {
			knowledge.modelProfiles.push({
				name: checkpoint,
				displayName: checkpoint.replace(/\.[^.]+$/, ''),
				baseType: 'unknown',
				strengths: [],
				weaknesses: [],
				bestSamplers,
				optimalCfg: median(cfgValues),
				optimalSteps: median(stepValues),
				avgScore,
				testCount: gens.length
			});
		}
	}
}

// ── LoRA profiling ───────────────────────────────────────────────────

function updateLoraProfiles(knowledge: ArtKnowledge, generations: Generation[]): void {
	const byLora = new Map<string, Generation[]>();
	for (const gen of generations) {
		for (const lora of gen.loras) {
			const list = byLora.get(lora.name) ?? [];
			list.push(gen);
			byLora.set(lora.name, list);
		}
	}

	for (const [loraName, gens] of byLora) {
		const avgScore = gens.reduce((s, g) => s + getScore(g), 0) / gens.length;
		const strengths = gens.flatMap(g => g.loras.filter(l => l.name === loraName).map(l => l.strength));
		const bestStrength = median(strengths);
		const models = [...new Set(gens.map(g => g.checkpoint))];
		const lora = gens[0].loras.find(l => l.name === loraName);

		const existing = knowledge.loraProfiles.find(l => l.name === loraName);
		if (existing) {
			const totalTests = existing.testCount + gens.length;
			existing.avgScore =
				(existing.avgScore * existing.testCount + avgScore * gens.length) / totalTests;
			existing.testCount = totalTests;
			existing.bestStrength = bestStrength;
			existing.bestModels = models;
		} else {
			knowledge.loraProfiles.push({
				name: loraName,
				displayName: loraName.replace(/\.[^.]+$/, ''),
				triggerWords: lora?.triggerWords ?? [],
				bestModels: models,
				bestStrength,
				bestCfg: median(gens.map(g => g.params.cfg)),
				bestSampler: gens[0].params.sampler,
				avgScore,
				testCount: gens.length,
				examplePrompts: gens.slice(0, 3).map(g => g.positive)
			});
		}
	}
}

// ── Prompt template collection ───────────────────────────────────────

function updatePromptTemplates(knowledge: ArtKnowledge, generations: Generation[]): void {
	// Only promote high-scoring prompts as templates
	const threshold = 3.5;
	const topGens = generations.filter(g => getScore(g) >= threshold);

	for (const gen of topGens) {
		const existing = knowledge.promptTemplates.find(t => t.positive === gen.positive);
		if (existing) {
			existing.useCount++;
			existing.avgScore = (existing.avgScore * (existing.useCount - 1) + getScore(gen)) / existing.useCount;
		} else if (knowledge.promptTemplates.length < 100) {
			knowledge.promptTemplates.push({
				id: gen.id,
				name: gen.positive.slice(0, 50),
				positive: gen.positive,
				negative: gen.negative,
				style: detectStyle(gen.positive),
				avgScore: getScore(gen),
				useCount: 1
			});
		}
	}

	// Sort by score and trim
	knowledge.promptTemplates.sort((a, b) => b.avgScore - a.avgScore);
	if (knowledge.promptTemplates.length > 100) {
		knowledge.promptTemplates = knowledge.promptTemplates.slice(0, 100);
	}
}

function detectStyle(prompt: string): string {
	const lower = prompt.toLowerCase();
	if (/anime|manga|2d|danbooru/.test(lower)) return 'anime';
	if (/photo|realistic|raw|dslr/.test(lower)) return 'photorealistic';
	if (/oil.?paint|canvas|brush/.test(lower)) return 'oil_painting';
	if (/watercolor/.test(lower)) return 'watercolor';
	if (/pixel.?art|8.?bit/.test(lower)) return 'pixel_art';
	if (/3d|render|blender/.test(lower)) return '3d_render';
	return 'general';
}

// ── Summary / insights ───────────────────────────────────────────────

export interface KnowledgeSummary {
	totalExperiments: number;
	totalGenerations: number;
	topKeywords: { keyword: string; impact: number }[];
	topModels: { name: string; avgScore: number }[];
	topLoras: { name: string; avgScore: number }[];
	topTemplates: { name: string; avgScore: number }[];
}

/** Get a summary of current knowledge for display or AI context. */
export async function getKnowledgeSummary(): Promise<KnowledgeSummary> {
	const [knowledge, experiments] = await Promise.all([
		loadKnowledge(),
		loadExperiments()
	]);

	const totalGenerations = experiments.reduce(
		(sum, e) => sum + e.generations.length, 0
	);

	return {
		totalExperiments: experiments.length,
		totalGenerations,
		topKeywords: knowledge.keywordIndex
			.filter(k => k.effect === 'positive')
			.slice(0, 10)
			.map(k => ({ keyword: k.keyword, impact: k.avgScoreImpact })),
		topModels: knowledge.modelProfiles
			.sort((a, b) => b.avgScore - a.avgScore)
			.slice(0, 5)
			.map(m => ({ name: m.displayName, avgScore: m.avgScore })),
		topLoras: knowledge.loraProfiles
			.sort((a, b) => b.avgScore - a.avgScore)
			.slice(0, 5)
			.map(l => ({ name: l.displayName, avgScore: l.avgScore })),
		topTemplates: knowledge.promptTemplates
			.slice(0, 5)
			.map(t => ({ name: t.name, avgScore: t.avgScore }))
	};
}

// ── Utils ────────────────────────────────────────────────────────────

function median(arr: number[]): number {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
