import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';

const expectedTools = [
  'add_finding_note',
  'get_finding',
  'list_findings',
  'list_projects',
  'register_finding',
  'update_finding_status',
];

let client: Client;
let databasePath: string;
let projectId: string;
let secondProjectId: string;
let tempDirectory: string;
let transport: StdioClientTransport;
const protocolErrors: string[] = [];
let stderr = '';

beforeAll(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'security-inbox-mcp-'));
  databasePath = join(tempDirectory, 'inbox.sqlite');
  const service = new SecurityInboxService(databasePath);
  projectId = service.createProject({
    name: 'Alpha',
    description: 'Temporary MCP test project',
  }).id;
  secondProjectId = service.createProject({
    name: 'Beta',
    description: 'Isolated MCP test project',
  }).id;
  service.close();

  execFileSync('npm', ['run', 'build'], { cwd: resolve('.'), stdio: 'pipe' });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/src/mcp/server.js')],
    env: { ...getDefaultEnvironment(), SECURITY_INBOX_DB: databasePath },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  client = new Client(
    { name: 'security-inbox-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  client.onerror = (error) => { protocolErrors.push(error.message); };
  await client.connect(transport);
}, 20_000);

afterAll(async () => {
  await client?.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('exposes exactly the six Security Inbox tools over stdio', async () => {
  const { tools } = await client.listTools();

  expect(tools.map(({ name }) => name).sort()).toEqual(expectedTools);
  for (const name of ['get_finding', 'update_finding_status', 'add_finding_note']) {
    expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toEqual(
      expect.arrayContaining(['projectId', 'findingId']),
    );
  }
});

test('negotiates the modern v2 stdio protocol', () => {
  expect(client.getProtocolEra()).toBe('modern');
  expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
});

test('advertises useful output schemas for every tool', async () => {
  const { tools } = await client.listTools();

  for (const tool of tools) {
    expect(tool.outputSchema).toBeDefined();
    expect(JSON.stringify(tool.outputSchema)).toContain('VALIDATION_ERROR');
  }
  expect(JSON.stringify(tools.find(({ name }) => name === 'list_projects')?.outputSchema)).toContain('openCounts');
  expect(JSON.stringify(tools.find(({ name }) => name === 'register_finding')?.outputSchema)).toContain('possibleDuplicates');
  expect(JSON.stringify(tools.find(({ name }) => name === 'list_findings')?.outputSchema)).toContain('updatedAt');
  for (const name of ['get_finding', 'update_finding_status', 'add_finding_note']) {
    expect(JSON.stringify(tools.find((tool) => tool.name === name)?.outputSchema)).toContain('history');
  }
});

test('returns invalid inputs as structured generic errors without echoing them', async () => {
  const secretInput = 'DO NOT ECHO INVALID INPUT';
  const invalid = await client.callTool({
    name: 'list_findings',
    arguments: { projectId: secretInput, query: secretInput },
  });

  expect(invalid).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' },
    },
  });
  expect(JSON.stringify(invalid)).not.toContain(secretInput);
});

test('runs the finding workflow with idempotency, isolation, history, safe errors, and clean stdio', async () => {
  const projects = await client.callTool({ name: 'list_projects', arguments: {} });
  expect(projects.isError).not.toBe(true);
  expect(projects.structuredContent).toMatchObject({
    projects: [
      { id: projectId, name: 'Alpha' },
      { id: secondProjectId, name: 'Beta' },
    ],
  });

  const emptySearch = await client.callTool({
    name: 'list_findings',
    arguments: { projectId, query: 'SQL injection' },
  });
  expect(emptySearch.structuredContent).toEqual({ findings: [] });

  const input = {
    projectId,
    idempotencyKey: 'scan-42',
    title: 'SQL injection in query builder',
    description: 'Untrusted filter reaches a dynamic query.',
    severity: 'high',
    filePath: 'src/search.ts',
    lineNumber: 42,
    commitRef: 'abc123',
    evidence: 'A synthetic test input changes the query shape.',
    recommendation: 'Use a parameterized statement.',
    origin: 'synthetic-e2e',
  };
  const created = await client.callTool({ name: 'register_finding', arguments: input });
  expect(created.isError).not.toBe(true);
  expect(created.structuredContent).toMatchObject({
    created: true,
    finding: {
      projectId,
      title: input.title,
      status: 'pending_review',
      history: [{ kind: 'created' }],
    },
    possibleDuplicates: [],
  });
  const findingId = (created.structuredContent as { finding: { id: string } }).finding.id;

  const retry = await client.callTool({ name: 'register_finding', arguments: input });
  expect(retry.structuredContent).toMatchObject({
    created: false,
    finding: { id: findingId, projectId },
  });

  const duplicate = await client.callTool({
    name: 'register_finding',
    arguments: {
      ...input,
      idempotencyKey: 'scan-43',
      title: 'SQL injection query builder flaw',
      description: 'A separate sink with similar title tokens.',
    },
  });
  expect(duplicate.structuredContent).toMatchObject({
    created: true,
    possibleDuplicates: [{ id: findingId, projectId, match: 'similar' }],
  });

  const search = await client.callTool({
    name: 'list_findings',
    arguments: { projectId, query: 'dynamic query' },
  });
  expect(search.structuredContent).toMatchObject({ findings: [{ id: findingId, projectId }] });

  const isolatedList = await client.callTool({
    name: 'list_findings',
    arguments: { projectId: secondProjectId },
  });
  expect(isolatedList.structuredContent).toEqual({ findings: [] });

  const isolatedGet = await client.callTool({
    name: 'get_finding',
    arguments: { projectId: secondProjectId, findingId },
  });
  expect(isolatedGet).toMatchObject({
    isError: true,
    structuredContent: { error: { code: 'FINDING_NOT_FOUND', message: 'Finding not found.' } },
  });
  expect(JSON.stringify(isolatedGet)).not.toContain(findingId);

  const detail = await client.callTool({
    name: 'get_finding',
    arguments: { projectId, findingId },
  });
  expect(detail.structuredContent).toMatchObject({ finding: { id: findingId, projectId } });

  const noted = await client.callTool({
    name: 'add_finding_note',
    arguments: { projectId, findingId, note: 'Reproduced in the isolated fixture.' },
  });
  expect(noted.structuredContent).toMatchObject({
    finding: { history: [{ kind: 'created' }, { kind: 'note', note: 'Reproduced in the isolated fixture.' }] },
  });

  const unverifiedResolution = await client.callTool({
    name: 'update_finding_status',
    arguments: { projectId, findingId, status: 'resolved' },
  });
  expect(unverifiedResolution).toMatchObject({
    isError: true,
    structuredContent: {
      error: {
        code: 'TERMINAL_NOTE_REQUIRED',
        message: 'A note is required for a terminal status.',
      },
    },
  });

  const resolved = await client.callTool({
    name: 'update_finding_status',
    arguments: { projectId, findingId, status: 'resolved', note: 'Verified after parameterization.' },
  });
  expect(resolved.structuredContent).toMatchObject({
    finding: {
      id: findingId,
      projectId,
      status: 'resolved',
      history: [
        { kind: 'created' },
        { kind: 'note' },
        {
          kind: 'status_changed',
          fromStatus: 'pending_review',
          toStatus: 'resolved',
          note: 'Verified after parameterization.',
        },
      ],
    },
  });

  const conflictingTitle = 'DO NOT ECHO THIS CONFLICTING TITLE';
  const conflict = await client.callTool({
    name: 'register_finding',
    arguments: { ...input, title: conflictingTitle },
  });
  expect(conflict).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key conflict.' },
    },
  });
  expect(JSON.stringify(conflict)).not.toContain(conflictingTitle);
  expect(JSON.stringify(conflict)).not.toContain(input.idempotencyKey);

  await new Promise((resolveDelay) => setImmediate(resolveDelay));
  expect(protocolErrors).toEqual([]);
  expect(stderr).toBe('');
});

test('closes the initialized entrypoint cleanly on SIGTERM without stdout noise', async () => {
  const child = spawn(process.execPath, [resolve('dist/src/mcp/server.js')], {
    env: { ...getDefaultEnvironment(), SECURITY_INBOX_DB: join(tempDirectory, 'shutdown.sqlite') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const lines = createInterface({ input: child.stdout });

  try {
    const response = once(lines, 'line');
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'shutdown-e2e', version: '1.0.0' },
      },
    })}\n`);
    const [line] = await response;
    expect(JSON.parse(String(line))).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });

    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code, signal] = await exited;

    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(output.trim()).toBe(String(line));
    expect(errors).toBe('');
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
