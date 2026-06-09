import { describe, it, expect } from 'vitest';
import {
	makeSecretResolver,
	describeSecrets,
	describeAdapterSecrets,
	resolverForAdapter,
	requiredSecretsPresent
} from './secrets';
import { SecretConfinementError, type SecretRequirement, type BaseAdapter } from './types';

// TASK 12.1 VERIFY — credential confinement (D-026). The resolver is SCOPED to declared names;
// an undeclared read throws; presence is exposed without the value; the value is never leaked
// to any returned surface.

const REQS: SecretRequirement[] = [
	{ envVar: 'NPM_TOKEN', label: 'npm token', purpose: 'publish', required: true },
	{ envVar: 'OPTIONAL_TOKEN', label: 'optional', purpose: 'extra' }
];

const ADAPTER: BaseAdapter = {
	id: 'npm',
	label: 'npm',
	kind: 'publish',
	secrets: () => REQS
};

describe('makeSecretResolver — confinement (D-026)', () => {
	it('reads a DECLARED secret value + presence', () => {
		const r = makeSecretResolver({ NPM_TOKEN: 'secret-value' }, REQS);
		expect(r.has('NPM_TOKEN')).toBe(true);
		expect(r.get('NPM_TOKEN')).toBe('secret-value');
	});

	it('reports an unset declared secret as absent (value undefined)', () => {
		const r = makeSecretResolver({}, REQS);
		expect(r.has('NPM_TOKEN')).toBe(false);
		expect(r.get('NPM_TOKEN')).toBeUndefined();
	});

	it('treats a whitespace-only value as UNSET (honest)', () => {
		const r = makeSecretResolver({ NPM_TOKEN: '   ' }, REQS);
		expect(r.has('NPM_TOKEN')).toBe(false);
		expect(r.get('NPM_TOKEN')).toBeUndefined();
	});

	it('THROWS SecretConfinementError on an UNDECLARED name (has + get)', () => {
		const r = makeSecretResolver({ OTHER: 'x' }, REQS);
		expect(() => r.has('OTHER')).toThrow(SecretConfinementError);
		expect(() => r.get('OTHER')).toThrow(SecretConfinementError);
	});
});

describe('describeSecrets — presence only (D-026)', () => {
	it('returns presence + non-secret metadata, NEVER the value', () => {
		const presence = describeSecrets({ NPM_TOKEN: 'sekret' }, REQS);
		const npm = presence.find((p) => p.envVar === 'NPM_TOKEN')!;
		expect(npm.present).toBe(true);
		expect(npm.required).toBe(true);
		// No field carries the value.
		expect(JSON.stringify(presence)).not.toContain('sekret');
	});

	it('defaults required to false when unspecified', () => {
		const presence = describeSecrets({}, REQS);
		expect(presence.find((p) => p.envVar === 'OPTIONAL_TOKEN')!.required).toBe(false);
		expect(presence.find((p) => p.envVar === 'NPM_TOKEN')!.present).toBe(false);
	});
});

describe('adapter convenience helpers', () => {
	it('describeAdapterSecrets + resolverForAdapter read the adapter declarations', () => {
		const presence = describeAdapterSecrets({ NPM_TOKEN: 'x' }, ADAPTER);
		expect(presence).toHaveLength(2);
		const r = resolverForAdapter({ NPM_TOKEN: 'x' }, ADAPTER);
		expect(r.has('NPM_TOKEN')).toBe(true);
		expect(() => r.has('UNDECLARED')).toThrow(SecretConfinementError);
	});

	it('requiredSecretsPresent is true only when every REQUIRED secret is set', () => {
		expect(requiredSecretsPresent({}, ADAPTER)).toBe(false);
		expect(requiredSecretsPresent({ NPM_TOKEN: 'x' }, ADAPTER)).toBe(true);
		// An adapter with no required secrets is always "present".
		const noReq: BaseAdapter = { ...ADAPTER, secrets: () => [{ envVar: 'X', label: 'x', purpose: 'x' }] };
		expect(requiredSecretsPresent({}, noReq)).toBe(true);
	});
});
