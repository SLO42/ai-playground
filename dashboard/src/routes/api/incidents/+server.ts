import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	createIncident,
	listIncidents,
	getOpenIncidents,
	updateIncidentStatus,
	type IncidentType,
	type IncidentSeverity,
	type IncidentStatus
} from '$lib/server/incidents.js';

const VALID_TYPES: IncidentType[] = [
	'ci_failure',
	'service_crash',
	'test_regression',
	'build_failure',
	'security_alert'
];
const VALID_SEVERITIES: IncidentSeverity[] = ['critical', 'high', 'medium', 'low'];
const VALID_STATUSES: IncidentStatus[] = ['open', 'investigating', 'resolved'];

export const GET: RequestHandler = async ({ url }) => {
	const projectId = url.searchParams.get('projectId') ?? undefined;
	const statusFilter = url.searchParams.get('status');

	if (statusFilter === 'open') {
		const incidents = projectId
			? (await getOpenIncidents()).filter((i) => i.projectId === projectId)
			: await getOpenIncidents();
		return json({ incidents });
	}

	const incidents = await listIncidents(projectId);
	return json({ incidents });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.title || typeof body.title !== 'string') {
		return json({ error: 'title is required' }, { status: 400 });
	}
	if (!body.projectId || typeof body.projectId !== 'string') {
		return json({ error: 'projectId is required' }, { status: 400 });
	}

	const type = VALID_TYPES.includes(body.type as IncidentType)
		? (body.type as IncidentType)
		: 'ci_failure';
	const severity = VALID_SEVERITIES.includes(body.severity as IncidentSeverity)
		? (body.severity as IncidentSeverity)
		: 'medium';

	const incident = await createIncident({
		projectId: body.projectId as string,
		type,
		title: body.title as string,
		description: (body.description as string) ?? '',
		severity,
		status: 'open',
		relatedTaskId: (body.relatedTaskId as string) ?? undefined,
		context: (body.context as Record<string, unknown>) ?? {}
	});

	return json({ incident }, { status: 201 });
};

export const PATCH: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const id = body.id as string;
	if (!id) {
		return json({ error: 'id is required' }, { status: 400 });
	}

	const status = body.status as IncidentStatus;
	if (!VALID_STATUSES.includes(status)) {
		return json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
	}

	const ok = await updateIncidentStatus(id, status);
	if (!ok) {
		return json({ error: 'Incident not found' }, { status: 404 });
	}

	return json({ ok: true });
};
