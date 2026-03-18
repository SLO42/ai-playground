import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { resolve } from 'path';
import type { HooksConfig, WorkerConfig } from '$lib/types/hooks.js';
import type { DaemonState } from '$lib/types/daemon.js';

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

export const load: PageServerLoad = async ({ params }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	const projectPath = project?.path ?? PATHS.root;

	// Try project-specific settings first, fall back to global
	const projectSettingsPath = resolve(projectPath, '.claude', 'settings.json');
	const [projectSettings, globalSettings, daemonState] = await Promise.all([
		readJsonFile<Settings>(projectSettingsPath),
		readJsonFile<Settings>(PATHS.settingsJson),
		readJsonFile<DaemonState>(PATHS.daemonState)
	]);

	const settings = projectSettings ?? globalSettings;
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

	// Live worker stats from daemon-state.json
	const workerStats = daemonState?.workers ?? {};
	const workerConfigs = daemonState?.config?.workers ?? [];

	return {
		hooks,
		workers,
		learning,
		daemonAutoStart: daemon?.autoStart ?? false,
		daemonRunning: daemonState?.running ?? false,
		daemonStartedAt: daemonState?.startedAt ?? null,
		workerStats,
		workerConfigs
	};
};
