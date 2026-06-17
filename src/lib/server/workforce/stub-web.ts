// WORKFORCE-SPEC §7b.4 — the RESEARCHER INTERVIEW SUBSTRATE (operator-LOCKED 2026-06-16).
//
// The live web is NON-DETERMINISTIC and CANNOT be the interview substrate (§7b.4), so the
// researcher gauntlet ships a LOCAL STUB SOURCE-SET: a controlled mini-web served by the
// runner on LOOPBACK (mirroring the Thunderstore stub-API precedent — adapters/thunderstore
// thunderstore.test.ts: a node:http server on 127.0.0.1:0, request-recording, ALWAYS closed
// in finally, F-014 process discipline). The candidate researcher's bundle fetch is
// ALLOWLISTED to the stub ONLY — a fetch to any non-stub origin (the live internet) is
// REFUSED. This module is the engine for both halves:
//
//   1. STUB-WEB (serveStubWeb): a loopback HTTP server hosting the fixtures' stub pages.
//      Pages are derived from the fixtures' OWN work (the `page-*.md` entries carry an
//      `<!-- stub-source url: … -->` header — the page's canonical URL). The server maps
//      `GET <path-of-url>` → the page body, records every request (audit), and is closed by
//      the caller (the gauntlet finally-teardown). It serves DATA only; it never executes.
//   2. FETCH ALLOWLIST (assertFetchAllowed / stubFetchGate): the origin-equality predicate
//      a fetch must satisfy — a request URL is permitted ONLY when its origin equals the
//      running stub's loopback origin; ANY other origin throws the named StubFetchRefusedError.
//      These helpers are the SEMANTICS; the ENFORCEMENT is the `fetch-allowlist` gate family
//      (claude-code/gates.ts) the runner arms via SpawnRequest.fetchPolicy = {allowedOrigin:
//      stub.origin}. That gate rides the SAME single evaluator the SDK canUseTool and the CLI
//      PreToolUse hook both consult, so the candidate's built-in WebFetch is allowlisted to
//      the stub on BOTH paths and the live internet is genuinely unreachable in the gauntlet
//      (not merely a prompt sentence) — WebSearch is denied entirely (it reaches the open web).
//
// NON-EXECUTION (D-026): a stub page is DATA. The page bodies are the fixtures' planted
// content; when they reach the candidate they ride the research-rail fence (research.fencePage
// — the SAME D-026 envelope recall uses) so an embedded "ignore your task" can never steer.
// This module serves the bytes; research.ts fences them; neither ever runs page content.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GauntletFixtureRow } from './repo';
import { WorkforceInputError } from './repo';

// ── stub-page model ──────────────────────────────────────────────────────────────────

/** One stub web page: its canonical URL (the `stub-source url:` header) + body bytes. */
export interface StubPage {
	/** The page's canonical (stub) URL — `https://stub.local/...`. */
	url: string;
	/** The page body (markdown/text). Served verbatim; NEVER executed (D-026). */
	body: string;
	/** The fixture slug the page belongs to (audit / corpus grouping). */
	fixture: string;
}

const STUB_URL_HEADER = /<!--\s*stub-source url:\s*(\S+)\s*-->/;

/**
 * Extract the stub pages from a researcher fixture's `work`. A page is any work entry whose
 * content carries the `<!-- stub-source url: … -->` header (the launch-fixtures stubPage()
 * shape). The task brief (`task.md`) and the scorer-control reports are NOT pages — they
 * have no stub-source header and are skipped. Pure + deterministic (no I/O).
 */
export function stubPagesOf(fixture: Pick<GauntletFixtureRow, 'slug' | 'work'>): StubPage[] {
	const pages: StubPage[] = [];
	for (const [rel, content] of Object.entries(fixture.work)) {
		if (typeof content !== 'string') continue;
		const m = STUB_URL_HEADER.exec(content);
		if (!m) continue; // not a stub page (task brief / control report)
		const url = m[1];
		if (!/^https?:\/\/[^\s]+$/i.test(url)) {
			throw new WorkforceInputError(
				`fixture '${fixture.slug}' work entry ${JSON.stringify(rel)} has a malformed stub-source url ${JSON.stringify(url)}`
			);
		}
		pages.push({ url, body: content, fixture: fixture.slug });
	}
	return pages;
}

/** Collect the stub pages across a set of researcher fixtures (the interview corpus). */
export function stubCorpusOf(fixtures: Array<Pick<GauntletFixtureRow, 'slug' | 'work'>>): StubPage[] {
	return fixtures.flatMap((f) => stubPagesOf(f));
}

// ── the loopback stub-web server ───────────────────────────────────────────────────────

/** One recorded stub-web request (audit — proves WHAT the candidate fetched). */
export interface StubRequest {
	method: string;
	/** The path-and-query the server received. */
	path: string;
	/** 404 when the path matched no stub page. */
	status: number;
}

export interface StubWeb {
	/** The loopback origin the stub is bound to — `http://127.0.0.1:<port>`. */
	origin: string;
	/** Map a page's canonical URL to the loopback URL the candidate actually fetches. */
	loopbackUrlFor(canonicalUrl: string): string;
	/** Every request the server received (audit). */
	requests: StubRequest[];
	/** Close the server (MANDATORY — F-014; call in the gauntlet finally-teardown). */
	close(): Promise<void>;
}

/**
 * Serve a researcher interview corpus on LOOPBACK (mirrors the Thunderstore stub precedent).
 * The server binds 127.0.0.1:0 (ephemeral port, loopback ONLY — never a routable address,
 * D-024), maps `GET <pathname-of-the-page-url>` → the page body, and 404s everything else
 * (an unknown path is honestly not-found — never a fabricated page). The page's CANONICAL
 * url (`https://stub.local/blog/x`) is served at the loopback origin under its PATHNAME
 * (`http://127.0.0.1:<port>/blog/x`); loopbackUrlFor() does that rewrite for the caller.
 *
 * The caller MUST close() it (F-014 — the gauntlet finally-teardown). Returns a recording
 * stub so a test can assert the EXACT pages the candidate fetched (red-team: prove the fetch
 * reached the stub and only the stub).
 */
export function serveStubWeb(pages: StubPage[]): Promise<StubWeb> {
	// Index pages by their canonical-url PATHNAME (the loopback path the candidate hits).
	// One stub serves ONE corpus across all of a run's fixtures, so two pages mapping to the
	// same loopback pathname would silently shadow each other (last-write-wins) — a fixture
	// author could ship a gauntlet that serves the WRONG body. Detect the collision and throw
	// (fail loud, never a silent wrong page).
	const byPath = new Map<string, StubPage>();
	for (const p of pages) {
		const path = pathnameOf(p.url);
		const prior = byPath.get(path);
		if (prior) {
			throw new WorkforceInputError(
				`stub-web pathname collision at ${JSON.stringify(path)}: fixture '${prior.fixture}' page ` +
					`${JSON.stringify(prior.url)} and fixture '${p.fixture}' page ${JSON.stringify(p.url)} map to the ` +
					`same loopback path — give them distinct paths (a stub serves one corpus per run)`
			);
		}
		byPath.set(path, p);
	}
	const requests: StubRequest[] = [];
	let origin = '';

	const server: Server = createServer((req, res) => {
		// Drain the body (we never use it — a stub page is a GET) so the socket frees.
		req.on('data', () => {});
		req.on('end', () => {
			const rawPath = (req.url ?? '/').split('#')[0];
			const path = rawPath.split('?')[0];
			const page = byPath.get(path);
			const status = page ? 200 : 404;
			requests.push({ method: req.method ?? 'GET', path: rawPath, status });
			if (page) {
				res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
				res.end(page.body);
			} else {
				res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end(`stub-web: no page at ${path}`);
			}
		});
	});

	return new Promise<StubWeb>((resolve) => {
		// Loopback ONLY (127.0.0.1) — the stub is never reachable off-host (D-024).
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as AddressInfo;
			origin = `http://127.0.0.1:${addr.port}`;
			resolve({
				origin,
				requests,
				loopbackUrlFor(canonicalUrl: string): string {
					return `${origin}${pathnameOf(canonicalUrl)}`;
				},
				close: () => new Promise<void>((r) => server.close(() => r()))
			});
		});
	});
}

/** The pathname (+ no query/hash) of a URL — the loopback path a page is served under. A
 *  malformed URL falls back to a deterministic safe path so the server never throws on it. */
function pathnameOf(url: string): string {
	try {
		const u = new URL(url);
		return u.pathname === '' ? '/' : u.pathname;
	} catch {
		// Not a parseable URL — treat the whole thing as an opaque path (leading slash).
		return url.startsWith('/') ? url : `/${url}`;
	}
}

// ── the fetch allowlist (fail-closed) ────────────────────────────────────────────────────

/**
 * A candidate researcher fetched a URL outside the interview allowlist (the live internet,
 * or any non-stub origin). REFUSED — never silently allowed. A silent allow would let the
 * interview reach the non-deterministic real web, defeating the whole §7b.4 substrate.
 */
export class StubFetchRefusedError extends Error {
	override readonly name = 'StubFetchRefusedError';
	constructor(
		readonly requestedUrl: string,
		readonly allowedOrigin: string
	) {
		super(
			`interview fetch to ${truncate(requestedUrl)} is REFUSED — a researcher interview fetch is ` +
				`allowlisted to the loopback stub-web (${allowedOrigin}) ONLY; the live internet is not ` +
				`reachable in the gauntlet (WORKFORCE-SPEC §7b.4, fail closed)`
		);
	}
}

/**
 * The fetch ALLOWLIST gate (fail-closed). A request URL is permitted ONLY when its origin
 * equals the running stub's loopback origin. ANY other origin — `https://evil.example`,
 * `http://127.0.0.1:<other-port>`, a credentialed `user:pw@…`, or a malformed URL — is
 * REFUSED with the named {@link StubFetchRefusedError}. There is NO allow branch that does
 * not first match the stub origin exactly: a non-match cannot fall through to an allow.
 */
export function assertFetchAllowed(requestedUrl: string, allowedOrigin: string): void {
	let origin: string;
	try {
		origin = new URL(requestedUrl).origin;
	} catch {
		// A URL the platform cannot even parse can never equal the stub origin — refuse.
		throw new StubFetchRefusedError(String(requestedUrl), allowedOrigin);
	}
	if (origin !== allowedOrigin) {
		throw new StubFetchRefusedError(requestedUrl, allowedOrigin);
	}
}

/** A reusable fetch gate bound to one running stub (the shape a runner hands the bundle).
 *  `allowed(url)` is the fail-closed predicate; `assert(url)` throws on refusal. */
export interface StubFetchGate {
	allowedOrigin: string;
	allowed(url: string): boolean;
	assert(url: string): void;
}

/** Build the fetch gate for a running stub-web (the allowlist the interview enforces). */
export function stubFetchGate(stub: Pick<StubWeb, 'origin'>): StubFetchGate {
	const allowedOrigin = stub.origin;
	return {
		allowedOrigin,
		allowed(url: string): boolean {
			try {
				assertFetchAllowed(url, allowedOrigin);
				return true;
			} catch {
				return false;
			}
		},
		assert(url: string): void {
			assertFetchAllowed(url, allowedOrigin);
		}
	};
}

function truncate(s: string, n = 120): string {
	return typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : String(s);
}
