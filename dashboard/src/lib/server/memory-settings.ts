import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { PATHS } from './constants.js';

export type MemoryBackend = 'hybrid' | 'sqlite' | 'hnsw';

export interface MemorySettings {
	backend: MemoryBackend;
	enableHNSW: boolean;
	cacheSize: number;
	persistPath: string;
	learningBridgeEnabled: boolean;
	memoryGraphEnabled: boolean;
}

export const MEMORY_DEFAULTS: MemorySettings = {
	backend: 'hybrid',
	enableHNSW: true,
	cacheSize: 100,
	persistPath: '.claude-flow/data',
	learningBridgeEnabled: true,
	memoryGraphEnabled: true
};

export async function loadMemorySettings(): Promise<MemorySettings> {
	// Try playground settings first (user overrides)
	try {
		const raw = await readFile(PATHS.memorySettings, 'utf-8');
		return { ...MEMORY_DEFAULTS, ...JSON.parse(raw) };
	} catch {
		// Fall back to reading from config.yaml
		try {
			const yaml = await readFile(PATHS.configYaml, 'utf-8');
			return parseMemoryFromYaml(yaml);
		} catch {
			return { ...MEMORY_DEFAULTS };
		}
	}
}

function parseMemoryFromYaml(yaml: string): MemorySettings {
	const settings = { ...MEMORY_DEFAULTS };

	const backendMatch = yaml.match(/^\s*backend:\s*(\S+)/m);
	if (backendMatch && ['hybrid', 'sqlite', 'hnsw'].includes(backendMatch[1])) {
		settings.backend = backendMatch[1] as MemoryBackend;
	}

	const hnswMatch = yaml.match(/^\s*enableHNSW:\s*(true|false)/m);
	if (hnswMatch) settings.enableHNSW = hnswMatch[1] === 'true';

	const cacheMatch = yaml.match(/^\s*cacheSize:\s*(\d+)/m);
	if (cacheMatch) settings.cacheSize = parseInt(cacheMatch[1], 10);

	const pathMatch = yaml.match(/^\s*persistPath:\s*(\S+)/m);
	if (pathMatch) settings.persistPath = pathMatch[1];

	const lbMatch = yaml.match(/learningBridge:[\s\S]*?enabled:\s*(true|false)/m);
	if (lbMatch) settings.learningBridgeEnabled = lbMatch[1] === 'true';

	const mgMatch = yaml.match(/memoryGraph:[\s\S]*?enabled:\s*(true|false)/m);
	if (mgMatch) settings.memoryGraphEnabled = mgMatch[1] === 'true';

	return settings;
}

export async function saveMemorySettings(settings: MemorySettings): Promise<void> {
	await mkdir(dirname(PATHS.memorySettings), { recursive: true });
	await writeFile(PATHS.memorySettings, JSON.stringify(settings, null, '\t'), 'utf-8');
}
