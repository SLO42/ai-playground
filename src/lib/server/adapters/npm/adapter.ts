// TASK 12.3 — the DEEPENED npm PublisherAdapter (D-037). The first general-purpose registry
// publish target: any Node package the operator builds in Atelier ships through this.
//
// It implements the 12.1 `PublisherAdapter` contract for real:
//   • probe()    — honest availability: package.json present + parseable + not private + the named
//                  secret's presence (D-026 — presence only). NEVER throws.
//   • validate() — preconditions against npm's publish rules (spec.ts) WITHOUT publishing:
//                  name (validate-npm-package-name semantics), version (SemVer), private flag,
//                  registry/access (publishConfig + scope), the `files` field shape.
//   • package()  — REAL `npm pack` file-SELECTION (pack.ts): respects package.json `files` (or the
//                  .npmignore fallback), npm's always-include/exclude rules, and names the exact
//                  tarball. dryRun lists the files that WOULD ship (no tarball write — npm produces
//                  the bytes at the real-call site).
//   • publish()  — the EXACT `npm publish` invocation behind dry-run-by-default (api.ts). The
//                  dry-run produces the precise argv + the registry PUT + the .npmrc auth line
//                  (token redacted — D-026). A real publish is GATED (D-018/D-024) + needs
//                  NPM_TOKEN, and is NOT executed in this track (honest deferred-live-proof).
//
// Filesystem touches are CONFINED to the project cwd (package.json + the tree walk for pack). All
// errors are honest + specific (F-008) — never a generic failure or a fabricated success.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	AdapterProbe,
	AdapterRunOptions,
	AdapterRunResult,
	PackageResult,
	PublishValidation,
	PublisherAdapter,
	SecretRequirement,
	SecretResolver
} from '../types';
import { validatePackage, validatePackageName } from './spec';
import { computePackPlan } from './pack';
import { buildNpmPublishPlan, npmPlanToSteps, REDACTED_TOKEN } from './api';

/** The env-var the operator supplies for a real npm publish (never stored — D-026). */
export const NPM_SECRET = 'NPM_TOKEN';

/** Read + parse package.json under cwd; null when absent/unparseable (honest). */
async function readPackageJson(cwd: string): Promise<{ pkg: Record<string, unknown> | null; raw: string | null }> {
	let raw: string | null = null;
	try {
		raw = await readFile(join(cwd, 'package.json'), 'utf8');
	} catch {
		return { pkg: null, raw: null };
	}
	try {
		const parsed = JSON.parse(raw);
		return { pkg: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null, raw };
	} catch {
		return { pkg: null, raw };
	}
}

/** Read the dist-tag from the per-project target config (default "latest"). */
function configTag(config?: Record<string, unknown>): string | undefined {
	return config && typeof config.tag === 'string' && config.tag.trim() ? config.tag.trim() : undefined;
}

export class NpmPublisherAdapter implements PublisherAdapter {
	readonly id = 'npm';
	readonly label = 'npm registry';
	readonly kind = 'publish' as const;

	secrets(): SecretRequirement[] {
		return [
			{
				envVar: NPM_SECRET,
				label: 'npm auth token',
				purpose: 'Authenticates `npm publish` to the registry (.npmrc _authToken). Required for a real publish.',
				required: true
			}
		];
	}

	async probe(opts: { cwd: string; secrets: SecretResolver }): Promise<AdapterProbe> {
		const { pkg, raw } = await readPackageJson(opts.cwd);
		if (!pkg) {
			return {
				available: false,
				reason: raw == null ? 'No package.json found in the project root.' : 'package.json is present but not valid JSON.'
			};
		}
		if (pkg.private === true) {
			return { available: false, reason: 'package.json is marked "private": true — npm refuses to publish it.' };
		}
		const nv = validatePackageName(pkg.name);
		if (!nv.ok) return { available: false, reason: nv.reason ?? 'package.json "name" is invalid.' };
		const name = String(pkg.name);
		const hasToken = opts.secrets.has(NPM_SECRET);
		return {
			available: true,
			target: `npm:${name}`,
			...(hasToken ? {} : { reason: `${NPM_SECRET} is not set — package + dry-run only until you supply it.` })
		};
	}

	async validate(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PublishValidation> {
		const { pkg, raw } = await readPackageJson(opts.cwd);
		if (!pkg) {
			return {
				ok: false,
				blockers: [raw == null ? 'No package.json found.' : 'package.json is not valid JSON.'],
				warnings: []
			};
		}
		const v = validatePackage(pkg);
		const warnings = [...v.warnings];
		if (!opts.secrets.has(NPM_SECRET)) {
			warnings.push(`${NPM_SECRET} is not set — a real publish will fail until you supply it in .env.`);
		}
		return { ok: v.ok, blockers: v.blockers, warnings };
	}

	async package(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PackageResult> {
		const { pkg, raw } = await readPackageJson(opts.cwd);
		if (!pkg) {
			return {
				target: 'npm:(invalid)',
				dryRun: true,
				ok: false,
				summary: raw == null ? 'No package.json to package.' : 'package.json is not valid JSON.',
				steps: [],
				warnings: []
			};
		}
		const v = validatePackage(pkg);
		const name = typeof pkg.name === 'string' ? pkg.name : '(unknown)';
		const version = typeof pkg.version === 'string' ? pkg.version : '(unknown)';
		const target = `npm:${name}`;

		// Compute the REAL npm pack file selection (respects files/.npmignore + always-rules).
		const plan = await computePackPlan({ cwd: opts.cwd, pkg });

		if (!v.ok) {
			return {
				target,
				dryRun: true,
				ok: false,
				summary: `Package not assembled — ${v.blockers.length} blocker(s): ${v.blockers.join('; ')}`,
				steps: [
					...plan.notes,
					`Would package ${plan.files.length} file(s) into ${plan.tarball} once the blockers are fixed.`
				],
				warnings: v.warnings
			};
		}

		return {
			target,
			dryRun: true,
			ok: true,
			summary: `Assembled ${plan.tarball} — ${plan.files.length} file(s) (npm pack selection).`,
			steps: [
				`Read package.json (${name}@${version})`,
				...plan.notes,
				`Tarball name: ${plan.tarball}`,
				`Files (${plan.files.length}):`,
				...plan.files.map((f) => `  • ${f}`)
			],
			warnings: v.warnings,
			artifact: { name, version }
		};
	}

	async publish(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult> {
		const { pkg } = await readPackageJson(opts.cwd);
		const dryRun = opts.dryRun ?? true;
		if (!pkg) {
			return {
				target: 'npm:(invalid)',
				dryRun,
				ok: false,
				summary: 'Not publishable: no valid package.json.',
				steps: ['Read package.json: failed (missing or invalid JSON).'],
				warnings: []
			};
		}
		const v = validatePackage(pkg);
		const name = typeof pkg.name === 'string' ? pkg.name : '(unknown)';
		const version = typeof pkg.version === 'string' ? pkg.version : '(unknown)';
		const target = `npm:${name}`;

		if (!v.ok) {
			return {
				target,
				dryRun,
				ok: false,
				summary: `Not publishable: ${v.blockers.join('; ')}`,
				steps: ['Validate npm publish preconditions before any upload:', ...v.blockers.map((b) => `  ✗ ${b}`)],
				warnings: v.warnings
			};
		}

		const packPlan = await computePackPlan({ cwd: opts.cwd, pkg });
		const tokenPresent = opts.secrets.has(NPM_SECRET);
		const publishPlan = buildNpmPublishPlan({
			name,
			version,
			registry: v.registry,
			access: v.access,
			tarball: packPlan.tarball,
			tokenPresent,
			...(configTag(opts.config) ? { tag: configTag(opts.config)! } : {})
		});
		const requestSteps = [
			`Package ${packPlan.tarball} (${packPlan.files.length} file(s))`,
			`npm publish invocation (NPM_TOKEN redacted — D-026):`,
			...npmPlanToSteps(publishPlan).map((s) => `  → ${s}`)
		];

		if (dryRun) {
			return {
				target,
				dryRun: true,
				ok: true,
				summary: `Dry-run: would publish ${name}@${version} to ${publishPlan.registry} (access "${publishPlan.access}", tag "${publishPlan.tag}"). Auth via ${NPM_SECRET} (${tokenPresent ? 'present' : 'not set'}).`,
				steps: requestSteps,
				warnings: v.warnings
			};
		}

		// Real publish: GATED (the driver enforces the confirm token) + DEFERRED in this track — no
		// external npm call is made. The invocation is fully prepared; the live publish lands when
		// the operator supplies NPM_TOKEN and confirms.
		return {
			target,
			dryRun: false,
			ok: false,
			summary: `Publish of ${name}@${version} prepared but NOT executed in this track — real npm publish deferred to operator credentials.`,
			steps: requestSteps,
			warnings: [
				...v.warnings,
				`Real npm publish not performed in this track — supply ${NPM_SECRET} in .env and confirm the gated action (D-026/D-018). The invocation above is exactly what would run (auth token redacted as "${REDACTED_TOKEN}").`
			]
		};
	}
}
