// SD-2 (PRE-WAKE SAFETY) — the honest AUTONOMY boot-status: compute + persist + read.
//
// THE HOLE (F-008 violation): a malformed/unreadable orchestration.yaml (or workforce.yaml)
// degrades every engine to mode='manual' with only a console.warn (hooks.server.ts) — the
// operator cannot SEE that autonomy is down. A silent disarm is exactly the "invisible failure"
// this repo forbids: runtime state must render an HONEST state, never a plausible-looking one.
//
// THIS MODULE closes it in three pure-then-persistent steps:
//   1. computeAutonomyStatus(configDir) — a PURE classifier over the SAME config files the boot
//      engines read (orchestration.yaml drives the mode → all engines; workforce.yaml drives PM
//      failure-triggers + drift). It never throws: a parse fault becomes an honest 'config-error'
//      assessment carrying the failing file + the raw message, mirroring how the boot code itself
//      catches ConfigError → manual (the 11.5 most-conservative-gate pattern).
//   2. persistAutonomyStatus(db, …) — UPSERTs the SINGLETON `autonomy_status:current` row (m0082)
//      so /services renders a persistent, plain-language surface, not a console line. UPSERT at a
//      fixed id fully replaces the prior boot's row (one honest current state; F-015 idempotent —
//      re-boot re-runs cleanly, no accumulation).
//   3. readAutonomyStatus(db) — the /services loader read path, POJO-only (F-013: booted_at → ISO).
//
// Boundary discipline: the fixed record id is a CONSTANT literal (never user input — D-016 permits
// interpolating only validated table/record ids; here it is a hardcoded constant). Every VALUE binds
// via $param. Absent option fields are OMITTED from CONTENT so the column stays NONE (§6.1), which is
// why a later healthy boot cleanly clears a prior boot's detail/config_file (UPSERT CONTENT replaces).

import type { Db } from '../db/client';
import { loadOrchestration, loadWorkforce, ConfigError, type OrchMode } from '../config/index';

/** The three honest autonomy states the operator can SEE. */
export type AutonomyState = 'armed' | 'manual' | 'config-error';

/** The pure classification of autonomy from the config files (no DB, no booted_at). */
export interface AutonomyAssessment {
	/** armed = engines drive automatically (mode event|periodic); manual = operator-only (as configured);
	 *  config-error = a config file was unreadable so engines are forced OFF (the silent-disarm hole). */
	state: AutonomyState;
	/** The RESOLVED orchestration mode, or null when the config could not be read. */
	mode: OrchMode | null;
	/** True iff orchestration.yaml parsed cleanly. */
	configOk: boolean;
	/** True iff workforce.yaml parsed cleanly (a fault degrades PM triggers/drift, not the mode). */
	workforceOk: boolean;
	/** The config file that FAILED to parse (config-error only), else null. */
	configFile: string | null;
	/** The plain-language headline the UI shows. */
	reason: string;
	/** The raw parse-error message (config-error only), else null. */
	detail: string | null;
	/** A secondary honest degrade note (e.g. workforce.yaml unreadable), else null. */
	note: string | null;
}

/** The persisted/read row shape — the assessment plus the boot instant (ISO; F-013). */
export interface AutonomyStatusRow extends AutonomyAssessment {
	/** ISO instant this status was written at boot, or null (renders "—"). */
	bootedAt: string | null;
}

/** The fixed singleton record id — a CONSTANT literal (safe to inline; D-016). */
const AUTONOMY_STATUS_ID = 'autonomy_status:current';

/** Basename of a config path for the human-facing message (full path lives in config_file/detail). */
function baseName(file: string): string {
	return file.split(/[\\/]/).pop() || file;
}

/**
 * PURE: classify autonomy from the config files under `configDir`. NEVER throws — a parse fault
 * becomes an honest 'config-error' assessment (the same fail-to-manual posture the boot engines
 * take, but SURFACED instead of swallowed). `configDir` empty/whitespace falls back to 'config'.
 *
 * Shadow paths (all four exercised by the test suite):
 *   • happy      — orchestration.yaml valid, mode manual → 'manual'; mode event|periodic → 'armed'.
 *   • upstream error — orchestration.yaml unreadable/malformed → 'config-error' (autonomy OFF).
 *   • partial degrade — orchestration.yaml valid but workforce.yaml unreadable → armed/manual per
 *                       mode, with workforceOk=false + an honest `note` (PM triggers unarmed).
 *   • empty dir  — a blank configDir falls back to the default 'config' directory.
 */
export function computeAutonomyStatus(configDir: string): AutonomyAssessment {
	const dir = (configDir ?? '').trim() || 'config';
	const orchFile = `${dir}/orchestration.yaml`;
	const wfFile = `${dir}/workforce.yaml`;

	// orchestration.yaml is the MODE driver — a fault here forces every engine OFF (config-error).
	let mode: OrchMode;
	try {
		mode = loadOrchestration(orchFile).mode;
	} catch (err) {
		const file = err instanceof ConfigError && err.file ? err.file : orchFile;
		return {
			state: 'config-error',
			mode: null,
			configOk: false,
			workforceOk: false, // not evaluated — the mode driver already failed
			configFile: file,
			reason: `autonomy OFF: config unreadable (${baseName(file)})`,
			detail: (err as Error).message,
			note: null
		};
	}

	// workforce.yaml drives PM failure-triggers + §5 drift auto-raise; a fault degrades THOSE to
	// unarmed but does NOT force the whole mode to manual (matches hooks.server.ts). Surface it as a
	// secondary honest note rather than a full config-error.
	let workforceOk = true;
	let note: string | null = null;
	try {
		loadWorkforce(wfFile);
	} catch (err) {
		workforceOk = false;
		const file = err instanceof ConfigError && err.file ? err.file : wfFile;
		note = `Workforce config unreadable (${baseName(file)}) — PM failure-triggers and drift auto-raise are unarmed until it is fixed and the server restarts.`;
	}

	if (mode === 'manual') {
		return {
			state: 'manual',
			mode,
			configOk: true,
			workforceOk,
			configFile: null,
			reason: 'Autonomy is in MANUAL mode — engines run only on operator action (as configured).',
			detail: null,
			note
		};
	}
	return {
		state: 'armed',
		mode,
		configOk: true,
		workforceOk,
		configFile: null,
		reason: `Autonomy is ARMED (${mode} mode) — engines drive automatically per config.`,
		detail: null,
		note
	};
}

/**
 * Persist the assessment as the SINGLETON `autonomy_status:current` row (m0082). UPSERT CONTENT at
 * the fixed id fully REPLACES the prior boot's row — so a later healthy boot cleanly clears a stale
 * config-error's detail/config_file (omitted option fields become NONE, §6.1). Idempotent (F-015):
 * re-boot re-runs it cleanly, one honest current state. booted_at is a JS Date → SurrealDB datetime.
 */
export async function persistAutonomyStatus(db: Db, a: AutonomyAssessment): Promise<void> {
	const content: Record<string, unknown> = {
		state: a.state,
		config_ok: a.configOk,
		workforce_ok: a.workforceOk,
		reason: a.reason,
		booted_at: new Date()
	};
	// OMIT absent option fields so the columns stay NONE (§6.1) — never a NULL that fails option<T>.
	if (a.mode !== null) content.mode = a.mode;
	if (a.configFile !== null) content.config_file = a.configFile;
	if (a.detail !== null) content.detail = a.detail;
	if (a.note !== null) content.note = a.note;

	await db.query(`UPSERT ${AUTONOMY_STATUS_ID} CONTENT $content;`, { content });
}

/** Raw row shape as SurrealDB returns it (before normalization). */
interface RawAutonomyRow {
	id?: unknown;
	state?: unknown;
	mode?: unknown;
	config_ok?: unknown;
	workforce_ok?: unknown;
	config_file?: unknown;
	reason?: unknown;
	detail?: unknown;
	note?: unknown;
	booted_at?: unknown;
}

/** Coerce a SurrealDB datetime (Date | ISO string | {toISOString}) to an ISO string, else null (F-013). */
function isoOrNull(at: unknown): string | null {
	if (at == null) return null;
	if (at instanceof Date) return at.toISOString();
	if (typeof at === 'string') return at;
	if (typeof (at as { toISOString?: unknown }).toISOString === 'function') {
		try {
			return (at as { toISOString: () => string }).toISOString();
		} catch {
			return null;
		}
	}
	return null;
}

/** Normalize a raw row to the POJO read shape (F-013: booted_at → ISO; absent option → null). */
function normAutonomyStatus(row: RawAutonomyRow): AutonomyStatusRow {
	const state = (row.state === 'armed' || row.state === 'manual' || row.state === 'config-error'
		? row.state
		: 'config-error') as AutonomyState;
	return {
		state,
		mode: (row.mode == null ? null : String(row.mode)) as OrchMode | null,
		configOk: Boolean(row.config_ok),
		workforceOk: Boolean(row.workforce_ok),
		configFile: row.config_file == null ? null : String(row.config_file),
		reason: row.reason == null ? '' : String(row.reason),
		detail: row.detail == null ? null : String(row.detail),
		note: row.note == null ? null : String(row.note),
		bootedAt: isoOrNull(row.booted_at)
	};
}

/**
 * Read the persisted autonomy boot-status (the /services loader read path). Returns null when the
 * row has never been written (no boot has persisted it yet) — the caller renders an honest "unknown"
 * rather than a fabricated state (F-008). POJO-only (F-013).
 */
export async function readAutonomyStatus(db: Db): Promise<AutonomyStatusRow | null> {
	const [rows] = await db.query<[RawAutonomyRow[]]>(`SELECT * FROM ${AUTONOMY_STATUS_ID};`);
	const row = rows?.[0];
	if (!row) return null;
	return normAutonomyStatus(row);
}
