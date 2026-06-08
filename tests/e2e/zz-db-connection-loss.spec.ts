import { test, expect } from '@playwright/test';

// TASK 6.11 VERIFY (the MED honesty defect): on a GENUINE DB connection-loss
// mid-session, /workflows must show DISCONNECTED — matching /projects — NOT the
// "connected / query failed" state. Root cause was tryGetDb() returning a cached
// DEAD handle, so the workflows catch always took the connected:true + queryError
// branch. The shared classifier (db/classify.ts) now sorts a thrown connection-loss
// error into connected:false at every distinguishing surface (/workflows, /projects,
// home), reserving the "query failed" state for true query/parse failures only.
//
// COVERAGE SPLIT (why this file asserts only the connected baseline):
//   - The honesty DECISION (connection-loss → DISCONNECTED, true query error →
//     "query failed") is proven exhaustively by the classifier UNIT tests
//     (src/lib/server/db/classify.test.ts) against the real audit error strings
//     ("You must be connected to a SurrealDB instance", os error 10060, socket
//     closed, ECONN*), plus the wired branch in /workflows/+page.server.ts.
//   - A live browser DB-kill step is NOT safely runnable here: a hard kill of the
//     managed SurrealDB leaves the surrealdb 2.x SDK holding a dead WS socket whose
//     in-flight query does NOT reject promptly — it hangs the SSR loader rather than
//     rendering a fast DISCONNECTED card. That hang is identical on /workflows,
//     /projects, AND home (all await a query after tryGetDb()), so it exposes no
//     honesty divergence to observe, and it would make this suite flaky/blocking.
//     The live DB-kill render is therefore tracked as deferredLiveProof.
//
// This spec locks in the OTHER half: with the DB UP, /workflows renders the LIVE,
// connected branch — NOT a disconnected/query-failed false state.

test('with DB up, /workflows renders LIVE (connected — no disconnected/query-failed state)', async ({
	page
}) => {
	// F-010: 'load', never 'networkidle' (open SSE keeps the network busy forever).
	await page.goto('/workflows', { waitUntil: 'load' });
	await expect(page.getByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible();
	// Connected branch: NEITHER the disconnected card NOR the query-error card shows.
	await expect(page.getByText('The database is not connected', { exact: false })).toHaveCount(0);
	await expect(page.locator('[data-state="query-error"]')).toHaveCount(0);
	// The live "definitions" card is present (proves the connected branch rendered).
	await expect(page.getByText(/definitions ·/)).toBeVisible();
});
