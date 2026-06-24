// server/cc-config — public barrel (TASK 1.8; D-010, depends on: 0.c).
//
// Read-only sync of a project's `.claude/` + `.mcp.json` (project + global) into
// the cc_* mirror tables. The filesystem is authoritative (D-010); these tables
// are a query/index mirror for the /claude-code catalog. Drift detection surfaces
// the "synced / out-of-sync" state.

export {
	parseSettings,
	parseMcpServers,
	flattenHooks,
	splitFrontmatter,
	parseAgentFile,
	parseSkillFile,
	scanAgents,
	scanSkills,
	readScope,
	digestScope,
	stableStringify,
	type ParsedHook,
	type ParsedMcpServer,
	type ParsedSettings,
	type ParsedAgent,
	type ParsedSkill,
	type ScopeContent
} from './parse';

export {
	syncScope,
	syncState,
	mirrorDigest,
	readCatalog,
	catalogIds,
	scopeIdOf,
	confineScope,
	projectScopeOf,
	classifyScopes,
	reconcileScopes,
	harvestScopeDir,
	harvestScope,
	ensureHarvestScope,
	ScopeConfinementError,
	type SyncScope,
	type SyncResult,
	type SyncStatus,
	type ScopeState,
	type CatalogScope,
	type CatalogIds,
	type ScopeRowView,
	type ScopeReconcileResult
} from './sync';

// TASK 2.11 — read-WRITE config manager (D-010): validate → diff + confirm → write →
// re-sync, plus a watcher for external edits.
export {
	planEdit,
	applyEdit,
	validateContent,
	validateSettings,
	validateMcpJson,
	projectSettings,
	ConfigValidationError,
	StaleConfirmError,
	type ConfigKind,
	type ValidationIssue,
	type ValidationResult,
	type ConfigDiff,
	type PlanEditInput,
	type EditPlan,
	type ApplyEditInput,
	type ApplyEditResult
} from './write';

export {
	watchScope,
	type WatchOptions,
	type WatchHandle,
	type ConfigChangeEvent
} from './watch';
