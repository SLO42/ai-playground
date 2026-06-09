// TASK 10.5 — /services: the managed-services control surface (UI-SPEC §45/§210; F-008; D-019).
//
// Surfaces the local services the platform depends on (Ollama / SurrealDB / engine /
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
}

export const load: PageServerLoad = async ({ depends }) => {
	// Re-invalidated on the SSE service/notification/incident watchers (live, §2.11).
	depends('app:services');

	const db = tryGetDb();
	if (!db) {
		// Honest disconnected shell (D-019): no fabricated services/incidents.
		return {
			connected: false,
			services: [] as ServiceView[],
			incidents: [] as IncidentRow[],
			notifications: [] as NotificationRow[]
		} satisfies ServicesPageData;
	}

	try {
		const [{ services }, incidents, notifications] = await Promise.all([
			readServices(db),
			listIncidents(db, 50),
			listUnreadNotifications(db, 50)
		]);
		return { connected: true, services, incidents, notifications } satisfies ServicesPageData;
	} catch (err) {
		// A dead cached handle / live-query failure → honest disconnected (D-019).
		void classifyDbError(err);
		return {
			connected: false,
			services: [] as ServiceView[],
			incidents: [] as IncidentRow[],
			notifications: [] as NotificationRow[]
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
