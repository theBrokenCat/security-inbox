import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError, type SecurityInboxService } from '../core/service.js';
import type { FindingDetail, FindingSummary, ListFindingsInput, ProjectSummary, User } from '../core/types.js';

// Read-only access for whatever cannot speak MCP: a MASTER session that only has a browser or
// curl, a script that snapshots a project's findings into its repository, a dashboard. It
// reuses the web's Host check and the service's validation; it writes nothing, so it needs no
// CSRF token. Identity stays attribution: "mine" reads the same cookie the web pages use.

type Query = Record<string, string | undefined>;
type ProjectParams = { projectId: string };
type FindingParams = ProjectParams & { findingId: string };

function optional(query: Query, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError('VALIDATION_ERROR', 'Invalid input');
  return value.trim() || undefined;
}

function integer(query: Query, key: string): number | undefined {
  const value = optional(query, key);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new AppError('VALIDATION_ERROR', 'Invalid input', { [key]: ['Expected a whole number'] });
  return Number(value);
}

function findingsFilter(projectId: string, query: Query): ListFindingsInput {
  const filter: ListFindingsInput = { projectId };
  for (const key of ['severity', 'status', 'query', 'externalRef'] as const) {
    const value = optional(query, key);
    if (value !== undefined) (filter as Record<string, unknown>)[key] = value;
  }
  const limit = integer(query, 'limit');
  const offset = integer(query, 'offset');
  if (limit !== undefined) filter.limit = limit;
  if (offset !== undefined) filter.offset = offset;
  return filter;
}

// Collects every page with the same filters before rendering, as list_findings asks agents to.
function allFindings(service: SecurityInboxService, filter: ListFindingsInput): FindingSummary[] {
  const findings: FindingSummary[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = service.listFindingsPage({ ...filter, limit: 100, offset });
    findings.push(...page.findings);
    offset = page.nextOffset;
  }
  return findings;
}

function markdownLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/([\\`*_[\]|<>])/g, '\\$1');
}

export function findingsMarkdown(project: ProjectSummary, findings: FindingDetail[], generatedAt: string): string {
  const lines = [
    `# ${markdownLine(project.name)} — hallazgos`,
    '',
    `Exportado de Security Inbox el ${generatedAt}. Proyecto \`${project.id}\`${project.repositoryReference ? ` · repositorio \`${markdownLine(project.repositoryReference)}\`` : ''}${project.directoryPath ? ` · ruta \`${markdownLine(project.directoryPath)}\`` : ''}.`,
    '',
    `${findings.length} hallazgo(s).`,
    '',
  ];
  for (const finding of findings) {
    lines.push(`## ${markdownLine(finding.title)}`, '');
    lines.push(`- **Id**: \`${finding.id}\``);
    lines.push(`- **Estado**: ${finding.status} · **Gravedad**: ${finding.severity} · **Origen**: ${markdownLine(finding.origin)}`);
    if (finding.filePath) lines.push(`- **Ubicación**: \`${markdownLine(finding.filePath)}${finding.lineNumber ? `:${finding.lineNumber}` : ''}\``);
    if (finding.commitRef) lines.push(`- **Commit**: \`${markdownLine(finding.commitRef)}\``);
    if (finding.externalRef) lines.push(`- **Referencia externa**: ${markdownLine(finding.externalRef)}`);
    lines.push(`- **Actualizado**: ${finding.updatedAt}`, '');
    lines.push(finding.description.split(/\r?\n/).map((line) => `> ${line}`).join('\n'), '');
    if (finding.evidence) lines.push('**Evidencia**', '', finding.evidence.split(/\r?\n/).map((line) => `> ${line}`).join('\n'), '');
    if (finding.recommendation) lines.push('**Recomendación**', '', finding.recommendation.split(/\r?\n/).map((line) => `> ${line}`).join('\n'), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function registerReadApi(
  app: FastifyInstance,
  service: SecurityInboxService,
  currentUser: (request: FastifyRequest) => User | undefined,
): void {
  const project = (projectId: string): ProjectSummary => {
    service.listFindings({ projectId, limit: 1 });
    return service.listProjects({ scope: 'all' }).find(({ id }) => id === projectId)!;
  };

  app.get<{ Querystring: Query }>('/api/projects', async (request) => {
    const scope = optional(request.query, 'scope') ?? 'all';
    const repositoryReference = optional(request.query, 'repositoryReference');
    const filter = repositoryReference ? { repositoryReference } : {};
    if (scope === 'mine') {
      const user = currentUser(request);
      if (!user) throw new AppError('USER_REQUIRED', 'No user selected');
      return { projects: service.listProjects({ scope: 'mine', ownerId: user.id, ...filter }) };
    }
    if (scope !== 'all') throw new AppError('VALIDATION_ERROR', 'Invalid input', { scope: ['Use "mine" or "all"'] });
    return { projects: service.listProjects({ scope: 'all', ...filter }) };
  });

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId', async (request) => (
    { project: project(request.params.projectId) }
  ));

  app.get<{ Params: ProjectParams; Querystring: Query }>('/api/projects/:projectId/findings', async (request) => (
    { ...service.listFindingsPage(findingsFilter(request.params.projectId, request.query)) }
  ));

  app.get<{ Params: FindingParams }>('/api/projects/:projectId/findings/:findingId', async (request) => (
    { finding: service.getFinding({ projectId: request.params.projectId, findingId: request.params.findingId }) }
  ));

  app.get<{ Params: ProjectParams; Querystring: Query }>('/projects/:projectId/export.md', async (request, reply) => {
    const filter = findingsFilter(request.params.projectId, request.query);
    delete filter.limit;
    delete filter.offset;
    const summary = project(request.params.projectId);
    const details = allFindings(service, filter)
      .map(({ id }) => service.getFinding({ projectId: summary.id, findingId: id }));
    return reply
      .type('text/markdown; charset=utf-8')
      .header('content-disposition', `inline; filename="security-inbox-${summary.id}.md"`)
      .send(findingsMarkdown(summary, details, new Date().toISOString()));
  });
}
