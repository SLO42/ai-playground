// MODEL-BENCHMARK-SPEC step 3 (class B — Judged) — the LLM-judge scoring core.
//
// An LLM judge scores a driven session on the operator's rubric (confidence, reasoning
// quality, fact-checking, thinking consistency) and emits ONE structured verdict per
// dimension. This module is the PURE, DB-free scoring logic: given a gathered `SessionCorpus`
// (already D-026-screened at source) and an injected `JudgeModel` (a cloud model — NEVER the
// local model under test), it returns per-dimension verdicts. gather.ts supplies the corpus;
// store.ts persists the verdicts; index.ts wires the bounded on-demand batch.
//
// HONESTY (F-008): no score without evidence. A dimension whose corpus is empty (e.g. Ollama
// emits NO thinking → thinking_consistency) is marked `insufficient_data` with score=null and
// an honest reason — LOCALLY, so even if the model hallucinates a number we never store it.
// If the model output is unparseable, every available dimension degrades to insufficient
// (never a fabricated fallback score).
//
// COST: the judge is ONE LLM call per session; the caller (index.ts runJudgeBatch) bounds the
// batch. When NO dimension is scorable (empty session) scoreSession returns early WITHOUT
// calling the model — a cold corpus costs $0.

import type { AgentPool } from '../../config/load';
import { screen } from '../../memory/screen';
import {
	ClaudeProvider,
	collectText,
	type ChatMessage,
	type StreamChunk
} from '../../providers';

/** The rubric axes (the operator-specified dimensions). Order is the display order. */
export const BENCHMARK_DIMENSIONS = [
	'confidence',
	'reasoning_quality',
	'fact_checking',
	'thinking_consistency'
] as const;
export type BenchmarkDimension = (typeof BENCHMARK_DIMENSIONS)[number];

/** A verdict is either a real SCORED figure, or an honest INSUFFICIENT_DATA (F-008). */
export type VerdictStatus = 'scored' | 'insufficient_data';

/** The objective (event-derived) fact-checking sub-signal — the "tool-before-claim" proxy. */
export interface ObjectiveSignals {
	/** Count of assistant text/result turns (the "claims"). */
	assistantTurns: number;
	/** Count of tool_use turns (Read/Grep/… — verification actions). */
	toolUses: number;
	/**
	 * Fraction of assistant claim-turns that occurred AFTER the session's first tool use
	 * (a coarse "did it verify before asserting" proxy). null when there are no claim-turns.
	 * 0 with toolUses=0 is a REAL measurement (assert-blind), not insufficient data.
	 */
	toolBeforeClaimRatio: number | null;
}

/** The screened corpus fed to the judge for one session (every field already D-026-screened). */
export interface SessionCorpus {
	sessionId: string;
	/** The SESSION-UNDER-TEST provider (e.g. 'ollama' local, 'claude' cloud) — the compare axis. */
	provider: string;
	/** The session-under-test model id. */
	modelId: string;
	/** Terminal outcome for confidence-calibration; 'running'/'unknown' ⇒ not yet calibratable. */
	outcome: 'done' | 'failed' | 'cancelled' | 'running' | 'unknown';
	/** Ordered transcript turns (assistant_text / tool_use / tool_result / result / …). */
	transcript: { kind: string; content: string }[];
	/** Thinking turns (message kind='thinking' or thinking_capture). Empty ⇒ no thinking corpus. */
	thinking: string[];
	/** Objective tool-before-claim signal derived from the transcript ordering. */
	objective: ObjectiveSignals;
}

/** One dimension's verdict. */
export interface DimensionVerdict {
	dimension: BenchmarkDimension;
	status: VerdictStatus;
	/** 0..1 when scored; null when insufficient (F-008 — never a fake 0). */
	score: number | null;
	/** One-line evidence-bearing rationale (screened); honest reason when insufficient. */
	rationale: string;
	/** Structured evidence backing the verdict (objective signals / outcome). */
	evidence?: Record<string, unknown>;
}

/** The full per-session verdict (one entry per rubric dimension). */
export interface SessionVerdict {
	sessionId: string;
	provider: string;
	modelId: string;
	dimensions: DimensionVerdict[];
}

/**
 * The injected judge model: takes a system+user prompt, returns raw completion text. Unit
 * tests supply a deterministic stub (no network); prod wires a cloud ClaudeProvider.
 */
export type JudgeModel = (prompt: { system: string; user: string }) => Promise<string>;

// Bounds that keep the judge prompt (and thus cost) finite regardless of session size.
const MAX_TRANSCRIPT_TURNS = 60;
const MAX_TURN_CHARS = 1600;
const MAX_THINKING_TURNS = 30;

const SYSTEM_PROMPT =
	'You are a strict evaluation judge scoring one AI coding session against a rubric. ' +
	'Score ONLY from the evidence provided. Output STRICT JSON, no prose outside it. ' +
	'For each requested dimension return {"score": <number 0..1>, "rationale": "<one line citing evidence>"}. ' +
	'Score 0..1 where higher is better. If the evidence does not support a dimension, set score to null and say why. ' +
	'NEVER invent tool calls, outcomes, or thinking that are not in the evidence.';

const DIMENSION_GUIDE: Record<BenchmarkDimension, string> = {
	confidence:
		'confidence — was expressed confidence CALIBRATED against the actual outcome? Penalize over-confidence on a failed outcome and under-confidence on a done one.',
	reasoning_quality:
		'reasoning_quality — coherence and depth: do the steps follow logically and build toward the goal?',
	fact_checking:
		'fact_checking — did it VERIFY claims with tools (Read/Grep/tool) before asserting, or assert blind? Weigh the objective tool-before-claim signal AND the transcript.',
	thinking_consistency:
		'thinking_consistency — does stated intent stay CONSISTENT across the thinking turns, or drift/contradict?'
};

/** Human reason attached to an insufficient verdict (honest, evidence-grounded). */
const INSUFFICIENT_REASON: Record<BenchmarkDimension, string> = {
	confidence:
		'insufficient data — no terminal outcome + expressed assertion to calibrate confidence against.',
	reasoning_quality: 'insufficient data — no assistant/thinking turns to assess reasoning.',
	fact_checking: 'insufficient data — no assistant claim-turns to check for verification.',
	thinking_consistency:
		'insufficient data — no thinking captured for this session (provider emitted none / capture off).'
};

/** Derive the objective tool-before-claim signal from an ordered transcript. Pure. */
export function deriveObjectiveSignals(
	transcript: { kind: string; content: string }[]
): ObjectiveSignals {
	let firstToolIdx = -1;
	let assistantTurns = 0;
	let toolUses = 0;
	transcript.forEach((t, i) => {
		if (t.kind === 'tool_use') {
			toolUses++;
			if (firstToolIdx === -1) firstToolIdx = i;
		} else if (t.kind === 'assistant_text' || t.kind === 'result') {
			assistantTurns++;
		}
	});
	let ratio: number | null = null;
	if (assistantTurns > 0) {
		const claimsAfterTool = transcript.filter(
			(t, i) =>
				(t.kind === 'assistant_text' || t.kind === 'result') &&
				firstToolIdx !== -1 &&
				i > firstToolIdx
		).length;
		ratio = round2(claimsAfterTool / assistantTurns);
	}
	return { assistantTurns, toolUses, toolBeforeClaimRatio: ratio };
}

/** Which dimensions have enough corpus to be scored at all (the honesty gate). */
function availability(corpus: SessionCorpus): Record<BenchmarkDimension, boolean> {
	const hasTranscript = corpus.transcript.length > 0;
	const hasThinking = corpus.thinking.length > 0;
	const terminal = corpus.outcome === 'done' || corpus.outcome === 'failed';
	const hasClaims = corpus.objective.assistantTurns > 0;
	return {
		confidence: terminal && hasClaims,
		reasoning_quality: hasTranscript || hasThinking,
		fact_checking: hasClaims,
		thinking_consistency: hasThinking
	};
}

/** Assemble the (screened) evidence block the judge reads. */
function buildUserPrompt(corpus: SessionCorpus, dims: BenchmarkDimension[]): string {
	const turns = corpus.transcript
		.slice(-MAX_TRANSCRIPT_TURNS)
		.map((t) => `[${t.kind}] ${clip(t.content, MAX_TURN_CHARS)}`)
		.join('\n');
	const thinking = corpus.thinking
		.slice(-MAX_THINKING_TURNS)
		.map((t, i) => `#${i + 1} ${clip(t, MAX_TURN_CHARS)}`)
		.join('\n');
	const obj = corpus.objective;
	const raw =
		`SESSION provider=${corpus.provider} model=${corpus.modelId} outcome=${corpus.outcome}\n\n` +
		`OBJECTIVE SIGNALS: assistantTurns=${obj.assistantTurns} toolUses=${obj.toolUses} ` +
		`toolBeforeClaimRatio=${obj.toolBeforeClaimRatio ?? 'n/a'}\n\n` +
		`TRANSCRIPT (oldest→newest, truncated):\n${turns || '(none)'}\n\n` +
		`THINKING TURNS:\n${thinking || '(none)'}\n\n` +
		`SCORE THESE DIMENSIONS: ${dims.map((d) => DIMENSION_GUIDE[d]).join('\n')}\n\n` +
		`Return JSON: { ${dims.map((d) => `"${d}": {"score":0..1|null,"rationale":"…"}`).join(', ')} }`;
	// Belt-and-suspenders D-026: the corpus is already screened at source; re-screen the
	// assembled block so any newly-composed span is caught before it leaves the process.
	return screen(raw).text;
}

/** Parse the judge's JSON, tolerating a code-fence / surrounding prose. null on any failure. */
export function parseJudgeJson(raw: string): Record<string, unknown> | null {
	if (typeof raw !== 'string') return null;
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		const obj = JSON.parse(raw.slice(start, end + 1));
		return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Score one session on the full rubric. Dimensions with no corpus are marked insufficient
 * LOCALLY (never scored by the model). When NO dimension is scorable the model is NOT called
 * (cold corpus costs nothing). Model output that fails to parse degrades available dimensions
 * to insufficient — never a fabricated fallback score.
 */
export async function scoreSession(
	corpus: SessionCorpus,
	model: JudgeModel
): Promise<SessionVerdict> {
	const avail = availability(corpus);
	const toScore = BENCHMARK_DIMENSIONS.filter((d) => avail[d]);

	const evidenceFor = (d: BenchmarkDimension): Record<string, unknown> | undefined => {
		if (d === 'fact_checking') return { ...corpus.objective };
		if (d === 'confidence') return { outcome: corpus.outcome };
		return undefined;
	};

	// No scorable dimension → all honest-insufficient, no model call.
	if (toScore.length === 0) {
		return {
			sessionId: corpus.sessionId,
			provider: corpus.provider,
			modelId: corpus.modelId,
			dimensions: BENCHMARK_DIMENSIONS.map((d) => insufficient(d, evidenceFor(d)))
		};
	}

	let parsed: Record<string, unknown> | null = null;
	try {
		const raw = await model({ system: SYSTEM_PROMPT, user: buildUserPrompt(corpus, toScore) });
		parsed = parseJudgeJson(raw);
	} catch {
		parsed = null; // transport/model failure ⇒ available dims degrade to insufficient (honest)
	}

	const dimensions = BENCHMARK_DIMENSIONS.map((d): DimensionVerdict => {
		if (!avail[d]) return insufficient(d, evidenceFor(d));
		const cell = parsed?.[d] as { score?: unknown; rationale?: unknown } | undefined;
		const score = normalizeScore(cell?.score);
		if (!parsed || cell == null || score === null) {
			return {
				dimension: d,
				status: 'insufficient_data',
				score: null,
				rationale: parsed
					? 'insufficient data — judge returned no valid score for this dimension.'
					: 'insufficient data — judge output was unparseable.',
				...(evidenceFor(d) ? { evidence: evidenceFor(d) } : {})
			};
		}
		const rationale = screen(String(cell.rationale ?? '').slice(0, 400)).text || '(no rationale)';
		return {
			dimension: d,
			status: 'scored',
			score,
			rationale,
			...(evidenceFor(d) ? { evidence: evidenceFor(d) } : {})
		};
	});

	return {
		sessionId: corpus.sessionId,
		provider: corpus.provider,
		modelId: corpus.modelId,
		dimensions
	};
}

function insufficient(
	d: BenchmarkDimension,
	evidence?: Record<string, unknown>
): DimensionVerdict {
	return {
		dimension: d,
		status: 'insufficient_data',
		score: null,
		rationale: INSUFFICIENT_REASON[d],
		...(evidence ? { evidence } : {})
	};
}

/** Clamp/validate a model score to [0,1]; null for anything non-numeric or out of range→clamped. */
function normalizeScore(v: unknown): number | null {
	if (typeof v !== 'number' || Number.isNaN(v)) return null;
	return round2(Math.max(0, Math.min(1, v)));
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

function clip(s: string, max: number): string {
	if (typeof s !== 'string') return '';
	return s.length <= max ? s : s.slice(0, max) + '…';
}

// ── Cloud-model resolution + prod wiring ─────────────────────────────────────────

/** The resolved judge model identity (a CLOUD tier — never the local model under test). */
export interface JudgeModelChoice {
	provider: string;
	modelId: string;
	tier: string;
}

/**
 * Resolve the default judge model from the LIVE pool (mirrors the boot.ts 'cloud' branch,
 * never hardcoded): prefer `sonnet` (a balanced always-on judge), else the first non-ollama
 * tier in the escalation order, else any non-ollama tier. Returns null (honest, F-008) when
 * the pool has no cloud tier — the judge then refuses rather than judging with the local model.
 */
export function resolveJudgeModel(pool: AgentPool): JudgeModelChoice | null {
	const nonOllama = (name: string): boolean =>
		!!pool.tiers[name] && pool.tiers[name].provider !== 'ollama';
	let tierName: string | undefined;
	if (nonOllama('sonnet')) tierName = 'sonnet';
	else tierName = pool.escalation?.order?.find(nonOllama);
	if (!tierName) tierName = Object.keys(pool.tiers).find(nonOllama);
	if (!tierName) return null;
	const t = pool.tiers[tierName];
	return { provider: t.provider, modelId: t.model, tier: tierName };
}

export interface ClaudeJudgeOptions {
	endpoint: string;
	model: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
}

/**
 * Prod judge: a single non-streaming-collected completion from a cloud ClaudeProvider. The
 * unit tests never touch this — they inject a deterministic JudgeModel stub.
 */
export function makeClaudeJudge(opts: ClaudeJudgeOptions): JudgeModel {
	const provider = new ClaudeProvider({
		endpoint: opts.endpoint,
		model: opts.model,
		...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
		...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {})
	});
	return async ({ system, user }) => {
		const messages: ChatMessage[] = [
			{ role: 'system', content: system },
			{ role: 'user', content: user }
		];
		const chunks: StreamChunk[] = [];
		for await (const c of provider.stream(messages)) chunks.push(c);
		return collectText(chunks);
	};
}
