/**
 * Incident management — tracks CI failures, service crashes, test regressions,
 * build failures, and security alerts. Persists to .playground/incidents.json.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import crypto from 'crypto';
import { PATHS } from './constants.js';
import { withLock } from './async-mutex.js';
import { pushNotification } from './notifications.js';

// ── Types ──────────────────────────────────────────────────────────────

export type IncidentType =
	| 'ci_failure'
	| 'service_crash'
	| 'test_regression'
	| 'build_failure'
	| 'security_alert';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentStatus = 'open' | 'investigating' | 'resolved';

export interface Incident {
	id: string;
	projectId: string;
	type: IncidentType;
	title: string;
	description: string;
	severity: IncidentSeverity;
	status: IncidentStatus;
	createdAt: string;
	resolvedAt?: string;
	relatedTaskId?: string;
	context: Record<string, unknown>;
}

// ── Storage ────────────────────────────────────────────────────────────

const INCIDENTS_FILE = resolve(PATHS.root, '.playground/incidents.json');
const MAX_STORED = 500;

async function readIncidents(): Promise<Incident[]> {
	try {
		const raw = await readFile(INCIDENTS_FILE, 'utf-8');
		return JSON.parse(raw) as Incident[];
	} catch {
		return [];
	}
}

async function writeIncidents(incidents: Incident[]): Promise<void> {
	await mkdir(dirname(INCIDENTS_FILE), { recursive: true });
	await writeFile(INCIDENTS_FILE, JSON.stringify(incidents, null, '\t'), 'utf-8');
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Create a new incident. Pushes a notification for critical/high severity.
 */
export async function createIncident(
	data: Omit<Incident, 'id' | 'createdAt'>
): Promise<Incident> {
	const incident: Incident = {
		...data,
		id: crypto.randomUUID().slice(0, 12),
		createdAt: new Date().toISOString()
	};

	await withLock(INCIDENTS_FILE, async () => {
		const incidents = await readIncidents();
		incidents.unshift(incident);
		if (incidents.length > MAX_STORED) {
			incidents.length = MAX_STORED;
		}
		await writeIncidents(incidents);
	});

	// Push notification for critical/high severity incidents
	if (incident.severity === 'critical' || incident.severity === 'high') {
		const severityMap = { critical: 'critical', high: 'warning' } as const;
		await pushNotification({
			severity: severityMap[incident.severity],
			category: 'system',
			title: `Incident: ${incident.title}`,
			message: incident.description.slice(0, 200),
			source: `incident:${incident.type}`,
			link: `/incidents`,
			linkLabel: 'View incidents',
			desktop: incident.severity === 'critical'
		}).catch(() => {});
	}

	return incident;
}

/**
 * Resolve an incident by ID.
 */
export async function resolveIncident(id: string): Promise<boolean> {
	return withLock(INCIDENTS_FILE, async () => {
		const incidents = await readIncidents();
		const incident = incidents.find((i) => i.id === id);
		if (!incident || incident.status === 'resolved') return false;
		incident.status = 'resolved';
		incident.resolvedAt = new Date().toISOString();
		await writeIncidents(incidents);
		return true;
	});
}

/**
 * Update an incident's status.
 */
export async function updateIncidentStatus(
	id: string,
	status: IncidentStatus
): Promise<boolean> {
	return withLock(INCIDENTS_FILE, async () => {
		const incidents = await readIncidents();
		const incident = incidents.find((i) => i.id === id);
		if (!incident) return false;
		incident.status = status;
		if (status === 'resolved') {
			incident.resolvedAt = new Date().toISOString();
		}
		await writeIncidents(incidents);
		return true;
	});
}

/**
 * List incidents, optionally filtered by projectId.
 */
export function listIncidents(projectId?: string): Promise<Incident[]> {
	return readIncidents().then((incidents) => {
		if (projectId) {
			return incidents.filter((i) => i.projectId === projectId);
		}
		return incidents;
	});
}

/**
 * Get all open (non-resolved) incidents.
 */
export async function getOpenIncidents(): Promise<Incident[]> {
	const incidents = await readIncidents();
	return incidents.filter((i) => i.status !== 'resolved');
}

/**
 * Get a single incident by ID.
 */
export async function getIncident(id: string): Promise<Incident | null> {
	const incidents = await readIncidents();
	return incidents.find((i) => i.id === id) ?? null;
}
