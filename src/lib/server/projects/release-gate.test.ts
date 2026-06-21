import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from './repo';
import { declareTarget } from '../adapters/registry';
import { getAdapterRegistry, resetAdapterRegistry } from '../adapters/index';
import type {
	PublisherAdapter,
	PublishValidation,
	PackageResult,
	AdapterProbe,
	AdapterRunResult,
	SecretRequirement
} from '../adapters/types';
import type { CommandResult } from '../orchestrator/post-task';
import type { RunTargetActionResult } from '../adapters/driver';
import { runReleaseReadinessGate } from './release-gate';

// RELEASE-GATE VERIFY — the OBJECTIVE release-readiness gate against a REAL throwaway SurrealDB. Build +
// publish are INJECTED seams (NO real build, NO real publish). Pack/validate run against a STUB publisher
// adapter registered into the live registry so we deterministically drive each green/red path. Every row
// asserted (the project, the declared target) is a real DB row (F-008).
//
// Covers the BUILD prompt's required integrity cases:
//   • consent + all-green → publish proceeds (stubbed) → published:true;
//   • consent + build-red (non-zero exit) → NO publish, halt + honest failure;
//   • consent + validate-red → NO publish (build green, validate skipped CANNOT slip through);
//   • consent + pack-red → NO publish;
//   • NO consent → halt at gate (never reaches build/pack/publish);
//   • no target → halt honestly; no token → halt honestly;
//   • the publish seam is handed a VALID confirm token for THIS target (drives the EXISTING D-037 path).

let tdb: TestDb;
let db: Db;
let projectId: string;
let seq = 0;

const STUB_SECRET = 'STUB_PUBLISH_TOKEN';

/** A controllable stub publisher: pack/validate outcomes are set per-test; it requires STUB_SECRET. */
class StubPublisher implements PublisherAdapter {
	readonly id = 'stub-publish';
	readonly label = 'Stub Publisher';
	readonly kind = 'publish' as const;
	packOk = true;
	validateOk = true;
	validateBlockers: string[] = [];
	packThrows = false;
	secrets(): SecretRequirement[] {
		return [{ envVar: STUB_SECRET, label: 'Stub token', purpose: 'auth', required: true }];
	}
	async probe(): Promise<AdapterProbe> {
		return { available: true, target: 'stub:thing' };
	}
	async validate(): Promise<PublishValidation> {
		return this.validateOk
			? { ok: true, blockers: [], warnings: [] }
			: { ok: false, blockers: this.validateBlockers.length ? this.validateBlockers : ['manifest invalid'], warnings: [] };
	}
	async package(): Promise<PackageResult> {
		if (this.packThrows) throw new Error('pack exploded');
		return this.packOk
			? { target: 'stub:thing', dryRun: true, ok: true, summary: 'Assembled stub-1.0.0.zip', steps: [], warnings: [] }
			: { target: 'stub:thing', dryRun: true, ok: false, summary: 'Package not assembled — 1 blocker', steps: [], warnings: [] };
	}
	async publish(): Promise<AdapterRunResult> {
		// Never reached in these tests — publish is driven through the injected runPublish seam.
		return { target: 'stub:thing', dryRun: false, ok: true, summary: 'published', steps: [], warnings: [] };
	}
}

let stub: StubPublisher;

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
	resetAdapterRegistry();
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query('DELETE project_target; DELETE project;').catch(() => {});
	const p = await createProject(db, {
		slug: `relgate${++seq}`,
		name: 'Gate Host',
		root_path: 'F:/code/relgate',
		build_tool: 'npm run build'
	});
	projectId = p.id;
	// Fresh registry with the stub publisher each test (so packOk/validateOk start clean).
	resetAdapterRegistry();
	stub = new StubPublisher();
	getAdapterRegistry().register(stub);
});

/** Declare the stub publish target as the project default. */
async function declareStubTarget() {
	await declareTarget(db, {
		project: projectId,
		kind: 'publish',
		adapterId: 'stub-publish',
		label: 'Stub Publisher',
		config: { namespace: 'team' },
		enabled: true,
		isDefault: true
	});
}

/** A build runner that always exits with the given code. */
function buildExit(code: number | null, stderr = ''): (f: string, a: readonly string[], o: { cwd: string }) => Promise<CommandResult> {
	return async () => ({ code, stdout: 'building…', stderr });
}

/** A publish seam capturing what it was handed; returns a green (or red) driver result. */
function capturePublish(ok = true) {
	const calls: Array<{ projectId: string; targetId: string; confirmToken: string }> = [];
	const fn = async (args: { projectId: string; targetId: string; confirmToken: string }): Promise<RunTargetActionResult> => {
		calls.push({ projectId: args.projectId, targetId: args.targetId, confirmToken: args.confirmToken });
		return {
			result: { target: 'stub:thing', dryRun: false, ok, summary: ok ? 'uploaded version 1.0.0' : 'upload did not complete', steps: [], warnings: [] },
			run: {} as RunTargetActionResult['run'],
			confirmToken: args.confirmToken,
			target: {} as RunTargetActionResult['target']
		};
	};
	return { fn, calls };
}

const env = { [STUB_SECRET]: 'sek' };

// ── ALL GREEN → publish proceeds (stubbed) → published:true ─────────────────────────────────────────

describe('runReleaseReadinessGate — all green publishes through the EXISTING path', () => {
	it('consent + build/pack/validate green → published:true; the publish seam got a valid token for THIS target', async () => {
		await declareStubTarget();
		const pub = capturePublish(true);
		const out = await runReleaseReadinessGate({
			db,
			env,
			projectId,
			consent: true,
			runCommand: buildExit(0),
			runPublish: pub.fn
		});
		expect(out.published).toBe(true);
		expect(out.failedAt).toBeNull();
		// Every objective check ran and is green.
		const names = out.checks.map((c) => c.name);
		expect(names).toEqual(['consent', 'target', 'token', 'build', 'pack', 'validate', 'publish']);
		expect(out.checks.every((c) => c.ok)).toBe(true);
		// The publish seam drove the EXISTING D-037 path with THIS project's resolved target + a real token.
		expect(pub.calls.length).toBe(1);
		expect(pub.calls[0].projectId).toBe(projectId);
		expect(pub.calls[0].targetId).toMatch(/^project_target:/);
		expect(pub.calls[0].confirmToken).toMatch(/^[0-9a-f]{64}$/); // deterministic sha256 token.
	});
});

// ── consent + build-red → NO publish, halt honestly ─────────────────────────────────────────────────

describe('runReleaseReadinessGate — a RED build never publishes', () => {
	it('build exits non-zero → published:false, failedAt build, NO publish call', async () => {
		await declareStubTarget();
		const pub = capturePublish(true);
		const out = await runReleaseReadinessGate({
			db,
			env,
			projectId,
			consent: true,
			runCommand: buildExit(1, 'TS2345: type error'),
			runPublish: pub.fn
		});
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('build');
		expect(out.summary).toMatch(/build FAILED/i);
		expect(out.checks.find((c) => c.name === 'build')?.detail).toMatch(/exited 1/);
		// pack/validate/publish were NEVER attempted (the gate short-circuits at the first red).
		expect(out.checks.some((c) => c.name === 'pack')).toBe(false);
		expect(pub.calls.length).toBe(0);
	});

	it('build command cannot run (spawn throws) → published:false, named, NO publish', async () => {
		await declareStubTarget();
		const pub = capturePublish(true);
		const out = await runReleaseReadinessGate({
			db,
			env,
			projectId,
			consent: true,
			runCommand: async () => {
				throw new Error('ENOENT: dotnet not on PATH');
			},
			runPublish: pub.fn
		});
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('build');
		expect(out.summary).toMatch(/ENOENT/);
		expect(pub.calls.length).toBe(0);
	});
});

// ── consent + validate-red / pack-red → NO publish (the "build green, validate skipped" gap) ────────

describe('runReleaseReadinessGate — pack/validate red never publish (no partial gate slips through)', () => {
	it('build green but VALIDATE red → published:false, failedAt validate, NO publish', async () => {
		await declareStubTarget();
		stub.validateOk = false;
		stub.validateBlockers = ['icon.png is not 256×256'];
		const pub = capturePublish(true);
		const out = await runReleaseReadinessGate({
			db,
			env,
			projectId,
			consent: true,
			runCommand: buildExit(0),
			runPublish: pub.fn
		});
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('validate');
		expect(out.checks.find((c) => c.name === 'build')?.ok).toBe(true); // build WAS green…
		expect(out.checks.find((c) => c.name === 'pack')?.ok).toBe(true); //   …pack WAS green…
		expect(out.checks.find((c) => c.name === 'validate')?.ok).toBe(false); //   …but validate is the wall.
		expect(out.summary).toMatch(/256/);
		expect(pub.calls.length).toBe(0);
	});

	it('build green but PACK red → published:false, failedAt pack, NO publish', async () => {
		await declareStubTarget();
		stub.packOk = false;
		const pub = capturePublish(true);
		const out = await runReleaseReadinessGate({
			db,
			env,
			projectId,
			consent: true,
			runCommand: buildExit(0),
			runPublish: pub.fn
		});
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('pack');
		// validate was NEVER reached (pack is before it) — and certainly no publish.
		expect(out.checks.some((c) => c.name === 'validate')).toBe(false);
		expect(pub.calls.length).toBe(0);
	});

	it('a pack THROW is caught into a named red check (never crashes), NO publish', async () => {
		await declareStubTarget();
		stub.packThrows = true;
		const pub = capturePublish(true);
		const out = await runReleaseReadinessGate({ db, env, projectId, consent: true, runCommand: buildExit(0), runPublish: pub.fn });
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('pack');
		expect(out.summary).toMatch(/threw/);
		expect(pub.calls.length).toBe(0);
	});
});

// ── NO consent → halt at the gate (never reaches build/pack/publish) ────────────────────────────────

describe('runReleaseReadinessGate — no consent never publishes (the integrity wall)', () => {
	it('consent:false → published:false, failedAt consent, NOTHING else ran', async () => {
		await declareStubTarget();
		const pub = capturePublish(true);
		let buildCalls = 0;
		const out = await runReleaseReadinessGate({
			db,
			env,
			projectId,
			consent: false,
			runCommand: async () => {
				buildCalls++;
				return { code: 0, stdout: '', stderr: '' };
			},
			runPublish: pub.fn
		});
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('consent');
		expect(out.checks).toHaveLength(1); // ONLY the consent check ran.
		expect(buildCalls).toBe(0); // no build…
		expect(pub.calls.length).toBe(0); // …no publish.
	});
});

// ── no target / no token → halt honestly ────────────────────────────────────────────────────────────

describe('runReleaseReadinessGate — missing target/token halt honestly', () => {
	it('no declared publish target → published:false, failedAt target, NO build/publish', async () => {
		// No declareStubTarget() — the project has no publish target.
		const pub = capturePublish(true);
		let buildCalls = 0;
		const out = await runReleaseReadinessGate({
			db,
			env,
			projectId,
			consent: true,
			runCommand: async () => {
				buildCalls++;
				return { code: 0, stdout: '', stderr: '' };
			},
			runPublish: pub.fn
		});
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('target');
		expect(out.summary).toMatch(/no publish target/i);
		expect(buildCalls).toBe(0);
		expect(pub.calls.length).toBe(0);
	});

	it('declared target but the required secret is NOT set → published:false, failedAt token, NO build/publish', async () => {
		await declareStubTarget();
		const pub = capturePublish(true);
		let buildCalls = 0;
		const out = await runReleaseReadinessGate({
			db,
			env: {}, // STUB_SECRET absent.
			projectId,
			consent: true,
			runCommand: async () => {
				buildCalls++;
				return { code: 0, stdout: '', stderr: '' };
			},
			runPublish: pub.fn
		});
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('token');
		expect(out.summary).toMatch(new RegExp(STUB_SECRET));
		expect(buildCalls).toBe(0); // we halt before building an artifact we cannot publish.
		expect(pub.calls.length).toBe(0);
	});

	it('no build command declared → published:false, failedAt build, NO publish', async () => {
		// A project with no build_tool/test_command.
		await db.query('DELETE project_target; DELETE project;');
		const p = await createProject(db, { slug: `relgate${++seq}`, name: 'No Build', root_path: 'F:/code/nb' });
		projectId = p.id;
		resetAdapterRegistry();
		stub = new StubPublisher();
		getAdapterRegistry().register(stub);
		await declareStubTarget();
		const pub = capturePublish(true);
		const out = await runReleaseReadinessGate({ db, env, projectId, consent: true, runPublish: pub.fn });
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('build');
		expect(out.summary).toMatch(/no project build command/i);
		expect(pub.calls.length).toBe(0);
	});
});

// ── a publish that does not complete → halt at publish (no false 'published') ────────────────────────

describe('runReleaseReadinessGate — a publish that does not complete halts honestly', () => {
	it('green gate but the publish returns ok:false → published:false, failedAt publish, gate surfaced', async () => {
		await declareStubTarget();
		const pub = capturePublish(false); // the driver ran but the upload did not complete.
		const out = await runReleaseReadinessGate({ db, env, projectId, consent: true, runCommand: buildExit(0), runPublish: pub.fn });
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('publish');
		expect(out.publish?.result.ok).toBe(false);
		expect(pub.calls.length).toBe(1); // the publish WAS attempted (gate was green) — but it did not complete.
	});

	it('the publish seam THROWS (e.g. a stale-token GateConfirmError) → published:false, failedAt publish', async () => {
		await declareStubTarget();
		const out = await runReleaseReadinessGate({
			db,
			env,
			projectId,
			consent: true,
			runCommand: buildExit(0),
			runPublish: async () => {
				throw new Error('confirm token does not match this target');
			}
		});
		expect(out.published).toBe(false);
		expect(out.failedAt).toBe('publish');
		expect(out.summary).toMatch(/did NOT complete/i);
	});
});
