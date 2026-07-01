import { describe, it, expect, vi } from 'vitest';
import {
	deriveObjectiveSignals,
	parseJudgeJson,
	scoreSession,
	resolveJudgeModel,
	type SessionCorpus,
	type JudgeModel
} from './judge';
import { boundJudgeLimit } from './index';
import type { AgentPool } from '../../config/load';

// MODEL-BENCHMARK-SPEC step 3 VERIFY (pure) — the judge scores from evidence only (F-008):
// structured per-dimension verdicts from a fixture transcript, honest insufficient-data when a
// dimension's corpus is empty, no model call on a cold corpus, and no fabricated score when the
// model output is unparseable. The judge model is MOCKED — no real model call in unit tests.

function corpus(over: Partial<SessionCorpus> = {}): SessionCorpus {
	const transcript = over.transcript ?? [
		{ kind: 'tool_use', content: 'Read src/x.ts' },
		{ kind: 'tool_result', content: 'export const x = 1;' },
		{ kind: 'assistant_text', content: 'x is defined as 1, verified by reading the file.' }
	];
	return {
		sessionId: over.sessionId ?? 'session:abc',
		provider: over.provider ?? 'claude',
		modelId: over.modelId ?? 'claude-sonnet-4-x',
		outcome: over.outcome ?? 'done',
		transcript,
		thinking: over.thinking ?? ['I will read the file before asserting.', 'Confirmed, x = 1.'],
		objective: over.objective ?? deriveObjectiveSignals(transcript)
	};
}

const fullJson = JSON.stringify({
	confidence: { score: 0.8, rationale: 'calibrated: confident and the outcome was done.' },
	reasoning_quality: { score: 0.7, rationale: 'coherent steps toward the goal.' },
	fact_checking: { score: 0.9, rationale: 'read the file before asserting.' },
	thinking_consistency: { score: 0.85, rationale: 'intent stayed consistent.' }
});

describe('deriveObjectiveSignals (pure)', () => {
	it('computes tool-before-claim ratio from ordered turns', () => {
		const sig = deriveObjectiveSignals([
			{ kind: 'tool_use', content: 'Read' },
			{ kind: 'assistant_text', content: 'a claim' },
			{ kind: 'assistant_text', content: 'another claim' }
		]);
		expect(sig.assistantTurns).toBe(2);
		expect(sig.toolUses).toBe(1);
		expect(sig.toolBeforeClaimRatio).toBe(1);
	});

	it('ratio is null with no claim-turns; 0 is a real assert-blind measurement', () => {
		expect(deriveObjectiveSignals([{ kind: 'tool_use', content: 'Read' }]).toolBeforeClaimRatio).toBe(
			null
		);
		const blind = deriveObjectiveSignals([{ kind: 'assistant_text', content: 'blind claim' }]);
		expect(blind.toolUses).toBe(0);
		expect(blind.toolBeforeClaimRatio).toBe(0);
	});
});

describe('parseJudgeJson', () => {
	it('extracts JSON from a fenced/prose-wrapped response', () => {
		expect(parseJudgeJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(parseJudgeJson('here you go: {"a":2} thanks')).toEqual({ a: 2 });
	});
	it('returns null on unparseable output', () => {
		expect(parseJudgeJson('not json at all')).toBeNull();
		expect(parseJudgeJson('')).toBeNull();
	});
});

describe('scoreSession', () => {
	it('produces a scored verdict per dimension from a full corpus', async () => {
		const model: JudgeModel = vi.fn(async () => fullJson);
		const v = await scoreSession(corpus(), model);
		expect(v.dimensions).toHaveLength(4);
		for (const d of v.dimensions) {
			expect(d.status).toBe('scored');
			expect(d.score).not.toBeNull();
			expect(d.score!).toBeGreaterThanOrEqual(0);
			expect(d.score!).toBeLessThanOrEqual(1);
			expect(d.rationale.length).toBeGreaterThan(0);
		}
		// fact_checking carries the objective signal as evidence.
		const fc = v.dimensions.find((d) => d.dimension === 'fact_checking')!;
		expect(fc.evidence).toMatchObject({ toolUses: 1 });
		expect(model).toHaveBeenCalledTimes(1);
	});

	it('marks thinking_consistency insufficient when no thinking corpus (Ollama case)', async () => {
		const model: JudgeModel = vi.fn(async () => fullJson);
		const v = await scoreSession(corpus({ thinking: [], provider: 'ollama' }), model);
		const tc = v.dimensions.find((d) => d.dimension === 'thinking_consistency')!;
		expect(tc.status).toBe('insufficient_data');
		expect(tc.score).toBeNull();
		expect(tc.rationale).toMatch(/insufficient/i);
	});

	it('marks confidence insufficient when the outcome is not terminal', async () => {
		const model: JudgeModel = vi.fn(async () => fullJson);
		const v = await scoreSession(corpus({ outcome: 'running' }), model);
		const c = v.dimensions.find((d) => d.dimension === 'confidence')!;
		expect(c.status).toBe('insufficient_data');
		expect(c.score).toBeNull();
	});

	it('does NOT call the model on a cold corpus (all insufficient, $0)', async () => {
		const model: JudgeModel = vi.fn(async () => fullJson);
		const v = await scoreSession(
			corpus({ transcript: [], thinking: [], outcome: 'unknown' }),
			model
		);
		expect(model).not.toHaveBeenCalled();
		expect(v.dimensions.every((d) => d.status === 'insufficient_data')).toBe(true);
		expect(v.dimensions.every((d) => d.score === null)).toBe(true);
	});

	it('degrades available dimensions to insufficient on unparseable model output (no fabrication)', async () => {
		const model: JudgeModel = vi.fn(async () => 'the model refused to answer');
		const v = await scoreSession(corpus(), model);
		expect(v.dimensions.every((d) => d.status === 'insufficient_data')).toBe(true);
		expect(v.dimensions.every((d) => d.score === null)).toBe(true);
	});

	it('clamps out-of-range scores and rejects non-numeric ones', async () => {
		const model: JudgeModel = vi.fn(async () =>
			JSON.stringify({
				confidence: { score: 1.7, rationale: 'over 1' },
				reasoning_quality: { score: -0.5, rationale: 'under 0' },
				fact_checking: { score: 'abc', rationale: 'not a number' },
				thinking_consistency: { score: 0.5, rationale: 'ok' }
			})
		);
		const v = await scoreSession(corpus(), model);
		const byDim = Object.fromEntries(v.dimensions.map((d) => [d.dimension, d]));
		expect(byDim.confidence.score).toBe(1);
		expect(byDim.reasoning_quality.score).toBe(0);
		expect(byDim.fact_checking.status).toBe('insufficient_data'); // non-numeric ⇒ not scored
		expect(byDim.thinking_consistency.score).toBe(0.5);
	});
});

describe('resolveJudgeModel (cloud only — never the local model under test)', () => {
	const pool = (tiers: Record<string, { provider: string; model: string }>, order?: string[]) =>
		({ tiers, ...(order ? { escalation: { order } } : {}) }) as unknown as AgentPool;

	it('prefers a non-ollama sonnet tier', () => {
		const c = resolveJudgeModel(
			pool({
				local: { provider: 'ollama', model: 'gpt-oss:20b' },
				sonnet: { provider: 'claude', model: 'claude-sonnet-4-x' }
			})
		);
		expect(c).toMatchObject({ provider: 'claude', tier: 'sonnet' });
	});

	it('falls back to the first non-ollama tier in the escalation order', () => {
		const c = resolveJudgeModel(
			pool(
				{
					local: { provider: 'ollama', model: 'gpt-oss:20b' },
					opus: { provider: 'claude', model: 'claude-opus-4-8' }
				},
				['local', 'opus']
			)
		);
		expect(c).toMatchObject({ provider: 'claude', tier: 'opus' });
	});

	it('returns null when the pool has only a local tier', () => {
		expect(resolveJudgeModel(pool({ local: { provider: 'ollama', model: 'gpt-oss:20b' } }))).toBeNull();
	});
});

describe('boundJudgeLimit (the on-demand trigger is bounded)', () => {
	it('defaults, clamps low, and caps high', () => {
		expect(boundJudgeLimit(undefined)).toBe(5);
		expect(boundJudgeLimit(0)).toBe(1);
		expect(boundJudgeLimit(7)).toBe(7);
		expect(boundJudgeLimit(100)).toBe(20);
		expect(boundJudgeLimit(NaN)).toBe(5);
	});
});
