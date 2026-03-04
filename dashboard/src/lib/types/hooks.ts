export interface HookEntry {
	type: string;
	command: string;
	timeout?: number;
}

export interface HookMatcher {
	matcher?: string;
	hooks: HookEntry[];
}

export interface HooksConfig {
	[family: string]: HookMatcher[];
}

export interface WorkerConfig {
	name: string;
	schedule: string;
	priority: number;
	triggers?: string[];
	command?: string;
}

export interface LearningConfig {
	autoTrain?: boolean;
	patternTypes?: string[];
	retention?: Record<string, string>;
}
