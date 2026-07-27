import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── THE SCORE-READ LEDGER — a STRUCTURAL guard, not a sixth point fix ────────────────────────
//
// WHY THIS FILE EXISTS. The rule is one sentence: an `interview_run` states its recall / false-
// positive figures ONLY when `isScoredStatus(status)` — the status is terminal ({passed, failed})
// and the run actually produced them. It was enforced ONE SURFACE AT A TIME and it did not
// converge: five surfaces were fixed individually, and a red-team still found a sixth
// (`routes/agents/ceremony/+page.svelte`, the action-feedback line, rendering
// `found N/T · k FP` completely ungated — three lines above a branch on `status`). Two more were
// found deferred behind it, one of which PERSISTED the fabricated number into a row.
//
// Point fixes cannot close this, because the failure is not "someone wrote bad code" — it is
// "someone added a NEW reader and had no way to know the rule applied to them". So the guard is
// not another assertion about one surface. It is an INVENTORY: every file in `src/` that reads a
// score column is listed below with a VERDICT, and this test fails when the inventory drifts —
// a new file starts reading them, an existing file grows a new read, or a listed file stops.
//
// WHAT IT COSTS, stated honestly. It fires on benign edits too: rename a local `plantedFound`,
// add a doc-example, delete a field, and the count moves. That is deliberate and it is the whole
// mechanism — the cost of touching these columns is one line of ledger and thirty seconds of
// deciding "does this new read state a number the run produced?". That question being asked at
// all is the property five point fixes never achieved. If you are here because the count moved:
// do NOT just bump the number. Look at the new read, gate it through
// `$lib/shared/interview-status` if it states a score, and write down which it was.
//
// WHAT IT CANNOT DO. It is a text scan, so it proves an INVENTORY, not a gate: it cannot tell a
// gated read from an ungated one. It guarantees the decision gets MADE, not that it gets made
// correctly. The behavioural gates live in the tests next to each surface.

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** The columns that CLAIM A MEASUREMENT, snake (DB) and camel (view-model) spellings alike.
 *  `\b` keeps `max_false_positives` (a pass-bar CRITERION, not a measurement) out of the count. */
const SCORE_IDENT =
	/\b(planted_found|planted_total|false_positives|plantedFound|plantedTotal|falsePositives)\b/g;

/**
 * Comments are stripped before counting. This codebase comments HEAVILY — the columns are named
 * dozens of times in prose explaining exactly this rule — and pinning prose would make the ledger
 * fire on every doc edit, which is how a guard gets deleted. Only real code counts.
 *
 * `(?<!:)//` spares `http://`; `<!-- -->` covers Svelte markup; `/* *\/` covers both TS block
 * comments and `<style>` blocks.
 */
function stripComments(src: string): string {
	return src
		.replace(/\r\n/g, '\n') // F-054: CRLF churn must not shift the counts.
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(?<!:)\/\/.*$/gm, '');
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) sourceFiles(p, acc);
		// Test files are excluded: a test's whole job is to construct these numbers.
		else if (/\.(ts|svelte)$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(p);
	}
	return acc;
}

/** file → number of score-column reads in comment-stripped code. */
function scanScoreReads(): Map<string, number> {
	const found = new Map<string, number>();
	for (const file of sourceFiles(SRC)) {
		const rel = relative(REPO, file).replace(/\\/g, '/');
		const n = (stripComments(readFileSync(file, 'utf8')).match(SCORE_IDENT) ?? []).length;
		if (n > 0) found.set(rel, n);
	}
	return found;
}

type Verdict =
	/** Routes through `isScoredStatus` before stating any score. */
	| 'gated'
	/** Gated by CONSTRUCTION: the query/caller can only hand it a terminal run. */
	| 'gated-upstream'
	/** Carries the raw columns AND the status; the single renderer downstream gates. Named. */
	| 'row-model'
	/** WRITES the columns (scorer / runner / event emitter). Cannot fabricate — it is the source. */
	| 'write-path'
	/** Reads them for something that is not a score claim (a pass-bar criterion, a count). */
	| 'not-a-score-claim';

interface LedgerEntry {
	reads: number;
	verdict: Verdict;
	why: string;
}

/**
 * THE COMPLETE LIST — every reader of a score column in `src/`, with a verdict.
 *
 * This is the artifact the sweep produced, kept in the repo instead of in a summary that gets
 * lost. Sorted by path.
 */
const LEDGER: Record<string, LedgerEntry> = {
	'src/lib/components/agents/hire-why-core.ts': {
		reads: 5,
		verdict: 'gated',
		why: "the 'interviewed' case gates recall AND FP on isScoredStatus (:68/:72); 'gauntlet_started' states planted_total only (a plant COUNT known at t=0, not a score); 'adjudicated' counts operator decisions, not run columns; 'candidate_considered' is gated-upstream — recruiter-hire refuses a non-terminal run before the event is ever emitted"
	},
	'src/lib/components/agents/hiring-ledger-core.ts': {
		reads: 12,
		verdict: 'gated',
		why: 'ceremonyFacts emits the recall + FP chips only inside `if (isScoredStatus(run.status))` (:218); the status chip and the error chip are outside it and state no number'
	},
	'src/lib/server/db/schema.ts': {
		reads: 3,
		verdict: 'write-path',
		why: 'the DDL that DEFINEs planted_total / planted_found / false_positives — the anchor itself, not a reader'
	},
	'src/lib/server/workforce/ceremony.ts': {
		reads: 15,
		verdict: 'row-model',
		why: 'latestRunLine carries the raw columns AND the status straight through to CeremonyInterviewLine; the sole renderer (routes/agents/ceremony/+page.svelte) gates on isScoredStatus. Certification itself never reads these — it is gated on a passing run (certifiedFromRuns)'
	},
	'src/lib/server/workforce/gauntlet.ts': {
		reads: 34,
		verdict: 'write-path',
		why: 'the runner: computes the score and WRITES the columns on each finalize. Note the error finalizes write planted_found:0 — the uninitialised value every reader must not publish'
	},
	'src/lib/server/workforce/hire-events.ts': {
		reads: 29,
		verdict: 'write-path',
		why: 'the analytics emitters; they persist what the caller measured. Recall is null-honest at plantedTotal 0 (:222). Terminality is the CALLER’s (hire-why-core documents which ops are gated where)'
	},
	'src/lib/server/workforce/panel.ts': {
		reads: 25,
		verdict: 'row-model',
		why: 'latestRun carries the raw columns AND the status into InterviewLine; routes/agents/+page.svelte gates. AdjudicationCard deliberately does NOT project false_positives at all (:373) — it is never written on the adjudicating finalize'
	},
	'src/lib/server/workforce/recruiter-hire.ts': {
		reads: 27,
		verdict: 'gated',
		why: 'refuses outright on `!isScoredStatus(run.status)` (:124) before any figure is read — the upstream that makes hire-why-core’s candidate_considered case safe'
	},
	'src/lib/server/workforce/repo.ts': {
		reads: 51,
		verdict: 'row-model',
		why: 'HiringRunFacts is the raw interview_run join for the hiring feed; it carries status alongside, and hiring-ledger-core is its single renderer and gates. The derived `recall` is computed unconditionally here BY DESIGN — null only when planted_total is 0 — because the row model states rows, not verdicts'
	},
	'src/lib/server/workforce/resolution.ts': {
		reads: 25,
		verdict: 'gated',
		why: 'regauntletChallenger gates on isScoredStatus BEFORE building or persisting a comparison — the one path where an ungated read PERSISTED. A non-terminal run writes nothing and returns unscoredComparison (all score fields null). The incumbent baseline query is gated-upstream: `WHERE status = "passed"`'
	},
	'src/lib/server/workforce/scorer.ts': {
		reads: 25,
		verdict: 'write-path',
		why: 'the deterministic scorer — it PRODUCES plantedFound/plantedTotal and evaluates the pass bar. There is no run status here to gate on; this is the thing that creates the score'
	},
	'src/lib/server/workforce/tier-hiring.ts': {
		reads: 23,
		verdict: 'gated-upstream',
		why: 'the grid reads the LATEST PASSING run only — the query is `WHERE status = "passed" ORDER BY started_at DESC LIMIT 1` (:246), so a non-terminal run can never reach it; null when no passing run exists'
	},
	'src/lib/server/workforce/track-record.ts': {
		reads: 12,
		verdict: 'gated',
		why: 'foldInterviews picks latestScored via isScoredStatus. It used to declare its own TERMINAL set that wrongly included "error", publishing recall 0% for every broken run. The passed/failed/error/adjudicating/running COUNTS are ungated on purpose — a count is not a score claim'
	},
	'src/routes/agents/+page.svelte': {
		reads: 8,
		verdict: 'gated',
		why: 'the interview line is an allow-list: error / running / adjudicating (progress only, no FP) / isScoredStatus (the sole score branch, status word first) / else → "no verdict recorded for this status"'
	},
	'src/routes/agents/ceremony/+page.server.ts': {
		reads: 18,
		verdict: 'gated',
		why: 'outcomeResult omits the score keys entirely unless isScoredStatus, and emits adjudicating progress under DIFFERENT names (progressFound/progressTotal) so no template can mistake a lower bound for a verdict. The adjudication card never projects false_positives (:166)'
	},
	'src/routes/agents/ceremony/+page.svelte': {
		reads: 10,
		verdict: 'gated',
		why: 'both the interview line and the action-feedback line (THE sixth instance) branch on isScoredStatus; the adjudication card states plants-found-so-far as explicit progress with no FP figure'
	},
	'src/routes/agents/proposals/+page.server.ts': {
		reads: 8,
		verdict: 'gated',
		why: 'outcomeResult gates the score keys identically to its ceremony twin, even though this page’s markup renders only the status today'
	},
	'src/routes/agents/proposals/+page.svelte': {
		reads: 4,
		verdict: 'gated-upstream',
		why: 'reads only the persisted review_proposal.comparison, which resolution.ts now only ever writes from a terminal run; every figure is rendered through a null-honest `num()`/`?? "—"`'
	}
};

describe('score-read ledger — every reader of a scored column is inventoried', () => {
	const found = scanScoreReads();

	it('no UNINVENTORIED file reads a score column', () => {
		const missing = [...found.keys()].filter((f) => !(f in LEDGER)).sort();
		expect(
			missing,
			`NEW reader(s) of planted_found / planted_total / false_positives with no ledger entry:\n` +
				missing.map((f) => `  • ${f}`).join('\n') +
				`\n\nThis is the guard, not a nuisance. Decide whether the new read STATES A SCORE:\n` +
				`  · if it does, gate it on isScoredStatus from $lib/shared/interview-status;\n` +
				`  · then add an entry to LEDGER in score-read-ledger.test.ts with a verdict and why.\n` +
				`Never re-declare terminality locally — a second definition is how this class survived ` +
				`five fixes.`
		).toEqual([]);
	});

	it('no ledger entry is STALE — a listed file that no longer reads them is dead rule surface', () => {
		const stale = Object.keys(LEDGER)
			.filter((f) => !found.has(f))
			.sort();
		expect(
			stale,
			`ledger entries whose file no longer reads a score column (delete the entry): ${stale.join(', ')}`
		).toEqual([]);
	});

	it('the read COUNT per file is pinned — a new read inside an ALREADY-listed file trips too', () => {
		// The sixth instance was a new ungated read in a file that had ALREADY been fixed, so
		// file-level membership alone would not have caught it. The count would have.
		const drifted: string[] = [];
		for (const [file, entry] of Object.entries(LEDGER)) {
			const actual = found.get(file);
			if (actual !== undefined && actual !== entry.reads) {
				drifted.push(`${file}: ledger says ${entry.reads}, source has ${actual}`);
			}
		}
		expect(
			drifted,
			`score-column read count changed:\n` +
				drifted.map((d) => `  • ${d}`).join('\n') +
				`\n\nIf you ADDED a read: does it state a number the run produced? Gate it on ` +
				`isScoredStatus, then update the count.\nIf you REMOVED one: update the count.\n` +
				`Do not bump the number without looking at the diff — that is the only way this guard ` +
				`fails.`
		).toEqual([]);
	});

	it('every ledger entry carries a verdict and a stated reason', () => {
		const thin = Object.entries(LEDGER)
			.filter(([, e]) => !e.why || e.why.trim().length < 40)
			.map(([f]) => f);
		expect(thin, `ledger entries with no real justification: ${thin.join(', ')}`).toEqual([]);
	});

	it('the scan actually found files (a broken scanner must not pass vacuously)', () => {
		// A scanner that silently walks the wrong directory would make every assertion above
		// trivially true. Pin the floor.
		expect(found.size).toBeGreaterThan(10);
	});

	it('the comment stripper does not swallow code — a known read is still counted', () => {
		// Proves the strip step cannot quietly zero the whole scan.
		expect(found.get('src/lib/server/workforce/scorer.ts')).toBeGreaterThan(5);
	});
});
