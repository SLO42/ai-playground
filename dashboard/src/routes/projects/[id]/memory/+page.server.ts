import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import { projectMemoryCache } from '$lib/server/cache.js';
import type { RankedContext, AutoMemoryEntry } from '$lib/types/memory.js';
import type { GraphState } from '$lib/types/graph.js';

export const load: PageServerLoad = async ({ parent }) => {
	const { projectId, project } = await parent();
	const projectName = project.name;
	const cacheKey = `page-memory:${projectId}`;

	const cached = projectMemoryCache.get(cacheKey);
	if (cached) return cached as Record<string, unknown>;

	let entries: AutoMemoryEntry[] = [];
	let context: RankedContext | null = null;
	let loadError: string | null = null;
	let graph: GraphState | null = null;

	try {
		const [contextResult, autoMemory, graphResult] = await Promise.all([
			readJsonFile<RankedContext>(PATHS.rankedContext),
			readJsonFile<AutoMemoryEntry[]>(PATHS.autoMemoryStore),
			readJsonFile<GraphState>(PATHS.graphState)
		]);

		graph = graphResult ?? null;
		const allEntries = autoMemory ?? [];

		// Filter entries relevant to this project (same logic as API endpoint)
		const filtered = allEntries.filter((e) => {
			const source = (e.metadata?.sourceFile as string) ?? '';
			const projectMatch = source.match(/projects[/\\]([^/\\]+)[/\\]/);
			const entryProject = projectMatch
				? projectMatch[1].replace(/^[Cc]--/, '').replace(/-/g, '/').split('/').pop()
				: '';
			return (
				entryProject === projectName ||
				entryProject === projectId ||
				source.includes(projectId)
			);
		});

		// Fall back to all entries if no project-specific ones found (root project)
		entries = filtered.length > 0 ? filtered : allEntries;
		context = contextResult ?? null;
	} catch (e) {
		loadError = e instanceof Error ? e.message : 'Failed to load memory data';
	}

	// Namespace breakdown
	const namespaces = new Map<string, number>();
	for (const e of entries) {
		const ns = e.namespace ?? 'default';
		namespaces.set(ns, (namespaces.get(ns) ?? 0) + 1);
	}

	// Category breakdown from ranked context
	const contextEntries = context?.entries ?? [];
	const categories = new Map<string, number>();
	for (const e of contextEntries) {
		const cat = e.category ?? 'unknown';
		categories.set(cat, (categories.get(cat) ?? 0) + 1);
	}

	const avgConfidence =
		contextEntries.length > 0
			? contextEntries.reduce((sum, e) => sum + e.confidence, 0) / contextEntries.length
			: 0;

	const result = {
		projectId,
		projectName,
		loadError,
		graph,
		summary: {
			totalNodes: entries.length + contextEntries.length,
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
		entries,
		context
	};

	if (!loadError) projectMemoryCache.set(cacheKey, result);

	return result;
};
