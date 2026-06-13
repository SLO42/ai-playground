// scripts/memory-eval.ts — MEMORY-SPEC §11 recall-quality re-validation (TASK B8 input).
//
// Run via `npx vite-node -c vite.node.config.mts scripts/memory-eval.ts`. Boots a THROWAWAY
// SurrealDB namespace (NEVER the live dev DB — the fixture corpus is eval data, not product
// data, F-008), seeds the labeled corpus, runs the recall-quality harness, prints the
// measured-numbers report, then tears the throwaway server down completely (F-014 cleanup;
// interrupt contract — no observable state left behind on a mid-run kill).
//
// MEASUREMENT ONLY: it changes no §11 default and prunes no memory (D-030 ranking-only). The
// numbers it prints are the EVIDENCE ARTIFACT for re-validating the WMR weights / novelty cut
// / recall budget on a controlled corpus — NOT a claim about live qwen3 (the deferred proof).

import { Db } from '../src/lib/server/db/client.ts';
import { runMigrations } from '../src/lib/server/db/migrate.ts';
import { schemaMigrations } from '../src/lib/server/db/schema.ts';
import { startTestDb } from '../src/lib/server/db/testserver.ts';
import { MemoryService } from '../src/lib/server/memory/index.ts';
import { LexicalEmbedder } from '../src/lib/server/memory/eval/embedder.ts';
import { runEval, formatReport } from '../src/lib/server/memory/eval/harness.ts';

async function main(): Promise<void> {
	const tdb = await startTestDb();
	const db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	try {
		await runMigrations(db, schemaMigrations);
		const mem = new MemoryService({ db, embedder: new LexicalEmbedder() });
		const report = await runEval(mem);
		console.log(formatReport(report));
		// Machine-readable companion for downstream B8 ingestion.
		console.log('\n=== JSON ===');
		console.log(JSON.stringify(report, null, 2));
	} finally {
		await db.close().catch(() => {});
		await tdb.teardown().catch(() => {});
	}
}

main().catch((err) => {
	console.error(`[memory-eval] FAILED: ${(err as Error).message}`);
	process.exit(1);
});
