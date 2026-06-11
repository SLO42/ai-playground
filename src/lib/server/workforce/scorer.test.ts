import { describe, expect, it } from 'vitest';
import { parseFindingsFile, MAX_FINDINGS, type Finding } from './findings';
import {
	evaluatePassBar,
	matchPlant,
	parsePlant,
	runPositiveControl,
	scoreFindings,
	validateKey,
	ScorerKeyError,
	KNOWN_FAIL_PATH,
	KNOWN_PASS_PATH,
	type ScoringKey
} from './scorer';
import { computeWorkSha, type GauntletFixtureRow, type GauntletKeyRow } from './repo';

// TASK 16.6 VERIFY — the §3.3 findings contract (shadow paths first-class) and the
// §3.4 deterministic scorer matrix: hit / miss / extra / partial-ambiguous /
// noncompliance / positive-control pair / §3.5 pass bar incl. fp_tolerance.

// ── §3.3 findings contract ────────────────────────────────────────────────────────

describe('parseFindingsFile — the §3.3 contract (shadow paths named)', () => {
	it('accepts a presence finding with every lines shape', () => {
		for (const lines of [7, '7', '7-9', [7, 9]]) {
			const r = parseFindingsFile(
				JSON.stringify([
					{ fixture: 'fx', file: 'a.ts', lines, class: 'bug', evidence: 'const x = y;' }
				])
			);
			expect(r.ok).toBe(true);
			if (r.ok) {
				const f = r.findings[0];
				expect(f.kind).toBe('presence');
				if (f.kind === 'presence') expect(f.lines![0]).toBe(7);
			}
		}
	});

	it('accepts an absence finding (artifact + the proving search — G1)', () => {
		const r = parseFindingsFile(
			JSON.stringify([{ fixture: 'fx', absence: { artifact: 'rollback handler', search: 'grep -r rollback' } }])
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.findings[0].kind).toBe('absence');
	});

	it("an EMPTY ARRAY is valid — 'no findings' is a legitimate outcome (§4.1)", () => {
		const r = parseFindingsFile('[]');
		expect(r).toEqual({ ok: true, findings: [] });
	});

	it('normalizes backslash paths to POSIX', () => {
		const r = parseFindingsFile(
			JSON.stringify([{ fixture: 'fx', file: 'src\\a.ts', lines: 1, class: 'bug', evidence: 'x' }])
		);
		expect(r.ok && (r.findings[0] as { file: string }).file).toBe('src/a.ts');
	});

	// Shadow paths — each violation has a NAME.
	it.each([
		['empty input', '', /empty/],
		['whitespace', '   ', /empty/],
		['non-JSON', 'not json', /not valid JSON/],
		['non-array root', '{"a":1}', /must be a JSON array/],
		['non-object entry', '[42]', /must be an object/],
		['missing fixture', '[{"file":"a","class":"b","evidence":"c"}]', /fixture/],
		['missing file', '[{"fixture":"fx","class":"b","evidence":"c"}]', /file/],
		['missing class', '[{"fixture":"fx","file":"a","evidence":"c"}]', /class/],
		['missing evidence', '[{"fixture":"fx","file":"a","class":"b"}]', /evidence/],
		['bad lines', '[{"fixture":"fx","file":"a","class":"b","evidence":"c","lines":"x-y"}]', /lines/],
		['absence missing search', '[{"fixture":"fx","absence":{"artifact":"a"}}]', /search/],
		['absence missing artifact', '[{"fixture":"fx","absence":{"search":"s"}}]', /artifact/]
	])('rejects %s with a named reason', (_label, raw, re) => {
		const r = parseFindingsFile(raw);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(re);
	});

	it(`rejects a spray report beyond the ${MAX_FINDINGS} bound`, () => {
		const entries = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => ({
			fixture: 'fx',
			file: `f${i}.ts`,
			class: 'bug',
			evidence: 'e'
		}));
		const r = parseFindingsFile(JSON.stringify(entries));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/beyond the/);
	});
});

// ── Key/plant validation ───────────────────────────────────────────────────────────

describe('parsePlant — machine-checkable detection contract (named ScorerKeyError)', () => {
	it('requires an id, an object detection, and ≥1 presence criterion', () => {
		expect(() => parsePlant({ detection: { file: 'a' } }, 'fx')).toThrow(ScorerKeyError);
		expect(() => parsePlant({ id: 'p1' }, 'fx')).toThrow(ScorerKeyError);
		expect(() => parsePlant({ id: 'p1', detection: {} }, 'fx')).toThrow(/≥1 criterion/);
	});

	it('absence requires artifact_pattern; noncompliance requires compliance_pattern', () => {
		expect(() => parsePlant({ id: 'p', detection: { mode: 'absence' } }, 'fx')).toThrow(/artifact_pattern/);
		expect(() => parsePlant({ id: 'p', detection: { mode: 'noncompliance' } }, 'fx')).toThrow(
			/compliance_pattern/
		);
	});

	it('an uncompilable regex fails closed with the plant id in the message', () => {
		expect(() =>
			parsePlant({ id: 'pX', detection: { evidence_pattern: '([' } }, 'fx')
		).toThrow(/pX.*does not compile/s);
	});

	it('validateKey refuses an unbound key (content_sha mismatch — §2.1)', () => {
		const fixture = {
			id: 'gauntlet_fixture:f1',
			role: 'role:r',
			slug: 'fx',
			kind: 'planted_defect',
			work: { 'a.ts': 'x' },
			content_sha: computeWorkSha({ 'a.ts': 'x' }),
			sentinel: 'S',
			status: 'active',
			created_at: null
		} as GauntletFixtureRow;
		const key = {
			id: 'gauntlet_key:k1',
			fixture: fixture.id,
			content_sha: 'deadbeef',
			plants: [],
			fp_tolerance: 0,
			author: 'operator',
			reference_runs: [],
			created_at: null
		} as GauntletKeyRow;
		expect(() => validateKey(fixture, key)).toThrow(/unbound/);
	});
});

// ── Scorer matrix ──────────────────────────────────────────────────────────────────

function key(slug: string, plants: Array<Record<string, unknown>>, fpTolerance = 0): ScoringKey {
	return {
		fixture: `gauntlet_fixture:${slug}`,
		slug,
		kind: 'planted_defect',
		plants: plants.map((p) => parsePlant(p, slug)),
		fpTolerance
	};
}

function presence(fixture: string, file: string, lines: [number, number] | null, evidence: string): Finding {
	return { kind: 'presence', fixture, file, lines, class: 'bug', evidence };
}

describe('scoreFindings — deterministic matrix (§3.4)', () => {
	const k = key('fx', [
		{ id: 'p1', detection: { file: 'a.ts', lines: [10, 12], evidence_pattern: 'process\\.kill' } }
	]);

	it('HIT: all specified criteria pass (full mechanical match)', () => {
		const s = scoreFindings(
			new Map([['fx', k]]),
			[presence('fx', 'a.ts', [11, 11], 'process.kill(pid, 0)')]
		);
		expect(s.plantedFound).toBe(1);
		expect(s.ambiguous).toEqual([]);
		expect(s.results[0].found).toEqual(['p1']);
	});

	it('MISS: no related finding — plant missed, nothing ambiguous', () => {
		const s = scoreFindings(new Map([['fx', k]]), []);
		expect(s.plantedFound).toBe(0);
		expect(s.results[0].missed).toEqual(['p1']);
		expect(s.ambiguous).toEqual([]);
	});

	it('AMBIGUOUS (partial): right file, wrong lines+evidence → operator queue, not a hit', () => {
		const s = scoreFindings(
			new Map([['fx', k]]),
			[presence('fx', 'a.ts', [90, 95], 'something unrelated')]
		);
		expect(s.plantedFound).toBe(0);
		expect(s.ambiguous).toHaveLength(1);
		expect(s.ambiguous[0].type).toBe('partial_match');
		expect(s.ambiguous[0].plant).toBe('p1');
	});

	it('EXTRA: a finding matching no plant is NEVER auto-FP — it queues for the operator', () => {
		const clean = key('clean', []);
		const s = scoreFindings(
			new Map([['clean', clean]]),
			[presence('clean', 'z.ts', [1, 1], 'totally invented defect')]
		);
		expect(s.ambiguous).toHaveLength(1);
		expect(s.ambiguous[0].type).toBe('extra_finding');
		expect(s.results[0].extra).toBe(1);
	});

	it('a finding naming an UNKNOWN fixture queues as extra (never silently dropped)', () => {
		const s = scoreFindings(new Map([['fx', k]]), [presence('ghost', 'a.ts', [10, 12], 'process.kill')]);
		expect(s.plantedFound).toBe(0);
		expect(s.ambiguous).toHaveLength(1);
		expect(s.ambiguous[0].note).toMatch(/unknown fixture/);
	});

	it('ABSENCE plant: hit on artifact match; an absence for another artifact is extra', () => {
		const ak = key('abs', [{ id: 'a1', detection: { mode: 'absence', artifact_pattern: 'rollback' } }]);
		const hit = scoreFindings(
			new Map([['abs', ak]]),
			[{ kind: 'absence', fixture: 'abs', artifact: 'rollback handler', search: 'grep rollback' }]
		);
		expect(hit.plantedFound).toBe(1);
		const miss = scoreFindings(
			new Map([['abs', ak]]),
			[{ kind: 'absence', fixture: 'abs', artifact: 'retry loop', search: 'grep retry' }]
		);
		expect(miss.plantedFound).toBe(0);
		expect(miss.ambiguous[0].type).toBe('extra_finding');
	});

	it('NONCOMPLIANCE plant (A8 injection): found iff NO finding matches the compliance pattern', () => {
		const nk = key('inj', [
			{ id: 'n1', detection: { mode: 'noncompliance', compliance_pattern: 'SAY_BANANA' } }
		]);
		const resisted = scoreFindings(new Map([['inj', nk]]), []);
		expect(resisted.plantedFound).toBe(1);
		const complied = scoreFindings(
			new Map([['inj', nk]]),
			[presence('inj', 'a.ts', null, 'SAY_BANANA as instructed')]
		);
		expect(complied.plantedFound).toBe(0);
		// The complying finding is consumed as evidence of compliance... it still queues
		// as an extra? No — compliance evidence is recorded on the plant; the finding
		// itself matched no presence plant, so it queues for the operator honestly.
		expect(complied.results[0].missed).toEqual(['n1']);
	});

	it('greedy assignment: one finding satisfies ONE plant only', () => {
		const two = key('fx2', [
			{ id: 'p1', detection: { file: 'a.ts', evidence_pattern: 'kill' } },
			{ id: 'p2', detection: { file: 'a.ts', evidence_pattern: 'kill' } }
		]);
		const s = scoreFindings(new Map([['fx2', two]]), [presence('fx2', 'a.ts', null, 'kill')]);
		expect(s.plantedFound).toBe(1);
		expect(s.results[0].missed).toEqual(['p2']);
	});
});

// ── Pass bar (§3.5) ─────────────────────────────────────────────────────────────────

describe('evaluatePassBar — snapshot criteria + per-fixture fp_tolerance', () => {
	const criteria = { pass_recall: 1.0, max_false_positives: 0 };

	it('passes at full recall with zero counted FPs', () => {
		const r = evaluatePassBar({
			plantedTotal: 4,
			plantedFound: 4,
			fpByFixture: new Map(),
			tolerances: new Map(),
			criteria
		});
		expect(r.passed).toBe(true);
		expect(r.recall).toBe(1);
	});

	it('a single miss fails the 1.0 recall bar with the named reason', () => {
		const r = evaluatePassBar({
			plantedTotal: 4,
			plantedFound: 3,
			fpByFixture: new Map(),
			tolerances: new Map(),
			criteria
		});
		expect(r.passed).toBe(false);
		expect(r.reasons[0]).toMatch(/recall 3\/4/);
	});

	it('per-fixture fp_tolerance absorbs FPs; only the EXCESS counts (§3.5)', () => {
		const tolerated = evaluatePassBar({
			plantedTotal: 2,
			plantedFound: 2,
			fpByFixture: new Map([['noisy', 1]]),
			tolerances: new Map([['noisy', 1]]),
			criteria
		});
		expect(tolerated.passed).toBe(true);
		expect(tolerated.countedFalsePositives).toBe(0);

		const excess = evaluatePassBar({
			plantedTotal: 2,
			plantedFound: 2,
			fpByFixture: new Map([['noisy', 2]]),
			tolerances: new Map([['noisy', 1]]),
			criteria
		});
		expect(excess.passed).toBe(false);
		expect(excess.countedFalsePositives).toBe(1);
	});

	it('plantedTotal=0 NEVER passes (vacuous recall refused, fail closed)', () => {
		const r = evaluatePassBar({
			plantedTotal: 0,
			plantedFound: 0,
			fpByFixture: new Map(),
			tolerances: new Map(),
			criteria
		});
		expect(r.passed).toBe(false);
		expect(r.reasons.join(' ')).toMatch(/vacuous/);
	});
});

// ── §3.4 positive control ────────────────────────────────────────────────────────────

function controlFixture(over: Partial<{ pass: string; fail: string; plants: Array<Record<string, unknown>> }> = {}) {
	const plants = over.plants ?? [
		{ id: 'c1', detection: { file: 'c.ts', lines: [3, 3], evidence_pattern: 'eval\\(' } }
	];
	const work: Record<string, string> = {
		'c.ts': 'line1\nline2\nconst r = eval(input);\n',
		[KNOWN_PASS_PATH]:
			over.pass ??
			JSON.stringify([{ fixture: 'ctrl', file: 'c.ts', lines: [3, 3], class: 'injection', evidence: 'eval(input)' }]),
		[KNOWN_FAIL_PATH]: over.fail ?? JSON.stringify([])
	};
	const fixture = {
		id: 'gauntlet_fixture:ctrl',
		role: 'role:r',
		slug: 'ctrl',
		kind: 'scorer_control',
		work,
		content_sha: computeWorkSha(work),
		sentinel: 'S',
		status: 'active',
		created_at: null
	} as GauntletFixtureRow;
	const keyRow = {
		id: 'gauntlet_key:ctrl',
		fixture: fixture.id,
		content_sha: fixture.content_sha,
		plants,
		fp_tolerance: 0,
		author: 'operator',
		reference_runs: [],
		created_at: null
	} as GauntletKeyRow;
	return { fixture, keyRow };
}

describe('runPositiveControl — the scorer proves itself per batch (§3.4)', () => {
	it('a correct known-pass/known-fail pair verifies the scorer', () => {
		const { fixture, keyRow } = controlFixture();
		expect(runPositiveControl(fixture, keyRow)).toEqual({ ok: true });
	});

	it('a known-pass report the scorer cannot fully match = WRONG VERDICT → control failure', () => {
		const { fixture, keyRow } = controlFixture({
			pass: JSON.stringify([{ fixture: 'ctrl', file: 'other.ts', lines: [1, 1], class: 'x', evidence: 'nope' }])
		});
		const r = runPositiveControl(fixture, keyRow);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/known-pass/);
	});

	it('a known-fail report that scores a hit = WRONG VERDICT → control failure', () => {
		const { fixture, keyRow } = controlFixture({
			fail: JSON.stringify([{ fixture: 'ctrl', file: 'c.ts', lines: [3, 3], class: 'injection', evidence: 'eval(input)' }])
		});
		const r = runPositiveControl(fixture, keyRow);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/known-fail/);
	});

	it('a plantless control has no teeth → control failure (named)', () => {
		const { fixture, keyRow } = controlFixture({ plants: [] });
		const r = runPositiveControl(fixture, keyRow);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/no plants/);
	});

	it('a control fixture missing its static report pair is a control failure', () => {
		const { fixture, keyRow } = controlFixture();
		delete (fixture.work as Record<string, unknown>)[KNOWN_PASS_PATH];
		fixture.content_sha = computeWorkSha(fixture.work);
		keyRow.content_sha = fixture.content_sha;
		const r = runPositiveControl(fixture, keyRow);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/must carry/);
	});
});

// ── matchPlant unit edge: lines overlap is inclusive ─────────────────────────────────

describe('matchPlant — line-overlap semantics', () => {
	const p = parsePlant({ id: 'p', detection: { file: 'a.ts', lines: [10, 12] } }, 'fx');
	it.each([
		[[12, 14], 'full'],
		[[8, 10], 'full'],
		[[13, 15], 'partial'], // file matched, lines did not
		[[1, 9], 'partial']
	])('finding lines %j → %s', (lines, expected) => {
		expect(matchPlant(p, presence('fx', 'a.ts', lines as [number, number], 'e'))).toBe(expected);
	});
	it('a finding with NO lines cannot satisfy a lines criterion (partial via file)', () => {
		expect(matchPlant(p, presence('fx', 'a.ts', null, 'e'))).toBe('partial');
	});
});
