import { z } from 'zod';

import { FINDING_STATUSES, PROJECT_SCOPES, SEVERITIES, USER_COLORS } from './types.js';

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => requiredText(max).nullable().optional();
const uuid = z.string().uuid();

export const severitySchema = z.enum(SEVERITIES);
export const findingStatusSchema = z.enum(FINDING_STATUSES);
export const projectScopeSchema = z.enum(PROJECT_SCOPES);
export const userColorSchema = z.enum(USER_COLORS);

// The slug is the identity a person types and an agent configures, so it stays narrow enough
// to be safe in a cookie, a URL and a CSS class name without any further escaping.
export const userSlugSchema = z.string().trim().toLowerCase().min(1).max(40)
  .regex(/^[a-z0-9-]+$/, 'Only lowercase letters, digits and hyphens are allowed');

export const createUserInputSchema = z.object({
  slug: userSlugSchema,
  name: requiredText(80).optional(),
  color: userColorSchema.optional(),
}).strict();

export const listProjectsInputSchema = z.object({
  scope: projectScopeSchema.optional(),
  ownerId: uuid.optional(),
}).strict().superRefine((value, context) => {
  if (value.scope === 'mine' && !value.ownerId) {
    context.addIssue({
      code: 'custom',
      path: ['ownerId'],
      message: 'Scope "mine" requires an owner',
    });
  }
});

export const createProjectInputSchema = z.object({
  name: requiredText(120),
  description: requiredText(2_000),
  repositoryReference: optionalText(500),
  ownerId: uuid,
}).strict();

export const resolvedProjectDirectoryInputSchema = z.object({
  name: requiredText(120),
  description: requiredText(2_000),
  directoryPath: requiredText(4_096),
  ownerId: uuid,
}).strict();

export const browseProjectDirectoriesInputSchema = z.object({
  relativePath: z.string().trim().max(4_096).optional(),
}).strict();

export const registerProjectDirectoryInputSchema = z.object({
  relativePath: z.string().trim().max(4_096),
  description: optionalText(2_000),
  ownerId: uuid,
}).strict();

export const registerFindingInputSchema = z.object({
  projectId: uuid,
  idempotencyKey: requiredText(200),
  title: requiredText(200),
  description: requiredText(10_000),
  severity: severitySchema,
  filePath: optionalText(1_000),
  lineNumber: z.number().int().min(1).max(10_000_000).nullable().optional(),
  commitRef: optionalText(200),
  evidence: requiredText(10_000),
  recommendation: optionalText(5_000),
  origin: requiredText(200),
}).strict().superRefine((value, context) => {
  if (value.lineNumber != null && value.filePath == null) {
    context.addIssue({
      code: 'custom',
      path: ['lineNumber'],
      message: 'Line number requires a file path',
    });
  }
});

export const findingIdentitySchema = z.object({
  projectId: uuid,
  findingId: uuid,
}).strict();

export const listFindingsInputSchema = z.object({
  projectId: uuid,
  severity: severitySchema.optional(),
  status: findingStatusSchema.optional(),
  query: requiredText(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const updateFindingInputSchema = findingIdentitySchema.extend({
  title: requiredText(200).optional(),
  description: requiredText(10_000).optional(),
  severity: severitySchema.optional(),
  filePath: optionalText(1_000),
  lineNumber: z.number().int().min(1).max(10_000_000).nullable().optional(),
  commitRef: optionalText(200),
  evidence: requiredText(10_000).optional(),
  recommendation: optionalText(5_000),
  origin: requiredText(200).optional(),
  note: optionalText(5_000),
}).strict().superRefine((value, context) => {
  const editableFields = [
    value.title,
    value.description,
    value.severity,
    value.filePath,
    value.lineNumber,
    value.commitRef,
    value.evidence,
    value.recommendation,
    value.origin,
  ];
  if (!editableFields.some((field) => field !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'At least one editable field is required',
    });
  }
});

export const updateFindingStatusInputSchema = findingIdentitySchema.extend({
  status: findingStatusSchema,
  note: requiredText(5_000).optional(),
}).strict();

export const addFindingNoteInputSchema = findingIdentitySchema.extend({
  note: requiredText(5_000),
}).strict();

export const duplicateSearchInputSchema = z.object({
  projectId: uuid,
  title: requiredText(200),
  excludeFindingId: uuid.optional(),
}).strict();
