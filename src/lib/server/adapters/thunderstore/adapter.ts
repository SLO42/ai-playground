// TASK 12.2 — the DEEPENED Thunderstore PublisherAdapter (D-037). The operator ships SWIP/ROUNDS
// mods to Thunderstore TODAY — this is the first real production publish target.
//
// It implements the 12.1 `PublisherAdapter` contract for real:
//   • probe()    — honest availability: a manifest.json present + parseable + the named secret's
//                  presence (D-026 — presence only). NEVER throws.
//   • validate() — a PREFLIGHT against Thunderstore's published rules (spec.ts) WITHOUT uploading:
//                  manifest fields, the 256×256 PNG icon, README.md, and the payload layout.
//   • package()  — assemble a REAL Thunderstore zip (manifest.json + README.md + icon.png + the
//                  dll/plugin payload) and report its exact contents. dryRun computes the plan +
//                  builds the bytes in-memory (no write) so the surface can list what WOULD ship.
//   • publish()  — dry-run-by-default: the dry-run produces the EXACT request that would be sent
//                  (minus the secret, D-026). A REAL publish (TASK 14.7, runbook §0) EXECUTES the
//                  4-step upload (initiate → parts → finish → submit) — it runs only after the
//                  driver's confirm gate (D-018/D-024) and only when THUNDERSTORE_TOKEN is
//                  present; a missing token stays the honest deferral (no fabricated upload).
//   • verify()   — post-publish visibility check (TASK 14.7): poll the PUBLIC package-version
//                  endpoint until the new version is live; bounded (~2 min), honest timeout.
//
// Filesystem touches are CONFINED to the project cwd (manifest/README/icon/payload reads). All
// errors are honest + specific (F-008) — never a generic failure or a fabricated success.

import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
import {
	REQUIRED_ROOT_FILES,
	validateManifest,
	validateIcon,
	validateReadme,
	type ThunderstoreManifest
} from './spec';
import { buildZip, listZip, type ZipEntry, type ZipListing } from './zip';
import {
	buildUploadPlan,
	planToSteps,
	executeUploadPlan,
	pollPackageVisible,
	packageVersionUrl,
	REDACTED_SECRET,
	VERIFY_TIMEOUT_DEFAULT_MS,
	type ThunderstoreSubmissionConfig
} from './api';

/** The env-var the operator supplies for a real Thunderstore upload (never stored — D-026). */
export const THUNDERSTORE_SECRET = 'THUNDERSTORE_TOKEN';

/** The default directory (relative to cwd) the mod payload (dll/plugin files) lives under. */
const DEFAULT_PAYLOAD_DIR = 'plugins';

/** Read a file's raw bytes under cwd; null when absent/unreadable (honest). */
async function readBytes(cwd: string, file: string): Promise<Uint8Array | null> {
	try {
		const buf = await readFile(join(cwd, file));
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	} catch {
		return null;
	}
}

/** Read a file's UTF-8 text under cwd; null when absent/unreadable (honest). */
async function readText(cwd: string, file: string): Promise<string | null> {
	try {
		return await readFile(join(cwd, file), 'utf8');
	} catch {
		return null;
	}
}

/** Parse manifest.json under cwd into an unknown value; null when absent/unparseable. */
async function readManifestJson(cwd: string): Promise<unknown | null> {
	const text = await readText(cwd, 'manifest.json');
	if (text == null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Recursively list files under a directory (relative posix paths), [] when absent. */
async function listFiles(root: string, dir: string): Promise<string[]> {
	const abs = join(root, dir);
	let entries: Dirent[];
	try {
		entries = await readdir(abs, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		const full = join(abs, e.name);
		if (e.isDirectory()) {
			out.push(...(await listFiles(root, join(dir, e.name))));
		} else if (e.isFile()) {
			out.push(relative(root, full).split(sep).join('/'));
		}
	}
	return out;
}

/** The Thunderstore submission config a per-project target carries (config blob, D-026 safe). */
function readSubmissionConfig(config?: Record<string, unknown>): ThunderstoreSubmissionConfig {
	const c = config ?? {};
	const out: ThunderstoreSubmissionConfig = {};
	if (typeof c.namespace === 'string') out.namespace = c.namespace;
	if (Array.isArray(c.communities)) out.communities = c.communities.map(String);
	if (c.categories && typeof c.categories === 'object' && !Array.isArray(c.categories)) {
		out.categories = c.categories as Record<string, string[]>;
	}
	if (typeof c.hasNsfwContent === 'boolean') out.hasNsfwContent = c.hasNsfwContent;
	if (typeof c.apiBase === 'string') out.apiBase = c.apiBase;
	return out;
}

/** A numeric config knob (per-step/verify timeouts) — undefined when absent/invalid (honest). */
function configMs(config: Record<string, unknown> | undefined, key: string): number | undefined {
	const v = config?.[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The payload dir from config (default `plugins`); guarded to stay inside the project. */
function payloadDir(config?: Record<string, unknown>): string {
	const d = config && typeof config.payloadDir === 'string' ? config.payloadDir.trim() : '';
	if (!d) return DEFAULT_PAYLOAD_DIR;
	// Confinement: no absolute path, no parent-escape (path-confinement spirit, D-018).
	if (d.startsWith('/') || d.startsWith('\\') || d.includes('..')) return DEFAULT_PAYLOAD_DIR;
	return d;
}

/** Assemble the in-memory zip entries for the package (root files + payload). */
async function collectEntries(
	cwd: string,
	config?: Record<string, unknown>
): Promise<{ entries: ZipEntry[]; payloadFiles: string[] }> {
	const entries: ZipEntry[] = [];
	for (const f of REQUIRED_ROOT_FILES) {
		const bytes = await readBytes(cwd, f);
		if (bytes) entries.push({ path: f, data: bytes });
	}
	const dir = payloadDir(config);
	const payloadFiles = await listFiles(cwd, dir);
	for (const rel of payloadFiles) {
		const bytes = await readBytes(cwd, rel);
		if (bytes) entries.push({ path: rel, data: bytes });
	}
	return { entries, payloadFiles };
}

/** A full preflight: every Thunderstore rule, collected honestly (used by validate + package). */
async function preflight(
	cwd: string,
	config?: Record<string, unknown>
): Promise<{ ok: boolean; blockers: string[]; warnings: string[]; manifest: ThunderstoreManifest | null }> {
	const blockers: string[] = [];
	const warnings: string[] = [];

	// manifest.json — present + parseable + valid fields.
	const rawManifest = await readManifestJson(cwd);
	if (rawManifest == null) {
		const text = await readText(cwd, 'manifest.json');
		blockers.push(
			text == null
				? 'manifest.json is missing from the project root.'
				: 'manifest.json is not valid JSON.'
		);
	}
	let manifest: ThunderstoreManifest | null = null;
	if (rawManifest != null) {
		const mv = validateManifest(rawManifest);
		blockers.push(...mv.blockers);
		warnings.push(...mv.warnings);
		if (mv.ok) manifest = rawManifest as ThunderstoreManifest;
	}

	// icon.png — exactly 256×256 PNG.
	const iconBytes = await readBytes(cwd, 'icon.png');
	const iv = validateIcon(iconBytes);
	blockers.push(...iv.blockers);
	warnings.push(...iv.warnings);

	// README.md — present.
	const readme = await readText(cwd, 'README.md');
	const rv = validateReadme(readme);
	blockers.push(...rv.blockers);
	warnings.push(...rv.warnings);

	// payload — at least one mod file should be present (a payload-less mod is almost always a bug).
	const dir = payloadDir(config);
	const payloadFiles = await listFiles(cwd, dir);
	if (payloadFiles.length === 0) {
		warnings.push(
			`No mod payload files found under "${dir}/" — the package will contain only the metadata files. Set config.payloadDir if your dll/plugin files live elsewhere.`
		);
	}

	return { ok: blockers.length === 0, blockers, warnings, manifest };
}

/** Build the zip filename Thunderstore expects: `<Name>-<Version>.zip`. */
function zipFilename(manifest: ThunderstoreManifest): string {
	return `${manifest.name}-${manifest.version_number}.zip`;
}

export class ThunderstorePublisherAdapter implements PublisherAdapter {
	readonly id = 'thunderstore';
	readonly label = 'Thunderstore';
	readonly kind = 'publish' as const;

	secrets(): SecretRequirement[] {
		return [
			{
				envVar: THUNDERSTORE_SECRET,
				label: 'Thunderstore service-account token',
				purpose: 'Authenticates a Thunderstore package upload (Bearer token). Required for a real publish.',
				required: true
			}
		];
	}

	async probe(opts: { cwd: string; secrets: SecretResolver; config?: Record<string, unknown> }): Promise<AdapterProbe> {
		const raw = await readManifestJson(opts.cwd);
		if (raw == null) {
			const text = await readText(opts.cwd, 'manifest.json');
			return {
				available: false,
				reason:
					text == null
						? 'No Thunderstore manifest.json found in the project root.'
						: 'manifest.json is present but not valid JSON.'
			};
		}
		const name = typeof (raw as Record<string, unknown>).name === 'string' ? String((raw as Record<string, unknown>).name) : undefined;
		if (!name) return { available: false, reason: 'manifest.json has no "name".' };
		const hasToken = opts.secrets.has(THUNDERSTORE_SECRET);
		return {
			available: true,
			target: `thunderstore:${name}`,
			...(hasToken ? {} : { reason: `${THUNDERSTORE_SECRET} is not set — package + dry-run only until you supply it.` })
		};
	}

	async validate(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PublishValidation> {
		const pf = await preflight(opts.cwd, opts.config);
		const warnings = [...pf.warnings];
		if (!opts.secrets.has(THUNDERSTORE_SECRET)) {
			warnings.push(`${THUNDERSTORE_SECRET} is not set — a real publish will fail until you supply it in .env.`);
		}
		// namespace is required to SUBMIT (the team is not derivable from the package name).
		const cfg = readSubmissionConfig(opts.config);
		if (!cfg.namespace) {
			warnings.push('config.namespace (the Thunderstore team) is not set — required to submit a real upload.');
		}
		return { ok: pf.ok, blockers: pf.blockers, warnings };
	}

	async package(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<PackageResult> {
		const pf = await preflight(opts.cwd, opts.config);
		// Even when invalid, report HONESTLY what is present (F-008) rather than fabricating success.
		const { entries, payloadFiles } = await collectEntries(opts.cwd, opts.config);

		if (!pf.ok || !pf.manifest) {
			const target = pf.manifest ? `thunderstore:${pf.manifest.name}` : 'thunderstore:(invalid)';
			return {
				target,
				dryRun: true,
				ok: false,
				summary: `Package not assembled — ${pf.blockers.length} blocker(s): ${pf.blockers.join('; ')}`,
				steps: [
					`Found root files: ${entries.filter((e) => (REQUIRED_ROOT_FILES as readonly string[]).includes(e.path)).map((e) => e.path).join(', ') || '(none)'}`,
					`Found ${payloadFiles.length} payload file(s).`
				],
				warnings: pf.warnings
			};
		}

		// Build the REAL zip bytes in-memory (deterministic) and list its exact contents.
		const zip = buildZip(entries);
		const listing: ZipListing[] = listZip(zip);
		const filename = zipFilename(pf.manifest);
		const target = `thunderstore:${pf.manifest.name}`;

		return {
			target,
			dryRun: true,
			ok: true,
			summary: `Assembled ${filename} — ${listing.length} entr${listing.length === 1 ? 'y' : 'ies'}, ${zip.length} bytes.`,
			steps: [
				`Validate Thunderstore rules (manifest + 256×256 icon.png + README.md): OK`,
				`Bundle root files: ${REQUIRED_ROOT_FILES.join(', ')}`,
				`Bundle ${payloadFiles.length} payload file(s) under the package`,
				`Zip contents:`,
				...listing.map((l) => `  • ${l.path} (${l.size} bytes)`),
				`Computed package ${filename} (${zip.length} bytes)`
			],
			warnings: pf.warnings,
			artifact: { name: pf.manifest.name, version: pf.manifest.version_number }
		};
	}

	async publish(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult> {
		const pf = await preflight(opts.cwd, opts.config);
		const dryRun = opts.dryRun ?? true;
		const cfg = readSubmissionConfig(opts.config);

		if (!pf.ok || !pf.manifest) {
			return {
				target: pf.manifest ? `thunderstore:${pf.manifest.name}` : 'thunderstore:(invalid)',
				dryRun,
				ok: false,
				summary: `Not publishable: ${pf.blockers.join('; ')}`,
				// Always emit a plan — the honest "what blocked us" so the surface is never blank (F-008).
				steps: [
					'Preflight the Thunderstore package rules before any upload:',
					...pf.blockers.map((b) => `  ✗ ${b}`)
				],
				warnings: pf.warnings
			};
		}

		const manifest = pf.manifest;
		const target = `thunderstore:${manifest.name}`;
		const { entries } = await collectEntries(opts.cwd, opts.config);
		const zip = buildZip(entries);
		const filename = zipFilename(manifest);
		const tokenPresent = opts.secrets.has(THUNDERSTORE_SECRET);

		// The EXACT upload-API request shape that WOULD be sent (the secret is redacted — D-026).
		const plan = buildUploadPlan({
			manifest,
			config: cfg,
			zipFilename: filename,
			zipSize: zip.length,
			tokenPresent
		});
		const requestSteps = [
			`Package ${filename} (${zip.length} bytes)`,
			`Thunderstore upload request shape (Bearer token redacted — D-026):`,
			...planToSteps(plan).map((s) => `  → ${s}`)
		];

		const warnings = [...pf.warnings];
		if (!plan.namespace) {
			warnings.push('config.namespace (the Thunderstore team) is required to submit — set it before a real publish.');
		}

		if (dryRun) {
			return {
				target,
				dryRun: true,
				ok: true,
				summary: `Dry-run: would publish ${manifest.name} ${manifest.version_number} to Thunderstore (${plan.requests.length}-step upload). Auth via ${THUNDERSTORE_SECRET} (${tokenPresent ? 'present' : 'not set'}).`,
				steps: requestSteps,
				warnings
			};
		}

		// ── REAL publish (TASK 14.7, runbook §0) ──────────────────────────────────────────
		// The driver enforced the confirm gate (D-018) before dryRun:false reaches us. The token
		// value is read from the CONFINED resolver only here, sent only as the Authorization
		// header, and never appears in any returned line (D-026).
		const token = opts.secrets.get(THUNDERSTORE_SECRET);
		if (!token) {
			// Missing token: the HONEST deferral (unchanged) — never a fabricated upload (F-008).
			return {
				target,
				dryRun: false,
				ok: false,
				summary: `Publish of ${manifest.name} ${manifest.version_number} prepared but NOT executed — ${THUNDERSTORE_SECRET} is not set, so the real Thunderstore upload is deferred to operator credentials.`,
				steps: requestSteps,
				warnings: [
					...warnings,
					`Real Thunderstore upload not performed — supply ${THUNDERSTORE_SECRET} in .env, set config.namespace, and confirm the gated action (D-026/D-018). The request shape above is exactly what would be sent (Bearer secret redacted as "${REDACTED_SECRET}").`
				]
			};
		}
		if (!plan.namespace) {
			// namespace is REQUIRED to submit — fail honestly BEFORE any external call lands
			// (an initiated-but-unsubmittable upload would strand a half-publish).
			return {
				target,
				dryRun: false,
				ok: false,
				summary: `Publish of ${manifest.name} ${manifest.version_number} NOT executed — config.namespace (the Thunderstore team) is required to submit.`,
				steps: requestSteps,
				warnings: [
					...warnings,
					'Set config.namespace on the publish target, re-run the dry-run, and confirm again (the confirm token is config-bound, D-018).'
				]
			};
		}

		// Execute the planned 4-step upload for real — bounded per step, honest per-step trail.
		const exec = await executeUploadPlan({
			apiBase: plan.apiBase,
			token,
			zip,
			zipFilename: filename,
			namespace: plan.namespace,
			communities: plan.communities,
			categories: cfg.categories ?? {},
			hasNsfwContent: cfg.hasNsfwContent ?? false,
			stepTimeoutMs: configMs(opts.config, 'stepTimeoutMs')
		});
		const execSteps = [
			`Package ${filename} (${zip.length} bytes)`,
			...exec.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`)
		];
		if (!exec.ok) {
			const failed = exec.steps.find((s) => !s.ok);
			return {
				target,
				dryRun: false,
				ok: false,
				summary: `Publish of ${manifest.name} ${manifest.version_number} FAILED at step "${exec.failedStep}" — ${failed?.detail ?? 'see steps'}.`,
				steps: execSteps,
				warnings: [
					...warnings,
					`Upload failed at "${exec.failedStep}": ${failed?.detail ?? 'no detail'}.`,
					`Safe to retry with the SAME version only if the submit step never succeeded; if a version was created on Thunderstore, bump version_number — Thunderstore permanently rejects re-used versions (runbook §8).`
				]
			};
		}
		return {
			target,
			dryRun: false,
			ok: true,
			summary: `Published ${manifest.name} ${manifest.version_number} to Thunderstore (${plan.namespace}) — 4-step upload complete.`,
			steps: execSteps,
			warnings
		};
	}

	/**
	 * Post-publish visibility check (TASK 14.7): poll the PUBLIC package-version endpoint until
	 * the manifest's (namespace, name, version) is live. Read-only — never mutates externally —
	 * and bounded (~2 min default; config.verifyTimeoutMs / config.verifyIntervalMs tune it).
	 * An honest timeout returns ok:false (the driver records the incident); never spins (F-014).
	 */
	async verify(opts: AdapterRunOptions & { secrets: SecretResolver }): Promise<AdapterRunResult> {
		const pf = await preflight(opts.cwd, opts.config);
		const cfg = readSubmissionConfig(opts.config);
		if (!pf.manifest) {
			return {
				target: 'thunderstore:(invalid)',
				dryRun: false,
				ok: false,
				summary: `Verify not possible: ${pf.blockers.join('; ') || 'manifest.json is missing/invalid.'}`,
				steps: pf.blockers.map((b) => `✗ ${b}`),
				warnings: ['Fix the manifest, then re-run verify.']
			};
		}
		const manifest = pf.manifest;
		const target = `thunderstore:${manifest.name}`;
		if (!cfg.namespace) {
			return {
				target,
				dryRun: false,
				ok: false,
				summary: `Verify not possible: config.namespace (the Thunderstore team) is not set — the package page lives under <namespace>/${manifest.name}.`,
				steps: [`Would poll ${packageVersionUrl(cfg.apiBase ?? 'https://thunderstore.io', '<namespace>', manifest.name, manifest.version_number)}`],
				warnings: ['Set config.namespace on the publish target, then re-run verify.']
			};
		}

		const poll = await pollPackageVisible({
			apiBase: cfg.apiBase ?? 'https://thunderstore.io',
			namespace: cfg.namespace,
			name: manifest.name,
			version: manifest.version_number,
			timeoutMs: configMs(opts.config, 'verifyTimeoutMs'),
			intervalMs: configMs(opts.config, 'verifyIntervalMs')
		});
		const steps = [
			`Poll ${poll.url} (public endpoint, no auth)`,
			`${poll.attempts} attempt(s) over ${Math.round(poll.elapsedMs / 100) / 10}s — last response: ${poll.detail}`
		];
		if (poll.visible) {
			return {
				target,
				dryRun: false,
				ok: true,
				summary: `Verified: ${cfg.namespace}/${manifest.name} ${manifest.version_number} is LIVE on Thunderstore (${poll.attempts} poll(s), ${Math.round(poll.elapsedMs / 100) / 10}s).`,
				steps,
				warnings: []
			};
		}
		return {
			target,
			dryRun: false,
			ok: false,
			summary: `Verify TIMED OUT after ${Math.round(poll.elapsedMs / 100) / 10}s — ${cfg.namespace}/${manifest.name} ${manifest.version_number} is not visible yet (last: ${poll.detail}).`,
			steps,
			warnings: [
				`The version may still be processing — re-run verify, or check ${poll.url} manually. Default bound is ${VERIFY_TIMEOUT_DEFAULT_MS / 1000}s (config.verifyTimeoutMs overrides).`
			]
		};
	}
}
