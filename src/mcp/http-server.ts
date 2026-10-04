import { SecurityInboxService } from '../core/service.js';
import { ProjectDirectoryManager } from '../projects/directory-manager.js';
import { resolveListenHost } from '../web/app.js';
import { startHttpMcpServer } from './http.js';
import { readMcpTokens } from './tokens.js';

// Entry point of the optional HTTP MCP adapter (compose profile "mcp-http"). Tokens are read
// once at start: edit the tokens file and restart the service to add or revoke a client.
try {
  const tokens = readMcpTokens(process.env.SECURITY_INBOX_MCP_TOKENS_FILE);
  const service = new SecurityInboxService();
  const directories = new ProjectDirectoryManager(service, {
    accessibleRoot: process.env.SECURITY_INBOX_PROJECTS_ROOT,
    displayRoot: process.env.SECURITY_INBOX_PROJECTS_DISPLAY_ROOT,
  });
  const running = await startHttpMcpServer({
    service,
    directories,
    tokens,
    host: resolveListenHost(process.env),
    port: Number(process.env.SECURITY_INBOX_MCP_PORT ?? 3301),
  });
  console.log(`Security Inbox MCP over HTTP at ${running.url} (${tokens.size} client token(s))`);
  const shutdown = () => {
    void running.close().finally(() => service.close());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error('Security Inbox HTTP MCP failed to start.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
