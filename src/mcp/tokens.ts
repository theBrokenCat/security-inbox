import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { userSlugSchema } from '../core/validation.js';

// The HTTP adapter's only secret. One line per client, "<user-slug> <token>", comments with #.
// The token says which user an agent writes as, exactly as SECURITY_INBOX_USER does for the
// stdio adapter: attribution, resolved in the adapter. What it adds is transport access: over
// HTTP anyone on the network could otherwise write to the inbox, so a request without a known
// token is refused before any MCP traffic. Only SHA-256 digests are kept in memory.
export type McpTokens = ReadonlyMap<string, string>;

const minimumTokenLength = 32;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseMcpTokens(text: string): McpTokens {
  const tokens = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [slugText, token, ...rest] = line.split(/\s+/);
    const slug = userSlugSchema.safeParse(slugText);
    if (!slug.success || !token || rest.length > 0) {
      throw new Error(`MCP tokens line ${index + 1}: expected "<user-slug> <token>"`);
    }
    if (token.length < minimumTokenLength) {
      throw new Error(`MCP tokens line ${index + 1}: the token must be at least ${minimumTokenLength} characters`);
    }
    const key = digest(token);
    if (tokens.has(key)) throw new Error(`MCP tokens line ${index + 1}: token already used by another line`);
    tokens.set(key, slug.data);
  });
  if (tokens.size === 0) throw new Error('MCP tokens file has no tokens');
  return tokens;
}

export function readMcpTokens(path: string | undefined): McpTokens {
  if (!path) throw new Error('SECURITY_INBOX_MCP_TOKENS_FILE is required for the HTTP MCP adapter');
  return parseMcpTokens(readFileSync(path, 'utf8'));
}

/** The user slug a bearer token writes as, or undefined when the header carries no known token. */
export function userForAuthorization(tokens: McpTokens, header: string | null): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match ? tokens.get(digest(match[1]!)) : undefined;
}
