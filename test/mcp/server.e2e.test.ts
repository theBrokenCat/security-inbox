import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import { testOwnerId } from '../support/owner.js';

const expectedTools = [
  'add_finding_note',
  'browse_project_directories',
  'get_finding',
  'list_findings',
  'list_projects',
  'list_users',
  'register_finding',
  'register_project',
  'update_finding',
  'update_finding_status',
];

let client: Client;
let databasePath: string;
let projectsRoot: string;
let projectId: string;
let secondProjectId: string;
let tempDirectory: string;
let transport: StdioClientTransport;
const protocolErrors: string[] = [];
let stderr = '';

beforeAll(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'security-inbox-mcp-'));
  databasePath = join(tempDirectory, 'inbox.sqlite');
  projectsRoot = join(tempDirectory, 'projects');
  mkdirSync(join(projectsRoot, 'Gamma', 'nested'), { recursive: true });
  const service = new SecurityInboxService(databasePath);
  projectId = service.createProject({ ownerId: testOwnerId(service),
    name: 'Alpha',
    description: 'Temporary MCP test project',
  }).id;
  secondProjectId = service.createProject({ ownerId: testOwnerId(service),
    name: 'Beta',
    description: 'Isolated MCP test project',
  }).id;
  service.close();

  execFileSync('npm', ['run', 'build'], { cwd: resolve('.'), stdio: 'pipe' });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/src/mcp/server.js')],
    env: {
      ...getDefaultEnvironment(),
      SECURITY_INBOX_DB: databasePath,
      SECURITY_INBOX_PROJECTS_ROOT: projectsRoot,
      SECURITY_INBOX_PROJECTS_DISPLAY_ROOT: '/srv/projects',
      SECURITY_INBOX_USER: 'tester',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  client = new Client(
    { name: 'security-inbox-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  client.onerror = (error) => { protocolErrors.push(error.message); };
  await client.connect(transport);
}, 60_000); // Includes compilation on small deployment hosts.

afterAll(async () => {
  await client?.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('exposes exactly the ten Security Inbox tools over stdio', async () => {
  const { tools } = await client.listTools();

  expect(tools.map(({ name }) => name).sort()).toEqual(expectedTools);
  for (const name of ['get_finding', 'update_finding_status', 'add_finding_note']) {
    expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toEqual(
      expect.arrayContaining(['projectId', 'findingId']),
    );
  }
  expect(tools.find(({ name }) => name === 'register_project')?.inputSchema.properties)
    .toHaveProperty('directoryPath');
  expect(tools.find(({ name }) => name === 'register_project')?.inputSchema.properties)
    .toHaveProperty('relativePath');
  expect(tools.find(({ name }) => name === 'update_finding')?.inputSchema.required).toEqual(
    expect.arrayContaining(['projectId', 'findingId']),
  );
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
  expect(JSON.stringify(tools.find(({ name }) => name === 'list_projects')?.outputSchema)).toContain('lastActivityAt');
  expect(JSON.stringify(tools.find(({ name }) => name === 'browse_project_directories')?.outputSchema))
    .toContain('rootDisplayPath');
  expect(JSON.stringify(tools.find(({ name }) => name === 'register_project')?.outputSchema))
    .toContain('directoryPath');
  expect(JSON.stringify(tools.find(({ name }) => name === 'register_finding')?.outputSchema)).toContain('possibleDuplicates');
  expect(JSON.stringify(tools.find(({ name }) => name === 'list_findings')?.outputSchema)).toContain('updatedAt');
  for (const name of ['get_finding', 'update_finding', 'update_finding_status', 'add_finding_note']) {
    expect(JSON.stringify(tools.find((tool) => tool.name === name)?.outputSchema)).toContain('history');
  }
});

test('lets an agent browse and register a directory, then edit its finding', async () => {
  const root = await client.callTool({ name: 'browse_project_directories', arguments: {} });
  expect(root.structuredContent).toMatchObject({
    listing: {
      rootDisplayPath: '/srv/projects',
      relativePath: '',
      directories: [{ name: 'Gamma', relativePath: 'Gamma', displayPath: '/srv/projects/Gamma' }],
    },
  });

  const nested = await client.callTool({
    name: 'browse_project_directories',
    arguments: { relativePath: 'Gamma' },
  });
  expect(nested.structuredContent).toMatchObject({
    listing: { relativePath: 'Gamma', parentRelativePath: '', directories: [{ name: 'nested' }] },
  });

  const registered = await client.callTool({
    name: 'register_project',
    arguments: { relativePath: 'Gamma', description: 'Registered by an agent' },
  });
  expect(registered.structuredContent).toMatchObject({
    created: true,
    project: { name: 'Gamma', description: 'Registered by an agent', directoryPath: '/srv/projects/Gamma' },
  });
  const project = (registered.structuredContent as { project: { id: string } }).project;
  const retry = await client.callTool({ name: 'register_project', arguments: { relativePath: 'Gamma' } });
  expect(retry.structuredContent).toMatchObject({ created: false, project: { id: project.id } });

  const created = await client.callTool({
    name: 'register_finding',
    arguments: {
      projectId: project.id,
      idempotencyKey: 'agent-edit',
      title: 'Original title',
      description: 'Original description',
      severity: 'low',
      evidence: 'Synthetic evidence',
      origin: 'agent-e2e',
    },
  });
  const findingId = (created.structuredContent as { finding: { id: string } }).finding.id;
  const edited = await client.callTool({
    name: 'update_finding',
    arguments: {
      projectId: project.id,
      findingId,
      title: 'Edited by agent',
      severity: 'medium',
      note: 'Updated through MCP.',
    },
  });
  expect(edited.structuredContent).toMatchObject({
    finding: {
      id: findingId,
      title: 'Edited by agent',
      severity: 'medium',
      history: [{ kind: 'created' }, { kind: 'edited', note: 'Updated through MCP.' }],
    },
  });
});

test('supports an absolute host path with mapped deployments and rejects ambiguous selections', async () => {
  const directoryPath = '/srv/projects/Gamma/nested';
  const listing = await client.callTool({ name: 'browse_project_directories', arguments: { directoryPath } });
  expect(listing.structuredContent).toMatchObject({ listing: { displayPath: directoryPath } });
  const registered = await client.callTool({ name: 'register_project', arguments: { directoryPath } });
  expect(registered.structuredContent).toMatchObject({ created: true, project: { directoryPath } });
  const retry = await client.callTool({ name: 'register_project', arguments: { relativePath: 'Gamma/nested' } });
  expect(retry.structuredContent).toMatchObject({ created: false, project: { directoryPath } });
  for (const arguments_ of [{}, { relativePath: 'Gamma', directoryPath }]) {
    const invalid = await client.callTool({ name: 'register_project', arguments: arguments_ });
    expect(invalid.structuredContent).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  }
});

test('registers directories outside the launch folder in native mode over stdio', async () => {
  const directoryPath = join(tempDirectory, 'native folder');
  mkdirSync(directoryPath);
  const nativeClient = new Client({ name: 'native-directory-test', version: '1.0.0' });
  const nativeTransport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/src/mcp/server.js')],
    env: { ...getDefaultEnvironment(), SECURITY_INBOX_DB: databasePath, SECURITY_INBOX_USER: 'tester' },
    stderr: 'pipe',
  });
  try {
    await nativeClient.connect(nativeTransport);
    const listing = await nativeClient.callTool({ name: 'browse_project_directories', arguments: { directoryPath } });
    expect(listing.structuredContent).toMatchObject({ listing: { displayPath: directoryPath, directories: [] } });
    const result = await nativeClient.callTool({ name: 'register_project', arguments: { directoryPath } });
    expect(result.structuredContent).toMatchObject({ created: true, project: { directoryPath } });
  } finally {
    await nativeClient.close();
  }
});

test('captures issues for an agent workspace unavailable on the inbox server', async () => {
  const directoryPath = '/home/agent-only/workspace';
  const arguments_ = { directoryPath, external: true };
  const registered = await client.callTool({ name: 'register_project', arguments: arguments_ });
  expect(registered.structuredContent).toMatchObject({ created: true, project: { directoryPath } });
  const id = (registered.structuredContent as { project: { id: string } }).project.id;
  const retry = await client.callTool({ name: 'register_project', arguments: arguments_ });
  expect(retry.structuredContent).toMatchObject({ created: false, project: { id } });
  const finding = await client.callTool({ name: 'register_finding', arguments: {
    projectId: id, idempotencyKey: 'external-workspace-issue', title: 'Focus lost on save',
    description: 'Observed in the agent workspace while editing a form.',
  } });
  expect(finding.structuredContent).toMatchObject({ created: true, finding: { projectId: id } });
  const invalid = await client.callTool({ name: 'register_project', arguments: { relativePath: 'Gamma', external: true } });
  expect(invalid.structuredContent).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
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
  expect((projects.structuredContent as { projects: unknown[] }).projects).toEqual(expect.arrayContaining([
      { id: projectId, name: 'Alpha' },
      { id: secondProjectId, name: 'Beta' },
  ].map((project) => expect.objectContaining(project))));

  const emptySearch = await client.callTool({
    name: 'list_findings',
    arguments: { projectId, query: 'SQL injection' },
  });
  expect(emptySearch.structuredContent).toEqual({ findings: [], total: 0, limit: 100, offset: 0, nextOffset: null });

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
  expect(isolatedList.structuredContent).toEqual({ findings: [], total: 0, limit: 100, offset: 0, nextOffset: null });

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

test('scopes projects to the configured user and never takes the owner from input', async () => {
  const tools = (await client.listTools()).tools;
  // The owner comes from SECURITY_INBOX_USER, so it must not be advertised as an argument.
  expect(Object.keys(
    tools.find(({ name }) => name === 'register_project')?.inputSchema.properties ?? {},
  )).not.toContain('ownerId');

  const users = await client.callTool({ name: 'list_users', arguments: {} });
  expect((users.structuredContent as { users: Array<{ slug: string }> }).users.map(({ slug }) => slug))
    .toContain('tester');

  const mine = await client.callTool({ name: 'list_projects', arguments: {} });
  const all = await client.callTool({ name: 'list_projects', arguments: { scope: 'all' } });
  const mineNames = (mine.structuredContent as { projects: Array<{ name: string }> }).projects;
  const allNames = (all.structuredContent as { projects: Array<{ name: string }> }).projects;

  expect(mineNames.length).toBeGreaterThan(0);
  expect(allNames.length).toBeGreaterThanOrEqual(mineNames.length);
  for (const project of mineNames) {
    expect((project as unknown as { owner: { slug: string } }).owner.slug).toBe('tester');
  }
});

test('captures a functional observation without classification and attributes all MCP changes', async () => {
  const input = { projectId, idempotencyKey: 'functional-quick', title: 'Keyboard focus lost on save', description: 'Observed while editing the profile page.', filePath: 'src/profile.ts', lineNumber: 12 };
  const created = await client.callTool({ name: 'register_finding', arguments: input });
  expect(created.isError).not.toBe(true);
  expect(created.structuredContent).toMatchObject({ created: true, finding: { severity: 'unclassified', evidence: '', origin: 'mcp', status: 'pending_review', history: [{ actor: { slug: 'tester', name: 'Tester' } }] } });
  const findingId = (created.structuredContent as { finding: { id: string } }).finding.id;
  const retry = await client.callTool({ name: 'register_finding', arguments: input });
  expect(retry.structuredContent).toMatchObject({ created: false, finding: { id: findingId } });
  const forged = await client.callTool({ name: 'add_finding_note', arguments: { projectId, findingId, note: 'Context', actor: { slug: 'invented', name: 'Invented' } } });
  expect(forged.isError).toBe(true);
  const edited = await client.callTool({ name: 'update_finding', arguments: { projectId, findingId, severity: 'low', evidence: 'Reproduced with the keyboard' } });
  expect(edited.isError).not.toBe(true);
  const started = await client.callTool({ name: 'update_finding_status', arguments: { projectId, findingId, status: 'in_progress' } });
  expect(started.isError).not.toBe(true);
  const noted = await client.callTool({ name: 'add_finding_note', arguments: { projectId, findingId, note: 'Keyboard flow checked' } });
  expect((noted.structuredContent as { finding: { history: Array<{ actor: { slug: string } }> } }).finding.history.map(event => event.actor.slug)).toEqual(['tester', 'tester', 'tester', 'tester']);
});

test('retrieves the complete MCP backlog with pagination and searches by file path', async () => {
  const seed = new SecurityInboxService(databasePath);
  let backlogId: string;
  const ids = new Set<string>();
  try {
    backlogId = seed.createProject({ ownerId: testOwnerId(seed), name: 'MCP backlog', description: 'Synthetic pagination fixture' }).id;
    for (let i = 0; i < 101; i++) ids.add(seed.registerFinding({ projectId: backlogId, idempotencyKey: `mcp-page-${i}`, title: `Incidental issue ${i}`, description: 'Observed context', filePath: i === 0 ? 'src/mcp-pagination-example.ts' : null }).finding.id);
  } finally { seed.close(); }
  const first = await client.callTool({ name: 'list_findings', arguments: { projectId: backlogId!, status: 'pending_review', severity: 'unclassified' } });
  expect(first.isError).not.toBe(true);
  expect(first.structuredContent).toMatchObject({ total: 101, limit: 100, offset: 0, nextOffset: 100 });
  const second = await client.callTool({ name: 'list_findings', arguments: { projectId: backlogId!, status: 'pending_review', severity: 'unclassified', offset: 100 } });
  expect(second.structuredContent).toMatchObject({ total: 101, offset: 100, nextOffset: null });
  const pageOne = (first.structuredContent as { findings: Array<{ id: string }> }).findings;
  const pageTwo = (second.structuredContent as { findings: Array<{ id: string }> }).findings;
  expect(pageOne).toHaveLength(100);
  expect(pageTwo).toHaveLength(1);
  expect(new Set([...pageOne, ...pageTwo].map(f => f.id))).toEqual(ids);
  const byFile = await client.callTool({ name: 'list_findings', arguments: { projectId: backlogId!, query: 'src/mcp-pagination-example.ts' } });
  expect(byFile.structuredContent).toMatchObject({ total: 1, nextOffset: null });
});
