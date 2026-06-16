// server/events — WATCHED_TABLES, the single source of truth for which tables get a
// boot-time live query (TASK 13.1; ARCHITECTURE §2.11).
//
// hooks.server.ts opens ONE live query per table listed here (via watchTable) and the
// one SSE fan-out republishes the row changes. A table a route subscribes to via
// `stream.onDbChange(table, …)` but that is MISSING here NEVER live-updates — the
// subscription silently waits on events that cannot fire (the 13.1 finding:
// workflow_run was unwatched, so the release page's documented live step_state
// updates could never arrive).
//
// INVARIANT (enforced by watched-tables.test.ts): this list is a superset of every
// table name any route/component passes to onDbChange, and every entry is defined in
// schema.ts (so the boot live query cannot fail on a missing table). When you add an
// `onDbChange('new_table', …)` subscription anywhere, add `new_table` here with a
// comment naming the route — the static-scan test fails the suite otherwise.

/** Tables whose row changes feed the dashboard's live regions, each annotated with
 *  every route that subscribes to it (audited 13.1; keep in sync when adding routes). */
export const WATCHED_TABLES = [
	// project — shell layout ticker; / (home); /projects; /projects/[id]; /claude-code
	'project',
	// task — / (home); /projects/[id]; /projects/[id]/sync
	'task',
	// session — shell layout ticker; / (home); /workflows; /agents; /claude-code; /projects/[id]
	'session',
	// message — /claude-code (live transcript panel: the persisted LT1 conversation rows
	// replay + live-append as the driven session writes turns) — TASK (transcript-panel);
	// /atelier (G-C global timeline — message turns + pushed-in communications)
	'message',
	// peer_message — /atelier (G-C global timeline + inbox lens: agent↔agent comms incl.
	// pending/expired/quarantined that never reached a transcript row) — GLOBAL-TRANSCRIPT-SPEC §5b
	'peer_message',
	// agent_event — shell layout ticker; / (home); /agents; /reports
	'agent_event',
	// routing_event — /reports
	'routing_event',
	// security_finding — /reports; /projects/[id]
	'security_finding',
	// service — shell layout ticker; / (home); /services
	'service',
	// pm_memory — /projects/[id] (PM tab)
	'pm_memory',
	// decision — /projects/[id] (PM tab)
	'decision',
	// sprint — /projects/[id] (PM tab)
	'sprint',
	// pm_review — /projects/[id] (PM tab)
	'pm_review',
	// pm — /projects/[id] (PM tab: hired identity + charter, TASK 16.1)
	'pm',
	// task_sync — /projects/[id]/sync
	'task_sync',
	// board_sync_config — /projects/[id]/sync
	'board_sync_config',
	// sync_incident — /projects/[id]/sync; /projects/[id]/targets
	'sync_incident',
	// project_target — /projects/[id]/targets; /projects/[id]/release
	'project_target',
	// target_run — /projects/[id]/targets; /projects/[id]/release
	'target_run',
	// workflow — /workflows
	'workflow',
	// workflow_run — /workflows; /projects/[id]/release (live step_state)
	'workflow_run',
	// memory — /memory; /projects/[id] (memory tab)
	'memory',
	// entity — /memory (graph); /projects/[id]
	'entity',
	// references — /memory (graph edges; RELATION table)
	'references',
	// notification — shell layout ticker; /services; /reports
	'notification',
	// decision_brief — shell layout (RightTray decisions inbox); /projects/[id] (PM tab) — TASK 16.4
	'decision_brief',
	// panel_verdict — /projects/[id] (PM tab proposals queue) — TASK 16.4; /atelier (G-C verdicts)
	'panel_verdict',
	// incident — /reports (incidents history)
	'incident',
	// cc_agent — /agents (catalog) + /claude-code catalog
	'cc_agent',
	// role — /agents (workforce panel role cards) — TASK 16.7b (W-D7c surfaces)
	'role',
	// role_version — /agents (workforce panel version chip + lifecycle) — TASK 16.7b
	'role_version',
	// interview_run — /agents (interview line + §3.4 adjudication queue) — TASK 16.7b
	'interview_run',
	// role_event — /agents (workforce audit feed re-derives the panel) — TASK 16.7b;
	// /atelier (G-C global timeline — workforce lifecycle turns)
	'role_event',
	// gauntlet_fixture — /agents/ceremony (day-0 ceremony DRIVER: a seed creates proposed
	// fixtures, re-deriving the authoring flow live) — TASK W-D7c CER1
	'gauntlet_fixture'
] as const;

/** One of the boot-watched table names. */
export type WatchedTable = (typeof WATCHED_TABLES)[number];
