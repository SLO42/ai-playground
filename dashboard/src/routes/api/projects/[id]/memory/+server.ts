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

	const [context, autoMemory, graph] = await Promise.all([
		readJsonFile<RankedContext>(PATHS.rankedContext),
		readJsonFile<AutoMemoryEntry[]>(PATHS.autoMemoryStore),
		readJsonFile<GraphState>(PATHS.graphState)
	]);

	// Filter auto-memory entries relevant to this project
	const entries = (autoMemory ?? []).filter((e) => {
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

	// If no project-specific entries, fall back to all entries (project may be the root)
	const effectiveEntries = entries.length > 0 ? entries : (autoMemory ?? []);

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
