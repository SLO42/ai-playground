// CONCIERGE (D-040 Stage-1) — unit + integration verification.
//
// Covers the three properties the operator asked for:
//   (1) resolveAtelier returns the LIVE session when atelier_self is up (via loadFleetSnapshot).
//   (2) the concierge turn GROUNDS + CITES and replies ADVISORY (non-steering).
//   (3) the TRIGGER path SPAWNS the atelier_self session on a pending atelier message, answers,
//       replies over the bus, marks the message delivered, and tears the session down ($0 idle).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { sendPeerMessage, loadFleetSnapshot } from '../peer/repo';
import { resolveAddress, ATELIER_PROJECT_KEY, ATELIER_SELF_PM } from '../peer/resolve';
import type { RecommendAgentInput } from '../agent-library/recommend';
import {
	runConciergeTurn,
	isRecommendRequest,
	classifyAtelierIntent,
	resolveConciergeProvider,
	ensureAtelierSession,
	handleAtelierMessages,
	fetchPendingAtelierInbox,
	gateSkillCandidates,
	parseSkillsSearchResponse,
	TRUSTED_SKILL_OWNERS,
	type ConciergeGroundingItem,
	type ConciergeRecallFn,
	type ConciergeListAgentsFn,
	type ConciergeLlmFn,
	type ConciergeSkillSearchFn,
	type SkillSearchResult
} from './concierge';
import type { AgentPool } from '../config/load';

// ── deterministic stubs (pure turn tests) ────────────────────────────────────────

const GROUNDING: ConciergeGroundingItem[] = [
	{ citationId: '[#1]', body: 'Prior SvelteKit work used Svelte 5 runes and Tailwind v4.', score: 0.82 },
	{ citationId: '[#2]', body: 'The memory scene renders with d3-force.', score: 0.51 }
];
const recallStub: ConciergeRecallFn = async () => GROUNDING;
const recallEmpty: ConciergeRecallFn = async () => [];

const LIB: RecommendAgentInput[] = [
	{
		name: 'atelier-developer',
		description: 'SvelteKit Svelte 5 Tailwind SurrealDB dashboard specialist',
		type: 'developer',
		capabilities: ['svelte', 'sveltekit', 'tailwind', 'surrealdb', 'dashboard', 'ui']
	},
	{
		name: 'rounds-mod-developer',
		description: 'C# BepInEx Unity ROUNDS mod specialist',
		type: 'developer',
		capabilities: ['csharp', 'bepinex', 'unity', 'harmony']
	}
];
const listStub: ConciergeListAgentsFn = () => LIB;
const listEmpty: ConciergeListAgentsFn = () => [];

// ── (a) the concierge TURN — grounds + cites + advisory, non-steering (pure) ──────

describe('runConciergeTurn — grounds, cites, recommends, advisory', () => {
	it('cites grounding memory AND recommends the best-matching specialist', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub },
			'Please recommend an agent to build a SvelteKit dashboard UI'
		);
		expect(turn.handledIntent).toBe(true);
		// Grounding cited (S0 — traceable to real rows).
		expect(turn.groundingCitations).toEqual(['[#1]', '[#2]']);
		expect(turn.replyText).toContain('[#1]');
		expect(turn.replyText).toContain('Grounded on 2 memory item(s)');
		// Recommendation is the strongest overlap (atelier-developer, not the C#/ROUNDS agent).
		expect(turn.recommendations[0].name).toBe('atelier-developer');
		expect(turn.replyText).toContain('atelier-developer');
		// ADVISORY + NON-STEERING framing present; no command/spawn directive.
		expect(turn.replyText).toContain('[Atelier Concierge — advisory, non-steering]');
		expect(turn.replyText).toContain('The concierge advises; it never commands or spawns an agent.');
		expect(turn.replyText.toLowerCase()).not.toMatch(/\byou must\b/);
	});

	it('honest empty states — no grounding + no matching specialist (F-008)', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallEmpty, listAgents: listEmpty },
			'recommend an agent for xylophone quantum flux'
		);
		expect(turn.handledIntent).toBe(true);
		expect(turn.groundingCitations).toEqual([]);
		expect(turn.recommendations).toEqual([]);
		expect(turn.replyText).toContain('no relevant memory available');
		expect(turn.replyText).toContain('No matching specialist in the library');
	});

	it('an open question with NO provider configured degrades to an honest unavailable note (F-008)', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub }, // no `llm` injected
			'what is the current sprint status?'
		);
		expect(turn.intent).toBe('open_question');
		expect(turn.handledIntent).toBe(false);
		expect(turn.llmUsed).toBe(false);
		expect(turn.recommendations).toEqual([]);
		expect(turn.replyText).toContain('no model provider is configured');
		expect(turn.replyText).toContain('did not fabricate an answer');
		// Still non-steering + still grounded (it read the brain).
		expect(turn.replyText).toContain('advisory, non-steering');
		expect(turn.groundingCitations).toEqual(['[#1]', '[#2]']);
	});

	it('a recall fault degrades to honest empty grounding, never a throw', async () => {
		const turn = await runConciergeTurn(
			{ recall: async () => { throw new Error('embedder offline'); }, listAgents: listStub },
			'recommend an agent for a svelte ui'
		);
		expect(turn.groundingCitations).toEqual([]);
		expect(turn.replyText).toContain('no relevant memory available');
		// Recommendation still produced (recommend does not depend on grounding).
		expect(turn.recommendations[0].name).toBe('atelier-developer');
	});

	it('isRecommendRequest detects the Stage-1 intent', () => {
		expect(isRecommendRequest('please RECOMMEND an Agent for X')).toBe(true);
		expect(isRecommendRequest('recommend a skill')).toBe(false);
		expect(isRecommendRequest('status update')).toBe(false);
	});
});

// ── (a2) Stage-2 intent split + the provider-aware LLM turn (pure) ─────────────────

describe('classifyAtelierIntent — explicit, ordered split', () => {
	it('recommend_agent wins over a skill/hire mention in the same message', () => {
		expect(classifyAtelierIntent('recommend an agent to build a skill')).toBe('recommend_agent');
		expect(classifyAtelierIntent('recommend an agent to hire for me')).toBe('recommend_agent');
	});
	it('routes skill / hire / open-question intents', () => {
		expect(classifyAtelierIntent('can you find a skill for X?')).toBe('skill_request');
		expect(classifyAtelierIntent('please hire a backend engineer')).toBe('hire_request');
		expect(classifyAtelierIntent('we should recruit more testers')).toBe('hire_request');
		expect(classifyAtelierIntent('how does the memory scene render?')).toBe('open_question');
	});
});

describe('runConciergeTurn — Stage-2 open-question LLM turn (stub, no real model)', () => {
	function makeLlmStub(answer: string) {
		const calls: { system: string; user: string }[] = [];
		const fn: ConciergeLlmFn = async (p) => {
			calls.push(p);
			return answer;
		};
		return { fn, calls };
	}
	const mustNotCall: ConciergeLlmFn = async () => {
		throw new Error('LLM must not be called for this intent');
	};

	it('grounds (S0 injected into the prompt), answers on the provider, wraps ADVISORY (non-steering)', async () => {
		const { fn, calls } = makeLlmStub(
			'Based on [#1], the scene renders with d3-force. Consider tuning force strength or node capping.'
		);
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, llm: fn },
			'How does the memory scene render today?'
		);
		expect(turn.intent).toBe('open_question');
		expect(turn.handledIntent).toBe(true);
		expect(turn.llmUsed).toBe(true);
		// The grounding memory was injected into the user prompt (S0), and the system prompt is advisory.
		expect(calls).toHaveLength(1);
		expect(calls[0].user).toContain('[#1]');
		expect(calls[0].user).toContain('d3-force');
		expect(calls[0].system).toContain('ADVISE ONLY');
		// The reply carries the model answer + advisory framing; grounding cited; NO directive.
		expect(turn.replyText).toContain('d3-force');
		expect(turn.groundingCitations).toEqual(['[#1]', '[#2]']);
		expect(turn.replyText).toContain('[Atelier Concierge — advisory, non-steering]');
		expect(turn.replyText).toContain('The concierge advises; it never commands or spawns an agent.');
		expect(turn.replyText.toLowerCase()).not.toMatch(/\bspawn the\b|\bhire the\b|\byou must\b/);
	});

	it('S4 — injects the DERIVED soul/identity block into the open-question system prompt when present', async () => {
		const { fn, calls } = makeLlmStub('Grounded answer.');
		const soulBlock = 'Maturity: developing. Atelier knows d3-force.\nKnows about: memory scene, d3-force.';
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, llm: fn, soulBlock },
			'What are you good at?'
		);
		expect(turn.intent).toBe('open_question');
		expect(turn.llmUsed).toBe(true);
		expect(calls).toHaveLength(1);
		// The base advisory contract is preserved AND the identity block is grounded into the system prompt.
		expect(calls[0].system).toContain('ADVISE ONLY');
		expect(calls[0].system).toContain('YOUR IDENTITY');
		expect(calls[0].system).toContain('Maturity: developing');
		expect(calls[0].system).toContain('d3-force');
	});

	it('S4 — omits the identity block honestly when the brain is cold (no soulBlock) — base prompt unchanged', async () => {
		const { fn, calls } = makeLlmStub('Grounded answer.');
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, llm: fn },
			'What are you good at?'
		);
		expect(turn.llmUsed).toBe(true);
		expect(calls[0].system).toContain('ADVISE ONLY');
		expect(calls[0].system).not.toContain('YOUR IDENTITY');
	});

	it('a model error degrades to an HONEST unavailable note (never a fabricated answer, F-008)', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, llm: async () => { throw new Error('ollama offline'); } },
			'What should we prioritize next?'
		);
		expect(turn.intent).toBe('open_question');
		expect(turn.handledIntent).toBe(false);
		expect(turn.llmUsed).toBe(false);
		expect(turn.replyText).toContain('the model was unavailable');
		expect(turn.replyText).toContain('did not fabricate an answer');
		expect(turn.replyText).toContain('advisory, non-steering');
	});

	it('an empty model output is an honest no-answer state, not a fabricated reply', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallEmpty, listAgents: listStub, llm: async () => '   ' },
			'Give me a status overview'
		);
		expect(turn.llmUsed).toBe(false);
		expect(turn.handledIntent).toBe(false);
		expect(turn.replyText).toContain('no usable answer');
	});

	it('a skill request with NO search seam gives an honest manual-path explainer — the LLM is NOT called', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, llm: mustNotCall },
			'Can you author a skill to lint our configs?'
		);
		expect(turn.intent).toBe('skill_request');
		expect(turn.handledIntent).toBe(false);
		expect(turn.recommendations).toEqual([]);
		expect(turn.replyText).toContain('not enabled');
		expect(turn.replyText).toContain('did not install');
		expect(turn.replyText).toContain('npx skills find');
		expect(turn.replyText).toContain('advisory, non-steering');
	});

	it('a hire request is honestly OPERATOR-GATED — no auto-draft/auto-hire, the LLM is NOT called', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, llm: mustNotCall },
			'Please hire a new backend engineer for the ROUNDS project'
		);
		expect(turn.intent).toBe('hire_request');
		expect(turn.handledIntent).toBe(false);
		expect(turn.replyText).toContain('operator-gated');
		expect(turn.replyText).toContain('never draft, certify, or execute a hire');
	});
});

// ── (a3) Stage-3 gated skill-discovery — search-only, quality-gated, advisory, NO install ──

describe('runConciergeTurn — Stage-3 gated skill-discovery (find-skills, advisory, no install)', () => {
	const RESULTS: SkillSearchResult[] = [
		// trusted owner → recommended (surfaced as trusted), ranked first.
		{ id: 'vercel-labs/agent-skills/vercel-react', name: 'vercel-react', source: 'vercel-labs/agent-skills', installs: 500_000 },
		// community, ≥1K installs → recommended.
		{ id: 'acme/tools/lint-configs', name: 'lint-configs', source: 'acme/tools', installs: 4_200 },
		// community, <100 installs → OMITTED (never recommend an unvetted low-adoption skill).
		{ id: 'randy/x/tiny-skill', name: 'tiny-skill', source: 'randy/x', installs: 12 }
	];
	function makeSearchStub(results: SkillSearchResult[]) {
		const calls: string[] = [];
		const fn: ConciergeSkillSearchFn = async (q) => {
			calls.push(q);
			return results;
		};
		return { fn, calls };
	}
	const searchMustNotCall: ConciergeSkillSearchFn = async () => {
		throw new Error('skillSearch must not be called for this intent');
	};
	const llmMustNotCall: ConciergeLlmFn = async () => {
		throw new Error('LLM must not be called on the skill path');
	};

	it('searches, quality-gates + ranks, proposes ADVISORY candidates, and NEVER installs', async () => {
		const { fn, calls } = makeSearchStub(RESULTS);
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, skillSearch: fn, llm: llmMustNotCall },
			'Can you find a skill to lint our configs?'
		);
		expect(turn.intent).toBe('skill_request');
		expect(turn.handledIntent).toBe(true);
		expect(turn.llmUsed).toBe(false); // deterministic — no model spawn on the skill path
		// The (unfenced) request reached the READ-ONLY search transport.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('lint');
		// Trusted source ranked FIRST; the <100-install candidate is OMITTED (not recommended unvetted).
		expect(turn.skillCandidates?.map((c) => c.name)).toEqual(['vercel-react', 'lint-configs']);
		expect(turn.skillCandidates?.[0].trust).toBe('trusted');
		expect(turn.skillCandidates?.[0].verdict).toBe('recommended');
		expect(turn.skillCandidates?.[1].verdict).toBe('recommended');
		// Advisory framing + the MANDATORY no-install / operator-gate contract.
		expect(turn.replyText).toContain('[Atelier Concierge — advisory, non-steering]');
		expect(turn.replyText).toContain('I did NOT install anything');
		expect(turn.replyText).toContain('OPERATOR-GATED');
		expect(turn.replyText).toContain('never run `npx skills add`');
		expect(turn.replyText).toContain('1 lower-adoption candidate(s) omitted');
		// No directive language.
		expect(turn.replyText.toLowerCase()).not.toMatch(/\byou must\b/);
	});

	it('an UNREACHABLE search transport degrades to an honest fallback — NO fabricated results (F-008)', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, skillSearch: async () => { throw new Error('skills.sh unreachable'); } },
			'find me a skill for X'
		);
		expect(turn.intent).toBe('skill_request');
		expect(turn.handledIntent).toBe(false);
		expect(turn.skillCandidates).toBeUndefined();
		expect(turn.replyText).toContain('unavailable right now');
		expect(turn.replyText).toContain('skills.sh unreachable');
		expect(turn.replyText).toContain('did not fabricate');
		expect(turn.replyText).toContain('npx skills find'); // honest manual path
		expect(turn.replyText).toContain('advisory, non-steering');
	});

	it('zero hits is an honest no-candidates state (never a fabricated proposal)', async () => {
		const { fn } = makeSearchStub([]);
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, skillSearch: fn },
			'find a skill for quantum xylophones'
		);
		expect(turn.handledIntent).toBe(false);
		expect(turn.skillCandidates).toEqual([]);
		expect(turn.replyText).toContain('found no candidates');
		expect(turn.replyText).toContain('did not fabricate');
	});

	it('when every hit is below the quality gate, nothing is recommended (no unvetted recommend)', async () => {
		const { fn } = makeSearchStub([
			{ id: 'a/b/low1', name: 'low1', source: 'a/b', installs: 40 },
			{ id: 'c/d/low2', name: 'low2', source: 'c/d', installs: 3 }
		]);
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, skillSearch: fn },
			'find a skill to do X'
		);
		expect(turn.handledIntent).toBe(false);
		expect(turn.skillCandidates).toEqual([]);
		expect(turn.replyText).toContain('none cleared the quality gate');
	});

	it('D-026 — screens untrusted third-party skill name before it enters the reply', async () => {
		const { fn } = makeSearchStub([
			{ id: 'evil/x/leak', name: 'leak sk-ant-ABCDEFGH12345', source: 'evil/repo', installs: 9_000 }
		]);
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, skillSearch: fn },
			'find a skill'
		);
		expect(turn.handledIntent).toBe(true);
		// The embedded secret-shaped token is redacted; the raw token NEVER reaches the reply.
		expect(turn.replyText).not.toContain('sk-ant-ABCDEFGH12345');
		expect(turn.replyText).toContain('[REDACTED:anthropic-key]');
	});

	it('a recommend-agent request never reaches the skill search (intent precedence holds)', async () => {
		const turn = await runConciergeTurn(
			{ recall: recallStub, listAgents: listStub, skillSearch: searchMustNotCall },
			'recommend an agent to build a skill' // recommend_agent wins over the skill mention
		);
		expect(turn.intent).toBe('recommend_agent');
		expect(turn.handledIntent).toBe(true);
	});
});

describe('gateSkillCandidates + parseSkillsSearchResponse (pure)', () => {
	it('parses the skills.sh response shape, tolerates drift, floors installs, caps results', () => {
		const json = {
			query: 'x',
			skills: [
				{ id: 'o/r/a', name: 'a', source: 'o/r', installs: 5 },
				{ id: 'o/r2/b', skillId: 'b', source: 'o/r2', installs: 2.9 }, // name from skillId; installs floored
				{ name: 'noSource' }, // dropped — no source
				{ source: 'o/r3' }, // dropped — no name
				null,
				'garbage'
			],
			count: 6
		};
		const out = parseSkillsSearchResponse(json, 10);
		expect(out.map((s) => s.name)).toEqual(['a', 'b']);
		expect(out[1].installs).toBe(2);
		expect(parseSkillsSearchResponse({}, 10)).toEqual([]);
		expect(parseSkillsSearchResponse(null, 10)).toEqual([]);
		expect(parseSkillsSearchResponse(json, 1)).toHaveLength(1); // cap respected
	});

	it('the quality gate: trusted promotes, ≥1K recommends, 100..999 cautious, <100 omitted', () => {
		const raw: SkillSearchResult[] = [
			{ id: '1', name: 'trusted-low', source: 'anthropics/skills', installs: 5 },
			{ id: '2', name: 'big', source: 'x/y', installs: 250_000 },
			{ id: '3', name: 'mid', source: 'x/y', installs: 300 },
			{ id: '4', name: 'tiny', source: 'x/y', installs: 9 }
		];
		const { proposed, omitted } = gateSkillCandidates(raw, { limit: 5 });
		expect(omitted).toBe(1); // tiny
		const byName = Object.fromEntries(proposed.map((c) => [c.name, c]));
		expect(byName['trusted-low'].verdict).toBe('recommended');
		expect(byName['trusted-low'].trust).toBe('trusted');
		expect(byName['big'].verdict).toBe('recommended');
		expect(byName['mid'].verdict).toBe('cautious');
		expect(byName['tiny']).toBeUndefined();
		// Trusted ranked FIRST even with far fewer installs.
		expect(proposed[0].name).toBe('trusted-low');
		// NEVER surfaces an unvetted low-adoption community skill as `recommended`.
		expect(
			proposed.find((c) => c.verdict === 'recommended' && c.trust === 'community' && c.installs < 1000)
		).toBeUndefined();
	});

	it('TRUSTED_SKILL_OWNERS covers the official owners only', () => {
		expect(TRUSTED_SKILL_OWNERS.has('vercel-labs')).toBe(true);
		expect(TRUSTED_SKILL_OWNERS.has('anthropics')).toBe(true);
		expect(TRUSTED_SKILL_OWNERS.has('microsoft')).toBe(true);
		expect(TRUSTED_SKILL_OWNERS.has('randos')).toBe(false);
	});
});

describe('resolveConciergeProvider — honors the defaultProvider toggle (pure)', () => {
	const P = (tiers: Record<string, { provider: string; model: string }>, order?: string[]): AgentPool =>
		({ tiers, ...(order ? { escalation: { order } } : {}) }) as unknown as AgentPool;
	const withCloud = P(
		{
			local: { provider: 'ollama', model: 'gpt-oss:20b' },
			sonnet: { provider: 'claude', model: 'claude-sonnet' },
			opus: { provider: 'claude', model: 'claude-opus' }
		},
		['haiku', 'sonnet', 'opus']
	);
	const localOnly = P({ local: { provider: 'ollama', model: 'gpt-oss:20b' } });
	const cloudOnly = P({ opus: { provider: 'claude', model: 'claude-opus' } }, ['opus']);

	it("'local' → the local tier (the always-on-local-brain experiment)", () => {
		expect(resolveConciergeProvider('local', withCloud, { hasCloudKey: true })).toEqual({
			provider: 'ollama',
			model: 'gpt-oss:20b',
			tier: 'local'
		});
	});
	it("'local' with no local tier → null (honest, never forces a provider the pool can't serve)", () => {
		expect(resolveConciergeProvider('local', cloudOnly, { hasCloudKey: true })).toBeNull();
	});
	it("'cloud' → a cloud tier, preferring sonnet", () => {
		expect(resolveConciergeProvider('cloud', withCloud, { hasCloudKey: true })).toEqual({
			provider: 'claude',
			model: 'claude-sonnet',
			tier: 'sonnet'
		});
	});
	it("'cloud' with no cloud tier → null", () => {
		expect(resolveConciergeProvider('cloud', localOnly, { hasCloudKey: true })).toBeNull();
	});
	it("'auto' + a cloud key → cloud; 'auto' + NO key → local (local-brain fallback)", () => {
		expect(resolveConciergeProvider('auto', withCloud, { hasCloudKey: true })?.provider).toBe('claude');
		expect(resolveConciergeProvider('auto', withCloud, { hasCloudKey: false })).toEqual({
			provider: 'ollama',
			model: 'gpt-oss:20b',
			tier: 'local'
		});
	});
	it("absent toggle + no key + no local tier → falls back to the cloud identity", () => {
		expect(resolveConciergeProvider(undefined, cloudOnly, { hasCloudKey: false })?.tier).toBe('opus');
	});
});

// ── (b) + (c) DB-backed: reachability + the event trigger ─────────────────────────

describe('concierge — reachability + event trigger (live DB)', () => {
	let tdb: TestDb;
	let db: Db;
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
		const applied = await runMigrations(db, schemaMigrations);
		expect(applied).toContain('0074_session_pm');
	}, 90_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown();
	});

	async function freshProject(): Promise<string> {
		const slug = `conc_proj_${++seq}`;
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE type::thing('project', $slug) SET slug = $slug, name = $slug, root_path = "/tmp", status = "active" RETURN id;`,
			{ slug }
		);
		return String(rows[0].id);
	}

	async function freshSession(project?: string): Promise<string> {
		const set = [`kind = 'task'`, `model = { provider: 'claude', model_id: 'claude-test' }`];
		const bind: Record<string, unknown> = {};
		if (project) {
			set.push(`project = type::thing('project', $pj)`);
			bind.pj = project.split(':')[1];
		}
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session SET ${set.join(', ')} RETURN id;`,
			bind
		);
		return String(rows[0].id);
	}

	it('resolveAtelier resolves LIVE to the atelier_self session while it is up, offline after', async () => {
		// Before: no atelier session → offline (inboxes pending).
		let fleet = await loadFleetSnapshot(db);
		expect(fleet.pmByProject?.[ATELIER_PROJECT_KEY]).toBeUndefined();
		const senderSession = await freshSession(await freshProject());
		const offline = resolveAddress({ kind: 'atelier' }, { session: senderSession }, fleet);
		expect(offline.sessions).toEqual([]);
		expect(offline.note).toMatch(/offline|pending/i);

		// Bring the atelier_self session up.
		const { sessionId, created } = await ensureAtelierSession(db);
		expect(created).toBe(true);

		fleet = await loadFleetSnapshot(db);
		expect(fleet.pmByProject?.[ATELIER_PROJECT_KEY]).toBe(ATELIER_SELF_PM);
		const live = resolveAddress({ kind: 'atelier' }, { session: senderSession }, fleet);
		expect(live.sessions).toEqual([sessionId]);
		expect(live.note).toBeNull();

		// ensureAtelierSession is idempotent-ish: a second call reuses the running one (created=false).
		const again = await ensureAtelierSession(db);
		expect(again.sessionId).toBe(sessionId);
		expect(again.created).toBe(false);

		// Tear it down → offline again.
		await db.query(`UPDATE $sid SET status = 'done', ended_at = time::now();`, {
			sid: new StringRecordId(sessionId)
		});
		fleet = await loadFleetSnapshot(db);
		expect(fleet.pmByProject?.[ATELIER_PROJECT_KEY]).toBeUndefined();
	});

	it('the TRIGGER spawns atelier_self on a pending atelier msg, replies advisory, marks delivered, tears down', async () => {
		const requester = await freshSession(await freshProject());
		// A PM sends a recommend-agent request to the atelier identity → persists PENDING.
		const req = await sendPeerMessage(db, {
			from_session: requester,
			to_kind: 'atelier',
			body: 'Please recommend an agent to build a SvelteKit dashboard UI with SurrealDB.'
		});
		expect(req.status).toBe('pending');

		const pendingBefore = await fetchPendingAtelierInbox(db, 20);
		expect(pendingBefore.some((m) => m.id === req.id)).toBe(true);

		// Fire the event trigger (injected deterministic recall + library; real send + DB).
		const result = await handleAtelierMessages({
			db,
			recall: recallStub,
			listAgents: listStub
		});
		expect(result.handled).toBe(1);
		expect(result.replies).toBe(1);
		expect(result.sessionId).not.toBeNull();

		// The atelier message is now DELIVERED (drained, never silently dropped).
		const [msgRows] = await db.query<[Array<{ status: unknown }>]>(
			`SELECT status FROM $rid;`,
			{ rid: new StringRecordId(req.id) }
		);
		expect(String(msgRows[0].status)).toBe('delivered');

		// An ADVISORY reply was sent back to the requester over the bus (to_kind=session).
		const [replyRows] = await db.query<[Array<{ from_session: unknown; body: string; to_session: unknown }>]>(
			`SELECT from_session, to_session, body FROM peer_message WHERE to_kind = "session";`
		);
		const reply = replyRows.filter((r) => String(r.to_session) === requester);
		expect(reply.length).toBe(1);
		expect(String(reply[0].from_session)).toBe(result.sessionId);
		// The body is screened+fenced by the repo but the advisory recommendation text survives.
		expect(reply[0].body).toContain('atelier-developer');
		expect(reply[0].body).toContain('advisory, non-steering');

		// The concierge session was torn down (bounded, $0 idle) → atelier offline again.
		const [sessRows] = await db.query<[Array<{ status: unknown }>]>(
			`SELECT status FROM $sid;`,
			{ sid: new StringRecordId(result.sessionId as string) }
		);
		expect(String(sessRows[0].status)).toBe('done');
		const fleet = await loadFleetSnapshot(db);
		expect(fleet.pmByProject?.[ATELIER_PROJECT_KEY]).toBeUndefined();

		// The pending atelier inbox is now empty (idempotent — a re-trigger is a clean no-op).
		const again = await handleAtelierMessages({ db, recall: recallStub, listAgents: listStub });
		expect(again.handled).toBe(0);
		expect(again.replies).toBe(0);
		expect(again.sessionId).toBeNull();
	});

	it('the TRIGGER runs the Stage-2 LLM turn for an open question, stamps the provider identity, replies advisory', async () => {
		const requester = await freshSession(await freshProject());
		const req = await sendPeerMessage(db, {
			from_session: requester,
			to_kind: 'atelier',
			body: 'How is the memory scene rendered today?'
		});
		expect(req.status).toBe('pending');

		// Injected deterministic LLM (NO real model) — asserts grounding reached the prompt.
		const llm: ConciergeLlmFn = async ({ user }) => {
			expect(user).toContain('[#1]');
			return 'Grounded on [#1]: the scene renders with d3-force. Consider tuning force strength.';
		};
		const result = await handleAtelierMessages({
			db,
			recall: recallStub,
			listAgents: listStub,
			llm,
			// Provider-aware identity stamped on the atelier_self session (honest provider tag).
			sessionModel: { provider: 'ollama', model_id: 'gpt-oss:20b' }
		});
		expect(result.handled).toBe(1);
		expect(result.replies).toBe(1);

		// The atelier_self session names the resolved provider (a benchmark-visible provider sample).
		const [sess] = await db.query<[Array<{ model: { provider: string; model_id: string } }>]>(
			`SELECT model FROM $sid;`,
			{ sid: new StringRecordId(result.sessionId as string) }
		);
		expect(sess[0].model.provider).toBe('ollama');
		expect(sess[0].model.model_id).toBe('gpt-oss:20b');

		// The advisory reply carries the model answer + the non-steering wrap (screened+fenced by the repo).
		const [replyRows] = await db.query<[Array<{ to_session: unknown; body: string }>]>(
			`SELECT to_session, body FROM peer_message WHERE to_kind = "session";`
		);
		const reply = replyRows.filter((r) => String(r.to_session) === requester);
		expect(reply.length).toBe(1);
		expect(reply[0].body).toContain('d3-force');
		expect(reply[0].body).toContain('advisory, non-steering');
	});
});
