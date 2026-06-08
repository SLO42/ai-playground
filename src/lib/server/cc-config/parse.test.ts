import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	digestScope,
	flattenHooks,
	parseAgentFile,
	parseMcpServers,
	parseSettings,
	parseSkillFile,
	readScope,
	scanAgents,
	scanSkills,
	splitFrontmatter
} from './parse';

// TASK 1.8 VERIFY (D-010, DATA-MODEL §4.10): the config PARSERS turn the real
// on-disk shapes — settings.json (hooks/permissions/env/plugins/mcp), agent .md
// frontmatter, SKILL.md frontmatter, .mcp.json — into the cc_* projections the
// mirror stores. Pure functions; these inputs are fixtures (F-008 forbids fake
// RUNTIME data — fixtures are test inputs, never shipped).

describe('flattenHooks (cc_hook)', () => {
	it('flattens the Claude Code hooks block into flat rows', () => {
		const block = {
			PreToolUse: [
				{
					matcher: 'Bash',
					hooks: [{ type: 'command', command: 'guard.sh', timeout: 10 }]
				}
			],
			SessionStart: [{ hooks: [{ type: 'command', command: 'inject.sh' }] }]
		};
		const hooks = flattenHooks(block);
		expect(hooks).toEqual([
			{ event: 'PreToolUse', matcher: 'Bash', command: 'guard.sh', timeout: 10 },
			{ event: 'SessionStart', command: 'inject.sh' }
		]);
	});

	it('is permissive: non-object / missing → empty', () => {
		expect(flattenHooks(undefined)).toEqual([]);
		expect(flattenHooks('nope')).toEqual([]);
		expect(flattenHooks({ PreToolUse: 'bad' })).toEqual([]);
	});
});

describe('parseMcpServers (cc_mcp_server)', () => {
	it('infers stdio from command and http from url; honors declared type', () => {
		const servers = parseMcpServers({
			fs: { command: 'npx', args: ['-y', 'mcp-fs'] },
			web: { url: 'http://127.0.0.1:9000' },
			stream: { type: 'sse', url: 'http://127.0.0.1:9001/sse' }
		});
		expect(servers).toContainEqual({
			name: 'fs',
			type: 'stdio',
			command: 'npx',
			args: ['-y', 'mcp-fs']
		});
		expect(servers).toContainEqual({ name: 'web', type: 'http', url: 'http://127.0.0.1:9000' });
		expect(servers).toContainEqual({
			name: 'stream',
			type: 'sse',
			url: 'http://127.0.0.1:9001/sse'
		});
	});

	it('skips entries with neither command, url, nor known type', () => {
		expect(parseMcpServers({ junk: { foo: 'bar' } })).toEqual([]);
	});
});

describe('parseSettings (cc_settings)', () => {
	it('projects permissions/env/plugins/hooks and merges .mcp.json + settings mcp', () => {
		const settings = JSON.stringify({
			permissions: { allow: ['Bash'], deny: ['mcp__x__*'] },
			env: { FOO: '1' },
			enabledPlugins: { 'my-plugin': true },
			hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'g.sh' }] }] },
			mcpServers: { local: { command: 'node', args: ['s.js'] } }
		});
		const mcpJson = JSON.stringify({
			mcpServers: { remote: { url: 'http://127.0.0.1:1' }, local: { url: 'http://override' } }
		});
		const p = parseSettings(settings, mcpJson);
		expect(p.permissions).toEqual({ allow: ['Bash'], deny: ['mcp__x__*'] });
		expect(p.env).toEqual({ FOO: '1' });
		expect(p.enabledPlugins).toEqual({ 'my-plugin': true });
		expect(p.hooks).toHaveLength(1);
		// settings mcpServers override .mcp.json on name clash ("local").
		const local = p.mcpServers.find((m) => m.name === 'local');
		expect(local).toEqual({ name: 'local', type: 'stdio', command: 'node', args: ['s.js'] });
		expect(p.mcpServers.find((m) => m.name === 'remote')?.type).toBe('http');
		// raw preserves the full settings JSON for round-trip.
		expect(p.raw.permissions).toBeDefined();
	});

	it('degrades to empty on malformed JSON (never throws)', () => {
		const p = parseSettings('{ not json', '{ also bad');
		expect(p.hooks).toEqual([]);
		expect(p.mcpServers).toEqual([]);
		expect(p.raw).toEqual({});
	});
});

describe('frontmatter (cc_agent / cc_skill)', () => {
	it('splits YAML frontmatter from the body', () => {
		const { frontmatter, body } = splitFrontmatter(
			'---\nname: my-agent\ndescription: does things\n---\nBody text here.\n'
		);
		expect(frontmatter).toEqual({ name: 'my-agent', description: 'does things' });
		expect(body.trim()).toBe('Body text here.');
	});

	it('parses an agent file; falls back to filename when no name', () => {
		const a = parseAgentFile(
			'/x/agents/coder.md',
			'---\ndescription: writes code\ncategory: dev\n---\nbody'
		);
		expect(a.name).toBe('coder');
		expect(a.description).toBe('writes code');
		expect(a.category).toBe('dev');
	});

	it('parses a SKILL.md; falls back to directory name when no name', () => {
		const k = parseSkillFile('/x/skills/my-skill/SKILL.md', '---\ndescription: a skill\n---\n');
		expect(k.name).toBe('my-skill');
		expect(k.description).toBe('a skill');
	});

	it('no frontmatter → empty frontmatter, full body', () => {
		const { frontmatter, body } = splitFrontmatter('# Just markdown\n');
		expect(frontmatter).toEqual({});
		expect(body).toContain('Just markdown');
	});
});

describe('readScope + digestScope (filesystem edge + drift digest)', () => {
	let root: string;
	let claudeDir: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'cc-parse-'));
		claudeDir = join(root, '.claude');
		mkdirSync(join(claudeDir, 'agents'), { recursive: true });
		mkdirSync(join(claudeDir, 'skills', 'alpha'), { recursive: true });
		writeFileSync(
			join(claudeDir, 'settings.json'),
			JSON.stringify({
				permissions: { allow: ['Bash'] },
				hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'g.sh' }] }] }
			})
		);
		writeFileSync(
			join(root, '.mcp.json'),
			JSON.stringify({ mcpServers: { srv: { command: 'node' } } })
		);
		writeFileSync(join(claudeDir, 'agents', 'a.md'), '---\nname: a\ndescription: d\n---\n');
		writeFileSync(
			join(claudeDir, 'skills', 'alpha', 'SKILL.md'),
			'---\nname: alpha\ndescription: sk\n---\n'
		);
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('reads settings + sibling .mcp.json + agents + skills', () => {
		const content = readScope(claudeDir);
		expect(content.settings.hooks).toHaveLength(1);
		expect(content.settings.mcpServers.find((m) => m.name === 'srv')).toBeDefined();
		expect(scanAgents(claudeDir).map((a) => a.name)).toContain('a');
		expect(scanSkills(claudeDir).map((s) => s.name)).toContain('alpha');
	});

	it('digest is stable for identical content and changes when content changes', () => {
		const d1 = digestScope(readScope(claudeDir));
		const d2 = digestScope(readScope(claudeDir));
		expect(d1).toBe(d2);
		writeFileSync(
			join(claudeDir, 'settings.json'),
			JSON.stringify({ permissions: { allow: ['Bash', 'Read'] } })
		);
		const d3 = digestScope(readScope(claudeDir));
		expect(d3).not.toBe(d1);
	});
});
