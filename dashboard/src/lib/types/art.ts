// ── Art Generation Types ─────────────────────────────────────────────

export interface ArtAsset {
	id: string;
	name: string;
	type: 'checkpoint' | 'lora' | 'vae' | 'embedding' | 'upscaler';
	source: 'civitai' | 'huggingface' | 'local';
	sourceId?: string;
	sourceUrl?: string;
	filePath: string;              // relative to ComfyUI models dir
	triggerWords: string[];
	compatibleBases: string[];     // e.g. ['sdxl', 'sd15', 'pony', 'flux']
	hash?: string;
	downloadedAt: string;
	tested: boolean;
	notes?: string;
}

export interface LoraRef {
	name: string;                  // filename in ComfyUI loras dir
	strength: number;              // 0.0 - 2.0 typically
	clipStrength?: number;         // separate CLIP strength if needed
	triggerWords: string[];        // injected into prompt
}

export interface GenerationParams {
	steps: number;
	cfg: number;
	sampler: string;
	scheduler: string;
	width: number;
	height: number;
	seed: number;                  // -1 for random
	denoise?: number;              // for img2img
}

export interface Generation {
	id: string;
	experimentId: string;
	positive: string;
	negative: string;
	checkpoint: string;
	loras: LoraRef[];
	params: GenerationParams;
	outputFile: string;            // relative path in art/outputs/
	comfyPromptId: string;
	score?: number;                // 1-5 user or vision model rating
	autoScore?: number;            // vision model score
	autoFeedback?: string;         // vision model description
	notes?: string;
	createdAt: string;
}

export interface ExperimentVariable {
	field: string;                 // e.g. 'params.cfg', 'positive', 'loras[0].strength'
	values: (string | number)[];   // values to test
}

export interface Experiment {
	id: string;
	name: string;
	hypothesis: string;
	variables: ExperimentVariable[];
	defaults: {
		positive: string;
		negative: string;
		checkpoint: string;
		loras: LoraRef[];
		params: GenerationParams;
	};
	generations: Generation[];
	status: 'planned' | 'running' | 'complete' | 'failed';
	conclusion?: string;
	createdAt: string;
	completedAt?: string;
}

// ── Knowledge Base ──────────────────────────────────────────────────

export interface PromptTemplate {
	id: string;
	name: string;
	positive: string;              // can contain {subject}, {style} placeholders
	negative: string;
	style: string;                 // 'anime', 'photorealistic', 'oil_painting', etc.
	avgScore: number;
	useCount: number;
}

export interface KeywordEntry {
	keyword: string;
	effect: 'positive' | 'negative' | 'neutral';
	models: string[];              // which models it works on
	avgScoreImpact: number;        // delta from baseline when added
	sampleCount: number;
}

export interface LoraProfile {
	name: string;                  // filename
	displayName: string;
	triggerWords: string[];
	bestModels: string[];
	bestStrength: number;
	bestCfg: number;
	bestSampler: string;
	avgScore: number;
	testCount: number;
	examplePrompts: string[];
}

export interface ModelProfile {
	name: string;                  // filename
	displayName: string;
	baseType: string;              // 'sdxl', 'sd15', 'flux', etc.
	strengths: string[];
	weaknesses: string[];
	bestSamplers: string[];
	optimalCfg: number;
	optimalSteps: number;
	avgScore: number;
	testCount: number;
}

export interface ArtKnowledge {
	promptTemplates: PromptTemplate[];
	keywordIndex: KeywordEntry[];
	loraProfiles: LoraProfile[];
	modelProfiles: ModelProfile[];
	lastUpdated: string;
}
