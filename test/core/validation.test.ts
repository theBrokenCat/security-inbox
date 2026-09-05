import { describe, expect, test } from 'vitest';

import {
  addFindingNoteInputSchema,
  createProjectInputSchema,
  duplicateSearchInputSchema,
  findingIdentitySchema,
  listFindingsInputSchema,
  registerFindingInputSchema,
  updateFindingInputSchema,
  updateFindingStatusInputSchema,
} from '../../src/core/validation.js';

const projectId = '0d895dc2-b358-44c5-84c6-e1c432f90cd8';
const findingId = 'e94adf78-47cb-4813-bc19-96b50d0419b5';

const registration = {
  projectId,
  idempotencyKey: ' key ',
  title: ' Finding ',
  description: ' Description ',
  severity: 'high' as const,
  filePath: ' src/app.ts ',
  lineNumber: 12,
  commitRef: ' abc123 ',
  evidence: ' Evidence ',
  recommendation: ' Fix it ',
  origin: ' manual ',
};

describe('validation', () => {
  test('trims valid project and finding input while preserving explicit nulls', () => {
    expect(createProjectInputSchema.parse({
      name: ' Project ',
      description: ' Description ',
      repositoryReference: null,
    })).toEqual({ name: 'Project', description: 'Description', repositoryReference: null });

    expect(registerFindingInputSchema.parse(registration)).toEqual({
      ...registration,
      idempotencyKey: 'key',
      title: 'Finding',
      description: 'Description',
      filePath: 'src/app.ts',
      commitRef: 'abc123',
      evidence: 'Evidence',
      recommendation: 'Fix it',
      origin: 'manual',
    });
  });

  test.each([
    [{ name: '', description: 'x' }, 'project name'],
    [{ name: 'x', description: 'x'.repeat(2_001) }, 'project description'],
    [{ name: 'x', description: 'x', repositoryReference: ' ' }, 'repository reference'],
  ])('rejects invalid create-project input: %s', (input, _label) => {
    expect(createProjectInputSchema.safeParse(input).success).toBe(false);
  });

  test.each([
    [{ ...registration, projectId: 'not-a-uuid' }, 'project id'],
    [{ ...registration, idempotencyKey: ' ' }, 'idempotency key'],
    [{ ...registration, title: 'x'.repeat(201) }, 'title'],
    [{ ...registration, description: '' }, 'description'],
    [{ ...registration, severity: 'urgent' }, 'severity'],
    [{ ...registration, filePath: null, lineNumber: 1 }, 'line without file'],
    [{ ...registration, lineNumber: 0 }, 'line minimum'],
    [{ ...registration, lineNumber: 10_000_001 }, 'line maximum'],
    [{ ...registration, evidence: 'x'.repeat(10_001) }, 'evidence'],
    [{ ...registration, recommendation: '' }, 'recommendation'],
    [{ ...registration, origin: 'x'.repeat(201) }, 'origin'],
  ])('rejects invalid registration input: %s', (input, _label) => {
    expect(registerFindingInputSchema.safeParse(input).success).toBe(false);
  });

  test('validates identities, filters, searches and the 100-row limit', () => {
    expect(findingIdentitySchema.parse({ projectId, findingId })).toEqual({ projectId, findingId });
    expect(listFindingsInputSchema.parse({
      projectId,
      severity: 'critical',
      status: 'pending_review',
      query: ' needle ',
      limit: 100,
    })).toMatchObject({ query: 'needle', limit: 100 });
    expect(listFindingsInputSchema.safeParse({ projectId, limit: 101 }).success).toBe(false);
    expect(listFindingsInputSchema.safeParse({ projectId, query: ' ' }).success).toBe(false);
    expect(duplicateSearchInputSchema.safeParse({ projectId, title: '', excludeFindingId: findingId }).success).toBe(false);
  });

  test('requires an editable field beyond an optional edit note', () => {
    expect(updateFindingInputSchema.safeParse({ projectId, findingId, note: 'context' }).success).toBe(false);
    expect(updateFindingInputSchema.parse({
      projectId,
      findingId,
      title: ' New title ',
      recommendation: null,
      note: ' Why ',
    })).toMatchObject({ title: 'New title', recommendation: null, note: 'Why' });
  });

  test('validates status changes and standalone notes', () => {
    expect(updateFindingStatusInputSchema.parse({
      projectId,
      findingId,
      status: 'resolved',
      note: ' fixed ',
    }).note).toBe('fixed');
    expect(updateFindingStatusInputSchema.safeParse({ projectId, findingId, status: 'closed' }).success).toBe(false);
    expect(addFindingNoteInputSchema.safeParse({ projectId, findingId, note: ' ' }).success).toBe(false);
    expect(addFindingNoteInputSchema.parse({ projectId, findingId, note: ' detail ' }).note).toBe('detail');
  });
});
