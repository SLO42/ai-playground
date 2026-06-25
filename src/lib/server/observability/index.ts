// UO-2 (USAGE-OBSERVABILITY-SPEC) — public surface for the usage read model. Pure READ
// aggregation over already-persisted data (UO-1 grants + tool_use message rows); no write path.
export {
	sessionToolBreakdown,
	usageRollup,
	DEFAULT_SESSION_TOOL_ROW_CAP,
	DEFAULT_ROLLUP_SESSION_CAP,
	DEFAULT_ROLLUP_TOOL_ROW_CAP,
	type ToolCount,
	type SessionToolBreakdown,
	type SessionRef,
	type CapabilityDimension,
	type GrantedCapabilityRollup,
	type UsedToolRollup,
	type UsageRollup,
	type UsageRollupOptions
} from './usage';
