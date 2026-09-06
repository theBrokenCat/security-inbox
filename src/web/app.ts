import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import nunjucks from 'nunjucks';

import { AppError, type SecurityInboxService } from '../core/service.js';
import {
  FINDING_STATUSES,
  SEVERITIES,
  USER_COLORS,
  type DirectoryListing,
  type FindingDetail,
  type ProjectSummary,
  type User,
  type UserColor,
} from '../core/types.js';
import type { ProjectDirectoryManager } from '../projects/directory-manager.js';

export type WebAppOptions = {
  service: SecurityInboxService;
  directories: ProjectDirectoryManager;
  port?: number;
};

type FormBody = Record<string, unknown>;
type ProjectParams = { projectId: string };
type FindingParams = ProjectParams & { findingId: string };
type FindingQuery = { severity?: string; status?: string; query?: string; created?: string; updated?: string };
type DirectoryQuery = { path?: string };
type ProjectsQuery = { scope?: string };

const userCookieName = 'si_user';
const userCookieMaxAge = 60 * 60 * 24 * 365;

// One cookie is not worth a dependency: this reads the single value the app sets itself.
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// No Secure flag: this runs over plain HTTP on loopback behind a VPN, and marking it Secure
// would stop the cookie from being stored at all.
function userCookie(slug: string): string {
  return [
    `${userCookieName}=${encodeURIComponent(slug)}`,
    'Path=/',
    `Max-Age=${userCookieMaxAge}`,
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ');
}

const severityOptions = [
  { value: 'critical', label: 'Crítica' },
  { value: 'high', label: 'Alta' },
  { value: 'medium', label: 'Media' },
  { value: 'low', label: 'Baja' },
  { value: 'informational', label: 'Informativa' },
] as const;

const statusOptions = [
  { value: 'pending_review', label: 'Sin revisar' },
  { value: 'confirmed', label: 'Confirmado' },
  { value: 'in_progress', label: 'En curso' },
  { value: 'resolved', label: 'Resuelto' },
  { value: 'dismissed', label: 'Descartado' },
] as const;
const severityLabels = Object.fromEntries(severityOptions.map(({ value, label }) => [value, label]));
const statusLabels = Object.fromEntries(statusOptions.map(({ value, label }) => [value, label]));
const eventLabels = {
  created: 'Creado',
  edited: 'Editado',
  status_changed: 'Estado actualizado',
  note: 'Nota añadida',
};

const publicErrors: Record<AppError['code'], { status: number; title: string; message: string }> = {
  VALIDATION_ERROR: {
    status: 400,
    title: 'Datos no válidos',
    message: 'Revisa los campos marcados e inténtalo de nuevo.',
  },
  PROJECT_NOT_FOUND: {
    status: 404,
    title: 'Proyecto no encontrado',
    message: 'No encontramos ese proyecto.',
  },
  FINDING_NOT_FOUND: {
    status: 404,
    title: 'Hallazgo no encontrado',
    message: 'No encontramos ese hallazgo dentro del proyecto.',
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    title: 'Registro en conflicto',
    message: 'La clave de registro ya se usó para otro contenido.',
  },
  TERMINAL_NOTE_REQUIRED: {
    status: 409,
    title: 'Falta la nota de cierre',
    message: 'Los estados terminales requieren una nota en este mismo cambio.',
  },
  NO_STATUS_CHANGE: {
    status: 409,
    title: 'Sin cambio de estado',
    message: 'El hallazgo ya tiene ese estado.',
  },
  DIRECTORY_INVALID: {
    status: 400,
    title: 'Directorio no válido',
    message: 'Selecciona una carpeta dentro de la raíz permitida.',
  },
  DIRECTORY_UNAVAILABLE: {
    status: 404,
    title: 'Directorio no disponible',
    message: 'No podemos acceder a esa carpeta.',
  },
  USER_NOT_FOUND: {
    status: 404,
    title: 'Usuario no encontrado',
    message: 'Ese usuario ya no existe. Vuelve a elegir quién eres.',
  },
  USER_REQUIRED: {
    status: 400,
    title: 'Falta elegir usuario',
    message: 'Elige quién eres antes de registrar o consultar proyectos propios.',
  },
  USER_HAS_PROJECTS: {
    status: 409,
    title: 'El usuario tiene proyectos',
    message: 'Traspasa sus proyectos a otra persona antes de eliminarlo.',
  },
};

const csp = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function text(body: FormBody, key: string): string {
  return typeof body[key] === 'string' ? body[key] : '';
}

function optionalText(body: FormBody, key: string): string | null {
  return text(body, key).trim() || null;
}

function lineNumber(body: FormBody): number | null {
  const value = text(body, 'lineNumber').trim();
  return value ? Number(value) : null;
}

function queryText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError('VALIDATION_ERROR', 'Invalid input');
  return value.trim() || undefined;
}

// The severity bar is sized here, not in the template: the CSP forbids inline styles, so the
// proportion has to arrive as a class name from a closed set of 5% steps. Widths are shared
// out by largest remainder so they total exactly 100 and no segment misrepresents its share.
function severityBar(project: ProjectSummary): Array<{ severity: string; width: number }> {
  if (project.openTotal === 0) return [];
  const steps = 20;
  const open = SEVERITIES
    .filter((severity) => project.openCounts[severity] > 0)
    .map((severity) => {
      const exact = (project.openCounts[severity] / project.openTotal) * steps;
      return { severity, floor: Math.max(1, Math.floor(exact)), remainder: exact - Math.floor(exact) };
    });

  let remaining = steps - open.reduce((total, { floor }) => total + floor, 0);
  const byRemainder = [...open].sort((left, right) => right.remainder - left.remainder);
  for (let index = 0; remaining > 0; index += 1, remaining -= 1) {
    byRemainder[index % byRemainder.length]!.floor += 1;
  }
  // Rounding every share up to at least one step can overshoot when many severities are open.
  for (let index = 0; remaining < 0; index += 1, remaining += 1) {
    const candidate = [...open].sort((left, right) => right.floor - left.floor)[0]!;
    candidate.floor -= 1;
  }

  return open.map(({ severity, floor }) => ({ severity, width: floor * 5 }));
}

function projectView(project: ProjectSummary) {
  return { ...project, bar: severityBar(project) };
}

// Critical and high work does not belong in the same grid as everything else: it gets its own
// list at the top, read as a queue rather than as cards to browse.
const urgentSeverities = new Set(['critical', 'high']);

function isUrgent(project: ProjectSummary): boolean {
  return project.worstOpenSeverity !== null && urgentSeverities.has(project.worstOpenSeverity);
}

function projectTotals(projects: ProjectSummary[]) {
  return projects.reduce((totals, project) => ({
    critical: totals.critical + project.openCounts.critical,
    pendingReview: totals.pendingReview + project.pendingReviewCount,
    open: totals.open + project.openTotal,
  }), { critical: 0, pendingReview: 0, open: 0 });
}

function projectFor(service: SecurityInboxService, projectId: string): ProjectSummary {
  service.listFindings({ projectId, limit: 1 });
  return service.listProjects().find(({ id }) => id === projectId)!;
}

function renderFinding(reply: FastifyReply, render: (name: string, context?: object) => string, data: {
  project: ProjectSummary;
  finding: FindingDetail;
  notice?: string;
}) {
  return reply.type('text/html; charset=utf-8').send(render('finding-detail.njk', data));
}

function directoryView(listing: DirectoryListing) {
  const segments = listing.relativePath.split('/').filter(Boolean);
  return {
    ...listing,
    parentHref: listing.parentRelativePath === null
      ? null
      : `/projects/new?path=${encodeURIComponent(listing.parentRelativePath)}`,
    breadcrumbs: segments.map((name, index) => ({
      name,
      href: `/projects/new?path=${encodeURIComponent(segments.slice(0, index + 1).join('/'))}`,
    })),
    directories: listing.directories.map((directory) => ({
      ...directory,
      href: `/projects/new?path=${encodeURIComponent(directory.relativePath)}`,
    })),
  };
}

export function resolveListenHost(environment: NodeJS.ProcessEnv): '127.0.0.1' | '0.0.0.0' {
  return environment.SECURITY_INBOX_CONTAINER === 'true' ? '0.0.0.0' : '127.0.0.1';
}

const friendlyDateFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' });

function friendlyDate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : friendlyDateFormatter.format(date);
}

export function buildWebApp({ service, directories, port = 3300 }: WebAppOptions): FastifyInstance {
  const app = Fastify();
  const csrfToken = randomBytes(32).toString('hex');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const templates = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(join(process.cwd(), 'views'), { noCache: true }),
    { autoescape: true, throwOnUndefined: false },
  );
  templates.addFilter('friendlyDate', friendlyDate);
  const stylesheet = readFileSync(join(process.cwd(), 'public/styles.css'), 'utf8');
  const render = (name: string, context: object = {}) => templates.render(name, {
    ...context,
    csrfToken,
    severityOptions,
    statusOptions,
    severityLabels,
    statusLabels,
    eventLabels,
  });

  const currentUser = (request: FastifyRequest): User | undefined => {
    const slug = readCookie(request.headers.cookie, userCookieName);
    return slug ? service.findUserBySlug(slug) : undefined;
  };
  const requireCurrentUser = (request: FastifyRequest): User => {
    const user = currentUser(request);
    if (!user) throw new AppError('USER_REQUIRED', 'No user selected');
    return user;
  };
  // Every page carries the session chrome, so the switcher renders the same everywhere.
  const renderFor = (request: FastifyRequest, name: string, context: object = {}) => render(name, {
    ...context,
    currentUser: currentUser(request) ?? null,
    users: service.listUsers(),
    userColors: USER_COLORS,
  });

  app.register(formbody);

  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('content-security-policy', csp)
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY');
    if (!request.headers.host || !allowedHosts.has(request.headers.host)) {
      return reply.code(403).type('text/html; charset=utf-8').send(render('error.njk', {
        title: 'Solicitud rechazada',
        message: 'Abre Security Inbox desde una dirección local permitida.',
      }));
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST') return;
    const host = request.headers.host!;
    const fetchSite = request.headers['sec-fetch-site'];
    const hasTrustedOrigin = request.headers.origin === `http://${host}`;
    const hasOpaqueSameOrigin = request.headers.origin === 'null' && fetchSite === 'same-origin';
    if (
      (!hasTrustedOrigin && !hasOpaqueSameOrigin)
      || fetchSite === 'cross-site'
    ) {
      return reply.code(403).type('text/html; charset=utf-8').send(render('error.njk', {
        title: 'Solicitud rechazada',
        message: 'El origen de la petición no coincide con esta aplicación local.',
      }));
    }

    const submitted = typeof request.body === 'object' && request.body !== null
      ? text(request.body as FormBody, '_csrf')
      : '';
    const expectedDigest = createHash('sha256').update(csrfToken).digest();
    const submittedDigest = createHash('sha256').update(submitted).digest();
    if (!timingSafeEqual(expectedDigest, submittedDigest)) {
      return reply.code(403).type('text/html; charset=utf-8').send(render('error.njk', {
        title: 'Solicitud rechazada',
        message: 'El formulario ha caducado o no pertenece a esta aplicación.',
      }));
    }
  });

  app.get('/assets/styles.css', async (_request, reply) => reply
    .type('text/css; charset=utf-8')
    .send(stylesheet));

  app.get<{ Querystring: ProjectsQuery }>('/', async (request, reply) => {
    const user = currentUser(request);
    // Rendered in place rather than redirected to, so there is no way to bounce between a
    // selector and the page that needs it.
    if (!user) {
      return reply.type('text/html; charset=utf-8').send(renderFor(request, 'user-select.njk', {
        hasUsers: service.listUsers().length > 0,
      }));
    }
    const scope = queryText(request.query.scope) === 'all' ? 'all' : 'mine';
    const projects = scope === 'all'
      ? service.listProjects({ scope: 'all' })
      : service.listProjects({ scope: 'mine', ownerId: user.id });
    return reply.type('text/html; charset=utf-8').send(renderFor(request, 'projects.njk', {
      projects: projects.map(projectView),
      urgent: projects.filter(isUrgent).map(projectView),
      rest: projects.filter((project) => !isUrgent(project)).map(projectView),
      totals: projectTotals(projects),
      scope,
      allProjectCount: scope === 'all' ? projects.length : service.listProjects({ scope: 'all' }).length,
    }));
  });

  app.get('/users/new', async (request, reply) => reply
    .type('text/html; charset=utf-8')
    .send(renderFor(request, 'user-new.njk')));

  app.post<{ Body: FormBody }>('/users', async (request, reply) => {
    const color = text(request.body, 'color');
    const name = optionalText(request.body, 'name');
    const { user } = service.registerUser({
      slug: text(request.body, 'slug'),
      ...(name ? { name } : {}),
      ...(USER_COLORS.includes(color as UserColor) ? { color: color as UserColor } : {}),
    });
    return reply.header('set-cookie', userCookie(user.slug)).redirect('/', 303);
  });

  app.post<{ Params: ProjectParams; Body: FormBody }>(
    '/projects/:projectId/owner',
    async (request, reply) => {
      requireCurrentUser(request);
      service.transferProject({
        projectId: request.params.projectId,
        ownerId: service.requireUserBySlug(text(request.body, 'slug')).id,
      });
      return reply.redirect(`/projects/${request.params.projectId}/findings?owner=1`, 303);
    },
  );

  app.post<{ Body: FormBody }>('/users/delete', async (request, reply) => {
    const slug = text(request.body, 'slug');
    service.deleteUser(slug);
    // Someone who deletes the identity they are using goes back to the selection screen.
    const current = currentUser(request);
    if (current && current.slug === slug) {
      return reply.header('set-cookie', `${userCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`)
        .redirect('/', 303);
    }
    return reply.redirect('/users', 303);
  });

  app.get('/users', async (request, reply) => reply
    .type('text/html; charset=utf-8')
    .send(renderFor(request, 'users.njk', {
      owned: Object.fromEntries(service.listUsers().map((user) => [
        user.slug,
        service.listProjects({ scope: 'mine', ownerId: user.id }).length,
      ])),
    })));

  app.post<{ Body: FormBody }>('/session/user', async (request, reply) => {
    const user = service.requireUserBySlug(text(request.body, 'slug'));
    return reply.header('set-cookie', userCookie(user.slug)).redirect('/', 303);
  });

  app.get<{ Querystring: DirectoryQuery }>('/projects/new', async (request, reply) => {
    requireCurrentUser(request);
    const listing = directories.browse(queryText(request.query.path));
    return reply.type('text/html; charset=utf-8').send(renderFor(request, 'project-new.njk', {
      listing: directoryView(listing),
    }));
  });

  app.post<{ Body: FormBody }>('/projects/register', async (request, reply) => {
    const result = directories.register({
      relativePath: text(request.body, 'relativePath'),
      description: optionalText(request.body, 'description'),
      ownerId: requireCurrentUser(request).id,
    });
    return reply.redirect(
      `/projects/${result.project.id}/findings?created=${result.created ? '1' : '0'}`,
      303,
    );
  });

  app.get<{ Params: ProjectParams; Querystring: FindingQuery }>(
    '/projects/:projectId/findings',
    async (request, reply) => {
      const severity = queryText(request.query.severity);
      const status = queryText(request.query.status);
      const query = queryText(request.query.query);
      const findings = service.listFindings({
        projectId: request.params.projectId,
        ...(severity ? { severity: severity as (typeof SEVERITIES)[number] } : {}),
        ...(status ? { status: status as (typeof FINDING_STATUSES)[number] } : {}),
        ...(query ? { query } : {}),
      });
      const created = queryText(request.query.created);
      return reply.type('text/html; charset=utf-8').send(renderFor(request, 'findings.njk', {
        project: projectFor(service, request.params.projectId),
        findings,
        filters: { severity, status, query },
        notice: created === '1'
          ? 'Proyecto registrado desde el directorio seleccionado.'
          : created === '0'
            ? 'Ese directorio ya estaba registrado; se muestra el proyecto existente.'
            : undefined,
      }));
    },
  );

  app.get<{ Params: ProjectParams }>('/projects/:projectId/findings/new', async (request, reply) => {
    const project = projectFor(service, request.params.projectId);
    return reply.type('text/html; charset=utf-8').send(renderFor(request, 'finding-new.njk', {
      project,
      form: { idempotencyKey: randomUUID(), severity: 'medium' },
      duplicates: null,
    }));
  });

  app.post<{ Params: ProjectParams; Body: FormBody }>(
    '/projects/:projectId/findings/precheck',
    async (request, reply) => {
      const project = projectFor(service, request.params.projectId);
      const form = request.body;
      const duplicates = service.findPossibleDuplicates({
        projectId: request.params.projectId,
        title: text(form, 'title'),
      });
      return reply.type('text/html; charset=utf-8').send(renderFor(request, 'finding-new.njk', {
        project,
        form,
        duplicates,
      }));
    },
  );

  app.post<{ Params: ProjectParams; Body: FormBody }>(
    '/projects/:projectId/findings',
    async (request, reply) => {
      const result = service.registerFinding({
        projectId: request.params.projectId,
        idempotencyKey: text(request.body, 'idempotencyKey'),
        title: text(request.body, 'title'),
        description: text(request.body, 'description'),
        severity: text(request.body, 'severity') as (typeof SEVERITIES)[number],
        filePath: optionalText(request.body, 'filePath'),
        lineNumber: lineNumber(request.body),
        commitRef: optionalText(request.body, 'commitRef'),
        evidence: text(request.body, 'evidence'),
        recommendation: optionalText(request.body, 'recommendation'),
        origin: text(request.body, 'origin'),
      });
      return reply.redirect(
        `/projects/${request.params.projectId}/findings/${result.finding.id}?created=${result.created ? '1' : '0'}`,
        303,
      );
    },
  );

  app.get<{ Params: FindingParams; Querystring: FindingQuery }>(
    '/projects/:projectId/findings/:findingId',
    async (request, reply) => {
      const finding = service.getFinding(request.params);
      const notice = request.query.created === '1'
        ? 'Hallazgo registrado como sospecha. Revísalo antes de confirmarlo.'
        : request.query.created === '0'
          ? 'Este envío ya estaba registrado; se muestra el hallazgo existente.'
          : request.query.updated === '1'
            ? 'Cambios guardados.'
            : undefined;
      return renderFinding(reply, (name, data) => renderFor(request, name, data), {
        project: projectFor(service, request.params.projectId),
        finding,
        ...(notice ? { notice } : {}),
      });
    },
  );

  app.post<{ Params: FindingParams; Body: FormBody }>(
    '/projects/:projectId/findings/:findingId/edit',
    async (request, reply) => {
      service.updateFinding({
        ...request.params,
        title: text(request.body, 'title'),
        description: text(request.body, 'description'),
        severity: text(request.body, 'severity') as (typeof SEVERITIES)[number],
        filePath: optionalText(request.body, 'filePath'),
        lineNumber: lineNumber(request.body),
        commitRef: optionalText(request.body, 'commitRef'),
        evidence: text(request.body, 'evidence'),
        recommendation: optionalText(request.body, 'recommendation'),
        origin: text(request.body, 'origin'),
        note: optionalText(request.body, 'note'),
      });
      return reply.redirect(
        `/projects/${request.params.projectId}/findings/${request.params.findingId}?updated=1`,
        303,
      );
    },
  );

  app.post<{ Params: FindingParams; Body: FormBody }>(
    '/projects/:projectId/findings/:findingId/status',
    async (request, reply) => {
      const note = optionalText(request.body, 'note');
      service.updateFindingStatus({
        ...request.params,
        status: text(request.body, 'status') as (typeof FINDING_STATUSES)[number],
        ...(note ? { note } : {}),
      });
      return reply.redirect(`/projects/${request.params.projectId}/findings/${request.params.findingId}`, 303);
    },
  );

  app.post<{ Params: FindingParams; Body: FormBody }>(
    '/projects/:projectId/findings/:findingId/notes',
    async (request, reply) => {
      service.addFindingNote({ ...request.params, note: text(request.body, 'note') });
      return reply.redirect(`/projects/${request.params.projectId}/findings/${request.params.findingId}`, 303);
    },
  );

  app.setNotFoundHandler(async (_request, reply) => reply
    .code(404)
    .type('text/html; charset=utf-8')
    .send(render('error.njk', {
      title: 'Página no encontrada',
      message: 'La página que buscas no existe en este cuaderno.',
    })));

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof AppError) {
      const publicError = publicErrors[error.code];
      return reply.code(publicError.status).type('text/html; charset=utf-8').send(render('error.njk', {
        title: publicError.title,
        message: publicError.message,
        code: error.code,
        fields: error.fieldErrors ? Object.keys(error.fieldErrors) : [],
      }));
    }
    const candidateStatus = typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode
      : undefined;
    const status = typeof candidateStatus === 'number' && candidateStatus >= 400 && candidateStatus < 500
      ? candidateStatus
      : 500;
    const publicError = status === 413
      ? { title: 'Solicitud demasiado grande', message: 'El contenido supera el tamaño permitido.' }
      : status === 415
        ? { title: 'Formato no admitido', message: 'El formato de la solicitud no es compatible.' }
        : status < 500
          ? { title: 'Solicitud no válida', message: 'No pudimos interpretar la solicitud.' }
          : {
              title: 'No pudimos completar la operación',
              message: 'No se guardó ningún cambio. Inténtalo de nuevo.',
            };
    return reply.code(status).type('text/html; charset=utf-8').send(render('error.njk', publicError));
  });

  return app;
}
