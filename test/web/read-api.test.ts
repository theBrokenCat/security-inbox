import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import { ProjectDirectoryManager } from '../../src/projects/directory-manager.js';
import { buildWebApp } from '../../src/web/app.js';

const HOST = '127.0.0.1:3300';

let directory: string;
let service: SecurityInboxService;
let app: FastifyInstance;
let mineId: string;
let otherId: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'security-inbox-api-'));
  mkdirSync(join(directory, 'projects'));
  service = new SecurityInboxService(join(directory, 'inbox.sqlite'));
  const guzman = service.registerUser({ slug: 'guzman' }).user;
  const arturo = service.registerUser({ slug: 'arturo' }).user;
  mineId = service.createProject({ ownerId: guzman.id, name: 'Mine', description: 'Owned by guzman', repositoryReference: 'github.com/acme/app' }).id;
  otherId = service.createProject({ ownerId: arturo.id, name: 'Other', description: 'Owned by arturo' }).id;
  for (let index = 0; index < 3; index += 1) {
    service.registerFinding({
      projectId: mineId,
      idempotencyKey: `finding-${index}`,
      title: `Issue number ${index}`,
      description: `Line one of ${index}\nline two`,
      ...(index === 0 ? { externalRef: 'T-044', filePath: 'src/a.ts', lineNumber: 3 } : {}),
    });
  }
  app = buildWebApp({
    service,
    directories: new ProjectDirectoryManager(service, { accessibleRoot: join(directory, 'projects') }),
    port: 3300,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  service.close();
  rmSync(directory, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { host: HOST, ...headers } });

describe('read API', () => {
  test('lists every project by default, mine by cookie, and by repository reference', async () => {
    const all = await get('/api/projects');
    expect(all.statusCode).toBe(200);
    expect(all.headers['content-type']).toMatch(/application\/json/);
    expect(all.json().projects.map(({ id }: { id: string }) => id).sort()).toEqual([mineId, otherId].sort());

    const mine = await get('/api/projects?scope=mine', { cookie: 'si_user=guzman' });
    expect(mine.json().projects.map(({ id }: { id: string }) => id)).toEqual([mineId]);
    expect((await get('/api/projects?scope=mine')).statusCode).toBe(400);

    const byRepository = await get('/api/projects?repositoryReference=git%40github.com%3Aacme%2Fapp.git');
    expect(byRepository.json().projects.map(({ id }: { id: string }) => id)).toEqual([mineId]);
  });

  test('pages and filters findings and returns one finding with its history', async () => {
    const page = await get(`/api/projects/${mineId}/findings?limit=2`);
    expect(page.json()).toMatchObject({ total: 3, limit: 2, offset: 0, nextOffset: 2 });
    const tracked = await get(`/api/projects/${mineId}/findings?externalRef=T-044`);
    expect(tracked.json().findings).toHaveLength(1);
    const findingId = tracked.json().findings[0].id;
    const detail = await get(`/api/projects/${mineId}/findings/${findingId}`);
    expect(detail.json().finding).toMatchObject({ id: findingId, externalRef: 'T-044', history: [{ kind: 'created' }] });
    expect((await get(`/api/projects/${mineId}`)).json().project).toMatchObject({ id: mineId, openTotal: 3 });
  });

  test('answers errors in JSON with the public codes', async () => {
    const missing = await get('/api/projects/00000000-0000-4000-8000-000000000000/findings');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'PROJECT_NOT_FOUND', message: expect.any(String) } });
    const badLimit = await get(`/api/projects/${mineId}/findings?limit=many`);
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json().error).toMatchObject({ code: 'VALIDATION_ERROR', fields: ['limit'] });
    const unknown = await get('/api/nothing-here');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
  });

  test('is read-only and keeps the Host check', async () => {
    const write = await app.inject({ method: 'POST', url: '/api/projects', headers: { host: HOST }, payload: {} });
    expect(write.statusCode).toBeGreaterThanOrEqual(400);
    expect(service.listProjects({ scope: 'all' })).toHaveLength(2);
    expect((await get('/api/projects', { host: 'evil.example:3300' })).statusCode).toBe(403);
  });

  test('exports every finding of a project as Markdown, collecting all pages', async () => {
    const exported = await get(`/projects/${mineId}/export.md`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toMatch(/text\/markdown/);
    const body = exported.body;
    expect(body).toContain('# Mine — hallazgos');
    expect(body).toContain('3 hallazgo(s).');
    expect(body).toContain('`github.com/acme/app`');
    expect(body).toContain('- **Referencia externa**: T-044');
    expect(body).toContain('`src/a.ts:3`');
    expect(body).toContain('> Line one of 1\n> line two');
    expect(body).toContain('- **Referencia externa**: T-044');
    const filtered = await get(`/projects/${mineId}/export.md?externalRef=T-044`);
    expect(filtered.body).toContain('1 hallazgo(s).');
  });

  test('keeps hostile text inert in the Markdown export', async () => {
    service.registerFinding({
      projectId: otherId,
      idempotencyKey: 'hostile',
      title: 'Title\r# Injected heading <img src=x onerror=alert(1)>',
      description: 'one\rtwo <script>alert(1)</script>',
      filePath: 'src/`weird`.ts',
      externalRef: 'https://tracker.example/issues/a_b',
    });
    const body = (await get(`/projects/${otherId}/export.md`)).body;
    expect(body).not.toMatch(/^# Injected heading/m);
    expect(body).not.toContain('<img');
    expect(body).not.toContain('<script>');
    expect(body).toContain('> one\n> two &lt;script&gt;');
    expect(body).toContain("`src/'weird'.ts`");
    expect(body).toContain('- **Referencia externa**: https://tracker.example/issues/a_b');
  });
});
