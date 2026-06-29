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

// Gap 1 (wave-v2.2b-a deferral ledger): private-key markers were case-SENSITIVE, so a
// lowercase PEM / lowercase OpenSSH header EVADED the screen (returned clean) and the
// key got embedded/stored. Markers are now case-insensitive — all casings caught.
describe('§3.1b private-key markers are case-INSENSITIVE (key-material leak)', () => {
	it('catches a LOWERCASE PEM header (was evading → clean)', () => {
		const r = screen('-----begin rsa private key-----\nMIIEowIBAAKCAQEA\n-----end rsa private key-----');
		expect(r.status).toBe('quarantined');
		expect(r.reasons).toContain('private-key');
		expect(r.text).not.toContain('MIIEowIBAAKCAQEA');
		expect(r.text).toContain('[REDACTED:private-key]');
	});

	it('catches a LOWERCASE OpenSSH private-key header', () => {
		const r = screen('-----begin openssh private key-----\nb3BlbnNzaC1rZXkBBBBB\n-----end openssh private key-----');
		expect(r.status).toBe('quarantined');
		expect(r.reasons).toContain('private-key');
		expect(r.text).not.toContain('b3BlbnNzaC1rZXk');
	});

	it('catches a MIXED-case header + still catches UPPERCASE (regression guard)', () => {
		const mixed = screen('-----Begin Rsa Private Key-----\nKEYMATERIAL123\n-----End Rsa Private Key-----');
		expect(mixed.status).toBe('quarantined');
		expect(mixed.text).not.toContain('KEYMATERIAL123');

		const upper = screen('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----');
		expect(upper.status).toBe('quarantined');
		expect(upper.reasons).toContain('private-key');
	});

	it('catches a LOWERCASE truncated header (no END) — remainder redacted (header rule)', () => {
		const r = screen('paste:\n-----begin openssh private key-----\nb3BlbnNzaC1rZXktruncatedkeymat');
		expect(r.status).toBe('quarantined');
		expect(r.text).not.toContain('truncatedkeymat');
	});
});

// Gap 2 (wave-v2.2b-a deferral ledger): the card-number rule redacted ANY 13–16 digit
// run, mangling legit build ids / version strings (F-008 data destruction). It is now
// Luhn-gated: only checksum-valid card numbers are redacted, look-alikes pass verbatim.
describe('§3.1b card-number rule is Luhn-gated (F-008 over-redaction)', () => {
	it('does NOT redact a legit build artifact id (Luhn-invalid 13-digit run)', () => {
		const r = screen('build artifact 1234567890123 shipped');
		expect(r.status).toBe('clean');
		expect(r.text).toBe('build artifact 1234567890123 shipped');
	});

	it('does NOT redact a Luhn-invalid 16-digit version/ordinal string', () => {
		const r = screen('release sequence 1234567890123456 logged');
		expect(r.status).toBe('clean');
		expect(r.text).toContain('1234567890123456');
	});

	it('DOES redact a Luhn-valid card number (contiguous)', () => {
		const r = screen('pay with 4242424242424242 today');
		expect(r.status).toBe('redacted');
		expect(r.reasons).toContain('card-number');
		expect(r.text).not.toContain('4242424242424242');
		expect(r.text).toContain('[REDACTED:card]');
	});

	it('DOES redact a Luhn-valid card number with spaces (grouped digits)', () => {
		const r = screen('card 4111 1111 1111 1111 on file');
		expect(r.status).toBe('redacted');
		expect(r.text).not.toContain('4111 1111 1111 1111');
	});

	it('mixed: redacts the real card, keeps the legit id (no collateral)', () => {
		const r = screen('order 1234567890123 paid via 4242424242424242');
		expect(r.status).toBe('redacted');
		expect(r.text).toContain('1234567890123'); // build-id-shaped, kept
		expect(r.text).not.toContain('4242424242424242'); // real card, redacted
	});

	it('shadow path — empty / nil-ish digit context stays clean', () => {
		expect(screen('').status).toBe('clean');
		expect(screen('no numbers here at all').status).toBe('clean');
	});
});

// D-026 redaction-completeness (game-verify-harden red-team): the Windows home-path
// rule had two leak holes — (1) usernames WITH SPACES redacted only the first word,
// leaking the surname (`C:\Users\John Doe` → `[REDACTED:home-path] Doe`); (2) FORWARD-
// SLASH Windows paths (`C:/Users/<name>`) matched neither home-path rule cleanly.
describe('§3.1b Windows home-path redaction completeness (D-026)', () => {
	it('redacts a username WITH SPACES fully — no surname leak (backslash)', () => {
		const r = screen('logs at C:\\Users\\John Doe\\secret were captured');
		expect(r.status).toBe('redacted');
		expect(r.reasons).toContain('home-path-win');
		expect(r.text).not.toContain('John');
		expect(r.text).not.toContain('Doe'); // surname must NOT leak
		expect(r.text).toContain('[REDACTED:home-path]');
		expect(r.text).toContain('\\secret'); // following path component preserved
	});

	it('redacts a FORWARD-SLASH Windows path (C:/Users/<name>)', () => {
		const r = screen('opened C:/Users/jane/proj/app.ts');
		expect(r.status).toBe('redacted');
		expect(r.text).not.toContain('/jane');
		expect(r.text).toContain('[REDACTED:home-path]');
		expect(r.text).toContain('/proj/app.ts'); // trailing components preserved
	});

	it('redacts a FORWARD-SLASH Windows path with a SPACED username (no surname leak)', () => {
		const r = screen('cwd C:/Users/John Doe/work');
		expect(r.status).toBe('redacted');
		expect(r.text).not.toContain('John');
		expect(r.text).not.toContain('Doe');
		expect(r.text).toContain('/work');
	});

	it('REGRESSION — a plain backslash, no-space Windows home path still redacts', () => {
		const r = screen('see D:\\Users\\sam\\AppData\\Local for cache');
		expect(r.status).toBe('redacted');
		expect(r.reasons).toContain('home-path-win');
		expect(r.text).not.toContain('\\sam');
		expect(r.text).toContain('\\AppData\\Local'); // following components preserved
	});

	it('REGRESSION — unix /home and mac /Users paths still redact', () => {
		const a = screen('from /home/jane/secrets');
		expect(a.status).toBe('redacted');
		expect(a.text).not.toContain('/home/jane');
		const b = screen('mac path /Users/jane/Library');
		expect(b.status).toBe('redacted');
		expect(b.text).not.toContain('/Users/jane');
	});

	it('does NOT over-redact ordinary prose containing the word "Users"', () => {
		const r = screen('the Users table lists all active Users in the system');
		expect(r.status).toBe('clean');
		expect(r.text).toBe('the Users table lists all active Users in the system');
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
