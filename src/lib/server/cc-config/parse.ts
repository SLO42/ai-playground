// TASK 1.8 — Claude Code config parsing (read-only, D-010; depends on: 0.c).
//
// PURE parsers + a content digest for the config-sync service. Claude Code reads
// its config from DISK — `.claude/settings.json` (hooks, permissions, env,
// enabled plugins, mcpServers), `.claude/agents/*.md` (YAML frontmatter),
// `.claude/skills/*/SKILL.md` (YAML frontmatter), and `.mcp.json` (mcpServers) —
// plus the global `~/.claude`. The FILESYSTEM is authoritative (D-010); these
// functions only READ + parse it into the shapes the `cc_*` mirror tables store.
//
// No DB, no spawn, no network here — just deterministic parse + hash so sync.ts
// can upsert the mirror and detect drift. Permissive: malformed/partial files
// degrade to empty results rather than throwing, so one bad file never blocks the
// catalog (the dashboard still shows everything that DID parse).

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

// ── Parsed shapes (mirror the cc_* tables, DATA-MODEL §4.10) ────────────────────

/** A hook entry flattened from settings.json `hooks.<Event>[].hooks[]` (cc_hook). */
export interface ParsedHook {
	event: string; // PreToolUse | PostToolUse | SessionStart | ...
	matcher?: string; // tool/event matcher, when present
	command: string; // the hook command line
	timeout?: number; // per-hook timeout (seconds), when present
}

/** An MCP server entry from `.mcp.json` / settings `mcpServers` (cc_mcp_server). */
export interface ParsedMcpServer {
	name: string;
	type: 'stdio' | 'http' | 'sse';
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, string>;
}

/** The settings.json projection the mirror stores (cc_settings). */
export interface ParsedSettings {
	permissions?: Record<string, unknown>; // allow / deny / ask
	env?: Record<string, unknown>;
	enabledPlugins?: Record<string, unknown>;
	hooks: ParsedHook[];
	mcpServers: ParsedMcpServer[];
	/** The full parsed JSON, preserved verbatim for round-trip (cc_settings.raw). */
	raw: Record<string, unknown>;
}

/** A parsed agent file `.claude/agents/*.md` (cc_agent). */
export interface ParsedAgent {
	file_path: string;
	name: string;
	description?: string;
	frontmatter: Record<string, unknown>;
	category?: string;
}

/** A parsed skill file under `.claude/skills/<name>/SKILL.md` (cc_skill). */
export interface ParsedSkill {
	file_path: string;
	name: string;
	description?: string;
	plugin?: string;
}

// ── Low-level helpers ───────────────────────────────────────────────────────────

/** Read a file as UTF-8, or undefined if it does not exist / is unreadable. */
function readMaybe(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

/** Parse JSON permissively into an object, or an empty object on any failure (never throws). */
function parseJsonObject(text: string | undefined): Record<string, unknown> {
	if (text === undefined) return {};
	try {
		const v = JSON.parse(text);
		return v !== null && typeof v === 'object' && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function asObject(v: unknown): Record<string, unknown> | undefined {
	return v !== null && typeof v === 'object' && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}

function asStringArray(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.filter((x): x is string => typeof x === 'string');
	return out.length ? out : undefined;
}

// ── settings.json ───────────────────────────────────────────────────────────────

/**
 * Flatten Claude Code's `hooks` block — shaped, per event, as an array of groups
 * each carrying an optional matcher and an inner hooks[] of { type, command,
 * timeout? } — into the flat cc_hook rows the mirror stores. Unknown shapes are skipped, not
 * errored (one malformed group never drops the rest).
 */
export function flattenHooks(hooksBlock: unknown): ParsedHook[] {
	const block = asObject(hooksBlock);
	if (!block) return [];
	const out: ParsedHook[] = [];
	for (const [event, groupsRaw] of Object.entries(block)) {
		if (!Array.isArray(groupsRaw)) continue;
		for (const groupRaw of groupsRaw) {
			const group = asObject(groupRaw);
			if (!group) continue;
			const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;
			const inner = Array.isArray(group.hooks) ? group.hooks : [];
			for (const hookRaw of inner) {
				const hook = asObject(hookRaw);
				if (!hook || typeof hook.command !== 'string') continue;
				out.push({
					event,
					...(matcher ? { matcher } : {}),
					command: hook.command,
					...(typeof hook.timeout === 'number' ? { timeout: hook.timeout } : {})
				});
			}
		}
	}
	return out;
}

/**
 * Parse an `mcpServers` map → cc_mcp_server rows. The transport `type` is inferred
 * when absent: a `command` implies stdio, a `url` implies http (Claude Code's
 * default). Entries with neither are skipped.
 */
export function parseMcpServers(mcpBlock: unknown): ParsedMcpServer[] {
	const block = asObject(mcpBlock);
	if (!block) return [];
	const out: ParsedMcpServer[] = [];
	for (const [name, entryRaw] of Object.entries(block)) {
		const entry = asObject(entryRaw);
		if (!entry) continue;
		const command = typeof entry.command === 'string' ? entry.command : undefined;
		const url = typeof entry.url === 'string' ? entry.url : undefined;
		let type: ParsedMcpServer['type'] | undefined;
		const declared = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
		if (declared === 'stdio' || declared === 'http' || declared === 'sse') {
			type = declared;
		} else if (command) {
			type = 'stdio';
		} else if (url) {
			type = 'http';
		}
		if (!type) continue; // neither command nor url nor a known type → not a server
		out.push({
			name,
			type,
			...(command ? { command } : {}),
			...(asStringArray(entry.args) ? { args: asStringArray(entry.args) } : {}),
			...(url ? { url } : {}),
			...(asObject(entry.env) ? { env: asObject(entry.env) as Record<string, string> } : {})
		});
	}
	return out;
}

/**
 * Parse a `settings.json` text + an optional `.mcp.json` text into the cc_settings
 * projection. `.mcp.json` servers and settings `mcpServers` are merged (settings
 * win on a name clash — they are the more specific scope). `raw` keeps the full
 * settings JSON verbatim for round-trip (the sync contract preserves unknown keys).
 */
export function parseSettings(
	settingsText: string | undefined,
	mcpJsonText?: string | undefined
): ParsedSettings {
	const raw = parseJsonObject(settingsText);
	const mcpJson = parseJsonObject(mcpJsonText);

	const fromMcpJson = parseMcpServers(mcpJson.mcpServers ?? mcpJson);
	const fromSettings = parseMcpServers(raw.mcpServers);
	const byName = new Map<string, ParsedMcpServer>();
	for (const s of fromMcpJson) byName.set(s.name, s);
	for (const s of fromSettings) byName.set(s.name, s); // settings override .mcp.json

	return {
		...(asObject(raw.permissions) ? { permissions: asObject(raw.permissions) } : {}),
		...(asObject(raw.env) ? { env: asObject(raw.env) } : {}),
		...(asObject(raw.enabledPlugins)
			? { enabledPlugins: asObject(raw.enabledPlugins) }
			: {}),
		hooks: flattenHooks(raw.hooks),
		mcpServers: [...byName.values()],
		raw
	};
}

// ── YAML frontmatter (agents + skills) ──────────────────────────────────────────

/** Split a markdown file's `---`-fenced YAML frontmatter from its body. */
export function splitFrontmatter(text: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	// Tolerate a leading BOM / blank lines before the opening fence.
	const m = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) return { frontmatter: {}, body: text };
	let fm: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(m[1]);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			fm = parsed as Record<string, unknown>;
		}
	} catch {
		fm = {};
	}
	return { frontmatter: fm, body: m[2] ?? '' };
}

/** Parse one agent `.md` file into a cc_agent projection. */
export function parseAgentFile(filePath: string, text: string): ParsedAgent {
	const { frontmatter } = splitFrontmatter(text);
	const name =
		typeof frontmatter.name === 'string' && frontmatter.name.trim()
			? frontmatter.name.trim()
			: basename(filePath).replace(/\.md$/i, '');
	return {
		file_path: filePath,
		name,
		...(typeof frontmatter.description === 'string'
			? { description: frontmatter.description }
			: {}),
		frontmatter,
		...(typeof frontmatter.category === 'string' ? { category: frontmatter.category } : {})
	};
}

/** Parse one `SKILL.md` file into a cc_skill projection. */
export function parseSkillFile(
	filePath: string,
	text: string,
	plugin?: string
): ParsedSkill {
	const { frontmatter } = splitFrontmatter(text);
	const name =
		typeof frontmatter.name === 'string' && frontmatter.name.trim()
			? frontmatter.name.trim()
			: basename(join(filePath, '..')); // the skill's directory name
	return {
		file_path: filePath,
		name,
		...(typeof frontmatter.description === 'string'
			? { description: frontmatter.description }
			: {}),
		...(plugin ? { plugin } : {})
	};
}

// ── Directory scans (the filesystem edge) ───────────────────────────────────────

/** List `.claude/agents/*.md`, parsed. Missing dir → []. */
export function scanAgents(claudeDir: string): ParsedAgent[] {
	const dir = join(claudeDir, 'agents');
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: ParsedAgent[] = [];
	for (const e of entries) {
		if (!e.toLowerCase().endsWith('.md')) continue;
		const filePath = join(dir, e);
		const text = readMaybe(filePath);
		if (text === undefined) continue;
		out.push(parseAgentFile(filePath, text));
	}
	return out;
}

/** List `.claude/skills/<name>/SKILL.md`, parsed. Missing dir → []. */
export function scanSkills(claudeDir: string): ParsedSkill[] {
	const dir = join(claudeDir, 'skills');
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: ParsedSkill[] = [];
	for (const e of entries) {
		const skillDir = join(dir, e);
		try {
			if (!statSync(skillDir).isDirectory()) continue;
		} catch {
			continue;
		}
		const filePath = join(skillDir, 'SKILL.md');
		const text = readMaybe(filePath);
		if (text === undefined) continue;
		out.push(parseSkillFile(filePath, text));
	}
	return out;
}

// ── Disk read (one scope) + content digest (drift detection) ─────────────────────

/** Everything parsed from one `.claude` scope on disk — the sync input. */
export interface ScopeContent {
	settings: ParsedSettings;
	agents: ParsedAgent[];
	skills: ParsedSkill[];
}

/**
 * Read + parse a whole scope from disk: `<claudeDir>/settings.json`, the sibling
 * `.mcp.json` (next to `.claude`, the project root), agents, and skills. Pure read
 * (no DB). `mcpJsonPath` defaults to `<claudeDir>/../.mcp.json` (project layout);
 * the global scope passes no `.mcp.json`.
 */
export function readScope(claudeDir: string, mcpJsonPath?: string): ScopeContent {
	const settingsText = readMaybe(join(claudeDir, 'settings.json'));
	const mcpText = mcpJsonPath ? readMaybe(mcpJsonPath) : readMaybe(join(claudeDir, '..', '.mcp.json'));
	return {
		settings: parseSettings(settingsText, mcpText),
		agents: scanAgents(claudeDir),
		skills: scanSkills(claudeDir)
	};
}

/**
 * A stable content digest of a parsed scope. The mirror's drift check compares the
 * CURRENT disk digest against the digest stored at last sync: equal ⇒ "synced",
 * different ⇒ "out_of_sync (edited on disk)". Computed over the parsed projection
 * (not raw bytes) so cosmetic whitespace/key-order changes don't show false drift,
 * while any meaningful config change does. Deterministic via sorted JSON.
 */
export function digestScope(content: ScopeContent): string {
	const stable = stableStringify({
		settings: {
			permissions: content.settings.permissions ?? null,
			env: content.settings.env ?? null,
			enabledPlugins: content.settings.enabledPlugins ?? null,
			hooks: content.settings.hooks,
			mcpServers: content.settings.mcpServers
		},
		agents: content.agents.map((a) => ({
			file_path: a.file_path,
			name: a.name,
			description: a.description ?? null,
			frontmatter: a.frontmatter,
			category: a.category ?? null
		})),
		skills: content.skills.map((s) => ({
			file_path: s.file_path,
			name: s.name,
			description: s.description ?? null,
			plugin: s.plugin ?? null
		}))
	});
	return createHash('sha256').update(stable).digest('hex');
}

/** Deterministic JSON with recursively sorted object keys (stable across runs). */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v !== null && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as Record<string, unknown>).sort()) {
			out[k] = sortKeys((v as Record<string, unknown>)[k]);
		}
		return out;
	}
	return v;
}
