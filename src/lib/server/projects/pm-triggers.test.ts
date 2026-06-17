import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { assertRecordId } from '../db/validate';
import { EventBus } from '../events/bus';
import { createProject } from './repo';
import { createTask, setStatus } from '../tasks/repo';
import { writeFindings } from '../scanner/findings-repo';
import { createPm, listPmMemory, listPmReviews, updatePmSchedule } from './pm-repo';
import type { WorkforceConfig } from '../config/load';
import {
	addPanelVerdict,
	closePanelVerdictOutcome,
	createRole,
	createRoleVersion,
	listReviewProposalsForRole,
	swapActiveVersion,
	transitionLifecycle
} from '../workforce/repo';
import {
	PmTriggerEngine,
	pmTriggerAllowed,
	reviewAllowedByAuthority,
	parseCron,
	cronMatches,
	parseDurationMs,
	periodicDue
} from './pm-triggers';

// TASK 16.2 VERIFY (D-038) — the PM trigger engine against a REAL throwaway SurrealDB:
// real pm/task/session/finding/workflow rows, SIMULATED bus events (the exact db_change
// shape watchTable publishes), real pm_review + pm_memory writes. Every fire's provenance
// is asserted against the real evidence rows (F-008); the D-004 mode-gating matrix, the
// hired-PM gate, the authority gate, the unarmed-threshold gate and the cadence_offset
// stagger are all exercised.

let tdb: TestDb;
let db: Db;
let projectId: string;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let engines: PmTriggerEngine[] = [];

beforeEach(async () => {
	await db
		.query(
			'DELETE pm; DELETE pm_review; DELETE pm_memory; DELETE security_finding; DELETE task; DELETE session; DELETE workflow_run; DELETE workflow; DELETE project; DELETE review_proposal; DELETE panel_verdict; DELETE role_version; DELETE role;'
		)
		.catch(() => {});
	const p = await createProject(db, {
		slug: 'pmtrigtest',
		name: 'PM Trigger Host',
		root_path: 'F:/code/pmtrigtest'
	});
	projectId = p.id;
});

afterEach(() => {
	for (const e of engines) e.stop();
	engines = [];
});

function makeEngine(
	opts: Partial<ConstructorParameters<typeof PmTriggerEngine>[0]> & { bus?: EventBus } = {}
): { engine: PmTriggerEngine; bus: EventBus } {
	const bus = opts.bus ?? new EventBus();
	const engine = new PmTriggerEngine({
		db,
		bus,
		mode: 'event',
		failureThreshold: null,
		coalesceMs: 5,
		...opts
	});
	engine.start();
	engines.push(engine);
	return { engine, bus };
}

/** Publish the exact db_change shape watchTable/db-source puts on the bus. */
function publishChange(
	bus: EventBus,
	table: string,
	action: 'CREATE' | 'UPDATE' | 'DELETE',
	record: string,
	result: Record<string, unknown> | null
): void {
	bus.publish({ type: 'db_change', topic: table, key: record, data: { action, record, result } });
}

async function createFailedSession(): Promise<string> {
	const project = new StringRecordId(assertRecordId(projectId));
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session SET project = $project, kind = 'task',
			model = { provider: 'claude', model_id: 'claude-test' },
			status = 'failed', ended_at = time::now() RETURN AFTER;`,
		{ project }
	);
	return String(rows[0].id);
}

async function createBlockedTask(title: string): Promise<string> {
	const t = await createTask(db, { project: projectId, title, description: '', status: 'ready' });
	await setStatus(db, t.id, 'in_progress');
	await setStatus(db, t.id, 'blocked');
	return t.id;
}

async function createReleaseRun(name: string, status: 'done' | 'failed'): Promise<{ runId: string; workflowId: string }> {
	const project = new StringRecordId(assertRecordId(projectId));
	const [wf] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE workflow SET name = $name, project = $project, steps = [{ id: 'noop' }] RETURN AFTER;`,
		{ name, project }
	);
	const workflowId = String(wf[0].id);
	const wid = new StringRecordId(assertRecordId(workflowId));
	const [run] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE workflow_run SET workflow = $wid, status = $status RETURN AFTER;`,
		{ wid, status }
	);
	return { runId: String(run[0].id), workflowId };
}

// ── Pure gates: the D-004 mode matrix + the authority ladder ───────────────────────

describe('pmTriggerAllowed — D-004 mode-gating matrix (manual/event/periodic × trigger kinds)', () => {
	it('manual triggers are ALWAYS allowed (the operator button)', () => {
		expect(pmTriggerAllowed('manual', 'manual')).toBe(true);
		expect(pmTriggerAllowed('manual', 'event')).toBe(true);
		expect(pmTriggerAllowed('manual', 'periodic')).toBe(true);
	});

	it('manual MODE permits NO automatic fires (periodic or event)', () => {
		expect(pmTriggerAllowed('periodic', 'manual')).toBe(false);
		expect(pmTriggerAllowed('event', 'manual')).toBe(false);
	});

	it('event + periodic modes permit automatic fires', () => {
		expect(pmTriggerAllowed('periodic', 'event')).toBe(true);
		expect(pmTriggerAllowed('event', 'event')).toBe(true);
		expect(pmTriggerAllowed('periodic', 'periodic')).toBe(true);
		expect(pmTriggerAllowed('event', 'periodic')).toBe(true);
	});
});

describe('reviewAllowedByAuthority — observe floor, fail-closed on unknown', () => {
	it('every valid authority permits a review pass (a review only observes)', () => {
		expect(reviewAllowedByAuthority('observe')).toBe(true);
		expect(reviewAllowedByAuthority('propose')).toBe(true);
		expect(reviewAllowedByAuthority('act')).toBe(true);
	});

	it('fails CLOSED on an unclassifiable authority (shadow: malformed row)', () => {
		expect(reviewAllowedByAuthority('admin')).toBe(false);
		expect(reviewAllowedByAuthority('')).toBe(false);
		expect(reviewAllowedByAuthority(undefined)).toBe(false);
		expect(reviewAllowedByAuthority(7)).toBe(false);
	});
});

// ── Cron + duration + stagger (pure units) ─────────────────────────────────────────

describe('parseCron / cronMatches', () => {
	it('matches a wildcard every minute', () => {
		const spec = parseCron('* * * * *')!;
		expect(spec).not.toBeNull();
		expect(cronMatches(spec, new Date('2026-06-11T10:05:00'))).toBe(true);
	});

	it('matches steps, ranges and lists', () => {
		const q = parseCron('*/15 * * * *')!;
		expect(cronMatches(q, new Date('2026-06-11T10:30:00'))).toBe(true);
		expect(cronMatches(q, new Date('2026-06-11T10:31:00'))).toBe(false);

		// 2026-06-11 is a Thursday (dow 4); 2026-06-13 is a Saturday (dow 6).
		const wk = parseCron('0 9 * * 1-5')!;
		expect(cronMatches(wk, new Date('2026-06-11T09:00:00'))).toBe(true);
		expect(cronMatches(wk, new Date('2026-06-13T09:00:00'))).toBe(false);
		expect(cronMatches(wk, new Date('2026-06-11T09:01:00'))).toBe(false);

		const list = parseCron('5,35 8,18 * * *')!;
		expect(cronMatches(list, new Date('2026-06-11T18:35:00'))).toBe(true);
		expect(cronMatches(list, new Date('2026-06-11T12:35:00'))).toBe(false);
	});

	it('dow 7 normalizes to Sunday (0)', () => {
		const sun = parseCron('0 0 * * 7')!;
		// 2026-06-14 is a Sunday.
		expect(cronMatches(sun, new Date('2026-06-14T00:00:00'))).toBe(true);
	});

	it('shadow: rejects malformed expressions honestly (null, never a guess)', () => {
		expect(parseCron('')).toBeNull();
		expect(parseCron('* * * *')).toBeNull(); // 4 fields
		expect(parseCron('61 * * * *')).toBeNull(); // out of range
		expect(parseCron('a b c d e')).toBeNull();
		expect(parseCron('1-0 * * * *')).toBeNull(); // inverted range
	});
});

describe('parseDurationMs + periodicDue (cadence_offset staggering)', () => {
	it('parses SurrealDB duration strings', () => {
		expect(parseDurationMs('5m')).toBe(300_000);
		expect(parseDurationMs('1h30m')).toBe(5_400_000);
		expect(parseDurationMs('90s')).toBe(90_000);
		expect(parseDurationMs('250ms')).toBe(250);
		expect(parseDurationMs('1d')).toBe(86_400_000);
	});

	it('shadow: rejects non-durations (null — the engine treats it as no stagger)', () => {
		expect(parseDurationMs('')).toBeNull();
		expect(parseDurationMs('soon')).toBeNull();
		expect(parseDurationMs('5 m')).toBeNull();
	});

	it('STAGGERS two PMs sharing one cron via different offsets (PM-SPEC §3)', () => {
		// Hourly cron. Offset 0 fires at :00; offset 5m fires at :05 — never together.
		const atHour = new Date('2026-06-11T10:00:00');
		const atFive = new Date('2026-06-11T10:05:00');
		const a = { cadence: '0 * * * *' };
		const b = { cadence: '0 * * * *', cadence_offset: '5m' };

		expect(periodicDue(a, atHour).due).toBe(true);
		expect(periodicDue(b, atHour).due).toBe(false);
		expect(periodicDue(a, atFive).due).toBe(false);
		expect(periodicDue(b, atFive).due).toBe(true);
		// The dedup key is the OFFSET-SHIFTED minute: b firing at :05 dedups on the same
		// cron-match minute a fired on at :00 (per-PM keys — one fire per cron match each).
		expect(periodicDue(b, atFive).minuteKey).toBe(periodicDue(a, atHour).minuteKey);
	});

	it('shadow: an unparseable cadence is never due (fail-closed)', () => {
		expect(periodicDue({ cadence: 'whenever' }, new Date()).due).toBe(false);
		expect(periodicDue({}, new Date()).due).toBe(false);
	});
});

// ── Periodic trigger (engine, real DB) ─────────────────────────────────────────────

describe('PmTriggerEngine — periodic cadence (PM-SPEC §3a)', () => {
	it('fires a periodic review for a hired PM whose cadence matches, exactly once per minute', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		await updatePmSchedule(db, projectId, { cadence: '* * * * *', cadenceOffset: null });

		const { engine } = makeEngine();
		const at = new Date('2026-06-11T10:05:30');
		expect(await engine.tickOnce(at)).toBe(1);
		// Same minute again (the 15s tick re-checks) → minute-deduped, no second fire.
		expect(await engine.tickOnce(new Date('2026-06-11T10:05:45'))).toBe(0);
		// The NEXT minute fires again.
		expect(await engine.tickOnce(new Date('2026-06-11T10:06:10'))).toBe(1);

		const reviews = await listPmReviews(db, projectId);
		expect(reviews).toHaveLength(2);
		expect(reviews[0].trigger).toBe('periodic');
		expect(reviews[0].provenance?.kind).toBe('periodic');
		expect(reviews[0].provenance?.evidence?.length).toBe(1);
		expect(reviews[0].provenance?.authority).toBe('act');
		expect(reviews[0].provenance?.detail?.cadence).toBe('* * * * *');
	});

	it('persists the schedule write path round-trip (cadence + duration offset)', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const set = await updatePmSchedule(db, projectId, { cadence: '0 9 * * 1-5', cadenceOffset: '5m' });
		expect(set?.cadence).toBe('0 9 * * 1-5');
		expect(set?.cadence_offset).toBe('5m'); // duration coerced to its string form (F-013 class)

		const cleared = await updatePmSchedule(db, projectId, { cadence: null, cadenceOffset: null });
		expect(cleared?.cadence).toBeUndefined();
		expect(cleared?.cadence_offset).toBeUndefined();
	});

	it('NEVER fires for a project without a hired PM (no pm row, no wake)', async () => {
		// No createPm at all — and no cadence anywhere — the tick scans pm rows only.
		const { engine } = makeEngine();
		expect(await engine.tickOnce(new Date())).toBe(0);
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});

	it('a PM without a cadence never fires periodically (no default schedule)', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { engine } = makeEngine();
		expect(await engine.tickOnce(new Date())).toBe(0);
	});

	it('D-004: manual mode arms nothing and tickOnce fires nothing', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		await updatePmSchedule(db, projectId, { cadence: '* * * * *', cadenceOffset: null });
		const { engine } = makeEngine({ mode: 'manual' });
		expect(engine.periodicArmed).toBe(false);
		expect(await engine.tickOnce(new Date())).toBe(0);
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});
});

// ── Event ① — session failed / task blocked > threshold ────────────────────────────

describe('PmTriggerEngine — distress events (threshold-gated, unarmed by default)', () => {
	it('UNARMED (threshold null): a failed session never auto-fires (F-008)', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const sessionId = await createFailedSession();
		const { engine, bus } = makeEngine({ failureThreshold: null });
		publishChange(bus, 'session', 'UPDATE', sessionId, { status: 'failed', project: projectId });
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});

	it('ARMED: fires when failed sessions exceed the threshold, with real evidence', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		await createFailedSession();
		const second = await createFailedSession();
		const { engine, bus } = makeEngine({ failureThreshold: 1 });
		publishChange(bus, 'session', 'UPDATE', second, { status: 'failed', project: projectId });
		await engine.idle();

		const reviews = await listPmReviews(db, projectId);
		expect(reviews).toHaveLength(1);
		expect(reviews[0].trigger).toBe('event');
		expect(reviews[0].provenance?.kind).toBe('session_failed');
		expect(reviews[0].provenance?.evidence).toContain(second);
		expect(reviews[0].provenance?.detail?.failed_sessions).toBe(2);
		expect(reviews[0].provenance?.detail?.threshold).toBe(1);
	});

	it('ARMED but distress ≤ threshold: no fire', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const only = await createFailedSession();
		const { engine, bus } = makeEngine({ failureThreshold: 5 });
		publishChange(bus, 'session', 'UPDATE', only, { status: 'failed', project: projectId });
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});

	it('fires on blocked tasks (the other distress signal) with kind task_blocked', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const taskId = await createBlockedTask('Stuck work');
		const { engine, bus } = makeEngine({ failureThreshold: 0 });
		publishChange(bus, 'task', 'UPDATE', taskId, { status: 'blocked', project: projectId });
		await engine.idle();

		const reviews = await listPmReviews(db, projectId);
		expect(reviews).toHaveLength(1);
		expect(reviews[0].provenance?.kind).toBe('task_blocked');
		expect(reviews[0].provenance?.evidence).toContain(taskId);
		expect(reviews[0].provenance?.detail?.blocked_tasks).toBe(1);
	});

	it('the last review RESETS the distress baseline (self-limiting, no re-fire storm)', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const sessionId = await createFailedSession();
		const { engine, bus } = makeEngine({ failureThreshold: 0 });
		publishChange(bus, 'session', 'UPDATE', sessionId, { status: 'failed', project: projectId });
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(1);

		// The SAME stale failure signal re-arrives (e.g. a row touch) — counts since the
		// last review are zero now, so 0 > 0 is false → no second wake.
		publishChange(bus, 'session', 'UPDATE', sessionId, { status: 'failed', project: projectId });
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(1);
	});

	it('shadow: no hired PM → an armed distress event still never fires', async () => {
		const sessionId = await createFailedSession();
		const { engine, bus } = makeEngine({ failureThreshold: 0 });
		publishChange(bus, 'session', 'UPDATE', sessionId, { status: 'failed', project: projectId });
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});

	it('shadow: project-less / malformed / DELETE events are ignored', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { engine, bus } = makeEngine({ failureThreshold: 0 });
		publishChange(bus, 'session', 'UPDATE', 'session:x', { status: 'failed' }); // no project
		publishChange(bus, 'session', 'UPDATE', 'session:y', null); // nil row
		publishChange(bus, 'session', 'DELETE', 'session:z', { status: 'failed', project: projectId });
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});
});

// ── Event ③ — a new security/UX finding lands ──────────────────────────────────────

describe('PmTriggerEngine — finding events (coalesced)', () => {
	it('a burst of new findings coalesces into ONE review carrying every finding id', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const written = await writeFindings(db, projectId, [
			{ rule: 'hardcoded-secret', severity: 'critical', file: 'src/a.ts', line: 1, detail: 'x' },
			{ rule: 'ux.missing-title', severity: 'low', file: 'src/routes/+page.svelte', line: 1, detail: 'y' }
		]);
		const { engine, bus } = makeEngine();
		for (const f of written) {
			publishChange(bus, 'security_finding', 'CREATE', f.id, {
				project: projectId,
				status: 'active',
				rule: f.rule
			});
		}
		await engine.idle();

		const reviews = await listPmReviews(db, projectId);
		expect(reviews).toHaveLength(1);
		expect(reviews[0].trigger).toBe('event');
		expect(reviews[0].provenance?.kind).toBe('finding');
		expect(reviews[0].provenance?.evidence).toEqual(expect.arrayContaining(written.map((f) => f.id)));
		expect(reviews[0].provenance?.detail?.findings).toBe(2);
		// The review pass itself examined the REAL findings (F-008).
		expect(reviews[0].findings_examined).toBe(2);
	});

	it('shadow: UPDATE/archived finding changes are not arrivals (no fire)', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { engine, bus } = makeEngine();
		publishChange(bus, 'security_finding', 'UPDATE', 'security_finding:a', {
			project: projectId,
			status: 'active'
		});
		publishChange(bus, 'security_finding', 'CREATE', 'security_finding:b', {
			project: projectId,
			status: 'archived'
		});
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});
});

// ── Event ④ — release completes/fails ──────────────────────────────────────────────

describe('PmTriggerEngine — release events (retro memory + follow-up)', () => {
	it('a FAILED release run fires a review with retro LEARNING + follow-up RISK', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { runId, workflowId } = await createReleaseRun('release 1.2.3', 'failed');
		const { engine, bus } = makeEngine();
		publishChange(bus, 'workflow_run', 'UPDATE', runId, { status: 'failed', workflow: workflowId });
		await engine.idle();

		const reviews = await listPmReviews(db, projectId);
		expect(reviews).toHaveLength(1);
		expect(reviews[0].provenance?.kind).toBe('release');
		expect(reviews[0].provenance?.evidence).toContain(runId);
		expect(reviews[0].provenance?.detail?.status).toBe('failed');

		const memory = await listPmMemory(db, projectId);
		const learning = memory.find((m) => m.kind === 'learning' && /release retro/i.test(m.content));
		expect(learning).toBeTruthy();
		expect(learning?.related_to).toBe(runId);
		const risk = memory.find((m) => m.kind === 'risk' && /release run .* FAILED/i.test(m.content));
		expect(risk).toBeTruthy();
	});

	it('a COMPLETED release fires the retro learning but no failure risk', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { runId, workflowId } = await createReleaseRun('release 2.0.0', 'done');
		const { engine, bus } = makeEngine();
		publishChange(bus, 'workflow_run', 'UPDATE', runId, { status: 'done', workflow: workflowId });
		await engine.idle();

		const reviews = await listPmReviews(db, projectId);
		expect(reviews).toHaveLength(1);
		expect(reviews[0].provenance?.detail?.status).toBe('done');
		const memory = await listPmMemory(db, projectId);
		expect(memory.some((m) => m.kind === 'learning' && /release retro/i.test(m.content))).toBe(true);
		expect(memory.some((m) => m.kind === 'risk' && /release run/i.test(m.content))).toBe(false);
	});

	it('shadow: a NON-release workflow run ending is not event ④ (no fire)', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { runId, workflowId } = await createReleaseRun('maintain sweep', 'done');
		const { engine, bus } = makeEngine();
		publishChange(bus, 'workflow_run', 'UPDATE', runId, { status: 'done', workflow: workflowId });
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});

	it('shadow: a still-running workflow_run change is ignored', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { runId, workflowId } = await createReleaseRun('release 3.0.0', 'done');
		const { engine, bus } = makeEngine();
		publishChange(bus, 'workflow_run', 'UPDATE', runId, { status: 'running', workflow: workflowId });
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});
});

// ── Event ② — GitHub issue/PR arrival (via the SyncAdapter seam) ───────────────────

describe('PmTriggerEngine — githubArrival (persistent dedup)', () => {
	it('fires once for fresh arrivals and records issue/PR refs as evidence', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { engine } = makeEngine();
		const fired = await engine.githubArrival(projectId, [
			{ kind: 'issue', externalId: '12', title: 'Bug: crash on save' },
			{ kind: 'pr', externalId: '13', title: 'Fix crash' }
		]);
		expect(fired).toBe(true);

		const reviews = await listPmReviews(db, projectId);
		expect(reviews).toHaveLength(1);
		expect(reviews[0].provenance?.kind).toBe('github_arrival');
		expect(reviews[0].provenance?.evidence).toEqual(['issue#12', 'pr#13']);
		expect(reviews[0].provenance?.detail?.issues).toBe(1);
		expect(reviews[0].provenance?.detail?.prs).toBe(1);
		// TASK 16.5: the fresh arrivals' REAL metadata rides in detail.arrivals so the
		// review pass can triage (summary + dup-check) without re-reaching GitHub.
		expect(reviews[0].provenance?.detail?.arrivals).toEqual([
			{ kind: 'issue', externalId: '12', title: 'Bug: crash on save' },
			{ kind: 'pr', externalId: '13', title: 'Fix crash' }
		]);
	});

	it('dedups the SAME arrivals within a boot (no second wake)', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const { engine } = makeEngine();
		expect(await engine.githubArrival(projectId, [{ kind: 'issue', externalId: '12' }])).toBe(true);
		expect(await engine.githubArrival(projectId, [{ kind: 'issue', externalId: '12' }])).toBe(false);
		expect(await listPmReviews(db, projectId)).toHaveLength(1);
	});

	it('dedups PERSISTENTLY across engine restarts via pm_review provenance', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const first = makeEngine();
		expect(await first.engine.githubArrival(projectId, [{ kind: 'issue', externalId: '12' }])).toBe(true);
		first.engine.stop();

		// A FRESH engine (new boot, empty in-memory set) sees the same arrival again —
		// the seen-set seeds from the prior review's provenance, so no re-fire.
		const second = makeEngine();
		expect(await second.engine.githubArrival(projectId, [{ kind: 'issue', externalId: '12' }])).toBe(false);
		// A genuinely NEW arrival still fires.
		expect(await second.engine.githubArrival(projectId, [{ kind: 'issue', externalId: '14' }])).toBe(true);
		expect(await listPmReviews(db, projectId)).toHaveLength(2);
	});

	it('shadow: empty arrivals / no hired PM / manual mode → no fire', async () => {
		const noPm = makeEngine();
		expect(await noPm.engine.githubArrival(projectId, [{ kind: 'issue', externalId: '1' }])).toBe(false);

		await createPm(db, { project: projectId, name: 'Vesper' });
		const { engine } = makeEngine();
		expect(await engine.githubArrival(projectId, [])).toBe(false);

		const manual = makeEngine({ mode: 'manual' });
		expect(await manual.engine.githubArrival(projectId, [{ kind: 'issue', externalId: '2' }])).toBe(false);
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});
});

// ── D-004 manual mode: the engine is fully inert on the bus ────────────────────────

describe('PmTriggerEngine — manual mode is inert (D-004)', () => {
	it('subscribes to nothing: bus events produce no reviews even with everything armed', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		const taskId = await createBlockedTask('Stuck');
		const written = await writeFindings(db, projectId, [
			{ rule: 'hardcoded-secret', severity: 'critical', file: 'src/a.ts', line: 1, detail: 'x' }
		]);
		const { engine, bus } = makeEngine({ mode: 'manual', failureThreshold: 0 });
		expect(bus.size).toBe(0); // no subscription at all
		publishChange(bus, 'task', 'UPDATE', taskId, { status: 'blocked', project: projectId });
		publishChange(bus, 'security_finding', 'CREATE', written[0].id, {
			project: projectId,
			status: 'active'
		});
		await engine.idle();
		expect(await listPmReviews(db, projectId)).toHaveLength(0);
	});
});

// ── WORKFORCE-SPEC §5 drift auto-raise wiring (engine-level) ──────────────────────────
// REGRESSION (red-team gap #2): the #driftPass / get driftArmed / tickOnce integration had
// no engine-level test. These assert the periodic-tick fire, the manual-mode skip
// (driftArmed excludes manual — D-004), and the error-swallow (a drift hiccup never breaks
// the cadence). The §5 unit behaviour itself is covered by workforce/drift.test.ts.

/** A WorkforceConfig with miscalibration armed @ 0.5, window 14d, floor 5 (shipped defaults). */
function driftCfg(): WorkforceConfig {
	return {
		pm: { provider: 'claude', model_id: 'm', triggers: { failure_threshold: null } },
		panel: { scope: { max_files: null, max_new_services: null } },
		gauntlet: { pass_recall: 1.0, max_false_positives: 0, session_timeout_minutes: 15 },
		budget: { max_auto_interviews_per_day: null, allowed_auto_tiers: [] },
		drift: {
			escaped_defect: true,
			operator_feedback: true,
			confidence_miscalibration: true,
			confidence_miscalibration_rate: 0.5,
			refutation_rate: null,
			fixloop_rate: null
		},
		research: { max_wall_clock_minutes: null, max_fetches: null },
		workforce: { max_open_proposals: 2, track_window_days: 14, min_events_for_claim: 5 }
	};
}

let driftSeq = 0;
/** Seed a role with an ACTIVE incumbent that has 6 high-confidence-WRONG closed verdicts
 *  (miscalibration rate 1.0 ≥ 0.5 over ≥ floor) → the §5 pass will auto-raise for it. */
async function seedDriftingIncumbent(): Promise<{ roleId: string; versionId: string }> {
	const slug = `pmtrig-drift-${++driftSeq}`;
	const role = await createRole(db, { slug, name: `Role ${slug}`, purpose: 'drift wiring test' });
	const version = await createRoleVersion(db, { role: role.id, prompt_core: 'Review.', default_tier: 'sonnet' });
	for (let i = 0; i < 6; i++) {
		const validator = await createFailedSession();
		const artifact = await createFailedSession();
		const v = await addPanelVerdict(db, {
			artifact,
			artifact_kind: 'task',
			validator_session: validator,
			validator_kind: 'catalog_role',
			role: role.id,
			role_version: version.id,
			verdict: 'pushback',
			confidence: 'high'
		});
		await closePanelVerdictOutcome(db, v.id, 'overridden_by_operator');
	}
	await transitionLifecycle(db, version.id, 'interviewing');
	await transitionLifecycle(db, version.id, 'passed');
	await swapActiveVersion(db, role.id, version.id);
	return { roleId: role.id, versionId: version.id };
}

describe('PmTriggerEngine — §5 drift auto-raise wiring', () => {
	it('a periodic tick runs the bounded drift pass and auto-raises a proposal', async () => {
		const { roleId } = await seedDriftingIncumbent();
		const { engine } = makeEngine({ mode: 'periodic', driftConfig: driftCfg() });
		expect(engine.driftArmed).toBe(true);
		await engine.tickOnce(new Date());
		await engine.idle();
		const props = await listReviewProposalsForRole(db, roleId);
		expect(props.filter((p) => p.status === 'proposed' && p.kind === 'prompt_revision')).toHaveLength(1);
		expect(engine.driftRaiseCount).toBeGreaterThanOrEqual(1);
	});

	it('is idempotent across two ticks (no proposal storm under persistent drift)', async () => {
		const { roleId } = await seedDriftingIncumbent();
		const { engine } = makeEngine({ mode: 'periodic', driftConfig: driftCfg() });
		await engine.tickOnce(new Date());
		await engine.idle();
		await engine.tickOnce(new Date());
		await engine.idle();
		const props = await listReviewProposalsForRole(db, roleId);
		expect(props.filter((p) => p.kind === 'prompt_revision')).toHaveLength(1);
	});

	it('D-004: manual mode is NOT driftArmed and a tick raises nothing', async () => {
		const { roleId } = await seedDriftingIncumbent();
		const { engine } = makeEngine({ mode: 'manual', driftConfig: driftCfg() });
		expect(engine.driftArmed).toBe(false);
		expect(await engine.tickOnce(new Date())).toBe(0);
		await engine.idle();
		expect(await listReviewProposalsForRole(db, roleId)).toHaveLength(0);
	});

	it('no driftConfig → not driftArmed (drift pass never runs)', async () => {
		const { roleId } = await seedDriftingIncumbent();
		const { engine } = makeEngine({ mode: 'periodic' });
		expect(engine.driftArmed).toBe(false);
		await engine.tickOnce(new Date());
		await engine.idle();
		expect(await listReviewProposalsForRole(db, roleId)).toHaveLength(0);
	});

	it('a drift-pass failure is swallowed and never breaks the periodic cadence', async () => {
		await createPm(db, { project: projectId, name: 'Vesper' });
		await updatePmSchedule(db, projectId, { cadence: '* * * * *', cadenceOffset: null });
		// A drifting incumbent exists so the per-version auto-raise actually runs and hits the
		// broken config (reading cfg.workforce.* on null throws inside autoRaiseForVersion).
		await seedDriftingIncumbent();
		const broken = { ...driftCfg(), workforce: null } as unknown as WorkforceConfig;
		const { engine } = makeEngine({ mode: 'periodic', driftConfig: broken });
		expect(engine.driftArmed).toBe(true);
		const fired = await engine.tickOnce(new Date());
		await engine.idle();
		expect(fired).toBe(1); // the PM cadence review still fired despite the drift error
		// And no proposal leaked from the failed pass.
		expect(engine.driftRaiseCount).toBe(0);
	});
});
