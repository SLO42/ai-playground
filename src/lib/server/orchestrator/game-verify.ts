// GAME-VERIFY runner — the heart of the live game-mod verification capability
// (spec: docs/GAME-VERIFY-SPEC.md). Verify a BUILT mod by RUNNING the game:
//   deploy artifact → launch game (detached) → poll its log for a ready signal →
//   capture+screen a structured verdict → KILL the game (always) → feed back.
//
// This is INFRASTRUCTURE, not a mod and not game-specific code. ROUNDS is only the
// reference config; the runner is generic (deploy → launch → poll-log → capture → kill →
// verdict). It mirrors the post-task.ts exec-runner discipline:
//   • execFile / spawn with ARGUMENT ARRAYS, never an interpolated shell string (D-008/F-002).
//   • every OS touch is an INJECTABLE SEAM (launcher / killer / logReader / clock / copier)
//     so the TEST suite NEVER launches a real game or reads a real log (F-010/F-014).
//   • NEVER throws out of runGameVerify — a fault here is caught and returned as an HONEST
//     verdict, so a bad game-verify can never crash the orchestrator drain (F-014/F-048).
//
// NON-NEGOTIABLE RAILS:
//   • F-014: the game process is ALWAYS killed — success, errors, not_ready, crashed,
//     timeout, OR a thrown error (try/finally). No orphan game process EVER. The poll is
//     wall-clock bounded with bounded backoff — NEVER a spin-retry.
//   • F-001: kill via `taskkill /F /IM` on Windows — `process.kill` is unreliable there.
//   • D-026: every captured log string (stack traces, log tail) is run through
//     screenForDisplay (secret/PII/home-path redact) BEFORE it enters the verdict.
//   • F-008: honest states — outcome ∈ pass|errors|not_ready|crashed|timeout. not_ready,
//     timeout and crashed are NEVER a pass; nothing is fabricated.

import { spawn, execFile } from 'node:child_process';
import { readFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { dirname, join, basename, isAbsolute, sep } from 'node:path';
import { screenForDisplay } from '../memory/observability';

// ── Config (the per-project, operator-set harness — absent ⇒ capability disabled) ─────

/** One deploy step: copy built-artifact(s) matching `source` (glob) → `target` (abs path). */
export interface GameVerifyDeploy {
	/** Glob matched against the built artifacts / files under the project cwd. */
	source: string;
	/** Absolute destination path under the game install (a dir, or an explicit file path). */
	target: string;
}

/** A launch command: a `steam://rungameid/<appid>` URI, OR an explicit exe + args. */
export type GameLaunchCommand = string | { exe: string; args?: string[] };

/**
 * The per-project game-verify harness. OPERATOR-SET — the agent never invents
 * launch_command / process_name / paths. Absent ⇒ the capability is OFF (like test_command).
 */
export interface GameVerifyConfig {
	launch_command: GameLaunchCommand;
	/** Process image name for the MANDATORY kill (e.g. `ROUNDS.exe`). */
	process_name: string;
	/** Deploy steps (the ONLY writes outside the project root, to configured paths). */
	deploy?: GameVerifyDeploy[];
	/** Absolute path to the log to read (e.g. `<game>/BepInEx/LogOutput.log`). */
	log_path: string;
	/** Regex (source) signalling load finished (e.g. `Chainloader startup complete`). */
	ready_pattern: string;
	/** Regexes (sources) counted as a successful load line. */
	success_patterns?: string[];
	/** Regexes (sources) counted as errors (NRE / MissingMethod / Exception / Fatal). */
	error_patterns?: string[];
	/** Wall-clock cap for the readiness poll (default 120000). */
	timeout_ms?: number;
	/** How many lines to capture after each error-class match (default 20). */
	stack_capture_lines?: number;
}

// ── Verdict (honest states — F-008) ───────────────────────────────────────────────────

export type GameVerifyOutcome = 'pass' | 'errors' | 'not_ready' | 'crashed' | 'timeout';

export interface GameVerifyVerdict {
	/** pass = ready + a load line + zero error matches; errors = ready but errors matched;
	 *  not_ready = ready signal never seen (and not a timeout/crash); timeout = wall-clock
	 *  elapsed without ready; crashed = the game process died before ready. */
	outcome: GameVerifyOutcome;
	/** The ready_pattern was seen in the log. */
	ready: boolean;
	/** A success/load pattern matched (or, when none are configured, == ready). */
	loaded: boolean;
	/** Total error-pattern matches. */
	errorCount: number;
	/** Per-pattern match counts (keyed by the raw pattern source), success + error. */
	byPattern: Record<string, number>;
	/** First N lines after each error-class match — SCREENED (D-026). */
	stackTraces: string[];
	/** A short tail of the log — SCREENED (D-026). '' when no log was read. */
	logTail: string;
	/** Honest human-readable reason (e.g. config error, env failure). Absent on a clean run. */
	note?: string;
	/** Deploy steps that copied an artifact (source→target), for operator visibility. */
	deployed?: { source: string; target: string }[];
}

// ── Injectable seams (tests pass fakes — NO live game / log / process EVER) ────────────

/** A launched game. `isAlive` is an OPTIONAL liveness probe used for crash detection. */
export interface LaunchHandle {
	pid?: number;
	/** True while the game process is still running. Absent ⇒ crash not detectable (poll to ready/timeout). */
	isAlive?: () => Promise<boolean>;
}

export type Launcher = (cmd: GameLaunchCommand, opts: { cwd: string }) => Promise<LaunchHandle>;
/** Kill the game by process image name. MUST resolve (never throw) — best-effort, idempotent. */
export type Killer = (processName: string) => Promise<void>;
/** Read the whole log, or null when the file is not present YET (fresh boot overwrites it). */
export type LogReader = (path: string) => Promise<string | null>;
/** A monotonic clock + sleep — injected so tests drive the poll deterministically (no real wait). */
export interface Clock {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}
/** Copy one file source→dest (creates parent dirs). Injected so deploy never touches a real FS in tests. */
export type FileCopier = (source: string, dest: string) => Promise<void>;
/** List candidate file paths under cwd (for glob resolution). Injected for deterministic deploy tests. */
export type FileLister = (cwd: string) => Promise<string[]>;

export interface GameVerifyDeps {
	launcher?: Launcher;
	killer?: Killer;
	logReader?: LogReader;
	clock?: Clock;
	copier?: FileCopier;
	listFiles?: FileLister;
}

export interface GameVerifyContext {
	/** Already-built artifact paths (preferred deploy source candidates). */
	builtArtifacts?: string[];
	/** The project working dir (deploy globs resolve relative to it). */
	cwd: string;
}

// ── Defaults (real OS impls — bypassed entirely by injected seams in tests) ────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STACK_LINES = 20;
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 2000;
const MAX_STACK_BLOCKS = 10; // bound the verdict size (F-014 — never unbounded capture)
const LOG_TAIL_LINES = 40;
const WALK_FILE_CAP = 5000; // bound the deploy-source walk (never an unbounded FS scan)

const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};

const realLogReader: LogReader = async (path) => {
	try {
		return await readFile(path, 'utf8');
	} catch (err) {
		// File-absent-yet is the NORMAL fresh-boot state (BepInEx overwrites the log on boot).
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
};

const realLauncher: Launcher = async (cmd, opts) => {
	if (typeof cmd === 'string') {
		// A protocol URI (steam://…) — hand it to the shell's `start` so Windows resolves the
		// handler. Steam then launches the game in a SEPARATE process, so this child's PID is
		// not the game's; liveness is not meaningful here (poll to ready/timeout, kill by name).
		const child = spawn('cmd', ['/c', 'start', '', cmd], {
			cwd: opts.cwd,
			detached: true,
			stdio: 'ignore',
			windowsHide: true
		});
		child.unref();
		return { pid: child.pid };
	}
	// An explicit exe + args (ARGUMENT ARRAY, no shell — D-008/F-002). Detached + tracked.
	const child = spawn(cmd.exe, [...(cmd.args ?? [])], {
		cwd: opts.cwd,
		detached: true,
		stdio: 'ignore',
		windowsHide: true
	});
	child.unref();
	let exited = false;
	child.on('exit', () => {
		exited = true;
	});
	child.on('error', () => {
		exited = true;
	});
	return { pid: child.pid, isAlive: async () => !exited };
};

const realKiller: Killer = (processName) =>
	new Promise<void>((resolve) => {
		// F-001: process.kill is unreliable on Windows — use taskkill /F /IM with an ARGUMENT
		// ARRAY (no shell). Best-effort: a non-zero exit (process already gone) is swallowed.
		execFile('taskkill', ['/F', '/IM', processName], { windowsHide: true }, () => resolve());
	});

const realCopier: FileCopier = async (source, dest) => {
	await mkdir(dirname(dest), { recursive: true });
	await copyFile(source, dest);
};

const realLister: FileLister = async (cwd) => {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		if (out.length >= WALK_FILE_CAP) return;
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= WALK_FILE_CAP) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				// Skip the usual heavy/irrelevant trees so the walk stays bounded.
				if (e.name === 'node_modules' || e.name === '.git' || e.name === 'obj') continue;
				await walk(full);
			} else if (e.isFile()) {
				out.push(full);
			}
		}
	}
	await walk(cwd);
	return out;
};

// ── Pure helpers (glob, regex, capture) — unit-testable in isolation ──────────────────

/**
 * Convert a glob (`**`, `*`, `?`) to an anchored RegExp matching a `/`-normalized path.
 * `**` matches across separators; `*` matches a run of non-separator chars; `?` one char.
 */
export function globToRegExp(glob: string): RegExp {
	const norm = glob.replace(/\\/g, '/');
	let re = '';
	for (let i = 0; i < norm.length; i++) {
		const c = norm[i];
		if (c === '*') {
			if (norm[i + 1] === '*') {
				// `**` (optionally followed by `/`) → match any chars incl. separators.
				re += '.*';
				i++;
				if (norm[i + 1] === '/') i++;
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if ('\\^$.|+()[]{}'.includes(c)) {
			re += '\\' + c;
		} else {
			re += c;
		}
	}
	return new RegExp('(?:^|/)' + re + '$', 'i');
}

/** Compile a pattern source to {global-count, line-test} regexes, or null when invalid. */
function compilePattern(src: string): { count: RegExp; test: RegExp } | null {
	try {
		return { count: new RegExp(src, 'g'), test: new RegExp(src) };
	} catch {
		return null;
	}
}

/** Count non-overlapping matches of a global regex in text. */
function countMatches(text: string, re: RegExp): number {
	re.lastIndex = 0;
	const m = text.match(re);
	return m ? m.length : 0;
}

/** First N lines starting at each line that matches any error pattern (bounded block count). */
function captureStacks(lines: string[], errorTests: RegExp[], n: number): string[] {
	const blocks: string[] = [];
	for (let i = 0; i < lines.length && blocks.length < MAX_STACK_BLOCKS; i++) {
		if (errorTests.some((re) => re.test(lines[i]))) {
			blocks.push(lines.slice(i, i + n).join('\n'));
		}
	}
	return blocks;
}

// ── The runner ────────────────────────────────────────────────────────────────────────

/**
 * Verify a built mod by running the game. NEVER throws: every fault (config error, deploy
 * failure, launcher/logReader exception) is caught and returned as an honest verdict, and the
 * game process is ALWAYS killed in `finally` (F-014). Serialization (one game-verify at a time
 * per game) is the orchestrator's responsibility — the runner itself runs a single pass.
 */
export async function runGameVerify(
	cfg: GameVerifyConfig,
	ctx: GameVerifyContext,
	opts: GameVerifyDeps = {}
): Promise<GameVerifyVerdict> {
	const clock = opts.clock ?? realClock;
	const logReader = opts.logReader ?? realLogReader;
	const launcher = opts.launcher ?? realLauncher;
	const killer = opts.killer ?? realKiller;
	const copier = opts.copier ?? realCopier;
	const listFiles = opts.listFiles ?? realLister;

	const timeout = cfg.timeout_ms && cfg.timeout_ms > 0 ? cfg.timeout_ms : DEFAULT_TIMEOUT_MS;
	const stackLines =
		cfg.stack_capture_lines && cfg.stack_capture_lines > 0
			? cfg.stack_capture_lines
			: DEFAULT_STACK_LINES;

	// MANDATORY kill, exactly once, on EVERY exit path (F-014). Best-effort — a kill failure
	// never propagates (we already swallow inside realKiller; guard injected killers too).
	let killed = false;
	const killOnce = async (): Promise<void> => {
		if (killed) return;
		killed = true;
		try {
			await killer(cfg.process_name);
		} catch {
			/* best-effort — never let a kill failure mask the verdict (F-014) */
		}
	};

	try {
		// ── ready_pattern is load-bearing: an invalid one is a config error → honest verdict ──
		const readyRe = compilePattern(cfg.ready_pattern);
		if (!readyRe) {
			return honest('not_ready', `invalid ready_pattern: ${cfg.ready_pattern}`);
		}

		// ── 1. DEPLOY (skip when no deploy block) ─────────────────────────────────────────
		const deployed: { source: string; target: string }[] = [];
		if (cfg.deploy && cfg.deploy.length > 0) {
			// Candidate sources: explicit built artifacts first, else a bounded cwd walk.
			const candidates =
				ctx.builtArtifacts && ctx.builtArtifacts.length > 0
					? ctx.builtArtifacts
					: await listFiles(ctx.cwd);
			for (const step of cfg.deploy) {
				// VALIDATION (rail): the destination MUST be the configured, absolute target —
				// never a path derived from the (possibly attacker-influenced) source basename in
				// a way that escapes it. We only ever write under `step.target`.
				if (!isAbsolute(step.target)) {
					return honest('not_ready', `deploy target must be an absolute path: ${step.target}`);
				}
				const glob = globToRegExp(step.source);
				const matches = candidates.filter((p) => glob.test(p.replace(/\\/g, '/')));
				for (const src of matches) {
					// Target may be a directory (ends with a separator) or an explicit file path.
					const dest =
						step.target.endsWith('/') || step.target.endsWith('\\') || step.target.endsWith(sep)
							? join(step.target, basename(src))
							: step.target;
					// Guard: the resolved dest stays under the configured target prefix. Compare
					// separator-normalized (join emits OS-native separators; the config may use `/`).
					const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
					if (!norm(dest).startsWith(norm(step.target))) {
						return honest('not_ready', `deploy dest escaped target: ${dest}`);
					}
					await copier(src, dest);
					// D-026: `source` (listFiles/builtArtifacts) and `target` (operator config) can each
					// embed a host home path (C:\Users\<name>\…); GV-4 RENDERS deployed[] in the
					// command-center. Screen BOTH at this capture choke — like stackTraces/logTail — so the
					// PERSISTED verdict never carries a raw home path. copier ran on the RAW paths above;
					// only the stored strings are screened. screenForDisplay is idempotent (re-screening
					// already-redacted text is a no-op) and never throws (fails closed).
					deployed.push({
						source: screenForDisplay(src).text,
						target: screenForDisplay(dest).text
					});
				}
			}
		}

		// ── 2. LAUNCH (detached, process TRACKED for the kill) ────────────────────────────
		const handle = await launcher(cfg.launch_command, { cwd: ctx.cwd });

		// ── 3. POLL the log until ready_pattern OR timeout — bounded backoff, NEVER spin ──
		const start = clock.now();
		let logText = '';
		let ready = false;
		let crashed = false;
		let timedOut = false;
		let backoff = POLL_MIN_MS;
		// First read happens immediately; subsequent reads back off up to POLL_MAX_MS.
		for (;;) {
			let read: string | null = null;
			try {
				read = await logReader(cfg.log_path);
			} catch (err) {
				// A read fault (not just absent) is honest, not fatal — treat as no-log-yet and
				// keep polling within the bound; record the last error in the note via throw-up only
				// if it persists. Here we simply continue; absent/garbled log → not_ready/timeout.
				read = null;
				logText = logText || `log read error: ${(err as Error).message}`;
			}
			if (read != null) logText = read;
			if (read != null && readyRe.test.test(read)) {
				ready = true;
				break;
			}
			// Crash detection: the game process died before we ever saw ready.
			if (handle.isAlive) {
				let alive = true;
				try {
					alive = await handle.isAlive();
				} catch {
					alive = false;
				}
				if (!alive) {
					crashed = true;
					break;
				}
			}
			if (clock.now() - start >= timeout) {
				timedOut = true;
				break;
			}
			await clock.sleep(backoff);
			backoff = Math.min(backoff * 2, POLL_MAX_MS);
		}

		// ── 4. CAPTURE — per-pattern counts + stack blocks after each error-class match ──
		const byPattern: Record<string, number> = {};
		const successSrcs = cfg.success_patterns ?? [];
		const errorSrcs = cfg.error_patterns ?? [];

		let successTotal = 0;
		for (const src of successSrcs) {
			const re = compilePattern(src);
			const c = re ? countMatches(logText, re.count) : 0;
			byPattern[src] = c;
			successTotal += c;
		}
		let errorCount = 0;
		const errorTests: RegExp[] = [];
		for (const src of errorSrcs) {
			const re = compilePattern(src);
			const c = re ? countMatches(logText, re.count) : 0;
			byPattern[src] = c;
			errorCount += c;
			if (re) errorTests.push(re.test);
		}

		const lines = logText ? logText.split(/\r?\n/) : [];
		const rawStacks = captureStacks(lines, errorTests, stackLines);
		const rawTail = lines.slice(-LOG_TAIL_LINES).join('\n');

		// ── 5. SCREEN every captured string before it enters the verdict (D-026) ──────────
		const stackTraces = rawStacks.map((b) => screenForDisplay(b).text).filter((t) => t.length > 0);
		const logTail = screenForDisplay(rawTail).text;

		// loaded: when success patterns are configured, a load line must have matched;
		// when none are configured, "loaded" degrades to "ready" (the chainloader finished).
		const loaded = successSrcs.length > 0 ? successTotal > 0 : ready;

		// ── 6. OUTCOME (honest — F-008) ───────────────────────────────────────────────────
		let outcome: GameVerifyOutcome;
		if (crashed) outcome = 'crashed';
		else if (!ready) outcome = timedOut ? 'timeout' : 'not_ready';
		else if (errorCount > 0) outcome = 'errors';
		else if (loaded) outcome = 'pass';
		else outcome = 'not_ready'; // ready, but the mod's load line never appeared → NOT a pass

		const verdict: GameVerifyVerdict = {
			outcome,
			ready,
			loaded,
			errorCount,
			byPattern,
			stackTraces,
			logTail
		};
		if (deployed.length > 0) verdict.deployed = deployed;
		return verdict;
	} catch (err) {
		// EVERY ERROR HAS A NAME: an unexpected fault (launcher threw, copier threw, …) is
		// caught here and returned as an honest verdict — it NEVER propagates to crash the
		// orchestrator drain (F-014/F-048).
		return honest('not_ready', `game-verify fault: ${(err as Error).message}`);
	} finally {
		// F-014 — the game is ALWAYS killed, on success, every failure, AND any throw.
		await killOnce();
	}
}

/**
 * An honest, fully-formed verdict for a config/env fault — never a fabricated pass.
 *
 * D-026: `note` is built from operator-set config paths AND OS error messages (a launcher/
 * copier ENOENT/EACCES can embed a host home path `C:\Users\<name>\…` or a token-shaped
 * string). GV-4 RENDERS `note` in the command-center, so — like stackTraces/logTail — it MUST
 * pass through screenForDisplay BEFORE it enters the verdict. This is the SINGLE note choke
 * point: every honest outcome (config error, deploy-escape, not_ready, the catch path) is
 * constructed here, and the clean-run verdict never sets a note. Display-safe: screenForDisplay
 * never throws (screen.ts fails CLOSED to a screened/quarantined string), so we keep .text and
 * never mask the outcome.
 */
function honest(outcome: GameVerifyOutcome, note: string): GameVerifyVerdict {
	return {
		outcome,
		ready: false,
		loaded: false,
		errorCount: 0,
		byPattern: {},
		stackTraces: [],
		logTail: '',
		note: screenForDisplay(note).text
	};
}
