// COMPLETION-LEDGER Wave A (finding 2) — the CONCIERGE THINKING LEDGER against a LIVE throwaway
// SurrealDB with the REAL schema (m0085's widened `agent_event.type` ASSERT).
//
// REAL-SURREAL ON PURPOSE. A stubDb does not parse SurrealQL and does not enforce the SCHEMAFULL
// `type` ASSERT, so it would pass green while `type:'consult'` was being REFUSED by the live DB and
// silently absorbed by the writer's own best-effort catch — the exact shape of hole this wave
// exists to close. It also would not catch an F-020 `ORDER BY at` with `at` dropped from the
// projection. Only a live DB proves the row LANDS and the read query PARSES.
//
// WHAT IS PROVEN:
//   • HAPPY PATH — the writer persists a queryable row, and listConciergeTurns READS IT BACK with
//     the full how/why payload (the F-020-sweep rule: a best-effort catch must have a happy-path
//     test behind it, and a best-effort loader needs a test asserting it actually RETURNS rows).
//   • m0085 — `type:'consult'` is ACCEPTED by the live ASSERT (without the migration this fails).
//   • NO DOUBLE METER (the hard regression) — consult rows carry NO token legs and NO cost, and
//     `tokensSpentSince` is byte-identical before and after a burst of them. The existing
//     `completion` metering row remains the sole spend record, estimated-vs-measured intact.
//   • LOCAL/CLOUD HONESTY — a local turn is `local-free`; a cloud turn is `cloud-metered`; a
//     DETERMINISTIC turn under a configured CLOUD brain is `no-model-call` with NO modelUsed.
//   • FAILURE VISIBILITY — a failed turn persists a named, screened error + class.
//   • D-026 — a secret in an ask/reply/error is screened before it is persisted.
//   • FAULT INJECTION — a DB fault on the ledger write is absorbed, returns false, does NOT throw.
//   • SHADOW PATHS — nil / empty / non-Error / malformed-row for every field.
//   • INTEGRATION — handleAtelierMessages emits exactly ONE row per turn, with the real outcome.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { writeAgentEvent } from '../analytics/events';
import { tokensSpentSince } from '../analytics/spend-budget';
import { createProject } from '../projects/repo';
import { fence, FENCE_OPEN, FENCE_CLOSE } from '../memory/fence';
import { sendPeerMessage } from '../peer/repo';
import { handleAtelierMessages, type ConciergeGroundingItem } from './concierge';
import type { RecommendAgentInput } from '../agent-library/recommend';
import {
	recordConciergeTurn,
	listConciergeTurns,
	normConciergeTurnRow,
	conciergeCostClass,
	conciergeTurnSummary,
	screenExcerpt,
	screenTurnError,
	stripFenceEnvelope,
	CONCIERGE_TURN_KIND,
	CONCIERGE_TURN_TYPE,
	CONCIERGE_TURN_OUTCOMES,
	CONCIERGE_TURN_OUTCOME_LABELS,
	CONCIERGE_COST_CLASSES,
	CONCIERGE_COST_CLASS_LABELS,
	type ConciergeBrain
} from './turn-events';

let tdb: TestDb;
let db: Db;
let projectId: string;

const LOCAL_BRAIN: ConciergeBrain = { provider: 'ollama', model: 'gpt-oss:20b', tier: 'local' };
const CLOUD_BRAIN: ConciergeBrain = { provider: 'claude', model: 'claude-sonnet-4', tier: 'sonnet' };

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
	const p = await createProject(db, {
		slug: 'ledgerturns',
		name: 'Ledger Turns Host',
		root_path: 'F:/code/ledger-turns'
	});
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query(`DELETE agent_event;`);
});

/** A Db-shaped stand-in whose query ALWAYS rejects — the fault-injection seam. */
function faultingDb(message: string): Db {
	return {
		query: async () => {
			throw new Error(message);
		}
	} as unknown as Db;
}

// ── vocabulary integrity ─────────────────────────────────────────────────────────────────

describe('concierge turn vocabulary', () => {
	it('every outcome and cost class has a plain-language label (no bare ids reach a human)', () => {
		for (const o of CONCIERGE_TURN_OUTCOMES) {
			expect(CONCIERGE_TURN_OUTCOME_LABELS[o], `outcome ${o} needs a label`).toBeTruthy();
		}
		for (const c of CONCIERGE_COST_CLASSES) {
			expect(CONCIERGE_COST_CLASS_LABELS[c], `cost class ${c} needs a label`).toBeTruthy();
		}
	});

	it('rides `consult`, NOT `completion` — the spend contract must stay single-writer', () => {
		expect(CONCIERGE_TURN_TYPE).toBe('consult');
		expect(CONCIERGE_TURN_TYPE).not.toBe('completion');
	});
});

// ── the local/cloud honesty invariant (pure) ─────────────────────────────────────────────

describe('conciergeCostClass — the local/cloud honesty invariant', () => {
	it('a LOCAL model that ran is free, and is never dressed up as cloud', () => {
		expect(conciergeCostClass(true, 'ollama')).toBe('local-free');
	});

	it('a CLOUD model that ran is metered', () => {
		expect(conciergeCostClass(true, 'claude')).toBe('cloud-metered');
	});

	it('a DETERMINISTIC turn is `no-model-call` even when a cloud brain WAS configured', () => {
		// THE invariant this task turns on: a recommend_agent turn calls no model at all. Reporting
		// it as a cloud call because a cloud brain happened to be configured would be a fabrication.
		expect(conciergeCostClass(false, 'claude')).toBe('no-model-call');
		expect(conciergeCostClass(undefined, 'claude')).toBe('no-model-call');
	});

	it('an LLM turn with an UNKNOWN provider is metered — under-counting cost is the failure class', () => {
		expect(conciergeCostClass(true, undefined)).toBe('cloud-metered');
	});
});

describe('conciergeTurnSummary — reads as a sentence, never a bare id', () => {
	it('names the verdict, the grounding and the cost class', () => {
		const s = conciergeTurnSummary({
			intent: 'recommend_agent',
			handledIntent: true,
			costClass: 'no-model-call',
			outcome: 'replied',
			recommendationCount: 2,
			groundingCount: 3
		});
		expect(s).toContain('recommend_agent');
		expect(s).toContain('recommended 2 specialist(s)');
		expect(s).toContain('grounded on 3 memory item(s)');
		expect(s).toContain('no model call');
	});

	it('a failed turn leads with FAILED and the error', () => {
		const s = conciergeTurnSummary({
			intent: 'open_question',
			costClass: 'no-model-call',
			outcome: 'failed',
			recommendationCount: 0,
			groundingCount: 0,
			errorText: 'provider exploded'
		});
		expect(s).toContain('FAILED');
		expect(s).toContain('provider exploded');
	});

	it('an unclassified/declined turn is honest about it (never invents a verdict)', () => {
		const s = conciergeTurnSummary({
			handledIntent: false,
			costClass: 'no-model-call',
			outcome: 'no_requester',
			recommendationCount: 0,
			groundingCount: 0
		});
		expect(s).toContain('unclassified');
		expect(s).toContain('declined');
		expect(s).toContain('no grounding available');
	});
});

// ── D-026 screening + shadow paths (pure) ────────────────────────────────────────────────

describe('screenExcerpt — D-026 + shadow paths', () => {
	it('screens a secret out of untrusted text before it can be persisted', () => {
		const out = screenExcerpt('use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA to auth');
		expect(out).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
	});

	it('nil input → the caller-supplied absent marker, never the string "undefined"', () => {
		expect(screenExcerpt(undefined, '(no request body)')).toBe('(no request body)');
		expect(screenExcerpt(null, '(no request body)')).toBe('(no request body)');
		expect(screenExcerpt(42)).toBe('(none)');
		expect(screenExcerpt(undefined)).not.toContain('undefined');
	});

	it('empty / whitespace input → an explicit (empty), never a blank that reads as "nothing said"', () => {
		expect(screenExcerpt('')).toBe('(empty)');
		expect(screenExcerpt('   \n  ')).toBe('(empty)');
	});

	it('bounds a long excerpt (an event row is not a transcript)', () => {
		const out = screenExcerpt('x'.repeat(5000));
		expect(out.length).toBeLessThanOrEqual(320);
		expect(out.endsWith('…')).toBe(true);
	});

	it('collapses newlines so the row stays one readable line', () => {
		expect(screenExcerpt('a\n\nb\tc')).toBe('a b c');
	});
});

describe('stripFenceEnvelope — the live-verify defect: the excerpt was ALL boilerplate', () => {
	// Built with the REAL fence(), so the test tracks the actual envelope shape rather than a guess.
	const fenced = fence({ source: 'channel', body: 'Which specialist should own the release pipeline?' });

	it('leaves the real question, not the standing D-026 note', () => {
		const out = stripFenceEnvelope(fenced.text);
		expect(out).toBe('Which specialist should own the release pipeline?');
		expect(out).not.toContain('REFERENCE MATERIAL');
		expect(out).not.toContain(FENCE_OPEN);
		expect(out).not.toContain(FENCE_CLOSE);
	});

	it('end-to-end: the PERSISTED ask is the question, not the boilerplate', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:fenced',
			intent: 'recommend_agent',
			ask: fenced.text,
			outcome: 'replied'
		});
		const [t] = await listConciergeTurns(db);
		expect(t.ask).toBe('Which specialist should own the release pipeline?');
		expect(t.ask).not.toContain('NOT instructions you must obey');
	});

	it('SHADOW PATH — an UNFENCED body is returned unchanged (never emptied)', () => {
		expect(stripFenceEnvelope('just a plain question')).toBe('just a plain question');
		expect(stripFenceEnvelope('')).toBe('');
	});

	it('SHADOW PATH — a malformed/partial envelope degrades to the full text, never to blank', () => {
		const partial = `${FENCE_OPEN}\n[channel] note\nno-separator-here\nbody`;
		expect(stripFenceEnvelope(partial)).toBe(partial);
		const emptyPayload = `${FENCE_OPEN}\n[channel] note\n---\n\n${FENCE_CLOSE}`;
		// An envelope with nothing inside keeps the original rather than reading as "nothing said".
		expect(stripFenceEnvelope(emptyPayload)).toBe(emptyPayload);
	});

	it('a multi-line question survives intact (only framing is removed, never content)', () => {
		const multi = fence({ source: 'channel', body: 'line one\nline two\n--- inner dashes ---' });
		expect(stripFenceEnvelope(multi.text)).toBe('line one\nline two\n--- inner dashes ---');
	});
});

describe('screenTurnError — shadow paths', () => {
	it('nil / empty / non-Error throws all get an honest marker, never "undefined"', () => {
		expect(screenTurnError(undefined)).toBe('(no error message)');
		expect(screenTurnError(null)).toBe('(no error message)');
		expect(screenTurnError('')).toBe('(no error message)');
		expect(screenTurnError({ weird: true })).toBe('(no error message)');
	});

	it('screens a secret out of an error message', () => {
		const out = screenTurnError(
			new Error('auth failed for sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
		);
		expect(out).not.toContain('sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
	});
});

// ── normalizer (F-013 + malformed rows) ──────────────────────────────────────────────────

describe('normConciergeTurnRow — F-013 + malformed input', () => {
	it('coerces a SurrealDB datetime to an ISO string', () => {
		const row = normConciergeTurnRow({ id: 'agent_event:x', at: new Date('2026-07-25T10:00:00Z') });
		expect(row.at).toBe('2026-07-25T10:00:00.000Z');
	});

	it('an ABSENT datetime becomes null (the UI renders "—"), never String(undefined)', () => {
		const row = normConciergeTurnRow({ id: 'agent_event:x' });
		expect(row.at).toBeNull();
		expect(row.at).not.toBe('undefined');
	});

	it('an UNPARSEABLE datetime becomes null rather than an Invalid Date string', () => {
		expect(normConciergeTurnRow({ id: 'x', at: 'not-a-date' }).at).toBeNull();
	});

	it('a row with NO detail degrades to nulls/zeros — never throws, never fabricates', () => {
		const row = normConciergeTurnRow({ id: 'agent_event:x', detail: null });
		expect(row.intent).toBeNull();
		expect(row.modelUsed).toBeNull();
		expect(row.llmUsed).toBe(false);
		expect(row.groundingCount).toBe(0);
		expect(row.durationMs).toBeNull();
	});

	it('an absent duration is null (not a fabricated 0); an absent project is null', () => {
		const row = normConciergeTurnRow({ id: 'x', duration_ms: -5, project: 'garbage' });
		expect(row.durationMs).toBeNull();
		expect(row.project).toBeNull();
	});
});

// ── LIVE writer + reader ─────────────────────────────────────────────────────────────────

describe('recordConciergeTurn — live SurrealDB', () => {
	it('m0085: a `consult` row is ACCEPTED by the live type ASSERT and lands queryable', async () => {
		const ok = await recordConciergeTurn(db, {
			messageId: 'peer_message:m1',
			fromSession: 'session:s1',
			fromRole: 'pm',
			conciergeSession: 'session:atelier',
			project: projectId,
			intent: 'recommend_agent',
			handledIntent: true,
			llmUsed: false,
			brainConfigured: CLOUD_BRAIN,
			groundingCitations: ['#1', '#2'],
			recommendations: [{ name: 'rounds-mod-developer', score: 0.82 }],
			ask: 'who should build the ROUNDS card mod?',
			reply: 'recommend rounds-mod-developer',
			durationMs: 42,
			outcome: 'replied'
		});
		expect(ok).toBe(true);

		const [rows] = await db.query<[Array<{ type: string; detail: Record<string, unknown> }>]>(
			`SELECT type, detail, at FROM agent_event ORDER BY at ASC;`
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].type).toBe(CONCIERGE_TURN_TYPE);
		expect(rows[0].detail.kind).toBe(CONCIERGE_TURN_KIND);
	});

	it('HAPPY PATH: listConciergeTurns actually RETURNS the row, with the full how/why payload', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:m2',
			fromSession: 'session:s2',
			fromRole: 'pm',
			project: projectId,
			intent: 'recommend_agent',
			handledIntent: true,
			llmUsed: false,
			brainConfigured: CLOUD_BRAIN,
			groundingCitations: ['#1', '#2', '#3'],
			recommendations: [
				{ name: 'atelier-developer', score: 0.91 },
				{ name: 'rounds-mod-developer', score: 0.4 }
			],
			ask: 'who can help with the release pipeline?',
			reply: 'atelier-developer is the closest match',
			durationMs: 120,
			outcome: 'replied'
		});

		const turns = await listConciergeTurns(db, { limit: 10 });
		expect(turns).toHaveLength(1);
		const t = turns[0];
		// WHAT TRIGGERED IT
		expect(t.fromRole).toBe('pm');
		expect(t.fromSession).toBe('session:s2');
		expect(t.project).toBe(projectId);
		// WHAT IT CONSIDERED
		expect(t.intent).toBe('recommend_agent');
		expect(t.ask).toContain('release pipeline');
		expect(t.groundingCount).toBe(3);
		expect(t.citations).toBe('#1, #2, #3');
		// WHAT IT DECIDED
		expect(t.handledIntent).toBe(true);
		expect(t.recommendationCount).toBe(2);
		expect(t.recommendations).toContain('atelier-developer (0.91)');
		expect(t.reply).toContain('atelier-developer');
		// WHAT SERVED IT + HOW IT ENDED
		expect(t.costClass).toBe('no-model-call');
		expect(t.outcome).toBe('replied');
		expect(t.outcomeLabel).toBe(CONCIERGE_TURN_OUTCOME_LABELS.replied);
		expect(t.durationMs).toBe(120);
		expect(t.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('a DETERMINISTIC turn records NO modelUsed, but DOES record the brain merely configured', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:m3',
			intent: 'recommend_agent',
			handledIntent: true,
			llmUsed: false,
			brainConfigured: CLOUD_BRAIN, // a CLOUD brain is configured…
			outcome: 'replied'
		});
		const [t] = await listConciergeTurns(db);
		// …but nothing ran, so no model is claimed and the cost is honestly "none".
		expect(t.llmUsed).toBe(false);
		expect(t.modelUsed).toBeNull();
		expect(t.costClass).toBe('no-model-call');
		// The configured brain is recorded under a DIFFERENT key so it can never be misread as usage.
		expect(t.brainConfigured).toBe('claude/claude-sonnet-4');
	});

	it('a LOCAL turn is recorded as genuinely free — never misrepresented as cloud', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:m4',
			intent: 'open_question',
			handledIntent: true,
			llmUsed: true,
			brainConfigured: LOCAL_BRAIN,
			outcome: 'replied'
		});
		const [t] = await listConciergeTurns(db);
		expect(t.llmUsed).toBe(true);
		expect(t.costClass).toBe('local-free');
		expect(t.costClassLabel).toBe('local model — free');
		expect(t.modelUsed).toBe('ollama/gpt-oss:20b');
	});

	it('a CLOUD turn is recorded as metered, and points at where its money lives', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:m5',
			intent: 'open_question',
			handledIntent: true,
			llmUsed: true,
			brainConfigured: CLOUD_BRAIN,
			outcome: 'replied'
		});
		const [rows] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
			`SELECT detail, at FROM agent_event ORDER BY at ASC;`
		);
		expect(rows[0].detail.costClass).toBe('cloud-metered');
		expect(String(rows[0].detail.spendRecordedOn)).toContain('completion row');
	});

	it('FAILURE VISIBILITY: a failed turn persists a named, screened error + its class', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:m6',
			intent: 'open_question',
			outcome: 'failed',
			error: new TypeError('recall is not a function')
		});
		const [t] = await listConciergeTurns(db);
		expect(t.outcome).toBe('failed');
		expect(t.error).toContain('recall is not a function');
		const [rows] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
			`SELECT detail, at FROM agent_event ORDER BY at ASC;`
		);
		expect(rows[0].detail.errorClass).toBe('TypeError');
		expect(rows[0].detail.ok).toBe(false);
		expect(String(rows[0].detail.summary)).toContain('FAILED');
	});

	it('D-026: a secret in the ask never reaches the stored row', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:m7',
			intent: 'open_question',
			ask: 'here is my key sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC please use it',
			outcome: 'replied'
		});
		const [t] = await listConciergeTurns(db);
		expect(t.ask).not.toContain('sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
	});

	it('SHADOW PATH — nil/empty everything still writes an honest row, never "undefined"', async () => {
		const ok = await recordConciergeTurn(db, { messageId: '', outcome: 'no_requester' });
		expect(ok).toBe(true);
		const [t] = await listConciergeTurns(db);
		expect(t.ask).toBe('(no request body)');
		expect(t.reply).toBe('(no reply produced)');
		expect(t.groundingCount).toBe(0);
		expect(t.recommendationCount).toBe(0);
		expect(t.brainConfigured).toBe('(none configured)');
		expect(JSON.stringify(t)).not.toContain('undefined');
	});

	it('SHADOW PATH — an upstream DB fault is ABSORBED (returns false, never throws)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const ok = await recordConciergeTurn(faultingDb('connection refused'), {
			messageId: 'peer_message:m8',
			outcome: 'replied'
		});
		expect(ok).toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('newest-first ordering holds, and the project filter narrows correctly', async () => {
		const other = await createProject(db, {
			slug: 'otherproj',
			name: 'Other Project',
			root_path: 'F:/code/other-proj'
		});
		await recordConciergeTurn(db, { messageId: 'peer_message:a', project: projectId, intent: 'one', outcome: 'replied' });
		await new Promise((r) => setTimeout(r, 15));
		await recordConciergeTurn(db, { messageId: 'peer_message:b', project: other.id, intent: 'two', outcome: 'replied' });

		const all = await listConciergeTurns(db, { limit: 10 });
		expect(all.map((t) => t.intent)).toEqual(['two', 'one']); // newest first
		const scoped = await listConciergeTurns(db, { projectId, limit: 10 });
		expect(scoped).toHaveLength(1);
		expect(scoped[0].intent).toBe('one');
	});

	it('an EMPTY ledger reads as an honest [] (never a fabricated turn)', async () => {
		expect(await listConciergeTurns(db, { limit: 5 })).toEqual([]);
	});

	it('does NOT swallow a read fault — the loader must be able to show an honest error', async () => {
		await expect(listConciergeTurns(faultingDb('db down'))).rejects.toThrow('db down');
	});
});

// ── THE REGRESSION: the metering contract must be untouched ──────────────────────────────

describe('metering contract — a consult row must NEVER double-count spend', () => {
	it('consult rows carry NO token legs and NO cost_usd', async () => {
		await recordConciergeTurn(db, {
			messageId: 'peer_message:meter1',
			intent: 'open_question',
			llmUsed: true,
			brainConfigured: CLOUD_BRAIN,
			outcome: 'replied'
		});
		const [rows] = await db.query<
			[Array<{ tokens_in: unknown; tokens_out: unknown; cost_usd: unknown }>]
		>(`SELECT tokens_in, tokens_out, cost_usd, at FROM agent_event ORDER BY at ASC;`);
		expect(rows[0].tokens_in ?? null).toBeNull();
		expect(rows[0].tokens_out ?? null).toBeNull();
		expect(rows[0].cost_usd ?? null).toBeNull();
	});

	it('tokensSpentSince is BYTE-IDENTICAL before and after a burst of consult rows', async () => {
		// A real metered completion row (the concierge's actual spend path, wire.ts meterConciergeTurn).
		await writeAgentEvent(db, {
			type: 'completion',
			model: { provider: 'claude', modelId: 'claude-sonnet-4', tier: 'sonnet' },
			tokensIn: 1000,
			tokensOut: 500,
			detail: { ok: true, source: 'concierge', summary: 'concierge Stage-2 open-question turn' }
		});
		const before = await tokensSpentSince(db);
		expect(before).toBe(1500);

		// Twenty thinking rows for the same turns — none of them may move the budget by a single token.
		for (let i = 0; i < 20; i++) {
			await recordConciergeTurn(db, {
				messageId: `peer_message:burst${i}`,
				intent: 'open_question',
				llmUsed: true,
				brainConfigured: CLOUD_BRAIN,
				outcome: 'replied'
			});
		}
		expect(await tokensSpentSince(db)).toBe(before);
	});

	it('the estimated-vs-measured distinction on the completion row survives untouched', async () => {
		// An ESTIMATED metering row (the abort path) alongside consult rows — the honesty fields the
		// cost-governance wave added must remain readable and unshadowed.
		await writeAgentEvent(db, {
			type: 'completion',
			model: { provider: 'ollama', modelId: 'gpt-oss:20b', tier: 'local' },
			tokensIn: 200,
			tokensOut: 1024,
			detail: {
				ok: false,
				source: 'concierge',
				estimated: true,
				estimate_basis: 'worst-case-cap',
				summary: 'concierge Stage-2 open-question turn — TIMED OUT (spend ESTIMATED, not measured)'
			}
		});
		await recordConciergeTurn(db, {
			messageId: 'peer_message:est',
			intent: 'open_question',
			llmUsed: true,
			brainConfigured: LOCAL_BRAIN,
			outcome: 'failed',
			error: new Error('timed out')
		});

		const [completions] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
			`SELECT detail, at FROM agent_event WHERE type = 'completion' ORDER BY at ASC;`
		);
		expect(completions).toHaveLength(1);
		expect(completions[0].detail.estimated).toBe(true);
		expect(completions[0].detail.estimate_basis).toBe('worst-case-cap');
		// And the consult row is a SEPARATE row that claims no spend of its own.
		const turns = await listConciergeTurns(db);
		expect(turns).toHaveLength(1);
		expect(turns[0].outcome).toBe('failed');
	});
});

// ── INTEGRATION: the real turn chokepoint emits exactly one row per turn ─────────────────

describe('handleAtelierMessages — one thinking row per turn (integration)', () => {
	const recallStub = async (): Promise<ConciergeGroundingItem[]> => [
		{ citationId: '#1', body: 'the release pipeline runs on GitHub Actions', score: 0.7 }
	];
	const listStub = (): RecommendAgentInput[] => [
		{
			slug: 'atelier-developer',
			name: 'atelier-developer',
			description: 'builds the Atelier platform: svelte, surrealdb, release pipeline',
			scope: 'project',
			tools: []
		} as unknown as RecommendAgentInput
	];

	/** A REAL session row — sendPeerMessage resolves `from_session` against the live table. */
	async function freshSession(): Promise<string> {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session SET kind = 'task', model = { provider: 'claude', model_id: 'claude-test' } RETURN id;`
		);
		return String(rows[0].id);
	}

	beforeEach(async () => {
		await db.query(`DELETE peer_message; DELETE agent_event;`);
	});

	it('records ONE consult row for a real turn, with the delivered outcome', async () => {
		const req = await sendPeerMessage(db, {
			from_session: await freshSession(),
			to_kind: 'atelier',
			body: 'recommend an agent for the release pipeline'
		});
		expect(req).toBeTruthy();

		const res = await handleAtelierMessages({
			db,
			recall: recallStub,
			listAgents: listStub,
			llmBrain: CLOUD_BRAIN
		});
		expect(res.handled).toBe(1);

		const turns = await listConciergeTurns(db, { limit: 10 });
		expect(turns).toHaveLength(1);
		expect(turns[0].intent).toBe('recommend_agent');
		expect(turns[0].outcome).toBe('replied');
		// The turn was DETERMINISTIC even though a cloud brain was configured — the honesty invariant,
		// proven end-to-end through the real chokepoint (not just the pure helper).
		expect(turns[0].llmUsed).toBe(false);
		expect(turns[0].costClass).toBe('no-model-call');
		expect(turns[0].modelUsed).toBeNull();
		expect(turns[0].brainConfigured).toBe('claude/claude-sonnet-4');
		expect(turns[0].handledIntent).toBe(true);
		expect(turns[0].groundingCount).toBe(1);
	});

	it('records a FAILED turn when the turn throws — previously a console.warn nobody could see', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await sendPeerMessage(db, {
			from_session: await freshSession(),
			to_kind: 'atelier',
			body: 'recommend an agent for something'
		});

		await handleAtelierMessages({
			db,
			recall: recallStub,
			// A DEVELOPER fault inside the turn — the fail-open catch must now leave a durable trace.
			listAgents: () => {
				throw new TypeError('listAgents blew up');
			},
			llmBrain: LOCAL_BRAIN
		});

		const turns = await listConciergeTurns(db, { limit: 10 });
		expect(turns).toHaveLength(1);
		expect(turns[0].outcome).toBe('failed');
		expect(turns[0].error).toContain('listAgents blew up');
		warn.mockRestore();
	});

	it('an EMPTY inbox is an honest no-op — no turn row is fabricated', async () => {
		const res = await handleAtelierMessages({ db, recall: recallStub, listAgents: listStub });
		expect(res.handled).toBe(0);
		expect(await listConciergeTurns(db, { limit: 10 })).toEqual([]);
	});
});
