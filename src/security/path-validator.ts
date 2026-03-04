/**
 * Path Validator — CVE-2 Fix
 * Prevents directory traversal attacks by validating and sanitizing file paths.
 * Ensures all file access stays within allowed boundaries.
 */

import * as path from 'path';

export interface PathValidationResult {
  valid: boolean;
  resolved: string;
  violations: string[];
}

// Patterns that indicate path traversal attempts
const TRAVERSAL_PATTERNS: RegExp[] = [
  /\.\.\//,            // ../
  /\.\.\\/,            // ..\
  /%2e%2e/i,           // URL-encoded ..
  /%2e%2e%2f/i,        // URL-encoded ../
  /%2e%2e%5c/i,        // URL-encoded ..\
  /\.\.%2f/i,          // mixed encoding
  /\.\.%5c/i,          // mixed encoding
  /%252e%252e/i,       // double URL-encoded
];

// Dangerous system paths that should never be accessed
const FORBIDDEN_PATHS: string[] = [
  '/etc/passwd',
  '/etc/shadow',
  '/etc/hosts',
  '/proc/',
  '/sys/',
  '/dev/',
  'C:\\Windows\\System32',
  'C:\\Windows\\system.ini',
];

// Sensitive file patterns
const SENSITIVE_PATTERNS: RegExp[] = [
  /\.env(\.[a-z]+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials\.json$/i,
  /\.netrc$/i,
  /\.ssh\//i,
  /\.gnupg\//i,
];

/**
 * Allowed root directories for file access.
 * All resolved paths must fall within one of these.
 */
const DEFAULT_ALLOWED_ROOTS = [
  './src',
  './config',
  './.claude-flow',
  './.claude',
  './.swarm',
  './docs',
  './tests',
  './scripts',
  './examples',
];

/**
 * Validate a file path to prevent directory traversal.
 *
 * @param inputPath — The path to validate (user-supplied)
 * @param allowedRoots — Allowed root directories (default from network-policy.yaml)
 * @param projectRoot — The project root directory (default: cwd)
 */
export function validatePath(
  inputPath: string,
  allowedRoots: string[] = DEFAULT_ALLOWED_ROOTS,
  projectRoot: string = process.cwd(),
): PathValidationResult {
  const violations: string[] = [];

  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    return { valid: false, resolved: '', violations: ['Path must be a non-empty string'] };
  }

  // Check for traversal patterns in the raw input (before resolution)
  for (const pattern of TRAVERSAL_PATTERNS) {
    if (pattern.test(inputPath)) {
      violations.push(`Path traversal pattern detected: ${pattern.source}`);
    }
  }

  // Check for null bytes (used to truncate paths in some languages/runtimes)
  if (inputPath.includes('\0')) {
    violations.push('Null byte detected in path');
    return { valid: false, resolved: '', violations };
  }

  // Resolve to absolute path
  const resolved = path.resolve(projectRoot, inputPath);
  const normalizedRoot = path.resolve(projectRoot);

  // Ensure resolved path stays within project root
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    violations.push(`Path escapes project root: ${resolved}`);
  }

  // Check against allowed roots (if the path is within project, check it's in an allowed subdir)
  if (violations.length === 0 && allowedRoots.length > 0) {
    const relPath = path.relative(normalizedRoot, resolved);
    const inAllowed = allowedRoots.some(root => {
      const normalizedAllowed = path.normalize(root).replace(/^\.[\\/]/, '');
      return relPath.startsWith(normalizedAllowed);
    });

    if (!inAllowed) {
      violations.push(`Path not in allowed directories: ${relPath}`);
    }
  }

  // Check forbidden system paths
  for (const forbidden of FORBIDDEN_PATHS) {
    if (resolved.toLowerCase().includes(forbidden.toLowerCase())) {
      violations.push(`Access to system path forbidden: ${forbidden}`);
    }
  }

  // Check for sensitive file patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(resolved)) {
      violations.push(`Access to sensitive file blocked: ${pattern.source}`);
    }
  }

  return {
    valid: violations.length === 0,
    resolved,
    violations,
  };
}

/**
 * Sanitize a filename — strip directory components and dangerous characters.
 * Useful for user-uploaded filenames.
 */
export function sanitizeFilename(filename: string): string {
  return path.basename(filename)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // Replace forbidden chars
    .replace(/^\.+/, '_')                       // Don't start with dots
    .slice(0, 255);                             // Max filename length
}
