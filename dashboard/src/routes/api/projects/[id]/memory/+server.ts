import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { RankedContext, AutoMemoryEntry } from '$lib/types/memory.js';
import type { GraphState } from '$lib/types/graph.js';

export interface ProjectMemoryResponse {
	projectId: string;
	projectName: string;
	summary: {
		totalNodes: number;
		namespaces: number;
		categories: number;
		avgConfidence: number;
		hitRate: string;
	};
	namespaceBreakdown: { name: string; count: number }[];
	categoryBreakdown: { name: string; count: number }[];
	entries: AutoMemoryEntry[];
	context: RankedContext | null;
	graph: GraphState | null;
}

export const GET: RequestHandler = async ({ params }) => {
	const projectId = params.id;

	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === projectId);
	const projectName = project?.name ?? projectId;

	let context: RankedContext | null = null;
	let autoMemory: AutoMemoryEntry[] | null = null;
	let graphRaw: GraphState | null = null;

	try {
		[context, autoMemory, graphRaw] = await Promise.all([
			readJsonFile<RankedContext>(PATHS.rankedContext),
			readJsonFile<AutoMemoryEntry[]>(PATHS.autoMemoryStore),
			readJsonFile<GraphState>(PATHS.graphState)
		]);
	} catch {
		// Individual reads may fail (missing files, parse errors) — continue with defaults
	}

	const graph: GraphState | null = graphRaw && typeof graphRaw === 'object' && graphRaw.nodes
		? { ...graphRaw, edges: graphRaw.edges ?? [], pageRanks: graphRaw.pageRanks ?? {} }
		: null;

	// Filter auto-memory entries relevant to this project
	// Check metadata.projectId first (reliable), then fall back to sourceFile path matching
	const entries = (autoMemory ?? []).filter((e) => {
		const meta = e.metadata as Record<string, unknown> | undefined;

		// Primary: explicit projectId in metadata
		if (meta?.projectId === projectId) return true;
		if (meta?.projectName === projectName) return true;

		// Secondary: namespace scoping (e.g., claude-flow:rounds-mod)
		if (e.namespace?.includes(projectId)) return true;

		// Tertiary: sourceFile path matching
		const source = (meta?.sourceFile as string) ?? '';
		if (source.includes(projectId)) return true;

		// Check if project name appears in the key
		if (e.key?.includes(projectId)) return true;

		return false;
	});

	// If no project-specific entries, fall back to all entries only for root project
	const isRootProject = project?.path === '.' || project?.path === PATHS.root;
	const effectiveEntries = entries.length > 0 ? entries : (isRootProject ? (autoMemory ?? []) : []);

	const namespaces = new Map<string, number>();
	for (const e of effectiveEntries) {
		const ns = e.namespace ?? 'default';
		namespaces.set(ns, (namespaces.get(ns) ?? 0) + 1);
	}

	const categories = new Map<string, number>();
	const contextEntries = context?.entries ?? [];
	for (const e of contextEntries) {
		const cat = e.category ?? 'unknown';
		categories.set(cat, (categories.get(cat) ?? 0) + 1);
	}

	const avgConfidence =
		contextEntries.length > 0
			? contextEntries.reduce((sum, e) => sum + e.confidence, 0) / contextEntries.length
			: 0;

	const body: ProjectMemoryResponse = {
		projectId,
		projectName,
		summary: {
			totalNodes: effectiveEntries.length + contextEntries.length,
			namespaces: namespaces.size,
			categories: categories.size,
			avgConfidence,
			hitRate: avgConfidence > 0 ? (avgConfidence * 100).toFixed(1) + '%' : 'N/A'
		},
		namespaceBreakdown: Array.from(namespaces.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count),
		categoryBreakdown: Array.from(categories.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count),
		entries: effectiveEntries,
		context,
		graph: graph ?? null
	};

	return json(body);
};
