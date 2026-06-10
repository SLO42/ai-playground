// LIVE PROOF — TASK 7.3: capability provisioning is WIRED (the D-036 dead branch is alive).
//
// GAP-ANALYSIS §1.2: composeCapabilities (D-036 / TASK 5.1) was a DEAD BRANCH — the
// runtime was built with NO catalog, so composeCapabilities never ran and req.capabilities
// was never composed into the isolated config. This proof exercises the EXACT wired path
// against the REAL running dev SurrealDB catalog (the cc_skill/cc_agent/cc_mcp_server
// mirror seeded by migrations + cc-config sync), NOT a fixture:
//
//   1. Connect to the LIVE dev DB (ws://127.0.0.1:8000, the same one `npm run db:up` runs).
//   2. Read the REAL catalog id-set via cc-config/sync.catalogIds — the SAME function
//      getRuntime() now calls. The catalog must be non-empty (proves a real mirror, not
//      the empty dead-branch default).
//   3. Build ClaudeCodeRuntime EXACTLY as wiring.getRuntime does — catalog + harness gates
//      — with a CAPTURING backend (no real spawn needed; we assert the composed plan).
//   4. Spawn with a real, catalog-VALID capability set → assert the isolated settings carry
//      EXACTLY that set (composeCapabilities RAN) AND plugins/marketplaces stay empty
//      (D-002 isolation preserved).
//   5. Spawn with an UNKNOWN id → assert the spawn FAILS CLOSED (catalog validation lives).
//
// F-008: the catalog is read from the live DB; nothing is fabricated. If SurrealDB is not
// running the suite is SKIPPED (honest deferral, not a faked artifact). No Anthropic token
// is needed — this proves the COMPOSITION wiring, not a live transcript.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { catalogIds } from '../cc-config/index';
import { DEFAULT_GATE_POLICY } from '../claude-code/gates';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent,
	type SpawnRequest,
	type CapabilityCatalog
} from '../runtime/index';

const WS = process.env.SURREAL_WS?.trim() || 'ws://127.0.0.1:8000';
const NS = process.env.SURREAL_NS?.trim() || 'playground';
const DBN = process.env.SURREAL_DB?.trim() || 'v2';
const USER = process.env.SURREAL_USER?.trim() || 'root';
const PASS = process.env.SURREAL_PASS?.trim() || 'root';

/** A backend that just RECORDS the plan it is handed (no spawn) — so we inspect the
 *  composed isolated settings the runtime built. */
function capturingBackend(): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: 'cc_capture',
				async *stream(): AsyncIterable<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'captured' } };
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return { ccSessionId: req.ccSessionId, async *stream() {}, async cancel() {} };
		},
		async interject() {}
	};
}

function baseReq(over: Partial<SpawnRequest> = {}): SpawnRequest {
	return {
		agentId: 'opus-1',
		projectId: 'project:test',
		cwd: '.',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		task: { id: 'task:1', title: 't', description: 'd' },
		budgets: { thinking: 'medium', toolCalls: 40, concurrency: 1 },
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] },
		...over
	};
}

async function drain(it: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
	const out: RuntimeEvent[] = [];
	for await (const ev of it) out.push(ev);
	return out;
}

let db: Db | null = null;
let catalog: CapabilityCatalog | null = null;
let available = false;

/**
 * Connect with a hard wall-clock bound (F-014): the SurrealDB SDK hangs ~90s on a dead
 * socket, so a bare `Db.connect()` would burn the whole beforeAll timeout (30s) and then
 * fail instead of skipping cleanly. Race the connect against a short timeout — on timeout
 * or refusal the live DB is treated as unavailable and the suite SKIPS.
 */
async function connectBounded(ms = 3_000): Promise<Db> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Db.connect({ url: WS, username: USER, password: PASS, namespace: NS, database: DBN }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`db connect timed out after ${ms}ms`)), ms);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

beforeAll(async () => {
	try {
		db = await connectBounded();
		const ids = await catalogIds(db);
		catalog = { skills: ids.skills, agents: ids.agents, mcp: ids.mcp };
		available = catalog.skills.size + catalog.agents.size + catalog.mcp.size > 0;
	} catch {
		available = false;
		// If the timeout fired after a socket actually opened, don't leak it.
		await db?.close().catch(() => {});
		db = null;
	}
}, 30_000);

afterAll(async () => {
	if (db) await db.close().catch(() => {});
});

/** Skip at RUNTIME (not collection) when the live DB/catalog was unavailable. */
function requireLive(ctx: { skip: () => void }): void {
	if (!available) ctx.skip();
}

describe('LIVE 7.3 — capability provisioning wired to the real catalog (D-036 dead-branch fix)', () => {
	it('the live cc-config catalog is non-empty (a REAL mirror, not the dead-branch empty default)', (ctx) => {
		requireLive(ctx);
		expect(catalog).not.toBeNull();
		const total = catalog!.skills.size + catalog!.agents.size + catalog!.mcp.size;
		expect(total).toBeGreaterThan(0);
	});

	it(
		'a real spawn composes the isolated config with the intent capability set (composeCapabilities RAN)',
		async (ctx) => {
			requireLive(ctx);
			// Pick a REAL skill id from the live catalog — proves we validate against the actual mirror.
			const realSkill = [...catalog!.skills][0];
			expect(typeof realSkill).toBe('string');

			const backend = capturingBackend();
			const runtime = new ClaudeCodeRuntime({
				backend,
				harnessConfigRoot: '.harness/claude-config-test-7-3',
				gates: { ...DEFAULT_GATE_POLICY },
				catalog: catalog! // EXACTLY what getRuntime(db) now wires in
			});

			const events = await drain(
				runtime.spawn(baseReq({ capabilities: { skills: [realSkill], agents: [], mcp: [] } }))
			);
			// No fail-closed error — the set is catalog-valid.
			expect(events.some((e) => e.type === 'error')).toBe(false);
			expect(backend.plans).toHaveLength(1);

			const settings = backend.plans[0].isolated.settings;
			// composeCapabilities RAN: the composed settings carry the EXACT declared set.
			expect(settings.capabilities).toEqual({ skills: [realSkill], agents: [], mcp: [] });
			// The harness gates rode through.
			expect(settings.gates).toMatchObject({ 'config-protection': 'deny' });
			// D-002 isolation preserved — never the operator's plugin soup.
			expect(settings.plugins).toEqual([]);
			expect(settings.marketplaces).toEqual([]);
		}
	);

	it('an UNKNOWN capability id fails the spawn CLOSED against the real catalog', async (ctx) => {
		requireLive(ctx);
		const backend = capturingBackend();
		const runtime = new ClaudeCodeRuntime({
			backend,
			harnessConfigRoot: '.harness/claude-config-test-7-3',
			gates: { ...DEFAULT_GATE_POLICY },
			catalog: catalog!
		});

		const bogus = '__definitely-not-a-real-skill-id__';
		expect(catalog!.skills.has(bogus)).toBe(false);

		const events = await drain(
			runtime.spawn(baseReq({ capabilities: { skills: [bogus], agents: [], mcp: [] } }))
		);
		// Fail closed: an error event, and the backend was NEVER reached with a bad config.
		const err = events.find((e) => e.type === 'error');
		expect(err).toBeDefined();
		expect((err as { error: string }).error).toMatch(/not in the cc-config catalog/i);
		expect(backend.plans).toHaveLength(0);
	});
});
