// TASK 10.3 — unit tests for API-key PRESENCE + set (D-026: never expose/commit a value).
//
// Covers: presence is a strict boolean (never the value, never a masked prefix); a set flips
// presence unset→set and the value lands in .env but is NEVER in the returned result; an
// unmanaged key is refused (allow-list); a newline value is refused (injection); an empty value
// clears the key (honest unset); and unrelated lines/comments survive a surgical upsert.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	describeKeyPresence,
	setEnvKey,
	MANAGED_KEYS,
	EnvWriteError,
	type SetKeyResult
} from './env-presence';

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'env-presence-'));
	file = join(dir, '.env');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('describeKeyPresence', () => {
	it('reports present:true for a non-empty value and present:false for unset/blank', () => {
		const out = describeKeyPresence({
			CLAUDE_CODE_OAUTH_TOKEN: 'sk-secret-value',
			ANTHROPIC_API_KEY: '   '
		});
		const tok = out.find((k) => k.key === 'CLAUDE_CODE_OAUTH_TOKEN');
		const key = out.find((k) => k.key === 'ANTHROPIC_API_KEY');
		expect(tok?.present).toBe(true);
		expect(key?.present).toBe(false); // whitespace-only ⇒ honestly unset
	});

	it('NEVER returns the value or any prefix of it (D-026)', () => {
		const out = describeKeyPresence({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-supersecret-123' });
		const serialized = JSON.stringify(out);
		expect(serialized).not.toContain('supersecret');
		expect(serialized).not.toContain('sk-ant');
		// The only fields are key/label/purpose/present — no `value`.
		for (const row of out) {
			expect(Object.keys(row).sort()).toEqual(['key', 'label', 'present', 'purpose']);
		}
	});

	it('covers exactly the managed allow-list', () => {
		const out = describeKeyPresence({});
		expect(out.map((k) => k.key).sort()).toEqual(MANAGED_KEYS.map((k) => k.key).sort());
	});
});

describe('setEnvKey', () => {
	it('writes the value to .env but returns ONLY presence (never the value)', () => {
		const res: SetKeyResult = setEnvKey(file, 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-topsecret');
		expect(res).toEqual({ key: 'CLAUDE_CODE_OAUTH_TOKEN', present: true });
		// The value DID land in the gitignored .env...
		expect(readFileSync(file, 'utf8')).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-topsecret');
		// ...but is absent from the returned surface.
		expect(JSON.stringify(res)).not.toContain('topsecret');
	});

	it('flips presence unset→set as seen by a re-describe of the file', () => {
		writeFileSync(file, 'CLAUDE_CODE_OAUTH_TOKEN=\nANTHROPIC_API_KEY=\n', 'utf8');
		setEnvKey(file, 'ANTHROPIC_API_KEY', 'sk-key-abc');
		// Parse the file back into an env-like map (presence is the observable contract).
		const text = readFileSync(file, 'utf8');
		const env: Record<string, string> = {};
		for (const line of text.split(/\r?\n/)) {
			const m = /^([A-Z_]+)=(.*)$/.exec(line);
			if (m) env[m[1]] = m[2];
		}
		const presence = describeKeyPresence(env);
		expect(presence.find((k) => k.key === 'ANTHROPIC_API_KEY')?.present).toBe(true);
		expect(presence.find((k) => k.key === 'CLAUDE_CODE_OAUTH_TOKEN')?.present).toBe(false);
	});

	it('upserts in place and preserves unrelated lines + comments', () => {
		writeFileSync(
			file,
			'# header comment\nSURREAL_WS=ws://127.0.0.1:8000\nCLAUDE_CODE_OAUTH_TOKEN=old\n',
			'utf8'
		);
		setEnvKey(file, 'CLAUDE_CODE_OAUTH_TOKEN', 'new');
		const text = readFileSync(file, 'utf8');
		expect(text).toContain('# header comment');
		expect(text).toContain('SURREAL_WS=ws://127.0.0.1:8000');
		expect(text).toContain('CLAUDE_CODE_OAUTH_TOKEN=new');
		expect(text).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=old');
	});

	it('clears a key on an empty value (honest unset, not an error)', () => {
		writeFileSync(file, 'ANTHROPIC_API_KEY=something\n', 'utf8');
		const res = setEnvKey(file, 'ANTHROPIC_API_KEY', '');
		expect(res.present).toBe(false);
		expect(readFileSync(file, 'utf8')).toContain('ANTHROPIC_API_KEY=');
		expect(readFileSync(file, 'utf8')).not.toContain('ANTHROPIC_API_KEY=something');
	});

	it('refuses an unmanaged key (allow-list)', () => {
		expect(() => setEnvKey(file, 'SURREAL_PASS', 'x')).toThrow(EnvWriteError);
	});

	it('refuses a value containing a newline (env-file injection)', () => {
		expect(() => setEnvKey(file, 'ANTHROPIC_API_KEY', 'a\nINJECTED=b')).toThrow(EnvWriteError);
	});
});
