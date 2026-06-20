import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, updateProjectPlan } from './repo';
import { listTasksByProject } from '../tasks/repo';
import { createPm, addPmMemory } from './pm-repo';
import {
	generatePmProposals,
	validateProposalsOutput,
	parsePmProposalOutput,
	PmProposalContractError,
	MAX_PROPOSALS_PER_TICK,
	type PmProposalGenerator,
	type PmProposalBrief
} from './pm-propose';

// PM-LC-1 VERIFY — the PM proposal GENERATOR against a REAL throwaway SurrealDB. The injected stub
// generator means NO real spend. Covers: proposals created BORN 'proposed' / origin 'pm' with
// pm_lifecycle provenance + real evidence; the F-008 honest-empty path (nil / { proposals: [] } →
// zero tasks + honest summary); the D-026 writer-boundary redaction (a [REDACTED:*] token persists,
// never the raw secret); a quarantined freetext field DROPS the candidate; the per-tick MAX cap; the
// brief assembly feeding the generator real plan/memory rows; and the structured-output parser/
// validator trust-boundary shadow paths.

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
		.query('DELETE pm; DELETE pm_memory; DELETE task; DELETE session; DELETE project;')
		.catch(() => {});
	const p = await createProject(db, {
		slug: `pmprop${++seq}`,
		name: 'Lifecycle Host',
		root_path: 'F:/code/pmprop'
	});
	projectId = p.id;
	await updateProjectPlan(db, projectId, {
		purpose: 'Ship a working release.',
		definition_of_done: 'All features complete, tested, live-verified.'
	});
	// A hired 'act' PM so proposeTask's authority precondition passes (the generator itself is gated
	// by the caller; here we test generation against a propose-capable PM).
	await createPm(db, { project: projectId, name: 'Vesper', authority: 'act' });
});

/** A stub generator that returns a fixed payload — NO spend (mirrors create/agent.ts test stubs). */
function stub(payload: unknown): PmProposalGenerator {
	return async () => payload;
}

/** Capture the brief the generator was handed (asserts the live-row assembly). */
function captureBrief(payload: unknown): { gen: PmProposalGenerator; seen: PmProposalBrief[] } {
	const seen: PmProposalBrief[] = [];
	const gen: PmProposalGenerator = async (brief) => {
		seen.push(brief);
		return payload;
	};
	return { gen, seen };
}

function candidate(over: Record<string, unknown> = {}) {
	return {
		title: 'Triage the open release risk',
		objective: 'Resolve the open release risk before shipping.',
		purpose: 'The plan DoD requires a clean release.',
		acceptance_criteria: ['The risk is resolved or formally accepted.'],
		evidence: [`project:${'x'}`],
		...over
	};
}

describe('generatePmProposals — happy path', () => {
	it('creates tasks BORN proposed / origin pm with pm_lifecycle provenance + real evidence', async () => {
		const ev = [`${projectId}`];
		const gen = stub({ proposals: [candidate({ evidence: ev, title: 'Close the DoD gap' })] });
		const res = await generatePmProposals(db, gen, projectId);

		expect(res.created).toBe(1);
		expect(res.outcomes[0].outcome).toBe('created');
		const proposed = await listTasksByProject(db, projectId, 'proposed');
		expect(proposed).toHaveLength(1);
		const t = proposed[0];
		expect(t.origin).toBe('pm');
		expect(t.status).toBe('proposed');
		expect(t.objective).toBe('Resolve the open release risk before shipping.');
		expect(t.purpose).toBe('The plan DoD requires a clean release.');
		expect(t.acceptance_criteria).toEqual(['The risk is resolved or formally accepted.']);
		expect(t.provenance?.kind).toBe('pm_lifecycle');
		expect(t.provenance?.evidence).toEqual(ev);
		// proposeTask stamps the PM authority onto the provenance.
		expect(t.provenance?.authority).toBe('act');
		expect(res.summary).toContain('1 proposal(s) created');
	});

	it('hands the generator a brief assembled from REAL plan + memory rows (F-008, no fabrication)', async () => {
		const mem = await addPmMemory(db, {
			project: projectId,
			kind: 'risk',
			content: 'Auth flow lacks a refresh-token rotation test.',
			source: 'test'
		});
		const { gen, seen } = captureBrief({ proposals: [] });
		await generatePmProposals(db, gen, projectId);

		expect(seen).toHaveLength(1);
		const brief = seen[0];
		expect(brief.projectName).toBe('Lifecycle Host');
		expect(brief.plan.purpose).toBe('Ship a working release.');
		expect(brief.memory.map((m) => m.id)).toContain(mem.id);
		expect(brief.memory.find((m) => m.id === mem.id)?.kind).toBe('risk');
	});
});

describe('generatePmProposals — F-008 honest empties', () => {
	it('nil generator output → zero tasks + honest no-gaps summary, never fabricates', async () => {
		const res = await generatePmProposals(db, stub(null), projectId);
		expect(res.created).toBe(0);
		expect(res.outcomes).toHaveLength(0);
		expect(res.summary).toMatch(/no actionable gaps/i);
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(0);
	});

	it('empty proposals array → zero tasks + honest summary', async () => {
		const res = await generatePmProposals(db, stub({ proposals: [] }), projectId);
		expect(res.created).toBe(0);
		expect(res.summary).toMatch(/no actionable gaps/i);
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(0);
	});

	it('object with no proposals key → honest empty (not an error)', async () => {
		const res = await generatePmProposals(db, stub({ note: 'healthy' }), projectId);
		expect(res.created).toBe(0);
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(0);
	});
});

describe('generatePmProposals — D-026 writer-boundary screen', () => {
	it('persists a [REDACTED:*] token, NEVER the raw secret, and surfaces the redaction', async () => {
		const gen = stub({
			proposals: [
				candidate({
					evidence: [projectId],
					purpose: 'Notify the owner at ops-lead@example.com when the risk closes.'
				})
			]
		});
		const res = await generatePmProposals(db, gen, projectId);
		expect(res.created).toBe(1);
		const t = (await listTasksByProject(db, projectId, 'proposed'))[0];
		// The raw email never persisted; the safe redacted token did.
		expect(t.purpose).not.toContain('ops-lead@example.com');
		expect(t.purpose).toContain('[REDACTED:email]');
		// The redaction is surfaced honestly (never silent).
		expect(res.redactions.some((r) => r.field.includes('purpose') && r.reasons.includes('email'))).toBe(true);
	});

	it('drops a candidate whose freetext field carries an un-redactable (quarantined) secret', async () => {
		const pem =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIBdum9yfake\n-----END RSA PRIVATE KEY-----';
		const gen = stub({
			proposals: [candidate({ evidence: [projectId], objective: `Rotate the key:\n${pem}` })]
		});
		const res = await generatePmProposals(db, gen, projectId);
		expect(res.created).toBe(0);
		expect(res.dropped.some((d) => /quarantined/i.test(d.reason))).toBe(true);
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(0);
	});

	// Re-review gap 1 (D-026 writer-boundary leak): `evidence` is the FIFTH agent-authored freetext
	// field — it persists (provenance.evidence), composes into the immutable description, and renders
	// verbatim to the operator. It MUST cross the writer-boundary screen like every other field. A
	// secret that fits the structural-ref SHAPE (no whitespace, lowercase prefix) but carries an
	// api-key body must be REDACTED at the boundary — the raw key never persists.
	it('screens evidence at the writer boundary — a key-shaped evidence ref is redacted, never persisted raw (D-026)', async () => {
		const leaky = `gap:sk-ant-${'a'.repeat(24)}`; // valid structural shape, secret body
		const gen = stub({ proposals: [candidate({ evidence: [projectId, leaky] })] });
		const res = await generatePmProposals(db, gen, projectId);
		expect(res.created).toBe(1);
		const t = (await listTasksByProject(db, projectId, 'proposed'))[0];
		// The raw key never lands anywhere evidence is stored/rendered.
		expect(t.provenance?.evidence?.join(' ')).not.toContain('sk-ant-');
		expect(t.provenance?.evidence?.join(' ')).toContain('[REDACTED:anthropic-key]');
		// The redaction is surfaced honestly on an evidence field (never silent).
		expect(res.redactions.some((r) => /evidence/.test(r.field) && r.reasons.includes('anthropic-key'))).toBe(true);
	});

	// A PEM block carries whitespace, so a PEM-in-evidence is refused by the structural-ref SHAPE guard
	// (no-whitespace) BEFORE it can persist — the candidate never lands, the raw key never reaches the
	// store/screen. Defense-in-depth: shape guard (no prose/whitespace) AND screen (key-shaped tokens).
	it('refuses a PEM-in-evidence at the shape guard — the whitespace-bearing secret never persists', async () => {
		const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBfake\n-----END RSA PRIVATE KEY-----';
		const gen = stub({ proposals: [candidate({ evidence: [`key:${pem}`] })] });
		await expect(generatePmProposals(db, gen, projectId)).rejects.toThrow(PmProposalContractError);
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(0);
	});
});

describe('generatePmProposals — anti-spam fingerprint stays structural (re-review gap 2)', () => {
	// Re-review gap 2: evidence feeds proposalFingerprint, whose contract is that cosmetic re-wording
	// cannot dodge an operator defer / duplicate absorb. PM-LC-1 made evidence agent-authored, so it
	// is now constrained to a STRUCTURAL ref shape: free prose ('the DoD gap') is refused, and two
	// ticks grounding the SAME structural refs produce the SAME fingerprint (the second is absorbed).
	it('refuses free-prose evidence (a sentence) so a reworded tick cannot mint a new fingerprint', async () => {
		const prose = stub({ proposals: [candidate({ evidence: ['the DoD gap in the plan'] })] });
		await expect(generatePmProposals(db, prose, projectId)).rejects.toThrow(/structural evidence ref/);
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(0);

		const reworded = stub({ proposals: [candidate({ evidence: ['DoD gap, per plan'] })] });
		await expect(generatePmProposals(db, reworded, projectId)).rejects.toThrow(/structural evidence ref/);
	});

	it('two ticks with the same structural evidence refs share a fingerprint — the second is absorbed, not re-created', async () => {
		const mem = await addPmMemory(db, {
			project: projectId,
			kind: 'risk',
			content: 'Refresh-token rotation is untested.',
			source: 'test'
		});
		const ev = [mem.id]; // a real pm_memory record id — a structural ref
		const first = await generatePmProposals(db, stub({ proposals: [candidate({ evidence: ev, title: 'Close it' })] }), projectId);
		expect(first.created).toBe(1);
		// A second tick re-wording every freetext field but grounding the SAME structural evidence:
		// the fingerprint is identical → absorbed as duplicate_open, NOT a second created row.
		const second = await generatePmProposals(
			db,
			stub({
				proposals: [
					candidate({
						evidence: ev,
						title: 'Totally different wording for the same matter',
						objective: 'Reworded objective that says the same thing differently.',
						purpose: 'Reworded purpose.'
					})
				]
			}),
			projectId
		);
		expect(second.created).toBe(0);
		expect(second.outcomes[0].outcome).toBe('duplicate_open');
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(1);
	});
});

describe('generatePmProposals — bounded per-tick cap', () => {
	it('attempts at most maxProposals candidates; the rest are dropped with an honest note', async () => {
		// 3 candidates, cap the tick at 1 → 1 attempted (created), 2 dropped as over-cap.
		const gen = stub({
			proposals: [
				candidate({ evidence: [projectId], title: 'A' }),
				candidate({ evidence: [projectId], title: 'B' }),
				candidate({ evidence: [projectId], title: 'C' })
			]
		});
		const res = await generatePmProposals(db, gen, projectId, { maxProposals: 1 });
		expect(res.created).toBe(1);
		expect(res.dropped.filter((d) => /over the per-tick cap/.test(d.reason))).toHaveLength(2);
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(1);
	});

	it('never attempts more than MAX_PROPOSALS_PER_TICK even when maxProposals is larger', async () => {
		const proposals = Array.from({ length: MAX_PROPOSALS_PER_TICK + 3 }, (_, i) =>
			candidate({ evidence: [projectId], title: `T${i}` })
		);
		const res = await generatePmProposals(db, stub({ proposals }), projectId, {
			maxProposals: 999
		});
		// over-cap drops = total - MAX (the open-proposal anti-spam cap further limits 'created').
		const overCapDrops = res.dropped.filter((d) => /over the per-tick cap/.test(d.reason));
		expect(overCapDrops).toHaveLength(3);
	});
});

describe('generatePmProposals — upstream error propagates named', () => {
	it('a generator throw (env/timeout) propagates unswallowed, never a phantom success', async () => {
		const gen: PmProposalGenerator = async () => {
			throw new PmProposalContractError('session ended timeout — no proposals produced');
		};
		await expect(generatePmProposals(db, gen, projectId)).rejects.toThrow(/timeout/);
		expect(await listTasksByProject(db, projectId, 'proposed')).toHaveLength(0);
	});

	it('an unknown project → named contract error (the brief assembly fails closed)', async () => {
		await expect(generatePmProposals(db, stub({ proposals: [] }), 'project:nope')).rejects.toThrow(
			PmProposalContractError
		);
	});
});

describe('parsePmProposalOutput / validateProposalsOutput — trust-boundary shadow paths', () => {
	it('parses a fenced json block (last one wins)', () => {
		const text = 'prose\n```json\n{"proposals":[]}\n```\nmore';
		expect(parsePmProposalOutput(text)).toEqual({ proposals: [] });
	});

	it('empty/nil text → named PmProposalContractError', () => {
		expect(() => parsePmProposalOutput('')).toThrow(PmProposalContractError);
		expect(() => parsePmProposalOutput(null)).toThrow(/EMPTY/);
	});

	it('no json block → named error', () => {
		expect(() => parsePmProposalOutput('no json here at all')).toThrow(/no JSON block/);
	});

	it('malformed json → named error', () => {
		expect(() => parsePmProposalOutput('```json\n{bad,\n```')).toThrow(/did not parse/);
	});

	it('nil raw → honest empty []', () => {
		expect(validateProposalsOutput(null)).toEqual([]);
		expect(validateProposalsOutput({})).toEqual([]);
	});

	it('a candidate missing acceptance_criteria → named contract error', () => {
		expect(() =>
			validateProposalsOutput({ proposals: [{ title: 't', objective: 'o', purpose: 'p', evidence: ['e'] }] })
		).toThrow(/acceptance_criteria/);
	});

	it('a candidate missing evidence → named contract error (no-guessing)', () => {
		expect(() =>
			validateProposalsOutput({
				proposals: [{ title: 't', objective: 'o', purpose: 'p', acceptance_criteria: ['a'] }]
			})
		).toThrow(/evidence/);
	});

	it('a non-array proposals → named contract error', () => {
		expect(() => validateProposalsOutput({ proposals: 'nope' })).toThrow(/must be an array/);
	});
});
