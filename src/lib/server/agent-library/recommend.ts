// AGENT LIBRARY — propose-only specialist recommender.
//
// Given a task (its title/description/objective/acceptance-criteria), score each library agent's
// PUBLISHED metadata (name, description, type/category, declared capabilities, and — when the
// caller supplies it — the when-to-use body) and return a ranked list of specialists with a score
// + a short rationale. PROPOSE-ONLY, exactly like workforce/recommendStaffing: this is a PURE
// function that returns a recommendation object; it spawns nothing, writes nothing, and never
// touches the launch/orchestrator path. The operator (or a gated manual-launch control) decides
// whether to act on it. F-008: a no-signal task yields an empty list (no fabricated confidence).

import type { LibraryAgent } from './library';

/** The task signal a recommendation is scored against. All fields optional; empty ⇒ no signal. */
export interface RecommendTaskInput {
	title?: string | null;
	description?: string | null;
	/** m0034 objective — the "what changes and why". */
	objective?: string | null;
	/** m0034 acceptance criteria — string[] or a single block of text. */
	acceptanceCriteria?: string[] | string | null;
}

/** The agent metadata scored. A {@link LibraryAgent} satisfies this; `whenToUse` is opt-in. */
export interface RecommendAgentInput {
	name: string;
	description?: string | null;
	type?: string | null;
	category?: string | null;
	capabilities?: string[];
	/** The when-to-use / instructions body (from readLibraryAgentContent). Opt-in — bounded cost. */
	whenToUse?: string | null;
}

/** One ranked specialist recommendation (propose-only). */
export interface AgentRecommendation {
	/** The library agent name — the spawn `specialist` value if the operator acts on this. */
	name: string;
	/** Raw weighted overlap score (sum of best per-term field weights). 0 ⇒ excluded from output. */
	score: number;
	/** score / top score across the candidate set (0..1); 1.0 is the strongest match. */
	normalized: number;
	/** Declared capabilities whose tokens overlap the task signal (the strongest evidence). */
	matchedCapabilities: string[];
	/** Distinct task terms that hit this agent (deduped, capped for readability). */
	matchedTerms: string[];
	/** Human-readable why (<~200 chars), citing capabilities + terms. */
	rationale: string;
}

// Per-field weight a matched term contributes. A term counts ONCE, at the MAX weight of any field
// it appears in — so a long when-to-use body never inflates a score by sheer length (we sum over
// DISTINCT task terms, not field occurrences).
const W_CAPABILITY = 3;
const W_NAME = 2.5;
const W_DESCRIPTION = 1.5;
const W_TYPE = 1;
const W_WHENTOUSE = 1;

// Modest stopword set — generic words that carry no specialist signal. Kept small on purpose
// (over-pruning would drop real signal like "test"/"build" which DO discriminate specialists).
const STOPWORDS = new Set([
	'the','a','an','and','or','but','for','to','of','in','on','at','by','with','from','into','out',
	'is','are','was','were','be','been','being','it','its','this','that','these','those','as','if',
	'then','than','so','not','no','can','will','would','should','could','may','might','must','do',
	'does','did','done','has','have','had','we','you','they','our','your','their','i','me','my',
	'when','where','what','which','who','whom','how','why','via','per','use','using','used','need',
	'needs','want','make','made','also','any','all','each','some','more','most','new','one','two'
]);

/** Tokenize free text into a deduped set of meaningful lowercase terms (len ≥ 3, non-stopword). */
function tokenize(text: string | null | undefined): Set<string> {
	const out = new Set<string>();
	if (!text) return out;
	for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
		const t = raw.trim();
		if (t.length < 3) continue;
		if (STOPWORDS.has(t)) continue;
		out.add(t);
	}
	return out;
}

/** Flatten the task input into one deduped term set (its full signal). */
function taskTerms(task: RecommendTaskInput): Set<string> {
	const ac = Array.isArray(task.acceptanceCriteria)
		? task.acceptanceCriteria.join(' ')
		: (task.acceptanceCriteria ?? '');
	const all = [task.title, task.description, task.objective, ac].filter(Boolean).join(' ');
	return tokenize(all);
}

/**
 * Score every agent against the task and return the ranked recommendations (propose-only). Only
 * agents with a positive score appear; ranked by score desc, then name asc (deterministic). A
 * task with no usable signal (or an empty agent list) returns [] — honest, never a fabricated
 * recommendation (F-008). `limit` caps the returned list (default 5; 0 ⇒ unlimited).
 *
 * Pure: no DB, no disk, no spawn. The caller chooses whether to pass each agent's `whenToUse`
 * body (richer signal at a bounded read cost) or score on the cheap metadata alone.
 */
export function recommendAgentsForTask(
	task: RecommendTaskInput,
	agents: RecommendAgentInput[],
	opts: { limit?: number } = {}
): AgentRecommendation[] {
	const terms = taskTerms(task);
	if (terms.size === 0 || agents.length === 0) return [];

	const scored: AgentRecommendation[] = [];
	for (const agent of agents) {
		// Build the best per-term field weight for THIS agent.
		const nameT = tokenize(agent.name);
		const descT = tokenize(agent.description);
		const typeT = new Set<string>([...tokenize(agent.type), ...tokenize(agent.category)]);
		const whenT = tokenize(agent.whenToUse);
		// Capability tokens, plus a map from token → the capability id(s) it came from (for evidence).
		const capTokenToIds = new Map<string, Set<string>>();
		for (const cap of agent.capabilities ?? []) {
			for (const tok of tokenize(cap)) {
				if (!capTokenToIds.has(tok)) capTokenToIds.set(tok, new Set());
				capTokenToIds.get(tok)!.add(cap);
			}
		}

		let score = 0;
		const matchedTerms: string[] = [];
		const matchedCaps = new Set<string>();
		for (const term of terms) {
			let best = 0;
			if (capTokenToIds.has(term)) {
				best = Math.max(best, W_CAPABILITY);
				for (const id of capTokenToIds.get(term)!) matchedCaps.add(id);
			}
			if (nameT.has(term)) best = Math.max(best, W_NAME);
			if (descT.has(term)) best = Math.max(best, W_DESCRIPTION);
			if (typeT.has(term)) best = Math.max(best, W_TYPE);
			if (whenT.has(term)) best = Math.max(best, W_WHENTOUSE);
			if (best > 0) {
				score += best;
				matchedTerms.push(term);
			}
		}

		if (score <= 0) continue;
		matchedTerms.sort();
		const matchedCapabilities = [...matchedCaps].sort();
		const capPart = matchedCapabilities.length
			? `capabilities [${matchedCapabilities.join(', ')}]`
			: '';
		const termsShown = matchedTerms.slice(0, 6);
		const termPart = termsShown.length
			? `terms: ${termsShown.join(', ')}${matchedTerms.length > termsShown.length ? '…' : ''}`
			: '';
		const rationale =
			['Matches on', [capPart, termPart].filter(Boolean).join(' and ')].join(' ').trim() + '.';

		scored.push({
			name: agent.name,
			score: Math.round(score * 100) / 100,
			normalized: 0, // filled after we know the top score
			matchedCapabilities,
			matchedTerms,
			rationale
		});
	}

	scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	const top = scored.length ? scored[0].score : 0;
	for (const r of scored) r.normalized = top > 0 ? Math.round((r.score / top) * 100) / 100 : 0;

	const limit = opts.limit ?? 5;
	return limit > 0 ? scored.slice(0, limit) : scored;
}

/** Adapt a {@link LibraryAgent} (+ optional when-to-use body) into a {@link RecommendAgentInput}. */
export function asRecommendAgentInput(
	a: LibraryAgent,
	whenToUse?: string | null
): RecommendAgentInput {
	return {
		name: a.name,
		description: a.description,
		type: a.type,
		category: a.category,
		capabilities: a.capabilities,
		whenToUse: whenToUse ?? null
	};
}
