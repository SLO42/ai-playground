/**
 * Art Researcher — fetches real-world usage data for models, LoRAs,
 * upscalers, and embeddings from CivitAI and other sources.
 *
 * Before testing any asset, the brain calls this module to learn:
 *   - How the creator recommends using it
 *   - What prompts the community uses with it
 *   - What settings (CFG, steps, sampler, resolution) produce good results
 *   - What other assets it pairs well with
 *   - Trigger words and how to weight them
 */

import type { ArtAsset } from '$lib/types/art.js';

const CIVITAI_API = 'https://civitai.com/api/v1';

// ── Types ────────────────────────────────────────────────────────────

export interface AssetResearch {
	assetId: string;
	name: string;
	type: ArtAsset['type'];
	source: string;

	/** Creator's description (HTML stripped to plaintext). */
	description: string;

	/** Creator's recommended settings. */
	recommended: {
		triggerWords: string[];
		baseModel: string;
		cfg?: number;
		steps?: number;
		sampler?: string;
		scheduler?: string;
		width?: number;
		height?: number;
		clipSkip?: number;
		strength?: number;       // for LoRAs
		negativePrompt?: string;
		vae?: string;
	};

	/** Real prompts from community images (up to 20). */
	communityPrompts: {
		positive: string;
		negative: string;
		cfg: number;
		steps: number;
		sampler: string;
		seed: number;
		width: number;
		height: number;
		score?: number; // CivitAI reaction score
	}[];

	/** Assets commonly paired with this one (from community images). */
	commonPairings: {
		type: 'checkpoint' | 'lora' | 'embedding';
		name: string;
		frequency: number; // how often paired
	}[];

	/** Version info */
	versionName: string;
	baseModel: string;

	/** Raw tags/categories from the source */
	tags: string[];

	/** When the research was done */
	researchedAt: string;
}

// ── CivitAI detailed model info ──────────────────────────────────────

interface CivitAIModelFull {
	id: number;
	name: string;
	description: string; // HTML
	type: string;
	tags: string[];
	modelVersions: {
		id: number;
		name: string;
		description: string; // HTML
		baseModel: string;
		trainedWords: string[];
		files: { name: string; sizeKB: number; downloadUrl: string }[];
	}[];
}

interface CivitAIImage {
	id: number;
	url: string;
	width: number;
	height: number;
	meta?: {
		prompt?: string;
		negativePrompt?: string;
		cfgScale?: number;
		steps?: number;
		sampler?: string;
		seed?: number;
		'Clip skip'?: number;
		Model?: string;
		resources?: { type: string; name: string; weight?: number }[];
		// Some images store params differently
		cfg?: number;
	};
	stats?: {
		likeCount?: number;
		heartCount?: number;
		laughCount?: number;
		cryCount?: number;
	};
}

interface CivitAIImagesResponse {
	items: CivitAIImage[];
	metadata: { totalItems: number; currentPage: number; pageSize: number };
}

// ── HTML stripping ───────────────────────────────────────────────────

function stripHtml(html: string): string {
	if (!html) return '';
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<\/li>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// ── Research by CivitAI model ID ─────────────────────────────────────

/** Fetch full model info from CivitAI. */
async function fetchCivitAIModel(modelId: number): Promise<CivitAIModelFull> {
	const res = await fetch(`${CIVITAI_API}/models/${modelId}`, {
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`CivitAI model ${modelId}: ${res.status}`);
	return (await res.json()) as CivitAIModelFull;
}

/** Fetch community images for a model (with generation metadata). */
async function fetchCivitAIImages(modelId: number, limit = 20): Promise<CivitAIImage[]> {
	const params = new URLSearchParams({
		modelId: String(modelId),
		limit: String(limit),
		sort: 'Most Reactions'
	});

	try {
		const res = await fetch(`${CIVITAI_API}/images?${params}`, {
			signal: AbortSignal.timeout(15_000)
		});
		if (!res.ok) return [];
		const data = (await res.json()) as CivitAIImagesResponse;
		return data.items ?? [];
	} catch {
		return [];
	}
}

/** Parse creator description for recommended settings. */
function parseDescriptionSettings(desc: string): Record<string, string | number> {
	const settings: Record<string, string | number> = {};
	const text = desc.toLowerCase();

	// Look for common patterns creators use
	const cfgMatch = text.match(/cfg\s*(?:scale)?\s*[:=]?\s*(\d+(?:\.\d+)?)/);
	if (cfgMatch) settings.cfg = parseFloat(cfgMatch[1]);

	const stepsMatch = text.match(/steps?\s*[:=]?\s*(\d+)/);
	if (stepsMatch) settings.steps = parseInt(stepsMatch[1], 10);

	const samplerMatch = text.match(/sampler\s*[:=]?\s*([a-z0-9_+ ]+)/);
	if (samplerMatch) settings.sampler = samplerMatch[1].trim();

	const clipMatch = text.match(/clip\s*skip\s*[:=]?\s*(\d+)/);
	if (clipMatch) settings.clipSkip = parseInt(clipMatch[1], 10);

	const strengthMatch = text.match(/(?:lora\s+)?(?:weight|strength)\s*[:=]?\s*(\d+(?:\.\d+)?)/);
	if (strengthMatch) settings.strength = parseFloat(strengthMatch[1]);

	const widthMatch = text.match(/(?:width|resolution)\s*[:=]?\s*(\d{3,4})\s*[x×]\s*(\d{3,4})/);
	if (widthMatch) {
		settings.width = parseInt(widthMatch[1], 10);
		settings.height = parseInt(widthMatch[2], 10);
	}

	const vaeMatch = text.match(/vae\s*[:=]?\s*([a-z0-9_.+-]+\.(?:safetensors|pt|ckpt))/);
	if (vaeMatch) settings.vae = vaeMatch[1];

	return settings;
}

/** Extract common pairings from community image metadata. */
function extractPairings(images: CivitAIImage[], selfName: string): AssetResearch['commonPairings'] {
	const counts = new Map<string, { type: 'checkpoint' | 'lora' | 'embedding'; count: number }>();

	for (const img of images) {
		if (!img.meta?.resources) continue;
		for (const r of img.meta.resources) {
			if (r.name === selfName) continue;
			const key = `${r.type}:${r.name}`;
			const entry = counts.get(key) ?? {
				type: r.type.toLowerCase() as 'checkpoint' | 'lora' | 'embedding',
				count: 0
			};
			entry.count++;
			counts.set(key, entry);
		}

		// Also extract checkpoint from Model field
		if (img.meta.Model && img.meta.Model !== selfName) {
			const key = `checkpoint:${img.meta.Model}`;
			const entry = counts.get(key) ?? { type: 'checkpoint' as const, count: 0 };
			entry.count++;
			counts.set(key, entry);
		}
	}

	return [...counts.entries()]
		.map(([key, val]) => ({
			type: val.type,
			name: key.split(':')[1],
			frequency: val.count
		}))
		.sort((a, b) => b.frequency - a.frequency)
		.slice(0, 15);
}

/** Calculate an image's engagement score from reactions. */
function imageScore(img: CivitAIImage): number {
	const s = img.stats;
	if (!s) return 0;
	return (s.heartCount ?? 0) * 3 + (s.likeCount ?? 0) * 2 + (s.laughCount ?? 0);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Research a CivitAI-sourced asset: fetch creator info, community prompts,
 * recommended settings, and common pairings.
 */
export async function researchCivitAIAsset(
	asset: ArtAsset,
	modelId: number
): Promise<AssetResearch> {
	const [model, images] = await Promise.all([
		fetchCivitAIModel(modelId),
		fetchCivitAIImages(modelId, 30)
	]);

	const version = model.modelVersions[0];
	const fullDesc = stripHtml(model.description ?? '') + '\n' + stripHtml(version?.description ?? '');
	const parsedSettings = parseDescriptionSettings(fullDesc);

	// Extract community prompts from images with metadata
	const communityPrompts = images
		.filter(img => img.meta?.prompt)
		.sort((a, b) => imageScore(b) - imageScore(a))
		.slice(0, 20)
		.map(img => ({
			positive: img.meta!.prompt!,
			negative: img.meta!.negativePrompt ?? '',
			cfg: img.meta!.cfgScale ?? img.meta!.cfg ?? 7,
			steps: img.meta!.steps ?? 25,
			sampler: img.meta!.sampler ?? 'euler_a',
			seed: img.meta!.seed ?? -1,
			width: img.width,
			height: img.height,
			score: imageScore(img)
		}));

	// Extract median settings from community images
	const communityCfgs = communityPrompts.map(p => p.cfg).filter(Boolean);
	const communitySteps = communityPrompts.map(p => p.steps).filter(Boolean);
	const communitySamplers = communityPrompts.map(p => p.sampler).filter(Boolean);

	const recommended: AssetResearch['recommended'] = {
		triggerWords: version?.trainedWords ?? [],
		baseModel: version?.baseModel ?? 'unknown',
		cfg: parsedSettings.cfg as number ?? median(communityCfgs) ?? 7,
		steps: parsedSettings.steps as number ?? median(communitySteps) ?? 25,
		sampler: (parsedSettings.sampler as string) ?? mode(communitySamplers) ?? 'euler_a',
		width: parsedSettings.width as number ?? undefined,
		height: parsedSettings.height as number ?? undefined,
		clipSkip: parsedSettings.clipSkip as number ?? undefined,
		strength: parsedSettings.strength as number ?? undefined,
		negativePrompt: communityPrompts[0]?.negative || undefined,
		vae: parsedSettings.vae as string ?? undefined
	};

	return {
		assetId: asset.id,
		name: model.name,
		type: asset.type,
		source: 'civitai',
		description: fullDesc.slice(0, 2000), // cap description length
		recommended,
		communityPrompts,
		commonPairings: extractPairings(images, model.name),
		versionName: version?.name ?? '',
		baseModel: version?.baseModel ?? 'unknown',
		tags: model.tags ?? [],
		researchedAt: new Date().toISOString()
	};
}

/**
 * Research any asset — dispatches to the appropriate source researcher.
 * For local assets without a source ID, returns minimal research.
 */
export async function researchAsset(asset: ArtAsset): Promise<AssetResearch> {
	if (asset.source === 'civitai' && asset.sourceId) {
		return researchCivitAIAsset(asset, parseInt(asset.sourceId, 10));
	}

	// For HuggingFace or local assets, return what we know
	return {
		assetId: asset.id,
		name: asset.name,
		type: asset.type,
		source: asset.source,
		description: asset.notes ?? '',
		recommended: {
			triggerWords: asset.triggerWords,
			baseModel: asset.compatibleBases[0] ?? 'unknown'
		},
		communityPrompts: [],
		commonPairings: [],
		versionName: '',
		baseModel: asset.compatibleBases[0] ?? 'unknown',
		tags: [],
		researchedAt: new Date().toISOString()
	};
}

/**
 * Research a CivitAI model by ID directly (before downloading).
 * Useful for the brain to decide whether to download something.
 */
export async function researchCivitAIModelById(modelId: number): Promise<{
	name: string;
	type: string;
	description: string;
	baseModel: string;
	triggerWords: string[];
	communityPrompts: AssetResearch['communityPrompts'];
	tags: string[];
}> {
	const [model, images] = await Promise.all([
		fetchCivitAIModel(modelId),
		fetchCivitAIImages(modelId, 15)
	]);

	const version = model.modelVersions[0];
	const communityPrompts = images
		.filter(img => img.meta?.prompt)
		.sort((a, b) => imageScore(b) - imageScore(a))
		.slice(0, 15)
		.map(img => ({
			positive: img.meta!.prompt!,
			negative: img.meta!.negativePrompt ?? '',
			cfg: img.meta!.cfgScale ?? img.meta!.cfg ?? 7,
			steps: img.meta!.steps ?? 25,
			sampler: img.meta!.sampler ?? 'euler_a',
			seed: img.meta!.seed ?? -1,
			width: img.width,
			height: img.height,
			score: imageScore(img)
		}));

	return {
		name: model.name,
		type: model.type,
		description: stripHtml(model.description ?? '').slice(0, 1500),
		baseModel: version?.baseModel ?? 'unknown',
		triggerWords: version?.trainedWords ?? [],
		communityPrompts,
		tags: model.tags ?? []
	};
}

// ── Utils ────────────────────────────────────────────────────────────

function median(arr: number[]): number | undefined {
	if (arr.length === 0) return undefined;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mode(arr: string[]): string | undefined {
	if (arr.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
