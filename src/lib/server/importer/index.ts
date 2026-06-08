// server/importer — public barrel (TASK 1.7; IMPLEMENTATION-PLAN §1.7, DATA-MODEL
// §11). One-time, re-runnable v1 → v2 migration: `registry.json` → `project` and
// the v1 task store → `task`. Idempotent by deterministic record id (the dedup_key
// principle, D-008): re-running the import produces no duplicate rows.

export {
	// import entry points
	importProjects,
	importTasks,
	importV1FromFiles,
	// id derivation (the dedup keys)
	projectSlugOf,
	taskDedupId,
	// enum mappers
	mapV1Status,
	mapV1Priority,
	// types
	type V1Project,
	type V1Registry,
	type V1Task,
	type V1TaskStore,
	type ImportCounts,
	type ImportTasksOptions,
	type ImportV1Options
} from './v1';

export {
	// remaining-store importers (TASK 2.9)
	importSwarmMemory,
	importSwarmMemoryFromDb,
	importGraphState,
	importGraphStateFromFile,
	// mappers + predicates
	mapSwarmKind,
	mapEdgeKind,
	parseSwarmEmbedding,
	needsReEmbed,
	swarmMemoryDedupKey,
	graphEntityId,
	// types
	type SwarmMemoryRow,
	type V1GraphState,
	type V1GraphNode,
	type V1GraphEdge,
	type ImportSwarmResult,
	type ImportGraphResult
} from './v1-stores';
