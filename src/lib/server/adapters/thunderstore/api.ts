// TASK 12.2 — the REAL Thunderstore upload API request SHAPE (dry-run produces the exact request
// that WOULD be sent, minus the secret) + TASK 14.7 — the REAL upload EXECUTION (runbook §0).
// The dry-run builder describes the request; `executeUploadPlan` performs it for real when the
// driver's gate confirm passed AND the operator supplied THUNDERSTORE_TOKEN (D-018/D-026).
//
// Thunderstore's experimental publish flow (thunderstore.io/api/docs) is a 4-step upload:
//   1. POST /api/experimental/usermedia/initiate-upload/   → reserve an upload (filename + size)
//      → returns an upload uuid + presigned S3 part URLs.
//   2. PUT each multipart part to its presigned URL, then
//   3. POST /api/experimental/usermedia/<uuid>/finish-upload/  with the part ETags.
//   4. POST /api/experimental/submission/submit/   with the metadata referencing the upload uuid.
// Auth is `Authorization: Bearer <THUNDERSTORE_TOKEN>` on the Thunderstore-hosted calls (the
// presigned S3 PUTs carry their auth in the URL — no bearer header there).
//
// We model the request as a PLAN of typed steps. The secret is referenced by NAME and represented
// as a redacted placeholder in the rendered request — the value NEVER appears in the plan, a log,
// the DB, or the surface (D-026). The EXECUTION reads the value only at call time, sends it only
// as the Authorization header, and redacts it from every recorded outcome line.

import type { ThunderstoreManifest } from './spec';

/** The redacted stand-in for the bearer secret in any rendered request (D-026 — never a value). */
export const REDACTED_SECRET = '<THUNDERSTORE_TOKEN — supplied from .env at call time>';

/** The Thunderstore community/submission metadata an operator's config supplies. */
export interface ThunderstoreSubmissionConfig {
	/** The Thunderstore team/namespace the package publishes under (the "author"). */
	namespace?: string;
	/** The community ids the package is submitted to (e.g. ["rounds"]). */
	communities?: string[];
	/** Per-community category slugs. */
	categories?: Record<string, string[]>;
	/** NSFW flag (Thunderstore requires it explicitly). */
	hasNsfwContent?: boolean;
	/** Override the API base (defaults to the production host) — e.g. a staging instance. */
	apiBase?: string;
}

/** The default Thunderstore API base. */
export const DEFAULT_API_BASE = 'https://thunderstore.io';

/** One described HTTP request in the upload plan (the shape that WOULD be sent). */
export interface PlannedRequest {
	step: string;
	method: 'POST' | 'PUT';
	url: string;
	headers: Record<string, string>;
	/** A non-secret JSON body description (the secret never appears here). */
	body?: Record<string, unknown>;
	note?: string;
}

/** The full dry-run upload plan: the ordered requests + the resolved submission metadata. */
export interface ThunderstoreUploadPlan {
	apiBase: string;
	namespace: string;
	communities: string[];
	zipFilename: string;
	zipSize: number;
	requests: PlannedRequest[];
	/** True iff the named secret is present (presence only — D-026). */
	tokenPresent: boolean;
}

export interface BuildUploadPlanInput {
	manifest: ThunderstoreManifest;
	config: ThunderstoreSubmissionConfig;
	/** The package zip filename (e.g. "SwipRounds-1.4.0.zip"). */
	zipFilename: string;
	/** The package zip byte size. */
	zipSize: number;
	/** Whether THUNDERSTORE_TOKEN is set (presence only — never the value, D-026). */
	tokenPresent: boolean;
}

/**
 * Build the exact Thunderstore upload request plan that a real publish WOULD send. Deterministic,
 * pure, no network. The bearer secret is rendered as `REDACTED_SECRET` — the actual value is read
 * from the resolver only at the real-call site (`executeUploadPlan`, 14.7). `namespace`
 * defaults to the manifest name's owner is NOT assumed — it MUST come from config (the team is not
 * derivable from the package name), so an absent namespace is surfaced honestly by the caller.
 */
export function buildUploadPlan(input: BuildUploadPlanInput): ThunderstoreUploadPlan {
	const apiBase = (input.config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
	const namespace = input.config.namespace ?? '';
	const communities = input.config.communities ?? [];
	const categories = input.config.categories ?? {};
	const hasNsfw = input.config.hasNsfwContent ?? false;
	const authHeaders = { Authorization: `Bearer ${REDACTED_SECRET}` };

	const requests: PlannedRequest[] = [
		{
			step: 'initiate-upload',
			method: 'POST',
			url: `${apiBase}/api/experimental/usermedia/initiate-upload/`,
			headers: { ...authHeaders, 'Content-Type': 'application/json' },
			body: { filename: input.zipFilename, file_size_bytes: input.zipSize },
			note: 'Reserves the upload; returns an upload uuid + presigned S3 part URLs.'
		},
		{
			step: 'upload-parts',
			method: 'PUT',
			url: '<presigned S3 part URL from initiate-upload>',
			headers: { 'Content-Type': 'application/octet-stream' },
			note: `PUT the ${input.zipSize}-byte zip in one or more parts to the presigned URLs (no auth header — the presigned URL carries it).`
		},
		{
			step: 'finish-upload',
			method: 'POST',
			url: `${apiBase}/api/experimental/usermedia/<upload-uuid>/finish-upload/`,
			headers: { ...authHeaders, 'Content-Type': 'application/json' },
			body: { parts: [{ part_number: 1, ETag: '<etag from the PUT response>' }] },
			note: 'Finalizes the multipart upload with the per-part ETags.'
		},
		{
			step: 'submit',
			method: 'POST',
			url: `${apiBase}/api/experimental/submission/submit/`,
			headers: { ...authHeaders, 'Content-Type': 'application/json' },
			body: {
				author_name: namespace,
				communities,
				community_categories: categories,
				has_nsfw_content: hasNsfw,
				upload_uuid: '<upload-uuid from initiate-upload>'
			},
			note: 'Creates the package version from the finished upload under the team/communities.'
		}
	];

	return {
		apiBase,
		namespace,
		communities,
		zipFilename: input.zipFilename,
		zipSize: input.zipSize,
		requests,
		tokenPresent: input.tokenPresent
	};
}

/** Render the plan as ordered human-readable step lines for the dry-run surface (no secret). */
export function planToSteps(plan: ThunderstoreUploadPlan): string[] {
	return plan.requests.map(
		(r) => `${r.method} ${r.url}${r.body ? ` body=${JSON.stringify(r.body)}` : ''}`
	);
}

// ── TASK 14.7 — REAL upload execution (runbook §0) ──────────────────────────────────────
//
// Performed ONLY by adapter.publish(dryRun:false) after the driver's confirm gate (D-018) when
// THUNDERSTORE_TOKEN is present. Every step is wall-clock-bounded (AbortSignal.timeout — never a
// spin, F-014 discipline) and reports an HONEST per-step outcome (which step, HTTP status, a
// short response excerpt) so a mid-flight failure lands legibly in target_run.steps + the
// incident (F-008). The bearer value is sent only as the Authorization header and is REDACTED
// from every recorded line (D-026).

/** The four canonical upload step names (the same ids the dry-run plan uses). */
export type UploadStepName = 'initiate-upload' | 'upload-parts' | 'finish-upload' | 'submit';

/** One executed step's honest outcome (no secret ever appears in `detail`). */
export interface UploadStepOutcome {
	step: UploadStepName;
	ok: boolean;
	/** Honest human line: HTTP status + a short response excerpt, or the timeout/network error. */
	detail: string;
}

export interface ExecuteUploadInput {
	apiBase: string;
	/** The REAL bearer value (resolver.get at call time). NEVER echoed into any outcome (D-026). */
	token: string;
	zip: Uint8Array;
	zipFilename: string;
	namespace: string;
	communities: string[];
	categories: Record<string, string[]>;
	hasNsfwContent: boolean;
	/** Per-step wall-clock bound in ms (default 30s; clamped 1s–120s). Bounded, never a spin. */
	stepTimeoutMs?: number;
	/** Injectable fetch (tests point this at a local stub server — NO real upload in tests). */
	fetchImpl?: typeof fetch;
}

export interface ExecuteUploadResult {
	ok: boolean;
	/** Every ATTEMPTED step in order — honest; steps after a failure are not attempted. */
	steps: UploadStepOutcome[];
	/** The failing step when not ok. */
	failedStep?: UploadStepName;
}

/** Default + clamp bounds for the per-step upload timeout. */
const STEP_TIMEOUT_DEFAULT_MS = 30_000;
const STEP_TIMEOUT_MIN_MS = 1_000;
const STEP_TIMEOUT_MAX_MS = 120_000;

/** Clamp a configured ms value into [min,max], falling back to `dflt` when absent/invalid. */
export function clampMs(value: unknown, dflt: number, min: number, max: number): number {
	const n = typeof value === 'number' && Number.isFinite(value) ? value : dflt;
	return Math.min(max, Math.max(min, Math.round(n)));
}

/** Truncate a response body for an honest-but-short outcome line; redact the bearer value. */
function excerpt(text: string, token: string): string {
	const safe = token ? text.split(token).join('<redacted>') : text;
	const oneLine = safe.replace(/\s+/g, ' ').trim();
	return oneLine.length > 300 ? `${oneLine.slice(0, 297)}…` : oneLine;
}

/** A presigned part URL from initiate-upload (defensively parsed — fields Thunderstore sends). */
interface UploadPartUrl {
	part_number: number;
	url: string;
	offset: number;
	length: number;
}

/** Parse the initiate-upload response into { uuid, parts } — null when the shape is unusable. */
function parseInitiate(body: unknown, zipSize: number): { uuid: string; parts: UploadPartUrl[] } | null {
	if (body == null || typeof body !== 'object') return null;
	const o = body as Record<string, unknown>;
	const media = (o.user_media ?? o) as Record<string, unknown>;
	const uuid = typeof media.uuid === 'string' ? media.uuid : typeof o.uuid === 'string' ? String(o.uuid) : '';
	if (!uuid) return null;
	const raw = Array.isArray(o.upload_urls) ? o.upload_urls : [];
	const parts: UploadPartUrl[] = [];
	for (const p of raw) {
		if (p == null || typeof p !== 'object') continue;
		const r = p as Record<string, unknown>;
		const url = typeof r.url === 'string' ? r.url : '';
		if (!url) continue;
		parts.push({
			part_number: typeof r.part_number === 'number' ? r.part_number : parts.length + 1,
			url,
			offset: typeof r.offset === 'number' ? r.offset : 0,
			length: typeof r.length === 'number' ? r.length : zipSize
		});
	}
	return parts.length > 0 ? { uuid, parts } : null;
}

/**
 * Execute the REAL 4-step Thunderstore upload (initiate → PUT parts → finish → submit). Stops at
 * the FIRST failing step (a partial upload is never silently continued) and returns the honest
 * per-step trail either way. Network/timeout errors are caught into the failing step's outcome —
 * this function never throws for a remote failure. NO retry loops (F-014: bounded, no spin; the
 * runbook §8 "bump-don't-retry" rule belongs to the operator, not this code).
 */
export async function executeUploadPlan(input: ExecuteUploadInput): Promise<ExecuteUploadResult> {
	const f = input.fetchImpl ?? fetch;
	const apiBase = input.apiBase.replace(/\/+$/, '');
	const timeoutMs = clampMs(input.stepTimeoutMs, STEP_TIMEOUT_DEFAULT_MS, STEP_TIMEOUT_MIN_MS, STEP_TIMEOUT_MAX_MS);
	const auth = { Authorization: `Bearer ${input.token}` };
	const steps: UploadStepOutcome[] = [];
	const fail = (step: UploadStepName, detail: string): ExecuteUploadResult => {
		steps.push({ step, ok: false, detail: excerpt(detail, input.token) });
		return { ok: false, steps, failedStep: step };
	};

	// One bounded request; network errors/timeouts come back as a string, never a throw.
	async function call(
		url: string,
		init: RequestInit
	): Promise<{ res: Response; text: string } | { error: string }> {
		try {
			const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
			const text = await res.text();
			return { res, text };
		} catch (err) {
			const e = err as Error;
			return {
				error:
					e.name === 'TimeoutError' || e.name === 'AbortError'
						? `timed out after ${timeoutMs}ms`
						: `network error: ${e.message}`
			};
		}
	}

	// Step 1 — initiate-upload: reserve the upload, get the uuid + presigned part URLs.
	const initiate = await call(`${apiBase}/api/experimental/usermedia/initiate-upload/`, {
		method: 'POST',
		headers: { ...auth, 'Content-Type': 'application/json' },
		body: JSON.stringify({ filename: input.zipFilename, file_size_bytes: input.zip.length })
	});
	if ('error' in initiate) return fail('initiate-upload', initiate.error);
	if (!initiate.res.ok) return fail('initiate-upload', `HTTP ${initiate.res.status}: ${initiate.text}`);
	let parsed: ReturnType<typeof parseInitiate>;
	try {
		parsed = parseInitiate(JSON.parse(initiate.text), input.zip.length);
	} catch {
		parsed = null;
	}
	if (!parsed) {
		return fail('initiate-upload', `HTTP ${initiate.res.status} but the response carried no upload uuid/part URLs: ${initiate.text}`);
	}
	steps.push({
		step: 'initiate-upload',
		ok: true,
		detail: excerpt(`HTTP ${initiate.res.status}: upload ${parsed.uuid} reserved, ${parsed.parts.length} part(s)`, input.token)
	});

	// Step 2 — PUT each part to its presigned URL (no bearer header — the URL carries auth).
	const etags: Array<{ part_number: number; ETag: string }> = [];
	for (const part of parsed.parts) {
		const end = Math.min(part.offset + part.length, input.zip.length);
		const slice = input.zip.slice(part.offset, end);
		const put = await call(part.url, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: slice
		});
		if ('error' in put) return fail('upload-parts', `part ${part.part_number}: ${put.error}`);
		if (!put.res.ok) return fail('upload-parts', `part ${part.part_number}: HTTP ${put.res.status}: ${put.text}`);
		const etag = put.res.headers.get('etag') ?? put.res.headers.get('ETag') ?? '';
		if (!etag) return fail('upload-parts', `part ${part.part_number}: HTTP ${put.res.status} but no ETag header in the response`);
		etags.push({ part_number: part.part_number, ETag: etag });
	}
	steps.push({
		step: 'upload-parts',
		ok: true,
		detail: `${etags.length} part(s) uploaded (${input.zip.length} bytes total)`
	});

	// Step 3 — finish-upload with the per-part ETags.
	const finish = await call(`${apiBase}/api/experimental/usermedia/${parsed.uuid}/finish-upload/`, {
		method: 'POST',
		headers: { ...auth, 'Content-Type': 'application/json' },
		body: JSON.stringify({ parts: etags })
	});
	if ('error' in finish) return fail('finish-upload', finish.error);
	if (!finish.res.ok) return fail('finish-upload', `HTTP ${finish.res.status}: ${finish.text}`);
	steps.push({ step: 'finish-upload', ok: true, detail: excerpt(`HTTP ${finish.res.status}`, input.token) });

	// Step 4 — submit the package version from the finished upload.
	const submit = await call(`${apiBase}/api/experimental/submission/submit/`, {
		method: 'POST',
		headers: { ...auth, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			author_name: input.namespace,
			communities: input.communities,
			community_categories: input.categories,
			has_nsfw_content: input.hasNsfwContent,
			upload_uuid: parsed.uuid
		})
	});
	if ('error' in submit) return fail('submit', submit.error);
	if (!submit.res.ok) return fail('submit', `HTTP ${submit.res.status}: ${submit.text}`);
	steps.push({ step: 'submit', ok: true, detail: excerpt(`HTTP ${submit.res.status}: ${submit.text}`, input.token) });

	return { ok: true, steps };
}

// ── TASK 14.7 — post-publish visibility poll (adapter.verify) ───────────────────────────
//
// Polls the PUBLIC package-version endpoint (no auth — nothing secret can leak) until the new
// version is visible, bounded in wall-clock (~2 min default). An honest timeout returns
// visible:false with the last observed status — the caller (driver) records the incident.

export interface PollVisibleInput {
	apiBase: string;
	namespace: string;
	name: string;
	version: string;
	/** Total wall-clock bound in ms (default 120s; clamped 1s–10min). */
	timeoutMs?: number;
	/** Delay between polls in ms (default 5s; clamped 10ms–30s). */
	intervalMs?: number;
	/** Injectable fetch (tests point this at a local stub server). */
	fetchImpl?: typeof fetch;
}

export interface PollVisibleResult {
	visible: boolean;
	attempts: number;
	elapsedMs: number;
	/** The polled endpoint (public, non-secret) — surfaced so the operator can check manually. */
	url: string;
	/** Honest last observation (HTTP status / timeout / network error). */
	detail: string;
}

export const VERIFY_TIMEOUT_DEFAULT_MS = 120_000;
const VERIFY_TIMEOUT_MIN_MS = 1_000;
const VERIFY_TIMEOUT_MAX_MS = 600_000;
const VERIFY_INTERVAL_DEFAULT_MS = 5_000;
const VERIFY_INTERVAL_MIN_MS = 10;
const VERIFY_INTERVAL_MAX_MS = 30_000;

/** The public package-version endpoint a verify polls (exported for the dry-run surface/tests). */
export function packageVersionUrl(apiBase: string, namespace: string, name: string, version: string): string {
	const base = apiBase.replace(/\/+$/, '');
	return `${base}/api/experimental/package/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/`;
}

/**
 * Poll until the package version is visible (HTTP 200) or the deadline passes. Bounded, never a
 * spin (F-014): each request is itself timeout-bounded, the loop sleeps `intervalMs` between
 * attempts, and the whole poll stops at `timeoutMs`. Never throws — every outcome is honest data.
 */
export async function pollPackageVisible(input: PollVisibleInput): Promise<PollVisibleResult> {
	const f = input.fetchImpl ?? fetch;
	const url = packageVersionUrl(input.apiBase, input.namespace, input.name, input.version);
	const timeoutMs = clampMs(input.timeoutMs, VERIFY_TIMEOUT_DEFAULT_MS, VERIFY_TIMEOUT_MIN_MS, VERIFY_TIMEOUT_MAX_MS);
	const intervalMs = clampMs(input.intervalMs, VERIFY_INTERVAL_DEFAULT_MS, VERIFY_INTERVAL_MIN_MS, VERIFY_INTERVAL_MAX_MS);
	const startedAt = Date.now();
	let attempts = 0;
	let lastDetail = 'no request made';

	while (Date.now() - startedAt <= timeoutMs) {
		attempts++;
		try {
			// Each probe is bounded by the SHORTER of 10s and the remaining budget.
			const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
			const res = await f(url, { method: 'GET', signal: AbortSignal.timeout(Math.min(10_000, remaining)) });
			// Drain the body so the socket is released (we only need the status).
			await res.text().catch(() => '');
			if (res.ok) {
				return { visible: true, attempts, elapsedMs: Date.now() - startedAt, url, detail: `HTTP ${res.status}` };
			}
			lastDetail = `HTTP ${res.status}`;
		} catch (err) {
			const e = err as Error;
			lastDetail =
				e.name === 'TimeoutError' || e.name === 'AbortError' ? 'request timed out' : `network error: ${e.message}`;
		}
		// Sleep between attempts, but never past the deadline.
		const left = timeoutMs - (Date.now() - startedAt);
		if (left <= 0) break;
		await new Promise((r) => setTimeout(r, Math.min(intervalMs, left)));
	}

	return { visible: false, attempts, elapsedMs: Date.now() - startedAt, url, detail: lastDetail };
}
