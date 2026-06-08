// server/routing — public barrel (TASK 2.3; ARCHITECTURE §2.5; D-020; F-005).
//
// ONE resolveRoute() resolves a task → ResolvedPlan through the canonical order
// (explicit override → classify → tier → adaptive config → provider/health →
// fallback) and writes the decision as a routing_event. Routing is the SOLE
// producer of routing_event (§2.5); analytics only queries it. Import routing
// from here.

export {
	resolveRoute,
	classifyIntent,
	scoreComplexity,
	writeRoutingEvent,
	ROUTING_METHODS,
	INTENTS,
	type RoutingMethod,
	type RouteTask,
	type ResolvedPlan,
	type ResolveRouteInput,
	type WriteRoutingEventInput
} from './resolve';
