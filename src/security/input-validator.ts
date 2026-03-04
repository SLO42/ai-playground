/**
 * Input Validator — CVE-1 Fix
 * Validates and sanitizes user input at system boundaries.
 * Detects prompt injection, XSS, SQL injection, and other injection attacks.
 */

export interface ValidationResult {
  valid: boolean;
  sanitized: string;
  violations: string[];
}

// Patterns that indicate prompt injection attempts
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?prior/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /```\s*(system|assistant)\b/i,
];

// Patterns that indicate XSS attempts
const XSS_PATTERNS: RegExp[] = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on(load|error|click|mouseover|focus|blur)\s*=/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /data\s*:\s*text\/html/i,
  /expression\s*\(/i,
  /url\s*\(\s*['"]?\s*javascript/i,
];

// Patterns that indicate SQL injection attempts
const SQL_INJECTION_PATTERNS: RegExp[] = [
  /(\b(union|select|insert|update|delete|drop|alter|create|exec|execute)\b\s+(all\s+)?)/i,
  /'\s*(or|and)\s+'?\d*'?\s*=\s*'?\d*'?/i,
  /;\s*(drop|delete|update|insert|alter)\s+/i,
  /--\s*$/m,
  /\/\*[\s\S]*?\*\//,
];

// Patterns for command injection (shell metacharacters in input)
const COMMAND_INJECTION_PATTERNS: RegExp[] = [
  /;\s*(rm|del|format|shutdown|reboot|curl|wget|nc|netcat)\b/i,
  /\$\(.*\)/,
  /`[^`]+`/,
  /\|\s*(sh|bash|cmd|powershell|pwsh)\b/i,
  />\s*\/etc\//,
  /&&\s*(rm|del|curl|wget)\b/i,
];

/**
 * Validate user input against common injection attacks.
 * Returns sanitized text and a list of violations found.
 */
export function validateInput(input: string): ValidationResult {
  const violations: string[] = [];

  if (typeof input !== 'string') {
    return { valid: false, sanitized: '', violations: ['Input must be a string'] };
  }

  // Check length — reject absurdly long inputs
  if (input.length > 100_000) {
    return { valid: false, sanitized: '', violations: ['Input exceeds maximum length (100KB)'] };
  }

  // Detect prompt injection
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      violations.push(`Prompt injection detected: ${pattern.source}`);
    }
  }

  // Detect XSS
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(input)) {
      violations.push(`XSS pattern detected: ${pattern.source}`);
    }
  }

  // Detect SQL injection
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      violations.push(`SQL injection pattern detected: ${pattern.source}`);
    }
  }

  // Detect command injection
  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      violations.push(`Command injection pattern detected: ${pattern.source}`);
    }
  }

  // Sanitize: strip HTML tags, null bytes, and control characters (keep newlines/tabs)
  let sanitized = input
    .replace(/\0/g, '')                              // null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '')  // control chars (preserve \n \r \t)
    .replace(/<\/?script[^>]*>/gi, '')                // script tags
    .replace(/<\/?iframe[^>]*>/gi, '')                // iframe tags
    .replace(/<\/?object[^>]*>/gi, '')                // object tags
    .replace(/<\/?embed[^>]*>/gi, '');                // embed tags

  return {
    valid: violations.length === 0,
    sanitized,
    violations,
  };
}

/**
 * Validate and sanitize a chat message specifically.
 * More permissive than general input validation — allows code blocks
 * but still blocks injection attacks.
 */
export function validateChatMessage(message: string): ValidationResult {
  const result = validateInput(message);

  // Additional chat-specific check: message length for chat platforms
  if (message.length > 4096) {
    result.violations.push('Chat message exceeds 4096 character limit');
    result.valid = false;
  }

  return result;
}

/**
 * Sanitize a string for safe display in HTML context.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
