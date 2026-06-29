import { describe, it, expect } from 'vitest';
import {
	runGameVerify,
	globToRegExp,
	type GameVerifyConfig,
	type GameVerifyContext,
	type Launcher,
	type Killer,
	type LogReader,
	type Clock,
	type FileCopier,
	type LaunchHandle
} from './game-verify';

// GAME-VERIFY VERIFY (spec docs/GAME-VERIFY-SPEC.md §2/§3; F-014 kill-always; F-010 never a
// real game; D-026 screen; F-008 honest states).
//
// A FAKE-GAME HARNESS only — the runner's every OS touch (launcher / killer / logReader /
// clock / copier) is an injected seam, so NO real game launches and NO real log is read (the
// post-task.test.ts fakeRunner discipline). A scripted logReader emits a canned BepInEx log to
// drive EACH outcome deterministically; a fake clock makes the timeout poll instant. We assert
// the game is killed on EVERY path (no orphan — F-014) and that captured output is SCREENED.

// ── Fakes ─────────────────────────────────────────────────────────────────────────────

/** A logReader that returns a scripted sequence of states (last state repeats). */
function seqLogReader(states: (string | null)[]): LogReader {
	let i = 0;
	// Fewer params than LogReader is assignable (it ignores the path) — no cast needed.
	return async () => {
		const s = i < states.length ? states[i] : states[states.length - 1];
		i++;
		return s;
	};
}

/** A fake clock: `now` advances by exactly the slept amount (poll is instant + deterministic). */
function fakeClock(): Clock & { sleeps: () => number } {
	let t = 0;
	let sleeps = 0;
	const c = {
		now: () => t,
		sleep: async (ms: number) => {
			sleeps++;
			t += ms;
		},
		sleeps: () => sleeps
	};
	return c;
}

/** A fake killer that records every call (asserts kill-after on every path — F-014). */
function fakeKiller(): Killer & { calls: string[] } {
	const calls: string[] = [];
	const fn = (async (name: string) => {
		calls.push(name);
	}) as Killer & { calls: string[] };
	fn.calls = calls;
	return fn;
}

/** A fake launcher that records the command + returns a (optionally crashing) handle. */
function fakeLauncher(handle: LaunchHandle = { pid: 4242 }): Launcher & {
	calls: { cmd: unknown; cwd: string }[];
} {
	const calls: { cmd: unknown; cwd: string }[] = [];
	const fn = (async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd });
		return handle;
	}) as Launcher & { calls: typeof calls };
	fn.calls = calls;
	return fn;
}

const baseCfg: GameVerifyConfig = {
	launch_command: 'steam://rungameid/1557740',
	process_name: 'ROUNDS.exe',
	log_path: 'E:/SteamLibrary/common/ROUNDS/BepInEx/LogOutput.log',
	ready_pattern: 'Chainloader startup complete',
	success_patterns: ['Rounds Unbound loaded'],
	error_patterns: ['NullReferenceException', 'MissingMethodException', 'AmbiguousMatch', 'Fatal'],
	timeout_ms: 5000,
	stack_capture_lines: 5
};

const ctx: GameVerifyContext = { cwd: 'F:/code/ai-playground-v2', builtArtifacts: [] };

const PASS_LOG = [
	'[Info   :   BepInEx] BepInEx 5.4.23.5',
	'[Info   :   BepInEx] Loading [Rounds Unbound 3.1.0]',
	'[Info   :Rounds Unbound] Rounds Unbound loaded.',
	'[Message:   BepInEx] Chainloader startup complete',
	'[Info   : Steamworks] SignIn ok'
].join('\n');

const ERRORS_LOG = [
	'[Message:   BepInEx] Chainloader startup complete',
	'[Error  :    Unity] NullReferenceException: Object reference not set to an instance',
	'  at GM_ArmsRace.Start () [0x00000]',
	'  at MonoBehaviour.Invoke () [0x00001]',
	'[Error  :    Unity] MissingMethodException: method not found'
].join('\n');

const NO_READY_LOG = [
	'[Info   :   BepInEx] BepInEx 5.4.23.5',
	'[Info   :   BepInEx] Loading [Rounds Unbound 3.1.0]'
].join('\n');

// ── Tests ───────────────────────────────────────────────────────────────────────────

describe('runGameVerify — honest verdicts + mandatory kill (F-014)', () => {
	it('(a) pass: ready + load line + 0 errors → outcome pass, kill ran once', async () => {
		const killer = fakeKiller();
		const launcher = fakeLauncher();
		// File absent for the first two polls (fresh boot overwrites it), then the full log.
		const logReader = seqLogReader([null, null, PASS_LOG]);
		const clock = fakeClock();

		const v = await runGameVerify(baseCfg, ctx, { killer, launcher, logReader, clock });

		expect(v.outcome).toBe('pass');
		expect(v.ready).toBe(true);
		expect(v.loaded).toBe(true);
		expect(v.errorCount).toBe(0);
		expect(v.byPattern['Rounds Unbound loaded']).toBe(1);
		// F-014: the game was killed exactly once.
		expect(killer.calls).toEqual(['ROUNDS.exe']);
		expect(launcher.calls).toHaveLength(1);
	});

	it('(b) errors: ready but error patterns match → outcome errors + screened stack capture', async () => {
		const killer = fakeKiller();
		const logReader = seqLogReader([ERRORS_LOG]);
		const clock = fakeClock();

		const v = await runGameVerify(baseCfg, ctx, {
			killer,
			launcher: fakeLauncher(),
			logReader,
			clock
		});

		expect(v.outcome).toBe('errors');
		expect(v.ready).toBe(true);
		expect(v.errorCount).toBeGreaterThanOrEqual(2);
		expect(v.byPattern['NullReferenceException']).toBe(1);
		expect(v.byPattern['MissingMethodException']).toBe(1);
		// A stack block was captured after the NRE and screened.
		expect(v.stackTraces.length).toBeGreaterThan(0);
		expect(v.stackTraces[0]).toContain('GM_ArmsRace.Start');
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});

	it('(c) timeout: ready never seen within timeout_ms → outcome timeout, bounded (no spin)', async () => {
		const killer = fakeKiller();
		const logReader = seqLogReader([NO_READY_LOG]);
		const clock = fakeClock();

		const v = await runGameVerify(
			{ ...baseCfg, timeout_ms: 1000 },
			ctx,
			{ killer, launcher: fakeLauncher(), logReader, clock }
		);

		expect(v.outcome).toBe('timeout');
		expect(v.ready).toBe(false);
		expect(v.loaded).toBe(false);
		// NEVER a spin: the poll slept a small, bounded number of times then gave up.
		expect(clock.sleeps()).toBeGreaterThan(0);
		expect(clock.sleeps()).toBeLessThan(8);
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});

	it('(d) crashed: process dies before ready → outcome crashed, kill still ran', async () => {
		const killer = fakeKiller();
		let polls = 0;
		const handle: LaunchHandle = {
			pid: 99,
			isAlive: async () => {
				polls++;
				return polls < 2; // alive on the first probe, dead on the second
			}
		};
		const logReader = seqLogReader([NO_READY_LOG]);
		const clock = fakeClock();

		const v = await runGameVerify(baseCfg, ctx, {
			killer,
			launcher: fakeLauncher(handle),
			logReader,
			clock
		});

		expect(v.outcome).toBe('crashed');
		expect(v.ready).toBe(false);
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});

	it('screens secrets/paths out of captured output (D-026) — no raw home path / credential', async () => {
		const killer = fakeKiller();
		const leaky = [
			'[Message:   BepInEx] Chainloader startup complete',
			'[Error  :    Unity] NullReferenceException at C:\\Users\\victim\\AppData\\game.dll',
			'  config loaded password=supersecret123 from disk'
		].join('\n');
		const v = await runGameVerify(baseCfg, ctx, {
			killer,
			launcher: fakeLauncher(),
			logReader: seqLogReader([leaky]),
			clock: fakeClock()
		});

		expect(v.outcome).toBe('errors');
		const blob = v.logTail + '\n' + v.stackTraces.join('\n');
		expect(blob).not.toContain('victim');
		expect(blob).not.toContain('supersecret123');
		expect(blob).toContain('[REDACTED:home-path]');
		expect(blob).toContain('[REDACTED:credential]');
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});

	it('a thrown launcher fault is caught → honest verdict, game still killed (F-048)', async () => {
		const killer = fakeKiller();
		const throwingLauncher: Launcher = async () => {
			throw new Error('Steam not running');
		};
		const v = await runGameVerify(baseCfg, ctx, {
			killer,
			launcher: throwingLauncher,
			logReader: seqLogReader([PASS_LOG]),
			clock: fakeClock()
		});

		// NEVER throws out of runGameVerify — honest non-pass + the kill still ran.
		expect(v.outcome).toBe('not_ready');
		expect(v.note).toContain('Steam not running');
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});

	it('invalid ready_pattern is a config error → honest not_ready (never a fabricated pass)', async () => {
		const killer = fakeKiller();
		const v = await runGameVerify(
			{ ...baseCfg, ready_pattern: '([unterminated' },
			ctx,
			{ killer, launcher: fakeLauncher(), logReader: seqLogReader([PASS_LOG]), clock: fakeClock() }
		);
		expect(v.outcome).toBe('not_ready');
		expect(v.note).toContain('invalid ready_pattern');
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});

	it('no deploy block + empty log (nil/empty shadow path) → not_ready, no crash', async () => {
		const killer = fakeKiller();
		const v = await runGameVerify(
			{ ...baseCfg, timeout_ms: 1000 },
			ctx,
			{ killer, launcher: fakeLauncher(), logReader: seqLogReader([null]), clock: fakeClock() }
		);
		// Log file never appears → ready never seen → timeout (honest), kill ran.
		expect(v.outcome).toBe('timeout');
		expect(v.logTail).toBe('');
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});
});

describe('runGameVerify — deploy (configured paths only, injected copier)', () => {
	it('copies a glob-matched artifact to the configured target dir; records it', async () => {
		const killer = fakeKiller();
		const copies: { source: string; dest: string }[] = [];
		const copier: FileCopier = async (source, dest) => {
			copies.push({ source, dest });
		};
		const cfg: GameVerifyConfig = {
			...baseCfg,
			deploy: [{ source: '**/UnboundLib.dll', target: 'E:/games/ROUNDS/BepInEx/plugins/mod/' }]
		};
		const deployCtx: GameVerifyContext = {
			cwd: 'F:/code/proj',
			builtArtifacts: [
				'F:/code/proj/bin/Release/UnboundLib.dll',
				'F:/code/proj/bin/Release/Readme.txt'
			]
		};
		const v = await runGameVerify(cfg, deployCtx, {
			killer,
			launcher: fakeLauncher(),
			logReader: seqLogReader([PASS_LOG]),
			clock: fakeClock(),
			copier
		});

		expect(copies).toHaveLength(1);
		expect(copies[0].source).toBe('F:/code/proj/bin/Release/UnboundLib.dll');
		expect(copies[0].dest).toContain('UnboundLib.dll');
		expect(copies[0].dest).toContain('plugins');
		// The verdict records exactly what was deployed (source → resolved target).
		expect(v.deployed).toEqual([
			{ source: 'F:/code/proj/bin/Release/UnboundLib.dll', target: copies[0].dest }
		]);
		expect(v.outcome).toBe('pass');
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});

	it('a non-absolute deploy target is rejected with an honest verdict (rail)', async () => {
		const killer = fakeKiller();
		const cfg: GameVerifyConfig = {
			...baseCfg,
			deploy: [{ source: '**/UnboundLib.dll', target: 'relative/plugins/' }]
		};
		const v = await runGameVerify(
			cfg,
			{ cwd: 'F:/code/proj', builtArtifacts: ['F:/code/proj/UnboundLib.dll'] },
			{ killer, launcher: fakeLauncher(), logReader: seqLogReader([PASS_LOG]), clock: fakeClock() }
		);
		expect(v.outcome).toBe('not_ready');
		expect(v.note).toContain('absolute path');
		expect(killer.calls).toEqual(['ROUNDS.exe']);
	});
});

describe('globToRegExp', () => {
	it('matches ** across separators and * within a segment', () => {
		expect(globToRegExp('**/UnboundLib.dll').test('a/b/c/UnboundLib.dll')).toBe(true);
		expect(globToRegExp('**/UnboundLib.dll').test('UnboundLib.dll')).toBe(true);
		expect(globToRegExp('bin/*.dll').test('bin/Foo.dll')).toBe(true);
		expect(globToRegExp('bin/*.dll').test('bin/sub/Foo.dll')).toBe(false);
		expect(globToRegExp('**/Foo.dll').test('bin/Bar.dll')).toBe(false);
	});
});
