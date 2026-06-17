// TASK 16.6 LIVE VERIFY — one FULL gauntlet run with a REAL credentialed Claude Code
// session (ClaudeCliBackend) against a REAL throwaway SurrealDB: a trivial planted
// fixture, the sterile confined interview session, the deterministic scorer, honest
// end-to-end scoring, and the mandatory teardown (workspace gone, session terminal).
//
// F-008 / F-014 discipline: SKIPPED honestly when no CLAUDE_CODE_OAUTH_TOKEN is
// available (no faked artifact); when it runs it is WALL-CLOCK BOUNDED (the §3.1
// session bound + the CLI backend's own timeout) — no spin, no orphan: the runner's
// finally-teardown kills the child and deletes the workspace on every path.
//
// HONESTY NOTE: a live model's verdict is not scripted — the assertion is that the
// engine SCORED it honestly (a terminal status with consistent counts/queues), not
// that the model passed. A miss → failed, an inventive extra → adjudicating: both are
// the engine working. Env failures classify mechanically (§3.6), also asserted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import { handleGatePreToolUse, resetGateSessions } from '../claude-code/gate-transport';
import { authorizeHookRequest } from '../hooks/index';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import type { WorkforceConfig } from '../config/index';
import { DEFAULT_GATE_POLICY } from '../claude-code/gates';
import { ClaudeCodeRuntime } from '../runtime/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';
import { runGauntlet } from './gauntlet';
import { activateGauntletFixture, newSentinelUlid } from './activation';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH } from './scorer';
import {
	createGauntletFixture,
	createGauntletKey,
	createRole,
	createRoleVersion
} from './repo';

/** Read CLAUDE_CODE_OAUTH_TOKEN from process env or the worktree .env (never logged). */
function readToken(): string | undefined {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	const p = join(process.cwd(), '.env');
	if (existsSync(p)) {
		const line = readFileSync(p, 'utf8')
			.split(/\r?\n/)
			.find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
		if (line) {
			return line
				.slice('CLAUDE_CODE_OAUTH_TOKEN='.length)
				.trim()
				.replace(/^["']|["']$/g, '');
		}
	}
	return undefined;
}

const TOKEN = readToken();
const live = TOKEN ? describe : describe.skip;

let tdb: TestDb;
let db: Db;
let wsRoot: string;
let harnessRoot: string;
let gateServer: Server | null = null;
const savedEnv: Record<string, string | undefined> = {};

const EVIDENCE_PATTERN = 'eval\\(';

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

function liveConfig(): WorkforceConfig {
	return {
		pm: { provider: 'claude', model_id: 'claude-opus-4-8', triggers: { failure_threshold: null } },
		panel: { scope: { max_files: null, max_new_services: null } },
		// 4-minute session bound: the F-014 "bounded live-verify" discipline.
		gauntlet: { pass_recall: 1.0, max_false_positives: 0, session_timeout_minutes: 4 },
		budget: { max_auto_interviews_per_day: null, allowed_auto_tiers: [] },
		drift: {
			escaped_defect: true,
			operator_feedback: true,
			confidence_miscalibration: true,
			confidence_miscalibration_rate: 0.5,
			refutation_rate: null,
			fixloop_rate: null
		},
		research: { max_wall_clock_minutes: null, max_fetches: null },
		workforce: { max_open_proposals: 2, track_window_days: 14, min_events_for_claim: 5 }
	};
}

beforeAll(async () => {
	if (!TOKEN) return;
	resetGateSessions();
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	wsRoot = mkdtempSync(join(tmpdir(), 'gauntlet-live-ws-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'gauntlet-live-harness-'));

	// In-process LOOPBACK gate endpoint (the 13.3/15.1 live-harness shape): the CLI's
	// PreToolUse hook POSTs here — same authorize + handleGatePreToolUse composition
	// as the production route. Without it EVERY tool call fails closed (D-024) and
	// the candidate can neither read fixtures nor write findings.json.
	const hookToken = randomBytes(24).toString('hex');
	gateServer = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === 'string') headers.set(k, v);
			}
			const auth = authorizeHookRequest(headers, { HOOK_TOKEN: hookToken });
			if (!auth.ok) {
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end('{}');
				return;
			}
			let body: unknown = null;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				body = null;
			}
			const decision = handleGatePreToolUse(body);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(decision));
		});
	});
	await new Promise<void>((resolve) => gateServer!.listen(0, '127.0.0.1', resolve));
	const addr = gateServer.address();
	const port = typeof addr === 'object' && addr ? addr.port : 0;
	for (const k of ['HOOK_URL', 'HOOK_TOKEN'] as const) savedEnv[k] = process.env[k];
	process.env.HOOK_URL = `http://127.0.0.1:${port}`;
	process.env.HOOK_TOKEN = hookToken;
}, 120_000);

afterAll(async () => {
	if (!TOKEN) return;
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	if (gateServer) await new Promise<void>((resolve) => gateServer!.close(() => resolve()));
	await db?.close().catch(() => {});
	await tdb?.teardown();
	if (wsRoot) rmSync(wsRoot, { recursive: true, force: true });
	if (harnessRoot) rmSync(harnessRoot, { recursive: true, force: true });
});

live('LIVE 16.6 — full gauntlet run, real candidate session, honest scoring, teardown', () => {
	it(
		'runs the gauntlet end-to-end against a trivial fixture and scores honestly',
		async () => {
			const role = await createRole(db, {
				slug: 'live-security-probe',
				name: 'Live Security Probe',
				purpose: 'live gauntlet verification'
			});
			const version = await createRoleVersion(db, {
				role: role.id,
				prompt_core:
					'You are a security code reviewer. Review every file for dangerous patterns. ' +
					'The single most important pattern: passing user-controlled input to eval(). ' +
					'Report each occurrence with its exact file, line, and a verbatim quote.',
				default_tier: 'haiku'
			});
			const fixture = await createGauntletFixture(db, {
				role: role.id,
				slug: 'live-eval-defect',
				kind: 'planted_defect',
				work: {
					'app.js':
						'function handle(req) {\n' +
						'  const expr = req.query.expr;\n' +
						'  return eval(expr); // compute\n' +
						'}\n' +
						'module.exports = { handle };\n'
				},
				sentinel: newSentinelUlid()
			});
			await createGauntletKey(db, {
				fixture: fixture.id,
				plants: [
					{
						id: 'live-p1',
						class: 'code-injection',
						location: 'app.js:3',
						severity: 'critical',
						detection: { file: 'app.js', lines: [1, 5], evidence_pattern: EVIDENCE_PATTERN }
					}
				]
			});
			await activateGauntletFixture(db, fixture.id);

			const controlSlug = 'live-ctrl';
			const control = await createGauntletFixture(db, {
				role: role.id,
				slug: controlSlug,
				kind: 'scorer_control',
				work: {
					'c.js': 'const r = eval(x);\n',
					[KNOWN_PASS_PATH]: JSON.stringify([
						{ fixture: controlSlug, file: 'c.js', lines: [1, 1], class: 'code-injection', evidence: 'eval(x)' }
					]),
					[KNOWN_FAIL_PATH]: JSON.stringify([])
				},
				sentinel: newSentinelUlid()
			});
			await createGauntletKey(db, {
				fixture: control.id,
				plants: [{ id: 'c1', detection: { file: 'c.js', lines: [1, 1], evidence_pattern: EVIDENCE_PATTERN } }]
			});
			await activateGauntletFixture(db, control.id);

			const backend = new ClaudeCliBackend({
				oauthToken: TOKEN!,
				maxTurns: 30,
				timeoutMs: 270_000
			});
			const runtime = new ClaudeCodeRuntime({
				backend,
				harnessConfigRoot: harnessRoot.replace(/\\/g, '/'),
				gates: { ...DEFAULT_GATE_POLICY }
			});

			const out = await runGauntlet(
				{ db, runtime, config: liveConfig(), workspaceRoot: wsRoot },
				{
					roleVersionId: version.id,
					tier: 'haiku',
					provider: 'claude',
					modelId: 'haiku',
					trigger: 'operator'
				}
			);

			expect(out.kind).toBe('ran');
			if (out.kind !== 'ran') return;
			const run = out.run;
			// HONEST terminal state — the engine judged whatever the live model did.
			expect(['passed', 'failed', 'adjudicating', 'error']).toContain(run.status);
			expect(run.ended_at).not.toBeNull();
			console.log(
				`[live-gauntlet] verdict: ${run.status}` +
					(run.error_reason ? ` (${run.error_reason})` : '') +
					` — found ${run.planted_found}/${run.planted_total}, ambiguous ${run.ambiguous.length}` +
					(out.retriedFrom ? ` (retried from ${out.retriedFrom})` : '')
			);
			console.log(`[live-gauntlet] results: ${JSON.stringify(run.results).slice(0, 2000)}`);
			if (run.status === 'error') {
				// Env failure: mechanically classified, named — surfaced, not masked.
				expect(['env_timeout', 'spawn_failure', 'scorer_error']).toContain(run.error_reason);
			} else {
				// The scorer judged real findings: counts are consistent with the verdict.
				if (run.status === 'passed') {
					expect(run.planted_found).toBe(run.planted_total);
					expect(run.ambiguous).toEqual([]);
				}
				if (run.status === 'adjudicating') expect(run.ambiguous.length).toBeGreaterThan(0);
			}

			// The candidate session is REAL, kind='interview', project-less, terminal,
			// with a persisted transcript.
			expect(run.session).toBeTruthy();
			const [sessions] = await db.query<
				[Array<{ kind: string; status: string; project?: unknown; cc_session_id?: unknown }>]
			>(`SELECT kind, status, project, cc_session_id FROM $sid;`, { sid: rid(run.session!) });
			expect(sessions[0].kind).toBe('interview');
			expect(['done', 'failed', 'cancelled']).toContain(sessions[0].status);
			expect(sessions[0].project ?? null).toBeNull();
			const [msgs] = await db.query<[Array<{ content: string }>]>(
				`SELECT content FROM message WHERE session = $sid LIMIT 500;`,
				{ sid: rid(run.session!) }
			);
			expect(msgs.length).toBeGreaterThan(0);
			console.log(
				`[live-gauntlet] transcript (${msgs.length} messages): ` +
					msgs.map((m) => m.content.slice(0, 200)).join(' | ').slice(0, 3000)
			);
			// LEAK RAIL: the answer key's detection source never entered the transcript
			// (the scorer runs outside the session — §3.4).
			expect(msgs.some((m) => m.content.includes(EVIDENCE_PATTERN))).toBe(false);

			// MANDATORY TEARDOWN (F-014): every attempt's workspace is gone.
			const [runs] = await db.query<[Array<{ id: unknown }>]>(
				`SELECT id FROM interview_run WHERE role_version = $v LIMIT 10;`,
				{ v: rid(version.id) }
			);
			for (const r of runs) {
				expect(existsSync(join(wsRoot, String(r.id).split(':')[1]))).toBe(false);
			}
		},
		600_000
	);
});
