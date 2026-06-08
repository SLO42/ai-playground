import { describe, it, expect } from 'vitest';
import { screen, captureGate, gateCandidate } from './screen';

// TASK 2.5 VERIFY — the secret/PII screen (§3.1b) + DO-NOT-CAPTURE guard (§3.1, D-026).
// A planted secret must be quarantined or redacted; a raw secret must NEVER survive
// screening (it is what gets embedded). Transient negative claims must be DROPPED.

describe('§3.1b secret/PII screen', () => {
	it('redacts an Anthropic-style API key in place (status=redacted)', () => {
		const r = screen('the key is sk-ant-api03-AbCdEf123456789xyz for the call');
		expect(r.status).toBe('redacted');
		expect(r.text).not.toContain('sk-ant-api03');
		expect(r.text).toContain('[REDACTED:anthropic-key]');
		expect(r.reasons).toContain('anthropic-key');
	});

	it('redacts a credential assignment (password=…)', () => {
		const r = screen('config: password=hunter2supersecret in the env');
		expect(r.status).toBe('redacted');
		expect(r.text).not.toContain('hunter2supersecret');
	});

	it('QUARANTINES a private-key block (cannot safely redact a span)', () => {
		const r = screen('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----');
		expect(r.status).toBe('quarantined');
		expect(r.reasons).toContain('private-key');
	});

	it('redacts email + home path PII', () => {
		const r = screen('mail me at jane.doe@example.com from /home/jane/secrets');
		expect(r.status).toBe('redacted');
		expect(r.text).not.toContain('jane.doe@example.com');
		expect(r.text).not.toContain('/home/jane');
	});

	it('leaves clean text untouched (status=clean)', () => {
		const r = screen('SvelteKit 2 uses Svelte 5 runes for reactivity');
		expect(r.status).toBe('clean');
		expect(r.text).toBe('SvelteKit 2 uses Svelte 5 runes for reactivity');
	});

	it('fails CLOSED on a non-string (quarantined, empty text)', () => {
		const r = screen(undefined as unknown as string);
		expect(r.status).toBe('quarantined');
		expect(r.text).toBe('');
	});

	it('a redacted result NEVER contains the raw secret substring (embed-safety)', () => {
		const raw = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
		const r = screen(`token ${raw}`);
		expect(r.text.includes(raw)).toBe(false);
	});
});

describe('§3.1 DO-NOT-CAPTURE guard', () => {
	it('drops "daemon is unreachable" (transient environment failure)', () => {
		expect(captureGate('the kongcode daemon is unreachable this turn').capture).toBe(false);
	});

	it('drops "the API returns 500"', () => {
		expect(captureGate('the build endpoint returns a 500 error').capture).toBe(false);
	});

	it('drops "X is broken" / "not working"', () => {
		expect(captureGate('the hot reload is broken').capture).toBe(false);
		expect(captureGate("the watcher isn't working").capture).toBe(false);
	});

	it('KEEPS a fix-phrased durable memory even if it mentions a failure', () => {
		expect(captureGate('to avoid the 500, use the /api/embed endpoint instead of /v1').capture).toBe(true);
	});

	it('keeps an ordinary durable fact', () => {
		expect(captureGate('the project root is F:/code/ai-playground-v2').capture).toBe(true);
	});

	it('the injected hook directive class is dropped (the canonical §10 example)', () => {
		// The exact transient-negative content this wave's hook injected.
		const g = captureGate('kongcode daemon is unreachable — hooks, memory injection, and gates are inactive this turn');
		expect(g.capture).toBe(false);
	});
});

describe('gateCandidate (combined §3.4 step 2.0)', () => {
	it('drops a transient claim before it can be screened/embedded', () => {
		const g = gateCandidate('the gateway is down right now');
		expect(g.capture).toBe(false);
		expect(g.screen).toBeUndefined();
	});

	it('screens a captured candidate carrying a secret', () => {
		const g = gateCandidate('store the prod key sk-ant-api03-ZZZ9999999999 in the vault');
		expect(g.capture).toBe(true);
		expect(g.screen?.status).toBe('redacted');
		expect(g.screen?.text).not.toContain('sk-ant-api03-ZZZ');
	});
});
