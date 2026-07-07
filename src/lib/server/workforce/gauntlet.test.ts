import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import type { WorkforceConfig } from '../config/index';
import { DEFAULT_GATE_POLICY } from '../claude-code/gates';
import {
	ClaudeCodeRuntime,
	composeCapabilities,
	SterileCompositionError,
	type CanUseToolResult,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import {
	adjudicateInterviewRun,
	checkInterviewBudget,
	fixtureSetSha,
	runGauntlet,
	sampleFixtures,
	assertSafeRelPath,
	AUTO_INTERVIEW_TOKEN_TYPE,
	QUEUED_INTERVIEW_TYPE,
	type GauntletDeps
} from './gauntlet';
import { activateGauntletFixture, newSentinelUlid } from './activation';
import { activeWorkItemId } from '../orchestrator/workqueue';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH } from './scorer';
import {
	createGauntletFixture,
	createGauntletKey,
	createRole,
	createRoleVersion,
	getRole,
	getRoleVersion,
	WorkforceInputError,
	type GauntletFixtureRow,
	type RoleRow,
	type RoleVersionRow
} from './repo';

// TASK 16.6 VERIFY — the gauntlet RUNNER end-to-end against a REAL throwaway
// SurrealDB + the REAL ClaudeCodeRuntime over a scripted backend (the 1.4/1.6b
// mock-backend discipline: the logic is real, only the LLM is scripted; every
// assertion reads rows the engine actually wrote — F-008):
//   • confinement: the workspace IS the editScope root; an out-of-workspace write is
//     denied by the REAL gate callback (15.1 machinery);
//   • sterile composition proof (§3.2): settings.sterile, no briefing, memory-pull
//     refusal fail-closed;
//   • findings contract (§3.3): absent/invalid → honest failed + raw preserved;
//   • mechanical §3.6 classification + ONE retry; failed NEVER auto-retried;
//   • §3.4 adjudication; §3.5 snapshot pass bar incl. fp_tolerance; §3.7 budget gate.

let tdb: TestDb;
let db: Db;
let wsRoot: string;
let harnessRoot: string;

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

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
	wsRoot = mkdtempSync(join(tmpdir(), 'gauntlet-ws-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'gauntlet-harness-'));
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	rmSync(wsRoot, { recursive: true, force: true });
	rmSync(harnessRoot, { recursive: true, force: true });
});

// ── Config + seed helpers ───────────────────────────────────────────────────────

function testConfig(over: Partial<WorkforceConfig['budget']> = {}, gauntletOver: Partial<WorkforceConfig['gauntlet']> = {}): WorkforceConfig {
	return {
		pm: { provider: 'claude', model_id: 'claude-opus-4-8', triggers: { failure_threshold: null } },
		panel: { scope: { max_files: null, max_new_services: null } },
		gauntlet: {
			pass_recall: 1.0,
			max_false_positives: 0,
			session_timeout_minutes: 15,
			...gauntletOver
		},
		budget: { max_auto_interviews_per_day: null, allowed_auto_tiers: [], ...over },
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

let seedCount = 0;

interface Seed {
	role: RoleRow;
	version: RoleVersionRow;
	defectSlug: string;
	controlSlug: string;
}

/** Seed one role: a planted_defect fixture (key: file+lines+evidence on a.ts:3), a
 *  scorer_control fixture with a correct static report pair, both ACTIVATED. */
async function seedRole(opts: {
	source?: 'operator' | 'pm_proposal';
	fixtureProvenance?: string;
	capabilities?: Record<string, unknown>;
	fpTolerance?: number;
	skipControl?: boolean;
} = {}): Promise<Seed> {
	const n = ++seedCount;
	const role = await createRole(db, {
		slug: `gauntlet-host-${n}`,
		name: `Gauntlet Host ${n}`,
		purpose: 'runner test bed'
	});
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are reviewer #${n}. Hunt platform bugs with verbatim evidence.`,
		capabilities: opts.capabilities,
		default_tier: 'sonnet',
		source: opts.source
	});
	const defectSlug = `fx-defect-${n}`;
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: defectSlug,
		kind: 'planted_defect',
		work: { 'a.ts': 'line1\nline2\nprocess.kill(pid, 0);\n' },
		sentinel: newSentinelUlid(),
		provenance: opts.fixtureProvenance
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		plants: [
			{
				id: 'p1',
				class: 'platform-bug',
				location: 'a.ts:3',
				severity: 'high',
				detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'process\\.kill' }
			}
		],
		fp_tolerance: opts.fpTolerance ?? 0
	});
	await activateGauntletFixture(db, fixture.id);

	const controlSlug = `ctrl-${n}`;
	if (!opts.skipControl) {
		const control = await createGauntletFixture(db, {
			role: role.id,
			slug: controlSlug,
			kind: 'scorer_control',
			work: {
				'c.ts': 'l1\nl2\nconst r = eval(input);\n',
				[KNOWN_PASS_PATH]: JSON.stringify([
					{ fixture: controlSlug, file: 'c.ts', lines: [3, 3], class: 'injection', evidence: 'eval(input)' }
				]),
				[KNOWN_FAIL_PATH]: JSON.stringify([])
			},
			sentinel: newSentinelUlid()
		});
		await createGauntletKey(db, {
			fixture: control.id,
			plants: [{ id: 'c1', detection: { file: 'c.ts', lines: [3, 3], evidence_pattern: 'eval\\(' } }]
		});
		await activateGauntletFixture(db, control.id);
	}
	return { role, version, defectSlug, controlSlug };
}

// ── Scripted backends ───────────────────────────────────────────────────────────

type FindingsWriter = (cwd: string, seed: Seed) => void;

interface ScriptedBackend extends CcBackend {
	plans: CcSpawnPlan[];
	probes: { inside?: CanUseToolResult; outside?: CanUseToolResult };
	sawWorkspaceDirs?: string[];
}

/** A candidate that (optionally) writes findings.json into the run workspace, probes
 *  the REAL gate callback, then finishes — the scripted stand-in for the live model. */
function candidateBackend(write: FindingsWriter | null, seed: Seed, extra: RuntimeEvent[] = []): ScriptedBackend {
	const plans: CcSpawnPlan[] = [];
	const probes: ScriptedBackend['probes'] = {};
	const backend: ScriptedBackend = {
		plans,
		probes,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: `cc_gauntlet_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					yield { type: 'log', message: 'candidate reviewing fixtures' } as RuntimeEvent;
					if (plan.canUseTool) {
						probes.inside = await plan.canUseTool('Write', {
							file_path: join(plan.cwd, 'findings.json')
						});
						probes.outside = await plan.canUseTool('Write', {
							file_path: resolve(plan.cwd, '..', '..', 'escape.txt')
						});
					}
					if (write) write(plan.cwd, seed);
					yield {
						type: 'tool_call',
						name: 'Write',
						args: { file_path: 'findings.json' },
						needsConfirm: false
					} as RuntimeEvent;
					yield { type: 'token_usage', input: 900, output: 120 } as RuntimeEvent;
					for (const e of extra) yield e;
					yield { type: 'done', result: { ok: true, summary: 'findings written' } } as RuntimeEvent;
				},
				async cancel() {}
			};
		},
		async resume() {
			throw new Error('not in this test');
		},
		async interject() {}
	};
	return backend;
}

/** A backend whose stream never ends (the env_timeout shape). */
function hangingBackend(): ScriptedBackend {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		probes: {},
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: 'cc_hang',
				async *stream() {
					yield { type: 'log', message: 'spinning' } as RuntimeEvent;
					await new Promise(() => {}); // wedged forever — the runner must bound it
				},
				async cancel() {}
			};
		},
		async resume() {
			throw new Error('no');
		},
		async interject() {}
	};
}

/** A backend that fails to spawn (error event, no done). */
function brokenBackend(): ScriptedBackend {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		probes: {},
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: 'cc_broken',
				async *stream() {
					yield { type: 'error', error: 'spawn exploded (scripted)' } as RuntimeEvent;
				},
				async cancel() {}
			};
		},
		async resume() {
			throw new Error('no');
		},
		async interject() {}
	};
}

function runtimeFor(backend: CcBackend): ClaudeCodeRuntime {
	return new ClaudeCodeRuntime({
		backend,
		harnessConfigRoot: harnessRoot.replace(/\\/g, '/'),
		gates: { ...DEFAULT_GATE_POLICY }
	});
}

function depsFor(backend: CcBackend, config = testConfig()): GauntletDeps {
	return { db, runtime: runtimeFor(backend), config, workspaceRoot: wsRoot };
}

const perfectFindings: FindingsWriter = (cwd, seed) => {
	writeFileSync(
		join(cwd, 'findings.json'),
		JSON.stringify([
			{
				fixture: seed.defectSlug,
				file: 'a.ts',
				lines: [3, 3],
				class: 'platform-bug',
				evidence: 'process.kill(pid, 0)'
			}
		]),
		'utf8'
	);
};

// ── The suite ───────────────────────────────────────────────────────────────────

describe('runGauntlet — happy path (operator trigger, perfect candidate)', () => {
	let seed: Seed;
	let backend: ScriptedBackend;

	it('passes end-to-end: run row, session row, snapshot, scoring, teardown', async () => {
		seed = await seedRole();
		backend = candidateBackend(perfectFindings, seed);
		const out = await runGauntlet(depsFor(backend), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		const run = out.run;
		expect(out.retriedFrom).toBeUndefined();
		expect(run.status).toBe('passed');
		expect(run.planted_total).toBe(1);
		expect(run.planted_found).toBe(1);
		expect(run.false_positives).toBe(0);
		expect(run.fixture_set_sha).toMatch(/^[0-9a-f]{64}$/);
		expect(run.prompt_sha).toBe(seed.version.prompt_sha);
		// §3.5 — the pass bar SNAPSHOT rode the run row.
		expect(run.pass_criteria).toMatchObject({
			pass_recall: 1.0,
			max_false_positives: 0,
			session_timeout_minutes: 15
		});
		// Cost honesty: nothing priced → null, never a fabricated $0 (F-008).
		expect(run.cost_usd).toBeNull();
		expect(run.ended_at).not.toBeNull();

		// The candidate session: kind='interview', identity links, NO project, terminal.
		expect(run.session).toBeTruthy();
		const [sessions] = await db.query<
			[Array<{ kind: string; status: string; role?: unknown; role_version?: unknown; project?: unknown }>]
		>(`SELECT kind, status, role, role_version, project FROM $sid;`, { sid: rid(run.session!) });
		expect(sessions[0].kind).toBe('interview');
		expect(sessions[0].status).toBe('done');
		expect(String(sessions[0].role)).toBe(seed.role.id);
		expect(String(sessions[0].role_version)).toBe(seed.version.id);
		expect(sessions[0].project ?? null).toBeNull();

		// Transcript persisted; NO briefing row (sterile — §3.2).
		const [msgs] = await db.query<[Array<{ content: string; tool_call?: { kind?: string } }>]>(
			`SELECT content, tool_call FROM message WHERE session = $sid LIMIT 100;`,
			{ sid: rid(run.session!) }
		);
		expect(msgs.length).toBeGreaterThan(0);
		expect(msgs.some((m) => m.tool_call?.kind === 'briefing')).toBe(false);

		// Campaign lifecycle: draft → interviewing → passed.
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('passed');

		// MANDATORY teardown (F-014): the run workspace is GONE.
		const idPart = run.id.split(':')[1];
		expect(existsSync(join(wsRoot, idPart))).toBe(false);

		// ── FS-2 (c) FINDING-CITE CAPTURE (FILE-SNAPSHOT-SPEC §3 c): the presence finding cited
		// `<defectSlug>/a.ts:3`; a file_snapshot of that cited file was linked from the run BEFORE the
		// workspace teardown, so the cited content survives + shows next to the finding in-app.
		const [snaps] = await db.query<[Record<string, unknown>[]]>(
			`SELECT path, content, captured_by, is_marker FROM file_snapshot WHERE captured_by = $by;`,
			{ by: run.id }
		);
		const cite = snaps.find((s) => String(s.path) === `${seed.defectSlug}/a.ts`);
		expect(cite).toBeTruthy();
		// The cited content is the REAL fixture work read from the workspace (not fabricated).
		expect(String(cite!.content)).toContain('process.kill(pid, 0)');
		expect(cite!.is_marker).toBe(false);
	}, 30_000);

	it('the captured plan PROVES confinement + sterility (15.1 + §3.2)', async () => {
		const plan = backend.plans[0];
		// editScope: the workspace IS the scope root.
		expect(plan.isolated.settings.editScope).toBeTruthy();
		const scopeRoots = (plan.isolated.settings.editScope as { scopeRoots: string[] }).scopeRoots;
		expect(scopeRoots).toHaveLength(1);
		expect(plan.cwd).toBe(scopeRoots[0]);
		expect(scopeRoots[0].startsWith(wsRoot)).toBe(true);
		// Sterile marker rides the isolated settings (the assertable §3.2 proof).
		expect(plan.isolated.settings.sterile).toBe(true);
		expect(plan.isolated.settings.plugins).toEqual([]);
		// The prompt = prompt core + harness instructions, NO injected memory context.
		expect(plan.prompt).toContain('Hunt platform bugs');
		expect(plan.prompt).toContain('findings.json');
		expect(plan.prompt).not.toContain('Reference context');
		expect(plan.prompt).not.toContain('REFERENCE MATERIAL');
		// The candidate never sees the scorer_control fixture (§3.4).
		expect(plan.prompt).toContain(seed.defectSlug);
		expect(plan.prompt).not.toContain(seed.controlSlug);

		// CONFINEMENT, via the REAL gate callback the backend probed mid-run:
		// in-workspace write allowed, out-of-workspace write DENIED.
		expect(backend.probes.inside?.behavior).toBe('allow');
		expect(backend.probes.outside?.behavior).toBe('deny');
	});
});

// ── WORKFORCE-SPEC §7b.4 — the WEB-CAPABLE researcher runner branch (the reviewed gap) ──
//
// REGRESSION for the reviewed defect: the §7b.4 web-capable runner path (isWebCapable
// detection → serveStubWeb stand-up → web toolPolicy → stub-origin prompt injection →
// fetch allowlist → stub teardown) had NEVER executed end-to-end (gauntlet.test.ts never
// built a web role; the prior live run used a non-web role). These tests drive runGauntlet
// with a REAL researcher role_version (capabilities.tools=[WebFetch]) over a scripted
// backend that probes the REAL gate callback — proving the stub stands up, the candidate's
// WebFetch is allowlisted to the stub ONLY (live internet DENIED, WebSearch DENIED), the
// prompt carries the stub origin, and the stub is torn down (no leaked socket, F-014).

/** Seed a WEB-CAPABLE researcher role: the defect fixture also carries a stub page (the
 *  `stub-source url:` header shape), and the version declares the WebFetch web tool. */
async function seedWebRole(): Promise<Seed & { stubPath: string }> {
	const n = ++seedCount;
	const role = await createRole(db, {
		slug: `gauntlet-web-host-${n}`,
		name: `Gauntlet Web Host ${n}`,
		purpose: 'researcher runner test bed'
	});
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are researcher #${n}. Cross-check claims with verbatim evidence.`,
		capabilities: { skills: [], agents: [], mcp: [], tools: ['WebFetch'] },
		default_tier: 'sonnet',
		source: 'operator'
	});
	const defectSlug = `fx-web-defect-${n}`;
	const stubUrl = `https://stub.local/web-fixture-${n}/page`;
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: defectSlug,
		kind: 'planted_defect',
		work: {
			'a.ts': 'line1\nline2\nprocess.kill(pid, 0);\n',
			'page.md': `<!-- stub-source url: ${stubUrl} -->\n# Page\n\nsome corpus body\n`
		},
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		plants: [
			{
				id: 'p1',
				class: 'platform-bug',
				location: 'a.ts:3',
				severity: 'high',
				detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'process\\.kill' }
			}
		],
		fp_tolerance: 0
	});
	await activateGauntletFixture(db, fixture.id);

	const controlSlug = `web-ctrl-${n}`;
	const control = await createGauntletFixture(db, {
		role: role.id,
		slug: controlSlug,
		kind: 'scorer_control',
		work: {
			'c.ts': 'l1\nl2\nconst r = eval(input);\n',
			[KNOWN_PASS_PATH]: JSON.stringify([
				{ fixture: controlSlug, file: 'c.ts', lines: [3, 3], class: 'injection', evidence: 'eval(input)' }
			]),
			[KNOWN_FAIL_PATH]: JSON.stringify([])
		},
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: control.id,
		plants: [{ id: 'c1', detection: { file: 'c.ts', lines: [3, 3], evidence_pattern: 'eval\\(' } }]
	});
	await activateGauntletFixture(db, control.id);
	return { role, version, defectSlug, controlSlug, stubPath: new URL(stubUrl).pathname };
}

interface WebProbes {
	liveInternet?: CanUseToolResult;
	webSearch?: CanUseToolResult;
	stubFetch?: CanUseToolResult;
	stubOriginFromPrompt?: string;
}

/** A researcher candidate that probes the REAL fetch-allowlist gate, then writes findings. */
function webCandidateBackend(seed: Seed, stubPath: string): ScriptedBackend & { web: WebProbes } {
	const plans: CcSpawnPlan[] = [];
	const web: WebProbes = {};
	const backend = {
		plans,
		probes: {},
		web,
		kind: 'mock' as const,
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			// The candidate reads the stub origin out of its prompt (the runner injected it).
			const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(plan.prompt);
			web.stubOriginFromPrompt = m?.[1];
			return {
				ccSessionId: `cc_web_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					yield { type: 'log', message: 'researcher reviewing' } as RuntimeEvent;
					if (plan.canUseTool) {
						web.liveInternet = await plan.canUseTool('WebFetch', { url: 'https://en.wikipedia.org/wiki/X' });
						web.webSearch = await plan.canUseTool('WebSearch', { query: 'anything' });
						if (web.stubOriginFromPrompt) {
							web.stubFetch = await plan.canUseTool('WebFetch', {
								url: `${web.stubOriginFromPrompt}${stubPath}`
							});
						}
					}
					writeFileSync(
						join(plan.cwd, 'findings.json'),
						JSON.stringify([
							{ fixture: seed.defectSlug, file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' }
						]),
						'utf8'
					);
					yield { type: 'tool_call', name: 'Write', args: { file_path: 'findings.json' }, needsConfirm: false } as RuntimeEvent;
					yield { type: 'done', result: { ok: true, summary: 'done' } } as RuntimeEvent;
				},
				async cancel() {}
			};
		},
		async resume() {
			throw new Error('not in this test');
		},
		async interject() {}
	};
	return backend;
}

describe('§7b.4 web-capable researcher runner — stub-web + fetch allowlist enforced END-TO-END', () => {
	it('arms the fetch allowlist to the stub origin: live internet + WebSearch DENIED, stub fetch ALLOWED', async () => {
		const seed = await seedWebRole();
		const backend = webCandidateBackend(seed, seed.stubPath);
		const out = await runGauntlet(depsFor(backend), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('passed');

		// The runner injected the loopback stub origin into the prompt (§7b.4).
		expect(backend.web.stubOriginFromPrompt).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		// The plan carries the fetch allowlist pinned to that origin.
		expect((backend.plans[0].isolated.settings.fetchPolicy as { allowedOrigin: string }).allowedOrigin).toBe(
			backend.web.stubOriginFromPrompt
		);
		// The web tools rode toolPolicy.allow (research base ⊕ WebFetch).
		expect(backend.plans[0].toolPolicy.allow).toContain('WebFetch');

		// THE GATE, probed mid-run via the REAL canUseTool callback:
		expect(backend.web.liveInternet?.behavior).toBe('deny'); // live internet REFUSED
		expect(backend.web.webSearch?.behavior).toBe('deny'); //     WebSearch REFUSED
		expect(backend.web.stubFetch?.behavior).toBe('allow'); //    stub origin ALLOWED

		// MANDATORY stub teardown (F-014): the loopback origin no longer answers.
		const origin = backend.web.stubOriginFromPrompt!;
		await expect(fetch(`${origin}${seed.stubPath}`)).rejects.toBeTruthy();
	}, 30_000);

	it('a NON-web role arms NO fetch allowlist (opt-in; legacy spawn unchanged)', async () => {
		const seed = await seedRole();
		const backend = candidateBackend(perfectFindings, seed);
		const out = await runGauntlet(depsFor(backend), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		expect(out.kind).toBe('ran');
		expect(backend.plans[0].isolated.settings.fetchPolicy).toBeUndefined();
	}, 30_000);
});

describe('§3.2 sterile composition is fail-closed at the compose seam', () => {
	it('composeCapabilities REFUSES a memory-pull id when sterile (named error); allows it unsterile', () => {
		const catalog = {
			skills: new Set(['memory-pull', 'linting']),
			agents: new Set<string>(),
			mcp: new Set<string>()
		};
		const set = { skills: ['memory-pull'], agents: [], mcp: [] };
		expect(() => composeCapabilities(set, catalog, {}, { sterile: true })).toThrow(
			SterileCompositionError
		);
		// The same id composes outside an interview (the rail is interview-specific).
		expect(composeCapabilities(set, catalog, {}).capabilities.skills).toEqual(['memory-pull']);
		// A clean bundle composes sterile, marked.
		const ok = composeCapabilities({ skills: ['linting'], agents: [], mcp: [] }, catalog, {}, { sterile: true });
		expect(ok.sterile).toBe(true);
	});

	it('a version whose bundle declares the memory pull-tool FAILS the spawn closed (spawn_failure, retried once)', async () => {
		const seed = await seedRole({ capabilities: { skills: ['memory-pull'], agents: [], mcp: [] } });
		const backend = candidateBackend(perfectFindings, seed);
		const runtime = new ClaudeCodeRuntime({
			backend,
			harnessConfigRoot: harnessRoot.replace(/\\/g, '/'),
			gates: { ...DEFAULT_GATE_POLICY },
			catalog: { skills: new Set(['memory-pull']), agents: new Set(), mcp: new Set() }
		});
		const out = await runGauntlet(
			{ db, runtime, config: testConfig(), workspaceRoot: wsRoot },
			{
				roleVersionId: seed.version.id,
				tier: 'sonnet',
				provider: 'claude',
				modelId: 'claude-sonnet-x',
				trigger: 'operator'
			}
		);
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		// The compose threw → error event before the backend was reached → spawn_failure,
		// with the ONE §3.6 auto-retry chained (same mechanical error).
		expect(out.run.status).toBe('error');
		expect(out.run.error_reason).toBe('spawn_failure');
		expect(out.retriedFrom).toBeTruthy();
		expect(out.run.retry_of).toBe(out.retriedFrom);
		expect(backend.plans).toHaveLength(0); // the backend never ran
	}, 30_000);
});

describe('§3.3 findings contract — capability failures, never env errors', () => {
	it('an ABSENT findings.json finalizes failed with the named reason; failed is NEVER auto-retried', async () => {
		const seed = await seedRole();
		const out = await runGauntlet(depsFor(candidateBackend(null, seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('failed');
		expect(out.retriedFrom).toBeUndefined(); // §3.6: failed never auto-retries
		expect(JSON.stringify(out.run.results)).toContain('findings.json absent');
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('failed');
		// Exactly ONE run row for this version (no laundering).
		const [runs] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM interview_run WHERE role_version = $v GROUP ALL;`,
			{ v: rid(seed.version.id) }
		);
		expect(runs[0].c).toBe(1);
	}, 30_000);

	it('INVALID findings.json finalizes failed with the parse reason + the RAW output preserved as evidence', async () => {
		const seed = await seedRole();
		const out = await runGauntlet(
			depsFor(
				candidateBackend((cwd) => writeFileSync(join(cwd, 'findings.json'), 'not even json', 'utf8'), seed)
			),
			{
				roleVersionId: seed.version.id,
				tier: 'sonnet',
				provider: 'claude',
				modelId: 'claude-sonnet-x',
				trigger: 'operator'
			}
		);
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('failed');
		const blob = JSON.stringify(out.run.results);
		expect(blob).toContain('findings contract violated');
		expect(blob).toContain('not even json'); // raw preserved (§3.3)
	}, 30_000);
});

describe('§3.6 mechanical error classification + ONE retry', () => {
	it('env_timeout: the wall clock bounds the run; ONE auto-retry chains retry_of; workspace torn down', async () => {
		const seed = await seedRole();
		const deps = { ...depsFor(hangingBackend()), timeoutMsOverride: 250 };
		const t0 = Date.now();
		const out = await runGauntlet(deps, {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		expect(Date.now() - t0).toBeLessThan(15_000); // bounded, no spin (F-014)
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('error');
		expect(out.run.error_reason).toBe('env_timeout');
		expect(out.retriedFrom).toBeTruthy();
		expect(out.run.retry_of).toBe(out.retriedFrom);
		// Exactly TWO runs (first + ONE retry — an errored retry is never re-retried).
		const [runs] = await db.query<[Array<{ id: unknown; session?: unknown }>]>(
			`SELECT id, session FROM interview_run WHERE role_version = $v LIMIT 10;`,
			{ v: rid(seed.version.id) }
		);
		expect(runs).toHaveLength(2);
		// The timed-out candidate session was driven terminal (cancelled), never wedged.
		for (const r of runs) {
			if (!r.session) continue;
			const [s] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM $sid;`, {
				sid: rid(String(r.session))
			});
			expect(['cancelled', 'failed']).toContain(s[0].status);
		}
		// Workspaces torn down for BOTH attempts.
		for (const r of runs) {
			expect(existsSync(join(wsRoot, String(r.id).split(':')[1]))).toBe(false);
		}
	}, 30_000);

	it('spawn_failure: a runtime error event classifies mechanically', async () => {
		const seed = await seedRole();
		const out = await runGauntlet(depsFor(brokenBackend()), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('error');
		expect(out.run.error_reason).toBe('spawn_failure');
		expect(JSON.stringify(out.run.results)).toContain('spawn exploded');
	}, 30_000);

	it('gate-plane-down is an ENV error (spawn_failure), never a terminal capability failed (live-verify finding)', async () => {
		// The first live run mis-scored exactly this: HOOK_URL/HOOK_TOKEN absent → the CLI
		// gate hook denied EVERY tool fail-closed → no findings.json → the run finalized
		// 'failed' (terminal for the campaign!) for an env outage. The rail classifies it
		// mechanically as spawn_failure instead.
		const seed = await seedRole();
		const backend = candidateBackend(null, seed, [
			{
				type: 'tool_result',
				name: 'Write',
				ok: false,
				output: 'gate control plane not configured (HOOK_URL/HOOK_TOKEN) — failing closed (D-024)'
			}
		]);
		const out = await runGauntlet(depsFor(backend), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('error');
		expect(out.run.error_reason).toBe('spawn_failure');
		expect(JSON.stringify(out.run.results)).toContain('gate control plane unconfigured');
		// The version's campaign is NOT terminally failed — it can retry/re-interview.
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).not.toBe('failed');
	}, 30_000);

	it('scorer_error: a role with NO scorer_control fixture cannot be control-verified (§3.4)', async () => {
		const seed = await seedRole({ skipControl: true });
		const out = await runGauntlet(depsFor(candidateBackend(perfectFindings, seed)), {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') return;
		expect(out.run.status).toBe('error');
		expect(out.run.error_reason).toBe('scorer_error');
		expect(JSON.stringify(out.run.results)).toContain('scorer_control');
	}, 30_000);
});

describe('§3.4 ambiguity → adjudicating → operator resolution against the SNAPSHOT bar', () => {
	async function adjudicatingRun(findings: Array<Record<string, unknown>>, fpTolerance = 0) {
		const seed = await seedRole({ fpTolerance });
		const out = await runGauntlet(
			depsFor(
				candidateBackend((cwd, s) => {
					const resolved = findings.map((f) => ({ ...f, fixture: s.defectSlug }));
					writeFileSync(join(cwd, 'findings.json'), JSON.stringify(resolved), 'utf8');
				}, seed)
			),
			{
				roleVersionId: seed.version.id,
				tier: 'sonnet',
				provider: 'claude',
				modelId: 'claude-sonnet-x',
				trigger: 'operator'
			}
		);
		expect(out.kind).toBe('ran');
		if (out.kind !== 'ran') throw new Error('unreachable');
		return { seed, run: out.run };
	}

	it('a PARTIAL match queues honestly; confirm_hit flips the run to passed', async () => {
		// Right file, wrong lines + wrong evidence = partial (§3.4).
		const { run, seed } = await adjudicatingRun([
			{ file: 'a.ts', lines: [40, 41], class: 'platform-bug', evidence: 'different quote' }
		]);
		expect(run.status).toBe('adjudicating');
		expect(run.ambiguous).toHaveLength(1);
		expect(run.ambiguous[0].type).toBe('partial_match');
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('interviewing'); // not yet judged

		const resolved = await adjudicateInterviewRun(db, run.id, {
			resolutions: [{ index: 0, resolution: 'confirm_hit', note: 'same defect, imprecise lines' }]
		});
		expect(resolved.status).toBe('passed');
		expect(resolved.planted_found).toBe(1);
		expect(resolved.ambiguous).toEqual([]); // queue drained
		expect(JSON.stringify(resolved.results)).toContain('adjudication');
		expect((await getRoleVersion(db, seed.version.id))?.lifecycle).toBe('passed');
	}, 30_000);

	it('an EXTRA finding resolved false_positive fails the armed 0-FP bar (§3.5)', async () => {
		const { run } = await adjudicatingRun([
			{ file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' },
			{ file: 'a.ts', lines: [1, 1], class: 'invented', evidence: 'line1' }
		]);
		expect(run.status).toBe('adjudicating');
		expect(run.planted_found).toBe(1); // the real hit scored deterministically
		expect(run.ambiguous[0].type).toBe('extra_finding');
		const resolved = await adjudicateInterviewRun(db, run.id, {
			resolutions: [{ index: 0, resolution: 'false_positive' }]
		});
		expect(resolved.status).toBe('failed');
		expect(resolved.false_positives).toBe(1);
	}, 30_000);

	it("the fixture's fp_tolerance absorbs the FP (operator-authored loosening, §3.5)", async () => {
		const { run } = await adjudicatingRun(
			[
				{ file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' },
				{ file: 'a.ts', lines: [1, 1], class: 'invented', evidence: 'line1' }
			],
			1 // fp_tolerance
		);
		const resolved = await adjudicateInterviewRun(db, run.id, {
			resolutions: [{ index: 0, resolution: 'false_positive' }]
		});
		expect(resolved.status).toBe('passed');
		expect(resolved.false_positives).toBe(0); // tolerated — not counted against the bar
	}, 30_000);

	it('dismiss leaves the plant missed → recall fails the snapshot bar', async () => {
		const { run } = await adjudicatingRun([
			{ file: 'a.ts', lines: [40, 41], class: 'platform-bug', evidence: 'different quote' }
		]);
		const resolved = await adjudicateInterviewRun(db, run.id, {
			resolutions: [{ index: 0, resolution: 'dismiss' }]
		});
		expect(resolved.status).toBe('failed');
		expect(JSON.stringify(resolved.results)).toContain('recall 0/1');
	}, 30_000);

	it('adjudication input is fail-closed: partial coverage, bad index, confirm_hit on an extra', async () => {
		const { run } = await adjudicatingRun([
			{ file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' },
			{ file: 'a.ts', lines: [1, 1], class: 'invented', evidence: 'line1' }
		]);
		await expect(adjudicateInterviewRun(db, run.id, { resolutions: [] })).rejects.toThrow(/ALL/);
		await expect(
			adjudicateInterviewRun(db, run.id, { resolutions: [{ index: 7, resolution: 'dismiss' }] })
		).rejects.toThrow(/out of range/);
		await expect(
			adjudicateInterviewRun(db, run.id, { resolutions: [{ index: 0, resolution: 'confirm_hit' }] })
		).rejects.toThrow(/only legal for a partial_match/);
		// A non-adjudicating run has no queue.
		const passed = await seedRole();
		const out = await runGauntlet(depsFor(candidateBackend(perfectFindings, passed)), {
			roleVersionId: passed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'operator'
		});
		if (out.kind === 'ran') {
			await expect(adjudicateInterviewRun(db, out.run.id, { resolutions: [] })).rejects.toThrow(
				/only an 'adjudicating' run/
			);
		}
	}, 45_000);
});

describe('§3.7 budget gate — auto triggers count-and-surface until armed', () => {
	it('UNARMED (null cap, the shipped default): nothing auto-runs; the would-be run queues ONCE', async () => {
		const seed = await seedRole();
		const deps = depsFor(candidateBackend(perfectFindings, seed));
		const out = await runGauntlet(deps, {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'auto'
		});
		expect(out.kind).toBe('queued');
		if (out.kind !== 'queued') return;
		expect(out.reason).toMatch(/count-and-surface/);
		expect(out.workItemId).toBeTruthy();
		// F-057-class regression (pins the corrected workqueue.ts/schema.ts §4.12 comment):
		// queued-interview routes through the DETERMINISTIC-id enqueue() (dedupScope = version|tier,
		// no session) — the returned workItemId IS activeWorkItemId(...), NOT a random id. A revert
		// to a random-id CREATE (relying on the work_item_dedup index) breaks this equality.
		expect(out.workItemId).toBe(
			activeWorkItemId(QUEUED_INTERVIEW_TYPE, '', `${seed.version.id}|sonnet`)
		);
		// No run, no session, no spend.
		const [runs] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM interview_run WHERE role_version = $v GROUP ALL;`,
			{ v: rid(seed.version.id) }
		);
		expect(runs[0]?.c ?? 0).toBe(0);
		// A repeat COALESCES into the same surfaced item (dedup — one open ask).
		const again = await runGauntlet(deps, {
			roleVersionId: seed.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'auto'
		});
		expect(again.kind).toBe('queued');
		if (again.kind === 'queued') expect(again.workItemId).toBeNull();
		const [items] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM work_item WHERE work_type = $wt AND status = 'pending' GROUP ALL;`,
			{ wt: QUEUED_INTERVIEW_TYPE }
		);
		expect(items[0]?.c ?? 0).toBeGreaterThanOrEqual(1);
	}, 30_000);

	it('ARMED cap=1 + allowed tier: first auto run SPENDS (token recorded), second queues cap_reached; a disallowed tier queues', async () => {
		const seedA = await seedRole();
		const config = testConfig({ max_auto_interviews_per_day: 1, allowed_auto_tiers: ['sonnet'] });
		const outA = await runGauntlet(depsFor(candidateBackend(perfectFindings, seedA), config), {
			roleVersionId: seedA.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'auto'
		});
		expect(outA.kind).toBe('ran');
		const [tokens] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM work_item WHERE work_type = $wt GROUP ALL;`,
			{ wt: AUTO_INTERVIEW_TOKEN_TYPE }
		);
		expect(tokens[0]?.c ?? 0).toBe(1);

		const seedB = await seedRole();
		const outB = await runGauntlet(depsFor(candidateBackend(perfectFindings, seedB), config), {
			roleVersionId: seedB.version.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-sonnet-x',
			trigger: 'auto'
		});
		expect(outB.kind).toBe('queued');
		if (outB.kind === 'queued') expect(outB.reason).toMatch(/cap/);

		// Tier outside allowed_auto_tiers refuses before any count check.
		const verdict = await checkInterviewBudget(db, config.budget, { tier: 'opus' });
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) expect(verdict.reason).toBe('tier_not_allowed');
	}, 45_000);

	// F-025 defect 2: the day-cap counting token must be recorded ONLY when a run
	// actually starts — i.e. AFTER the pre-flight (sample / keys / plant-floor) passes.
	// The original code recorded it BEFORE the pre-flight, so an ARMED auto trigger that
	// then hit an uncaught pre-flight WorkforceInputError burned a day-cap slot for a
	// run that never happened. Each sub-case arms the budget (cap=1, sonnet allowed) so
	// the budget gate ALLOWS — the ONLY thing that can stop the run is the pre-flight.
	describe('F-025 — an ARMED auto trigger that fails pre-flight consumes NO day-cap token', () => {
		async function tokensSpent(): Promise<number> {
			const [rows] = await db.query<[Array<{ c: number }>]>(
				`SELECT count() AS c FROM work_item WHERE work_type = $wt GROUP ALL;`,
				{ wt: AUTO_INTERVIEW_TOKEN_TYPE }
			);
			return rows[0]?.c ?? 0;
		}

		// Cap set high so the budget gate ALWAYS allows regardless of tokens other tests
		// in this file recorded today (the day-cap count is shared on the one test DB);
		// the ONLY thing that can stop these runs is the pre-flight under test.
		const armedConfig = () => testConfig({ max_auto_interviews_per_day: 1000, allowed_auto_tiers: ['sonnet'] });

		it('no active fixtures: refuses (sampleFixtures), token unspent', async () => {
			const before = await tokensSpent();
			const bare = await createRole(db, { slug: 'auto-bare', name: 'Auto Bare', purpose: 'no fixtures' });
			const bareVersion = await createRoleVersion(db, {
				role: bare.id,
				prompt_core: 'x',
				default_tier: 'sonnet'
			});
			const backend = candidateBackend(null, { role: bare, version: bareVersion, defectSlug: '', controlSlug: '' });
			await expect(
				runGauntlet(depsFor(backend, armedConfig()), {
					roleVersionId: bareVersion.id,
					tier: 'sonnet',
					provider: 'claude',
					modelId: 'claude-sonnet-x',
					trigger: 'auto'
				})
			).rejects.toThrow(WorkforceInputError);
			expect(backend.plans).toHaveLength(0); // refused before any session
			expect(await tokensSpent()).toBe(before); // NO day-cap slot burned
		});

		it('a keyless active fixture: refuses (loadScoringKeys), token unspent', async () => {
			const before = await tokensSpent();
			const role = await createRole(db, { slug: 'auto-keyless', name: 'Auto Keyless', purpose: 'fixture w/o key' });
			const version = await createRoleVersion(db, { role: role.id, prompt_core: 'x', default_tier: 'sonnet' });
			const fixture = await createGauntletFixture(db, {
				role: role.id,
				slug: 'auto-keyless-fx',
				kind: 'planted_defect',
				work: { 'a.ts': 'process.kill(pid, 0);\n' },
				sentinel: newSentinelUlid()
			});
			// NO createGauntletKey — activate the keyless fixture so it is sampled.
			await activateGauntletFixture(db, fixture.id);
			const backend = candidateBackend(null, { role, version, defectSlug: 'auto-keyless-fx', controlSlug: '' });
			await expect(
				runGauntlet(depsFor(backend, armedConfig()), {
					roleVersionId: version.id,
					tier: 'sonnet',
					provider: 'claude',
					modelId: 'claude-sonnet-x',
					trigger: 'auto'
				})
			).rejects.toThrow(WorkforceInputError);
			expect(backend.plans).toHaveLength(0);
			expect(await tokensSpent()).toBe(before);
		});

		it('a plantless pool (key with zero plants): refuses (plant floor §3.5), token unspent', async () => {
			const before = await tokensSpent();
			const role = await createRole(db, { slug: 'auto-plantless', name: 'Auto Plantless', purpose: 'zero plants' });
			const version = await createRoleVersion(db, { role: role.id, prompt_core: 'x', default_tier: 'sonnet' });
			const fixture = await createGauntletFixture(db, {
				role: role.id,
				slug: 'auto-plantless-fx',
				kind: 'clean_control',
				work: { 'a.ts': 'clean code\n' },
				sentinel: newSentinelUlid()
			});
			await createGauntletKey(db, { fixture: fixture.id, plants: [] }); // zero plants
			await activateGauntletFixture(db, fixture.id);
			const backend = candidateBackend(null, { role, version, defectSlug: 'auto-plantless-fx', controlSlug: '' });
			await expect(
				runGauntlet(depsFor(backend, armedConfig()), {
					roleVersionId: version.id,
					tier: 'sonnet',
					provider: 'claude',
					modelId: 'claude-sonnet-x',
					trigger: 'auto'
				})
			).rejects.toThrow(/ZERO plants/);
			expect(backend.plans).toHaveLength(0);
			expect(await tokensSpent()).toBe(before);
		});
	});
});

describe('sampling rails (§3.8/§4.4) + path boundary', () => {
	it('a pm_proposal version is never certified solely on PM-authored fixtures (§4.4)', async () => {
		const seed = await seedRole({ source: 'pm_proposal', fixtureProvenance: 'pm: drafted repro from F-015' });
		const role = await getRole(db, seed.role.id);
		const version = await getRoleVersion(db, seed.version.id);
		await expect(sampleFixtures(db, role!, version!)).rejects.toThrow(/own-author/);
		// The same pool certifies an OPERATOR-authored version (the rail is identity-keyed).
		const opVersion = await createRoleVersion(db, {
			role: seed.role.id,
			prompt_core: 'operator-authored revision',
			default_tier: 'sonnet'
		});
		const fixtures = await sampleFixtures(db, role!, opVersion);
		expect(fixtures).toHaveLength(1);
	});

	it('a role with no active fixtures / a keyless fixture / a plantless pool refuses BEFORE spend', async () => {
		const bare = await createRole(db, { slug: 'bare-host', name: 'Bare', purpose: 'no fixtures' });
		const bareVersion = await createRoleVersion(db, {
			role: bare.id,
			prompt_core: 'x',
			default_tier: 'sonnet'
		});
		const backend = candidateBackend(null, { role: bare, version: bareVersion, defectSlug: '', controlSlug: '' });
		await expect(
			runGauntlet(depsFor(backend), {
				roleVersionId: bareVersion.id,
				tier: 'sonnet',
				provider: 'claude',
				modelId: 'claude-sonnet-x',
				trigger: 'operator'
			})
		).rejects.toThrow(WorkforceInputError);
		expect(backend.plans).toHaveLength(0); // refused before any session
	});

	it('fixture work paths are boundary-validated (no .., no absolute, no drive letters)', () => {
		expect(assertSafeRelPath('src/a.ts', 'fx')).toBe('src/a.ts');
		for (const bad of ['../escape.ts', '/abs.ts', 'C:/evil.ts', 'a/../../b', '']) {
			expect(() => assertSafeRelPath(bad, 'fx')).toThrow(WorkforceInputError);
		}
	});

	it('fixtureSetSha is order-insensitive and content-bound', () => {
		const a = { id: 'gauntlet_fixture:a', content_sha: 's1' } as GauntletFixtureRow;
		const b = { id: 'gauntlet_fixture:b', content_sha: 's2' } as GauntletFixtureRow;
		expect(fixtureSetSha([a, b])).toBe(fixtureSetSha([b, a]));
		expect(fixtureSetSha([a])).not.toBe(fixtureSetSha([{ ...a, content_sha: 'changed' } as GauntletFixtureRow]));
	});
});
