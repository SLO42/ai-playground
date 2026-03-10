import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { projectMemoryCache } from '$lib/server/cache.js';
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

const RANGE_MS: Record<string, number> = {
	'1h': 3_600_000,
	'6h': 21_600_000,
	'24h': 86_400_000,
	'7d': 604_800_000
};

function filterGraphByRange(graph: GraphState, cutoff: number): GraphState {
	const nodes: Record<string, GraphState['nodes'][string]> = {};
	for (const [id, node] of Object.entries(graph.nodes)) {
		if (node.createdAt != null && node.createdAt >= cutoff) {
			nodes[id] = node;
		}
	}
	const nodeIds = new Set(Object.keys(nodes));
	// Support both source/target and sourceId/targetId edge shapes
	const edges = (graph.edges ?? []).filter((e) => {
		const src = (e as Record<string, unknown>).source ?? e.sourceId;
		const tgt = (e as Record<string, unknown>).target ?? e.targetId;
		return nodeIds.has(src as string) && nodeIds.has(tgt as string);
	});
	const pageRanks: Record<string, number> = {};
	for (const id of nodeIds) {
		if (graph.pageRanks?.[id] != null) pageRanks[id] = graph.pageRanks[id];
	}
	return { ...graph, nodes, edges, pageRanks };
}

export const GET: RequestHandler = async ({ params, url }) => {
	const projectId = params.id;
	const range = url.searchParams.get('range') ?? null;
	const cacheKey = `project-memory:${projectId}:${range ?? 'all'}`;

	// Check cache first
	const cached = projectMemoryCache.get(cacheKey) as ProjectMemoryResponse | undefined;
	if (cached) {
		const ttl = projectMemoryCache.getRemainingTtl(cacheKey);
		return json(cached, {
			headers: { 'Cache-Control': `max-age=${ttl}, stale-while-revalidate=10` }
		});
	}

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

	let graph: GraphState | null = graphRaw && typeof graphRaw === 'object' && graphRaw.nodes
		? { ...graphRaw, edges: graphRaw.edges ?? [], pageRanks: graphRaw.pageRanks ?? {} }
		: null;

	// Apply time-range filtering to graph
	if (graph && range && RANGE_MS[range]) {
		const cutoff = Date.now() - RANGE_MS[range];
		graph = filterGraphByRange(graph, cutoff);
	}

	// Filter auto-memory entries relevant to this project
	const entries = (autoMemory ?? []).filter((e) => {
		const meta = e.metadata as Record<string, unknown> | undefined;
		if (meta?.projectId === projectId) return true;
		if (meta?.projectName === projectName) return true;
		if (e.namespace?.includes(projectId)) return true;
		const source = (meta?.sourceFile as string) ?? '';
		if (source.includes(projectId)) return true;
		if (e.key?.includes(projectId)) return true;
		return false;
	});

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

	// Store in cache and return with Cache-Control
	projectMemoryCache.set(cacheKey, body);
	return json(body, {
		headers: { 'Cache-Control': 'max-age=30, stale-while-revalidate=10' }
	});
};
