// E2E DB harness (TASK 1.5 verify) — spins up a REAL, throwaway SurrealDB, applies
// the canonical schema, and seeds ONE real `project` row. The dashboard then renders
// that LIVE row (F-008 — the e2e proves real DB data, no mocks in the app path; the
// seed is a test fixture, which the rules permit).
//
// The connection params (OS-assigned loopback port, ns/db, root creds) are written
// to a handoff JSON file so the Playwright `webServer` launcher can point the built
// SvelteKit server at this exact DB via env (SURREAL_WS/NS/DB/USER/PASS).

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Surreal, StringRecordId } from 'surrealdb';
import { SurrealServer } from '../../src/lib/server/db/provision';
import { Db } from '../../src/lib/server/db/client';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { schemaMigrations } from '../../src/lib/server/db/schema';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..', '..');
export const HANDOFF_PATH = join(REPO_ROOT, '.data', 'e2e-db.json');

export interface DbHandoff {
	ws: string;
	ns: string;
	db: string;
	user: string;
	pass: string;
	dataDir: string;
	pid: number | null;
	/** PID of the built dashboard server (set by startDashboard). */
	dashboardPid?: number | null;
	/** The base URL the dashboard listens on. */
	baseUrl?: string;
	/** Slug+name of the seeded project the e2e asserts against. */
	seededProjectName: string;
}

/** Start a throwaway SurrealDB, migrate, seed one project, write the handoff file. */
export async function startSeededDb(): Promise<DbHandoff> {
	const dataDir = mkdtempSync(join(tmpdir(), 'e2e-surreal-'));
	const server = new SurrealServer({
		dataDir,
		bind: '127.0.0.1:0',
		username: 'root',
		password: 'root'
	});
	await server.start();

	const ns = `e2e_ns_${process.pid}_${Date.now()}`;
	const database = 'main';

	// 1. Connect root + USE ns/db (auto-created on first use under root), then apply
	//    the canonical schema under the root/provisioning connection (D-026c).
	const root = await Db.connect({
		url: server.wsUrl,
		username: 'root',
		password: 'root',
		namespace: ns,
		database
	});
	await runMigrations(root, schemaMigrations);

	// 2. Seed ONE real project row (the e2e renders THIS, proving live DB data).
	const seededProjectName = 'E2E Demo Project';
	const rid = new StringRecordId('project:e2e_demo');
	await root.query(
		'CREATE $rid CONTENT { slug: $slug, name: $name, root_path: $path, ecosystem: $eco, status: $status };',
		{
			rid,
			slug: 'e2e_demo',
			name: seededProjectName,
			path: 'F:/code/e2e-demo',
			eco: ['node'],
			status: 'active'
		}
	);
	await root.close();

	const handoff: DbHandoff = {
		ws: server.wsUrl,
		ns,
		db: database,
		user: 'root',
		pass: 'root',
		dataDir,
		pid: server.pid,
		seededProjectName
	};
	writeFileSync(HANDOFF_PATH, JSON.stringify(handoff, null, 2));
	return handoff;
}

/** Read the handoff written by {@link startSeededDb}. */
export function readHandoff(): DbHandoff {
	return JSON.parse(readFileSync(HANDOFF_PATH, 'utf8')) as DbHandoff;
}

/**
 * Spawn the BUILT dashboard (`build/index.js`) pointed at the seeded DB via env,
 * wait until it serves HTTP, and record its pid + baseUrl back into the handoff.
 * Returns the base URL. The built server runs hooks.server.ts → initDbFromEnv, so
 * the dashboard renders the seeded `project` row live.
 */
export async function startDashboard(port = 4173): Promise<string> {
	const { spawn } = await import('node:child_process');
	const h = readHandoff();
	const baseUrl = `http://127.0.0.1:${port}`;

	const child = spawn(process.execPath, [join(REPO_ROOT, 'build', 'index.js')], {
		env: {
			...process.env,
			PORT: String(port),
			HOST: '127.0.0.1',
			SURREAL_WS: h.ws,
			SURREAL_NS: h.ns,
			SURREAL_DB: h.db,
			SURREAL_USER: h.user,
			SURREAL_PASS: h.pass
		},
		stdio: 'inherit',
		// shell:false here — execPath has no spaces; keep the pid addressable for taskkill.
		windowsHide: true
	});

	h.dashboardPid = child.pid ?? null;
	h.baseUrl = baseUrl;
	writeFileSync(HANDOFF_PATH, JSON.stringify(h, null, 2));

	// Poll until the server answers (or time out).
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(baseUrl + '/', { redirect: 'manual' });
			if (res.status < 500) return baseUrl;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`dashboard did not become healthy on ${baseUrl} within 30s`);
}

/** Stop the server (taskkill on Windows) + drop the namespace + remove the data dir. */
export async function stopSeededDb(): Promise<void> {
	if (!existsSync(HANDOFF_PATH)) return;
	const h = readHandoff();
	// Drop the namespace, then kill the process tree (F-001 — never process.kill(pid,0)).
	try {
		const db = new Surreal();
		await db.connect(h.ws);
		await db.signin({ username: h.user, password: h.pass });
		await db.query('REMOVE NAMESPACE IF EXISTS type::namespace($ns);', { ns: h.ns });
		await db.close();
	} catch {
		/* best effort */
	}
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const execFileP = promisify(execFile);
	const killTree = async (pid: number | null | undefined) => {
		if (!pid) return;
		if (process.platform === 'win32') {
			await execFileP('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
		} else {
			try {
				process.kill(pid, 'SIGTERM');
			} catch {
				/* gone */
			}
		}
	};
	// Kill the dashboard first (it holds the WS connection), then the DB server.
	await killTree(h.dashboardPid);
	await killTree(h.pid);
	rmSync(h.dataDir, { recursive: true, force: true });
	rmSync(HANDOFF_PATH, { force: true });
}
