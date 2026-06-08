// Playwright global setup (TASK 1.5 verify): start a throwaway SurrealDB, apply the
// canonical schema, seed ONE real `project` row, then launch the BUILT dashboard
// pointed at that DB. The e2e then loads a page serving LIVE DB data (F-008).

import { startSeededDb, startDashboard } from './db-harness';

const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);

export default async function globalSetup(): Promise<void> {
	await startSeededDb();
	await startDashboard(E2E_PORT);
}
