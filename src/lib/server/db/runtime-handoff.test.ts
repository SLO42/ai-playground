import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
	runtimeHandoffLines,
	RuntimeHandoffError,
	RUNTIME_USER_VAR,
	RUNTIME_PASS_VAR,
	type RuntimeHandoffFacts
} from './runtime-handoff';
import { resolveDbConnect, type DbEnv } from './runtime-init';

// SF3-1 / SF3-2 REGRESSION — the operator handoff `npm run db:up` prints must stay
// reconciled with the seam that actually reads the env (db/runtime-init.ts) and with
// .env.example's spelling. The shipped defect was drift: db:up printed
// SURREAL_USER/SURREAL_PASS + "connect at DATABASE auth level (Db.connect
// authLevel:'database')", i.e. vars the runtime does not read plus a code edit that
// does not exist — an operator following it ended up silently disconnected.
//
// The load-bearing test is NOT a string match: it PARSES the printed .env block, feeds
// it to resolveDbConnect, and asserts the real resolver accepts it at DATABASE auth
// level. If either side moves, this fails.

const HERE = dirname(fileURLToPath(import.meta.url));
// src/lib/server/db → repo root is 4 up.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const BASE: RuntimeHandoffFacts = {
	ws: 'ws://127.0.0.1:8000',
	namespace: 'playground',
	database: 'v2',
	username: 'atelier_runtime',
	role: 'EDITOR',
	alreadyExisted: false,
	generated: true,
	password: 'GEN3RAT3D-pw_abc'
};

/** Parse the indented `KEY=value` lines out of the printed block. */
function envBlock(lines: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const l of lines) {
		const m = /^\s{2,}([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

describe('runtimeHandoffLines — the printed block matches the real seam (SF3-1)', () => {
	it('prints an .env block resolveDbConnect accepts at DATABASE auth level', () => {
		const lines = runtimeHandoffLines(BASE);
		const kv = envBlock(lines);

		// The var names must be the ones runtime-init actually reads.
		expect(Object.keys(kv)).toEqual(
			expect.arrayContaining(['SURREAL_WS', 'SURREAL_NS', 'SURREAL_DB', RUNTIME_USER_VAR, RUNTIME_PASS_VAR])
		);

		// Strip the trailing `# GENERATED …` note the operator would not paste.
		const pass = kv[RUNTIME_PASS_VAR].replace(/\s+#.*$/, '');
		const env: DbEnv = {
			SURREAL_WS: kv.SURREAL_WS,
			SURREAL_NS: kv.SURREAL_NS,
			SURREAL_DB: kv.SURREAL_DB,
			SURREAL_RUNTIME_USER: kv[RUNTIME_USER_VAR],
			SURREAL_RUNTIME_PASS: pass
		};
		const r = resolveDbConnect(env);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.opts.authLevel).toBe('database');
			expect(r.opts.username).toBe('atelier_runtime');
			expect(r.opts.password).toBe('GEN3RAT3D-pw_abc');
			expect(r.opts.namespace).toBe('playground');
			expect(r.opts.database).toBe('v2');
		}
	});

	it('never tells the operator to set SURREAL_USER/SURREAL_PASS as the scoped creds', () => {
		const kv = envBlock(runtimeHandoffLines(BASE));
		// The historical root vars must NOT appear as things to SET in the block.
		expect(kv.SURREAL_USER).toBeUndefined();
		expect(kv.SURREAL_PASS).toBeUndefined();
	});

	it('never instructs a source edit — the seam sets authLevel itself', () => {
		const text = runtimeHandoffLines(BASE).join('\n');
		// The shipped defect literally pointed at `Db.connect authLevel:'database'`.
		expect(text).not.toMatch(/Db\.connect/);
		expect(text).toMatch(/no code edit is required/i);
		// And it must state the both-or-neither contract the resolver enforces.
		expect(text).toMatch(/BOTH or NEITHER/i);
	});

	it('states that SURREAL_USER/SURREAL_PASS are ignored once both runtime vars are set', () => {
		const text = runtimeHandoffLines(BASE).join('\n');
		expect(text).toMatch(/SURREAL_USER\/SURREAL_PASS path unchanged/);
		expect(text).toMatch(/IGNORED/);
	});
});

describe('runtimeHandoffLines — password shadow paths (F-008: never fabricate)', () => {
	it('generated: prints the credential exactly once, flagged shown-ONCE', () => {
		const text = runtimeHandoffLines(BASE).join('\n');
		const hits = text.split('GEN3RAT3D-pw_abc').length - 1;
		expect(hits).toBe(1);
		expect(text).toMatch(/shown ONCE/);
	});

	it('alreadyExisted: prints an honest placeholder, never a value it does not know', () => {
		const kv = envBlock(
			runtimeHandoffLines({
				...BASE,
				alreadyExisted: true,
				generated: false,
				password: '' // provisionRuntimeUser returns '' on the no-op path
			})
		);
		expect(kv[RUNTIME_PASS_VAR]).toMatch(/^<unchanged/);
		// The stale generated value must never leak into the no-op branch.
		expect(Object.values(kv).join('\n')).not.toContain('GEN3RAT3D-pw_abc');
	});

	it('alreadyExisted: even a stale generated flag cannot print the password', () => {
		// Defensive: db:up passes provisionRuntimeUser's struct straight through; if a
		// future change left `generated:true` set alongside `alreadyExisted:true`, the
		// no-op branch must still win rather than claim a password that had no effect.
		const text = runtimeHandoffLines({ ...BASE, alreadyExisted: true, generated: true }).join('\n');
		expect(text).not.toContain('GEN3RAT3D-pw_abc');
		expect(text).toMatch(/unchanged/);
	});

	it('supplied via env: points back at the value the operator already set', () => {
		const kv = envBlock(
			runtimeHandoffLines({ ...BASE, generated: false, password: 'operator_supplied' })
		);
		expect(kv[RUNTIME_PASS_VAR]).toBe(`<the ${RUNTIME_PASS_VAR} you already set for this run>`);
		expect(kv[RUNTIME_PASS_VAR]).not.toContain('operator_supplied');
	});
});

describe('runtimeHandoffLines — nil / empty input', () => {
	it.each([['ws'], ['namespace'], ['database'], ['username']] as const)(
		'refuses to print a half-blank block when %s is empty',
		(field) => {
			expect(() => runtimeHandoffLines({ ...BASE, [field]: '   ' })).toThrow(RuntimeHandoffError);
		}
	);

	it('refuses to print a blank credential claimed as GENERATED', () => {
		expect(() => runtimeHandoffLines({ ...BASE, generated: true, password: '' })).toThrow(
			RuntimeHandoffError
		);
	});

	it('names the missing fields in the error (no anonymous catch-all)', () => {
		try {
			runtimeHandoffLines({ ...BASE, ws: '', username: '' });
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(RuntimeHandoffError);
			expect((err as Error).message).toMatch(/ws/);
			expect((err as Error).message).toMatch(/username/);
		}
	});
});

describe('one spelling across doc, .env.example, and the printed handoff (SF3-2)', () => {
	// F-054: normalize CRLF before scanning committed source text on Windows.
	const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8').replace(/\r\n/g, '\n');

	it('.env.example documents exactly the vars the handoff prints', () => {
		expect(envExample).toMatch(new RegExp(`^#\\s*${RUNTIME_USER_VAR}=`, 'm'));
		expect(envExample).toMatch(new RegExp(`^#\\s*${RUNTIME_PASS_VAR}=`, 'm'));
	});

	it('the handoff prints exactly the vars .env.example documents', () => {
		const kv = envBlock(runtimeHandoffLines(BASE));
		for (const key of Object.keys(kv)) {
			// Every key the operator is told to set must be present in .env.example.
			expect(envExample).toMatch(new RegExp(`^#?\\s*${key}=`, 'm'));
		}
	});

	it('scripts/db-up.ts delegates to this builder instead of hand-rolling the block', () => {
		const dbUp = readFileSync(join(REPO_ROOT, 'scripts', 'db-up.ts'), 'utf8').replace(/\r\n/g, '\n');
		expect(dbUp).toMatch(/runtimeHandoffLines/);
		// The exact drifted guidance that shipped must not come back.
		expect(dbUp).not.toMatch(/SURREAL_USER=\$\{|authLevel:\\'database\\'\)/);
	});
});
