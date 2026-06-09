// TASK 9.2 — Home / portfolio overview, LIVE (UI-SPEC §6; F-008; D-019).
//
// The real Home dashboard read model (was a single count card). Serves the at-a-glance
// portfolio + engine health from REAL rows only (F-008): four headline metrics
// (projects · running agents · today's tokens+cost · services up), a recent agent-activity
// feed, a portfolio task summary (counts by status), and the LIVE fleet of running/recent
// sessions — the SAME liveness source as /agents (session.status, never agent_slot.busy).
//
// Degrades honestly (D-019): when the DB singleton isn't connected, everything is reported
// as unknown (null/empty), never zero-dressed-as-real. A cached-but-dead handle that throws
// mid-query is classified the same way the other surfaces classify it.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { listProjects } from '$lib/server/projects/repo';
import { buildShellMetrics, listFleet } from '$lib/server/analytics';
import type { ShellMetrics, FleetSession } from '$lib/server/analytics';
import {
	readServicesHealth,
	listRecentActivity,
	buildTaskSummary,
	type ServicesHealth,
	type ActivityItem,
	type TaskSummary
} from '$lib/server/home';
import type { PageServerLoad } from './$types';

export interface HomeData {
	connected: boolean;
	projectCount: number | null;
	metrics: ShellMetrics | null;
	services: ServicesHealth | null;
	activity: ActivityItem[];
	taskSummary: TaskSummary | null;
	fleet: FleetSession[];
}

function disconnected(): HomeData {
	return {
		connected: false,
		projectCount: null,
		metrics: null,
		services: null,
		activity: [],
		taskSummary: null,
		fleet: []
	};
}

export const load: PageServerLoad = async ({ depends }): Promise<HomeData> => {
	// Each region re-invalidates on its own table's SSE watcher (live by default, §1.2).
	depends('app:projects');
	depends('app:fleet');
	depends('app:analytics');
	depends('app:services');
	depends('app:tasks');

	const db = tryGetDb();
	if (!db) {
		return disconnected();
	}
	try {
		const [projects, metrics, services, activity, taskSummary, fleet] = await Promise.all([
			listProjects(db),
			buildShellMetrics(db),
			readServicesHealth(db),
			listRecentActivity(db, 8),
			buildTaskSummary(db),
			listFleet(db, 24)
		]);
		return {
			connected: true,
			projectCount: projects.length,
			metrics,
			services,
			activity,
			taskSummary,
			fleet
		};
	} catch (err) {
		// A cached-but-dead handle (SurrealDB killed / socket dropped mid-session) throws
		// here — a non-null handle does NOT prove liveness. Classify the error the same way
		// /workflows + /projects do: a genuine connection loss degrades to honest
		// disconnected (D-019), never a fabricated metric.
		void classifyDbError(err);
		return disconnected();
	}
};
