// SPAWN-IDENTITY (LB-2 write half) — the agent-pool slot → spawn identity mapping.
//
// The defect this closes: `session.agent` was the pool SLOT id (`sonnet-1`) — a tier bucket, not
// an identity — because the slot carried nothing but `id`/`tier`/`role`. Every surface that
// rendered it therefore clustered unrelated sessions under one "agent" (F-046 leaking into the
// UI). A slot now carries an optional purposeful `name` (+ `purpose`, + a deliberate
// `specialist`), and `resolveSlotIdentity` is the ONE seam boot's route resolver uses to map a
// routed tier onto it.
//
// These tests run the REAL mapping over the REAL shipped `config/agent-pool.yaml` (not a mirror
// of it), so a config edit that drops a name, or a loader that silently swallows the key, fails
// here. The legacy-shaped fixture pool (no optional keys) is the F-053 regression: an un-named
// pool must produce EXACTLY the pre-change shape — `agentId` alone.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadAgentPool, ConfigError, type AgentPool } from '../config/index';
import { resolveSlotIdentity } from './boot';

const SHIPPED = join(process.cwd(), 'config/agent-pool.yaml');
const FIXTURE = join(process.cwd(), 'src/lib/server/config/__fixtures__/agent-pool.yaml');

/** A minimal in-memory pool; `_inject` on the loader is for files, so build the shape directly. */
function poolWith(slots: AgentPool['slots']): AgentPool {
	return {
		tiers: { sonnet: { provider: 'claude', model: 'claude-sonnet-4-6' } },
		slots
	};
}

describe('resolveSlotIdentity — the shipped pool names every slot by PURPOSE', () => {
	it('maps a routed tier onto that tier’s slot id AND its purposeful name/purpose', () => {
		const pool = loadAgentPool(SHIPPED);
		const id = resolveSlotIdentity(pool, 'sonnet');
		// The slot id stays the runtime key — it is not replaced, only demoted from being the
		// ONLY identity present.
		expect(id.agentId).toBe('sonnet-1');
		expect(id.agentName).toBeTruthy();
		expect(id.agentPurpose).toBeTruthy();
		// The standing operator rule: a name must convey PURPOSE, never tier/model/slot/id.
		expect(id.agentName).not.toBe(id.agentId);
		expect(id.agentName).not.toMatch(/sonnet|opus|haiku|claude|^local$/i);
	});

	it('every shipped slot carries a name and a purpose (no half-named pool)', () => {
		const pool = loadAgentPool(SHIPPED);
		expect(pool.slots.length).toBeGreaterThan(0);
		for (const slot of pool.slots) {
			const id = resolveSlotIdentity(pool, slot.tier);
			expect(id.agentId, `slot ${slot.id}`).toBe(slot.id);
			expect(id.agentName, `slot ${slot.id} name`).toBeTruthy();
			expect(id.agentPurpose, `slot ${slot.id} purpose`).toBeTruthy();
		}
	});

	it('ships NO specialist — an unearned attribution would be a fabricated value (F-008)', () => {
		// The spawn argv carries no agent directive, so `session.specialist` records a routing
		// DECISION, not observed behaviour. The key exists for an operator who means it; shipping
		// a default would claim every spawn "acted as" a library agent that never saw the turn.
		const pool = loadAgentPool(SHIPPED);
		for (const slot of pool.slots) {
			expect(resolveSlotIdentity(pool, slot.tier).specialist).toBeUndefined();
		}
	});

	it('carries a configured specialist through when the operator DOES set one', () => {
		const pool = poolWith([
			{ id: 'sonnet-1', tier: 'sonnet', role: 'builder', name: 'builder', specialist: 'atelier-developer' }
		]);
		expect(resolveSlotIdentity(pool, 'sonnet').specialist).toBe('atelier-developer');
	});
});

describe('resolveSlotIdentity — shadow paths', () => {
	it('NIL/legacy pool: a slot with no optional keys yields agentId ALONE (F-053 regression)', () => {
		// The fixture pool is the pre-change shape. The resolved identity must be structurally
		// identical to what the old `agentForTier` produced — one key, no extras to spread onto
		// the route, so a spawn from an un-named pool is byte-identical to before.
		const pool = loadAgentPool(FIXTURE);
		const id = resolveSlotIdentity(pool, 'opus');
		expect(id).toEqual({ agentId: 'coder-1' });
		expect(Object.keys(id)).toEqual(['agentId']);
	});

	it('EMPTY/blank config strings collapse to ABSENT, never a persisted "" (F-013/§6.1)', () => {
		const pool = poolWith([{ id: 'sonnet-1', tier: 'sonnet', role: 'builder', name: '   ', purpose: '', specialist: '\t' }]);
		expect(resolveSlotIdentity(pool, 'sonnet')).toEqual({ agentId: 'sonnet-1' });
	});

	it('UNKNOWN/undefined tier falls back to the first slot, identity and all', () => {
		const pool = loadAgentPool(SHIPPED);
		const first = pool.slots[0];
		expect(resolveSlotIdentity(pool, 'no-such-tier').agentId).toBe(first.id);
		expect(resolveSlotIdentity(pool, undefined).agentId).toBe(first.id);
		expect(resolveSlotIdentity(pool, 'no-such-tier').agentName).toBe(first.name);
	});

	it('UPSTREAM-ERROR shape: a slot-less pool still yields the DEFAULT_AGENT key, never undefined', () => {
		// startOrchestrator refuses to boot a slot-less pool, so this is belt-and-braces: the
		// resolver must never hand the launch path an undefined agentId (the runtime key).
		expect(resolveSlotIdentity(poolWith([]), 'sonnet')).toEqual({ agentId: 'opus-1' });
	});
});

describe('agent-pool loader — the optional identity keys fail CLOSED on a typo', () => {
	it('accepts the legacy shape unchanged', () => {
		const pool = loadAgentPool(FIXTURE);
		expect(pool.slots.map((s) => s.id)).toEqual(['coder-1', 'tester-1', 'scout-1']);
		expect(pool.slots[0].name).toBeUndefined();
	});

	it('rejects a non-string name/purpose/specialist with a NAMED error', () => {
		// A mistyped key would otherwise ride onto every spawn row as "[object Object]". The
		// boundary refuses it: the error names the slot and the key.
		for (const key of ['name', 'purpose', 'specialist']) {
			expect(() =>
				loadAgentPool(FIXTURE, { _inject: { slots: [{ id: 'x-1', tier: 'opus', role: 'coder', [key]: { oops: true } }] } })
			).toThrow(new RegExp(`slot "x-1" ${key} must be a string`));
			expect(() =>
				loadAgentPool(FIXTURE, { _inject: { slots: [{ id: 'x-1', tier: 'opus', role: 'coder', [key]: { oops: true } }] } })
			).toThrow(ConfigError);
		}
	});
});
