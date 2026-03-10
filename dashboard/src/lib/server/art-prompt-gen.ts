/**
 * Art Prompt Generator — uses local Ollama model to generate structured
 * Stable Diffusion prompts from natural language descriptions.
 *
 * Also uses a vision model to evaluate generated images.
 */
import { APIS } from './constants.js';
import type { GenerationParams, LoraRef } from '$lib/types/art.js';

// ── Config ──────────────────────────────────────────────────────────

/** Model for prompt generation (text-only, fast). */
const PROMPT_MODEL = 'gpt-oss:20b';

/** Model for image evaluation (vision-capable). */
const VISION_MODEL = 'llama3.2-vision:11b';

const OLLAMA_URL = APIS.ollama;

// ── Ollama helpers ──────────────────────────────────────────────────

interface OllamaGenerateResponse {
	response: string;
	done: boolean;
}

async function ollamaGenerate(
	model: string,
	prompt: string,
	system?: string,
	images?: string[] // base64 encoded
): Promise<string> {
	const body: Record<string, unknown> = {
		model,
		prompt,
		stream: false,
		options: { temperature: 0.7, num_predict: 2048 }
	};
	if (system) body.system = system;
	if (images && images.length > 0) body.images = images;

	const res = await fetch(`${OLLAMA_URL}/api/generate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(120_000) // 2 min for vision
	});

	if (!res.ok) {
		throw new Error(`Ollama ${model} error: ${res.status} ${res.statusText}`);
	}

	const data = (await res.json()) as OllamaGenerateResponse;
	return data.response;
}

// ── Prompt Generation ───────────────────────────────────────────────

const PROMPT_SYSTEM = `You are an expert Stable Diffusion prompt engineer. Given a user's description, output ONLY a JSON object (no markdown, no explanation) with these fields:

- positive: comma-separated prompt tags. Include quality boosters (masterpiece, best quality, highly detailed, etc.) and style modifiers. Use danbooru tags for anime, natural language for photorealistic.
- negative: comma-separated negative prompt tags (low quality, blurry, deformed, etc.)
- steps: recommended steps (20-50)
- cfg: recommended CFG scale (1-20)
- sampler: recommended sampler name (euler_a, dpmpp_2m_sde_karras, dpmpp_sde, euler, ddim)
- width: recommended width (512-2048, must be multiple of 8)
- height: recommended height (512-2048, must be multiple of 8)

Respond with ONLY the JSON object.`;

export interface PromptGenResult {
	positive: string;
	negative: string;
	params: Partial<GenerationParams>;
}

/** Generate a structured SD prompt from natural language. */
export async function generatePrompt(
	description: string,
	style?: string,
	model?: string
): Promise<PromptGenResult> {
	let userPrompt = description;
	if (style) userPrompt += `\nStyle: ${style}`;
	if (model) userPrompt += `\nTarget model: ${model}`;

	const raw = await ollamaGenerate(PROMPT_MODEL, userPrompt, PROMPT_SYSTEM);

	// Extract JSON from response (handle markdown code blocks)
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		throw new Error('Prompt model did not return valid JSON');
	}

	const parsed = JSON.parse(jsonMatch[0]);
	return {
		positive: parsed.positive ?? description,
		negative: parsed.negative ?? 'low quality, blurry, deformed',
		params: {
			steps: clamp(parsed.steps ?? 25, 10, 100),
			cfg: clamp(parsed.cfg ?? 7, 1, 30),
			sampler: parsed.sampler ?? 'euler_a',
			width: alignTo8(clamp(parsed.width ?? 1024, 512, 2048)),
			height: alignTo8(clamp(parsed.height ?? 1024, 512, 2048))
		}
	};
}

// ── Prompt Variation ────────────────────────────────────────────────

const VARIATION_SYSTEM = `You are an expert Stable Diffusion prompt engineer. Given a base prompt and a number of variations requested, output ONLY a JSON array of objects, each with "positive" and "negative" fields. Each variation should test different approaches: different quality tags, different style modifiers, different emphasis, different word order. Keep the core subject the same but vary the prompt engineering technique. Output ONLY the JSON array.`;

/** Generate N variations of a prompt for batch testing. */
export async function generatePromptVariations(
	basePositive: string,
	baseNegative: string,
	count: number
): Promise<{ positive: string; negative: string }[]> {
	const userPrompt = `Base prompt: ${basePositive}\nBase negative: ${baseNegative}\nGenerate ${count} variations.`;
	const raw = await ollamaGenerate(PROMPT_MODEL, userPrompt, VARIATION_SYSTEM);

	const jsonMatch = raw.match(/\[[\s\S]*\]/);
	if (!jsonMatch) {
		// Fallback: return the base prompt repeated
		return Array.from({ length: count }, () => ({
			positive: basePositive,
			negative: baseNegative
		}));
	}

	try {
		const parsed = JSON.parse(jsonMatch[0]) as { positive: string; negative: string }[];
		return parsed.slice(0, count);
	} catch {
		return [{ positive: basePositive, negative: baseNegative }];
	}
}

// ── Image Evaluation (Vision Model) ─────────────────────────────────

export interface ImageEvaluation {
	score: number;          // 1-5
	quality: string;        // brief quality assessment
	composition: string;    // composition feedback
	artifacts: string[];    // detected issues
	suggestions: string[];  // improvement suggestions
}

const EVAL_SYSTEM = `You are an AI art critic evaluating Stable Diffusion generated images. Score the image 1-5 and provide brief feedback. Output ONLY a JSON object with:
- score: 1-5 (1=terrible, 2=poor, 3=average, 4=good, 5=excellent)
- quality: one sentence about overall quality
- composition: one sentence about composition
- artifacts: array of detected issues (e.g. "extra fingers", "blurry background", "color bleeding")
- suggestions: array of prompt improvement suggestions

Be honest and critical. Output ONLY the JSON.`;

/** Evaluate an image using a vision model. Returns score and feedback. */
export async function evaluateImage(
	imageBase64: string,
	prompt: string
): Promise<ImageEvaluation> {
	const userPrompt = `Evaluate this image. It was generated with the prompt: "${prompt}"`;

	try {
		const raw = await ollamaGenerate(VISION_MODEL, userPrompt, EVAL_SYSTEM, [imageBase64]);
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return { score: 3, quality: 'Could not parse evaluation', composition: '', artifacts: [], suggestions: [] };
		}
		const parsed = JSON.parse(jsonMatch[0]);
		return {
			score: clamp(parsed.score ?? 3, 1, 5),
			quality: parsed.quality ?? '',
			composition: parsed.composition ?? '',
			artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
			suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
		};
	} catch {
		return { score: 3, quality: 'Vision model unavailable', composition: '', artifacts: [], suggestions: [] };
	}
}

// ── Experiment Planning ─────────────────────────────────────────────

const PLAN_SYSTEM = `You are an AI art research planner. Given the current knowledge base and a research goal, plan a batch experiment. Output ONLY a JSON object with:
- name: short experiment name
- hypothesis: what we're testing
- variables: array of { field, values } — what to vary
- defaults: { positive, negative, checkpoint, params: { steps, cfg, sampler, scheduler, width, height, seed } }

Available fields to vary: positive, negative, params.cfg, params.steps, params.sampler, params.scheduler, checkpoint, loras.
For "values", provide 3-8 concrete values to test.
Output ONLY the JSON.`;

export interface ExperimentPlan {
	name: string;
	hypothesis: string;
	variables: { field: string; values: (string | number)[] }[];
	defaults: {
		positive: string;
		negative: string;
		checkpoint: string;
		params: Partial<GenerationParams>;
	};
}

/** Ask Ollama to plan an experiment based on a research goal. */
export async function planExperiment(
	goal: string,
	availableModels: string[],
	availableLoras: string[],
	availableSamplers: string[],
	knowledgeContext?: string
): Promise<ExperimentPlan> {
	const context = [
		`Research goal: ${goal}`,
		`Available checkpoints: ${availableModels.slice(0, 10).join(', ')}`,
		`Available LoRAs: ${availableLoras.slice(0, 10).join(', ')}`,
		`Available samplers: ${availableSamplers.join(', ')}`
	];
	if (knowledgeContext) context.push(`Previous findings: ${knowledgeContext}`);

	const raw = await ollamaGenerate(PROMPT_MODEL, context.join('\n'), PLAN_SYSTEM);
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error('Could not parse experiment plan');

	return JSON.parse(jsonMatch[0]) as ExperimentPlan;
}

// ── Utils ───────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function alignTo8(n: number): number {
	return Math.round(n / 8) * 8;
}
