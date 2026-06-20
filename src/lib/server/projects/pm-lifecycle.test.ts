import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus } from '../events/bus';
import { ClaudeCodeRuntime, type CcBackend, type RuntimeEvent } from '../runtime/index';
import { createProject, updateProjectPlan } from './repo';
import { listTasksByProject, getTask } from '../tasks/repo';
import { createPm, listPmMemory, type PmAuthority } from './pm-repo';
import { listPanelVerdictsForArtifact } from '../workforce/repo';
import type { PmProposalGenerator } from './pm-propose';
import { startProjectLifecycle, type LifecycleDeps } from './pm-lifecycle';

// PM-LC-2 VERIFY — the one-click lifecycle TICK against a REAL throwaway SurrealDB. The PM proposal
// GENERATOR is an injected stub (NO spend — mirrors create/agent.ts); the validation PANEL runs real
// (SCRIPTED-runtime, the 1.6b mock-backend pattern — a mocked runtime in a TEST is not fabricated
// product data; every row asserted is read back from the live DB the runner wrote). Covers:
//   • each authority's promotion behavior — observe promotes NOTHING (generates nothing), propose leaves
//     approved proposals 'proposed' for the operator, act promotes 'proposed'→'ready' (the panel's own
//     setStatus — the EXISTING auto-develop trigger);
//   • the needsHire path when no PM is hired (NEVER auto-hire — nothing run);
//   • idempotent bootstrap (a second tick does NOT re-seed founding memory);
//   • the returned summary SHAPE (real counts, honest empties);
//   • shadow paths: nil/empty generation → zero tasks + honest summary.

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
			'DELETE panel_verdict; DELETE decision_brief; DELETE notification; DELETE message; DELETE agent_event; DELETE routing_event; DELETE session; DELETE pm; DELETE pm_memory; DELETE pm_review; DELETE task; DELETE project;'
		)
		.catch(() => {});
	const p = await createProject(db, {
		slug: `pmlc${++seq}`,
		name: 'Lifecycle Host',
		root_path: 'F:/code/pmlc'
	});
	projectId = p.id;
	await updateProjectPlan(db, projectId, {
		purpose: 'Ship a working release.',
		definition_of_done: 'All features complete, tested, live-verified.'
	});
});

// ── Scripted backend: each panel validator spawn consumes the next scripted event stream ──────────

function queuedBackend(queue: RuntimeEvent[][]): CcBackend {
	return {
		kind: 'mock',
		run() {
			const events = queue.shift();
			if (!events) throw new Error('queuedBackend: unexpected extra spawn');
			return {
				ccSessionId: `cc_lc_${Math.random().toString(36).slice(2, 10)}`,
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

/** A scripted validator run ending in an APPROVE verdict-contract summary. */
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

/** Build LifecycleDeps with a SCRIPTED runtime for the panel (the generator is injected separately). */
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

/** One valid proposal candidate the stub generator emits (grounded evidence — no-guessing). */
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

/** A stub generator returning a fixed payload — NO spend (mirrors create/agent.ts test stubs). */
function stub(payload: unknown): PmProposalGenerator {
	return async () => payload;
}

async function hire(authority: PmAuthority) {
	await createPm(db, { project: projectId, name: 'Vesper', authority });
}

// ── needsHire: NEVER auto-hire ──────────────────────────────────────────────────────────────────

describe('startProjectLifecycle — needsHire when no PM (NEVER auto-hire)', () => {
	it('returns needsHire and runs NOTHING when the project has no PM', async () => {
		const res = await startProjectLifecycle(db, deps([]), projectId, {
			generate: stub({ proposals: [candidate()] })
		});
		expect(res.needsHire).toBe(true);
		expect(res.generated).toBe(0);
		expect(res.validated).toBe(0);
		expect(res.promoted).toBe(0);
		expect(res.sessionId).toBeNull();
		// No PM row was created (no auto-hire), and no task was generated.
		expect(await listPmMemory(db, projectId)).toHaveLength(0);
		expect((await listTasksByProject(db, projectId)).length).toBe(0);
		expect(res.summary).toMatch(/no PM is hired/i);
	});
});

// ── Authority promotion matrix (the LOCKED integrity boundary) ────────────────────────────────────

describe('startProjectLifecycle — authority governs promotion (LOCKED)', () => {
	it('authority "act" → the panel promotes the approved proposal proposed→ready (existing path)', async () => {
		await hire('act');
		const res = await startProjectLifecycle(db, deps([approveRun(), approveRun()]), projectId, {
			generate: stub({ proposals: [candidate()] })
		});
		expect(res.authority).toBe('act');
		expect(res.generated).toBe(1);
		expect(res.validated).toBe(1);
		expect(res.promoted).toBe(1);
		expect(res.leftForOperator).toBe(0);
		expect(res.panels[0].decision).toBe('approved');
		expect(res.panels[0].status).toBe('ready');
		// The task is REALLY 'ready' in the DB — read it back (the panel's own setStatus fired).
		const ready = await getTask(db, res.panels[0].taskId);
		expect(ready?.status).toBe('ready');
		// Two real verdict rows were recorded.
		expect(await listPanelVerdictsForArtifact(db, res.panels[0].taskId)).toHaveLength(2);
		expect(res.summary).toMatch(/promoted 1 to ready/i);
	});

	it('authority "propose" → approved proposal STAYS proposed; left for the operator (gate brief)', async () => {
		await hire('propose');
		const res = await startProjectLifecycle(db, deps([approveRun(), approveRun()]), projectId, {
			generate: stub({ proposals: [candidate()] })
		});
		expect(res.authority).toBe('propose');
		expect(res.generated).toBe(1);
		expect(res.promoted).toBe(0);
		expect(res.leftForOperator).toBe(1);
		expect(res.panels[0].decision).toBe('operator_gate');
		expect(res.panels[0].status).toBe('proposed');
		expect(res.panels[0].briefId).not.toBeNull();
		// The task is still 'proposed' in the DB — the operator holds the gate (D-039 untouched).
		const t = await getTask(db, res.panels[0].taskId);
		expect(t?.status).toBe('proposed');
		expect(res.summary).toMatch(/awaiting your approval/i);
	});

	it('authority "observe" → generates NOTHING (proposeTask refuses observe); promotes nothing', async () => {
		await hire('observe');
		const res = await startProjectLifecycle(db, deps([]), projectId, {
			generate: stub({ proposals: [candidate()] })
		});
		expect(res.authority).toBe('observe');
		expect(res.generated).toBe(0);
		expect(res.validated).toBe(0);
		expect(res.promoted).toBe(0);
		expect(res.leftForOperator).toBe(0);
		// An observe PM created NO proposed task — the candidate was dropped (refused by proposeTask).
		expect((await listTasksByProject(db, projectId, 'proposed')).length).toBe(0);
		expect(res.dropped.length).toBeGreaterThan(0);
		expect(res.summary).toMatch(/observe/i);
	});
});

// ── Idempotent bootstrap ──────────────────────────────────────────────────────────────────────────

describe('startProjectLifecycle — idempotent bootstrap', () => {
	it('first tick bootstraps; a second tick does NOT re-seed founding memory', async () => {
		await hire('observe'); // observe so neither tick proposes — isolates the bootstrap assertion.
		const first = await startProjectLifecycle(db, deps([]), projectId, { generate: stub({ proposals: [] }) });
		expect(first.bootstrapped).toBe(true);
		const seeded = await listPmMemory(db, projectId);
		expect(seeded.length).toBeGreaterThan(0);

		const second = await startProjectLifecycle(db, deps([]), projectId, { generate: stub({ proposals: [] }) });
		expect(second.bootstrapped).toBe(false);
		// Memory count unchanged — bootstrapPm no-opped (idempotent).
		expect((await listPmMemory(db, projectId)).length).toBe(seeded.length);
	});
});

// ── Honest empties + summary shape (F-008) ──────────────────────────────────────────────────────

describe('startProjectLifecycle — honest empties + summary shape (F-008)', () => {
	it('act PM, generator returns no proposals → zero tasks, honest summary, real counts', async () => {
		await hire('act');
		const res = await startProjectLifecycle(db, deps([]), projectId, {
			generate: stub({ proposals: [] })
		});
		expect(res.generated).toBe(0);
		expect(res.validated).toBe(0);
		expect(res.promoted).toBe(0);
		expect(res.panels).toEqual([]);
		expect(res.panelFailures).toEqual([]);
		expect((await listTasksByProject(db, projectId, 'proposed')).length).toBe(0);
		expect(res.summary).toMatch(/no actionable gaps/i);
	});

	it('nil generator output is treated as honest-empty (shadow path)', async () => {
		await hire('act');
		const res = await startProjectLifecycle(db, deps([]), projectId, { generate: stub(null) });
		expect(res.generated).toBe(0);
		expect(res.promoted).toBe(0);
		expect(res.summary).toMatch(/PM lifecycle tick/i);
	});

	it('the returned result carries every documented field with real values', async () => {
		await hire('act');
		const res = await startProjectLifecycle(db, deps([approveRun(), approveRun()]), projectId, {
			generate: stub({ proposals: [candidate()] })
		});
		// Shape: every field present, counts internally consistent.
		expect(typeof res.bootstrapped).toBe('boolean');
		expect(res.authority).toBe('act');
		expect(res.generated).toBe(1);
		expect(res.validated).toBe(res.panels.length);
		expect(res.promoted + res.leftForOperator).toBeLessThanOrEqual(res.validated);
		expect(Array.isArray(res.panelFailures)).toBe(true);
		expect(Array.isArray(res.dropped)).toBe(true);
		expect(Array.isArray(res.redactions)).toBe(true);
	});
});

// ── REAL-SPEND CONCURRENCY GUARD (PM-LC-2 hardening) ──────────────────────────────────────────────
// A double-click / concurrent submit must NOT spawn two PM sessions or double-propose. The per-project
// in-flight lock serializes ticks: the second concurrent tick returns a BENIGN already-running result.

/** A generator that COUNTS its invocations (the proxy for "how many PM sessions were spawned"). */
function countingStub(payload: unknown): { gen: PmProposalGenerator; calls: () => number } {
	let calls = 0;
	return {
		gen: async () => {
			calls += 1;
			return payload;
		},
		calls: () => calls
	};
}

describe('startProjectLifecycle — real-spend concurrency guard (PM-LC-2 hardening)', () => {
	it('two CONCURRENT ticks → exactly ONE PM session + ONE set of proposals; the other is benign', async () => {
		await hire('act');
		const c = countingStub({ proposals: [candidate()] });

		// Fire two ticks in parallel (the double-submit). Only ONE may run the generator + panel; the
		// other must short-circuit on the held lock with alreadyRunning (no second session/spend).
		const [a, b] = await Promise.all([
			startProjectLifecycle(db, deps([approveRun(), approveRun()]), projectId, { generate: c.gen }),
			startProjectLifecycle(db, deps([approveRun(), approveRun()]), projectId, { generate: c.gen })
		]);

		const ran = [a, b].filter((r) => !r.alreadyRunning && !r.needsHire);
		const benign = [a, b].filter((r) => r.alreadyRunning === true);
		expect(ran).toHaveLength(1);
		expect(benign).toHaveLength(1);
		// Exactly ONE PM session was spawned (the generator ran once) — no double spend.
		expect(c.calls()).toBe(1);
		// Exactly ONE proposal exists in the DB — no double-propose.
		expect((await listTasksByProject(db, projectId)).length).toBe(1);
		expect(ran[0].generated).toBe(1);
		expect(benign[0].summary).toMatch(/already running/i);
	});

	it('the lock RELEASES on success — a second SEQUENTIAL tick runs normally (no wedge)', async () => {
		await hire('observe'); // observe so each tick is cheap (no panel) — isolates lock release.
		const first = await startProjectLifecycle(db, deps([]), projectId, { generate: stub({ proposals: [] }) });
		expect(first.alreadyRunning).toBeFalsy();
		// If the lock did not release, this second call would return alreadyRunning. It must run normally.
		const second = await startProjectLifecycle(db, deps([]), projectId, { generate: stub({ proposals: [] }) });
		expect(second.alreadyRunning).toBeFalsy();
		expect(second.authority).toBe('observe');
	});

	it('the lock RELEASES on ERROR — a throwing generator does NOT wedge the project', async () => {
		await hire('act');
		const boom: PmProposalGenerator = async () => {
			throw new Error('generator exploded');
		};
		await expect(
			startProjectLifecycle(db, deps([]), projectId, { generate: boom })
		).rejects.toThrow(/exploded/);
		// The lock must have been released in `finally` — a normal tick now runs (not wedged).
		const after = await startProjectLifecycle(db, deps([]), projectId, { generate: stub({ proposals: [] }) });
		expect(after.alreadyRunning).toBeFalsy();
	});

	it('a benign already-running result does NOT mask a needsHire (lock acquired before getPm)', async () => {
		// No PM hired. A single tick returns needsHire — and crucially the lock was released so a later
		// tick (after hiring) is not wedged. (Guards: the benign path can't swallow a real state.)
		const noPm = await startProjectLifecycle(db, deps([]), projectId, { generate: stub({ proposals: [] }) });
		expect(noPm.needsHire).toBe(true);
		expect(noPm.alreadyRunning).toBeFalsy();
		await hire('act');
		const afterHire = await startProjectLifecycle(db, deps([]), projectId, { generate: stub({ proposals: [] }) });
		expect(afterHire.alreadyRunning).toBeFalsy();
		expect(afterHire.needsHire).toBeFalsy();
	});
});
