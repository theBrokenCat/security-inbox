import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import type { RegisterFindingInput } from '../../src/core/types.js';
import { ProjectDirectoryManager } from '../../src/projects/directory-manager.js';
import { buildWebApp, resolveListenHost } from '../../src/web/app.js';
import { testOwnerId } from '../support/owner.js';

const PORT = 3300;
const HOST = `127.0.0.1:${PORT}`;

let directory: string;
let projectsRoot: string;
let service: SecurityInboxService;
let app: FastifyInstance;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'security-inbox-web-'));
  projectsRoot = join(directory, 'projects');
  mkdirSync(join(projectsRoot, 'alpha', 'nested'), { recursive: true });
  service = new SecurityInboxService(join(directory, 'inbox.sqlite'));
  testOwnerId(service);
  app = buildWebApp({
    service,
    directories: new ProjectDirectoryManager(service, {
      accessibleRoot: projectsRoot,
      displayRoot: '/srv/projects',
    }),
    port: PORT,
  });
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

// Requests carry the session cookie by default; the tests that exercise the selection
// screen pass anonymous: true instead.
const sessionCookie = `${'si_user'}=tester`;

async function get(url: string, host = HOST, options: { anonymous?: boolean } = {}) {
  const headers: Record<string, string> = { host };
  if (!options.anonymous) headers.cookie = sessionCookie;
  return app.inject({ method: 'GET', url, headers });
}

function csrfFrom(html: string): string {
  const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1]
    ?? html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
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
    cookie: sessionCookie,
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
  test('keeps creation off the dashboard and registers a selected directory on its own page', async () => {
    const empty = await get('/');

    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain('Todavía no hay proyectos');
    expect(empty.body).toContain('href="/projects/new"');
    expect(empty.body).not.toContain('name="name"');
    expect(empty.body).not.toContain('action="/projects"');
    expect(empty.body).not.toContain('<script');
    expect(empty.headers['content-security-policy']).toContain("default-src 'none'");
    expect(empty.headers['content-security-policy']).toContain("style-src 'self'");

    const rootPicker = await get('/projects/new');
    expect(rootPicker.statusCode).toBe(200);
    expect(rootPicker.body).toContain('/srv/projects');
    expect(rootPicker.body).toContain('href="/projects/new?path=alpha"');
    expect(rootPicker.body).not.toContain('Seleccionar esta carpeta');

    const selected = await get('/projects/new?path=alpha');
    expect(selected.statusCode).toBe(200);
    expect(selected.body).toContain('/srv/projects/alpha');
    expect(selected.body).toContain('href="/projects/new?path=alpha%2Fnested"');
    expect(selected.body).toContain('Seleccionar esta carpeta');
    expect(selected.body).not.toContain('name="name"');
    expect(selected.body.indexOf('Seleccionar esta carpeta')).toBeLessThan(
      selected.body.indexOf('aria-label="Directorios"'),
    );

    const created = await post('/projects/register', {
      _csrf: csrfFrom(selected.body),
      relativePath: 'alpha',
      description: '<script>alert("project")</script>',
    });

    expect(created.statusCode).toBe(303);
    const project = service.listProjects()[0]!;
    expect(created.headers.location).toBe(`/projects/${project.id}/findings?created=1`);
    const page = await get('/');
    expect(page.body).toContain('alpha');
    expect(page.body).toContain('/srv/projects/alpha');
    expect(page.body).toContain('&lt;script&gt;alert(&quot;project&quot;)&lt;/script&gt;');
    expect(page.body).not.toContain('<script>alert');
    expect(service.listProjects()).toHaveLength(1);

    const retry = await post('/projects/register', {
      _csrf: csrfFrom(selected.body),
      relativePath: 'alpha',
      description: 'Ignored on retry',
    });
    expect(retry.headers.location).toBe(`/projects/${project.id}/findings?created=0`);
    expect(service.listProjects()).toHaveLength(1);
  });

  test('shows non-terminal severity totals and pending-review count per project', async () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Counts', description: 'Counts project' });
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
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Web', description: 'Web app' });
    const emptyProject = service.createProject({ ownerId: testOwnerId(service), name: 'Empty', description: 'No findings' });
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
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Flows', description: 'All flows' });
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
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Errors', description: 'Error paths' });
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
      url: '/projects/register',
      headers: {
        host: HOST,
        origin: `http://${HOST}`,
        'sec-fetch-site': 'same-origin',
        'content-type': contentType,
      },
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
      const response = await post('/projects/register', {
        _csrf: token,
        relativePath: 'alpha',
        description: name,
      }, overrides);
      expect(response.statusCode, name).toBe(403);
      expect(response.body, name).toContain('Solicitud rechazada');
    }

    for (const submitted of ['', 'wrong', 'f'.repeat(10_000)]) {
      const response = await post('/projects/register', {
        _csrf: submitted,
        relativePath: 'alpha',
        description: 'Bad token',
      });
      expect(response.statusCode).toBe(403);
    }

    const forbiddenGet = await get('/', 'attacker.test');
    expect(forbiddenGet.statusCode).toBe(403);

    for (const host of [`localhost:${PORT}`, `[::1]:${PORT}`]) {
      const page = await get('/', host);
      const response = await post('/projects/register', {
        _csrf: csrfFrom(page.body),
        relativePath: 'alpha',
        description: `Allowed ${host}`,
      }, { headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' } });
      expect(response.statusCode).toBe(303);
    }

    const opaqueOrigin = await post('/projects/register', {
      _csrf: token,
      relativePath: 'alpha',
      description: 'Opaque browser origin',
    }, { headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } });
    expect(opaqueOrigin.statusCode).toBe(303);
  });

  test('serves only local CSS and resolves the only two permitted listen hosts', async () => {
    const css = await get('/assets/styles.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.body).toBe(readFileSync(join(process.cwd(), 'public/styles.css'), 'utf8'));
    expect(css.body).not.toMatch(/https?:\/\//);
    expect(css.body).not.toMatch(/repeating-linear-gradient|Georgia|rotate\(/);
    expect(css.body).toContain('--canvas:');
    expect(css.body).toContain('"Avenir Next"');
    expect(css.body).toContain('outline: 3px solid var(--focus)');
    expect(css.body).toContain('--medium: #7a5300');
    // The severity scale stays reserved for severity: user accents are separate tokens.
    expect(css.body).toContain('--violeta: #7b45d6');
    expect(css.body).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css.body).toMatch(/summary\s*\{[^}]*min-height:\s*2\.75rem/s);
    expect(readFileSync(join(process.cwd(), 'views/project-new.njk'), 'utf8'))
      .not.toContain('Puedes seleccionar esta ubicación');

    const projects = await get('/');
    expect(projects.body).not.toMatch(/cuaderno|índice de investigación/i);
    expect(projects.body).toContain('Gestión local de hallazgos');

    expect(resolveListenHost({})).toBe('127.0.0.1');
    expect(resolveListenHost({ SECURITY_INBOX_CONTAINER: 'true' })).toBe('0.0.0.0');
    expect(resolveListenHost({ SECURITY_INBOX_CONTAINER: 'false' })).toBe('127.0.0.1');
  });
});

describe('Security Inbox users', () => {
  test('asks who you are without redirecting, then remembers the choice', async () => {
    const anonymous = await get('/', HOST, { anonymous: true });

    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.body).toContain('¿Quién eres?');
    // The selection screen is rendered in place: a redirect here could only loop.
    expect(anonymous.headers.location).toBeUndefined();
    expect(anonymous.body).toContain('Esto no es un inicio de sesión');

    const chosen = await post('/session/user', {
      _csrf: csrfFrom(anonymous.body),
      slug: 'tester',
    }, { headers: { cookie: '' } });

    expect(chosen.statusCode).toBe(303);
    expect(chosen.headers['set-cookie']).toContain('si_user=tester');
    expect(chosen.headers['set-cookie']).toContain('HttpOnly');
    expect(chosen.headers['set-cookie']).toContain('SameSite=Strict');
  });

  test('creates a user from the form and signs them in', async () => {
    const form = await get('/users/new');
    const created = await post('/users', {
      _csrf: csrfFrom(form.body),
      slug: 'ada',
      name: 'Ada',
      color: 'coral',
    });

    expect(created.statusCode).toBe(303);
    expect(created.headers['set-cookie']).toContain('si_user=ada');
    expect(service.findUserBySlug('ada')?.color).toBe('coral');

    // Repeating the same slug reuses the user instead of failing or duplicating.
    const again = await post('/users', { _csrf: csrfFrom(form.body), slug: 'ada', name: 'Otra' });
    expect(again.statusCode).toBe(303);
    expect(service.listUsers().filter(({ slug }) => slug === 'ada')).toHaveLength(1);
  });

  test('separates projects by owner while keeping every project reachable', async () => {
    const ada = service.registerUser({ slug: 'ada', name: 'Ada' }).user;
    service.createProject({ name: 'Tester project', description: 'Mine', ownerId: testOwnerId(service) });
    service.createProject({ name: 'Ada project', description: 'Hers', ownerId: ada.id });

    const mine = await get('/');
    expect(mine.body).toContain('Tester project');
    expect(mine.body).not.toContain('Ada project');

    const all = await get('/?scope=all');
    expect(all.body).toContain('Tester project');
    expect(all.body).toContain('Ada project');
    expect(all.body).toContain('Ada');

    // An unknown cookie falls back to the selection screen rather than leaking a list.
    const stale = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: HOST, cookie: 'si_user=ghost' },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toContain('¿Quién eres?');
    expect(stale.body).not.toContain('Ada project');
  });

  test('registers a project owned by the current user', async () => {
    const picker = await get('/projects/new?path=alpha');
    const registered = await post('/projects/register', {
      _csrf: csrfFrom(picker.body),
      relativePath: 'alpha',
    });

    expect(registered.statusCode).toBe(303);
    const [project] = service.listProjects({ scope: 'all' });
    expect(project!.owner.slug).toBe('tester');
  });

  test('refuses to register a project when no user is selected', async () => {
    const anonymous = await post('/projects/register', {
      _csrf: await csrf(),
      relativePath: 'alpha',
    }, { headers: { cookie: '' } });

    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.body).toContain('Elige quién eres');
    expect(service.listProjects({ scope: 'all' })).toHaveLength(0);
  });
});
