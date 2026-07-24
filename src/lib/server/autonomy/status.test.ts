// SD-2 (PRE-WAKE SAFETY) — autonomy boot-status: the pure classifier + the real-SurrealDB
// persist/read round-trip. Because computeAutonomyStatus classifies the SAME config files the boot
// engines read, its four shadow paths (happy · malformed/upstream-error · missing/nil · partial
// workforce degrade) are proven against REAL fixture files; persist/read is proven against a REAL
// migrated SurrealDB (F-020: a stubDb would pass green while the UPSERT/SELECT is broken; F-013:
// booted_at must read back a plain ISO string, never an SDK DateTime).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	computeAutonomyStatus,
	persistAutonomyStatus,
	readAutonomyStatus,
	type AutonomyAssessment
} from './status';

// A minimal-but-VALID workforce.yaml (loadWorkforce requires only pm.model_id, a known model id).
const VALID_WORKFORCE = 'pm:\n  model_id: claude-opus-4-8\n';
// A minimal-but-VALID agent-pool.yaml: one non-claude tier (ollama sidesteps the CA-H3 model-id
// allowlist) + one slot referencing it. Passes loadAgentPool AND the orchestrator's non-empty
// tiers/slots gate — so armed/manual paths reach their real assessment (SD-2 fix regression guard).
const VALID_POOL =
	'tiers:\n  local:\n    provider: ollama\n    model: gpt-oss:20b\nslots:\n  - id: worker-1\n    tier: local\n    role: builder\n';

/** Write orchestration.yaml (+ optionally workforce.yaml + agent-pool.yaml) into a fresh temp dir;
 *  return the dir. Both workforce + agent-pool default to VALID so happy paths reach their state;
 *  pass null to OMIT the file (missing) or a raw string to inject a malformed/empty one. */
function fixtureDir(
	orch: string,
	workforce: string | null = VALID_WORKFORCE,
	agentPool: string | null = VALID_POOL
): string {
	const dir = mkdtempSync(join(tmpdir(), 'atelier-autonomy-'));
	writeFileSync(join(dir, 'orchestration.yaml'), orch);
	if (workforce !== null) writeFileSync(join(dir, 'workforce.yaml'), workforce);
	if (agentPool !== null) writeFileSync(join(dir, 'agent-pool.yaml'), agentPool);
	return dir;
}

const cleanup: string[] = [];
function tmp(
	orch: string,
	workforce: string | null = VALID_WORKFORCE,
	agentPool: string | null = VALID_POOL
): string {
	const dir = fixtureDir(orch, workforce, agentPool);
	cleanup.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

const VALID_ORCH = (mode: string): string =>
	`mode: ${mode}\nconcurrency:\n  maxAgents: 8\n  perProject: 3\n`;

describe('computeAutonomyStatus — pure classifier (four shadow paths)', () => {
	it('HAPPY: mode event → armed, mode echoed, config+workforce ok, no note', () => {
		const a = computeAutonomyStatus(tmp(VALID_ORCH('event')));
		expect(a.state).toBe('armed');
		expect(a.mode).toBe('event');
		expect(a.configOk).toBe(true);
		expect(a.workforceOk).toBe(true);
		expect(a.configFile).toBeNull();
		expect(a.detail).toBeNull();
		expect(a.note).toBeNull();
		expect(a.reason).toMatch(/ARMED/);
	});

	it('HAPPY: mode periodic → armed', () => {
		const a = computeAutonomyStatus(tmp(VALID_ORCH('periodic')));
		expect(a.state).toBe('armed');
		expect(a.mode).toBe('periodic');
	});

	it('HAPPY: mode manual → manual (honest, as configured — NOT a fault)', () => {
		const a = computeAutonomyStatus(tmp(VALID_ORCH('manual')));
		expect(a.state).toBe('manual');
		expect(a.mode).toBe('manual');
		expect(a.configOk).toBe(true);
		expect(a.reason).toMatch(/MANUAL/);
	});

	it('UPSTREAM ERROR: malformed mode value → config-error (autonomy OFF), file + detail surfaced', () => {
		const a = computeAutonomyStatus(tmp('mode: bogus\nconcurrency:\n  maxAgents: 1\n  perProject: 1\n'));
		expect(a.state).toBe('config-error');
		expect(a.mode).toBeNull();
		expect(a.configOk).toBe(false);
		expect(a.configFile).toContain('orchestration.yaml');
		expect(a.detail).toBeTruthy();
		// The exact plain-language headline the operator sees (task contract).
		expect(a.reason).toBe('autonomy OFF: config unreadable (orchestration.yaml)');
	});

	it('UPSTREAM ERROR: missing concurrency (malformed shape) → config-error', () => {
		const a = computeAutonomyStatus(tmp('mode: event\n'));
		expect(a.state).toBe('config-error');
		expect(a.reason).toMatch(/config unreadable/);
	});

	it('NIL: missing orchestration.yaml entirely → config-error (never a fabricated armed)', () => {
		// A dir with NO orchestration.yaml at all — the mode driver cannot be read.
		const dir = mkdtempSync(join(tmpdir(), 'atelier-autonomy-empty-'));
		cleanup.push(dir);
		const a = computeAutonomyStatus(dir);
		expect(a.state).toBe('config-error');
		expect(a.configOk).toBe(false);
		expect(a.reason).toMatch(/config unreadable/);
	});

	// SD-2 FIX (in-scope config-unreadable gap): the orchestrator HARD-refuses to start when
	// agent-pool.yaml is unreadable OR empty (boot.ts startOrchestrator — no tiers/slots ⇒ no route
	// ⇒ every spawn fails). A valid orchestration.yaml alone must therefore NOT report 'armed', or
	// /services paints a false-green banner while nothing drives. These guard that hole.
	it('ROUTING-LADDER ERROR: valid orch + MISSING agent-pool.yaml → config-error (autonomy OFF, NOT armed)', () => {
		const a = computeAutonomyStatus(tmp(VALID_ORCH('event'), VALID_WORKFORCE, null));
		expect(a.state).toBe('config-error');
		expect(a.mode).toBeNull();
		expect(a.configOk).toBe(false);
		expect(a.configFile).toContain('agent-pool.yaml');
		expect(a.detail).toBeTruthy();
		expect(a.reason).toBe('autonomy OFF: config unreadable (agent-pool.yaml)');
	});

	it('ROUTING-LADDER ERROR: valid orch + EMPTY agent-pool (no tiers/slots) → config-error (mirrors boot gate)', () => {
		// Parses cleanly (tiers is a mapping, slots is a list) but is EMPTY — the exact case
		// loadAgentPool accepts yet the orchestrator refuses to start on (slots.length===0 || no tiers).
		const a = computeAutonomyStatus(tmp(VALID_ORCH('event'), VALID_WORKFORCE, 'tiers: {}\nslots: []\n'));
		expect(a.state).toBe('config-error');
		expect(a.mode).toBeNull();
		expect(a.configOk).toBe(false);
		expect(a.configFile).toContain('agent-pool.yaml');
		expect(a.reason).toMatch(/config unreadable/);
		expect(a.detail).toMatch(/tiers|slots/i);
	});

	it('ROUTING-LADDER ERROR: valid orch + MALFORMED agent-pool (slots not a list) → config-error', () => {
		const a = computeAutonomyStatus(
			tmp(VALID_ORCH('periodic'), VALID_WORKFORCE, 'tiers:\n  local:\n    provider: ollama\n    model: gpt-oss:20b\nslots: not-a-list\n')
		);
		expect(a.state).toBe('config-error');
		expect(a.configFile).toContain('agent-pool.yaml');
		expect(a.reason).toMatch(/config unreadable/);
	});

	it('ORDER: orchestration.yaml error is reported BEFORE an agent-pool error (mode driver first)', () => {
		// Both broken: the mode driver (orchestration.yaml) is the primary fault surfaced.
		const a = computeAutonomyStatus(tmp('mode: bogus\nconcurrency:\n  maxAgents: 1\n  perProject: 1\n', VALID_WORKFORCE, null));
		expect(a.state).toBe('config-error');
		expect(a.configFile).toContain('orchestration.yaml');
	});

	it('PARTIAL DEGRADE: valid orch + MALFORMED workforce → armed per mode, workforceOk=false + note', () => {
		// orchestration.yaml valid (armed), but workforce.yaml has an invalid model id → the PM
		// triggers degrade to unarmed. Autonomy is NOT fully off, but the degrade is surfaced honestly.
		const a = computeAutonomyStatus(
			tmp(VALID_ORCH('event'), 'pm:\n  model_id: not-a-real-model\n')
		);
		expect(a.state).toBe('armed');
		expect(a.mode).toBe('event');
		expect(a.configOk).toBe(true);
		expect(a.workforceOk).toBe(false);
		expect(a.note).toMatch(/workforce/i);
		expect(a.note).toMatch(/unarmed/i);
	});

	it('PARTIAL DEGRADE: missing workforce.yaml → armed but workforceOk=false + note', () => {
		const a = computeAutonomyStatus(tmp(VALID_ORCH('manual'), null));
		expect(a.state).toBe('manual');
		expect(a.workforceOk).toBe(false);
		expect(a.note).toBeTruthy();
	});

	it('EMPTY input: blank configDir falls back to the default "config" dir (does not throw)', () => {
		// The real repo config is valid → a defined state, never a throw (the classifier never throws).
		const a = computeAutonomyStatus('');
		expect(['armed', 'manual', 'config-error']).toContain(a.state);
		// The repo config is valid, so this is not a config-error in practice.
		expect(a.configOk).toBe(true);
	});
});

describe('persist + read (REAL SurrealDB)', () => {
	let tdb: TestDb;
	let db: Db;

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
		await db?.close();
		await tdb?.teardown();
	});

	it('read on an empty DB → null (NIL shadow path — honest "unknown", never fabricated)', async () => {
		expect(await readAutonomyStatus(db)).toBeNull();
	});

	it('persist a config-error → read back with file/detail set + booted_at as an ISO STRING (F-013)', async () => {
		const err: AutonomyAssessment = {
			state: 'config-error',
			mode: null,
			configOk: false,
			workforceOk: false,
			configFile: 'config/orchestration.yaml',
			reason: 'autonomy OFF: config unreadable (orchestration.yaml)',
			detail: 'orchestration: "mode" must be one of event | periodic | manual (got bogus)',
			note: null
		};
		await persistAutonomyStatus(db, err);
		const row = await readAutonomyStatus(db);
		expect(row).not.toBeNull();
		expect(row!.state).toBe('config-error');
		expect(row!.mode).toBeNull();
		expect(row!.configOk).toBe(false);
		expect(row!.configFile).toBe('config/orchestration.yaml');
		expect(row!.detail).toContain('mode');
		// F-013: booted_at must be a plain ISO string, not an SDK DateTime.
		expect(typeof row!.bootedAt).toBe('string');
		expect(Number.isNaN(Date.parse(row!.bootedAt as string))).toBe(false);
	});

	it('re-persist an armed status → UPSERT REPLACES the row; stale detail/config_file cleared to NONE', async () => {
		const armed: AutonomyAssessment = {
			state: 'armed',
			mode: 'event',
			configOk: true,
			workforceOk: true,
			configFile: null,
			reason: 'Autonomy is ARMED (event mode) — engines drive automatically per config.',
			detail: null,
			note: null
		};
		await persistAutonomyStatus(db, armed);
		const row = await readAutonomyStatus(db);
		expect(row!.state).toBe('armed');
		expect(row!.mode).toBe('event');
		// The previous boot's config-error detail/file MUST be gone (UPSERT CONTENT replaced the row).
		expect(row!.detail).toBeNull();
		expect(row!.configFile).toBeNull();
		expect(row!.note).toBeNull();

		// Singleton invariant: exactly ONE row exists (re-boot never accumulates).
		const [rows] = await db.query<[unknown[]]>('SELECT * FROM autonomy_status;');
		expect(rows.length).toBe(1);
	});

	it('persist an armed-with-workforce-degraded status → note round-trips', async () => {
		const degraded: AutonomyAssessment = {
			state: 'armed',
			mode: 'periodic',
			configOk: true,
			workforceOk: false,
			configFile: null,
			reason: 'Autonomy is ARMED (periodic mode) — engines drive automatically per config.',
			detail: null,
			note: 'Workforce config unreadable (workforce.yaml) — PM failure-triggers and drift auto-raise are unarmed until it is fixed and the server restarts.'
		};
		await persistAutonomyStatus(db, degraded);
		const row = await readAutonomyStatus(db);
		expect(row!.workforceOk).toBe(false);
		expect(row!.note).toMatch(/workforce/i);
	});
});
