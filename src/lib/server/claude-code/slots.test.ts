import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import type { AgentPool } from '../config/index';
import { syncAgentSlots, slotTierOf, listAgentSlots } from './slots';

// TASK 1.4 — populate `agent_slot` from config/agent-pool.yaml. agent_slot is a
// CONFIG/STAT MIRROR (DATA-MODEL §4.3) — NOT a live allocation table. syncAgentSlots
// upserts one row per pool slot, mapping each slot's tier → the schema's
// local|haiku|sonnet|opus ASSERT via its provider/model. Idempotent: re-running with
// the same pool yields the same rows (no dupes), and a removed slot is pruned.

let tdb: TestDb;
let db: Db;

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

function pool(over: Partial<AgentPool> = {}): AgentPool {
	return {
		tiers: {
			local: { provider: 'ollama', model: 'gpt-oss:20b' },
			haiku: { provider: 'anthropic', model: 'claude-haiku-4-5' },
			sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
			opus: { provider: 'anthropic', model: 'claude-opus-4-8' }
		},
		slots: [
			{ id: 'coder-1', tier: 'opus', role: 'coder' },
			{ id: 'tester-1', tier: 'sonnet', role: 'tester' },
			{ id: 'scout-1', tier: 'local', role: 'scout' }
		],
		...over
	};
}

describe('slotTierOf — pool tier → schema agent_slot.tier', () => {
	it('maps each pool tier to a valid agent_slot tier ASSERT value', () => {
		const p = pool();
		expect(slotTierOf(p, 'opus')).toBe('opus');
		expect(slotTierOf(p, 'sonnet')).toBe('sonnet');
		expect(slotTierOf(p, 'haiku')).toBe('haiku');
		// ollama-backed tier maps to the schema's "local".
		expect(slotTierOf(p, 'local')).toBe('local');
	});

	it('falls back to "local" for an ollama-backed custom tier name', () => {
		const p = pool({
			tiers: {
				...pool().tiers,
				cheap: { provider: 'ollama', model: 'gpt-oss:20b' }
			}
		});
		expect(slotTierOf(p, 'cheap')).toBe('local');
	});
});

describe('syncAgentSlots — mirror config/agent-pool.yaml into agent_slot', () => {
	it('inserts one agent_slot per pool slot with mapped tier + role', async () => {
		const n = await syncAgentSlots(db, pool());
		expect(n).toBe(3);
		const rows = await listAgentSlots(db);
		expect(rows).toHaveLength(3);
		const coder = rows.find((r) => r.name === 'coder-1');
		expect(coder).toMatchObject({ name: 'coder-1', tier: 'opus', role: 'coder', busy: false });
		const scout = rows.find((r) => r.name === 'scout-1');
		expect(scout?.tier).toBe('local');
	});

	it('is idempotent — re-sync yields no duplicate rows', async () => {
		await syncAgentSlots(db, pool());
		await syncAgentSlots(db, pool());
		const rows = await listAgentSlots(db);
		expect(rows).toHaveLength(3);
	});

	it('prunes a slot removed from the pool on the next sync', async () => {
		await syncAgentSlots(db, pool());
		const trimmed = pool({
			slots: [
				{ id: 'coder-1', tier: 'opus', role: 'coder' },
				{ id: 'tester-1', tier: 'sonnet', role: 'tester' }
			]
		});
		await syncAgentSlots(db, trimmed);
		const rows = await listAgentSlots(db);
		expect(rows.map((r) => r.name).sort()).toEqual(['coder-1', 'tester-1']);
	});

	it('updates the tier/role of an existing slot in place (no new row)', async () => {
		await syncAgentSlots(db, pool());
		const repurposed = pool({
			slots: [
				{ id: 'coder-1', tier: 'sonnet', role: 'reviewer' },
				{ id: 'tester-1', tier: 'sonnet', role: 'tester' },
				{ id: 'scout-1', tier: 'local', role: 'scout' }
			]
		});
		await syncAgentSlots(db, repurposed);
		const rows = await listAgentSlots(db);
		expect(rows).toHaveLength(3);
		const coder = rows.find((r) => r.name === 'coder-1');
		expect(coder).toMatchObject({ tier: 'sonnet', role: 'reviewer' });
	});

	it('rejects a slot id that is not a safe record-id segment (D-016)', async () => {
		const bad = pool({
			slots: [{ id: 'bad id!', tier: 'opus', role: 'coder' }]
		});
		await expect(syncAgentSlots(db, bad)).rejects.toThrow();
	});
});
