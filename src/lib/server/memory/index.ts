// TASK 2.5 — memory service facade (MEMORY-SPEC; D-026/D-027/D-028/D-029/D-030/D-031).
//
// The single public surface the rest of the system codes against. It wires the pieces:
//   • store / extractAndStore  (§3 ADD-only extraction, screen-before-embed)   → store.ts
//   • recall                   (§4 staged retrieval, WMR, novelty gate, fenced) → recall.ts
//   • the two-tier loop        (§2 fast fork enqueue, §5 slow consolidator)     → loop.ts
//   • embeddings + cache       (§7 Ollama 1024-dim, L1+L2)                       → embed.ts
//   • screen + fence           (§3.1b secret screen, §10 context fence)  → screen.ts/fence.ts
//
// THE CROSS-CUTTING INVARIANT (§10, D-026): EVERY injection path that puts memory/learning
// content into the model's context goes through `assembleInjection()` here, which FENCES
// each source uniformly — recall, Tier-0 directives, the user-model, learned skills, and
// inbound channel/peer bodies. No path is spliced where its content can act as an
// instruction. Tier-0 membership is operator/curator-set; it does NOT exempt content from
// the fence. This facade is the ONE place that guarantees the invariant holds.

import type { Db } from '../db/client';
import { StringRecordId } from 'surrealdb';
import { assertRecordId } from '../db/validate';
import type { Embedder } from './embed';
import { CachedEmbedder } from './embed';
import { fence, assembleContext, type FencedItem, type InjectionSource } from './fence';
import { gateCandidate } from './screen';
import { recall, recordOutcomes, type RecallOptions, type RecallResult, type OutcomeInput } from './recall';
import { recordTurnOutcomes, type RecordTurnOutcomesInput } from './outcomes';
import { extractAndStore, storeMemories, type StoreOptions, type MemoryCandidate, type StoredMemory, type ExtractFn, type ExtractInput } from './store';

export { screen, captureGate, gateCandidate, type ScreenStatus, type ScreenResult } from './screen';
export { fence, fenceAll, assembleContext, StreamScrubber, scrubComplete, FENCE_OPEN, FENCE_CLOSE, type InjectionSource, type FencedItem } from './fence';
export { OllamaEmbedder, CachedEmbedder, FakeEmbedder, EmbeddingError, EMBEDDING_DIM, cacheKey, distanceToSimilarity, type Embedder, type EmbedRole } from './embed';
export { recall, recordOutcomes, parseCitations, WMR_WEIGHTS, NOVELTY_COSINE_CUT, type RecallItem, type RecallResult } from './recall';
export { recordTurnOutcomes, summarizeTurnTools, type RecordTurnOutcomesInput, type TurnToolOutcome } from './outcomes';
export { storeMemory, storeMemories, extractAndStore, buildExtraction, type MemoryCandidate, type StoredMemory, type ExtractFn, type ExtractInput } from './store';
export { dueReview, bumpCounters, enqueueReview, consolidate, DEFAULT_CADENCE, type ReviewKind, type ReviewCadence } from './loop';
export {
	buildBriefing,
	estimateTokens,
	bandForScore,
	BRIEFING_INJECTION_SOURCES,
	BAND_THRESHOLDS,
	type Briefing,
	type BriefingItem,
	type BriefingOptions,
	type SalienceBand
} from './briefing';
export {
	listMemories,
	listGraph,
	type MemoryRow,
	type GraphNodeRow,
	type GraphEdgeRow,
	type MemoryGraph
} from './explorer';
export {
	parseAutoMemoryFile,
	parseMemoryLinks,
	entityIdForFile,
	importAutoMemory,
	importAutoMemoryFromDir,
	traverse,
	type AutoMemoryFile,
	type ParsedAutoMemory,
	type ImportAutoMemoryOptions,
	type ImportAutoMemoryResult,
	type GraphNode,
	type TraverseOptions
} from './bridge';

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

// ── Injection assembly — the §10 fence invariant chokepoint ────────────────────────

/** One raw (already-screened) body destined for a fenced injection slot. */
export interface InjectionPart {
	source: InjectionSource;
	body: string;
	citationId?: string;
}

/**
 * Assemble the full injectable context for a turn from any mix of sources, FENCING each
 * uniformly (§10). This is the ONE chokepoint — recall items, Tier-0 directives, the
 * user-model summary, learned skills, and channel bodies ALL pass through here, so every
 * injection path provably emits fenced content. Order follows §8 (summary→user→self) with
 * Tier-0 leading; the live task is spliced SEPARATELY by the runtime (never folded in).
 */
export function assembleInjection(parts: InjectionPart[]): { items: FencedItem[]; text: string } {
	const items = parts.map((p) => fence({ source: p.source, body: p.body, citationId: p.citationId }));
	return { items, text: assembleContext(items) };
}

// ── Tier-0 directives (§6.8) — operator/curator-set membership, STILL fenced ───────

/**
 * Load the small always-loaded Tier-0 directive set (tier=0, no KNN — §6.8). Membership
 * is operator/curator-set (we read tier=0 rows; recalled/injected text can NEVER
 * self-grant Tier-0). Returns FENCED items — Tier-0 content is fenced like any other
 * injected content (§10): membership controls WHAT is loaded, not whether it is fenced.
 */
export async function loadTier0(db: Db, project?: string): Promise<FencedItem[]> {
	const projFilter = project ? `AND project = $project` : '';
	const [rows] = await db.query<[Array<{ id: unknown; content: string }>]>(
		`SELECT id, content, importance FROM memory
		  WHERE tier = 0
		    AND (status = "active" OR status IS NONE)
		    AND screen_status != "quarantined"
		    ${projFilter}
		  ORDER BY importance DESC;`,
		project ? { project: link(project) } : {}
	);
	return rows.map((r) => fence({ source: 'tier0', body: r.content, citationId: `t0:${String(r.id)}` }));
}

// ── Learned-skill injection (§5.4) — screened at synthesis, fenced at injection ─────

export interface SkillRow {
	id: string;
	description: string;
	steps: string[];
}

/**
 * Fence a graduated/learned skill for injection (§5.4b). A skill carries NO more trust
 * than recalled memory (D-026): it is fenced IDENTICALLY to recalled memory ("reference,
 * not instructions"). The skill's body was already screened at synthesis time (§5.4a /
 * graduateSkill); this is the injection-time fence.
 */
export function fenceSkill(skill: SkillRow): FencedItem {
	const body = `${skill.description}\nSteps:\n${skill.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
	return fence({ source: 'learned-skill', body, citationId: `skill:${skill.id}` });
}

/**
 * §5.4a synthesis-time screen for a graduating skill. The description + each step pass the
 * DO-NOT-CAPTURE + secret/PII gate BEFORE the skill graduates — a chain graduated from a
 * POISONED causal_chain would otherwise carry injected instructions forward. Returns the
 * screened skill body, or null if any part is quarantined (the chain does not graduate raw).
 */
export function screenSkillForGraduation(skill: { description: string; steps: string[] }): SkillRow | null {
	const dgate = gateCandidate(skill.description);
	if (!dgate.capture || dgate.screen!.status === 'quarantined') return null;
	const steps: string[] = [];
	for (const step of skill.steps) {
		const sgate = gateCandidate(step);
		if (!sgate.capture || sgate.screen!.status === 'quarantined') return null;
		steps.push(sgate.screen!.text);
	}
	return { id: '', description: dgate.screen!.text, steps };
}

// ── Inbound channel/peer body (§10 / D-035) — screened then fenced as DATA ──────────

/**
 * Screen + fence an inbound channel/peer_message body (§10, D-035). Agent-origin bodies
 * are secret/PII-screened BEFORE storage and fenced as DATA on the SAME path as recalled
 * memory. ONLY an operator-origin message (authenticated upstream by the D-025 token) may
 * steer — for origin='operator' we still screen but do not fence (it is a command, not
 * memory). Returns null if the body is quarantined.
 */
export function ingestChannelBody(origin: string, body: string): { fenced?: FencedItem; screenedText: string } | null {
	const gate = gateCandidate(body);
	if (!gate.capture || gate.screen!.status === 'quarantined') return null;
	const screenedText = gate.screen!.text;
	if (origin === 'operator') {
		// Operator-origin: screened (no secret laundering) but NOT fenced — it may steer.
		return { screenedText };
	}
	// Any non-operator origin is fenced as DATA on the same path as recalled memory.
	return { fenced: fence({ source: 'channel', body: screenedText }), screenedText };
}

// ── The service object ─────────────────────────────────────────────────────────────

export interface MemoryServiceOptions {
	db: Db;
	embedder: Embedder;
	/** Wrap the embedder in the two-tier cache (§7.1). Default true. */
	cache?: boolean;
}

/**
 * The wired memory service. Construct once at startup with the runtime Db + an Embedder
 * (OllamaEmbedder in production; FakeEmbedder in tests). All methods route through the
 * screen-before-embed (write) and fence-on-injection (read) invariants.
 */
export class MemoryService {
	readonly db: Db;
	readonly embedder: Embedder;
	private readonly storeOpts: StoreOptions;

	constructor(opts: MemoryServiceOptions) {
		this.db = opts.db;
		this.embedder = opts.cache === false ? opts.embedder : new CachedEmbedder({ embedder: opts.embedder, db: opts.db });
		this.storeOpts = { db: this.db, embedder: this.embedder };
	}

	/** ADD-only store of a candidate set (§3.4 phased batch add). */
	store(candidates: MemoryCandidate[]): Promise<StoredMemory[]> {
		return storeMemories(this.storeOpts, candidates);
	}

	/** Extract (ONE LLM call) then store (§3). `extract` is injected (mock in tests). */
	extractAndStore(extract: ExtractFn, input: ExtractInput): Promise<StoredMemory[]> {
		return extractAndStore({ ...this.storeOpts, extract }, input);
	}

	/** Staged recall (§4) — ranked, novelty-gated, FENCED items. */
	recall(query: string, opts?: Omit<RecallOptions, 'db' | 'embedder'>): Promise<RecallResult> {
		return recall({ db: this.db, embedder: this.embedder, ...opts }, query);
	}

	/** Record retrieval outcomes for the ranker (§4.5, D-030 — ranking input only). */
	recordOutcomes(input: OutcomeInput): Promise<string[]> {
		return recordOutcomes(this.db, input);
	}

	/**
	 * Record turn outcomes (2.16): link each injected citation to the AGGREGATED success/
	 * failure of the turn's subsequent tool calls (folds a runtime event stream). Ranker
	 * input ONLY (D-030) — never drives pruning. The richer successor to recordOutcomes.
	 */
	recordTurnOutcomes(input: RecordTurnOutcomesInput): Promise<string[]> {
		return recordTurnOutcomes(this.db, input);
	}

	/** Load the fenced Tier-0 directive set (§6.8). */
	loadTier0(project?: string): Promise<FencedItem[]> {
		return loadTier0(this.db, project);
	}

	/** Assemble a full fenced injection block from any mix of sources (§10 chokepoint). */
	assembleInjection(parts: InjectionPart[]): { items: FencedItem[]; text: string } {
		return assembleInjection(parts);
	}
}
