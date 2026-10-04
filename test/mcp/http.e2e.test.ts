import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import { startHttpMcpServer, type RunningHttpMcp } from '../../src/mcp/http.js';
import { parseMcpTokens } from '../../src/mcp/tokens.js';
import { ProjectDirectoryManager } from '../../src/projects/directory-manager.js';

// Tokens are generated per run: nothing secret-looking lives in the repository.
const guzmanToken = `g-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const arturoToken = `a-${crypto.randomUUID()}-${crypto.randomUUID()}`;

let directory: string;
let service: SecurityInboxService;
let running: RunningHttpMcp;

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'http-e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'security-inbox-http-'));
  mkdirSync(join(directory, 'projects'));
  service = new SecurityInboxService(join(directory, 'inbox.sqlite'));
  service.registerUser({ slug: 'guzman' });
  service.registerUser({ slug: 'arturo' });
  running = await startHttpMcpServer({
    service,
    directories: new ProjectDirectoryManager(service, { accessibleRoot: join(directory, 'projects') }),
    tokens: parseMcpTokens(`# clients\nguzman ${guzmanToken}\narturo ${arturoToken}\n`),
    host: '127.0.0.1',
    port: 0,
  });
});

afterAll(async () => {
  await running.close();
  service.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('MCP over HTTP', () => {
  test('refuses requests without a known bearer token before any MCP traffic', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const anonymous = await fetch(running.url, { method: 'POST', headers, body });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const forged = await fetch(running.url, { method: 'POST', headers: { ...headers, authorization: 'Bearer not-a-real-token-but-long-enough-0000' }, body });
    expect(forged.status).toBe(401);
    const elsewhere = await fetch(running.url.replace('/mcp', '/other'), { method: 'POST', headers: { ...headers, authorization: `Bearer ${guzmanToken}` }, body });
    expect(elsewhere.status).toBe(404);
  });

  test('answers from the headers alone, before an unauthenticated body arrives', async () => {
    const { port } = new URL(running.url);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = tcpConnect(Number(port), '127.0.0.1', () => {
        // Announces a body it never sends: the gate must not wait for it.
        socket.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n');
      });
      let received = '';
      socket.on('data', (chunk) => { received += chunk.toString(); if (received.includes('\r\n\r\n')) { socket.destroy(); resolve(received); } });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); reject(new Error('no answer within 2 s')); }, 2_000);
    });
    expect(answer.split('\r\n')[0]).toContain('401');
  });

  test('refuses browser origins, oversized bodies and malformed hosts', async () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${guzmanToken}` };
    const fromPage = await fetch(running.url, { method: 'POST', headers: { ...headers, origin: 'http://evil.example' }, body: '{}' });
    expect(fromPage.status).toBe(403);
    const huge = await fetch(running.url, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) });
    expect(huge.status).toBe(413);
    const { port } = new URL(running.url);
    const malformed = await new Promise<string>((resolve, reject) => {
      const socket = tcpConnect(Number(port), '127.0.0.1', () => {
        socket.write(`POST /mcp HTTP/1.1\r\nHost: [::1\r\nAuthorization: Bearer ${guzmanToken}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
      });
      let received = '';
      socket.on('data', (chunk) => { received += chunk.toString(); if (received.includes('\r\n\r\n')) { socket.destroy(); resolve(received); } });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); reject(new Error('no answer')); }, 2_000);
    });
    expect(malformed.split('\r\n')[0]).toMatch(/400/);
  });

  test('serves the same ten tools as stdio', async () => {
    const client = await connect(guzmanToken);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual([
        'add_finding_note', 'browse_project_directories', 'get_finding', 'list_findings', 'list_projects',
        'list_users', 'register_finding', 'register_project', 'update_finding', 'update_finding_status',
      ]);
      const users = structured<{ users: Array<{ slug: string }> }>(await client.callTool({ name: 'list_users', arguments: {} }));
      expect(users.users.map(({ slug }) => slug).sort()).toEqual(['arturo', 'guzman']);
    } finally {
      await client.close();
    }
  });

  test('each token writes as its own user', async () => {
    const guzman = await connect(guzmanToken);
    const arturo = await connect(arturoToken);
    try {
      const registered = structured<{ project: { id: string; ownerId: string } }>(await guzman.callTool({
        name: 'register_project',
        arguments: { directoryPath: '/Users/guzman/z_dev/app', external: true, repositoryReference: 'git@github.com:acme/app.git' },
      }));
      expect(registered.project.ownerId).toBe(service.requireUserBySlug('guzman').id);

      const finding = structured<{ finding: { id: string; history: Array<{ actor: { slug: string } | null }> } }>(await arturo.callTool({
        name: 'register_finding',
        arguments: { projectId: registered.project.id, idempotencyKey: 'http-1', title: 'Seen from HTTP', description: 'Context' },
      }));
      expect(finding.finding.history[0]!.actor?.slug).toBe('arturo');

      const mine = structured<{ projects: unknown[] }>(await arturo.callTool({ name: 'list_projects', arguments: {} }));
      expect(mine.projects).toEqual([]);
    } finally {
      await guzman.close();
      await arturo.close();
    }
  });
});

describe('MCP tokens file', () => {
  test.each([
    ['', /no tokens/],
    ['Guzmán abcdefghijklmnopqrstuvwxyz0123456789', /line 1/],
    ['guzman short', /at least 32/],
    [`guzman ${'x'.repeat(40)} extra`, /line 1/],
    [`guzman ${'x'.repeat(40)}\narturo ${'x'.repeat(40)}`, /already used/],
  ])('rejects %j', (text, message) => {
    expect(() => parseMcpTokens(text)).toThrow(message);
  });
});
