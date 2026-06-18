// CT-4 (CREATE-SPEC) — the /projects/create template-picker WIRING. The picker's three pure server
// helpers, tested in isolation (no DB, no agent, no spend — the scaffold itself is integration-tested
// in create/execute-template.test.ts; this proves the FORM↔TEMPLATE plumbing the route action adds):
//
//   1. templateChoices() — every registry template projects to {metadata + CT-4 pre-fill hints};
//      the hints are HONEST (only genuinely-mapped language/tag fields appear, F-008), and the
//      bepinex choice carries its params with gameId defaulting to ROUNDS (the live-verify case).
//   2. readTemplateParams() — form fields → typed param values: boolean checkbox 'on'→true / absent→
//      false; select/string takes the bounded trimmed value or the declared default when absent;
//      ONLY declared keys are read (registry is the source of truth); unknown templateId → {}.
//   3. templateScaffoldErrorReason() — each NAMED execute error maps to an honest operator reason
//      (EVERY ERROR HAS A NAME), and the shared scaffold/slug/exists classes defer to createErrorReason.

import { describe, it, expect } from 'vitest';
import {
	templateChoices,
	readTemplateParams,
	templateScaffoldErrorReason,
	MAX_TEMPLATE_PARAM
} from '$lib/server/create/template-form';
import {
	TemplateNotFoundError,
	ConcurrentCreateError,
	PostRegisterWriterError,
	ProjectExistsError,
	UnstableSlugError,
	ScaffoldPathError,
	ScaffoldSecretError,
	ScaffoldFailedError
} from '$lib/server/create';

describe('templateChoices — metadata + CT-4 pre-fill hints (F-008 honest)', () => {
	const choices = templateChoices();

	it('projects every registry template (17) with id/name/params/hints', () => {
		expect(choices.length).toBe(17);
		for (const c of choices) {
			expect(typeof c.id).toBe('string');
			expect(typeof c.name).toBe('string');
			expect(Array.isArray(c.params)).toBe(true);
			expect(c.hints).toBeDefined();
			// hints carry only the two optional keys — never a fabricated extra (F-008).
			for (const k of Object.keys(c.hints)) expect(['ecosystem', 'targetPlatform']).toContain(k);
		}
	});

	it('bepinex carries gameId=ROUNDS default + maps hints (csharp game→dotnet/game)', () => {
		const bepinex = choices.find((c) => c.id === 'bepinex');
		expect(bepinex).toBeDefined();
		const gameId = bepinex!.params.find((p) => p.key === 'gameId');
		expect(gameId?.type).toBe('select');
		expect(gameId?.default).toBe('ROUNDS');
		expect(gameId?.options).toContain('ROUNDS');
		expect(bepinex!.hints.ecosystem).toBe('dotnet'); // language 'C#' → dotnet
		expect(bepinex!.hints.targetPlatform).toBe('unity'); // 'unity' tag wins over 'game'/'mod'
	});

	it('blank template maps NO hints (empty language, no platform tag) — honest absence', () => {
		const blank = choices.find((c) => c.id === 'blank');
		expect(blank).toBeDefined();
		expect(blank!.hints.ecosystem).toBeUndefined();
		expect(blank!.hints.targetPlatform).toBeUndefined();
	});

	it('does not leak the non-serialisable generate fn into a choice', () => {
		const sveltekit = choices.find((c) => c.id === 'sveltekit')!;
		expect((sveltekit as Record<string, unknown>).generate).toBeUndefined();
	});
});

describe('readTemplateParams — form → typed values (registry is the source of truth)', () => {
	it('reads boolean (on→true), select + string for go; absent boolean → false', () => {
		const form = new FormData();
		form.set('param.moduleName', '  github.com/me/proj  ');
		form.set('param.projectType', 'library');
		form.set('param.includeCI', 'on');
		const p = readTemplateParams(form, 'go');
		expect(p.moduleName).toBe('github.com/me/proj'); // trimmed
		expect(p.projectType).toBe('library');
		expect(p.includeCI).toBe(true);

		const form2 = new FormData(); // includeCI absent → false (checkbox not ticked)
		const p2 = readTemplateParams(form2, 'go');
		expect(p2.includeCI).toBe(false);
		expect(p2.projectType).toBe('binary'); // declared default when absent
		expect(p2.moduleName).toBe(''); // string default is '' for go
	});

	it('bepinex absent fields fall back to declared defaults (gameId→ROUNDS)', () => {
		const p = readTemplateParams(new FormData(), 'bepinex');
		expect(p.gameId).toBe('ROUNDS');
		expect(p.modName).toBe('My Mod');
		expect(p.includeCI).toBe(false); // boolean absent → false
	});

	it('reads ONLY declared keys — an undeclared form field is dropped (never threaded to the agent)', () => {
		const form = new FormData();
		form.set('param.notAKey', 'evil');
		form.set('param.gameId', 'Valheim');
		const p = readTemplateParams(form, 'bepinex');
		expect(p.notAKey).toBeUndefined();
		expect('notAKey' in p).toBe(false); // dropped, not merely undefined-valued
		expect(p.gameId).toBe('Valheim'); // declared key passes through with its value
	});

	it('caps an over-long string param value at MAX_TEMPLATE_PARAM (prompt-injection bound)', () => {
		// A 50k param value must NOT thread unbounded into the agent prompt / scaffold (a 50k param →
		// 200k prompt). Trim happens BEFORE the slice, so the bound is on the trimmed content length.
		const over = 'x'.repeat(MAX_TEMPLATE_PARAM + 5000);
		const form = new FormData();
		form.set('param.moduleName', over); // go.moduleName is a string param
		const p = readTemplateParams(form, 'go');
		expect((p.moduleName as string).length).toBe(MAX_TEMPLATE_PARAM);

		// A value at/under the cap is preserved verbatim (no false truncation).
		const exact = 'y'.repeat(MAX_TEMPLATE_PARAM);
		const form2 = new FormData();
		form2.set('param.moduleName', exact);
		expect(readTemplateParams(form2, 'go').moduleName).toBe(exact);
	});

	it('unknown templateId → {} (the action then throws TemplateNotFoundError)', () => {
		expect(readTemplateParams(new FormData(), 'nope')).toEqual({});
	});

	it('a template with no params (blank) → {}', () => {
		expect(readTemplateParams(new FormData(), 'blank')).toEqual({});
	});
});

describe('templateScaffoldErrorReason — EVERY ERROR HAS A NAME', () => {
	it('TemplateNotFoundError → pick-one-from-the-list', () => {
		const r = templateScaffoldErrorReason(new TemplateNotFoundError('ghost'));
		expect(r).toContain("'ghost'");
		expect(r.toLowerCase()).toContain('pick one');
	});

	it('ConcurrentCreateError → in-progress (names the slug)', () => {
		const r = templateScaffoldErrorReason(new ConcurrentCreateError('my-mod'));
		expect(r).toContain("'my-mod'");
		expect(r.toLowerCase()).toContain('in progress');
	});

	it('PostRegisterWriterError → registered-but-incomplete (names id + incident)', () => {
		const r = templateScaffoldErrorReason(
			new PostRegisterWriterError('project:my-mod', 'pm hire failed', 'incident:42')
		);
		expect(r).toContain('project:my-mod');
		expect(r.toLowerCase()).toContain('incomplete');
		expect(r).toContain('incident:42');
	});

	it('shared classes defer to createErrorReason (exists/slug/path/secret/failed)', () => {
		expect(templateScaffoldErrorReason(new ProjectExistsError('project:dup')).toLowerCase()).toContain(
			'already exists'
		);
		const slugErr = new UnstableSlugError('!!!', '', '');
		expect(templateScaffoldErrorReason(slugErr)).toBe(slugErr.message);
		expect(
			templateScaffoldErrorReason(new ScaffoldPathError('../escape', '/abs/escape')).toLowerCase()
		).toContain('escape the project directory');
		expect(
			templateScaffoldErrorReason(new ScaffoldSecretError('.env', 'leak')).toLowerCase()
		).toContain('literal secret');
		expect(
			templateScaffoldErrorReason(new ScaffoldFailedError('disk full', 'incident:7')).toLowerCase()
		).toContain('scaffold failed');
	});

	it('an unknown/unnamed error surfaces its message (no swallow)', () => {
		expect(templateScaffoldErrorReason(new Error('boom'))).toBe('boom');
	});
});
