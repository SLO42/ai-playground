/**
 * Safe Executor — CVE-3 Fix
 * Executes shell commands safely without shell interpolation.
 * Uses execFileSync (no shell) with an explicit allowlist of commands.
 */

import { execFileSync, type ExecFileSyncOptions } from 'child_process';

export interface ExecutionResult {
  stdout: string;
  allowed: boolean;
  command: string;
  violations: string[];
}

/**
 * Commands allowed to be executed.
 * Any command not in this list is rejected.
 */
const ALLOWED_COMMANDS: Set<string> = new Set([
  'git',
  'npm',
  'npx',
  'node',
  'gh',
  'ollama',
  'uvx',
  'python',
  'python3',
  'pip',
  'pip3',
  'tsc',
  'eslint',
  'prettier',
]);

/**
 * Commands that are always blocked regardless of context.
 */
const BLOCKED_COMMANDS: Set<string> = new Set([
  'rm',
  'del',
  'rmdir',
  'format',
  'shutdown',
  'reboot',
  'mkfs',
  'dd',
  'fdisk',
  'kill',
  'killall',
  'pkill',
  'taskkill',
  'reg',
  'regedit',
  'net',
  'netsh',
  'sc',
  'wmic',
  'powershell',
  'pwsh',
  'cmd',
]);

/**
 * Dangerous argument patterns that should be blocked in any command.
 */
const DANGEROUS_ARG_PATTERNS: RegExp[] = [
  /^--delete-all$/i,
  /^--force-delete$/i,
  /^-rf$/,
  /^--no-preserve-root$/,
  /^\/s\s*\/q$/i,                // Windows recursive delete flags
  /^\|/,                          // Pipe character as argument start
  /^;/,                           // Command separator
  /^`/,                           // Backtick execution
  /^\$\(/,                        // Command substitution
];

/**
 * Execute a command safely — no shell interpolation, allowlisted commands only.
 *
 * @param command — The command to execute (must be in ALLOWED_COMMANDS)
 * @param args — Array of arguments (NOT a string — prevents injection)
 * @param options — execFileSync options (cwd, timeout, etc.)
 */
export function safeExec(
  command: string,
  args: string[],
  options: ExecFileSyncOptions = {},
): ExecutionResult {
  const violations: string[] = [];

  // Validate command is in allowlist
  const basename = command.split(/[\\/]/).pop() || command;
  if (BLOCKED_COMMANDS.has(basename.toLowerCase())) {
    return {
      stdout: '',
      allowed: false,
      command: basename,
      violations: [`Command is blocked: ${basename}`],
    };
  }

  if (!ALLOWED_COMMANDS.has(basename.toLowerCase())) {
    return {
      stdout: '',
      allowed: false,
      command: basename,
      violations: [`Command not in allowlist: ${basename}`],
    };
  }

  // Validate arguments — check for shell metacharacters
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      violations.push(`Argument ${i} must be a string`);
      continue;
    }

    // Check for null bytes
    if (arg.includes('\0')) {
      violations.push(`Argument ${i} contains null byte`);
    }

    // Check against dangerous patterns
    for (const pattern of DANGEROUS_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        violations.push(`Argument ${i} matches dangerous pattern: ${pattern.source}`);
      }
    }
  }

  if (violations.length > 0) {
    return { stdout: '', allowed: false, command: basename, violations };
  }

  // Execute using execFileSync — NO shell, args are passed as array
  // This is immune to shell injection because there's no shell to interpret metacharacters
  const execOptions: ExecFileSyncOptions = {
    encoding: 'utf-8' as BufferEncoding,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    ...options,
    shell: false, // CRITICAL: never use shell
  };

  try {
    const stdout = execFileSync(command, args, execOptions);
    return {
      stdout: typeof stdout === 'string' ? stdout : stdout?.toString() ?? '',
      allowed: true,
      command: basename,
      violations: [],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      stdout: '',
      allowed: true,
      command: basename,
      violations: [`Execution failed: ${msg}`],
    };
  }
}

/**
 * Check if a command string would be allowed (dry run, no execution).
 */
export function isAllowed(command: string): boolean {
  const basename = command.split(/[\\/]/).pop() || command;
  return ALLOWED_COMMANDS.has(basename.toLowerCase()) &&
         !BLOCKED_COMMANDS.has(basename.toLowerCase());
}
