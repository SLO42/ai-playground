// Unit — verify-flows runner (TASK 15.3 B9): draft exclusion (atomic
// stage→test→rename discipline), per-flow wall-clock bound enforcement,
// honest skip on env-unavailable, protocol-violation channel naming, and the
// graduation rename gate. Child-process pieces run REAL subprocesses (no
// mocks of the thing under test); everything is bounded.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitFlows, parseFlowResult, summarize, runOneFlow } from './runner.mjs';
import { classifyBvFailure } from './harness.mjs';

const RUNNER = join(process.cwd(), 'tests', 'verify-flows', 'lib', 'runner.mjs');

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'vf-runner-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeFlow(name: string, body: string): string {
	const p = join(dir, name);
	writeFileSync(p, body);
	return p;
}

/** Run the real runner.mjs as a child with env, bounded. */
function runRunner(env: Record<string, string>, boundMs = 30_000) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			process.execPath,
			[RUNNER],
			{ timeout: boundMs, windowsHide: true, env: { ...process.env, ...env } },
			(err, stdout, stderr) => {
				const code = err ? ((err as { code?: number }).code ?? 1) : 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
			}
		);
	});
}

describe('splitFlows — draft exclusion (atomic discipline)', () => {
	it('separates active flows from .draft.mjs and ignores non-flows', () => {
		const { active, drafts } = splitFlows([
			'services-health.mjs',
			'new-feature.draft.mjs',
			'shell-primitives.mjs',
			'lib', // directory
			'README.md',
			'runner.test.ts'
		]);
		expect(active).toEqual(['services-health.mjs', 'shell-primitives.mjs']);
		expect(drafts).toEqual(['new-feature.draft.mjs']); // reported, never silently dropped
	});

	it('shadow paths: empty and all-draft listings', () => {
		expect(splitFlows([])).toEqual({ active: [], drafts: [] });
		expect(splitFlows(['a.draft.mjs'])).toEqual({ active: [], drafts: ['a.draft.mjs'] });
	});
});

describe('parseFlowResult — protocol parsing', () => {
	it('parses the LAST stdout line as the result', () => {
		const r = parseFlowResult('noise\n{"flow":"x","status":"pass","evidence":[],"durationMs":5}');
		expect(r).toMatchObject({ flow: 'x', status: 'pass' });
	});
	it('rejects garbage, wrong shape, and empty output (null — caller names the channel)', () => {
		expect(parseFlowResult('not json')).toBeNull();
		expect(parseFlowResult('{"status":"pass"}')).toBeNull(); // no flow name
		expect(parseFlowResult('{"flow":"x","status":"green"}')).toBeNull(); // unknown status
		expect(parseFlowResult('')).toBeNull();
	});
});

describe('summarize — honest exit codes', () => {
	const r = (status: 'pass' | 'fail' | 'skip') => ({ flow: 'f', status, evidence: [], durationMs: 0 });
	it('any fail → 1', () => {
		expect(summarize([r('pass'), r('fail'), r('skip')]).exitCode).toBe(1);
	});
	it('passes (with skips) → 0', () => {
		expect(summarize([r('pass'), r('skip')]).exitCode).toBe(0);
	});
	it('ALL skipped → 2 (nothing verified must not read green)', () => {
		expect(summarize([r('skip'), r('skip')]).exitCode).toBe(2);
	});
	it('empty → 2', () => {
		expect(summarize([]).exitCode).toBe(2);
	});
});

describe('classifyBvFailure — honest skip on daemon-unavailable', () => {
	it('daemon-unavailable error names are env (skip), feature errors are defects (fail)', () => {
		expect(classifyBvFailure('daemon-start-timeout')).toBe('env');
		expect(classifyBvFailure('daemon-unreachable')).toBe('env');
		expect(classifyBvFailure('stale-ref')).toBe('defect');
		expect(classifyBvFailure('flow-assert')).toBe('defect');
		expect(classifyBvFailure(undefined as unknown as string)).toBe('defect');
	});
});

describe('runOneFlow — bounded child execution', () => {
	it(
		'kills an over-bound flow and reports a TIMEOUT failure with the channel named',
		async () => {
			const p = writeFlow('hang.mjs', 'await new Promise((r) => setTimeout(r, 60_000));');
			const res = await runOneFlow(p, 1_500);
			expect(res.status).toBe('fail');
			expect(res.reason).toMatch(/flow-bound-exceeded/);
			expect(res.reason).toMatch(/channel: timeout/);
		},
		30_000
	);

	it('passes through an honest skip result (exit 2 + skip JSON)', async () => {
		const p = writeFlow(
			'skipper.mjs',
			`console.log(JSON.stringify({ flow: 'skipper', status: 'skip', reason: 'daemon-unreachable: env', evidence: [], durationMs: 1 }));process.exit(2);`
		);
		const res = await runOneFlow(p, 15_000);
		expect(res.status).toBe('skip');
		expect(res.reason).toMatch(/daemon-unreachable/);
	});

	it('names the channel on a protocol violation (no result JSON)', async () => {
		const p = writeFlow('garbage.mjs', `console.log('no json here');console.error('boom detail');process.exit(3);`);
		const res = await runOneFlow(p, 15_000);
		expect(res.status).toBe('fail');
		expect(res.reason).toMatch(/flow-protocol-violation/);
		expect(res.reason).toMatch(/exit 3/);
		expect(res.reason).toMatch(/boom detail/); // first stderr lines quoted
	});
});

describe('runner main — app preflight + graduation (real subprocess)', () => {
	it(
		'app unreachable → ALL flows honestly skipped WITHOUT executing them; exit 2',
		async () => {
			const marker = join(dir, 'executed.marker');
			writeFlow(
				'marker.mjs',
				`import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'ran');console.log(JSON.stringify({ flow: 'marker', status: 'pass', evidence: [], durationMs: 1 }));`
			);
			const out = await runRunner({
				VF_FLOWS_DIR: dir,
				VF_BASE: 'http://127.0.0.1:9', // nothing listens here
				VF_FLOW_BOUND_MS: '10000'
			});
			expect(out.code).toBe(2);
			expect(out.stdout).toMatch(/app-unreachable/);
			expect(existsSync(marker), 'flow must NOT run when the app is down').toBe(false);
			rmSync(join(dir, 'marker.mjs'), { force: true });
		},
		30_000
	);

	it(
		'graduation: a PASSING draft is atomically renamed to active; a FAILING draft is not',
		async () => {
			writeFlow(
				'grad-ok.draft.mjs',
				`console.log(JSON.stringify({ flow: 'grad-ok', status: 'pass', evidence: ['proven once live'], durationMs: 1 }));`
			);
			writeFlow(
				'grad-bad.draft.mjs',
				`console.log(JSON.stringify({ flow: 'grad-bad', status: 'fail', reason: 'assert blew', evidence: [], durationMs: 1 }));process.exit(1);`
			);

			const ok = await new Promise<number>((resolve) => {
				execFile(
					process.execPath,
					[RUNNER, '--graduate', 'grad-ok'],
					{ timeout: 30_000, windowsHide: true, env: { ...process.env, VF_FLOWS_DIR: dir } },
					(err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0)
				);
			});
			expect(ok).toBe(0);
			expect(existsSync(join(dir, 'grad-ok.mjs')), 'passing draft becomes active').toBe(true);
			expect(existsSync(join(dir, 'grad-ok.draft.mjs')), 'no half-state: draft gone').toBe(false);

			const bad = await new Promise<number>((resolve) => {
				execFile(
					process.execPath,
					[RUNNER, '--graduate', 'grad-bad'],
					{ timeout: 30_000, windowsHide: true, env: { ...process.env, VF_FLOWS_DIR: dir } },
					(err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0)
				);
			});
			expect(bad).toBe(1);
			expect(existsSync(join(dir, 'grad-bad.draft.mjs')), 'failing draft stays a draft').toBe(true);
			expect(existsSync(join(dir, 'grad-bad.mjs')), 'failing draft must NOT activate').toBe(false);
			rmSync(join(dir, 'grad-ok.mjs'), { force: true });
			rmSync(join(dir, 'grad-bad.draft.mjs'), { force: true });
		},
		60_000
	);
});
