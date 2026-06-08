// Playwright global teardown (TASK 1.5 verify): stop the dashboard + DB server
// (taskkill the process trees on Windows — F-001), drop the namespace, remove the
// throwaway data dir + handoff file. Best-effort; never leaks state between runs.

import { stopSeededDb } from './db-harness';

export default async function globalTeardown(): Promise<void> {
	await stopSeededDb();
}
