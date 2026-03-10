/**
 * Art Asset Manager — downloads and manages LoRAs, checkpoints, VAEs,
 * and embeddings from CivitAI and HuggingFace.
 *
 * Models are stored in a configurable directory (env: COMFYUI_MODELS_ROOT,
 * defaults to F:/models/image) with subdirectories:
 *   checkpoints/  loras/  vae/  embeddings/
 *
 * ComfyUI must be configured to scan these paths (extra_model_paths.yaml).
 */
import { mkdir, writeFile, readdir, stat, unlink } from 'fs/promises';
import { resolve, basename, extname, sep } from 'path';
import { randomUUID } from 'crypto';
import { loadAssets, saveAssets } from './art-experiments.js';
import * as comfy from './comfyui-client.js';
import type { ArtAsset } from '$lib/types/art.js';

// ── Paths ────────────────────────────────────────────────────────────

const MODELS_ROOT = resolve(process.env.COMFYUI_MODELS_ROOT || 'F:/models/image');

const ASSET_DIRS: Record<ArtAsset['type'], string> = {
	checkpoint: resolve(MODELS_ROOT, 'checkpoints'),
	lora: resolve(MODELS_ROOT, 'loras'),
	vae: resolve(MODELS_ROOT, 'vae'),
	embedding: resolve(MODELS_ROOT, 'embeddings'),
	upscaler: resolve(MODELS_ROOT, 'upscale_models')
};

async function ensureAssetDirs(): Promise<void> {
	for (const dir of Object.values(ASSET_DIRS)) {
		await mkdir(dir, { recursive: true });
	}
}

export function getAssetDir(type: ArtAsset['type']): string {
	return ASSET_DIRS[type];
}

// ── CivitAI API ─────────────────────────────────────────────────────

const CIVITAI_API = 'https://civitai.com/api/v1';

interface CivitAIModel {
	id: number;
	name: string;
	type: string; // 'Checkpoint', 'LORA', 'TextualInversion', 'VAE'
	modelVersions: {
		id: number;
		name: string;
		baseModel: string; // 'SD 1.5', 'SDXL 1.0', 'Pony', 'Flux.1 D'
		trainedWords: string[];
		files: {
			id: number;
			name: string;
			sizeKB: number;
			downloadUrl: string;
			metadata?: { format?: string };
		}[];
	}[];
}

interface CivitAISearchResult {
	items: CivitAIModel[];
	metadata: { totalItems: number; currentPage: number; pageSize: number };
}

function civitaiTypeToAssetType(civitType: string): ArtAsset['type'] {
	switch (civitType) {
		case 'Checkpoint': return 'checkpoint';
		case 'LORA': case 'LoCon': return 'lora';
		case 'VAE': return 'vae';
		case 'TextualInversion': return 'embedding';
		case 'Upscaler': return 'upscaler';
		default: return 'lora';
	}
}

/** Search CivitAI for models. */
export async function searchCivitAI(query: string, type?: string, limit = 10): Promise<{
	id: number;
	name: string;
	type: ArtAsset['type'];
	baseModel: string;
	triggerWords: string[];
	downloadUrl: string;
	fileName: string;
	sizeKB: number;
}[]> {
	const params = new URLSearchParams({
		query,
		limit: String(limit),
		sort: 'Most Downloaded'
	});
	if (type) params.set('types', type);

	const res = await fetch(`${CIVITAI_API}/models?${params}`, {
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`CivitAI search failed: ${res.status}`);

	const data = (await res.json()) as CivitAISearchResult;
	const results: ReturnType<typeof searchCivitAI> extends Promise<infer T> ? T : never = [];

	for (const model of data.items) {
		const version = model.modelVersions[0];
		if (!version?.files?.length) continue;

		const file = version.files[0];
		results.push({
			id: model.id,
			name: model.name,
			type: civitaiTypeToAssetType(model.type),
			baseModel: version.baseModel,
			triggerWords: version.trainedWords ?? [],
			downloadUrl: file.downloadUrl,
			fileName: file.name,
			sizeKB: file.sizeKB
		});
	}

	return results;
}

/** Download a model from CivitAI by model ID + version. */
export async function downloadFromCivitAI(
	modelId: number,
	opts?: { versionId?: number; type?: ArtAsset['type'] }
): Promise<ArtAsset> {
	// Fetch model info
	const res = await fetch(`${CIVITAI_API}/models/${modelId}`, {
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`CivitAI model ${modelId} not found: ${res.status}`);

	const model = (await res.json()) as CivitAIModel;
	const version = opts?.versionId
		? model.modelVersions.find(v => v.id === opts.versionId)
		: model.modelVersions[0];

	if (!version?.files?.length) {
		throw new Error(`No downloadable files for model ${modelId}`);
	}

	const file = version.files[0];
	const assetType = opts?.type ?? civitaiTypeToAssetType(model.type);
	const targetDir = ASSET_DIRS[assetType];
	await mkdir(targetDir, { recursive: true });

	const targetPath = resolve(targetDir, file.name);

	// Download the file
	const dlRes = await fetch(file.downloadUrl, {
		signal: AbortSignal.timeout(600_000), // 10 min for large models
		redirect: 'follow'
	});
	if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

	const buffer = Buffer.from(await dlRes.arrayBuffer());
	await writeFile(targetPath, buffer);

	// Create asset record
	const asset: ArtAsset = {
		id: randomUUID().slice(0, 12),
		name: model.name,
		type: assetType,
		source: 'civitai',
		sourceId: String(modelId),
		sourceUrl: `https://civitai.com/models/${modelId}`,
		filePath: file.name,
		triggerWords: version.trainedWords ?? [],
		compatibleBases: [version.baseModel.toLowerCase().replace(/\s+/g, '')],
		downloadedAt: new Date().toISOString(),
		tested: false
	};

	// Save to registry
	const assets = await loadAssets();
	assets.push(asset);
	await saveAssets(assets);

	// Invalidate ComfyUI model cache so new model appears
	comfy.invalidateModelCache();

	return asset;
}

// ── HuggingFace API ─────────────────────────────────────────────────

const HF_API = 'https://huggingface.co/api';

interface HFModel {
	id: string; // "user/model-name"
	modelId: string;
	tags: string[];
	siblings: { rfilename: string }[];
}

/** Search HuggingFace for diffusion models. */
export async function searchHuggingFace(query: string, limit = 10): Promise<{
	id: string;
	name: string;
	tags: string[];
	files: string[];
}[]> {
	const params = new URLSearchParams({
		search: query,
		limit: String(limit),
		filter: 'diffusers'
	});

	const res = await fetch(`${HF_API}/models?${params}`, {
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`HuggingFace search failed: ${res.status}`);

	const models = (await res.json()) as HFModel[];
	return models.map(m => ({
		id: m.id,
		name: m.modelId,
		tags: m.tags ?? [],
		files: m.siblings?.map(s => s.rfilename) ?? []
	}));
}

/** Download a single file from HuggingFace. */
export async function downloadFromHuggingFace(
	repoId: string,
	fileName: string,
	type: ArtAsset['type']
): Promise<ArtAsset> {
	const targetDir = ASSET_DIRS[type];
	await mkdir(targetDir, { recursive: true });

	const localName = basename(fileName);
	const targetPath = resolve(targetDir, localName);

	const dlUrl = `https://huggingface.co/${repoId}/resolve/main/${fileName}`;
	const dlRes = await fetch(dlUrl, {
		signal: AbortSignal.timeout(600_000),
		redirect: 'follow'
	});
	if (!dlRes.ok) throw new Error(`HF download failed: ${dlRes.status}`);

	const buffer = Buffer.from(await dlRes.arrayBuffer());
	await writeFile(targetPath, buffer);

	const asset: ArtAsset = {
		id: randomUUID().slice(0, 12),
		name: repoId.split('/').pop() ?? localName,
		type,
		source: 'huggingface',
		sourceId: repoId,
		sourceUrl: `https://huggingface.co/${repoId}`,
		filePath: localName,
		triggerWords: [],
		compatibleBases: [],
		downloadedAt: new Date().toISOString(),
		tested: false
	};

	const assets = await loadAssets();
	assets.push(asset);
	await saveAssets(assets);

	comfy.invalidateModelCache();
	return asset;
}

// ── Local scanning ──────────────────────────────────────────────────

const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin']);

/** Scan local model directories and return unregistered files. */
export async function scanLocalModels(): Promise<{
	type: ArtAsset['type'];
	fileName: string;
	sizeBytes: number;
	registered: boolean;
}[]> {
	await ensureAssetDirs();
	const assets = await loadAssets();
	const registeredFiles = new Set(assets.map(a => a.filePath));
	const results: Awaited<ReturnType<typeof scanLocalModels>> = [];

	for (const [type, dir] of Object.entries(ASSET_DIRS) as [ArtAsset['type'], string][]) {
		try {
			const files = await readdir(dir);
			for (const file of files) {
				if (!MODEL_EXTENSIONS.has(extname(file).toLowerCase())) continue;
				const fileStat = await stat(resolve(dir, file));
				results.push({
					type,
					fileName: file,
					sizeBytes: fileStat.size,
					registered: registeredFiles.has(file)
				});
			}
		} catch {
			// Directory might not exist yet
		}
	}

	return results;
}

/** Register a local model file that was manually placed. */
export async function registerLocalModel(
	fileName: string,
	type: ArtAsset['type'],
	opts?: { name?: string; triggerWords?: string[]; compatibleBases?: string[] }
): Promise<ArtAsset> {
	// Strip any directory traversal — only keep the basename
	const safeFileName = basename(fileName);
	const asset: ArtAsset = {
		id: randomUUID().slice(0, 12),
		name: opts?.name ?? safeFileName.replace(/\.[^.]+$/, ''),
		type,
		source: 'local',
		filePath: safeFileName,
		triggerWords: opts?.triggerWords ?? [],
		compatibleBases: opts?.compatibleBases ?? [],
		downloadedAt: new Date().toISOString(),
		tested: false
	};

	const assets = await loadAssets();
	assets.push(asset);
	await saveAssets(assets);

	return asset;
}

/** Remove an asset and optionally delete the file. */
export async function removeAsset(assetId: string, deleteFile = false): Promise<boolean> {
	const assets = await loadAssets();
	const idx = assets.findIndex(a => a.id === assetId);
	if (idx < 0) return false;

	const asset = assets[idx];
	if (deleteFile) {
		try {
			const dir = ASSET_DIRS[asset.type];
			const target = resolve(dir, asset.filePath);
			// Guard against path traversal: ensure target stays within the asset dir
			if (!target.startsWith(resolve(dir) + sep)) {
				throw new Error(`Refusing to delete file outside asset directory: ${target}`);
			}
			await unlink(target);
		} catch {
			// File may already be gone
		}
	}

	assets.splice(idx, 1);
	await saveAssets(assets);
	comfy.invalidateModelCache();
	return true;
}

/** Get ComfyUI-visible models (what ComfyUI actually sees). */
export async function getComfyModels(): Promise<{
	checkpoints: string[];
	loras: string[];
	vaes: string[];
	samplers: string[];
	schedulers: string[];
}> {
	const [checkpoints, loras, vaes, upscalers, samplers, schedulers] = await Promise.all([
		comfy.listCheckpoints(),
		comfy.listLoras(),
		comfy.listVaes(),
		comfy.listUpscalers(),
		comfy.listSamplers(),
		comfy.listSchedulers()
	]);
	return { checkpoints, loras, vaes, upscalers, samplers, schedulers };
}
