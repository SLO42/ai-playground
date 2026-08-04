// CT-1 — project template registry tests (CREATE-SPEC).
//
// Pure-module tests: no DB, no fs. Covers the four data-flow paths per template.generate:
//   • happy — name + description + typical params
//   • empty params {} — every declared default must be applied (omitted-param path)
//   • nil/empty NAME and DESCRIPTION (the zero-length shadow path)
//   • redTeam — across param combos: NO literal secret (D-026, via the canonical screen())
//     and NO absolute / `..`-escaping path (D-018 pre-condition).

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	registry,
	getTemplate,
	listTemplateMetadata,
	toTemplateMetadata,
	BEPINEX_GAME_CONFIGS,
	type ProjectTemplate,
	type TemplateParam
} from './templates';
import { screen } from '../memory/screen';

// The canonical write-time secret gate execute.ts uses (D-026). A template whose generated content
// trips screen() is broken at scaffold time — 'quarantined' HARD-throws ScaffoldSecretError, and
// 'redacted' is WORSE THAN A THROW for template-authored content: execute.ts writes the redacted
// text (execute.ts, the `res.status === 'redacted'` branch), silently corrupting the generated file
// and reporting a bogus redaction reason to the operator. So it must be clean here. This couples the
// redTeam to the REAL detector.
function assertNoSecret(rel: string, content: string): void {
	const res = screen(content);
	expect(res.status, `screen('${rel}') reasons=[${res.reasons.join(',')}]`).toBe('clean');
}

// D-018 pre-condition: every emitted path is RELATIVE and never escapes its root. A literal
// secret value the tests can recognise without itself being a scannable token.
function assertSafeRelPath(rel: string): void {
	expect(rel.length, 'empty path').toBeGreaterThan(0);
	// No absolute paths (POSIX root or Windows drive).
	expect(/^([A-Za-z]:[\\/]|[\\/])/.test(rel), `absolute path: ${rel}`).toBe(false);
	// No `..` traversal segment (forward or back slash).
	expect(/(^|[\\/])\.\.([\\/]|$)/.test(rel), `'..' escape: ${rel}`).toBe(false);
	// No leading-slash or backslash-escape (UNC etc).
	expect(rel.startsWith('\\'), `leading backslash: ${rel}`).toBe(false);
}

/** Build a param map applying every declared default — the "defaults applied" baseline. */
function defaultParams(t: ProjectTemplate): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (const p of t.params) out[p.key] = p.default;
	return out;
}

/**
 * Boolean/select defaults only. Supplying these explicitly MUST reproduce the omitted-param
 * output: that is the precise meaning of "defaults are applied for omitted params" for the
 * branch-selecting params. STRING defaults are intentionally excluded — a string default like
 * bepinex `modId='AuthorName-MyMod'` legitimately differs from its name-derived omitted fallback,
 * so it is not part of this invariant.
 */
function branchDefaults(t: ProjectTemplate): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (const p of t.params) if (p.type === 'boolean' || p.type === 'select') out[p.key] = p.default;
	return out;
}

const ALL_IDS = [
	'blank', 'sveltekit', 'nextjs', 'fullstack', 'python', 'python-cli', 'rust', 'go',
	'java', 'ruby', 'dotnet', 'bepinex', 'fabric', 'forge', 'paper', 'bg3', 'agent'
];

describe('CT-1 registry shape', () => {
	it('contains all 17 expected templates with unique ids', () => {
		expect(registry).toHaveLength(17);
		const ids = registry.map((t) => t.id);
		expect(new Set(ids).size).toBe(17);
		for (const id of ALL_IDS) expect(ids).toContain(id);
	});

	it('getTemplate returns the template by id, undefined for unknown', () => {
		for (const t of registry) expect(getTemplate(t.id)).toBe(t);
		expect(getTemplate('does-not-exist')).toBeUndefined();
		// shadow paths: empty string + whitespace are not ids
		expect(getTemplate('')).toBeUndefined();
		expect(getTemplate(' blank ')).toBeUndefined();
	});

	it('listTemplateMetadata projects every template without a generate fn', () => {
		const meta = listTemplateMetadata();
		expect(meta).toHaveLength(registry.length);
		for (const m of meta) {
			expect('generate' in m).toBe(false);
			expect(typeof m.id).toBe('string');
			expect(Array.isArray(m.params)).toBe(true);
		}
		// order preserved
		expect(meta.map((m) => m.id)).toEqual(registry.map((t) => t.id));
	});

	it('toTemplateMetadata drops generate but keeps metadata fields', () => {
		const m = toTemplateMetadata(registry[0]);
		expect(m.id).toBe(registry[0].id);
		expect('generate' in m).toBe(false);
	});

	it('every param declaration is well-formed', () => {
		for (const t of registry) {
			for (const p of t.params as TemplateParam[]) {
				expect(p.key).toBeTruthy();
				expect(p.label).toBeTruthy();
				expect(['string', 'select', 'boolean']).toContain(p.type);
				expect(p.description).toBeTypeOf('string');
				if (p.type === 'select') {
					expect(Array.isArray(p.options)).toBe(true);
					expect(p.options!.length).toBeGreaterThan(0);
					// a select default must be one of its options
					expect(p.options).toContain(p.default as string);
				}
				if (p.type === 'boolean') expect(typeof p.default).toBe('boolean');
			}
		}
	});
});

describe('CT-1 generate — happy + empty-params paths', () => {
	for (const t of registry) {
		it(`${t.id}: generate(name, desc, {}) returns a non-empty map of relative paths with content`, () => {
			const out = t.generate('my-project', 'A test project.', {});
			const entries = Object.entries(out);
			expect(entries.length, `${t.id} produced no files`).toBeGreaterThan(0);
			for (const [rel, content] of entries) {
				assertSafeRelPath(rel);
				expect(typeof content).toBe('string');
				// Non-empty content EXCEPT explicit directory-keeper sentinels (.gitkeep) which are
				// intentionally empty placeholders.
				if (!rel.endsWith('.gitkeep')) {
					expect(content.length, `${t.id}:${rel} empty content`).toBeGreaterThan(0);
				}
			}
		});

		it(`${t.id}: omitting branch params == supplying their declared boolean/select defaults`, () => {
			const omitted = t.generate('proj', 'desc', {});
			const explicit = t.generate('proj', 'desc', branchDefaults(t));
			// (bg3 uses a random UUID + today's date, so its output is non-deterministic — compare
			// the key SET only there.)
			if (t.id === 'bg3') {
				expect(Object.keys(explicit).sort()).toEqual(Object.keys(omitted).sort());
			} else {
				expect(explicit).toEqual(omitted);
			}
		});
	}
});

describe('CT-1 generate — nil/empty name & description shadow paths', () => {
	for (const t of registry) {
		it(`${t.id}: empty name and empty description still produce a valid scaffold`, () => {
			const out = t.generate('', '', {});
			expect(Object.keys(out).length).toBeGreaterThan(0);
			for (const [rel, content] of Object.entries(out)) {
				assertSafeRelPath(rel);
				expect(typeof content).toBe('string');
			}
		});
	}
});

describe('CT-1 bepinex — ROUNDS-specific contract', () => {
	it('emits Plugin.cs with [BepInProcess("Rounds.exe")] + a BepInPlugin attribute', () => {
		const out = getTemplate('bepinex')!.generate('coolmod', 'desc', { gameId: 'ROUNDS' });
		const plugin = out['Plugin.cs'];
		expect(plugin).toBeTruthy();
		expect(plugin).toContain('[BepInProcess("Rounds.exe")]');
		expect(plugin).toContain('[BepInPlugin(');
		expect(plugin).toContain('BaseUnityPlugin');
	});

	it('emits <name>.csproj with the ROUNDS TargetFramework from BEPINEX_GAME_CONFIGS', () => {
		const out = getTemplate('bepinex')!.generate('coolmod', 'desc', { gameId: 'ROUNDS' });
		const csproj = out['coolmod.csproj'];
		expect(csproj).toBeTruthy();
		expect(csproj).toContain(`<TargetFramework>${BEPINEX_GAME_CONFIGS['ROUNDS'].framework}</TargetFramework>`);
		expect(BEPINEX_GAME_CONFIGS['ROUNDS'].framework).toBe('net472');
	});

	it('emits a Thunderstore manifest.json when includeThunderstore is set', () => {
		const withTs = getTemplate('bepinex')!.generate('coolmod', 'desc', {
			gameId: 'ROUNDS',
			includeThunderstore: true
		});
		expect(withTs['manifest.json']).toBeTruthy();
		const manifest = JSON.parse(withTs['manifest.json']);
		expect(manifest.version_number).toBe('1.0.0');
		expect(manifest.dependencies).toEqual(BEPINEX_GAME_CONFIGS['ROUNDS'].deps);

		const withoutTs = getTemplate('bepinex')!.generate('coolmod', 'desc', {
			gameId: 'ROUNDS',
			includeThunderstore: false
		});
		expect(withoutTs['manifest.json']).toBeUndefined();
	});

	it('non-ROUNDS game uses its own framework + process name', () => {
		const out = getTemplate('bepinex')!.generate('mod', 'desc', { gameId: 'Lethal Company' });
		expect(out['mod.csproj']).toContain(
			`<TargetFramework>${BEPINEX_GAME_CONFIGS['Lethal Company'].framework}</TargetFramework>`
		);
		expect(out['Plugin.cs']).toContain('[BepInProcess("LethalCompany.exe")]');
	});
});

// ── redTeam: D-026 (no literal secret) + D-018 pre-condition (no absolute / `..` path) ──
//
// A representative sample of param combos per template, INCLUDING adversarial inputs that try
// to smuggle a path escape through a name/param, plus toggling every boolean/select branch.
describe('CT-1 redTeam — D-026 secret-free & D-018 path-safe across param combos', () => {
	// Adversarial names/descriptions that try to escape the root or inject a secret-shaped value.
	const ADVERSARIAL_NAMES = [
		'../../etc/passwd',
		'..\\..\\windows',
		'/abs/path',
		'C:\\abs\\win',
		'proj; rm -rf',
		''
	];
	// NOTE: descriptions are echoed verbatim into generated files; the screen() PII rules (email,
	// card) would legitimately redact such content if the USER typed it — that is upstream user
	// input, not a secret the TEMPLATE introduces. So adversarial descriptions here probe path
	// escapes / shell metacharacters only, never PII the screen is designed to catch.
	const ADVERSARIAL_DESC = ['', 'normal desc', 'desc with ../.. inside', 'desc; rm -rf /'];

	/** Per-template param combos exercising every branch (booleans both ways, each select option). */
	function paramCombos(t: ProjectTemplate): Record<string, string | boolean>[] {
		const combos: Record<string, string | boolean>[] = [{}, defaultParams(t)];
		// One combo per select option, and both boolean values.
		for (const p of t.params) {
			if (p.type === 'select' && p.options) {
				for (const opt of p.options) combos.push({ [p.key]: opt });
			} else if (p.type === 'boolean') {
				combos.push({ [p.key]: true });
				combos.push({ [p.key]: false });
			} else if (p.type === 'string') {
				// adversarial string param value
				combos.push({ [p.key]: '../escape' });
			}
		}
		return combos;
	}

	for (const t of registry) {
		it(`${t.id}: every (name × param-combo) output is secret-free and path-safe`, () => {
			for (const combo of paramCombos(t)) {
				for (const name of ADVERSARIAL_NAMES) {
					for (const desc of ADVERSARIAL_DESC) {
						const out = t.generate(name, desc, combo);
						for (const [rel, content] of Object.entries(out)) {
							assertSafeRelPath(rel);
							assertNoSecret(rel, content);
						}
					}
				}
			}
		});
	}

	it('a deliberately secret-bearing description is caught by the same screen() gate (control)', () => {
		// Proves the redTeam gate has teeth: a real token in a description would be flagged.
		const leaked = screen('GameDir password = hunter2supersecret value here');
		expect(leaked.status).not.toBe('clean');
	});
});

// ── regression: the bg3 placeholder UUID must be screen-clean BY CONSTRUCTION ──
//
// Defect (MERGE-B re-gate, root cause): bg3's placeholder UUID was a bare `Math.random()` roll,
// so its output was nondeterministic. A roll whose 4th+5th groups (4+12 = 16 chars) — or whose
// 1st+2nd+3rd (8+4+4) — come out ALL-DIGITS forms a 13–16 digit run that screen()'s `card-number`
// rule matches (screen.ts:174), and ~1 in 10 of those also passes the Luhn gate. Measured ≈1.4e-4
// per roll; the redTeam block above makes 168 bg3 generate() calls per suite run, so ~2.4% of runs
// went RED on a suite that must stay green — and, worse, ~1 in 7,000 REAL bg3 scaffolds had its
// info.json `UUID`/`Group` partly overwritten with `[REDACTED:card]` (execute.ts:453-457 writes the
// redacted text for status 'redacted'; only 'quarantined' hard-throws) plus a bogus "payment card"
// redaction note to the operator. The fix re-rolls until screen() calls the candidate clean.
describe('CT-1 bg3 placeholder UUID is screen-clean by construction (card-number flake + info.json corruption)', () => {
	// The `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` template the generator fills, one nibble per x/y.
	const UUID_PATTERN = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';

	/** The exact Math.random() sequence that makes the generator emit `uuid`. */
	function randomsFor(uuid: string): number[] {
		const out: number[] = [];
		for (let i = 0; i < UUID_PATTERN.length; i++) {
			const slot = UUID_PATTERN[i];
			if (slot !== 'x' && slot !== 'y') continue;
			const nib = parseInt(uuid[i], 16);
			// x → r.toString(16); y → ((r & 3) | 8).toString(16), so r = nib & 3 reproduces it.
			out.push((slot === 'y' ? nib & 0x3 : nib) / 16);
		}
		return out;
	}

	// Groups 4+5 = '8000' + '000000000003' → the 16-digit run '8000000000000003', whose Luhn sum is
	// 0 mod 10. Letters in groups 1-3 keep the OTHER window inert, isolating one cause.
	const DIRTY_UUID = 'deadbeef-dead-4ead-8000-000000000003';
	const CLEAN_UUID = 'deadbeef-dead-4ead-bead-deadbeefdead';

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('the reproduction: a Luhn-valid all-digit UUID tail IS flagged by the canonical screen()', () => {
		const res = screen(DIRTY_UUID);
		expect(res.status).toBe('redacted');
		expect(res.reasons).toContain('card-number');
		expect(res.text).toContain('[REDACTED:card]');
		// …and the control: the clean candidate is untouched, so the fix's exit condition is real.
		expect(screen(CLEAN_UUID).status).toBe('clean');
	});

	it('the generator re-rolls past a card-shaped UUID and emits the clean one', () => {
		const seq = [...randomsFor(DIRTY_UUID), ...randomsFor(CLEAN_UUID)];
		let i = 0;
		vi.spyOn(Math, 'random').mockImplementation(() => {
			if (i >= seq.length) throw new Error(`Math.random() over-drawn (${i}): re-roll did not stop`);
			return seq[i++];
		});

		const out = getTemplate('bg3')!.generate('My Mod', 'a mod', {});
		const info = out['info.json'];

		// The dirty roll was rejected; the clean one was emitted (both UUID fields).
		expect(info).not.toContain(DIRTY_UUID);
		expect(info).toContain(`"UUID": "${CLEAN_UUID}"`);
		expect(info).toContain(`"Group": "${CLEAN_UUID}"`);
		// Exactly two rolls were consumed — no silent extra churn.
		expect(i).toBe(seq.length);
		// The whole file passes the write-time gate execute.ts applies (D-026), so nothing is
		// redacted into the mod metadata on disk.
		const res = screen(info);
		expect(res.status, `screen('info.json') reasons=[${res.reasons.join(',')}]`).toBe('clean');
	});

	it('every bg3 UUID is clean across many real (unstubbed) rolls', () => {
		// Statistical backstop: at ≈1.4e-4 per roll the OLD code fails this ~1 in 4 runs; the fixed
		// generator cannot fail it at all, because 'clean' is its loop exit condition.
		for (let n = 0; n < 2000; n++) {
			const info = getTemplate('bg3')!.generate('My Mod', 'a mod', {});
			const res = screen(info['info.json']);
			expect(res.status, `roll ${n}: reasons=[${res.reasons.join(',')}]`).toBe('clean');
		}
	});
});
