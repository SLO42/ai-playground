import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { PATHS } from '$lib/server/constants.js';
import type { V3Progress, SwarmActivity } from '$lib/types/metrics.js';
import { getAgentAnalytics } from '$lib/server/heartbeat/agent-analytics.js';
import { getPoolStats, getConfigAgents } from '$lib/server/heartbeat/session-pool.js';
import { getActiveAgents } from '$lib/server/heartbeat/shared.js';
import { scanAgents } from '$lib/server/agent-scanner.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

/** Build a reverse map: agentFilename → projectId[] */
async function buildAgentProjectMap(): Promise<Record<string, string[]>> {
	const map: Record<string, string[]> = {};
	try {
		const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
		for (const project of projects) {
			try {
				const raw = await readFile(resolve(project.path, '.playground', 'agents.json'), 'utf-8');
				const parsed = JSON.parse(raw) as { agents?: string[] };
				if (parsed.agents) {
					for (const filename of parsed.agents) {
						if (!map[filename]) map[filename] = [];
						map[filename].push(project.id);
					}
				}
			} catch { /* no association file */ }
		}
	} catch { /* scan failed */ }
	return map;
}

export const load: PageServerLoad = async ({ url }) => {
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('perPage') ?? '24', 10) || 24));
	const agentsDir = PATHS.agentsDir;

	const [agents, v3Progress, swarmActivity, swarmConfig, analytics, rawPoolStats, configAgents, agentProjectMap] = await Promise.all([
		scanAgents(agentsDir),
		readJsonFile<V3Progress>(PATHS.v3Progress),
		readJsonFile<SwarmActivity>(PATHS.swarmActivity),
		readYamlFile<Record<string, unknown>>(PATHS.configYaml),
		getAgentAnalytics(),
		getPoolStats(),
		getConfigAgents(),
		buildAgentProjectMap()
	]);

	// Get active agents (synchronous)
	const activeAgentsMap = getActiveAgents();
	const activeAgentsList = Array.from(activeAgentsMap.values()).map(a => ({
		taskId: a.taskId,
		pid: a.pid,
		startedAt: a.startedAt,
		label: a.sender.label,
		color: a.sender.color,
		sessionId: a.reportSessionId
	}));

	const total = agents.length;
	const totalPages = Math.max(1, Math.ceil(total / perPage));
	const safePage = Math.min(page, totalPages);
	const start = (safePage - 1) * perPage;
	const paginatedAgents = agents.slice(start, start + perPage);

	return {
		agents: paginatedAgents,
		total,
		page: safePage,
		perPage,
		totalPages,
		swarmStatus: {
			active: swarmActivity?.swarm?.active ?? false,
			agentCount: swarmActivity?.swarm?.agent_count ?? 0,
			coordinationActive: swarmActivity?.swarm?.coordination_active ?? false,
			processes: swarmActivity?.processes ?? null
		},
		v3Progress: {
			activeAgents: v3Progress?.swarm?.activeAgents ?? 0,
			maxAgents: v3Progress?.swarm?.maxAgents ?? 6,
			topology: v3Progress?.swarm?.topology ?? 'hierarchical-mesh'
		},
		swarmConfig: swarmConfig ?? null,
		analytics,
		poolStats: rawPoolStats,
		activeAgents: activeAgentsList,
		agentProjectMap
	};
};
