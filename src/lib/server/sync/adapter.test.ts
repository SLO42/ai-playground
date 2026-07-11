// SYN-2 (SYNC-SPEC §3) — the SyncRegistry contract, direct unit coverage.
//
// The registry is the D-037 plug-in point: register/get/has/list plus the two fail-loud
// edges — a duplicate register (a programming error) throws, and an UNKNOWN id fails CLOSED
// with the ONE canonical UnknownAdapterError (ADF-2). No DB, no gh: pure in-memory.

import { describe, it, expect } from 'vitest';
import type { Db } from '../db/client';
import {
	SyncRegistry,
	UnknownAdapterError,
	type SyncAdapter,
	type SyncProbe,
	type SyncResult,
	type SyncRunOptions
} from './adapter';
// The registry throws the SAME class the release/adapter surface catches (ADF-2): assert the
// re-exported symbol IS the canonical one from adapters/types (instanceof must cross the seam).
import { UnknownAdapterError as CanonicalUnknownAdapterError } from '../adapters/types';

/** A minimal stub adapter — probe/sync are never exercised here (registry-only coverage). */
function stubAdapter(id: string, label = id): SyncAdapter {
	return {
		id,
		label,
		async probe(): Promise<SyncProbe> {
			return { available: false, reason: 'stub' };
		},
		async sync(_db: Db, opts: SyncRunOptions): Promise<SyncResult> {
			return {
				target: 'stub',
				direction: opts.direction ?? 'both',
				dryRun: opts.dryRun,
				created: 0,
				updated: 0,
				pulled: 0,
				linked: 0,
				skipped: 0,
				items: [],
				errors: []
			};
		}
	};
}

describe('SyncRegistry', () => {
	it('register → get round-trips the SAME adapter instance', () => {
		const reg = new SyncRegistry();
		const a = stubAdapter('github', 'GitHub');
		reg.register(a);
		expect(reg.get('github')).toBe(a);
	});

	it('register returns `this` (chainable) and seeds multiple ids', () => {
		const reg = new SyncRegistry();
		const ret = reg.register(stubAdapter('github')).register(stubAdapter('github-board'));
		expect(ret).toBe(reg);
		expect(reg.has('github')).toBe(true);
		expect(reg.has('github-board')).toBe(true);
	});

	it('has() reflects registration state', () => {
		const reg = new SyncRegistry();
		expect(reg.has('github')).toBe(false);
		reg.register(stubAdapter('github'));
		expect(reg.has('github')).toBe(true);
		expect(reg.has('nope')).toBe(false);
	});

	it('list() returns every registered adapter, in insertion order', () => {
		const reg = new SyncRegistry();
		reg.register(stubAdapter('github')).register(stubAdapter('github-board'));
		expect(reg.list().map((x) => x.id)).toEqual(['github', 'github-board']);
	});

	it('list() on an empty registry is [] (honest empty, not undefined)', () => {
		expect(new SyncRegistry().list()).toEqual([]);
	});

	it('get(unknown) FAILS CLOSED with UnknownAdapterError (kind=sync, id carried)', () => {
		const reg = new SyncRegistry();
		reg.register(stubAdapter('github'));
		let caught: unknown;
		try {
			reg.get('does-not-exist');
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(UnknownAdapterError);
		// ADF-2: the re-exported symbol is the ONE canonical class — a catch on the release
		// surface's import catches a sync-registry miss too.
		expect(caught).toBeInstanceOf(CanonicalUnknownAdapterError);
		const e = caught as UnknownAdapterError;
		expect(e.adapterId).toBe('does-not-exist');
		expect(e.kind).toBe('sync');
		expect(e.name).toBe('UnknownAdapterError');
	});

	it('get() on an EMPTY registry also fails closed (shadow: nothing registered)', () => {
		expect(() => new SyncRegistry().get('github')).toThrow(UnknownAdapterError);
	});

	it('register(duplicate id) throws (a programming error, fail loud)', () => {
		const reg = new SyncRegistry();
		reg.register(stubAdapter('github'));
		expect(() => reg.register(stubAdapter('github', 'other'))).toThrow(/already registered/);
		// The first registration is unchanged (the dup never overwrites it).
		expect(reg.get('github').label).toBe('github');
	});
});
