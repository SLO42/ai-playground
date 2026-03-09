/**
 * Agent token usage tracking, log parsing, completion logging, and log tailing.
 */
import { readFile, writeFile, unlink } from 'fs/promises';
import { execSync, execFileSync } from 'child_process';
import { resolve } from 'path';
import { PATHS } from '../constants.js';
import {
	MONITOR_SESSION_ID, getActiveAgents, taskSessionId,
	log, trimSession, loadMonitorSession, saveMonitorSession, readSessionIndex, upsertSessionMeta
} from './shared.js';
import type { ChatSession, ChatSender } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

// ── Usage types ──────────────────────────────────────────────────────

export interface AgentUsage {
	taskId: string;
	taskTitle: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
	model: string;
	durationMs: number;
	timestamp: string;
	usedClaudeFlow?: boolean;
	claudeFlowTools?: string[];
}

const USAGE_LOG_PATH = resolve(PATHS.root, '.playground/agent-usage.json');

async function loadUsageLog(): Promise<AgentUsage[]> {
	try {
		const raw = await readFile(USAGE_LOG_PATH, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

async function recordUsage(usage: AgentUsage): Promise<void> {
	try {
		const usageLog = await loadUsageLog();
		usageLog.push(usage);
		const trimmed = usageLog.length > 500 ? usageLog.slice(-500) : usageLog;
		await writeFile(USAGE_LOG_PATH, JSON.stringify(trimmed, null, '\t'), 'utf-8');
	} catch { /* best effort */ }
}

// ── Stream-JSON log parsing ──────────────────────────────────────────

export interface ParsedLog {
	text: string;
	usage: Partial<AgentUsage>;
	mcpTools: string[];
	toolCounts: Record<string, number>;
	usedClaudeFlow: boolean;
}

export async function parseStreamJsonLog(logFile: string): Promise<ParsedLog> {
	const result: ParsedLog = { text: '', usage: {}, mcpTools: [], toolCounts: {}, usedClaudeFlow: false };
	try {
		const raw = await readFile(logFile, 'utf-8');
		const lines = raw.split('\n').filter(l => l.trim());

		for (const line of lines) {
			try {
				const msg = JSON.parse(line);

				if (msg.type === 'assistant' && msg.message?.content) {
					for (const block of msg.message.content) {
						if (block.type === 'text') result.text += block.text;
						if (block.type === 'tool_use' && block.name) {
							const name = block.name as string;
							result.toolCounts[name] = (result.toolCounts[name] ?? 0) + 1;
							if (name.startsWith('mcp__claude-flow__') || name.startsWith('mcp__claude_flow__')) {
								const shortName = name.replace(/^mcp__claude[-_]flow__/, '');
								if (!result.mcpTools.includes(shortName)) {
									result.mcpTools.push(shortName);
								}
								result.usedClaudeFlow = true;
							}
						}
					}
				}

				if (msg.type === 'assistant' && msg.message?.model) {
					result.usage.model = msg.message.model;
				}

				if (msg.type === 'result') {
					if (msg.modelUsage) {
						let totalIn = 0, totalOut = 0;
						const models = Object.keys(msg.modelUsage);
						for (const modelKey of models) {
							const mu = msg.modelUsage[modelKey];
							totalIn += (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
							totalOut += mu.outputTokens ?? 0;
						}
						result.usage.inputTokens = totalIn;
						result.usage.outputTokens = totalOut;
						result.usage.totalTokens = totalIn + totalOut;
						if (models.length > 0 && !result.usage.model) {
							result.usage.model = models.sort((a, b) =>
								(msg.modelUsage[b].outputTokens ?? 0) - (msg.modelUsage[a].outputTokens ?? 0)
							)[0];
						}
					} else if (msg.usage) {
						result.usage.inputTokens = msg.usage.input_tokens ?? msg.usage.inputTokens ?? 0;
						result.usage.outputTokens = msg.usage.output_tokens ?? msg.usage.outputTokens ?? 0;
						result.usage.totalTokens = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
					}
					if (msg.total_cost_usd != null) result.usage.costUsd = msg.total_cost_usd;
					else if (msg.cost_usd != null) result.usage.costUsd = msg.cost_usd;
					else if (msg.costUsd != null) result.usage.costUsd = msg.costUsd;
					if (msg.duration_ms != null) result.usage.durationMs = msg.duration_ms;
					if (msg.durationMs != null) result.usage.durationMs = msg.durationMs;
				}
			} catch { /* skip unparseable lines */ }
		}
	} catch { /* log file missing */ }
	return result;
}

// ── Prompt file cleanup ──────────────────────────────────────────────

const g = globalThis as Record<string, unknown>;
const PROMPT_CLEANUP_INTERVAL = 15 * 60_000;
let lastPromptCleanup = (g.__claw_last_prompt_cleanup as number) ?? 0;

export async function cleanupPromptFiles() {
	const now = Date.now();
	if (now - lastPromptCleanup < PROMPT_CLEANUP_INTERVAL) return;
	lastPromptCleanup = now;
	g.__claw_last_prompt_cleanup = now;

	try {
		const { readdir, stat } = await import('fs/promises');
		const files = await readdir(PATHS.headlessLogsDir);
		for (const file of files) {
			if (!file.startsWith('prompt-') || !file.endsWith('.txt')) continue;
			try {
				const filePath = resolve(PATHS.headlessLogsDir, file);
				const info = await stat(filePath);
				if (now - info.mtimeMs > PROMPT_CLEANUP_INTERVAL) {
					await unlink(filePath).catch(() => {});
				}
			} catch { /* skip */ }
		}
	} catch { /* dir may not exist */ }
}

// ── Failure reason extraction ────────────────────────────────────────

async function extractFailureReason(logFile: string): Promise<string> {
	try {
		const content = await readFile(logFile, 'utf-8');
		const lines = content.split('\n').filter(l => l.trim());
		if (lines.length === 0) return 'no output captured';

		const tail = lines.slice(-20);
		const errorLine = tail.find(l =>
			/error|Error|ERR|failed|FAILED|panic|exception|ENOENT|ENAMETOOLONG|EPERM|denied|not found|timed out|timeout/i.test(l)
		);
		if (errorLine) return errorLine.trim().slice(0, 200);

		const lastLine = tail[tail.length - 1]?.trim();
		return lastLine ? lastLine.slice(0, 200) : 'no output captured';
	} catch {
		return 'log file not found';
	}
}

// ── Git diff stats ───────────────────────────────────────────────────

/** Capture the set of currently modified files — call before spawning an agent. */
export function captureGitBaseline(): Set<string> {
	try {
		const raw = execSync('git diff --name-only', { cwd: PATHS.root, encoding: 'utf-8', timeout: 5000 });
		return new Set(raw.trim().split('\n').filter(Boolean));
	} catch {
		return new Set();
	}
}

/**
 * Get diff stats, optionally filtering out files that were already modified
 * before the agent started (baseline). This ensures we only report changes
 * the agent actually made.
 */
function getGitDiffStats(baseline?: Set<string>): { files: string[]; insertions: number; deletions: number; chars: number } | null {
	try {
		const raw = execSync('git diff --numstat', { cwd: PATHS.root, encoding: 'utf-8', timeout: 5000 });
		if (!raw.trim()) return null;

		const lines = raw.trim().split('\n');
		const files: string[] = [];
		let insertions = 0;
		let deletions = 0;

		for (const line of lines) {
			const parts = line.split('\t');
			if (parts.length >= 3) {
				const filePath = parts[2];
				// Skip files that were already modified before this agent started
				if (baseline && baseline.has(filePath)) continue;
				const added = parseInt(parts[0], 10) || 0;
				const removed = parseInt(parts[1], 10) || 0;
				insertions += added;
				deletions += removed;
				files.push(filePath);
			}
		}

		if (files.length === 0) return null;

		let chars = 0;
		try {
			// Only diff the files this agent changed (use execFileSync to avoid shell injection)
			const diff = execFileSync('git', ['diff', '--', ...files], { cwd: PATHS.root, encoding: 'utf-8', timeout: 10000 }) as string;
			chars = diff.length;
		} catch { /* ignore */ }

		return { files, insertions, deletions, chars };
	} catch {
		return null;
	}
}

// ── Agent summary extraction ─────────────────────────────────────────

function extractAgentSummary(lines: string[]): string {
	if (lines.length === 0) return '';
	const tail = lines.slice(-30);
	const summary = tail
		.map(l => l.trim())
		.filter(l => l.length > 0 && l.length < 300)
		.join('\n');
	return summary.length > 2000 ? summary.slice(0, 2000) + '\n...(truncated)' : summary;
}

// ── Agent completion logging ─────────────────────────────────────────

export async function logAgentCompletion(task: Task, sender: ChatSender, exitMsg: string, logFile: string, targetSessionId?: string, gitBaseline?: Set<string>, opts?: { skipUsageRecord?: boolean }) {
	const sessionId = targetSessionId ?? MONITOR_SESSION_ID;
	let session: ChatSession;

	const isMonitor = sessionId === MONITOR_SESSION_ID;

	const parsed = await parseStreamJsonLog(logFile);
	const usage = parsed.usage;

	let failureReason = '';
	if (!exitMsg.includes('successfully') && !exitMsg.includes('review complete')) {
		if (parsed.text) {
			const errorMatch = parsed.text.match(/(?:error|Error|ERR|failed|FAILED)[^\n]*/);
			failureReason = errorMatch ? errorMatch[0].slice(0, 200) : '';
		}
		if (!failureReason) {
			failureReason = await extractFailureReason(logFile);
		}
	}

	const agentInfo = getActiveAgents().get(task.id);
	const startTime = agentInfo ? new Date(agentInfo.startedAt).getTime() : Date.now();
	const durationMs = usage.durationMs ?? (Date.now() - startTime);
	if (!opts?.skipUsageRecord) await recordUsage({
		taskId: task.id,
		taskTitle: task.title,
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		costUsd: usage.costUsd ?? 0,
		model: usage.model ?? 'unknown',
		durationMs,
		timestamp: new Date().toISOString(),
		usedClaudeFlow: parsed.usedClaudeFlow,
		claudeFlowTools: parsed.mcpTools.length > 0 ? parsed.mcpTools : undefined
	});

	const usageLine = (usage.totalTokens ?? 0) > 0
		? `${((usage.inputTokens ?? 0) / 1000).toFixed(1)}K in / ${((usage.outputTokens ?? 0) / 1000).toFixed(1)}K out` +
		  (usage.costUsd ? ` ($${usage.costUsd.toFixed(4)})` : '') +
		  ` — ${(durationMs / 1000).toFixed(0)}s`
		: '';

	if (isMonitor) {
		session = await loadMonitorSession();
	} else {
		try {
			const raw = await readFile(`${PATHS.chatsDir}/${sessionId}.json`, 'utf-8');
			session = JSON.parse(raw);
		} catch {
			session = await loadMonitorSession();
		}
	}

	const diffStats = getGitDiffStats(gitBaseline);
	const statsLine = diffStats && diffStats.files.length > 0
		? `${diffStats.files.length} file(s) changed, +${diffStats.insertions} -${diffStats.deletions} lines, ~${(diffStats.chars / 1024).toFixed(1)}KB diff`
		: 'no file changes detected';

	if (isMonitor) {
		const reason = failureReason ? ` — ${failureReason}` : '';
		const tokens = usageLine ? ` — ${usageLine}` : '';
		const cf = parsed.usedClaudeFlow ? ` — CF: ${parsed.mcpTools.join(', ')}` : '';
		log(session, `[done] Agent for "${task.title}" — ${exitMsg} — ${statsLine}${tokens}${cf}${reason}`);
	} else {
		const reason = failureReason ? `\n**Reason**: ${failureReason}` : '';
		log(session, `[done] ${exitMsg}${reason}`, sender);

		if (usageLine) {
			log(session, `**Tokens**: ${usageLine}`, sender);
		}

		if (parsed.usedClaudeFlow) {
			log(session, `**Claude Flow**: ${parsed.mcpTools.map(t => `\`${t}\``).join(', ')} (${parsed.mcpTools.length} tool type${parsed.mcpTools.length !== 1 ? 's' : ''})`, sender);
		} else {
			log(session, `**Claude Flow**: not used — agent did not call any MCP tools`, sender);
		}

		if (diffStats && diffStats.files.length > 0) {
			const fileList = diffStats.files.map(f => `- \`${f}\``).join('\n');
			log(session, `**Changes**: ${diffStats.files.length} file(s) | +${diffStats.insertions} -${diffStats.deletions} lines | ~${(diffStats.chars / 1024).toFixed(1)}KB\n${fileList}`, sender);
		} else {
			log(session, `**Changes**: no file changes detected`, sender);
		}

		if (parsed.text) {
			const textLines = parsed.text.split('\n').filter(l => l.trim());
			const summary = extractAgentSummary(textLines);
			if (summary) {
				log(session, `[result] ${summary}`, sender);
			}
		}
	}

	trimSession(session);

	if (sessionId === MONITOR_SESSION_ID) {
		await saveMonitorSession(session);
	} else {
		session.updatedAt = new Date().toISOString();
		session.status = 'idle';
		await writeFile(
			`${PATHS.chatsDir}/${sessionId}.json`,
			JSON.stringify(session, null, '\t'),
			'utf-8'
		);

		try {
			const existingIdx = await readSessionIndex();
			const found = existingIdx.find((s) => s.id === sessionId);
			if (found) {
				await upsertSessionMeta({ ...found, status: 'idle', updatedAt: session.updatedAt, messageCount: session.messages.length });
			}
		} catch { /* index update failed */ }
	}
}

// ── Agent log tailing ────────────────────────────────────────────────

export async function tailAgentLogs(monitorSession: ChatSession) {
	const agents = getActiveAgents();
	if (agents.size === 0) return;

	for (const [, info] of agents) {
		try {
			const content = await readFile(info.logFile, 'utf-8');
			const newContent = content.slice(info.lastLogPos);
			info.lastLogPos = content.length;

			if (newContent.trim().length === 0) continue;

			const rawLines = newContent.split('\n').filter(l => l.trim());
			if (rawLines.length === 0) continue;

			const textChunks: string[] = [];
			for (const line of rawLines) {
				try {
					const msg = JSON.parse(line);
					if (msg.type === 'assistant' && msg.message?.content) {
						for (const block of msg.message.content) {
							if (block.type === 'text' && block.text) textChunks.push(block.text.trim());
						}
					}
				} catch {
					if (line.trim().length > 0 && !line.startsWith('{')) textChunks.push(line.trim());
				}
			}

			if (textChunks.length === 0) continue;
			const lines = textChunks.join('\n').split('\n').filter(l => l.trim());
			if (lines.length === 0) continue;

			let snippet: string;
			if (lines.length <= 3) {
				snippet = lines.map(l => l.trim().slice(0, 120)).join(' | ');
			} else {
				snippet = [
					lines[0].trim().slice(0, 100),
					`... ${lines.length - 2} more lines ...`,
					lines[lines.length - 1].trim().slice(0, 100)
				].join(' | ');
			}

			const targetId = info.reportSessionId !== MONITOR_SESSION_ID
				? info.reportSessionId
				: taskSessionId(info.taskId);
			try {
				const raw = await readFile(`${PATHS.chatsDir}/${targetId}.json`, 'utf-8');
				const reportSession: ChatSession = JSON.parse(raw);
				log(reportSession, `[working] ${snippet}`, info.sender);
				reportSession.updatedAt = new Date().toISOString();
				await writeFile(
					`${PATHS.chatsDir}/${targetId}.json`,
					JSON.stringify(reportSession, null, '\t'),
					'utf-8'
				);
			} catch { /* report session not available */ }
		} catch { /* log file not ready yet */ }
	}
}
