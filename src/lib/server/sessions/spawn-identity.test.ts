// SPAWN-IDENTITY — the purposeful-name table, and the guard that keeps every spawn seam using it.
//
// `spawn-identity.ts` is the write-path half of the LB-2 naming work: a session row is BORN with a
// name that says what the agent is FOR, instead of the pool slot id ("opus-1"/"sonnet-1") which is
// a model tier bucket. These tests assert two different things:
//
//   1. THE TABLE IS HONEST AND USABLE — every entry is non-blank, unique, and satisfies the
//      standing operator rule (2026-07-26: a display name must convey PURPOSE, never
//      tier/model/slot/id). A name that violated it would be the exact defect the module exists to
//      remove, shipped from the module that removes it.
//   2. THE SEAMS ACTUALLY USE IT — a source scan over every `launchSession(` call site in `src/`.
//      This is the regression that matters: the table is worthless if the next spawn seam added
//      forgets it, and TypeScript cannot catch an OMITTED optional field. A new seam either names
//      itself or lands on the EXEMPT list with a written reason — never silently unnamed.
//
// F-054: the scan normalizes CRLF→LF before matching (the editor flips line endings on Windows and
// a \r would silently break a source regex).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SPAWN_IDENTITIES, spawnIdentity, type SpawnIdentityKey } from './spawn-identity';

const SRC = join(process.cwd(), 'src');

/** Tokens that make a name a TIER/MODEL/SLOT bucket rather than a purpose (the operator rule). */
const BUCKET_TOKEN = /(^|[-_])(opus|sonnet|haiku|claude|gpt|ollama|local|slot|tier|agent|\d+)($|[-_])/i;

const entries = Object.entries(SPAWN_IDENTITIES) as Array<
	[SpawnIdentityKey, (typeof SPAWN_IDENTITIES)[SpawnIdentityKey]]
>;

describe('SPAWN_IDENTITIES — every entry conveys PURPOSE', () => {
	it('has at least one entry (an empty table would silently disable the whole write half)', () => {
		expect(entries.length).toBeGreaterThan(0);
	});

	it.each(entries)('%s: name is a non-blank, lowercase kebab handle', (key, entry) => {
		expect(entry.name, key).toBeTruthy();
		expect(entry.name.trim(), key).toBe(entry.name);
		// Kebab-case so it reads like a `.claude/agents` name or a role slug — the same shape the
		// naming composer already renders for those, so surfaces stay visually consistent.
		expect(entry.name, key).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
	});

	it.each(entries)('%s: name is NOT a tier/model/slot/ordinal bucket', (key, entry) => {
		// The named defect: `sonnet-1` says which ladder rung ran the work, not what the work was.
		expect(entry.name, `${key} → "${entry.name}"`).not.toMatch(BUCKET_TOKEN);
	});

	it.each(entries)('%s: purpose is a real sentence, not a restatement of the name', (key, entry) => {
		expect(entry.purpose.trim(), key).toBeTruthy();
		expect(entry.purpose.trim().length, key).toBeGreaterThan(20);
		expect(entry.purpose.trim().toLowerCase(), key).not.toBe(entry.name.toLowerCase());
		// It must say something the name does not — a purpose that is only the name re-hyphenated
		// carries no information into the spawn analytics event.
		expect(entry.purpose.split(/\s+/).length, key).toBeGreaterThan(4);
	});

	it.each(entries)('%s: seam names a real module', (key, entry) => {
		expect(entry.seam.trim(), key).toBeTruthy();
		expect(entry.seam, key).toMatch(/\.(ts|svelte)/);
	});

	it('names are UNIQUE — two seams sharing a name would merge into one scene node', () => {
		const names = entries.map(([, e]) => e.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe('spawnIdentity() — the LaunchInput fragment', () => {
	it.each(entries)('%s: returns BOTH fields, ready to spread', (key, entry) => {
		expect(spawnIdentity(key)).toEqual({ agentName: entry.name, agentPurpose: entry.purpose });
	});

	it('returns exactly the two launch keys — nothing that would leak `seam` onto a row', () => {
		// `seam` is documentation for a human reading the table; persisting it would put a source
		// path on a session row, which is provenance nobody asked for.
		expect(Object.keys(spawnIdentity('skillHarvester')).sort()).toEqual([
			'agentName',
			'agentPurpose'
		]);
	});
});

// ── The coverage guard ────────────────────────────────────────────────────────────────────────

/**
 * Call sites that legitimately do NOT name themselves here. Each needs a WRITTEN reason — a bare
 * exemption is how a rule rots. Anything not listed must supply an identity.
 */
const EXEMPT: Record<string, string> = {
	// The launch implementation itself — it RECEIVES the identity, it does not choose one.
	'lib/server/sessions/launch.ts': 'defines launchSession; the identity is an input',
	// The drain: its identity comes from the agent-pool slot the routing layer picked
	// (`config/agent-pool.yaml` slots[].name → boot.resolveSlotIdentity → route.agentName), which is
	// operator config, not a constant that belongs in this table.
	'lib/server/orchestrator/orchestrator.ts': 'named from the agent-pool slot via route.agentName',
	// DEFERRED (named): a workflow STEP declares only `agent` (a pool slot id) in
	// `workflows/repo.ts` WorkflowStep — there is no per-step name/purpose to carry, and inventing
	// one per step would be a fabricated identity (F-008). Adding `WorkflowStep.name/purpose` is a
	// config-shape change, out of scope for this task.
	'lib/server/workflows/runner.ts': 'WorkflowStep carries no name/purpose field yet (deferred)'
};

/**
 * Strip block and line comments so the scan matches CODE, not prose.
 *
 * The named failure this fixes: `channel.ts` and `reaper.ts` both DISCUSS launchSession in a
 * comment ("we reuse runtime.resume rather than launchSession (which …)") and were flagged as
 * unnamed spawn seams though neither spawns anything. A guard that cries wolf gets exempted into
 * uselessness. Crude by design — a `//` inside a string literal truncates that line, which cannot
 * hide a call because a call never follows a URL on the same line.
 */
function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Every `.ts`/`.svelte` file under src/, excluding tests. */
function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name === 'node_modules' || name === '__fixtures__') continue;
			sourceFiles(full, out);
			continue;
		}
		if (!/\.(ts|svelte)$/.test(name)) continue;
		if (/\.(test|spec)\.(ts|svelte)$/.test(name) || /\.live\.test\.ts$/.test(name)) continue;
		out.push(full);
	}
	return out;
}

describe('coverage guard — every spawn seam names itself', () => {
	it('no `launchSession(` call site spawns an unnamed session', () => {
		const unnamed: string[] = [];
		for (const file of sourceFiles(SRC)) {
			// F-054: normalize CRLF so the regexes below are line-ending agnostic.
			const text = stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
			if (!/\blaunchSession\s*\(/.test(text)) continue;
			const rel = relative(SRC, file).split(sep).join('/');
			if (rel in EXEMPT) continue;
			// A named seam either spreads the shared table or forwards a resolved name.
			if (/\bspawnIdentity\s*\(|\bagentName\b/.test(text)) continue;
			unnamed.push(rel);
		}
		// The failure message is the fix: it tells the next author exactly what to do.
		expect(
			unnamed,
			`These files call launchSession without a purposeful agent identity. Add ` +
				`\`...spawnIdentity('<key>')\` next to \`agentId\` (see sessions/spawn-identity.ts), ` +
				`or add the file to EXEMPT in this test WITH a written reason.`
		).toEqual([]);
	});

	it('every EXEMPT entry still exists and still calls launchSession (no stale exemptions)', () => {
		// A stale exemption is a hole that opens quietly when a file is renamed or its spawn removed.
		for (const [rel, reason] of Object.entries(EXEMPT)) {
			expect(reason.length, rel).toBeGreaterThan(10);
			const text = stripComments(readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n'));
			expect(/\blaunchSession\s*\(/.test(text), `${rel} no longer calls launchSession`).toBe(true);
		}
	});

	it('every table entry is actually WIRED to a call site (no dead config)', () => {
		// The table module is excluded: its own doc example spells `spawnIdentity('…')` and would
		// vouch for a key that no seam actually spreads.
		const all = sourceFiles(SRC)
			.filter((f) => !f.endsWith(join('sessions', 'spawn-identity.ts')))
			.map((f) => stripComments(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')))
			.join('\n');
		for (const [key] of entries) {
			expect(all.includes(`spawnIdentity('${key}')`), `${key} is declared but never used`).toBe(
				true
			);
		}
	});
});
