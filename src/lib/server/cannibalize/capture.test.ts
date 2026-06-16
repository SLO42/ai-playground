import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
	isBlockedIp,
	parseFetchTarget,
	resolvePublicAddresses,
	fetchBounded,
	captureUrl,
	captureRepo,
	captureFile,
	captureText,
	SsrfBlockedError,
	CaptureBoundsError,
	CaptureFetchError,
	type HttpTransport,
	type HttpResponse,
	type ResolveAll
} from './capture';
import { PathConfinementError } from '../claude-code/guardrails';

// BL-6 CANNIBALIZE-SPEC §2.5/§7 VERIFY — the CAPTURE layer is SSRF-safe + bounded +
// CODE_ROOT-confined, every refusal is a NAMED error, and the four data-flow paths
// (happy / nil / empty / upstream-error) are covered.

// ── A tiny fake transport so we exercise redirects/bounds/status without a live server ──
function streamOf(...parts: string[]): AsyncIterable<Uint8Array> {
	return Readable.from(parts.map((p) => Buffer.from(p, 'utf8')));
}
function fakeTransport(
	plan: (url: string) => { status: number; headers?: Record<string, string>; body?: AsyncIterable<Uint8Array> }
): HttpTransport {
	return async (url): Promise<HttpResponse> => {
		const r = plan(url.toString());
		return { status: r.status, headers: r.headers ?? {}, body: r.body ?? streamOf('') };
	};
}
const allowAll: ResolveAll = async () => ['93.184.216.34']; // example.com-ish public IP

describe('isBlockedIp — SSRF classification', () => {
	it('blocks loopback / private / link-local / metadata / CGNAT', () => {
		for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
			expect(isBlockedIp(ip), `${ip} should be blocked`).toBe(true);
		}
	});
	it('blocks IPv6 loopback / unique-local / link-local + IPv4-mapped private', () => {
		for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
			expect(isBlockedIp(ip), `${ip} should be blocked`).toBe(true);
		}
	});
	it('allows public addresses', () => {
		for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
			expect(isBlockedIp(ip), `${ip} should be allowed`).toBe(false);
		}
	});
	it('fail-closed: a non-IP string is blocked', () => {
		expect(isBlockedIp('not-an-ip')).toBe(true);
	});
});

describe('parseFetchTarget — scheme + literal-host guard', () => {
	it('refuses non-http(s) schemes (file/gopher/etc) with SsrfBlockedError', () => {
		for (const u of ['file:///etc/passwd', 'gopher://x', 'ftp://x/y']) {
			expect(() => parseFetchTarget(u)).toThrow(SsrfBlockedError);
		}
	});
	it('refuses a loopback/metadata literal-IP host', () => {
		expect(() => parseFetchTarget('http://127.0.0.1/x')).toThrow(SsrfBlockedError);
		expect(() => parseFetchTarget('http://169.254.169.254/latest/meta-data')).toThrow(SsrfBlockedError);
		expect(() => parseFetchTarget('http://[::1]/x')).toThrow(SsrfBlockedError);
	});
	it('accepts a public http(s) URL', () => {
		expect(parseFetchTarget('https://example.com/p').hostname).toBe('example.com');
	});
	it('refuses an unparseable URL', () => {
		expect(() => parseFetchTarget('not a url')).toThrow(SsrfBlockedError);
	});
});

describe('resolvePublicAddresses — DNS-rebind defense (resolve then re-check)', () => {
	it('refuses a NAME that resolves to a private/metadata address (rebind to internal)', async () => {
		const rebind: ResolveAll = async () => ['169.254.169.254'];
		await expect(resolvePublicAddresses('evil.example.com', 'http://evil.example.com', rebind)).rejects.toThrow(SsrfBlockedError);
	});
	it('refuses if ANY resolved address is internal (split-horizon attack)', async () => {
		const mixed: ResolveAll = async () => ['93.184.216.34', '10.0.0.1'];
		await expect(resolvePublicAddresses('evil.example.com', 'http://evil.example.com', mixed)).rejects.toThrow(SsrfBlockedError);
	});
	it('returns the address list when every resolved address is public', async () => {
		const ok: ResolveAll = async () => ['93.184.216.34'];
		expect(await resolvePublicAddresses('example.com', 'http://example.com', ok)).toEqual(['93.184.216.34']);
	});
	it('a literal public IP short-circuits (no DNS)', async () => {
		expect(await resolvePublicAddresses('8.8.8.8', 'http://8.8.8.8')).toEqual(['8.8.8.8']);
	});
	it('NXDOMAIN surfaces as CaptureFetchError, not a silent empty', async () => {
		const fail: ResolveAll = async () => {
			throw new Error('ENOTFOUND');
		};
		await expect(resolvePublicAddresses('nope.example.com', 'http://nope.example.com', fail)).rejects.toThrow(CaptureFetchError);
	});
	it('zero resolved addresses surfaces as CaptureFetchError (empty-input shadow path)', async () => {
		const none: ResolveAll = async () => [];
		await expect(resolvePublicAddresses('empty.example.com', 'http://empty.example.com', none)).rejects.toThrow(CaptureFetchError);
	});
});

describe('fetchBounded — happy / bounds / redirect / error', () => {
	it('captures a public 200 body (happy path)', async () => {
		const t = fakeTransport(() => ({ status: 200, body: streamOf('hello ', 'world') }));
		const r = await fetchBounded('https://example.com/p', { transport: t, resolveAll: allowAll });
		expect(r.text).toBe('hello world');
		expect(r.bytes).toBe(11);
	});

	it('refuses an SSRF redirect hop (302 → 169.254.169.254 is re-screened, not followed)', async () => {
		const t = fakeTransport((u) =>
			u.includes('example.com')
				? { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }
				: { status: 200, body: streamOf('secret') }
		);
		await expect(fetchBounded('https://example.com/p', { transport: t, resolveAll: allowAll })).rejects.toThrow(SsrfBlockedError);
	});

	it('follows a SAFE redirect to a public target', async () => {
		const t = fakeTransport((u) =>
			u.includes('/start')
				? { status: 301, headers: { location: 'https://example.com/end' } }
				: { status: 200, body: streamOf('arrived') }
		);
		const r = await fetchBounded('https://example.com/start', { transport: t, resolveAll: allowAll });
		expect(r.text).toBe('arrived');
		expect(r.finalUrl).toBe('https://example.com/end');
	});

	it('bounds an oversized body by Content-Length (cheap pre-reject)', async () => {
		const t = fakeTransport(() => ({ status: 200, headers: { 'content-length': '999999' }, body: streamOf('x') }));
		await expect(fetchBounded('https://example.com/p', { transport: t, resolveAll: allowAll, maxBytes: 10 })).rejects.toThrow(CaptureBoundsError);
	});

	it('bounds an oversized STREAMED body mid-stream (no declared length)', async () => {
		const t = fakeTransport(() => ({ status: 200, body: streamOf('a'.repeat(50)) }));
		await expect(fetchBounded('https://example.com/p', { transport: t, resolveAll: allowAll, maxBytes: 10 })).rejects.toThrow(CaptureBoundsError);
	});

	it('refuses a redirect loop', async () => {
		const t = fakeTransport(() => ({ status: 302, headers: { location: 'https://example.com/loop' } }));
		await expect(fetchBounded('https://example.com/loop', { transport: t, resolveAll: allowAll })).rejects.toThrow(CaptureFetchError);
	});

	it('surfaces a non-2xx as CaptureFetchError with the status (upstream-error shadow path)', async () => {
		const t = fakeTransport(() => ({ status: 503 }));
		await expect(fetchBounded('https://example.com/p', { transport: t, resolveAll: allowAll })).rejects.toMatchObject({
			name: 'CaptureFetchError',
			status: 503
		});
	});

	it('exceeding maxRedirects fails NAMED (no spin)', async () => {
		let n = 0;
		const t = fakeTransport(() => ({ status: 302, headers: { location: `https://example.com/r${n++}` } }));
		await expect(fetchBounded('https://example.com/r-start', { transport: t, resolveAll: allowAll, maxRedirects: 2 })).rejects.toThrow(CaptureFetchError);
	});

	it('a literal loopback URL is refused before any transport call', async () => {
		let called = false;
		const t: HttpTransport = async () => {
			called = true;
			return { status: 200, headers: {}, body: streamOf('') };
		};
		await expect(fetchBounded('http://127.0.0.1/x', { transport: t })).rejects.toThrow(SsrfBlockedError);
		expect(called).toBe(false);
	});
});

describe('captureUrl — wraps fetchBounded with url provenance', () => {
	it('returns raw + provenance{kind:url, ref:finalUrl}', async () => {
		const t = fakeTransport(() => ({ status: 200, body: streamOf('body') }));
		const r = await captureUrl('https://example.com/p', { transport: t, resolveAll: allowAll });
		expect(r.raw).toBe('body');
		expect(r.provenance).toEqual({ kind: 'url', ref: 'https://example.com/p' });
	});
});

// ── CODE_ROOT-confined repo/file read (D-018) ──────────────────────────────────────────
describe('captureRepo / captureFile — CODE_ROOT confinement (D-018, read-only)', () => {
	let root: string;
	let outside: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'capture-root-'));
		outside = mkdtempSync(join(tmpdir(), 'capture-outside-'));
		mkdirSync(join(root, 'pkg'), { recursive: true });
		writeFileSync(join(root, 'pkg', 'README.md'), '# repo readme\n');
		writeFileSync(join(outside, 'secret.txt'), 'SECRET');
	});
	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it('captures a file under CODE_ROOT with repo provenance', async () => {
		const r = await captureRepo('pkg/README.md', { codeRoot: root });
		expect(r.raw).toContain('repo readme');
		expect(r.provenance.kind).toBe('repo');
	});

	it('captures a single file with file provenance', async () => {
		const r = await captureFile('pkg/README.md', { codeRoot: root });
		expect(r.provenance.kind).toBe('file');
	});

	it('refuses a `..` traversal escaping CODE_ROOT (PathConfinementError)', async () => {
		await expect(captureFile('../../etc/passwd', { codeRoot: root })).rejects.toThrow(PathConfinementError);
	});

	it('refuses an absolute path outside CODE_ROOT', async () => {
		await expect(captureFile(join(outside, 'secret.txt'), { codeRoot: root })).rejects.toThrow(PathConfinementError);
	});

	it('refuses a symlink whose real target is outside CODE_ROOT', async () => {
		const linkName = 'link-out';
		try {
			symlinkSync(join(outside, 'secret.txt'), join(root, linkName));
		} catch {
			return; // symlink may be unavailable (Windows perms) — the `..` + absolute cases cover the class
		}
		await expect(captureFile(linkName, { codeRoot: root })).rejects.toThrow(PathConfinementError);
	});

	it('bounds an oversized confined file', async () => {
		writeFileSync(join(root, 'big.txt'), 'x'.repeat(100));
		await expect(captureFile('big.txt', { codeRoot: root, maxBytes: 10 })).rejects.toThrow(CaptureBoundsError);
	});

	it('refuses a directory target (expects a file)', async () => {
		await expect(captureFile('pkg', { codeRoot: root })).rejects.toThrow(CaptureFetchError);
	});
});

describe('captureText — pasted intake (bounded, synthetic provenance)', () => {
	it('captures pasted text with text provenance', () => {
		const r = captureText('some pasted knowledge', 'paste-1');
		expect(r.raw).toBe('some pasted knowledge');
		expect(r.provenance).toEqual({ kind: 'text', ref: 'paste-1' });
		expect(r.bytes).toBe(21);
	});
	it('empty string is a valid (zero-length) capture, not an error (empty-input shadow path)', () => {
		const r = captureText('');
		expect(r.raw).toBe('');
		expect(r.bytes).toBe(0);
	});
	it('bounds oversized pasted text', () => {
		expect(() => captureText('x'.repeat(100), 'p', 10)).toThrow(CaptureBoundsError);
	});
	it('a non-string input fails NAMED (nil-input shadow path)', () => {
		// @ts-expect-error — exercising the runtime nil guard.
		expect(() => captureText(null)).toThrow(CaptureFetchError);
	});
});
