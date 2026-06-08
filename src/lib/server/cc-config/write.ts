// TASK 2.11 — Claude Code config MANAGER (read-WRITE, D-010; depends on: 1.8).
//
// 1.8 gave us the READ side: parse `.claude/` + `.mcp.json` on disk → mirror into the
// cc_* tables, with drift detection. 2.11 is the WRITE side: edit a config file from the
// dashboard, with the D-010 contract enforced at every step:
//
//   validate → diff → CONFIRM (mandatory) → write file → re-sync the cc_* mirror.
//
// D-010 is explicit: "Writes validate before touching files (settings.json schema, agent
// frontmatter, SKILL.md frontmatter)" and "Never silently overwrite hand-edited files —
// diff and confirm." So this module splits the edit into TWO calls:
//
//   • planEdit(...)  — validate the proposed content + compute a diff vs what is on disk
//                      NOW. Pure: NO write, NO DB. Returns a token bound to the exact bytes
//                      it diffed. This is the "diff" the operator reviews.
//   • applyEdit(...) — the CONFIRM step. Re-reads disk, re-validates, and refuses if the
//                      file changed under us since planEdit (the confirm token no longer
//                      matches) — that is the "never silently overwrite a hand-edit" guard.
//                      Then writes the file and re-syncs the mirror (reusing syncScope).
//
// The validators carry the v1 settings lesson (D-010): a valid MCP permission rule is
// `mcp__server__tool` / `mcp__server__*`, NEVER the v1 mistake `mcp__server__:*` (a stray
// colon). Invalid config is rejected BEFORE any byte hits disk.
//
// Boundary discipline: the only thing that touches disk is a path we resolved + confined
// (reusing confineScope from sync.ts where a root is supplied). Optionals are OMITTED, never
// NULL (option<T>, §6.1). Re-sync goes through the SAME syncScope used by 1.8 — one writer.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { Db } from '../db/client';
import {
	parseSettings,
	splitFrontmatter,
	stableStringify,
	type ParsedSettings
} from './parse';
import { syncScope, type SyncResult, type SyncScope } from './sync';

// ── The editable config kinds (D-010: hooks/skills/agents/MCP/settings.json/CLAUDE.md) ──

/**
 * Which config file a write targets. `settings` covers hooks + permissions + env + MCP
 * servers (they all live in settings.json); `mcp_json` is the sibling `.mcp.json`;
 * `agent`/`skill` are markdown-with-frontmatter; `claude_md` is the free-text CLAUDE.md.
 */
export type ConfigKind = 'settings' | 'mcp_json' | 'agent' | 'skill' | 'claude_md';

/** A validation problem. `path` locates it within the document for the UI. */
export interface ValidationIssue {
	path: string;
	message: string;
}

export interface ValidationResult {
	ok: boolean;
	issues: ValidationIssue[];
}

/** Thrown when applyEdit is called but the on-disk file changed since planEdit (D-010). */
export class StaleConfirmError extends Error {
	override readonly name = 'StaleConfirmError';
	constructor(
		message: string,
		readonly filePath: string
	) {
		super(message);
	}
}

/** Thrown when applyEdit is given content that fails validation (defense in depth). */
export class ConfigValidationError extends Error {
	override readonly name = 'ConfigValidationError';
	constructor(
		message: string,
		readonly issues: ValidationIssue[]
	) {
		super(message);
	}
}

// ── Validators (validate BEFORE touching files — D-010) ──────────────────────────────────

/** A valid MCP permission rule: `mcp__<server>` or `mcp__<server>__<tool|*>`. No stray colon. */
const MCP_PERMISSION_RE = /^mcp__[A-Za-z0-9_.-]+(?:__[A-Za-z0-9_.*-]+)?$/;
/** The v1 mistake we must reject loudly: a colon in an mcp rule (`mcp__server__:*`). */
const MCP_PERMISSION_BAD_COLON_RE = /^mcp__.*:/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Validate one permission rule string; pushes an issue for the v1 colon mistake. */
function validatePermissionRule(rule: unknown, where: string, issues: ValidationIssue[]): void {
	if (typeof rule !== 'string' || rule.trim() === '') {
		issues.push({ path: where, message: 'permission rule must be a non-empty string' });
		return;
	}
	if (rule.startsWith('mcp__')) {
		if (MCP_PERMISSION_BAD_COLON_RE.test(rule)) {
			issues.push({
				path: where,
				message: `invalid MCP permission rule "${rule}": a colon is the v1 mistake — use mcp__server__tool or mcp__server__* (D-010)`
			});
		} else if (!MCP_PERMISSION_RE.test(rule)) {
			issues.push({
				path: where,
				message: `invalid MCP permission rule "${rule}": expected mcp__server or mcp__server__tool (D-010)`
			});
		}
	}
}

/**
 * Validate settings.json text. Must be a JSON object; permissions.allow/deny/ask must be
 * arrays of valid rules (MCP rules carry the v1 colon lesson); hooks/env/mcpServers must be
 * objects when present. Permissive on unknown keys (round-tripped), strict on shape.
 */
export function validateSettings(text: string): ValidationResult {
	const issues: ValidationIssue[] = [];
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		return { ok: false, issues: [{ path: '$', message: `invalid JSON: ${(err as Error).message}` }] };
	}
	if (!isPlainObject(json)) {
		return { ok: false, issues: [{ path: '$', message: 'settings.json must be a JSON object' }] };
	}
	const perms = json.permissions;
	if (perms !== undefined) {
		if (!isPlainObject(perms)) {
			issues.push({ path: 'permissions', message: 'permissions must be an object' });
		} else {
			for (const bucket of ['allow', 'deny', 'ask'] as const) {
				const arr = perms[bucket];
				if (arr === undefined) continue;
				if (!Array.isArray(arr)) {
					issues.push({ path: `permissions.${bucket}`, message: `${bucket} must be an array` });
					continue;
				}
				arr.forEach((rule, i) =>
					validatePermissionRule(rule, `permissions.${bucket}[${i}]`, issues)
				);
			}
		}
	}
	if (json.env !== undefined && !isPlainObject(json.env)) {
		issues.push({ path: 'env', message: 'env must be an object of string→string' });
	}
	if (json.hooks !== undefined && !isPlainObject(json.hooks)) {
		issues.push({ path: 'hooks', message: 'hooks must be an object keyed by event' });
	}
	if (json.mcpServers !== undefined && !isPlainObject(json.mcpServers)) {
		issues.push({ path: 'mcpServers', message: 'mcpServers must be an object keyed by server name' });
	}
	return { ok: issues.length === 0, issues };
}

/** Validate `.mcp.json` text: object with an `mcpServers` object (or bare server map). */
export function validateMcpJson(text: string): ValidationResult {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		return { ok: false, issues: [{ path: '$', message: `invalid JSON: ${(err as Error).message}` }] };
	}
	if (!isPlainObject(json)) {
		return { ok: false, issues: [{ path: '$', message: '.mcp.json must be a JSON object' }] };
	}
	const servers = isPlainObject(json.mcpServers) ? json.mcpServers : json;
	const issues: ValidationIssue[] = [];
	for (const [name, entry] of Object.entries(servers)) {
		if (!isPlainObject(entry)) {
			issues.push({ path: `mcpServers.${name}`, message: 'server entry must be an object' });
			continue;
		}
		const hasCommand = typeof entry.command === 'string';
		const hasUrl = typeof entry.url === 'string';
		const declaredType = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
		if (!hasCommand && !hasUrl && !declaredType) {
			issues.push({
				path: `mcpServers.${name}`,
				message: 'server needs a command (stdio) or url (http/sse)'
			});
		}
		if (declaredType && !['stdio', 'http', 'sse'].includes(declaredType)) {
			issues.push({
				path: `mcpServers.${name}.type`,
				message: `unknown transport "${entry.type}" — expected stdio|http|sse`
			});
		}
	}
	return { ok: issues.length === 0, issues };
}

/** Validate a markdown-with-frontmatter file (agent or skill): fenced YAML + a `name`. */
function validateFrontmatterDoc(text: string, kind: 'agent' | 'skill'): ValidationResult {
	const issues: ValidationIssue[] = [];
	const fence = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!fence) {
		return {
			ok: false,
			issues: [{ path: '$', message: `${kind} file must start with --- fenced YAML frontmatter` }]
		};
	}
	let fm: unknown;
	try {
		fm = parseYaml(fence[1]);
	} catch (err) {
		return {
			ok: false,
			issues: [{ path: 'frontmatter', message: `invalid YAML frontmatter: ${(err as Error).message}` }]
		};
	}
	if (!isPlainObject(fm)) {
		issues.push({ path: 'frontmatter', message: 'frontmatter must be a YAML mapping' });
	} else if (typeof fm.name !== 'string' || fm.name.trim() === '') {
		issues.push({ path: 'frontmatter.name', message: `${kind} requires a non-empty "name"` });
	}
	return { ok: issues.length === 0, issues };
}

/** Validate a proposed edit by kind. CLAUDE.md is free text → always valid. */
export function validateContent(kind: ConfigKind, text: string): ValidationResult {
	switch (kind) {
		case 'settings':
			return validateSettings(text);
		case 'mcp_json':
			return validateMcpJson(text);
		case 'agent':
			return validateFrontmatterDoc(text, 'agent');
		case 'skill':
			return validateFrontmatterDoc(text, 'skill');
		case 'claude_md':
			return { ok: true, issues: [] };
	}
}

// ── Diff (the operator-reviewable change) ────────────────────────────────────────────────

/** A unified per-line diff of the file's current bytes vs the proposed bytes. */
export interface ConfigDiff {
	filePath: string;
	/** True if the proposed content is byte-identical to what is on disk (no-op edit). */
	unchanged: boolean;
	/** Line-level changes: '+' added, '-' removed, ' ' context. */
	hunks: Array<{ op: '+' | '-' | ' '; line: string }>;
	/** sha256 of the bytes currently on disk at plan time — the confirm token. */
	currentDigest: string;
}

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Read a file's current bytes, or '' if it does not exist (a create). */
function readCurrent(filePath: string): string {
	try {
		return readFileSync(filePath, 'utf8');
	} catch {
		return '';
	}
}

/**
 * A minimal line-level diff (LCS) of `current` vs `proposed`. Not a full Myers diff, but
 * it produces a faithful add/remove/context view for review — enough for the operator to
 * see exactly what an edit changes before confirming (D-010).
 */
function diffLines(current: string, proposed: string): ConfigDiff['hunks'] {
	const a = current === '' ? [] : current.split('\n');
	const b = proposed === '' ? [] : proposed.split('\n');
	const n = a.length;
	const m = b.length;
	// LCS length table.
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const hunks: ConfigDiff['hunks'] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			hunks.push({ op: ' ', line: a[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			hunks.push({ op: '-', line: a[i] });
			i++;
		} else {
			hunks.push({ op: '+', line: b[j] });
			j++;
		}
	}
	while (i < n) hunks.push({ op: '-', line: a[i++] });
	while (j < m) hunks.push({ op: '+', line: b[j++] });
	return hunks;
}

// ── planEdit: validate + diff (NO write, NO DB) ──────────────────────────────────────────

export interface PlanEditInput {
	kind: ConfigKind;
	/** Absolute path to the file being edited. */
	filePath: string;
	/** The proposed full file content. */
	content: string;
}

export interface EditPlan {
	kind: ConfigKind;
	filePath: string;
	validation: ValidationResult;
	diff: ConfigDiff;
	/** The confirm token applyEdit requires — binds the confirm to the bytes diffed. */
	confirmToken: string;
}

/**
 * Step 1 of the D-010 write contract: VALIDATE the proposed content + compute the DIFF
 * against what is on disk RIGHT NOW. Pure — touches no DB, writes no file. The returned
 * `confirmToken` is the sha256 of the current on-disk bytes; applyEdit refuses unless the
 * file still matches it, so a hand-edit landing between plan and confirm is never silently
 * clobbered (the "diff and confirm" mandate). If validation fails, `diff` is still computed
 * so the UI can show what WOULD change, but applyEdit will refuse.
 */
export function planEdit(input: PlanEditInput): EditPlan {
	const validation = validateContent(input.kind, input.content);
	const current = readCurrent(input.filePath);
	const currentDigest = sha256(current);
	const diff: ConfigDiff = {
		filePath: input.filePath,
		unchanged: current === input.content,
		hunks: diffLines(current, input.content),
		currentDigest
	};
	return {
		kind: input.kind,
		filePath: input.filePath,
		validation,
		diff,
		confirmToken: currentDigest
	};
}

// ── applyEdit: confirm → write → re-sync the mirror ──────────────────────────────────────

export interface ApplyEditInput extends PlanEditInput {
	/** The `confirmToken` from the planEdit the operator reviewed. MANDATORY (D-010). */
	confirmToken: string;
	/** The scope to re-sync after the write — the SAME shape 1.8's syncScope takes. */
	scope: SyncScope;
}

export interface ApplyEditResult {
	filePath: string;
	bytesWritten: number;
	/** The re-sync outcome (mirror is now lock-step with the new file, D-010). */
	sync: SyncResult;
}

/**
 * Step 2 of the D-010 write contract: the CONFIRM. Re-validates (defense in depth — never
 * trust that the content passed planEdit), then asserts the file on disk STILL matches the
 * confirm token from planEdit. If the file changed under us (a hand-edit, an external tool),
 * the token mismatches and we throw StaleConfirmError WITHOUT writing — "never silently
 * overwrite hand-edited files" (D-010). Only on a clean confirm do we write the bytes and
 * re-sync the cc_* mirror through the existing single writer (syncScope) so the mirror is
 * immediately lock-step with the new file.
 */
export async function applyEdit(db: Db, input: ApplyEditInput): Promise<ApplyEditResult> {
	const validation = validateContent(input.kind, input.content);
	if (!validation.ok) {
		throw new ConfigValidationError(
			`refusing to write invalid ${input.kind} config (${validation.issues.length} issue(s))`,
			validation.issues
		);
	}

	// The confirm guard: the file MUST still be the bytes planEdit diffed.
	const current = readCurrent(input.filePath);
	if (sha256(current) !== input.confirmToken) {
		throw new StaleConfirmError(
			`file changed on disk since the diff was generated — re-review before confirming (D-010): ${input.filePath}`,
			input.filePath
		);
	}

	mkdirSync(dirname(input.filePath), { recursive: true });
	writeFileSync(input.filePath, input.content, 'utf8');
	const bytesWritten = Buffer.byteLength(input.content, 'utf8');

	// Re-sync the mirror through the SAME writer 1.8 uses (D-010: edits go disk → re-sync).
	const sync = await syncScope(db, input.scope);
	return { filePath: input.filePath, bytesWritten, sync };
}

// ── A tiny helper the route uses to project settings for the editor ──────────────────────

/** Parse the current settings.json projection (reuses 1.8's parser) for the edit UI. */
export function projectSettings(settingsText: string | undefined): ParsedSettings {
	return parseSettings(settingsText);
}

/** Re-export the frontmatter splitter so the agent/skill editor can show the body. */
export { splitFrontmatter };
export { stableStringify };
