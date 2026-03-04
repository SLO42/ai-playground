export interface ModelProvider {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	models: ModelDefinition[];
}

export interface ModelDefinition {
	id: string;
	name: string;
	reasoning?: boolean;
	input?: string[];
	cost?: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	contextWindow?: number;
	maxTokens?: number;
}

export interface ModelsConfig {
	models: {
		providers: Record<string, ModelProvider>;
		defaults: {
			primary: string;
			fallbacks: string[];
		};
	};
}
