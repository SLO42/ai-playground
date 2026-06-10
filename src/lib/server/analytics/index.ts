// server/analytics — public barrel (TASK 2.4).
//
// The analytics module is the CONSUMER side of the first-class analytics spine: it
// writes every agent lifecycle step (writeAgentEvent — the one chokepoint) and reads
// `agent_event` + `routing_event` back into daily rollups, anomaly flags, per-tier
// usage, and the how/why trace for a single action. It NEVER produces routing_event
// (routing is that table's sole owner — §2.5) and rides the `events` bus only (D-038/§2.11).

export {
	writeAgentEvent,
	activityLabel,
	AGENT_EVENT_TYPES,
	type AgentEventType,
	type AgentEventModel,
	type AgentEventDetail,
	type WriteAgentEventInput
} from './events';

export {
	buildReportSummary,
	buildTierUsage,
	buildShellMetrics,
	foldDaily,
	detectAnomalies,
	type DailyRollup,
	type Anomaly,
	type ReportSummary,
	type TierUsage,
	type ShellMetrics,
	type RollupOptions
} from './rollup';

export { traceAction, type ActionTrace, type TraceStep } from './trace';

export {
	buildRoutingRationale,
	aggregateDecisions,
	type RoutingRationale,
	type RoutingDecision,
	type RationaleAggregate,
	type RationaleBucket,
	type RoutingRationaleOptions,
	type DecisionOutcome
} from './routing-rationale';

export {
	listPoolSlots,
	listFleet,
	listFleetByProject,
	listFleetAcrossProjects,
	listAgentCatalog,
	type PoolSlot,
	type FleetSession,
	type FleetSessionXP,
	type AgentCatalogEntry,
	type AgentCatalogScope
} from './fleet';
