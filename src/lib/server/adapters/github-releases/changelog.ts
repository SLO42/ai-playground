// TASK 12.3 — the GitHub-release BODY source. It REUSES the 11.2 changelog render source rather
// than duplicating it: the canonical generated changelog is the assistant output of a release
// run's `changelog` STEP session, read by `getReleaseChangelogMarkdown` (release/pipeline.ts,
// the SAME function `getReleaseChangelogHtml` renders). A GitHub release wants RAW Markdown (the
// API renders it itself), so we use the markdown source directly — no second render path.
//
// The PublisherAdapter contract is stateless + DB-less (it takes per-call options + a confined
// SecretResolver — types.ts), so the adapter cannot itself read SurrealDB. The release pipeline
// (which HAS the db) resolves the body via `getReleaseChangelogMarkdown` and passes it into the
// per-project target `config.body`. This module is the single resolver the adapter calls, with a
// layered, HONEST fallback so a dry-run is never blank or fabricated:
//   1. config.body            — the pipeline-supplied generated changelog (the primary path);
//   2. CHANGELOG.md in cwd    — a checked-in changelog file (the no-pipeline manual path);
//   3. honest empty (null)    — the caller renders an explicit "no changelog yet" note (F-008).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The resolved release body + where it came from (for an honest surface). */
export interface ResolvedBody {
	/** The Markdown body, or null when no source produced content (honest empty — F-008). */
	body: string | null;
	/** Which source produced it (or 'none'). */
	source: 'config' | 'CHANGELOG.md' | 'none';
}

/**
 * Resolve the GitHub-release body Markdown. `config.body` (the pipeline-supplied generated
 * changelog from `getReleaseChangelogMarkdown` — the 11.2 source) takes precedence; else a
 * checked-in `CHANGELOG.md` under cwd; else null (the caller surfaces an explicit empty state).
 * The only IO is reading CHANGELOG.md, confined to cwd.
 */
export async function resolveReleaseBody(
	cwd: string,
	config?: Record<string, unknown>
): Promise<ResolvedBody> {
	const fromConfig = config && typeof config.body === 'string' ? config.body.trim() : '';
	if (fromConfig) return { body: fromConfig, source: 'config' };

	try {
		const file = await readFile(join(cwd, 'CHANGELOG.md'), 'utf8');
		if (file.trim()) return { body: file.trim(), source: 'CHANGELOG.md' };
	} catch {
		// no CHANGELOG.md — fall through to the honest empty state
	}
	return { body: null, source: 'none' };
}
