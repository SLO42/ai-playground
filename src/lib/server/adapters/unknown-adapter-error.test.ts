// ADF-2 (ADAPTER-FRAMEWORK-SPEC §8) — UnknownAdapterError is now ONE class across the whole
// adapter framework. Before this fix it was defined twice (adapters/types.ts + sync/adapter.ts):
// same name, different identities, so a `catch (e) { if (e instanceof UnknownAdapterError) }` on
// one path silently missed a throw from the other. These tests pin the unification: the class is
// identical by reference through every barrel, and an instanceof on the CANONICAL class catches a
// miss thrown from BOTH the release/action path (AdapterRegistry) and the sync path (SyncRegistry).

import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from './registry';
import { UnknownAdapterError as CanonicalError } from './types';
import { UnknownAdapterError as ViaAdaptersBarrel } from './index';
import { SyncRegistry, UnknownAdapterError as ViaSyncBarrel } from '../sync';

describe('UnknownAdapterError unification (ADF-2)', () => {
	it('is the SAME class through the types module, the adapters barrel, and the sync barrel', () => {
		// Identity, not just structural equality — a re-export forwards the same binding.
		expect(ViaAdaptersBarrel).toBe(CanonicalError);
		expect(ViaSyncBarrel).toBe(CanonicalError);
	});

	it('a miss from the RELEASE/action path (AdapterRegistry) is caught by the canonical class', () => {
		const reg = new AdapterRegistry();
		let caught: unknown;
		try {
			reg.getPublisher('totally-unknown-publisher');
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(CanonicalError);
		expect((caught as CanonicalError).adapterId).toBe('totally-unknown-publisher');
		expect((caught as CanonicalError).kind).toBe('publish');
	});

	it('a miss from the SYNC path (SyncRegistry) is caught by the canonical class', () => {
		const reg = new SyncRegistry();
		let caught: unknown;
		try {
			reg.get('totally-unknown-sync');
		} catch (e) {
			caught = e;
		}
		// The crux of the fix: a catch written against the CANONICAL class now catches the sync
		// throw too — pre-ADF-2 this instanceof was false (two different class identities).
		expect(caught).toBeInstanceOf(CanonicalError);
		expect((caught as CanonicalError).adapterId).toBe('totally-unknown-sync');
		expect((caught as CanonicalError).kind).toBe('sync');
		// Message stays honest + still carries the "sync adapter registered" phrasing callers match on.
		expect((caught as Error).message).toMatch(/no sync adapter registered/);
	});

	it('the caught error is a real Error with the stable name (surfaces honestly)', () => {
		const err = new CanonicalError('x', 'deploy');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('UnknownAdapterError');
	});
});
