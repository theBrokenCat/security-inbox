import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z, type ZodType } from 'zod';

import { AppError, validationError } from '../core/errors.js';
import { SecurityInboxService } from '../core/service.js';
import { FINDING_STATUSES, SEVERITIES, type AppErrorCode } from '../core/types.js';
import {
  addFindingNoteInputSchema,
  findingIdentitySchema,
  listFindingsInputSchema,
  registerFindingInputSchema,
  updateFindingStatusInputSchema,
} from '../core/validation.js';

const publicMessages: Record<AppErrorCode, string> = {
  VALIDATION_ERROR: 'Invalid request.',
  PROJECT_NOT_FOUND: 'Project not found.',
  FINDING_NOT_FOUND: 'Finding not found.',
  IDEMPOTENCY_CONFLICT: 'Idempotency key conflict.',
  TERMINAL_NOTE_REQUIRED: 'A note is required for a terminal status.',
  NO_STATUS_CHANGE: 'Finding status is unchanged.',
};

const uuidSchema = z.string().uuid();
const timestampSchema = z.string().datetime();
const countSchema = z.number().int().nonnegative();
const severitySchema = z.enum(SEVERITIES);
const statusSchema = z.enum(FINDING_STATUSES);
const projectSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string(),
  repositoryReference: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
const projectSummarySchema = projectSchema.extend({
  openCounts: z.object({
    critical: countSchema,
    high: countSchema,
    medium: countSchema,
    low: countSchema,
    informational: countSchema,
  }),
  openTotal: countSchema,
  pendingReviewCount: countSchema,
});
const findingSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  title: z.string(),
  description: z.string(),
  severity: severitySchema,
  status: statusSchema,
  filePath: z.string().nullable(),
  lineNumber: z.number().int().nullable(),
  commitRef: z.string().nullable(),
  evidence: z.string(),
  recommendation: z.string().nullable(),
  origin: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
const scalarSchema = z.union([z.string(), z.number(), z.null()]);
const eventSchema = z.object({
  id: uuidSchema,
  findingId: uuidSchema,
  kind: z.enum(['created', 'edited', 'status_changed', 'note']),
  fromStatus: statusSchema.nullable(),
  toStatus: statusSchema.nullable(),
  note: z.string().nullable(),
  changes: z.record(z.string(), z.object({ from: scalarSchema, to: scalarSchema })).nullable(),
  createdAt: timestampSchema,
});
const findingDetailSchema = findingSchema.extend({ history: z.array(eventSchema) });
const findingSummarySchema = findingSchema.pick({
  id: true,
  projectId: true,
  title: true,
  severity: true,
  status: true,
  origin: true,
  filePath: true,
  lineNumber: true,
  updatedAt: true,
});
const duplicateSchema = findingSchema.pick({
  id: true,
  projectId: true,
  title: true,
  severity: true,
  status: true,
  updatedAt: true,
}).extend({
  match: z.enum(['exact', 'similar']),
  score: z.number().min(0).max(1),
});
const errorSchema = z.object({
  error: z.object({
    code: z.enum([
      'VALIDATION_ERROR',
      'PROJECT_NOT_FOUND',
      'FINDING_NOT_FOUND',
      'IDEMPOTENCY_CONFLICT',
      'TERMINAL_NOTE_REQUIRED',
      'NO_STATUS_CHANGE',
      'INTERNAL_ERROR',
    ]),
    message: z.string(),
  }),
});
const listProjectsOutputSchema = z.union([
  z.object({ projects: z.array(projectSummarySchema) }),
  errorSchema,
]);
const registerFindingOutputSchema = z.union([
  z.object({
    finding: findingDetailSchema,
    created: z.boolean(),
    possibleDuplicates: z.array(duplicateSchema),
  }),
  errorSchema,
]);
const listFindingsOutputSchema = z.union([
  z.object({ findings: z.array(findingSummarySchema) }),
  errorSchema,
]);
const findingOutputSchema = z.union([z.object({ finding: findingDetailSchema }), errorSchema]);

function result(structuredContent: Record<string, unknown>, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function advertisedInput(schema: ZodType): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'security-inbox',
      validate: (value) => ({ value }),
      jsonSchema: schema['~standard'].jsonSchema,
    },
  };
}

function handle<T>(schema: ZodType<T>, input: unknown, operation: (value: T) => Record<string, unknown>) {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    return result(operation(parsed.data));
  } catch (error) {
    const failure = error instanceof AppError
      ? { code: error.code, message: publicMessages[error.code] }
      : { code: 'INTERNAL_ERROR', message: 'Request failed.' };
    return result({ error: failure }, true);
  }
}

export function createSecurityInboxMcpServer(service: SecurityInboxService): McpServer {
  const server = new McpServer({ name: 'security-inbox', version: '0.1.0' });
  const emptyInputSchema = z.object({}).strict();

  server.registerTool('list_projects', {
    description: 'List Security Inbox projects and their open finding counts.',
    inputSchema: advertisedInput(emptyInputSchema),
    outputSchema: listProjectsOutputSchema,
  }, async (input) => handle(emptyInputSchema, input, () => ({ projects: service.listProjects() })));

  server.registerTool('register_finding', {
    description: 'Register an unconfirmed security finding after checking for existing findings.',
    inputSchema: advertisedInput(registerFindingInputSchema),
    outputSchema: registerFindingOutputSchema,
  }, async (input) => handle(registerFindingInputSchema, input, (value) => service.registerFinding(value)));

  server.registerTool('list_findings', {
    description: 'List or search findings within one Security Inbox project.',
    inputSchema: advertisedInput(listFindingsInputSchema),
    outputSchema: listFindingsOutputSchema,
  }, async (input) => handle(listFindingsInputSchema, input, (value) => ({ findings: service.listFindings(value) })));

  server.registerTool('get_finding', {
    description: 'Get one finding and its chronological history within its project.',
    inputSchema: advertisedInput(findingIdentitySchema),
    outputSchema: findingOutputSchema,
  }, async (input) => handle(findingIdentitySchema, input, (value) => ({ finding: service.getFinding(value) })));

  server.registerTool('update_finding_status', {
    description: 'Change a finding status; resolving or dismissing requires a verification note.',
    inputSchema: advertisedInput(updateFindingStatusInputSchema),
    outputSchema: findingOutputSchema,
  }, async (input) => handle(updateFindingStatusInputSchema, input, (value) => ({ finding: service.updateFindingStatus(value) })));

  server.registerTool('add_finding_note', {
    description: 'Append a note to a finding without changing its status.',
    inputSchema: advertisedInput(addFindingNoteInputSchema),
    outputSchema: findingOutputSchema,
  }, async (input) => handle(addFindingNoteInputSchema, input, (value) => ({ finding: service.addFindingNote(value) })));

  return server;
}
