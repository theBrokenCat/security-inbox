import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { SecurityInboxService } from '../core/service.js';
import { createSecurityInboxMcpServer } from './factory.js';

function buildServer() {
  const service = new SecurityInboxService();
  const server = createSecurityInboxMcpServer(service);
  server.server.onclose = () => { service.close(); };
  return server;
}

function reportFailure() {
  process.stderr.write('Security Inbox MCP failed to start.\n');
  process.exitCode = 1;
}

try {
  const handle = serveStdio(() => buildServer(), { onerror: reportFailure });
  const shutdown = () => { void handle.close().catch(reportFailure); };
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  reportFailure();
}
