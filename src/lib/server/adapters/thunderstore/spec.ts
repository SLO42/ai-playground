// TASK 12.2 — Thunderstore PACKAGE SPEC: the validation rules a Thunderstore mod package must
// satisfy, transcribed from the official spec (wiki.thunderstore.io/mods/creating-a-package).
//
// A valid Thunderstore package zip has THREE required files at its ROOT:
//   • manifest.json — package metadata (validated field-by-field below);
//   • README.md     — UTF-8 markdown documentation;
//   • icon.png      — a PNG image EXACTLY 256×256 pixels.
// plus the mod payload (dll/plugin files) laid out under the zip (commonly under plugins/).
//
// This module is PURE + dependency-free: it validates parsed values + raw bytes and returns
// HONEST, SPECIFIC blockers (F-008) — never a generic "invalid". 12.2's package()/validate()
// delegate every rule here so the contract harness, the unit tests, and the live surface share
// ONE rule set. No filesystem, no network — callers read the files; this judges them.

/** The three files Thunderstore requires at the package zip root. */
export const REQUIRED_ROOT_FILES = ['manifest.json', 'README.md', 'icon.png'] as const;

/** Thunderstore field limits (official spec). */
export const MANIFEST_LIMITS = {
	/** `name`: max 128 chars, only `a-z A-Z 0-9 _`. */
	nameMax: 128,
	/** `description`: max 250 chars (shown in list views). */
	descriptionMax: 250
} as const;

/** Icon must be EXACTLY this resolution, in PNG format. */
export const ICON_SIZE = 256;

/** The Thunderstore `name` charset: letters, digits, underscore (underscores display as spaces). */
const NAME_RE = /^[A-Za-z0-9_]+$/;

/** 3-numbered Major.Minor.Patch semantic version (each part a non-negative integer, no leading +). */
const SEMVER3_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A dependency string: `{team}-{package}-{version}` where version is a 3-part semver. */
const DEPENDENCY_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The validated, normalized Thunderstore manifest (only after `validateManifest` passes). */
export interface ThunderstoreManifest {
	name: string;
	version_number: string;
	website_url: string;
	description: string;
	dependencies: string[];
}

/** A field-level validation outcome: honest blockers + non-blocking warnings (F-008). */
export interface FieldValidation {
	ok: boolean;
	blockers: string[];
	warnings: string[];
}

/** True iff `v` is a 3-numbered Major.Minor.Patch semantic version. */
export function isValidVersion(v: unknown): v is string {
	return typeof v === 'string' && SEMVER3_RE.test(v);
}

/** True iff `dep` is a well-formed `{team}-{package}-{version}` dependency string. */
export function isValidDependency(dep: unknown): dep is string {
	return typeof dep === 'string' && DEPENDENCY_RE.test(dep);
}

/**
 * Validate a parsed manifest.json object against Thunderstore's manifest rules. Returns every
 * blocker found (not just the first) so the operator fixes them in one pass — each message names
 * the exact field + rule (honest, F-008). `manifest` may be anything (untrusted JSON); a non-object
 * is itself a blocker.
 */
export function validateManifest(manifest: unknown): FieldValidation {
	const blockers: string[] = [];
	const warnings: string[] = [];

	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		return { ok: false, blockers: ['manifest.json must be a JSON object.'], warnings };
	}
	const m = manifest as Record<string, unknown>;

	// name — required, max 128, charset [A-Za-z0-9_].
	if (typeof m.name !== 'string' || m.name.length === 0) {
		blockers.push('manifest.name is required (a non-empty string).');
	} else {
		if (m.name.length > MANIFEST_LIMITS.nameMax) {
			blockers.push(`manifest.name exceeds ${MANIFEST_LIMITS.nameMax} characters (got ${m.name.length}).`);
		}
		if (!NAME_RE.test(m.name)) {
			blockers.push('manifest.name may contain only letters, digits, and underscores (a-z A-Z 0-9 _).');
		}
	}

	// version_number — required, 3-part semver.
	if (typeof m.version_number !== 'string' || m.version_number.length === 0) {
		blockers.push('manifest.version_number is required (a Major.Minor.Patch version).');
	} else if (!isValidVersion(m.version_number)) {
		blockers.push(
			`manifest.version_number "${m.version_number}" is not a 3-numbered Major.Minor.Patch semantic version (e.g. 1.4.0).`
		);
	}

	// description — required by the surface, max 250.
	if (typeof m.description !== 'string') {
		blockers.push('manifest.description is required (a string; "" is allowed but the field must exist).');
	} else if (m.description.length > MANIFEST_LIMITS.descriptionMax) {
		blockers.push(
			`manifest.description exceeds ${MANIFEST_LIMITS.descriptionMax} characters (got ${m.description.length}).`
		);
	} else if (m.description.length === 0) {
		warnings.push('manifest.description is empty — the package will show no summary in list views.');
	}

	// website_url — optional, but the FIELD must be present (empty string when unused).
	if (!('website_url' in m)) {
		blockers.push('manifest.website_url is required by Thunderstore — use an empty string "" when unused.');
	} else if (typeof m.website_url !== 'string') {
		blockers.push('manifest.website_url must be a string (use "" when unused).');
	} else if (m.website_url.length > 0 && !/^https?:\/\//i.test(m.website_url)) {
		blockers.push(`manifest.website_url "${m.website_url}" must be an http(s) URL or an empty string.`);
	}

	// dependencies — required array of `{team}-{package}-{version}` strings.
	if (!('dependencies' in m)) {
		blockers.push('manifest.dependencies is required (use [] when the mod has no dependencies).');
	} else if (!Array.isArray(m.dependencies)) {
		blockers.push('manifest.dependencies must be an array of "Team-Package-Version" strings.');
	} else {
		m.dependencies.forEach((dep, i) => {
			if (!isValidDependency(dep)) {
				blockers.push(
					`manifest.dependencies[${i}] ${JSON.stringify(dep)} is not a valid "Team-Package-Version" string (e.g. BepInEx-BepInExPack-5.4.2100).`
				);
			}
		});
	}

	return { ok: blockers.length === 0, blockers, warnings };
}

/**
 * Read a PNG's pixel dimensions from its IHDR chunk (the first chunk after the 8-byte signature).
 * Returns null when the bytes are not a PNG (so the caller can give an honest "not a PNG" blocker)
 * — no image library needed; the IHDR width/height are big-endian uint32 at fixed offsets.
 */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
	// PNG signature: 89 50 4E 47 0D 0A 1A 0A.
	const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length < 24) return null;
	for (let i = 0; i < SIG.length; i++) {
		if (bytes[i] !== SIG[i]) return null;
	}
	// The first chunk must be IHDR (bytes 12..16 = "IHDR"); width@16, height@20 (big-endian).
	if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = dv.getUint32(16, false);
	const height = dv.getUint32(20, false);
	return { width, height };
}

/** Validate icon.png raw bytes are a PNG of EXACTLY 256×256 (honest, specific blockers). */
export function validateIcon(bytes: Uint8Array | null): FieldValidation {
	const blockers: string[] = [];
	if (!bytes || bytes.length === 0) {
		return { ok: false, blockers: ['icon.png is missing — Thunderstore requires a 256×256 PNG icon.'], warnings: [] };
	}
	const size = readPngSize(bytes);
	if (!size) {
		blockers.push('icon.png is not a valid PNG file (the PNG signature/IHDR header is missing).');
	} else if (size.width !== ICON_SIZE || size.height !== ICON_SIZE) {
		blockers.push(
			`icon.png must be exactly ${ICON_SIZE}×${ICON_SIZE} pixels — found ${size.width}×${size.height}.`
		);
	}
	return { ok: blockers.length === 0, blockers, warnings: [] };
}

/** Validate README.md content is present + UTF-8 decodable (honest blockers). */
export function validateReadme(text: string | null): FieldValidation {
	const blockers: string[] = [];
	const warnings: string[] = [];
	if (text == null) {
		blockers.push('README.md is missing — Thunderstore requires a README.md at the package root.');
	} else if (text.trim().length === 0) {
		warnings.push('README.md is empty — the package will show no documentation.');
	}
	return { ok: blockers.length === 0, blockers, warnings };
}
