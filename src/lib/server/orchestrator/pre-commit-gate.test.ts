import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreCommitGate } from './pre-commit-gate';
import type { CommandResult, CommandRunner } from './command-runner';

// PCG-1 VERIFY — the pre-commit gate (orchestrator/pre-commit-gate.ts).
//
// Every command is driven through an INJECTED runner: no build, no test suite and no live process
// is ever spawned by this file (a mock in a TEST is allowed — F-008). The filesystem IS real,
// because the gate's lint/typecheck resolution reads a real package.json and the "cwd does not
// exist" shadow path is only meaningful against a real disk.
//
// The four shadow paths are named per test: HAPPY · NIL (no cwd / no tool) · EMPTY (a resolvable
// tool with nothing declared) · UPSTREAM ERROR (non-zero exit, and a runner that THROWS).

/** A fake runner: records calls, returns per-program scripted results. NO live process. */
function fakeRunner(
	script: (file: string, args: readonly string[]) => CommandResult | Promise<CommandResult>
): CommandRunner & { calls: { file: string; args: string[]; cwd: string }[] } {
	const calls: { file: string; args: string[]; cwd: string }[] = [];
	const fn = (async (file, args, opts) => {
		calls.push({ file, args: [...args], cwd: opts.cwd });
		return script(file, args);
	}) as CommandRunner & { calls: typeof calls };
	fn.calls = calls;
	return fn;
}

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

let root: string;
/** An npm project declaring build + lint + typecheck + test — the fully-covered case. */
let fullRoot: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'pcg-bare-'));
	fullRoot = mkdtempSync(join(tmpdir(), 'pcg-full-'));
	writeFileSync(
		join(fullRoot, 'package.json'),
		JSON.stringify({
			name: 'covered',
			scripts: { build: 'vite build', lint: 'eslint .', typecheck: 'svelte-check', test: 'vitest run' }
		})
	);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(fullRoot, { recursive: true, force: true });
});

describe('pre-commit gate — the happy path', () => {
	it('runs build → lint → typecheck → test in order, all green ⇒ passed + verified', async () => {
		const runner = fakeRunner(() => OK);
		const gate = await runPreCommitGate(
			{ cwd: fullRoot, buildTool: 'npm', testCommand: 'npm test' },
			{ run: runner }
		);

		expect(gate.status).toBe('passed');
		expect(gate.verified).toBe(true);
		expect(gate.errored).toBe(false);
		expect(gate.failedAt).toBeNull();

		// ORDER is part of the contract (a build failure should be seen before a test failure).
		expect(runner.calls.map((c) => c.args.join(' '))).toEqual([
			'run build',
			'run lint',
			'run typecheck',
			'test'
		]);
		// Every step ran in the SESSION worktree, never anywhere else.
		expect(new Set(runner.calls.map((c) => c.cwd))).toEqual(new Set([fullRoot]));
		// D-008: argument ARRAYS — the program is `npm`, never a shell line.
		expect(new Set(runner.calls.map((c) => c.file))).toEqual(new Set(['npm']));

		expect(gate.steps.filter((s) => s.ran).map((s) => s.name)).toEqual([
			'build',
			'lint',
			'typecheck',
			'test'
		]);
		expect(gate.steps.every((s) => s.ok)).toBe(true);
		expect(gate.summary).toMatch(/passed/);
	});

	it('a bare build_tool maps through buildCommandFor — never run as a bare token (false-green class)', async () => {
		// `dotnet` alone EXITS 0 WITHOUT BUILDING. The gate must run `dotnet build -c Release`.
		const runner = fakeRunner(() => OK);
		const gate = await runPreCommitGate({ cwd: root, buildTool: 'dotnet' }, { run: runner });
		expect(runner.calls[0]).toMatchObject({ file: 'dotnet', args: ['build', '-c', 'Release'] });
		expect(gate.status).toBe('passed');
	});

	it('an operator-edited multi-token build_tool is split to argv, not handed to a shell (D-008)', async () => {
		const runner = fakeRunner(() => OK);
		await runPreCommitGate({ cwd: root, buildTool: 'make all; rm -rf /' }, { run: runner });
		// Each token is its own INERT argv element — there is no shell to re-parse the `;`.
		expect(runner.calls[0]).toMatchObject({ file: 'make', args: ['all;', 'rm', '-rf', '/'] });
	});

	it('opts.steps narrows the gate — the excluded steps are recorded as not-run, not dropped', async () => {
		const runner = fakeRunner(() => OK);
		const gate = await runPreCommitGate(
			{ cwd: fullRoot, buildTool: 'npm', testCommand: 'npm test' },
			{ run: runner, steps: ['test'] }
		);
		expect(runner.calls.map((c) => c.args.join(' '))).toEqual(['test']);
		expect(gate.status).toBe('passed');
		// The record still carries all four names — a narrowed gate is visible, not invisible.
		expect(gate.steps.map((s) => s.name)).toEqual(['build', 'lint', 'typecheck', 'test']);
		expect(gate.steps.find((s) => s.name === 'lint')?.detail).toMatch(/not part of the configured gate/);
	});
});

describe('pre-commit gate — the FAILURE path (the one that matters)', () => {
	it('a non-zero build exits the gate RED, names the step, and STOPS (no later step runs)', async () => {
		const runner = fakeRunner((file, args) =>
			args[1] === 'build'
				? { code: 2, stdout: '', stderr: 'src/x.ts(3,1): error TS1005' }
				: OK
		);
		const gate = await runPreCommitGate(
			{ cwd: fullRoot, buildTool: 'npm', testCommand: 'npm test' },
			{ run: runner }
		);

		expect(gate.status).toBe('failed');
		expect(gate.failedAt).toBe('build');
		expect(gate.errored).toBe(false); // it RAN and failed — not an infrastructure fault
		expect(gate.verified).toBe(true);
		// Halt-at-first-red: exactly ONE command was spawned.
		expect(runner.calls.length).toBe(1);
		// The later steps are RECORDED with the reason, never silently absent.
		for (const name of ['lint', 'typecheck', 'test'] as const) {
			const step = gate.steps.find((s) => s.name === name)!;
			expect(step.ran).toBe(false);
			expect(step.detail).toMatch(/the gate stopped at the failing build step/);
		}
		// The honest detail carries the exit code AND the compiler's own words.
		expect(gate.steps[0].code).toBe(2);
		expect(gate.summary).toMatch(/FAILED at build/);
		expect(gate.summary).toMatch(/TS1005/);
	});

	it('a failing TEST is a RED gate — not a follow-up-and-carry-on (the PCG-1 reversal)', async () => {
		const runner = fakeRunner((file, args) =>
			args[0] === 'test' ? { code: 1, stdout: '3 failed', stderr: '' } : OK
		);
		const gate = await runPreCommitGate(
			{ cwd: fullRoot, buildTool: 'npm', testCommand: 'npm test' },
			{ run: runner }
		);
		expect(gate.status).toBe('failed');
		expect(gate.failedAt).toBe('test');
		expect(gate.steps.find((s) => s.name === 'test')?.detail).toMatch(/3 failed/);
	});

	it('UPSTREAM ERROR: a runner that THROWS is RED + errored — "could not verify" is never "verified"', async () => {
		const runner = fakeRunner(() => {
			throw new Error('spawn npm ENOENT');
		});
		const gate = await runPreCommitGate({ cwd: fullRoot, buildTool: 'npm' }, { run: runner });

		expect(gate.status).toBe('failed');
		expect(gate.errored).toBe(true);
		expect(gate.failedAt).toBe('build');
		// Nothing actually ran, so nothing was verified — and we still do NOT claim a pass.
		expect(gate.verified).toBe(false);
		expect(gate.steps[0].detail).toMatch(/could not run: spawn npm ENOENT/);
		expect(gate.summary).toMatch(/COULD NOT RUN/);
	});
});

describe('pre-commit gate — the SKIP path (honest, and deliberately not a failure)', () => {
	it('NIL: no cwd ⇒ skipped, and NOT ONE command is spawned in some other directory', async () => {
		const runner = fakeRunner(() => OK);
		const gate = await runPreCommitGate({ cwd: '', buildTool: 'npm' }, { run: runner });
		expect(gate.status).toBe('skipped');
		expect(gate.verified).toBe(false);
		expect(gate.errored).toBe(false);
		expect(runner.calls.length).toBe(0);
		expect(gate.summary).toMatch(/no working dir/);
	});

	it('NIL: a cwd that does not exist on disk ⇒ skipped, nothing spawned', async () => {
		const runner = fakeRunner(() => OK);
		const gate = await runPreCommitGate(
			{ cwd: join(tmpdir(), 'pcg-does-not-exist-9f3a'), buildTool: 'npm' },
			{ run: runner }
		);
		expect(gate.status).toBe('skipped');
		expect(runner.calls.length).toBe(0);
		expect(gate.summary).toMatch(/not found on disk/);
	});

	it('EMPTY: an npm project declaring NO scripts and no test target ⇒ skipped, never a false RED', async () => {
		const bare = mkdtempSync(join(tmpdir(), 'pcg-empty-'));
		writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'bare' }));
		try {
			// `npm` DOES map to a build command, so the build step still runs; force it to be the only
			// resolvable one and assert lint/typecheck/test each skip with their own named reason.
			const runner = fakeRunner(() => OK);
			const gate = await runPreCommitGate({ cwd: bare, buildTool: 'npm' }, { run: runner });
			expect(gate.steps.find((s) => s.name === 'lint')?.detail).toMatch(/declares no "lint" script/);
			expect(gate.steps.find((s) => s.name === 'typecheck')?.detail).toMatch(
				/declares no "typecheck" script/
			);
			expect(gate.steps.find((s) => s.name === 'test')?.detail).toMatch(/no resolved test target/);
			// One step ran (build) so this is a PASS, not a skip — `verified` says what was checked.
			expect(gate.status).toBe('passed');
			expect(gate.verified).toBe(true);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it('NIL: no build_tool and no test command ⇒ skipped with every reason named (UNVERIFIED, honest)', async () => {
		const runner = fakeRunner(() => OK);
		const gate = await runPreCommitGate({ cwd: root }, { run: runner });
		expect(gate.status).toBe('skipped');
		expect(gate.verified).toBe(false);
		expect(runner.calls.length).toBe(0);
		expect(gate.summary).toMatch(/UNVERIFIED/);
		expect(gate.steps.find((s) => s.name === 'build')?.detail).toMatch(/no project build_tool/);
	});

	it('an un-buildable tool (pip) is a named skip, never the bare token run as a command', async () => {
		const runner = fakeRunner(() => OK);
		const gate = await runPreCommitGate({ cwd: root, buildTool: 'pip' }, { run: runner });
		expect(runner.calls.length).toBe(0);
		expect(gate.steps[0].detail).toMatch(/no known real build command/);
		expect(gate.status).toBe('skipped');
	});
});

describe('pre-commit gate — the interrupt contract', () => {
	it('is re-runnable: a second run over the same tree yields the identical verdict (no own state)', async () => {
		const script = (file: string, args: readonly string[]): CommandResult =>
			args[1] === 'lint' ? { code: 1, stdout: 'lint error', stderr: '' } : OK;
		const first = await runPreCommitGate(
			{ cwd: fullRoot, buildTool: 'npm', testCommand: 'npm test' },
			{ run: fakeRunner(script) }
		);
		const second = await runPreCommitGate(
			{ cwd: fullRoot, buildTool: 'npm', testCommand: 'npm test' },
			{ run: fakeRunner(script) }
		);
		expect(second.status).toBe(first.status);
		expect(second.failedAt).toBe(first.failedAt);
		expect(second.steps.map((s) => [s.name, s.ran, s.ok])).toEqual(
			first.steps.map((s) => [s.name, s.ran, s.ok])
		);
	});

	it('NEVER throws: a rejecting runner on EVERY step still returns a verdict (the drain stays up)', async () => {
		const gate = await runPreCommitGate(
			{ cwd: fullRoot, buildTool: 'npm', testCommand: 'npm test' },
			{
				run: fakeRunner(() => {
					throw new Error('boom');
				})
			}
		);
		expect(gate.status).toBe('failed');
		expect(gate.errored).toBe(true);
	});
});
