// TASK 2.11 — external-edit watcher (D-010; depends on: 1.8).
//
// D-010: "Never silently overwrite hand-edited files — diff and confirm." The confirm-token
// guard in write.ts catches a hand-edit at WRITE time. This watcher is the proactive half:
// it watches a scope's `.claude/` (+ the sibling `.mcp.json`) on disk and fires when a file
// changes OUTSIDE our own write path — so the dashboard can flip the scope to "out_of_sync"
// the moment an external tool (or the operator's editor) touches a config file, instead of
// only discovering it on the next manual sync.
//
// Implementation: a debounced `fs.watch` over the scope tree. fs.watch is intentionally
// chatty + platform-variable (it can fire twice, or with a null filename on Windows), so we
// DEBOUNCE and then RE-COMPUTE the disk digest (parse.digestScope) and compare it to the
// digest captured at watch-start (or after the last fire). Only a REAL content change (a
// different digest) emits — cosmetic touch/atime events are filtered out. This makes the
// watcher robust to fs.watch's quirks and aligned with the same digest the mirror uses.
//
// Pure fs + the existing parser; NO DB write here (the route decides whether to re-sync or
// just surface the drift). Returns a disposer — the caller owns the lifecycle.

import { watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { digestScope, readScope } from './parse';

/** Emitted when a real content change is detected on disk. */
export interface ConfigChangeEvent {
	/** Absolute path to the watched `.claude` dir. */
	claudeDir: string;
	/** The new disk digest after the change. */
	digest: string;
	/** The digest before this change (what we last knew). */
	previousDigest: string;
}

export interface WatchOptions {
	/** Absolute path to the `.claude` dir to watch. */
	claudeDir: string;
	/** Optional explicit `.mcp.json` path (defaults to `<claudeDir>/../.mcp.json`). */
	mcpJsonPath?: string;
	/** Called when a real (digest-changing) external edit lands. */
	onChange: (ev: ConfigChangeEvent) => void;
	/** Debounce window for coalescing fs.watch's chatter (ms). Default 150. */
	debounceMs?: number;
}

/** A handle to stop watching. */
export interface WatchHandle {
	/** Stop all watchers + clear timers. Idempotent. */
	close: () => void;
	/** The digest the watcher currently considers "known" (updated after each fired change). */
	readonly currentDigest: () => string;
}

/**
 * Watch a scope's config tree and fire `onChange` only when the parsed content digest
 * actually changes. Watches the `.claude` dir recursively (agents/, skills/, settings.json)
 * and the sibling `.mcp.json` directory. Debounced + digest-gated so fs.watch's duplicate /
 * spurious events never produce a false "external edit". Returns a disposer.
 *
 * The watcher does NOT write the DB; it surfaces drift. A consumer that wants the mirror to
 * follow the disk calls syncScope (1.8) in its onChange handler. The digest comparison is
 * exactly the one the mirror's drift check uses (parse.digestScope), so "watcher fired" and
 * "syncState says out_of_sync" agree.
 */
export function watchScope(opts: WatchOptions): WatchHandle {
	const debounceMs = opts.debounceMs ?? 150;
	const mcpDir = dirname(opts.mcpJsonPath ?? join(opts.claudeDir, '..', '.mcp.json'));

	const compute = (): string => digestScope(readScope(opts.claudeDir, opts.mcpJsonPath));

	let knownDigest = compute();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const watchers: FSWatcher[] = [];

	const fire = (): void => {
		if (closed) return;
		const next = compute();
		if (next !== knownDigest) {
			const previousDigest = knownDigest;
			knownDigest = next;
			opts.onChange({ claudeDir: opts.claudeDir, digest: next, previousDigest });
		}
	};

	const onRaw = (): void => {
		if (closed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(fire, debounceMs);
	};

	// Watch the `.claude` tree recursively. `recursive` is supported on Windows + macOS;
	// on Linux we additionally rely on the directory watch firing for nested changes (the
	// digest re-read covers what the event itself does not name).
	const addWatch = (path: string, recursive: boolean): void => {
		try {
			const w = watch(path, { recursive, persistent: false }, onRaw);
			w.on('error', () => {}); // a transient watch error must never crash the server
			watchers.push(w);
		} catch {
			// Missing dir / unsupported recursive on this platform → degrade. The other
			// watchers + the digest re-read still catch changes; worst case the operator's
			// manual re-sync (1.8) is the backstop. Never throw out of setup.
		}
	};

	addWatch(opts.claudeDir, true);
	// The `.mcp.json` lives OUTSIDE `.claude` (project root) — watch its dir too, unless it
	// is the same dir we already watch.
	if (mcpDir !== opts.claudeDir) addWatch(mcpDir, false);

	return {
		close: () => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					/* already closed */
				}
			}
		},
		currentDigest: () => knownDigest
	};
}
