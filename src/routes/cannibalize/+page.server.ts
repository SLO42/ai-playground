// BL-6 CANNIBALIZE-SPEC §5 — /cannibalize: the Ingest front door (the operator capability that
// grows the brain's ecosystem). A natural-language INTENT + one INPUT (a URL, a CODE_ROOT-confined
// repo path/file, or pasted text) → "Ingest" → the server runs CB1 capture (bounded, SSRF-safe) +
// CB2 ingestCaptured (distill→screen→fence→embed→ingest, provenance + license on every finding) →
// LIVE progress + RESULTS. The page subscribes to the `ingest_source` SSE watcher so each run
// walks its status enum (capturing→distilling→ingesting→done|quarantined|failed) in place.
//
// Capability-gated (§2.3, fail-closed): ingest WRITES THROUGH the memory store path, which needs
// the embedder (qwen3 via Ollama). getMemoryService is the honest gate — no embedder ⇒ the action
// fails closed with the actionable reason (F-008/D-024), never a fabricated success. This surface
// is the OPERATOR's own loopback dashboard (D-026); a project session cannot reach it.
//
// Read-only beyond the ingest trigger (the spec): the load lists recent runs; nothing here mutates
// except the `ingest` action. Honest states throughout (F-008): DB down → connected:false.

import { fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { getMemoryService } from '$lib/server/harness/wiring';
import { assertRecordId } from '$lib/server/db/validate';
import {
	captureUrl,
	captureText,
	captureRepo,
	captureFile,
	SsrfBlockedError,
	CaptureBoundsError,
	CaptureFetchError,
	type CaptureResult
} from '$lib/server/cannibalize/capture';
import {
	ingestCaptured,
	listIngestSources,
	plainDistill,
	DistillTimeoutError,
	DistillFailedError,
	type IngestSourceView,
	type IngestResult
} from '$lib/server/cannibalize/ingest';
import { PathConfinementError } from '$lib/server/claude-code/guardrails';
import type { Actions, PageServerLoad } from './$types';

export interface CannibalizePageData {
	/** True once the runtime DB singleton is connected (else honest disconnected). */
	connected: boolean;
	/** Recent ingest runs, newest first (live via the `ingest_source` watcher). */
	sources: IngestSourceView[];
	/** The configured CODE_ROOT for repo/file confinement (display only; D-018). */
	codeRoot: string;
}

/** The confinement root for repo/file capture (D-018). Falls back to cwd when unset. */
function codeRoot(): string {
	return process.env.CODE_ROOT?.trim() || process.cwd();
}

export const load: PageServerLoad = async ({ depends }): Promise<CannibalizePageData> => {
	// Live re-invalidation key: an ingest_source row change re-runs this loader (§2.11).
	depends('app:ingest');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, sources: [], codeRoot: codeRoot() };
	}
	try {
		const sources = await listIngestSources(db, 50);
		return { connected: true, sources, codeRoot: codeRoot() };
	} catch {
		// A dead cached handle / live-query failure → honest disconnected (D-019).
		return { connected: false, sources: [], codeRoot: codeRoot() };
	}
};

/** The validated, non-empty input kinds the operator may submit. */
type InputKind = 'url' | 'repo' | 'file' | 'text';

function asString(v: FormDataEntryValue | null): string {
	return typeof v === 'string' ? v : '';
}

export const actions: Actions = {
	/**
	 * OPERATOR ingest trigger (§5). Validates the intent + the single chosen input at the
	 * boundary (D-016 discipline), CAPTURES it (CB1 — bounded, SSRF-safe, CODE_ROOT-confined),
	 * then runs the full DISTILL→SCREEN→FENCE→EMBED→INGEST pipeline (CB2). Every failure mode
	 * is NAMED and surfaced as an honest, actionable message (F-008) — never a silent empty.
	 *
	 * Shadow paths: nil intent / empty input → 400 named validation fail; SSRF/bounds/transport
	 * → the capture error's typed message; distill timeout/throw → the named distill failure;
	 * embedder down → the fail-closed capability message.
	 */
	ingest: async ({ request }) => {
		const form = await request.formData();
		const intent = asString(form.get('intent')).trim();
		const kind = asString(form.get('kind')).trim() as InputKind;
		const value = asString(form.get('value')).trim();
		const license = asString(form.get('license')).trim();
		const projectRaw = asString(form.get('project')).trim();

		// (1) Boundary validation — intent + a recognized non-empty input (D-016).
		if (!intent) {
			return fail(400, { ingest: { error: 'An intent is required — say what you want to learn from this source.' } });
		}
		if (kind !== 'url' && kind !== 'repo' && kind !== 'file' && kind !== 'text') {
			return fail(400, { ingest: { error: 'Choose an input type (URL, repo, file, or text).' } });
		}
		if (!value) {
			return fail(400, {
				ingest: {
					error:
						kind === 'text' ? 'Paste some text to ingest.' : kind === 'url' ? 'Enter a URL to ingest.' : 'Enter a path to ingest.'
				}
			});
		}
		let project: string | undefined;
		if (projectRaw) {
			try {
				project = assertRecordId(projectRaw);
			} catch {
				return fail(400, { ingest: { error: 'Project must be a valid record id (table:id) or left blank for global.' } });
			}
		}

		// (2) Capability gate (fail-closed, §2.3): the brain needs the embedder to ingest.
		const db = tryGetDb();
		if (!db) {
			return fail(503, { ingest: { error: 'The datastore is not connected — cannot ingest right now.' } });
		}
		const mem = await getMemoryService(db);
		if (!mem.available) {
			// HONEST, actionable fail-closed reason (F-008/D-024) — no fabricated ingest.
			return fail(503, { ingest: { error: `Ingest is unavailable: ${mem.reason}` } });
		}

		// (3) CAPTURE (CB1) — bounded + SSRF-safe + CODE_ROOT-confined. Every error is named.
		let capture: CaptureResult;
		try {
			if (kind === 'url') {
				capture = await captureUrl(value);
			} else if (kind === 'text') {
				capture = captureText(value);
			} else if (kind === 'repo') {
				capture = await captureRepo(value, { codeRoot: codeRoot() });
			} else {
				capture = await captureFile(value, { codeRoot: codeRoot() });
			}
		} catch (err) {
			if (err instanceof SsrfBlockedError) {
				return fail(400, { ingest: { error: `Refused for safety (SSRF guard): ${err.message}` } });
			}
			if (err instanceof CaptureBoundsError) {
				return fail(400, { ingest: { error: `Source exceeded a ${err.kind} bound: ${err.message}` } });
			}
			if (err instanceof PathConfinementError) {
				return fail(400, { ingest: { error: `Path escapes the allowed root (CODE_ROOT): ${err.message}` } });
			}
			if (err instanceof CaptureFetchError) {
				return fail(400, { ingest: { error: `Could not capture the source: ${err.message}` } });
			}
			return fail(500, { ingest: { error: `Capture failed: ${(err as Error).message}` } });
		}

		// (4) INGEST (CB2) — distill→screen→fence→embed→ingest, provenance + license per finding.
		let result: IngestResult;
		try {
			result = await ingestCaptured(
				{ db: mem.memory.db, embedder: mem.memory.embedder, distill: plainDistill() },
				{ capture, intent, license: license || undefined, project }
			);
		} catch (err) {
			if (err instanceof DistillTimeoutError) {
				return fail(504, { ingest: { error: `Distill timed out (${err.timeoutMs}ms) — the run was marked failed; nothing partial reached the brain.` } });
			}
			if (err instanceof DistillFailedError) {
				return fail(502, { ingest: { error: `Distill failed (${err.channel}): ${err.message}` } });
			}
			return fail(500, { ingest: { error: `Ingest failed: ${(err as Error).message}` } });
		}

		return {
			ingest: {
				ok: true,
				sourceId: result.sourceId,
				status: result.status,
				ingestedCount: result.ingestedCount,
				findingCount: result.findings.length,
				ref: capture.provenance.ref,
				kind: capture.provenance.kind,
				// Per-finding outcome (honest: quarantined/dropped included) for the result list.
				findings: result.findings.map((f) => ({
					memoryId: f.memoryId,
					ingested: f.ingested,
					screenStatus: f.screenStatus,
					dropReason: f.dropReason ?? null
				}))
			}
		};
	}
};
