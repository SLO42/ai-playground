// scripts/import-v1.ts — runnable edge for the v1 → v2 data importer (TASK 1.7,
// IMPLEMENTATION-PLAN §1.7). The migration LOGIC lives in (and is tested under)
// src/lib/server/importer; this file is only the thin CLI that opens a live DB
// connection and drives importV1FromFiles. It is intentionally NOT under src/** so
// vitest never treats it as a suite — the core is covered by importer/v1.test.ts.
//
// Idempotent by design: re-running this script over the same v1 files produces no
// duplicate rows (every write is an UPSERT onto a deterministic id). See §1.7.
//
// Usage (DB connection comes from env so no secrets are baked in — D-025/no-secrets):
//   SURREAL_URL=ws://127.0.0.1:PORT SURREAL_USER=… SURREAL_PASS=… \
//   SURREAL_NS=playground SURREAL_DB=main \
//   node --experimental-strip-types scripts/import-v1.ts \
//     --registry F:/path/registry.json --tasks F:/path/tasks.json [--project project:<slug>]

import { Db } from '../src/lib/server/db/client.ts';
import { importV1FromFiles } from '../src/lib/server/importer/v1.ts';
import {
	importGraphStateFromFile,
	importSwarmMemoryFromDb
} from '../src/lib/server/importer/v1-stores.ts';
import { CachedEmbedder, OllamaEmbedder } from '../src/lib/server/memory/embed.ts';

/** Parse `--flag value` pairs into a plain map (no external dep). */
function parseFlags(argv: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				out[key] = next;
				i++;
			} else {
				out[key] = 'true';
			}
		}
	}
	return out;
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v || v.trim() === '') {
		throw new Error(`missing required env var ${name} (set the SurrealDB connection in env)`);
	}
	return v;
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	if (!flags.registry && !flags.tasks && !flags['swarm-db'] && !flags.graph) {
		throw new Error(
			'nothing to import: pass --registry/--tasks (1.7) and/or --swarm-db/--graph (2.9)'
		);
	}

	const db = await Db.connect({
		url: requireEnv('SURREAL_URL'),
		username: requireEnv('SURREAL_USER'),
		password: requireEnv('SURREAL_PASS'),
		namespace: requireEnv('SURREAL_NS'),
		database: requireEnv('SURREAL_DB')
	});
	try {
		if (flags.registry || flags.tasks) {
			const counts = await importV1FromFiles(db, {
				registryPath: flags.registry,
				tasksPath: flags.tasks,
				taskProjectId: flags.project
			});
			process.stdout.write(
				`v1 import complete: ${counts.projects} project(s), ${counts.tasks} task(s) ` +
					`(re-run is idempotent — no duplicate rows)\n`
			);
		}

		// TASK 2.9 — remaining stores. The swarm memory import RE-EMBEDS every row to 1024
		// (the v1 vectors are 384-dim), so it needs a live embedder: the local Ollama server
		// (D-014, no /v1 suffix). Endpoint/model come from env so no secrets are baked in.
		if (flags['swarm-db']) {
			const inner = new OllamaEmbedder({
				endpoint: requireEnv('OLLAMA_ENDPOINT'),
				model: requireEnv('EMBEDDING_MODEL')
			});
			const embedder = new CachedEmbedder({ embedder: inner, db });
			const r = await importSwarmMemoryFromDb({ db, embedder }, flags['swarm-db']);
			process.stdout.write(
				`swarm memory import: ${r.imported} new, ${r.skipped} skipped, ` +
					`${r.reEmbedded} re-embedded to 1024, ${r.dropped} screened-out (idempotent)\n`
			);
		}

		if (flags.graph) {
			const g = await importGraphStateFromFile(db, flags.graph);
			process.stdout.write(
				`graph-state import: ${g.entities} entit(ies), ${g.edges} edge(s), ` +
					`${g.skippedEdges} dangling edge(s) skipped (idempotent)\n`
			);
		}
	} finally {
		await db.close().catch(() => {});
	}
}

main().catch((err: unknown) => {
	process.stderr.write(`v1 import failed: ${(err as Error).message}\n`);
	process.exitCode = 1;
});
