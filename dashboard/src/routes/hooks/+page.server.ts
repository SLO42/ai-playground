import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { HooksConfig, WorkerConfig } from '$lib/types/hooks.js';

interface Settings {
	hooks?: HooksConfig;
	claudeFlow?: {
		daemon?: {
			autoStart?: boolean;
			workers?: string[];
			schedules?: Record<string, { interval: string; priority: string; triggers?: string[] }>;
		};
		learning?: {
			enabled?: boolean;
			autoTrain?: boolean;
			patterns?: string[];
			retention?: Record<string, string>;
		};
	};
}

const PRIORITY_MAP: Record<string, number> = {
	critical: 1,
	high: 2,
	normal: 3,
	low: 4
};

export const load: PageServerLoad = async () => {
	const settings = await readJsonFile<Settings>(PATHS.settingsJson);

	const hooks: HooksConfig = settings?.hooks ?? {};

	// Build worker configs from daemon section
	const daemon = settings?.claudeFlow?.daemon ?? null;
	const workers: WorkerConfig[] = [];
	if (daemon?.workers && daemon?.schedules) {
		for (const name of daemon.workers) {
			const sched = daemon.schedules[name];
			if (sched) {
				workers.push({
					name,
					schedule: sched.interval,
					priority: PRIORITY_MAP[sched.priority] ?? 3,
					triggers: sched.triggers
				});
			} else {
				workers.push({ name, schedule: 'on-demand', priority: 5 });
			}
		}
	}

	const learning = settings?.claudeFlow?.learning ?? null;

	return {
		hooks,
		workers,
		learning,
		daemonAutoStart: daemon?.autoStart ?? false
	};
};
