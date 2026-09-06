import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { SecurityInboxService } from '../core/service.js';
import { ProjectDirectoryManager } from '../projects/directory-manager.js';
import { createSecurityInboxMcpServer } from './factory.js';

function buildServer() {
  const service = new SecurityInboxService();
  const directories = new ProjectDirectoryManager(service, {
    accessibleRoot: process.env.SECURITY_INBOX_PROJECTS_ROOT,
    displayRoot: process.env.SECURITY_INBOX_PROJECTS_DISPLAY_ROOT,
  });
  const server = createSecurityInboxMcpServer(service, directories, {
    userSlug: process.env.SECURITY_INBOX_USER,
  });
  server.server.onclose = () => { service.close(); };
  return server;
}

// stdout stays reserved for the protocol, so the reason goes to stderr where a client shows it.
function reportFailure(error?: unknown) {
  process.stderr.write('Security Inbox MCP failed to start.\n');
  if (error !== undefined) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}

try {
  const handle = serveStdio(() => buildServer(), { onerror: reportFailure });
  const shutdown = () => { void handle.close().catch(reportFailure); };
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  reportFailure(error);
}
