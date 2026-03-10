/**
 * Art Brain — the autonomous orchestrator for image generation testing.
 *
 * The brain uses the local Ollama model (GPT-OSS 20B) to:
 *   1. Research every asset before testing (via art-researcher)
 *   2. Analyze research and decide what to test & how
 *   3. Craft prompts that maximize each model/lora/upscaler's strengths
 *   4. Create and execute bulk experiment batches
 *   5. Track what's been tested and what hasn't
 *
 * The brain is the ONLY decision-maker. It reads research, reasons about
 * what tests to run, and outputs concrete experiment configurations.
 * All reasoning happens through Ollama — no hardcoded prompt logic.
 */
import { APIS } from './constants.js';
import { loadAssets, loadExperiments, saveAssets } from './art-experiments.js';
import { runExperiment, createQuickExperiment } from './art-experiments.js';
import { getComfyModels } from './art-assets.js';
import { researchAsset, type AssetResearch } from './art-researcher.js';
import { loadKnowledge, saveKnowledge } from './art-experiments.js';
import type {
	ArtAsset, Experiment, ExperimentVariable,
	LoraRef, GenerationParams
} from '$lib/types/art.js';

// ── Config ───────────────────────────────────────────────────────────

const OLLAMA_URL = APIS.ollama;
const BRAIN_MODEL = 'gpt-oss:20b';

interface OllamaGenerateResponse {
	response: string;
	done: boolean;
}

async function think(prompt: string, system: string, temperature = 0.4): Promise<string> {
	const res = await fetch(`${OLLAMA_URL}/api/generate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: BRAIN_MODEL,
			prompt,
			system,
			stream: false,
			options: { temperature, num_predict: 4096 }
		}),
		signal: AbortSignal.timeout(180_000) // 3 min for complex reasoning
	});
	if (!res.ok) throw new Error(`Brain model error: ${res.status}`);
	const data = (await res.json()) as OllamaGenerateResponse;
	return data.response;
}

function extractJson<T>(raw: string): T | null {
	// Try array first, then object
	const arrMatch = raw.match(/\[[\s\S]*\]/);
	if (arrMatch) {
		try { return JSON.parse(arrMatch[0]) as T; } catch { /* fall through */ }
	}
	const objMatch = raw.match(/\{[\s\S]*\}/);
	if (objMatch) {
		try { return JSON.parse(objMatch[0]) as T; } catch { /* fall through */ }
	}
	return null;
}

// ── Research cache ───────────────────────────────────────────────────

const researchCache = new Map<string, AssetResearch>();

async function getResearch(asset: ArtAsset): Promise<AssetResearch> {
	const cached = researchCache.get(asset.id);
	if (cached) return cached;

	const research = await researchAsset(asset);
	researchCache.set(asset.id, research);
	return research;
}

// ── Brain: analyze research and create test plans ────────────────────

const ANALYZE_SYSTEM = `You are an expert AI art researcher. You have been given research data about a Stable Diffusion model/LoRA/upscaler. Your job is to analyze this data and create a comprehensive test plan.

You must output ONLY a JSON object with these fields:
- testSets: array of test configurations to run. Each has:
  - name: short descriptive name for this test set
  - purpose: what this test set is testing (1 sentence)
  - positive: the positive prompt to use (be specific, use the trigger words correctly)
  - negative: the negative prompt
  - variableField: which parameter to vary ("params.cfg", "params.steps", "params.sampler", "positive")
  - variableValues: array of values to test for that field
  - fixedParams: { cfg, steps, sampler, scheduler, width, height } — the fixed parameters for this set

Rules:
- ALWAYS include trigger words in the positive prompt exactly as specified
- Use quality boosters appropriate for the model's base type (SDXL vs SD1.5 vs Pony vs Flux)
- For SDXL: use "masterpiece, best quality, highly detailed" style boosters
- For SD1.5: use "(masterpiece:1.2), best quality" with emphasis weights
- For Pony: use "score_9, score_8_up, score_7_up" quality tags
- For Flux: minimal quality tags needed, focus on descriptive natural language
- Test at least: different CFG values, different step counts, different subjects/scenes
- For LoRAs: also test different strength values using the "loras[0].strength" field
- For character LoRAs: test the character in different poses, settings, expressions
- For style LoRAs: test different subjects with the style applied
- For upscalers: just note the recommended settings (testing happens post-generation)
- Each test set should produce 3-8 images (3-8 variable values)
- Craft prompts that would produce HIGH QUALITY, DETAILED, ACCURATE images
- Use the community prompts as inspiration but create your OWN optimized versions
- Be creative with test subjects: characters, landscapes, portraits, action scenes

Output ONLY the JSON.`;

interface TestSet {
	name: string;
	purpose: string;
	positive: string;
	negative: string;
	variableField: string;
	variableValues: (string | number)[];
	fixedParams: Partial<GenerationParams>;
}

interface AnalysisResult {
	testSets: TestSet[];
}

/**
 * Have the brain analyze research data and produce test plans.
 * This is where all the intelligence lives — Ollama decides what to test.
 */
async function analyzeAndPlan(
	research: AssetResearch,
	availableCheckpoints: string[],
	availableSamplers: string[]
): Promise<AnalysisResult> {
	// Build the context the brain needs
	const topPrompts = research.communityPrompts
		.slice(0, 8)
		.map((p, i) => `  ${i + 1}. [score:${p.score ?? '?'}] "${p.positive.slice(0, 200)}" (cfg:${p.cfg}, steps:${p.steps}, sampler:${p.sampler})`)
		.join('\n');

	const pairings = research.commonPairings
		.slice(0, 5)
		.map(p => `  - ${p.type}: ${p.name} (used ${p.frequency} times)`)
		.join('\n');

	const context = [
		`=== ASSET: ${research.name} ===`,
		`Type: ${research.type}`,
		`Base model: ${research.baseModel}`,
		`Tags: ${research.tags.join(', ')}`,
		``,
		`=== CREATOR DESCRIPTION ===`,
		research.description.slice(0, 1000),
		``,
		`=== RECOMMENDED SETTINGS ===`,
		`Trigger words: ${research.recommended.triggerWords.join(', ') || 'none'}`,
		`CFG: ${research.recommended.cfg ?? 'not specified'}`,
		`Steps: ${research.recommended.steps ?? 'not specified'}`,
		`Sampler: ${research.recommended.sampler ?? 'not specified'}`,
		`Resolution: ${research.recommended.width ?? '?'}x${research.recommended.height ?? '?'}`,
		research.recommended.strength != null ? `LoRA strength: ${research.recommended.strength}` : '',
		research.recommended.negativePrompt ? `Negative: ${research.recommended.negativePrompt.slice(0, 300)}` : '',
		``,
		`=== TOP COMMUNITY PROMPTS (sorted by popularity) ===`,
		topPrompts || '  (no community prompts available)',
		``,
		`=== COMMONLY PAIRED WITH ===`,
		pairings || '  (no pairing data)',
		``,
		`=== AVAILABLE IN COMFYUI ===`,
		`Checkpoints: ${availableCheckpoints.slice(0, 10).join(', ')}`,
		`Samplers: ${availableSamplers.join(', ')}`,
		``,
		`Create 3-5 comprehensive test sets for this ${research.type}. Each test set should generate 4-6 images by varying one parameter.`
	].filter(Boolean).join('\n');

	const raw = await think(context, ANALYZE_SYSTEM);
	const result = extractJson<AnalysisResult>(raw);

	if (!result?.testSets?.length) {
		// Fallback: create a basic test plan from the research data
		return createFallbackPlan(research, availableSamplers);
	}

	return result;
}

/** Fallback plan if Ollama fails to produce valid JSON. */
function createFallbackPlan(
	research: AssetResearch,
	availableSamplers: string[]
): AnalysisResult {
	const triggers = research.recommended.triggerWords.join(', ');
	const basePositive = triggers
		? `${triggers}, masterpiece, best quality, highly detailed`
		: 'masterpiece, best quality, highly detailed, 1girl, portrait';
	const baseNegative = research.recommended.negativePrompt
		?? 'low quality, blurry, deformed, ugly, bad anatomy, bad hands, extra fingers';

	const cfg = research.recommended.cfg ?? 7;
	const steps = research.recommended.steps ?? 25;
	const sampler = research.recommended.sampler ?? 'euler_a';
	const width = research.recommended.width ?? 1024;
	const height = research.recommended.height ?? 1024;

	const testSets: TestSet[] = [
		{
			name: 'CFG sweep',
			purpose: `Find optimal CFG for ${research.name}`,
			positive: basePositive,
			negative: baseNegative,
			variableField: 'params.cfg',
			variableValues: [4, 5, 7, 9, 12],
			fixedParams: { steps, sampler, scheduler: 'normal', width, height }
		},
		{
			name: 'Steps sweep',
			purpose: `Find optimal step count for ${research.name}`,
			positive: basePositive,
			negative: baseNegative,
			variableField: 'params.steps',
			variableValues: [15, 20, 25, 35, 50],
			fixedParams: { cfg, sampler, scheduler: 'normal', width, height }
		},
		{
			name: 'Sampler comparison',
			purpose: `Find best sampler for ${research.name}`,
			positive: basePositive,
			negative: baseNegative,
			variableField: 'params.sampler',
			variableValues: availableSamplers.slice(0, 6),
			fixedParams: { cfg, steps, scheduler: 'normal', width, height }
		}
	];

	// For LoRAs, add a strength test
	if (research.type === 'lora') {
		testSets.push({
			name: 'Strength sweep',
			purpose: `Find optimal LoRA weight for ${research.name}`,
			positive: basePositive,
			negative: baseNegative,
			variableField: 'loras[0].strength',
			variableValues: [0.4, 0.6, 0.8, 1.0, 1.2],
			fixedParams: { cfg, steps, sampler, scheduler: 'normal', width, height }
		});
	}

	return { testSets };
}

// ── Brain: convert test plans into experiments ───────────────────────

function testSetToExperiment(
	testSet: TestSet,
	checkpoint: string,
	loras: LoraRef[],
	assetName: string
): Experiment {
	return createQuickExperiment({
		name: `[${assetName}] ${testSet.name}`,
		positive: testSet.positive,
		negative: testSet.negative,
		checkpoint,
		loras,
		variables: [{
			field: testSet.variableField,
			values: testSet.variableValues
		}],
		params: testSet.fixedParams
	});
}

// ── Brain: autonomous test runner ────────────────────────────────────

export interface BrainProgress {
	phase: 'researching' | 'planning' | 'generating' | 'complete' | 'error';
	assetName: string;
	testSetIndex: number;
	totalTestSets: number;
	totalImages: number;
	completedImages: number;
	currentTestSet?: string;
	error?: string;
}

// In-memory progress tracking
const brainProgressMap = new Map<string, BrainProgress>();

export function getBrainProgress(runId: string): BrainProgress | undefined {
	return brainProgressMap.get(runId);
}

/**
 * Test a single asset autonomously:
 *   1. Research how it's used
 *   2. Ask Ollama to create test plans based on the research
 *   3. Execute all test sets as experiments
 *
 * Returns the experiments that were created and run.
 */
export async function testAsset(
	asset: ArtAsset,
	opts?: {
		runId?: string;
		checkpoint?: string; // override checkpoint for LoRA testing
		onProgress?: (p: BrainProgress) => void;
	}
): Promise<Experiment[]> {
	const runId = opts?.runId ?? asset.id;
	const progress: BrainProgress = {
		phase: 'researching',
		assetName: asset.name,
		testSetIndex: 0,
		totalTestSets: 0,
		totalImages: 0,
		completedImages: 0
	};
	brainProgressMap.set(runId, progress);
	opts?.onProgress?.(progress);

	try {
		// Phase 1: Research
		const research = await getResearch(asset);

		// Phase 2: Plan
		progress.phase = 'planning';
		opts?.onProgress?.(progress);

		const comfyModels = await getComfyModels();
		const analysis = await analyzeAndPlan(
			research,
			comfyModels.checkpoints,
			comfyModels.samplers
		);

		// Determine checkpoint to use
		let checkpoint = opts?.checkpoint ?? '';
		if (!checkpoint) {
			if (asset.type === 'checkpoint') {
				checkpoint = asset.filePath;
			} else {
				// For LoRAs/etc, pick a compatible checkpoint
				checkpoint = pickCompatibleCheckpoint(
					research.baseModel,
					comfyModels.checkpoints
				);
			}
		}

		if (!checkpoint) {
			throw new Error(`No compatible checkpoint found for ${asset.name} (base: ${research.baseModel})`);
		}

		// Build LoRA refs if testing a LoRA
		const loras: LoraRef[] = [];
		if (asset.type === 'lora') {
			loras.push({
				name: asset.filePath,
				strength: research.recommended.strength ?? 0.8,
				triggerWords: research.recommended.triggerWords
			});
		}

		// Phase 3: Generate
		progress.phase = 'generating';
		progress.totalTestSets = analysis.testSets.length;
		progress.totalImages = analysis.testSets.reduce(
			(sum, ts) => sum + ts.variableValues.length, 0
		);
		opts?.onProgress?.(progress);

		const experiments: Experiment[] = [];

		for (let i = 0; i < analysis.testSets.length; i++) {
			const testSet = analysis.testSets[i];
			progress.testSetIndex = i;
			progress.currentTestSet = testSet.name;
			opts?.onProgress?.(progress);

			const experiment = testSetToExperiment(testSet, checkpoint, loras, asset.name);

			// Run experiment (no auto-evaluate per user request — skip for today)
			const completed = await runExperiment(experiment, {
				autoEvaluate: false,
				onProgress: (ep) => {
					progress.completedImages = experiments.reduce(
						(s, e) => s + e.generations.length, 0
					) + ep.completed;
					opts?.onProgress?.(progress);
				}
			});

			experiments.push(completed);
		}

		// Mark asset as tested
		const assets = await loadAssets();
		const idx = assets.findIndex(a => a.id === asset.id);
		if (idx >= 0) {
			assets[idx].tested = true;
			await saveAssets(assets);
		}

		progress.phase = 'complete';
		opts?.onProgress?.(progress);
		return experiments;

	} catch (err) {
		progress.phase = 'error';
		progress.error = err instanceof Error ? err.message : String(err);
		opts?.onProgress?.(progress);
		brainProgressMap.set(runId, progress);
		throw err;
	}
}

/**
 * Run a full autonomous test session across all untested assets.
 * The brain researches each one, plans tests, and executes them.
 */
export async function runAutonomousSession(opts?: {
	runId?: string;
	maxAssets?: number;
	assetTypes?: ArtAsset['type'][];
	onProgress?: (p: BrainProgress) => void;
}): Promise<{ assetsProcessed: number; totalExperiments: number; totalImages: number }> {
	const assets = await loadAssets();
	const untested = assets.filter(a => {
		if (a.tested) return false;
		if (opts?.assetTypes && !opts.assetTypes.includes(a.type)) return false;
		return true;
	});

	const toTest = untested.slice(0, opts?.maxAssets ?? 10);
	let totalExperiments = 0;
	let totalImages = 0;

	for (const asset of toTest) {
		try {
			const experiments = await testAsset(asset, {
				runId: opts?.runId ?? `session-${asset.id}`,
				onProgress: opts?.onProgress
			});
			totalExperiments += experiments.length;
			totalImages += experiments.reduce((s, e) => s + e.generations.length, 0);
		} catch (err) {
			// Log but continue to next asset
			console.error(`Brain: failed to test ${asset.name}:`, err);
		}
	}

	return { assetsProcessed: toTest.length, totalExperiments, totalImages };
}

// ── Brain: custom test by description ────────────────────────────────

const CUSTOM_TEST_SYSTEM = `You are an expert Stable Diffusion prompt engineer and test planner. Given a test description and available assets, create test configurations.

Output ONLY a JSON object with:
- experiments: array of experiment configs, each with:
  - name: descriptive name
  - positive: the positive prompt (detailed, using correct trigger words and quality tags)
  - negative: the negative prompt
  - checkpoint: which checkpoint to use (must be from the available list)
  - loras: array of { name, strength, triggerWords } (from available list, or empty)
  - variable: { field, values } — what to vary
  - params: { cfg, steps, sampler, scheduler, width, height }

Rules:
- Use ONLY assets from the available lists provided
- Include trigger words for any LoRAs used
- Craft detailed, high-quality prompts
- For character tests: detailed descriptions of pose, expression, clothing, lighting, background
- For detail tests: test different emphasis weights, tag ordering, quality boosters
- For style tests: same subject across different style approaches
- Produce 4-6 variable values per experiment
- Aim for photorealistic quality unless style-specific

Output ONLY the JSON.`;

interface CustomTestConfig {
	experiments: {
		name: string;
		positive: string;
		negative: string;
		checkpoint: string;
		loras: { name: string; strength: number; triggerWords: string[] }[];
		variable: { field: string; values: (string | number)[] };
		params: Partial<GenerationParams>;
	}[];
}

/**
 * Ask the brain to plan and execute custom tests from a description.
 * Example: "test all character LoRAs with the anime checkpoint in action poses"
 */
export async function runCustomTest(
	description: string,
	opts?: { runId?: string; onProgress?: (p: BrainProgress) => void }
): Promise<Experiment[]> {
	const [assets, comfyModels, knowledge] = await Promise.all([
		loadAssets(),
		getComfyModels(),
		loadKnowledge()
	]);

	// Research all relevant assets so the brain has full context
	const assetResearch: string[] = [];
	for (const asset of assets.slice(0, 20)) {
		const research = await getResearch(asset);
		assetResearch.push(
			`- ${asset.type}: "${asset.name}" (file: ${asset.filePath}, triggers: ${research.recommended.triggerWords.join(', ') || 'none'}, base: ${research.baseModel})`
		);
	}

	const context = [
		`=== TEST REQUEST ===`,
		description,
		``,
		`=== AVAILABLE CHECKPOINTS (in ComfyUI) ===`,
		comfyModels.checkpoints.map(c => `  - ${c}`).join('\n'),
		``,
		`=== AVAILABLE LORAS (in ComfyUI) ===`,
		comfyModels.loras.map(l => `  - ${l}`).join('\n'),
		``,
		`=== REGISTERED ASSETS WITH RESEARCH ===`,
		assetResearch.join('\n'),
		``,
		`=== AVAILABLE SAMPLERS ===`,
		comfyModels.samplers.join(', '),
		``,
		`=== PREVIOUS KNOWLEDGE ===`,
		knowledge.modelProfiles.length > 0
			? knowledge.modelProfiles.map(m => `  ${m.name}: avg ${m.avgScore}/5, best sampler: ${m.bestSamplers[0]}, cfg: ${m.optimalCfg}`).join('\n')
			: '  (no previous test data)',
		``,
		`Create experiments to fulfill this test request.`
	].join('\n');

	const raw = await think(context, CUSTOM_TEST_SYSTEM);
	const config = extractJson<CustomTestConfig>(raw);

	if (!config?.experiments?.length) {
		throw new Error('Brain could not create a test plan from the description');
	}

	const experiments: Experiment[] = [];
	for (const exp of config.experiments) {
		const loras: LoraRef[] = exp.loras?.map(l => ({
			name: l.name,
			strength: l.strength,
			triggerWords: l.triggerWords ?? []
		})) ?? [];

		const experiment = createQuickExperiment({
			name: exp.name,
			positive: exp.positive,
			negative: exp.negative,
			checkpoint: exp.checkpoint,
			loras,
			variables: [{ field: exp.variable.field, values: exp.variable.values }],
			params: exp.params
		});

		const completed = await runExperiment(experiment, {
			autoEvaluate: false,
			onProgress: opts?.onProgress
				? (ep) => opts.onProgress!({
					phase: 'generating',
					assetName: exp.name,
					testSetIndex: experiments.length,
					totalTestSets: config.experiments.length,
					totalImages: config.experiments.reduce((s, e) => s + e.variable.values.length, 0),
					completedImages: experiments.reduce((s, e) => s + e.generations.length, 0) + ep.completed,
					currentTestSet: exp.name
				})
				: undefined
		});
		experiments.push(completed);
	}

	return experiments;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Pick a checkpoint compatible with the given base model type. */
function pickCompatibleCheckpoint(baseModel: string, available: string[]): string {
	if (available.length === 0) return '';
	const lower = baseModel.toLowerCase().replace(/\s+/g, '');

	// Try to match by base model keywords in filename
	const keywords: Record<string, string[]> = {
		'sdxl1.0': ['sdxl', 'xl'],
		'sdxl': ['sdxl', 'xl'],
		'sd1.5': ['sd15', '1.5', 'v1-5'],
		'sd15': ['sd15', '1.5', 'v1-5'],
		'pony': ['pony'],
		'flux.1d': ['flux'],
		'flux': ['flux'],
		'illustrious': ['illustrious']
	};

	const matchKeywords = keywords[lower] ?? [lower];
	for (const kw of matchKeywords) {
		const match = available.find(c => c.toLowerCase().includes(kw));
		if (match) return match;
	}

	// No match — return first available
	return available[0];
}
