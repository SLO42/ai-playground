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
	scopeIdOf,
	confineScope,
	ScopeConfinementError,
	type SyncScope,
	type SyncResult,
	type SyncStatus,
	type ScopeState,
	type CatalogScope
} from './sync';
