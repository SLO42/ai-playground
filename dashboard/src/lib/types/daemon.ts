export interface DaemonWorkerStats {
	runCount: number;
	successCount: number;
	failureCount: number;
	averageDurationMs: number;
	isRunning: boolean;
	nextRun?: string;
	lastRun?: string;
}

export interface DaemonWorkerConfig {
	type: string;
	intervalMs: number;
	offsetMs: number;
	priority: string;
	description: string;
	enabled: boolean;
}

export interface DaemonState {
	running: boolean;
	startedAt: string;
	savedAt: string;
	workers: Record<string, DaemonWorkerStats>;
	config: {
		autoStart: boolean;
		logDir: string;
		stateFile: string;
		maxConcurrent: number;
		workerTimeoutMs: number;
		workers: DaemonWorkerConfig[];
	};
}

export interface GraphState {
	version: number;
	updatedAt: number;
	nodeCount: number;
	nodes: Record<string, { id: string; category: string; confidence: number; accessCount: number }>;
	edges: Array<{ sourceId: string; targetId: string; type: string; weight: number }>;
	pageRanks: Record<string, number>;
}
