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

// LG-2 (LIFECYCLE-GRAPH-SPEC §LG-2) — the live causal node-graph read model
// (Continue→session→PM→task). Pure READ over scene_event + session/task/agent_event;
// the LG-3 UI (/projects/[id]/graph) renders + animates this off the existing onDbChange SSE.
export {
	buildLifecycleGraph,
	type LifecycleGraph,
	type LifecycleNode,
	type LifecycleEdge,
	type LifecycleNodeKind,
	type LifecycleEdgeKind,
	type LifecycleSource,
	type LifecycleGraphLimits,
	type LifecycleNodeDetail,
	type LifecycleToolCount
} from './lifecycle';
