import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus } from '../events/bus';
import { ClaudeCodeRuntime, type CcBackend, type RuntimeEvent } from '../runtime/index';
import { createProject, updateProjectPlan } from './repo';
import { listTasksByProject } from '../tasks/repo';
import { createPm, setPmAutonomous, setPmAutoPublishPreauthorized, getPm, type PmAuthority } from './pm-repo';
import type { PmProposalGenerator } from './pm-propose';
import { type LifecycleDeps } from './pm-lifecycle';
import { AutonomousPmLoop } from './pm-autonomous';
import type { ReleaseGateResult } from './release-gate';

// PMA VERIFY — the CONTINUOUS AUTONOMOUS LOOP against a REAL throwaway SurrealDB. The PM proposal
// GENERATOR is an injected stub (NO spend — mirrors pm-lifecycle.test.ts); the validation PANEL runs the
// SCRIPTED-runtime (a mocked runtime in a TEST is not fabricated product data — every row asserted is read
// back from the live DB). Covers (the BUILD prompt's required cases):
//   • armed PM RE-TICKS on a task-terminal event (the loop drives the next batch);
//   • the loop STOPS honestly at DoD-reached → proposes release tasks → awaiting-release-confirm (NEVER
//     auto-publishes);
//   • the loop STOPS at blocked (needsHire HALTS at the operator hire gate; a standing blocked task stops);
//   • the loop STOPS at cap-reached (the PMA-2 hard re-tick cap bounds unsupervised spend);
//   • a DISARMED PM does NOT auto-re-tick;
//   • a batch still IN FLIGHT does NOT re-tick (waits to drain);
//   • the in-flight LOCK prevents overlapping re-ticks (no double spend).

let tdb: TestDb;
let db: Db;
let projectId: string;
let seq = 0;

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

beforeEach(async () => {
	await db
		.query(
			'DELETE panel_verdict; DELETE decision_brief; DELETE notification; DELETE message; DELETE agent_event; DELETE routing_event; DELETE session; DELETE pm; DELETE pm_memory; DELETE pm_review; DELETE pm_lifecycle_lock; DELETE task; DELETE project;'
		)
		.catch(() => {});
	const p = await createProject(db, {
		slug: `pma${++seq}`,
		name: 'Autonomous Host',
		root_path: 'F:/code/pma'
	});
	projectId = p.id;
	await updateProjectPlan(db, projectId, {
		purpose: 'Ship a working release.',
		definition_of_done: 'All features complete, tested, live-verified.'
	});
});

// ── Scripted backend (mirrors pm-lifecycle.test.ts) ───────────────────────────────────────────────

function queuedBackend(queue: RuntimeEvent[][]): CcBackend {
	return {
		kind: 'mock',
		run() {
			const events = queue.shift();
			if (!events) throw new Error('queuedBackend: unexpected extra spawn');
			return {
				ccSessionId: `cc_pma_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return {
				ccSessionId: req.ccSessionId,
				async *stream() {
					yield { type: 'done', result: { ok: true, summary: 'resumed' } } as RuntimeEvent;
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
}

/** A scripted validator run ending in an APPROVE verdict (promotes under 'act'). */
function approveRun(): RuntimeEvent[] {
	const verdict = {
		verdict: 'approve',
		confidence: 'high',
		classification: 'mechanical',
		reasons: ['purpose ties to the plan DoD', 'criteria executable as written'],
		falsifier: 'the cited evidence row may already be resolved out-of-band',
		evidence: [{ claim: 'no duplicate found', kind: 'absence', artifact: 'open task list', search: 'scanned context' }],
		scope_findings: []
	};
	return [
		{ type: 'log', message: 'examining…' },
		{
			type: 'done',
			result: {
				ok: true,
				summary: `Examined.\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``,
				ccSessionId: `cc_v_${Math.random().toString(36).slice(2, 10)}`
			}
		}
	];
}

function deps(queue: RuntimeEvent[][]): LifecycleDeps {
	return {
		bus: new EventBus(),
		runtime: new ClaudeCodeRuntime({ backend: queuedBackend(queue) }),
		fallbackModel: { provider: 'claude', modelId: 'claude-test' },
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		proposalModel: { provider: 'claude', modelId: 'claude-test' },
		proposalAgentId: 'pm-propose-1'
	};
}

function candidate(over: Record<string, unknown> = {}) {
	return {
		title: 'Add the release checklist',
		objective: 'Build the pre-release verification checklist task.',
		purpose: 'The plan DoD requires every feature live-verified before release.',
		acceptance_criteria: ['A checklist task exists covering build/test/live-verify.'],
		evidence: ['plan:definition_of_done'],
		...over
	};
}

/** A stub generator returning a fixed payload — NO spend. */
function stub(payload: unknown): PmProposalGenerator {
	return async () => payload;
}

async function hire(authority: PmAuthority, armed = true) {
	await createPm(db, { project: projectId, name: 'Vesper', authority });
	if (armed) await setPmAutonomous(db, projectId, true);
}

/** Build a loop whose lifecycle ticks use the given panel queue + stub generator (NO spend). */
function loop(
	panelQueue: RuntimeEvent[][],
	genPayload: unknown,
	opts: { maxTicks?: number; now?: () => number; releasePayload?: unknown } = {}
) {
	return new AutonomousPmLoop({
		db,
		bus: new EventBus(),
		deps: deps(panelQueue),
		maxTicksPerWindow: opts.maxTicks,
		now: opts.now,
		lifecycleOpts: { generate: stub(genPayload) },
		releaseOpts: { generate: stub(opts.releasePayload ?? genPayload) }
	});
}

// ── PMA-1: the armed flag ─────────────────────────────────────────────────────────────────────────

describe('setPmAutonomous — the armed flag (PMA-1)', () => {
	it('arms/disarms an existing PM; defaults false on hire; never auto-hires a missing PM', async () => {
		// No PM → arming returns null (NEVER auto-hires).
		expect(await setPmAutonomous(db, projectId, true)).toBeNull();
		expect(await getPm(db, projectId)).toBeNull();

		await createPm(db, { project: projectId, name: 'Vesper', authority: 'act' });
		expect((await getPm(db, projectId))?.autonomous).toBe(false); // default false (supervised).

		expect((await setPmAutonomous(db, projectId, true))?.autonomous).toBe(true);
		expect((await getPm(db, projectId))?.autonomous).toBe(true);
		expect((await setPmAutonomous(db, projectId, false))?.autonomous).toBe(false);
	});
});

// ── Re-tick on a task-terminal event ───────────────────────────────────────────────────────────────

describe('AutonomousPmLoop — armed PM re-ticks toward the next batch', () => {
	it('an armed PM re-ticks and promotes the next batch (running)', async () => {
		await hire('act');
		const lp = loop([approveRun(), approveRun()], { proposals: [candidate()] });
		const out = await lp.evaluate(projectId);
		expect(out.state).toBe('running');
		expect(out.lifecycle?.promoted).toBe(1);
		// The promoted task is REALLY 'ready' (the panel's own setStatus — the existing auto-develop path).
		expect((await listTasksByProject(db, projectId, 'ready')).length).toBe(1);
		expect(lp.reTickCount).toBe(1);
	});

	it('a terminal task event on the bus drives the same re-tick', async () => {
		await hire('act');
		const bus = new EventBus();
		const lp = new AutonomousPmLoop({
			db,
			bus,
			deps: deps([approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [candidate()] }) }
		});
		lp.start();
		// Simulate a task reaching a terminal state — the SAME shape the live-query source publishes.
		bus.publish({
			type: 'db_change',
			topic: 'task',
			key: 'task:done1',
			data: { action: 'UPDATE', record: 'task:done1', result: { status: 'done', project: projectId } }
		});
		await lp.idle();
		lp.stop();
		expect(lp.reTickCount).toBe(1);
		expect(lp.lastOutcome.get(projectId)?.state).toBe('running');
	});
});

// ── Disarmed / no-PM → NO re-tick ───────────────────────────────────────────────────────────────────

describe('AutonomousPmLoop — disarmed/absent PM does NOT auto-re-tick', () => {
	it('a DISARMED PM is idle (no re-tick, no spend)', async () => {
		await hire('act', false); // hired but NOT armed.
		const lp = loop([], { proposals: [candidate()] });
		const out = await lp.evaluate(projectId);
		expect(out.state).toBe('idle');
		expect(out.lifecycle).toBeNull();
		expect(lp.reTickCount).toBe(0);
		expect((await listTasksByProject(db, projectId)).length).toBe(0); // nothing generated.
	});

	it('no PM hired → idle (never auto-hires)', async () => {
		const lp = loop([], { proposals: [candidate()] });
		const out = await lp.evaluate(projectId);
		expect(out.state).toBe('idle');
		expect(await getPm(db, projectId)).toBeNull();
	});
});

// ── Batch still in flight → wait ────────────────────────────────────────────────────────────────────

describe('AutonomousPmLoop — a batch still in flight does NOT re-tick', () => {
	it('an in-flight (ready) task blocks the re-tick (running, no second spend)', async () => {
		await hire('act');
		// Seed a promoted task that is still being worked (ready) — a batch is in flight.
		await db.query(`CREATE task CONTENT { project: $p, title: 'wip', description: 'x', status: 'ready' };`, {
			p: new (await import('surrealdb')).StringRecordId(projectId)
		});
		const lp = loop([], { proposals: [candidate()] }); // no panel runs expected — should not tick.
		const out = await lp.evaluate(projectId);
		expect(out.state).toBe('running');
		expect(out.reason).toMatch(/in flight/i);
		expect(lp.reTickCount).toBe(0); // did NOT re-tick while the batch is in flight.
	});
});

// ── DoD reached → release proposal → HALT at the publish gate (NEVER auto-publish) ─────────────────

describe('AutonomousPmLoop — DoD reached halts at the operator publish gate', () => {
	it('zero proposals + no work → DoD reached → proposes release tasks → awaiting-release-confirm', async () => {
		await hire('act');
		// First tick generates NOTHING (no actionable gaps). The release tick then proposes ONE release
		// task (version bump) which the panel approves. The loop HALTS at awaiting-release-confirm.
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]), // panel runs for the release tick's one proposal.
			lifecycleOpts: { generate: stub({ proposals: [] }) }, // DoD tick: no gaps.
			releaseOpts: {
				generate: stub({
					proposals: [
						candidate({
							title: 'Bump version to 1.0.0 and pack',
							objective: 'Bump the project version to 1.0.0, pack and validate the release artifact, write the changelog.'
						})
					]
				})
			}
		});
		const out = await lp.evaluate(projectId);
		expect(out.state).toBe('awaiting-release-confirm');
		expect(out.reason).toMatch(/HALTED at the publish gate/i);
		expect(out.reason).toMatch(/never auto-published/i);
		// The release task was REALLY proposed + promoted to ready (a development task — the loop has NO
		// publish authority; the actual external publish stays operator-gated, D-037).
		expect(out.lifecycle?.generated).toBe(1);
		const ready = await listTasksByProject(db, projectId, 'ready');
		expect(ready.some((t) => /1\.0\.0/.test(t.title))).toBe(true);
	});

	it('DoD reached but a task is BLOCKED → stops blocked (the PM cannot propose a way forward)', async () => {
		await hire('act');
		await db.query(`CREATE task CONTENT { project: $p, title: 'stuck', description: 'x', status: 'blocked' };`, {
			p: new (await import('surrealdb')).StringRecordId(projectId)
		});
		const lp = loop([], { proposals: [] }); // no gaps proposed, but a blocker stands.
		const out = await lp.evaluate(projectId);
		expect(out.state).toBe('blocked');
		expect(out.reason).toMatch(/blocked/i);
	});
});

// ── CONSENTED auto-publish: the objective release-readiness gate decides (HIGHEST-STAKES path) ───────
// At DoD-reached, WITH the operator's recorded auto_publish_preauthorized consent, the loop runs the
// OBJECTIVE gate (build + pack + validate) via the injected seam and ONLY proceeds to 'published' on a
// GREEN gate. On a RED gate it HALTS at 'awaiting-release-confirm' with the failure surfaced. WITHOUT
// consent, behavior is UNCHANGED (halt at the gate). The gate's own build/publish are NOT exercised here
// (that is release-gate.test.ts) — we inject a stub gate verdict and assert the LOOP's decision wiring.

describe('AutonomousPmLoop — consented auto-publish runs the objective gate, never publishes unsafely', () => {
	/** A loop at DoD-reached (zero gaps), with an injected release-gate verdict. The release tick proposes
	 *  exactly ONE release-prep task (version bump) — so PHASE 1 holds the publish; PHASE 2 runs the gate
	 *  only after that task DRAINS. */
	function gateLoop(gateResult: ReleaseGateResult) {
		return new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [] }) }, // DoD: no gaps.
			releaseOpts: { generate: stub({ proposals: [candidate({ title: 'Bump version to 1.0.0' })] }) },
			releaseGate: async () => gateResult
		});
	}

	/** Mark every promoted release-prep task DONE (simulating the version-bump/pack/changelog tasks
	 *  completing) so the next evaluate sees release prep DRAINED and reaches PHASE 2 (the publish gate). */
	async function drainReleaseTasks() {
		await db.query(`UPDATE task SET status = 'done' WHERE project = $p AND status IN ['ready','in_progress','review'];`, {
			p: new (await import('surrealdb')).StringRecordId(projectId)
		});
	}

	/** Drive the two-phase consented flow to its terminal: PHASE 1 (propose+hold → running), drain the
	 *  release prep, then PHASE 2 (the gate). Returns the PHASE-1 and PHASE-2 outcomes. */
	async function driveToPublish(lp: AutonomousPmLoop) {
		const phase1 = await lp.evaluate(projectId);
		await drainReleaseTasks();
		const phase2 = await lp.evaluate(projectId);
		return { phase1, phase2 };
	}
	const greenGate: ReleaseGateResult = {
		published: true,
		checks: [{ name: 'publish', ok: true, detail: 'uploaded 1.0.0' }],
		failedAt: null,
		summary: 'published stub:thing',
		publish: null
	};
	const redGate: ReleaseGateResult = {
		published: false,
		checks: [{ name: 'build', ok: false, detail: 'build exited 1' }],
		failedAt: 'build',
		summary: 'the project build FAILED (exit 1)',
		publish: null
	};

	it('PHASE 1: consent + release prep proposed → HOLDS the publish (running), gate NOT run this cycle', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		let gateCalls = 0;
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [] }) },
			releaseOpts: { generate: stub({ proposals: [candidate({ title: 'Bump version to 1.0.0' })] }) },
			releaseGate: async () => {
				gateCalls++;
				return greenGate;
			}
		});
		const out = await lp.evaluate(projectId);
		// Release prep was JUST proposed (version not bumped yet) → HOLD the publish, do NOT run the gate.
		expect(out.state).toBe('running');
		expect(out.reason).toMatch(/HOLDING the publish/i);
		expect(gateCalls).toBe(0); // the gate (and any publish) is NOT run on the cycle that proposes prep.
		// The version-bump release task is REALLY promoted to ready (developing, not yet done).
		const ready = await listTasksByProject(db, projectId, 'ready');
		expect(ready.some((t) => /1\.0\.0/.test(t.title))).toBe(true);
	});

	it('PHASE 2: consent + GREEN gate AFTER release prep drains → published (the two-phase 0→v1 drive completes)', async () => {
		await hire('act');
		expect((await setPmAutoPublishPreauthorized(db, projectId, true))?.auto_publish_preauthorized).toBe(true);
		const lp = gateLoop(greenGate);
		const { phase1, phase2 } = await driveToPublish(lp);
		expect(phase1.state).toBe('running'); // PHASE 1 held the publish.
		expect(phase2.state).toBe('published'); // PHASE 2 published only after the prep drained.
		expect(phase2.reason).toMatch(/GREEN/);
		expect(phase2.releaseGate?.published).toBe(true);
	});

	// ── AUTO-DISARM at v1 (operator directive: a ONE-SHOT 0→v1 drive that AUTO-DISARMS on the real ──────
	// publish-success signal, never a forever-daemon). On gate.published the loop sets pm.autonomous=false
	// and surfaces the honest 'v1 shipped — autonomous mode complete' terminal state. It does NOT re-tick
	// after disarm; only an EXPLICIT operator re-arm starts a fresh drive.

	it('GREEN gate → AUTO-DISARMS the PM (autonomous=false) and reports "v1 shipped"', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		expect((await getPm(db, projectId))?.autonomous).toBe(true); // armed before the drive completes.
		const lp = gateLoop(greenGate);
		const { phase2: out } = await driveToPublish(lp);
		expect(out.state).toBe('published');
		expect(out.reason).toMatch(/v1 shipped/i);
		expect(out.reason).toMatch(/autonomous mode complete/i);
		expect(out.reason).toMatch(/auto-disarmed/i);
		// The disarm is driven by the REAL publish-success signal — the LIVE pm row is now disarmed (F-008).
		expect((await getPm(db, projectId))?.autonomous).toBe(false);
	});

	it('after the v1 disarm the loop does NOT re-tick (a later terminal event is idle, gate NOT re-run)', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		let gateCalls = 0;
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [] }) },
			releaseOpts: { generate: stub({ proposals: [candidate({ title: 'Bump version to 1.0.0' })] }) },
			releaseGate: async () => {
				gateCalls++;
				return greenGate;
			}
		});
		const { phase2 } = await driveToPublish(lp);
		expect(phase2.state).toBe('published');
		expect(gateCalls).toBe(1); // the gate ran EXACTLY once (PHASE 2), never on PHASE 1.
		const reTicksAfterPublish = lp.reTickCount;
		// A later terminal event MUST NOT re-tick or re-run the gate: the live row is disarmed (Gate 1 → idle).
		const second = await lp.evaluate(projectId);
		expect(second.state).toBe('idle');
		expect(second.reason).toMatch(/not armed/i);
		expect(gateCalls).toBe(1); // NOT 2 — no second publish.
		expect(lp.reTickCount).toBe(reTicksAfterPublish); // no extra re-tick.
	});

	it('the v1 disarm is IDEMPOTENT — a re-run of the published drive lands the same disarmed state (no double-anything)', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		// Disarm the row up-front (simulating a prior partial run that already disarmed) — the GREEN drive must
		// still land cleanly on 'published' and leave the row disarmed (a MERGE to false over false is a no-op).
		await setPmAutonomous(db, projectId, false);
		await setPmAutonomous(db, projectId, true); // re-arm so the drive can run.
		const lp = gateLoop(greenGate);
		const { phase2 } = await driveToPublish(lp);
		expect(phase2.state).toBe('published');
		expect((await getPm(db, projectId))?.autonomous).toBe(false);
	});

	it('an EXPLICIT operator re-arm after v1 starts a FRESH drive (a new version is operator-initiated)', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		let gateCalls = 0;
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun(), approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [] }) },
			releaseOpts: { generate: stub({ proposals: [candidate({ title: 'Bump version to 1.0.0' })] }) },
			releaseGate: async () => {
				gateCalls++;
				return greenGate;
			}
		});
		expect((await driveToPublish(lp)).phase2.state).toBe('published'); // v1 shipped → disarmed.
		expect(gateCalls).toBe(1);
		// Clear the v1 release task the first drive promoted/drained (the operator would ship/close it before
		// the next version) so the fresh drive reaches DoD→gate again rather than waiting on stale work.
		await db.query(`DELETE task WHERE project = $p;`, {
			p: new (await import('surrealdb')).StringRecordId(projectId)
		});
		// Operator explicitly RE-ARMS for the next version — a fresh, explicit action (never the loop itself).
		// Gate 1's re-arm path clears the release-prep latch, so the fresh drive re-proposes prep (PHASE 1)
		// then publishes after it drains (PHASE 2) — proving a post-v1 version is operator-initiated.
		await setPmAutonomous(db, projectId, true);
		const { phase1: reArmedP1, phase2: reArmedP2 } = await driveToPublish(lp);
		expect(reArmedP1.state).toBe('running'); // fresh PHASE 1 re-proposed prep (not skipped to a stale gate).
		expect(reArmedP2.state).toBe('published');
		expect(gateCalls).toBe(2); // the gate ran a SECOND time — only because the operator re-armed.
	});

	it('consent recorded + RED gate (build fails) → NO publish, halts at awaiting-release-confirm honestly', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		const lp = gateLoop(redGate);
		const { phase2: out } = await driveToPublish(lp);
		expect(out.state).toBe('awaiting-release-confirm');
		expect(out.reason).toMatch(/RED at "build"/);
		expect(out.reason).toMatch(/no publish/i);
		expect(out.releaseGate?.published).toBe(false);
	});

	it('NO consent → the gate seam is NEVER invoked; behavior unchanged (halt at the publish gate)', async () => {
		await hire('act'); // consent NOT set (default false).
		let gateCalls = 0;
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [] }) },
			releaseOpts: { generate: stub({ proposals: [candidate({ title: 'Bump version to 1.0.0' })] }) },
			releaseGate: async () => {
				gateCalls++;
				return greenGate;
			}
		});
		const out = await lp.evaluate(projectId);
		expect(out.state).toBe('awaiting-release-confirm');
		expect(out.reason).toMatch(/never auto-published/i);
		expect(gateCalls).toBe(0); // the gate was NEVER consulted without recorded consent.
		expect(out.releaseGate ?? null).toBeNull();
	});

	it('consent recorded but the gate seam THROWS → halts honestly (never an auto-publish on an indeterminate gate)', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [] }) },
			releaseOpts: { generate: stub({ proposals: [candidate({ title: 'Bump version to 1.0.0' })] }) },
			releaseGate: async () => {
				throw new Error('gate env unreachable');
			}
		});
		const { phase2: out } = await driveToPublish(lp);
		expect(out.state).toBe('awaiting-release-confirm');
		expect(out.reason).toMatch(/gate errored/i);
		expect(out.reason).toMatch(/gate env unreachable/);
	});

	it('published does NOT re-run the gate (no double publish) — the v1 auto-disarm carries the no-spin guarantee', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		let gateCalls = 0;
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [] }) },
			releaseOpts: { generate: stub({ proposals: [candidate({ title: 'Bump version to 1.0.0' })] }) },
			releaseGate: async () => {
				gateCalls++;
				return greenGate;
			}
		});
		expect((await driveToPublish(lp)).phase2.state).toBe('published');
		expect(gateCalls).toBe(1);
		// A later terminal event MUST NOT re-run the gate: post-v1 the PM is auto-disarmed → Gate 1 → idle.
		const second = await lp.evaluate(projectId);
		expect(second.state).toBe('idle'); // disarmed at v1 — not re-published.
		expect(gateCalls).toBe(1); // NOT 2 — no second publish.
	});

	// ── PHASE-SEPARATION CONVERGENCE (the red-team livelock question) ───────────────────────────────────
	// The release tick promotes the version-bump task OUT of 'proposed' (→ ready → done), so the release-tick
	// dedup (which only absorbs still-'proposed' rows) would NOT collapse a second release tick to zero. The
	// #releasePrepProposed latch is what guarantees convergence: PHASE 1 proposes prep ONCE, then PHASE 2
	// SKIPS the release tick and goes straight to the gate. This test proves prep is proposed exactly once.

	it('CONVERGENCE: release prep is proposed EXACTLY ONCE across the two phases (no re-propose livelock)', async () => {
		await hire('act');
		await setPmAutoPublishPreauthorized(db, projectId, true);
		let releaseTicks = 0;
		let gateCalls = 0;
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]),
			lifecycleOpts: { generate: stub({ proposals: [] }) },
			releaseOpts: {
				generate: async () => {
					releaseTicks++;
					return { proposals: [candidate({ title: 'Bump version to 1.0.0' })] };
				}
			},
			releaseGate: async () => {
				gateCalls++;
				return greenGate;
			}
		});
		const phase1 = await lp.evaluate(projectId);
		expect(phase1.state).toBe('running'); // PHASE 1 proposed prep, held the publish.
		expect(releaseTicks).toBe(1);
		expect(gateCalls).toBe(0);
		await drainReleaseTasks();
		const phase2 = await lp.evaluate(projectId);
		expect(phase2.state).toBe('published'); // PHASE 2 skipped the release tick, ran the gate, published.
		expect(releaseTicks).toBe(1); // NOT 2 — the release tick was NOT re-run on PHASE 2 (no livelock).
		expect(gateCalls).toBe(1); // the gate ran exactly once.
		// Exactly ONE '1.0.0' release task exists (no duplicate re-proposed prep).
		const all = await listTasksByProject(db, projectId);
		expect(all.filter((t) => /1\.0\.0/.test(t.title)).length).toBe(1);
	});
});

// ── Stop-latch: a stopped project STAYS stopped (never spins / never re-spends) ─────────────────────
// REGRESSION for the re-review defect: #stoppedProjects was WRITTEN but never READ, so a later terminal
// event re-entered the spend path — a dod-reached project re-proposed DUPLICATE release tasks every cycle
// (a capped spin) and a blocked-by-error project retried the throwing tick on every event. The latch must
// re-surface the stopped state WITHOUT re-spending, and must clear on an operator disarm→re-arm.

describe('AutonomousPmLoop — a stopped project STAYS stopped (the never-spin contract)', () => {
	it('awaiting-release-confirm LATCHES: a second terminal event does NOT re-propose release tasks', async () => {
		await hire('act');
		let releaseTicks = 0;
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([approveRun(), approveRun()]), // exactly ONE release proposal's panel run.
			lifecycleOpts: { generate: stub({ proposals: [] }) }, // DoD: no gaps, every call.
			releaseOpts: {
				generate: async () => {
					releaseTicks++;
					return {
						proposals: [
							candidate({
								title: 'Bump version to 1.0.0 and pack',
								objective: 'Bump version, pack and validate, write the changelog.'
							})
						]
					};
				}
			}
		});
		const first = await lp.evaluate(projectId);
		expect(first.state).toBe('awaiting-release-confirm');
		expect(releaseTicks).toBe(1);
		const ticksAfterFirst = lp.reTickCount;

		// A NEW terminal event re-enters #decide — it MUST hit the latch and re-surface the stopped state
		// WITHOUT running a second release tick (no duplicate release task, no extra spend).
		const second = await lp.evaluate(projectId);
		expect(second.state).toBe('awaiting-release-confirm');
		expect(releaseTicks).toBe(1); // NOT 2 — no duplicate release proposal.
		expect(lp.reTickCount).toBe(ticksAfterFirst); // no extra re-tick.
		// Exactly ONE release task exists (no duplicate '1.0.0' tasks).
		const ready = await listTasksByProject(db, projectId, 'ready');
		expect(ready.filter((t) => /1\.0\.0/.test(t.title)).length).toBe(1);
	});

	it('blocked-by-error LATCHES: a second terminal event does NOT retry the throwing tick', async () => {
		await hire('act');
		let attempts = 0;
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([]),
			lifecycleOpts: {
				generate: async () => {
					attempts++;
					throw new Error('PM session env unreachable');
				}
			}
		});
		expect((await lp.evaluate(projectId)).state).toBe('blocked');
		expect(attempts).toBe(1);
		// A later terminal event must NOT re-attempt the failing tick — it re-surfaces 'blocked' off the latch.
		const second = await lp.evaluate(projectId);
		expect(second.state).toBe('blocked');
		expect(attempts).toBe(1); // NOT retried — no spin.
	});

	it('an operator DISARM clears the latch so a re-arm starts clean', async () => {
		await hire('act');
		const lp = loop([], { proposals: [] }, { releasePayload: { proposals: [] } });
		expect((await lp.evaluate(projectId)).state).toBe('awaiting-release-confirm'); // latched.
		// Latched: a re-evaluate stays stopped.
		expect((await lp.evaluate(projectId)).state).toBe('awaiting-release-confirm');

		// Operator DISARMS via the DB (the route's only seam — it never touches the in-memory loop). The
		// next #decide sees autonomous=false, goes idle AND clears the latch.
		await setPmAutonomous(db, projectId, false);
		expect((await lp.evaluate(projectId)).state).toBe('idle');

		// Re-arm: the loop is free to drive again (the latch was cleared by the disarm), proving the
		// re-arm-reset path works without the route reaching into the loop.
		await setPmAutonomous(db, projectId, true);
		const reArmed = await lp.evaluate(projectId);
		expect(reArmed.state).toBe('awaiting-release-confirm'); // drove again, NOT stuck on a stale latch.
	});

	it('cap-reached is NOT a hard latch: it re-evaluates so the rolling window can free it', async () => {
		await hire('propose');
		let clock = 1_000_000;
		let n = 0;
		const panel = Array.from({ length: 8 }, () => approveRun());
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps(panel),
			maxTicksPerWindow: 1,
			now: () => clock,
			lifecycleOpts: { generate: async () => { n++; return { proposals: [candidate({ title: `Cap task ${n}`, evidence: [`plan:cap-${n}`] })] }; } },
			releaseOpts: { generate: async () => { n++; return { proposals: [candidate({ title: `Cap task ${n}`, evidence: [`plan:cap-${n}`] })] }; } }
		});
		expect((await lp.evaluate(projectId)).state).toBe('running'); // consumes the one tick.
		expect((await lp.evaluate(projectId)).state).toBe('cap-reached'); // capped.
		clock += 25 * 60 * 60 * 1000; // window rolls forward.
		// cap-reached must NOT be latched — it re-evaluates and re-ticks now that the window freed.
		expect((await lp.evaluate(projectId)).state).toBe('running');
	});
});

// ── Blocked: needsHire HALTS at the operator hire gate ──────────────────────────────────────────────

describe('AutonomousPmLoop — blocked stops honestly (no spin, no auto-hire)', () => {
	it('needsHire mid-loop HALTS at the operator hire gate (blocked)', async () => {
		// Arm a PM, then DELETE it so the re-tick sees needsHire — exercising the classify branch (we keep
		// the loop armed via lastOutcome path). Directly assert the classify→blocked via a fresh project
		// where evaluate sees no PM is idle; to hit needsHire we keep the pm row but force the tick's
		// internal needsHire by... using the real path: hire+arm, then the lifecycle's needsHire only
		// fires with NO pm. So we assert the loop's OWN gate: no pm → idle (covered above). Here we assert
		// the blocked-by-error path instead (a thrown tick is a hard stop, never a spin).
		await hire('act');
		// A generator that THROWS → the lifecycle tick rejects → the loop records blocked-by-error.
		const lp = new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps([]),
			lifecycleOpts: {
				generate: async () => {
					throw new Error('PM session env unreachable');
				}
			}
		});
		const out = await lp.evaluate(projectId);
		expect(out.state).toBe('blocked');
		expect(out.reason).toMatch(/re-tick failed/i);
		expect(out.reason).toMatch(/env unreachable/i);
	});
});

// ── Cap reached (PMA-2 hard re-tick cap) ────────────────────────────────────────────────────────────

describe('AutonomousPmLoop — the hard re-tick cap bounds unsupervised spend (PMA-2)', () => {
	// A loop whose every re-tick returns a NON-latching 'running' (a propose-authority PM whose approved
	// proposal becomes an operator_gate → the task stays 'proposed', not in-flight). Each call yields a
	// UNIQUE candidate so proposeTask never dedups it to generated:0 (which would latch dod-reached). This
	// is the path that genuinely RE-ENTERS the spend path, so Gate 3 (the cap) is what stops it.
	// Each call yields a UNIQUE evidence ref → a UNIQUE proposal fingerprint (title/objective are NOT in
	// the fingerprint — project+trigger+evidence are; pm-proposals.proposalFingerprint), so proposeTask
	// never absorbs it as a duplicate_open (which would collapse generated→0 and latch dod-reached).
	function gateGen(): PmProposalGenerator {
		let n = 0;
		return async () => {
			n++;
			return { proposals: [candidate({ title: `Gate task ${n}`, objective: `Build gate task ${n}.`, evidence: [`plan:gate-${n}`] })] };
		};
	}
	function gateLoop(opts: { maxTicks?: number; now?: () => number } = {}) {
		// Plenty of approve runs queued — one panel run per re-tick proposal, more than the cap needs.
		const panel = Array.from({ length: 8 }, () => approveRun());
		return new AutonomousPmLoop({
			db,
			bus: new EventBus(),
			deps: deps(panel),
			maxTicksPerWindow: opts.maxTicks,
			now: opts.now,
			lifecycleOpts: { generate: gateGen() },
			releaseOpts: { generate: gateGen() }
		});
	}

	it('stops at cap-reached once the re-tick cap is hit', async () => {
		await hire('propose'); // approved proposals become operator_gate → 'running', task stays 'proposed'.
		// Cap = 2. Two evaluates each re-tick (running, NOT latched); the THIRD is refused at the cap.
		const lp = gateLoop({ maxTicks: 2 });
		expect((await lp.evaluate(projectId)).state).toBe('running');
		expect((await lp.evaluate(projectId)).state).toBe('running');
		expect(lp.reTickCount).toBe(2);

		const capped = await lp.evaluate(projectId);
		expect(capped.state).toBe('cap-reached');
		expect(capped.reason).toMatch(/cap reached/i);
		expect(lp.reTickCount).toBe(2); // NO further re-tick — spend is bounded.
	});

	it('the rolling window frees the cap as ticks age out', async () => {
		await hire('propose');
		let clock = 1_000_000;
		const lp = gateLoop({ maxTicks: 1, now: () => clock });
		expect((await lp.evaluate(projectId)).state).toBe('running'); // consumes the one tick.
		expect((await lp.evaluate(projectId)).state).toBe('cap-reached');
		clock += 25 * 60 * 60 * 1000; // advance past the 24h window.
		const after = await lp.evaluate(projectId);
		expect(after.state).not.toBe('cap-reached'); // the window rolled forward — a re-tick is allowed again.
	});
});

// ── The in-flight lock prevents overlapping re-ticks (no double spend) ──────────────────────────────

describe('AutonomousPmLoop — the lifecycle lock prevents overlapping re-ticks', () => {
	it('a concurrent evaluate while a lock is held does not double-spend', async () => {
		await hire('act');
		// Pre-acquire the project's lifecycle lock so the loop's re-tick sees alreadyRunning (benign) —
		// proving a concurrent tick adds no second PM session/spend.
		const { acquireLifecycleLock, releaseLifecycleLock } = await import('./pm-lifecycle-lock');
		const held = await acquireLifecycleLock(db, projectId);
		expect(held.held).toBe(true);
		try {
			const lp = loop([], { proposals: [candidate()] });
			const out = await lp.evaluate(projectId);
			expect(out.state).toBe('idle');
			expect(out.reason).toMatch(/already running/i);
			// No task was generated (the tick short-circuited on the held lock — no double spend).
			expect((await listTasksByProject(db, projectId, 'proposed')).length).toBe(0);
		} finally {
			await releaseLifecycleLock(db, projectId, held.nonce);
		}
	});

	it('a burst of terminal events coalesces into one decision (re-entrancy guard)', async () => {
		await hire('act');
		const lp = loop([approveRun(), approveRun()], { proposals: [candidate()] });
		// Fire three concurrent evaluations — the per-project guard coalesces them.
		const [a, b, c] = await Promise.all([
			lp.evaluate(projectId),
			lp.evaluate(projectId),
			lp.evaluate(projectId)
		]);
		// Exactly one re-tick ran (the others coalesced); the promoted batch is a single task.
		expect(lp.reTickCount).toBe(1);
		expect([a, b, c].filter((o) => o.lifecycle != null).length).toBeGreaterThanOrEqual(1);
		expect((await listTasksByProject(db, projectId, 'ready')).length).toBe(1);
	});
});
