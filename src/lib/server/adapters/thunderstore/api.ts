// TASK 12.2 — the REAL Thunderstore upload API request SHAPE (dry-run produces the exact request
// that WOULD be sent, minus the secret). NO live external call happens in this track (D-026): the
// builder describes the request; the driver records it; the operator supplies the token + confirms
// later. Encoding the real shape now means the eventual live publish is a credential swap, not a
// rewrite.
//
// Thunderstore's experimental publish flow (thunderstore.io/api/docs) is a 3-step upload:
//   1. POST /api/experimental/usermedia/initiate-upload/   → reserve an upload (filename + size)
//      → returns an upload uuid + presigned S3 part URLs.
//   2. PUT each multipart part to its presigned URL, then
//      POST /api/experimental/usermedia/<uuid>/finish-upload/  with the part ETags.
//   3. POST /api/experimental/submission/submit/   with the metadata referencing the upload uuid.
// Auth is `Authorization: Bearer <THUNDERSTORE_TOKEN>` on the Thunderstore-hosted calls.
//
// We model the request as a PLAN of typed steps. The secret is referenced by NAME and represented
// as a redacted placeholder in the rendered request — the value NEVER appears in the plan, a log,
// the DB, or the surface (D-026).

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
 * from the resolver only at the real-call site (which this track does not reach). `namespace`
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
