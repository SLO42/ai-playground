/**
 * Art Experiment Engine — runs bulk generation batches through ComfyUI,
 * varying parameters to test hypotheses about prompts, models, and LoRAs.
 *
 * Generates all combinations of variable values (cartesian product),
 * queues them through ComfyUI, and collects results.
 */
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { resolve, basename } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from './constants.js';
import * as comfy from './comfyui-client.js';
import { evaluateImage } from './art-prompt-gen.js';
import type {
	Experiment, Generation, GenerationParams, LoraRef,
	ExperimentVariable, ArtAsset, ArtKnowledge
} from '$lib/types/art.js';

// ── Storage ─────────────────────────────────────────────────────────

async function ensureArtDirs(): Promise<void> {
	await mkdir(PATHS.artDir, { recursive: true });
	await mkdir(PATHS.artOutputDir, { recursive: true });
}

export async function loadExperiments(): Promise<Experiment[]> {
	try {
		const raw = await readFile(PATHS.artExperiments, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

async function saveExperiments(experiments: Experiment[]): Promise<void> {
	await ensureArtDirs();
	await writeFile(PATHS.artExperiments, JSON.stringify(experiments, null, '\t'), 'utf-8');
}

export async function loadAssets(): Promise<ArtAsset[]> {
	try {
		const raw = await readFile(PATHS.artAssets, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

export async function saveAssets(assets: ArtAsset[]): Promise<void> {
	await ensureArtDirs();
	await writeFile(PATHS.artAssets, JSON.stringify(assets, null, '\t'), 'utf-8');
}

export async function loadKnowledge(): Promise<ArtKnowledge> {
	try {
		const raw = await readFile(PATHS.artKnowledge, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return {
			promptTemplates: [],
			keywordIndex: [],
			loraProfiles: [],
			modelProfiles: [],
			lastUpdated: new Date().toISOString()
		};
	}
}

export async function saveKnowledge(knowledge: ArtKnowledge): Promise<void> {
	await ensureArtDirs();
	knowledge.lastUpdated = new Date().toISOString();
	await writeFile(PATHS.artKnowledge, JSON.stringify(knowledge, null, '\t'), 'utf-8');
}

// ── Default params ──────────────────────────────────────────────────

const DEFAULT_PARAMS: GenerationParams = {
	steps: 25,
	cfg: 7,
	sampler: 'euler_a',
	scheduler: 'normal',
	width: 1024,
	height: 1024,
	seed: -1
};

// ── Workflow builder ────────────────────────────────────────────────

/**
 * Build a ComfyUI workflow JSON for txt2img generation.
 * This creates the standard pipeline:
 *   CheckpointLoader → CLIP Text Encode (pos/neg) → KSampler → VAE Decode → Save Image
 * With optional LoRA stacking.
 */
function buildTxt2ImgWorkflow(
	positive: string,
	negative: string,
	checkpoint: string,
	params: GenerationParams,
	loras: LoraRef[] = [],
	batchId?: string
): Record<string, unknown> {
	const seed = params.seed === -1 ? Math.floor(Math.random() * 2 ** 32) : params.seed;
	const prefix = batchId ? `art_${batchId}` : `art_${Date.now()}`;

	// Inject LoRA trigger words into positive prompt
	let fullPositive = positive;
	for (const lora of loras) {
		if (lora.triggerWords.length > 0) {
			fullPositive = lora.triggerWords.join(', ') + ', ' + fullPositive;
		}
	}

	// Node IDs
	let nodeId = 1;
	const nodes: Record<string, unknown> = {};

	// 1. Checkpoint loader
	const checkpointNodeId = String(nodeId++);
	nodes[checkpointNodeId] = {
		class_type: 'CheckpointLoaderSimple',
		inputs: { ckpt_name: checkpoint }
	};

	let modelOutput: [string, number] = [checkpointNodeId, 0]; // MODEL
	let clipOutput: [string, number] = [checkpointNodeId, 1];  // CLIP
	const vaeOutput: [string, number] = [checkpointNodeId, 2]; // VAE

	// 2. LoRA loaders (chained)
	for (const lora of loras) {
		const loraNodeId = String(nodeId++);
		nodes[loraNodeId] = {
			class_type: 'LoraLoader',
			inputs: {
				lora_name: lora.name,
				strength_model: lora.strength,
				strength_clip: lora.clipStrength ?? lora.strength,
				model: modelOutput,
				clip: clipOutput
			}
		};
		modelOutput = [loraNodeId, 0];
		clipOutput = [loraNodeId, 1];
	}

	// 3. CLIP Text Encode — positive
	const posNodeId = String(nodeId++);
	nodes[posNodeId] = {
		class_type: 'CLIPTextEncode',
		inputs: { text: fullPositive, clip: clipOutput }
	};

	// 4. CLIP Text Encode — negative
	const negNodeId = String(nodeId++);
	nodes[negNodeId] = {
		class_type: 'CLIPTextEncode',
		inputs: { text: negative, clip: clipOutput }
	};

	// 5. Empty Latent Image
	const latentNodeId = String(nodeId++);
	nodes[latentNodeId] = {
		class_type: 'EmptyLatentImage',
		inputs: {
			width: params.width,
			height: params.height,
			batch_size: 1
		}
	};

	// 6. KSampler
	const samplerNodeId = String(nodeId++);
	nodes[samplerNodeId] = {
		class_type: 'KSampler',
		inputs: {
			seed,
			steps: params.steps,
			cfg: params.cfg,
			sampler_name: params.sampler,
			scheduler: params.scheduler,
			denoise: params.denoise ?? 1.0,
			model: modelOutput,
			positive: [posNodeId, 0],
			negative: [negNodeId, 0],
			latent_image: [latentNodeId, 0]
		}
	};

	// 7. VAE Decode
	const decodeNodeId = String(nodeId++);
	nodes[decodeNodeId] = {
		class_type: 'VAEDecode',
		inputs: {
			samples: [samplerNodeId, 0],
			vae: vaeOutput
		}
	};

	// 8. Save Image
	const saveNodeId = String(nodeId++);
	nodes[saveNodeId] = {
		class_type: 'SaveImage',
		inputs: {
			filename_prefix: prefix,
			images: [decodeNodeId, 0]
		}
	};

	return nodes;
}

// ── Cartesian product ───────────────────────────────────────────────

function cartesian(variables: ExperimentVariable[]): Record<string, string | number>[] {
	if (variables.length === 0) return [{}];

	const [first, ...rest] = variables;
	const restCombos = cartesian(rest);
	const result: Record<string, string | number>[] = [];

	for (const value of first.values) {
		for (const combo of restCombos) {
			result.push({ ...combo, [first.field]: value });
		}
	}

	return result;
}

/** Apply variable overrides to default generation config. */
function applyOverrides(
	defaults: Experiment['defaults'],
	overrides: Record<string, string | number>
): { positive: string; negative: string; checkpoint: string; loras: LoraRef[]; params: GenerationParams } {
	const result = {
		positive: defaults.positive,
		negative: defaults.negative,
		checkpoint: defaults.checkpoint,
		loras: defaults.loras?.map(l => ({ ...l })) ?? [],
		params: { ...DEFAULT_PARAMS, ...defaults.params }
	};

	for (const [field, value] of Object.entries(overrides)) {
		if (field === 'positive') result.positive = String(value);
		else if (field === 'negative') result.negative = String(value);
		else if (field === 'checkpoint') result.checkpoint = String(value);
		else if (field.startsWith('params.')) {
			const key = field.slice(7) as keyof GenerationParams;
			(result.params as Record<string, unknown>)[key] = value;
		} else if (field.startsWith('loras[') && field.includes('].strength')) {
			const idx = parseInt(field.match(/\[(\d+)\]/)?.[1] ?? '0', 10);
			if (result.loras[idx]) result.loras[idx].strength = Number(value);
		}
	}

	return result;
}

// ── Experiment execution ────────────────────────────────────────────

export interface ExperimentProgress {
	experimentId: string;
	total: number;
	completed: number;
	failed: number;
	current?: string; // description of current generation
}

// In-memory progress tracking
const progressMap = new Map<string, ExperimentProgress>();

export function getExperimentProgress(experimentId: string): ExperimentProgress | undefined {
	return progressMap.get(experimentId);
}

/**
 * Run an experiment: generate all combinations and collect results.
 * Runs sequentially to avoid VRAM contention.
 */
export async function runExperiment(
	experiment: Experiment,
	opts?: { autoEvaluate?: boolean; onProgress?: (p: ExperimentProgress) => void }
): Promise<Experiment> {
	await ensureArtDirs();

	const combinations = cartesian(experiment.variables);
	const progress: ExperimentProgress = {
		experimentId: experiment.id,
		total: combinations.length,
		completed: 0,
		failed: 0
	};
	progressMap.set(experiment.id, progress);

	experiment.status = 'running';
	experiment.generations = [];

	// Save initial state
	const experiments = await loadExperiments();
	const idx = experiments.findIndex(e => e.id === experiment.id);
	if (idx >= 0) experiments[idx] = experiment;
	else experiments.push(experiment);
	await saveExperiments(experiments);

	for (const combo of combinations) {
		const config = applyOverrides(experiment.defaults, combo);
		const genId = randomUUID().slice(0, 12);
		const batchId = `${experiment.id.slice(0, 8)}_${genId}`;

		progress.current = Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(', ');
		opts?.onProgress?.(progress);

		try {
			// Build and submit workflow
			const workflow = buildTxt2ImgWorkflow(
				config.positive,
				config.negative,
				config.checkpoint,
				config.params,
				config.loras,
				batchId
			);

			const queued = await comfy.queuePrompt(workflow);
			if (!queued) {
				progress.failed++;
				continue;
			}

			// Wait for completion
			const images = await comfy.waitForCompletion(queued.prompt_id, 300_000);
			if (images.length === 0) {
				progress.failed++;
				continue;
			}

			// Copy output image to our art directory
			const outputFilename = `${batchId}_${images[0].filename}`;
			const outputPath = resolve(PATHS.artOutputDir, outputFilename);

			const imageBuffer = await comfy.fetchImage(
				images[0].filename,
				images[0].subfolder,
				images[0].type
			);
			if (imageBuffer) {
				await writeFile(outputPath, imageBuffer);
			}

			// Build generation record
			const generation: Generation = {
				id: genId,
				experimentId: experiment.id,
				positive: config.positive,
				negative: config.negative,
				checkpoint: config.checkpoint,
				loras: config.loras,
				params: config.params,
				outputFile: outputFilename,
				outputType: 'image',
				comfyPromptId: queued.prompt_id,
				createdAt: new Date().toISOString()
			};

			// Auto-evaluate with vision model if requested
			if (opts?.autoEvaluate && imageBuffer) {
				try {
					const eval_ = await evaluateImage(
						imageBuffer.toString('base64'),
						config.positive
					);
					generation.autoScore = eval_.score;
					generation.autoFeedback = [eval_.quality, eval_.composition].filter(Boolean).join(' ');
				} catch {
					// Vision model not available — skip evaluation
				}
			}

			experiment.generations.push(generation);
			progress.completed++;
		} catch (err) {
			progress.failed++;
		}

		opts?.onProgress?.(progress);
	}

	experiment.status = progress.failed === progress.total ? 'failed' : 'complete';
	experiment.completedAt = new Date().toISOString();

	// Persist final state
	const finalExperiments = await loadExperiments();
	const finalIdx = finalExperiments.findIndex(e => e.id === experiment.id);
	if (finalIdx >= 0) finalExperiments[finalIdx] = experiment;
	else finalExperiments.push(experiment);
	await saveExperiments(finalExperiments);

	progressMap.delete(experiment.id);
	return experiment;
}

/**
 * Create a quick experiment from simple parameters.
 * Useful for one-off batch generations.
 */
export function createQuickExperiment(opts: {
	name: string;
	positive: string;
	negative?: string;
	checkpoint: string;
	loras?: LoraRef[];
	variables: ExperimentVariable[];
	params?: Partial<GenerationParams>;
}): Experiment {
	return {
		id: randomUUID().slice(0, 12),
		name: opts.name,
		hypothesis: `Testing ${opts.variables.map(v => v.field).join(', ')} variations`,
		variables: opts.variables,
		defaults: {
			positive: opts.positive,
			negative: opts.negative ?? 'low quality, blurry, deformed, ugly, bad anatomy',
			checkpoint: opts.checkpoint,
			loras: opts.loras ?? [],
			params: { ...DEFAULT_PARAMS, ...opts.params }
		},
		generations: [],
		status: 'planned',
		createdAt: new Date().toISOString()
	};
}
