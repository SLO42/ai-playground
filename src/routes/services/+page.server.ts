// TASK 10.5 — /services: the managed-services control surface (UI-SPEC §45/§210; F-008; D-019).
//
// Surfaces the local services the platform depends on (Ollama / SurrealDB /
// dashboard) with LIVE health + status, operator start/stop/restart on the controllable
// ones (Ollama — safe; the dashboard cannot act on its own datastore/self, honestly noted),
// and the durable incidents + notifications history (the operational audit trail, §208).
//
// Live: the page subscribes to the SSE `service`/`notification`/`incident` stream and
// re-invalidates this load (depends('app:services')) so health/status + the incident feed
// update in place as the manager/heartbeat writes rows — no poll. Honest degradation
// (D-019): a disconnected DB yields connected:false + the full managed set as 'unknown',
// never a fabricated "all up". The action records a real audit incident via the manager.

import { fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import {
	readServices,
	operateService,
	ServiceControlError,
	type ServiceView
} from '$lib/server/services';
import { listIncidents, listUnreadNotifications, type IncidentRow, type NotificationRow } from '$lib/server/services';
import {
	resolveDailyTokenBudget,
	resolvePerProjectTokenBudget,
	assessBudgetSafety,
	type BudgetSafety
} from '$lib/server/analytics/spend-budget';
import { listAutonomousPms } from '$lib/server/projects/pm-repo';
import type { Actions, PageServerLoad } from './$types';

export interface ServicesPageData {
	/** True once the runtime DB singleton is connected (else honest disconnected). */
	connected: boolean;
	/** The managed services (live health + honest controllability). */
	services: ServiceView[];
	/** Durable incident history, newest first (operational audit trail). */
	incidents: IncidentRow[];
	/** Unread notifications, newest first. */
	notifications: NotificationRow[];
	/**
	 * SD-1 — the budget-safety verdict driving the loud armed-and-uncapped banner. The two caps
	 * come from config (resolve*, config-only — meaningful even when the DB is down); armedLoops
	 * is the LIVE pm.autonomous=true count (0 when the DB is unreachable — we cannot claim a loop
	 * is armed without reading it, so the banner stays honestly silent, F-008).
	 */
	budgetSafety: BudgetSafety;
}

export const load: PageServerLoad = async ({ depends }) => {
	// Re-invalidated on the SSE service/notification/incident watchers (live, §2.11).
	depends('app:services');

	// SD-1: the armed caps are config-only (resolve*), so they are known even when the DB is down —
	// but a token-budget read/parse fault must never wedge the page (a soft governance control, not a
	// security boundary — D-024/F-053; resolve* already fail-open to 0 with a once-per-boot warning).
	const dailyTokenBudget = resolveDailyTokenBudget();
	const perProjectTokenBudget = resolvePerProjectTokenBudget();

	const db = tryGetDb();
	if (!db) {
		// Honest disconnected shell (D-019): no fabricated services/incidents. armedLoops:0 because we
		// cannot read the pm rows — the banner stays honestly silent rather than claim a loop is armed.
		return {
			connected: false,
			services: [] as ServiceView[],
			incidents: [] as IncidentRow[],
			notifications: [] as NotificationRow[],
			budgetSafety: assessBudgetSafety({ dailyTokenBudget, perProjectTokenBudget, armedLoops: 0 })
		} satisfies ServicesPageData;
	}

	try {
		// The armed-loop count is a SEPARATE, best-effort read (F-014): a fault reading the pm rows must
		// not fail the whole services page. On a fault we report 0 armed loops (honest — no armed loop
		// observed) rather than fabricate an alarm; the caps still surface from config above.
		const [{ services }, incidents, notifications, armedLoops] = await Promise.all([
			readServices(db),
			listIncidents(db, 50),
			listUnreadNotifications(db, 50),
			listAutonomousPms(db)
				.then((pms) => pms.length)
				.catch((err) => {
					console.warn(`[services] armed-loop count read failed (best-effort): ${(err as Error).message}`);
					return 0;
				})
		]);
		return {
			connected: true,
			services,
			incidents,
			notifications,
			budgetSafety: assessBudgetSafety({ dailyTokenBudget, perProjectTokenBudget, armedLoops })
		} satisfies ServicesPageData;
	} catch (err) {
		// A dead cached handle / live-query failure → honest disconnected (D-019).
		void classifyDbError(err);
		return {
			connected: false,
			services: [] as ServiceView[],
			incidents: [] as IncidentRow[],
			notifications: [] as NotificationRow[],
			budgetSafety: assessBudgetSafety({ dailyTokenBudget, perProjectTokenBudget, armedLoops: 0 })
		} satisfies ServicesPageData;
	}
};

export const actions: Actions = {
	/**
	 * OPERATOR lifecycle action (start | stop | restart) on a controllable service. The
	 * service name + action are validated at the boundary (operateService refuses an
	 * unknown/non-controllable service — no dead/dangerous control). On success/failure the
	 * manager records a real audit incident + notification (which the live feed then shows).
	 */
	operate: async ({ request }) => {
		const form = await request.formData();
		const name = typeof form.get('name') === 'string' ? String(form.get('name')) : '';
		const action = typeof form.get('action') === 'string' ? String(form.get('action')) : '';

		const db = tryGetDb();
		if (!db) {
			return fail(503, { op: { error: 'datastore is not connected — cannot act on services right now' } });
		}
		try {
			const res = await operateService(db, name, action);
			return {
				op: {
					name: res.name,
					action: res.action,
					ok: res.ok,
					error: res.error,
					incidentTitle: res.incident.title
				}
			};
		} catch (err) {
			if (err instanceof ServiceControlError) return fail(400, { op: { error: err.message } });
			return fail(500, { op: { error: (err as Error).message } });
		}
	}
};
