import { AppError } from './errors.js';

// The inbox has no authentication and every reader sees every finding, so a credential pasted
// into a report is a leak to everyone on the network. Findings are rejected rather than masked:
// a silent rewrite would change what the author meant and hide that the secret was exposed.
// The patterns favour precision over recall; prose such as "the password field is not
// validated" must keep working.
const secretPatterns: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { kind: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'API key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];

const placeholder = /^(?:\*+|x{3,}|<[^>]*>|\[[^\]]*\]|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_]+%|process\.env\.\w+|env\.\w+|changeme|redacted|example\w*|placeholder|dummy|secret|password|your[-_]\w*|\.{3,}|…)$/i;

// "user:password@host" inside a URL.
const urlCredentials = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi;
// "password = value", "DB_PASSWORD=value" or "api_key: value"; only letters bound the name, so
// SCREAMING_SNAKE variables match. The value must look like a value, not a word in prose.
const assignment = /(?<![A-Za-z])(?:password|passwd|pwd|secret|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|private[-_]?key)(?![A-Za-z])["']?\s*[:=]\s*["']?([^\s"',;)]{8,})/gi;

function hasRealValue(expression: RegExp, text: string): boolean {
  for (const match of text.matchAll(expression)) {
    const value = (match[1] ?? '').replace(/["'`]+$/, '');
    if (value && !placeholder.test(value)) return true;
  }
  return false;
}

/** Names the kinds of secret found in the text; empty when nothing looks like a credential. */
export function detectSecrets(text: string): string[] {
  const kinds = secretPatterns.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind);
  if (hasRealValue(urlCredentials, text)) kinds.push('credentials in a URL');
  if (hasRealValue(assignment, text)) kinds.push('password or key assignment');
  return kinds;
}

/** Throws SECRET_DETECTED naming each field and kind, never echoing the value itself. */
export function assertNoSecrets(fields: Record<string, unknown>): void {
  const fieldErrors: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value === '') continue;
    const kinds = detectSecrets(value);
    if (kinds.length > 0) {
      fieldErrors[field] = kinds.map((kind) => `Looks like a ${kind}; remove or redact it`);
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError('SECRET_DETECTED', 'Input looks like it contains a secret', fieldErrors);
  }
}
