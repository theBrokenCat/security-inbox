import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import nunjucks from 'nunjucks';

import { AppError, type SecurityInboxService } from '../core/service.js';
import {
  FINDING_STATUSES,
  SEVERITIES,
  type DirectoryListing,
  type FindingDetail,
  type ProjectSummary,
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

export function buildWebApp({ service, directories, port = 3300 }: WebAppOptions): FastifyInstance {
  const app = Fastify();
  const csrfToken = randomBytes(32).toString('hex');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const templates = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(join(process.cwd(), 'views'), { noCache: true }),
    { autoescape: true, throwOnUndefined: false },
  );
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

  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(render('projects.njk', {
    projects: service.listProjects(),
  })));

  app.get<{ Querystring: DirectoryQuery }>('/projects/new', async (request, reply) => {
    const listing = directories.browse(queryText(request.query.path));
    return reply.type('text/html; charset=utf-8').send(render('project-new.njk', {
      listing: directoryView(listing),
    }));
  });

  app.post<{ Body: FormBody }>('/projects/register', async (request, reply) => {
    const result = directories.register({
      relativePath: text(request.body, 'relativePath'),
      description: optionalText(request.body, 'description'),
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
      return reply.type('text/html; charset=utf-8').send(render('findings.njk', {
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
    return reply.type('text/html; charset=utf-8').send(render('finding-new.njk', {
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
      return reply.type('text/html; charset=utf-8').send(render('finding-new.njk', {
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
      return renderFinding(reply, render, {
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
