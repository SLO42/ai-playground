// BL-6 CANNIBALIZE-SPEC §2.5/§7/§10.2 — the CAPTURE layer.
//
// The first pipeline stage (CANNIBALIZE-SPEC §4): take an operator request — a URL, a
// repo path, or pasted text/a file — and produce RAW captured content + a candidate
// provenance record, BOUNDED and SSRF-SAFE. Nothing here reaches the brain: downstream
// (a later wave) runs distill → screen() → fence() → embed → ingest. This module's ONE
// job is to fetch/read external content SAFELY and attach honest provenance.
//
// LOCKED INVARIANTS enforced here (CANNIBALIZE-SPEC §2.5 / §7, F-014/D-024/D-018):
//   • URL fetch is SSRF-SAFE: loopback/private/link-local/metadata targets are REFUSED
//     BEFORE connect (literal-IP host) AND after DNS resolution (defeat DNS-rebind —
//     resolve, re-check every resolved address, then connect by IP via a pinned lookup).
//   • Fetch is SIZE + TIME bounded (no spin): an AbortController time bound + a streamed
//     byte cap that aborts mid-body so an oversized/slow source cannot exhaust us.
//   • Repo / file read is CONFINED under CODE_ROOT (D-018), READ-ONLY, via the canonical
//     resolveConfinedTarget (symlink + `..` resolved BEFORE the prefix check, fail-closed).
//   • Every error has a NAME (the trigger, the catcher, what the caller sees) — never a
//     catch-all. SSRF → SsrfBlockedError; bound → CaptureBoundsError; transport →
//     CaptureFetchError; path escape → PathConfinementError (reused).
//
// Provenance is a CANDIDATE here (kind/ref/intent/license) — the ingest_source row (m0042)
// is written downstream once the operator's intent is screened. `ref` is the NON-secret
// locator (D-026); `license` is unknown until distill, hence optional.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolveConfinedTarget } from '../claude-code/guardrails';

// ── Bounds (F-014/D-024) — defaults; callers may tighten, never loosen past these ──────

/** Wall-clock cap on a single URL fetch (connect + body). */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
/** Hard byte cap on a fetched body — aborts mid-stream past this (no exhaustion). */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
/** Cap on a confined file read (same exhaustion class as a fetch body). */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Max HTTP redirects to follow — each hop is re-screened for SSRF. */
export const DEFAULT_MAX_REDIRECTS = 3;

// ── Provenance (candidate) ─────────────────────────────────────────────────────────────

export type IngestKind = 'url' | 'repo' | 'file' | 'text';

/** A candidate provenance record — becomes an ingest_source row (m0042) downstream. */
export interface CaptureProvenance {
	kind: IngestKind;
	/** The url / repo / path / a synthetic label for pasted text — NON-secret (D-026). */
	ref: string;
	/** Declared/derived license/consent for code-lifting (§2.2) — unknown until distilled. */
	license?: string;
}

/** Raw captured content + its candidate provenance. NOT yet screened/fenced/ingested. */
export interface CaptureResult {
	raw: string;
	provenance: CaptureProvenance;
	/** Honest size of the captured body in bytes (post-bound). */
	bytes: number;
}

// ── Named errors (every error has a name) ───────────────────────────────────────────────

/**
 * An SSRF-class target was REFUSED: the host (literal IP) or one of its RESOLVED addresses
 * is loopback / private / link-local / a cloud metadata endpoint, or the scheme/host is not
 * a fetchable public target. Trigger: capture* sees such a target. Catcher: assertPublicHost
 * / the pinned-lookup re-check. Caller sees: this typed refusal — the chunk is NEVER fetched.
 */
export class SsrfBlockedError extends Error {
	override readonly name = 'SsrfBlockedError';
	constructor(
		message: string,
		readonly target: string,
		/** The specific resolved/literal address that tripped the guard, when known. */
		readonly address?: string
	) {
		super(message);
	}
}

/**
 * A fetch/read exceeded a BOUND (time or size). Trigger: the AbortController time bound
 * fires, or the streamed body / file crossed its byte cap. Catcher: fetchBounded's reader /
 * the abort handler. Caller sees: this typed bound — no spin, no partial-into-the-brain.
 */
export class CaptureBoundsError extends Error {
	override readonly name = 'CaptureBoundsError';
	constructor(
		message: string,
		readonly kind: 'timeout' | 'size',
		readonly limit: number
	) {
		super(message);
	}
}

/**
 * A transport-level fetch failure that is NOT an SSRF refusal and NOT a bound: DNS NXDOMAIN,
 * connection reset, a non-2xx HTTP status, a redirect loop / too many redirects, a bad URL.
 * Trigger: the underlying fetch/connect throws or returns non-OK. Catcher: captureUrl.
 * Caller sees: this typed failure naming WHICH channel failed — never a silent empty success.
 */
export class CaptureFetchError extends Error {
	override readonly name = 'CaptureFetchError';
	constructor(
		message: string,
		readonly target: string,
		/** http status when the failure was a non-2xx response. */
		readonly status?: number
	) {
		super(message);
	}
}

// ── SSRF address classification ─────────────────────────────────────────────────────────

/**
 * True iff a literal IP string is a target we must REFUSE: loopback, private (RFC1918),
 * link-local (incl. the 169.254.169.254 cloud-metadata endpoint), unique-local IPv6
 * (fc00::/7), IPv4-mapped IPv6 of any of the above, unspecified, and CGNAT (100.64/10).
 * Conservative/fail-closed: anything we cannot positively classify as public is blocked.
 */
export function isBlockedIp(ip: string): boolean {
	const v = isIP(ip);
	if (v === 4) return isBlockedIpv4(ip);
	if (v === 6) return isBlockedIpv6(ip.toLowerCase());
	return true; // not a valid IP literal → fail closed
}

function isBlockedIpv4(ip: string): boolean {
	const o = ip.split('.').map((x) => Number(x));
	if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = o;
	if (a === 0) return true; // 0.0.0.0/8 "this network" / unspecified
	if (a === 127) return true; // loopback
	if (a === 10) return true; // RFC1918
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
	if (a === 192 && b === 168) return true; // RFC1918
	if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
	if (a >= 224) return true; // multicast / reserved (224+)
	return false;
}

function isBlockedIpv6(ip: string): boolean {
	if (ip === '::1' || ip === '::') return true; // loopback / unspecified
	if (ip.startsWith('fe80') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
		return true; // link-local fe80::/10
	}
	if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local fc00::/7
	if (ip.startsWith('ff')) return true; // multicast
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — re-check the embedded v4.
	const mapped = ip.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isBlockedIpv4(mapped[1]);
	return false;
}

/**
 * Parse + validate a URL for fetching: only http/https, a non-empty host. A literal-IP host
 * is classified immediately (no DNS). A NAMED hostname is left for the resolve-then-re-check
 * step (defeats DNS-rebind: we cannot trust a name's A/AAAA until WE resolve it). Throws
 * SsrfBlockedError for a non-fetchable scheme or a literal-IP that is blocked.
 */
export function parseFetchTarget(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new SsrfBlockedError(`not a valid absolute URL: ${raw}`, raw);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new SsrfBlockedError(`refused non-http(s) scheme '${url.protocol}' (SSRF/file/gopher guard)`, raw);
	}
	const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
	if (!host) throw new SsrfBlockedError('refused empty host', raw);
	// A bare literal IP host: classify now (no DNS round-trip).
	if (isIP(host) !== 0) {
		if (isBlockedIp(host)) {
			throw new SsrfBlockedError(`refused private/loopback/link-local literal host: ${host}`, raw, host);
		}
	}
	return url;
}

/**
 * Resolve a hostname to ALL its addresses and refuse if ANY is blocked (defeat DNS-rebind:
 * a name that points partly at a public IP and partly at 169.254.169.254 is refused). The
 * returned addresses are then PINNED for the actual connect so the kernel cannot re-resolve
 * to a different (internal) address between our check and the socket (TOCTOU). Injectable
 * `resolveAll` so tests can simulate a rebind without real DNS.
 */
export type ResolveAll = (host: string) => Promise<string[]>;

const defaultResolveAll: ResolveAll = (host) =>
	new Promise((resolve, reject) => {
		// all:true → every A/AAAA record; verbatim:false is irrelevant (we re-check all).
		dnsLookup(host, { all: true }, (err, addrs) => {
			if (err) reject(err);
			else resolve(addrs.map((a) => a.address));
		});
	});

/**
 * Resolve `host` and assert EVERY address is public; return the pinned address list. A
 * literal-IP host short-circuits (already classified). Throws SsrfBlockedError on the first
 * blocked address, CaptureFetchError if the name does not resolve at all.
 */
export async function resolvePublicAddresses(
	host: string,
	target: string,
	resolveAll: ResolveAll = defaultResolveAll
): Promise<string[]> {
	if (isIP(host) !== 0) {
		if (isBlockedIp(host)) throw new SsrfBlockedError(`refused private/loopback literal host: ${host}`, target, host);
		return [host];
	}
	let addrs: string[];
	try {
		addrs = await resolveAll(host);
	} catch (err) {
		throw new CaptureFetchError(`DNS resolution failed for ${host}: ${(err as Error).message}`, target);
	}
	if (addrs.length === 0) throw new CaptureFetchError(`DNS returned no addresses for ${host}`, target);
	for (const a of addrs) {
		if (isBlockedIp(a)) {
			throw new SsrfBlockedError(
				`refused host ${host} — it resolves to a private/loopback/metadata address ${a} (DNS-rebind guard)`,
				target,
				a
			);
		}
	}
	return addrs;
}

// ── Bounded, SSRF-safe fetch ─────────────────────────────────────────────────────────────

export interface FetchOptions {
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
	/**
	 * Injectable single-hop HTTP transport for tests — given a fully-screened target, returns
	 * a status, headers, and a body stream. Defaults to the built-in node:http(s) transport
	 * whose custom `lookup` re-screens + pins EVERY resolved address at socket-connect (the
	 * rebind defense). Tests pass a fake to exercise redirects/bounds without a live server.
	 */
	transport?: HttpTransport;
	/** Injectable DNS resolver for the resolve-then-re-check step (tests). */
	resolveAll?: ResolveAll;
}

/** One HTTP hop's outcome: status, headers (lowercased keys), and a Node readable body stream. */
export interface HttpResponse {
	status: number;
	headers: Record<string, string | undefined>;
	/** Async byte chunks of the body. */
	body: AsyncIterable<Uint8Array>;
}

/** A single-hop GET. MUST itself enforce the per-address SSRF screen at connect (the default does). */
export type HttpTransport = (url: URL, signal: AbortSignal, resolveAll: ResolveAll) => Promise<HttpResponse>;

/**
 * The default transport: a node:http(s) GET whose `lookup` callback re-screens + PINS every
 * resolved address at socket-connect time. The lookup is what the kernel uses to obtain the
 * connect address, so screening THERE closes the TOCTOU between our pre-check and the socket
 * (a name that rebinds to 169.254.169.254 between the pre-check and connect is refused at
 * connect, not followed). Bound by the AbortSignal. No redirect-follow here — the caller
 * (`fetchBounded`) follows + re-screens each hop itself.
 */
const nodeHttpTransport: HttpTransport = (url, signal) =>
	new Promise<HttpResponse>((resolve, reject) => {
		const lib = url.protocol === 'https:' ? https : http;
		// The rebind-defeating lookup: every address the kernel would connect to is screened here.
		const screeningLookup: typeof dnsLookup = ((host: string, optsOrCb: unknown, maybeCb?: unknown) => {
			const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
				err: NodeJS.ErrnoException | null,
				address: string | LookupAddress[],
				family?: number
			) => void;
			dnsLookup(host, { all: true }, (err, addrs) => {
				if (err) return cb(err, '', 0);
				const ok = addrs.find((a) => !isBlockedIp(a.address));
				if (!ok) {
					return cb(
						new SsrfBlockedError(`connect refused — ${host} resolved only to private/loopback/metadata addresses (rebind guard)`, host) as NodeJS.ErrnoException,
						'',
						0
					);
				}
				cb(null, ok.address, ok.family);
			});
		}) as unknown as typeof dnsLookup;

		const req = lib.request(
			url,
			{ method: 'GET', signal, lookup: screeningLookup },
			(res) => {
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers as Record<string, string | undefined>,
					body: res as unknown as AsyncIterable<Uint8Array>
				});
			}
		);
		req.on('error', (err) => reject(err));
		req.end();
	});

/**
 * Read a body stream with a HARD byte cap, destroying the stream the moment the cap is
 * crossed — never buffers the whole oversized body first. Throws CaptureBoundsError('size').
 */
async function readBounded(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ text: string; bytes: number }> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of body) {
		total += chunk.byteLength;
		if (total > maxBytes) {
			// Destroy the underlying stream if it exposes destroy() (node IncomingMessage does).
			(body as { destroy?: () => void }).destroy?.();
			throw new CaptureBoundsError(`response body exceeded ${maxBytes} bytes (aborted mid-stream)`, 'size', maxBytes);
		}
		chunks.push(Buffer.from(chunk));
	}
	const buf = Buffer.concat(chunks);
	return { text: buf.toString('utf8'), bytes: total };
}

/**
 * Bounded, SSRF-safe HTTP(S) GET. Manually follows redirects, re-screening EVERY hop's
 * target for SSRF (a 302 to http://169.254.169.254 is refused at the hop, not blindly
 * followed). Time-bounded by an AbortController; size-bounded by readBounded; rebind-defeated
 * by resolvePublicAddresses (pre-check) + the transport's connect-time screening lookup.
 * Throws SsrfBlockedError / CaptureBoundsError / CaptureFetchError.
 */
export async function fetchBounded(rawUrl: string, opts: FetchOptions = {}): Promise<{ text: string; bytes: number; finalUrl: string }> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const transport = opts.transport ?? nodeHttpTransport;
	const resolveAll = opts.resolveAll ?? defaultResolveAll;

	let current = parseFetchTarget(rawUrl);
	const seen = new Set<string>();

	for (let hop = 0; hop <= maxRedirects; hop++) {
		const target = current.toString();
		if (seen.has(target)) throw new CaptureFetchError(`redirect loop detected at ${target}`, target);
		seen.add(target);

		// (1) Pre-check: resolve + screen EVERY address (defeat DNS-rebind) BEFORE we connect.
		//     The transport's connect-time lookup re-screens to close the TOCTOU.
		const host = current.hostname.replace(/^\[|\]$/g, '');
		await resolvePublicAddresses(host, target, resolveAll);

		const ac = new AbortController();
		const timer = setTimeout(
			() => ac.abort(new CaptureBoundsError(`fetch exceeded ${timeoutMs}ms`, 'timeout', timeoutMs)),
			timeoutMs
		);
		let res: HttpResponse;
		try {
			res = await transport(current, ac.signal, resolveAll);
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof SsrfBlockedError || err instanceof CaptureBoundsError) throw err;
			const e = err as Error & { cause?: unknown };
			if (e.cause instanceof SsrfBlockedError || e.cause instanceof CaptureBoundsError) throw e.cause;
			if (ac.signal.aborted && ac.signal.reason instanceof CaptureBoundsError) throw ac.signal.reason;
			// A connect-time SSRF refusal arrives as an aborted/errored request whose message
			// carries our marker — surface it as the named SSRF error, not a generic transport one.
			if (/rebind guard|private\/loopback/i.test(e.message)) {
				throw new SsrfBlockedError(e.message, target);
			}
			throw new CaptureFetchError(`fetch transport failure for ${target}: ${e.message}`, target);
		}

		// Manual redirect handling — re-loop with the new (re-screened next iteration) target.
		if (res.status >= 300 && res.status < 400) {
			clearTimeout(timer);
			const loc = res.headers['location'];
			if (!loc) throw new CaptureFetchError(`redirect (${res.status}) with no Location from ${target}`, target, res.status);
			current = parseFetchTarget(new URL(loc, target).toString());
			continue;
		}

		if (res.status < 200 || res.status >= 300) {
			clearTimeout(timer);
			throw new CaptureFetchError(`non-2xx response ${res.status} from ${target}`, target, res.status);
		}

		// Content-Length pre-check (cheap reject before streaming).
		const cl = Number(res.headers['content-length']);
		if (Number.isFinite(cl) && cl > maxBytes) {
			clearTimeout(timer);
			throw new CaptureBoundsError(`declared Content-Length ${cl} exceeds ${maxBytes} bytes`, 'size', maxBytes);
		}

		try {
			const { text, bytes } = await readBounded(res.body, maxBytes);
			return { text, bytes, finalUrl: target };
		} catch (err) {
			if (ac.signal.aborted && ac.signal.reason instanceof CaptureBoundsError) throw ac.signal.reason;
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}
	throw new CaptureFetchError(`exceeded ${maxRedirects} redirects`, rawUrl);
}

// ── Public capture entry points (URL / repo / file / text) ───────────────────────────────

/** Capture a URL: SSRF-safe + bounded fetch → raw body + url provenance. */
export async function captureUrl(rawUrl: string, opts: FetchOptions = {}): Promise<CaptureResult> {
	const { text, bytes, finalUrl } = await fetchBounded(rawUrl, opts);
	return { raw: text, bytes, provenance: { kind: 'url', ref: finalUrl } };
}

export interface ConfinedReadOptions {
	/** Confinement root (CODE_ROOT) — the target MUST resolve under this (D-018). */
	codeRoot: string;
	maxBytes?: number;
}

/**
 * Capture a confined REPO/FILE read (read-only, D-018). `target` is resolved + confined
 * under CODE_ROOT via the canonical resolveConfinedTarget (symlink + `..` resolved BEFORE
 * the prefix check, fail-closed) → a `..`/symlink escape throws PathConfinementError. Size
 * bounded. `kind` distinguishes a single file ('file') from a repo entry-point ('repo').
 */
async function captureConfined(target: string, kind: 'repo' | 'file', opts: ConfinedReadOptions): Promise<CaptureResult> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
	// resolveConfinedTarget throws PathConfinementError on a `..`/symlink escape (fail-closed).
	const abs = resolveConfinedTarget(target, opts.codeRoot);
	const st = await stat(abs);
	if (st.isDirectory()) {
		throw new CaptureFetchError(`confined target is a directory, expected a file: ${target}`, target);
	}
	if (st.size > maxBytes) {
		throw new CaptureBoundsError(`confined file ${st.size} bytes exceeds ${maxBytes}`, 'size', maxBytes);
	}
	const raw = await readFile(abs, 'utf8');
	return { raw, bytes: Buffer.byteLength(raw, 'utf8'), provenance: { kind, ref: target } };
}

/** Capture a repo entry-point file (read-only, CODE_ROOT-confined, D-018). */
export function captureRepo(target: string, opts: ConfinedReadOptions): Promise<CaptureResult> {
	return captureConfined(target, 'repo', opts);
}

/** Capture a single file (read-only, CODE_ROOT-confined, D-018). */
export function captureFile(target: string, opts: ConfinedReadOptions): Promise<CaptureResult> {
	return captureConfined(target, 'file', opts);
}

/**
 * Capture pasted TEXT — already in hand, so no fetch/read, just a bound + a synthetic
 * provenance. `label` is a NON-secret human marker for the source (e.g. "pasted-2026-06-15").
 */
export function captureText(text: string, label = 'pasted-text', maxBytes = DEFAULT_MAX_BYTES): CaptureResult {
	if (typeof text !== 'string') {
		throw new CaptureFetchError(`text capture expects a string, got ${text === null ? 'null' : typeof text}`, label);
	}
	const bytes = Buffer.byteLength(text, 'utf8');
	if (bytes > maxBytes) {
		throw new CaptureBoundsError(`pasted text ${bytes} bytes exceeds ${maxBytes}`, 'size', maxBytes);
	}
	return { raw: text, bytes, provenance: { kind: 'text', ref: label } };
}
