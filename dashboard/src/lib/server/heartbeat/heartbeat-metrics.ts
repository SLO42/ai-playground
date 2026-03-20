import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from '../constants.js';

const METRICS_PATH = resolve(PATHS.root, '.playground/heartbeat-metrics.json');
const MAX_CYCLES = 100;

export interface CycleMetrics {
	timestamp: string;
	totalMs: number;
	tasksProcessed: number;
	timings: Record<string, number>;
}

export async function recordHeartbeatMetrics(metrics: Omit<CycleMetrics, 'timestamp'>): Promise<void> {
	let history: CycleMetrics[] = [];
	try { history = JSON.parse(await readFile(METRICS_PATH, 'utf-8')); } catch { /* no existing file */ }
	history.push({ ...metrics, timestamp: new Date().toISOString() });
	if (history.length > MAX_CYCLES) history = history.slice(-MAX_CYCLES);
	await mkdir(dirname(METRICS_PATH), { recursive: true });
	await writeFile(METRICS_PATH, JSON.stringify(history, null, '\t'), 'utf-8');
}

export async function getHeartbeatMetrics(): Promise<CycleMetrics[]> {
	try { return JSON.parse(await readFile(METRICS_PATH, 'utf-8')); } catch { return []; }
}
