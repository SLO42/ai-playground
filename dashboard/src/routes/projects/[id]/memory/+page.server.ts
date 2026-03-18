import { resolve } from 'path';
import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { GraphState } from '$lib/types/graph.js';
import type { AutoMemoryEntry } from '$lib/types/memory.js';

interface NamespaceInfo {
	name: string;
	count: number;
	color: string;
}

interface MemoryPageData {
	projectId: string;
	projectName: string;
	projectPath: string;
	graph: GraphState | null;
	autoMemory: AutoMemoryEntry[];
	namespaces: NamespaceInfo[];
	stats: {
		totalNodes: number;
		totalAutoMemory: number;
		totalNamespaces: number;
		totalEdges: number;
	};
}

const NS_COLORS: Record<string, string> = {
	patterns: 'accent-blue',
	decisions: 'accent-purple',
	context: 'accent-cyan',
	errors: 'accent-red',
	dependencies: 'accent-yellow',
	'user-prefs': 'accent-green',
	security: 'accent-red',
	sessions: 'accent-green',
	agents: 'accent-blue',
	routing: 'accent-cyan',
	hooks: 'accent-yellow'
};

function pickColor(ns: string, index: number): string {
	if (NS_COLORS[ns]) return NS_COLORS[ns];
	const fallback = ['accent-blue', 'accent-purple', 'accent-cyan', 'accent-green', 'accent-yellow', 'accent-red'];
	return fallback[index % fallback.length];
}

export const load: PageServerLoad = async ({ parent, params }): Promise<MemoryPageData> => {
	const { project } = await parent();
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const scannedProject = projects.find((p) => p.id === params.id);
	const projectPath = scannedProject?.path ?? project.path;
	const projectName = scannedProject?.name ?? project.name;

	// Load graph state — try project-local first, then global
	let graph: GraphState | null = null;
	const projectGraphPath = resolve(projectPath, '.claude-flow/data/graph-state.json');
	graph = await readJsonFile<GraphState>(projectGraphPath);
	if (!graph) {
		// Fall back to global graph and filter by project-related nodes
		graph = await readJsonFile<GraphState>(PATHS.graphState);
	}

	// Load auto-memory — try project-local first, then filter global
	let autoMemory: AutoMemoryEntry[] = [];
	const projectMemoryPath = resolve(projectPath, '.claude-flow/data/auto-memory-store.json');
	const localMemory = await readJsonFile<AutoMemoryEntry[]>(projectMemoryPath);
	if (localMemory && localMemory.length > 0) {
		autoMemory = localMemory;
	} else {
		// Filter global auto-memory by project path
		const globalMemory = await readJsonFile<AutoMemoryEntry[]>(PATHS.autoMemoryStore);
		if (globalMemory) {
			const normalizedPath = projectPath.replace(/\\/g, '/').toLowerCase();
			autoMemory = globalMemory.filter((entry) => {
				const source = (entry.source ?? '').replace(/\\/g, '/').toLowerCase();
				const key = (entry.key ?? '').toLowerCase();
				const value = (entry.value ?? '').toLowerCase();
				const projectId = params.id.toLowerCase();
				return (
					source.includes(normalizedPath) ||
					key.includes(projectId) ||
					value.includes(normalizedPath) ||
					(entry.namespace && entry.namespace === projectId)
				);
			});
		}
	}

	// Compute namespace distribution
	const nsCounts = new Map<string, number>();
	for (const entry of autoMemory) {
		const ns = entry.namespace ?? 'default';
		nsCounts.set(ns, (nsCounts.get(ns) ?? 0) + 1);
	}
	const namespaces: NamespaceInfo[] = [...nsCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([name, count], i) => ({
			name,
			count,
			color: pickColor(name, i)
		}));

	const nodeCount = graph?.nodeCount ?? (graph?.nodes ? Object.keys(graph.nodes).length : 0);
	const edgeCount = graph?.edges?.length ?? 0;

	return {
		projectId: params.id,
		projectName,
		projectPath,
		graph,
		autoMemory,
		namespaces,
		stats: {
			totalNodes: nodeCount,
			totalAutoMemory: autoMemory.length,
			totalNamespaces: namespaces.length,
			totalEdges: edgeCount
		}
	};
};
