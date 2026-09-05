import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import type { RegisterFindingInput } from '../../src/core/types.js';
import { buildWebApp, resolveListenHost } from '../../src/web/app.js';

const PORT = 3300;
const HOST = `127.0.0.1:${PORT}`;

let directory: string;
let service: SecurityInboxService;
let app: FastifyInstance;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'security-inbox-web-'));
  service = new SecurityInboxService(join(directory, 'inbox.sqlite'));
  app = buildWebApp({ service, port: PORT });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  service.close();
  rmSync(directory, { recursive: true, force: true });
});

function registration(
  projectId: string,
  idempotencyKey: string,
  overrides: Partial<RegisterFindingInput> = {},
): RegisterFindingInput {
  return {
    projectId,
    idempotencyKey,
    title: 'SQL injection in users endpoint',
    description: 'Unsanitized input reaches a query.',
    severity: 'high',
    filePath: 'src/users.ts',
    lineNumber: 42,
    commitRef: 'abc123',
    evidence: 'The parameter is concatenated into SQL.',
    recommendation: 'Use a parameterized query.',
    origin: 'manual-review',
    ...overrides,
  };
}

async function get(url: string, host = HOST) {
  return app.inject({ method: 'GET', url, headers: { host } });
}

function csrfFrom(html: string): string {
  const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  return token!;
}

async function csrf(): Promise<string> {
  return csrfFrom((await get('/')).body);
}

async function post(
  url: string,
  fields: Record<string, string>,
  overrides: { headers?: Record<string, string>; omitOrigin?: boolean } = {},
) {
  const headers: Record<string, string> = {
    host: HOST,
    origin: `http://${HOST}`,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded',
    ...overrides.headers,
  };
  if (overrides.omitOrigin) delete headers.origin;
  return app.inject({
    method: 'POST',
    url,
    headers,
    payload: new URLSearchParams(fields).toString(),
  });
}

describe('Security Inbox web adapter', () => {
  test('renders an empty project notebook and creates a project with an escaped description', async () => {
    const empty = await get('/');

    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain('Todavía no hay proyectos');
    expect(empty.body).toContain('name="_csrf"');
    expect(empty.body).not.toContain('<script');
    expect(empty.headers['content-security-policy']).toContain("default-src 'none'");
    expect(empty.headers['content-security-policy']).toContain("style-src 'self'");

    const created = await post('/projects', {
      _csrf: csrfFrom(empty.body),
      name: 'Cuaderno principal',
      description: '<script>alert("project")</script>',
      repositoryReference: 'git@example.test:team/app.git',
    });

    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe('/');
    const page = await get('/');
    expect(page.body).toContain('Cuaderno principal');
    expect(page.body).toContain('&lt;script&gt;alert(&quot;project&quot;)&lt;/script&gt;');
    expect(page.body).not.toContain('<script>alert');
    expect(service.listProjects()).toHaveLength(1);
  });

  test('shows non-terminal severity totals and pending-review count per project', async () => {
    const project = service.createProject({ name: 'Counts', description: 'Counts project' });
    const statuses = ['pending_review', 'confirmed', 'in_progress', 'resolved'] as const;
    const severities = ['critical', 'high', 'medium', 'low'] as const;

    statuses.forEach((status, index) => {
      const finding = service.registerFinding(registration(project.id, `count-${index}`, {
        title: `${severities[index]} finding`,
        severity: severities[index],
      })).finding;
      if (status !== 'pending_review') {
        service.updateFindingStatus({
          projectId: project.id,
          findingId: finding.id,
          status,
          ...(status === 'resolved' ? { note: 'Resolved after verification' } : {}),
        });
      }
    });

    const page = await get('/');
    expect(page.body).toMatch(/data-count-severity="critical"[^>]*>\s*<span>Crítica<\/span>\s*<strong>1<\/strong>/);
    expect(page.body).toMatch(/data-count-severity="high"[^>]*>\s*<span>Alta<\/span>\s*<strong>1<\/strong>/);
    expect(page.body).toMatch(/data-count-severity="medium"[^>]*>\s*<span>Media<\/span>\s*<strong>1<\/strong>/);
    expect(page.body).toMatch(/data-count-severity="low"[^>]*>\s*<span>Baja<\/span>\s*<strong>0<\/strong>/);
    expect(page.body).toContain('data-pending-review-count="1"');
    expect(page.body).toContain('3 abiertos');
  });

  test('lists an empty project and filters findings by severity, status, and query', async () => {
    const project = service.createProject({ name: 'Web', description: 'Web app' });
    const emptyProject = service.createProject({ name: 'Empty', description: 'No findings' });
    const sql = service.registerFinding(registration(project.id, 'sql')).finding;
    service.registerFinding(registration(project.id, 'cookie', {
      title: 'Weak cookie flags',
      severity: 'medium',
      origin: 'scanner',
    }));
    service.updateFindingStatus({ projectId: project.id, findingId: sql.id, status: 'confirmed' });

    const empty = await get(`/projects/${emptyProject.id}/findings`);
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain('No hay hallazgos en este proyecto');

    const filtered = await get(
      `/projects/${project.id}/findings?severity=high&status=confirmed&query=${encodeURIComponent(' SQL ')}`,
    );
    expect(filtered.statusCode).toBe(200);
    expect(filtered.body).toContain('SQL injection in users endpoint');
    expect(filtered.body).not.toContain('Weak cookie flags');
    expect(filtered.body).toContain('value="high" selected');
    expect(filtered.body).toContain('value="confirmed" selected');
    expect(filtered.body).toContain('value="SQL"');
  });

  test('prechecks duplicates, then creates, views, edits, changes status, and adds a note', async () => {
    const project = service.createProject({ name: 'Flows', description: 'All flows' });
    service.registerFinding(registration(project.id, 'existing'));
    const token = await csrf();

    const createPage = await get(`/projects/${project.id}/findings/new`);
    expect(createPage.statusCode).toBe(200);
    expect(createPage.body).toContain('Comprobar parecidos');

    const precheck = await post(`/projects/${project.id}/findings/precheck`, {
      _csrf: token,
      idempotencyKey: 'new-web-finding',
      title: 'SQL injection in users endpoint',
      description: '<img src=x onerror=alert(1)>',
      severity: 'critical',
      filePath: 'src/web.ts',
      lineNumber: '8',
      commitRef: 'def456',
      evidence: '<b>raw evidence</b>',
      recommendation: 'Parameterize it',
      origin: 'browser',
    });
    expect(precheck.statusCode).toBe(200);
    expect(precheck.body).toContain('Coincidencia exacta');
    expect(precheck.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(precheck.body).not.toContain('<img src=x');

    const created = await post(`/projects/${project.id}/findings`, {
      _csrf: token,
      idempotencyKey: 'new-web-finding',
      title: 'Stored XSS in activity',
      description: '<img src=x onerror=alert(1)>',
      severity: 'critical',
      filePath: 'src/web.ts',
      lineNumber: '8',
      commitRef: 'def456',
      evidence: '<b>raw evidence</b>',
      recommendation: 'Escape on output',
      origin: 'browser',
    });
    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toMatch(new RegExp(`^/projects/${project.id}/findings/[0-9a-f-]+\\?created=1$`));

    const location = created.headers.location!;
    const detailPath = location.split('?')[0]!;
    const detail = await get(location);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('Hallazgo registrado como sospecha');
    expect(detail.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(detail.body).toContain('&lt;b&gt;raw evidence&lt;/b&gt;');
    expect(detail.body).not.toContain('<img src=x');

    const edited = await post(`${detailPath}/edit`, {
      _csrf: token,
      title: 'Stored XSS reviewed',
      description: 'Confirmed rendering path',
      severity: 'high',
      filePath: '',
      lineNumber: '',
      commitRef: '',
      evidence: 'Escaped in SSR output',
      recommendation: '',
      origin: 'manual-review',
      note: 'Triaged by owner',
    });
    expect(edited.statusCode).toBe(303);
    expect(edited.headers.location).toBe(`${detailPath}?updated=1`);

    const findingId = detailPath.split('/').at(-1)!;
    const confirmed = await post(`${detailPath}/status`, {
      _csrf: token,
      status: 'confirmed',
      note: '',
    });
    expect(confirmed.statusCode).toBe(303);

    const terminalWithoutNote = await post(`${detailPath}/status`, {
      _csrf: token,
      status: 'resolved',
      note: '',
    });
    expect(terminalWithoutNote.statusCode).toBe(409);
    expect(terminalWithoutNote.body).toContain('Los estados terminales requieren una nota');

    const noted = await post(`${detailPath}/notes`, {
      _csrf: token,
      note: '<script>note()</script>',
    });
    expect(noted.statusCode).toBe(303);

    const resolved = await post(`${detailPath}/status`, {
      _csrf: token,
      status: 'resolved',
      note: 'Verified fixed',
    });
    expect(resolved.statusCode).toBe(303);

    const finalDetail = await get(detailPath);
    expect(finalDetail.body).toContain('Stored XSS reviewed');
    expect(finalDetail.body).toContain('resolved');
    expect(finalDetail.body).toContain('&lt;script&gt;note()&lt;/script&gt;');
    expect(finalDetail.body).not.toContain('<script>note');
    expect(finalDetail.body).toContain('Triaged by owner');
    expect(finalDetail.body).toContain('Verified fixed');
    expect(service.getFinding({ projectId: project.id, findingId }).history.map(({ kind }) => kind))
      .toEqual(['created', 'edited', 'status_changed', 'note', 'status_changed']);
  });

  test('returns understandable public errors for invalid and missing identifiers and bad input', async () => {
    const project = service.createProject({ name: 'Errors', description: 'Error paths' });
    const token = await csrf();

    const invalid = await get('/projects/not-a-uuid/findings');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain('Datos no válidos');
    expect(invalid.body).not.toContain('ZodError');

    const missing = await get(`/projects/${randomUUID()}/findings`);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('No encontramos ese proyecto');

    const repeatedFilter = await get(`/projects/${project.id}/findings?severity=high&severity=low`);
    expect(repeatedFilter.statusCode).toBe(400);
    expect(repeatedFilter.body).toContain('Datos no válidos');

    const invalidForm = await post(`/projects/${project.id}/findings`, {
      _csrf: token,
      idempotencyKey: 'invalid',
      title: '',
      description: '',
      severity: 'high',
      filePath: '',
      lineNumber: '',
      commitRef: '',
      evidence: '',
      recommendation: '',
      origin: '',
    });
    expect(invalidForm.statusCode).toBe(400);
    expect(invalidForm.body).toContain('Revisa los campos marcados');
    expect(invalidForm.body).not.toContain('ZodError');
  });

  test.each([
    {
      name: 'malformed JSON',
      status: 400,
      title: 'Solicitud no válida',
      contentType: 'application/json',
      payload: '{"private":"parser-secret"',
    },
    {
      name: 'oversized body',
      status: 413,
      title: 'Solicitud demasiado grande',
      contentType: 'application/x-www-form-urlencoded',
      payload: `private=${'body-secret'.repeat(100_000)}`,
    },
    {
      name: 'unsupported media type',
      status: 415,
      title: 'Formato no admitido',
      contentType: 'application/x-private-format',
      payload: 'media-secret',
    },
  ])('preserves Fastify $status for $name without echoing details', async ({ status, title, contentType, payload }) => {
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { host: HOST, 'content-type': contentType },
      payload,
    });

    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain(title);
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('FST_ERR_');
    expect(response.body).not.toContain('Unexpected token');
  });

  test('requires loopback Host, matching Origin, same-site fetch, and the app CSRF token', async () => {
    const token = await csrf();
    const cases: Array<[string, { headers: Record<string, string>; omitOrigin?: boolean }]> = [
      ['missing origin', { headers: { host: HOST }, omitOrigin: true }],
      ['external origin', { headers: { host: HOST, origin: 'https://attacker.test' } }],
      ['cross-site fetch', { headers: { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'cross-site' } }],
      ['untrusted host', { headers: { host: 'attacker.test', origin: 'http://attacker.test' } }],
    ];

    for (const [name, overrides] of cases) {
      const response = await post('/projects', {
        _csrf: token,
        name,
        description: 'Must be rejected',
        repositoryReference: '',
      }, overrides);
      expect(response.statusCode, name).toBe(403);
      expect(response.body, name).toContain('Solicitud rechazada');
    }

    for (const submitted of ['', 'wrong', 'f'.repeat(10_000)]) {
      const response = await post('/projects', {
        _csrf: submitted,
        name: 'Bad token',
        description: 'Must be rejected',
        repositoryReference: '',
      });
      expect(response.statusCode).toBe(403);
    }

    const forbiddenGet = await get('/', 'attacker.test');
    expect(forbiddenGet.statusCode).toBe(403);

    for (const host of [`localhost:${PORT}`, `[::1]:${PORT}`]) {
      const page = await get('/', host);
      const response = await post('/projects', {
        _csrf: csrfFrom(page.body),
        name: `Allowed ${host}`,
        description: 'Legitimate loopback request',
        repositoryReference: '',
      }, { headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' } });
      expect(response.statusCode).toBe(303);
    }
  });

  test('serves only local CSS and resolves the only two permitted listen hosts', async () => {
    const css = await get('/assets/styles.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.body).toBe(readFileSync(join(process.cwd(), 'public/styles.css'), 'utf8'));
    expect(css.body).not.toMatch(/https?:\/\//);

    expect(resolveListenHost({})).toBe('127.0.0.1');
    expect(resolveListenHost({ SECURITY_INBOX_CONTAINER: 'true' })).toBe('0.0.0.0');
    expect(resolveListenHost({ SECURITY_INBOX_CONTAINER: 'false' })).toBe('127.0.0.1');
  });
});
