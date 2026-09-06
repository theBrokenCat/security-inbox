import { createHash, randomUUID } from 'node:crypto';

import type { ZodType } from 'zod';

import { AppError, validationError } from './errors.js';
import type {
  CreateProjectInput,
  DuplicateCandidate,
  EditableFindingFields,
  FieldChange,
  Finding,
  FindingDetail,
  FindingIdentity,
  FindingStatus,
  FindingSummary,
  ListFindingsInput,
  ListProjectsInput,
  Project,
  ProjectSummary,
  RegisterProjectDirectoryResult,
  RegisterFindingInput,
  RegisterFindingResult,
  RegisterUserResult,
  Scalar,
  TransferProjectInput,
  User,
  UserColor,
} from './types.js';
import { USER_COLORS } from './types.js';
import {
  addFindingNoteInputSchema,
  createProjectInputSchema,
  createUserInputSchema,
  listProjectsInputSchema,
  transferProjectInputSchema,
  userSlugSchema,
  duplicateSearchInputSchema,
  findingIdentitySchema,
  listFindingsInputSchema,
  registerFindingInputSchema,
  resolvedProjectDirectoryInputSchema,
  updateFindingInputSchema,
  updateFindingStatusInputSchema,
} from './validation.js';
import { openDatabase, type OpenDatabaseOptions } from '../storage/database.js';
import { SecurityInboxRepository } from '../storage/repository.js';

export { AppError } from './errors.js';
export type * from './types.js';

const editableKeys = [
  'title',
  'description',
  'severity',
  'filePath',
  'lineNumber',
  'commitRef',
  'evidence',
  'recommendation',
  'origin',
] as const;

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function normalizedTitle(title: string): string {
  return (title.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [])
    .join(' ');
}

function fingerprint(input: RegisterFindingInput): string {
  const canonicalPayload = {
    projectId: input.projectId,
    title: input.title,
    description: input.description,
    severity: input.severity,
    filePath: input.filePath ?? null,
    lineNumber: input.lineNumber ?? null,
    commitRef: input.commitRef ?? null,
    evidence: input.evidence,
    recommendation: input.recommendation ?? null,
    origin: input.origin,
  };
  return createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
}

function timestampAfter(previous?: string): string {
  const current = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isNaN(previousTime) ? current : Math.max(current, previousTime + 1)).toISOString();
}

export class SecurityInboxService {
  private readonly repository: SecurityInboxRepository;

  constructor(databasePath?: string, options?: OpenDatabaseOptions) {
    this.repository = new SecurityInboxRepository(openDatabase(databasePath, options));
  }

  close(): void {
    this.repository.close();
  }

  registerUser(input: { slug: string; name?: string; color?: UserColor }): RegisterUserResult {
    const value = parse(createUserInputSchema, input);
    return this.repository.immediate(() => {
      const existing = this.repository.findUserBySlug(value.slug);
      if (existing) return { user: existing, created: false };
      const user: User = {
        id: randomUUID(),
        slug: value.slug,
        name: value.name ?? value.slug,
        color: value.color ?? USER_COLORS[this.repository.countUsers() % USER_COLORS.length]!,
        createdAt: timestampAfter(),
      };
      this.repository.insertUser(user);
      return { user, created: true };
    });
  }

  listUsers(): User[] {
    return this.repository.listUsers();
  }

  findUserBySlug(slug: string): User | undefined {
    return this.repository.findUserBySlug(slug);
  }

  requireUserBySlug(slug: string): User {
    const user = this.repository.findUserBySlug(slug);
    if (!user) throw new AppError('USER_NOT_FOUND', 'User not found');
    return user;
  }

  createProject(input: CreateProjectInput): Project {
    const value = parse(createProjectInputSchema, input);
    this.requireUser(value.ownerId);
    const now = timestampAfter();
    const project: Project = {
      id: randomUUID(),
      name: value.name,
      description: value.description,
      repositoryReference: value.repositoryReference ?? null,
      directoryPath: null,
      ownerId: value.ownerId,
      createdAt: now,
      updatedAt: now,
    };
    this.repository.insertProject(project);
    return project;
  }

  registerProjectDirectory(input: {
    name: string;
    description: string;
    directoryPath: string;
    ownerId: string;
  }): RegisterProjectDirectoryResult {
    const value = parse(resolvedProjectDirectoryInputSchema, input);
    return this.repository.immediate(() => {
      this.requireUser(value.ownerId);
      const existing = this.repository.findProjectByDirectoryPath(value.directoryPath);
      if (existing) return { project: existing, created: false };
      const now = timestampAfter();
      const project: Project = {
        id: randomUUID(),
        name: value.name,
        description: value.description,
        repositoryReference: null,
        directoryPath: value.directoryPath,
        ownerId: value.ownerId,
        createdAt: now,
        updatedAt: now,
      };
      this.repository.insertProject(project);
      return { project, created: true };
    });
  }

  transferProject(input: TransferProjectInput): Project {
    const value = parse(transferProjectInputSchema, input);
    return this.repository.immediate(() => {
      this.requireProject(value.projectId);
      this.requireUser(value.ownerId);
      const current = this.repository.listProjects({ scope: 'all' })
        .find(({ id }) => id === value.projectId)!;
      this.repository.transferProject(
        value.projectId,
        value.ownerId,
        timestampAfter(current.updatedAt),
      );
      return { ...current, ownerId: value.ownerId };
    });
  }

  // Deleting a user must never orphan a project: owner_id is NOT NULL, so the caller has to
  // hand the projects over first. This is the only deletion the application performs.
  deleteUser(slug: string): void {
    const value = parse(userSlugSchema, slug);
    this.repository.immediate(() => {
      const user = this.requireUserBySlug(value);
      if (this.repository.countProjectsOwnedBy(user.id) > 0) {
        throw new AppError('USER_HAS_PROJECTS', 'User still owns projects');
      }
      this.repository.deleteUser(user.id);
    });
  }

  listProjects(input: ListProjectsInput = {}): ProjectSummary[] {
    return this.repository.listProjects(parse(listProjectsInputSchema, input));
  }

  registerFinding(input: RegisterFindingInput): RegisterFindingResult {
    const value = parse(registerFindingInputSchema, input);
    const requestFingerprint = fingerprint(value);
    const result = this.repository.immediate(() => {
      this.requireProject(value.projectId);
      const existing = this.repository.findIdempotent(value.projectId, value.idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with different input');
        }
        return { findingId: existing.id, created: false };
      }

      const now = timestampAfter();
      const finding: Finding & {
        idempotencyKey: string;
        requestFingerprint: string;
        normalizedTitle: string;
      } = {
        id: randomUUID(),
        projectId: value.projectId,
        idempotencyKey: value.idempotencyKey,
        requestFingerprint,
        title: value.title,
        normalizedTitle: normalizedTitle(value.title),
        description: value.description,
        severity: value.severity,
        status: 'pending_review',
        filePath: value.filePath ?? null,
        lineNumber: value.lineNumber ?? null,
        commitRef: value.commitRef ?? null,
        evidence: value.evidence,
        recommendation: value.recommendation ?? null,
        origin: value.origin,
        createdAt: now,
        updatedAt: now,
      };
      this.repository.insertFinding(finding);
      this.repository.insertEvent({
        id: randomUUID(),
        findingId: finding.id,
        kind: 'created',
        fromStatus: null,
        toStatus: 'pending_review',
        note: null,
        changes: null,
        createdAt: now,
      });
      return { findingId: finding.id, created: true };
    });

    return {
      finding: this.requireFinding({ projectId: value.projectId, findingId: result.findingId }),
      created: result.created,
      possibleDuplicates: this.findPossibleDuplicates({
        projectId: value.projectId,
        title: value.title,
        excludeFindingId: result.findingId,
      }),
    };
  }

  listFindings(input: ListFindingsInput): FindingSummary[] {
    const value = parse(listFindingsInputSchema, input);
    this.requireProject(value.projectId);
    return this.repository.listFindings(value);
  }

  getFinding(input: FindingIdentity): FindingDetail {
    return this.requireFinding(parse(findingIdentitySchema, input));
  }

  updateFinding(input: FindingIdentity & EditableFindingFields): FindingDetail {
    const value = parse(updateFindingInputSchema, input);
    return this.repository.immediate(() => {
      const original = this.requireFinding(value);
      const filePath = value.filePath === undefined ? original.filePath : value.filePath;
      const lineNumber = value.lineNumber === undefined ? original.lineNumber : value.lineNumber;
      if (lineNumber !== null && filePath === null) {
        throw new AppError('VALIDATION_ERROR', 'Invalid input', {
          lineNumber: ['Line number requires a file path'],
        });
      }

      const changes: Record<string, FieldChange> = {};
      for (const key of editableKeys) {
        const next = value[key];
        if (next !== undefined && next !== original[key]) {
          changes[key] = { from: original[key] as Scalar, to: next as Scalar };
        }
      }
      if (Object.keys(changes).length === 0) return original;

      const updatedAt = timestampAfter(original.updatedAt);
      const updated: Finding = {
        ...original,
        title: value.title ?? original.title,
        description: value.description ?? original.description,
        severity: value.severity ?? original.severity,
        filePath,
        lineNumber,
        commitRef: value.commitRef === undefined ? original.commitRef : value.commitRef,
        evidence: value.evidence ?? original.evidence,
        recommendation: value.recommendation === undefined ? original.recommendation : value.recommendation,
        origin: value.origin ?? original.origin,
        updatedAt,
      };
      this.repository.updateFinding(updated, normalizedTitle(updated.title));
      this.repository.insertEvent({
        id: randomUUID(),
        findingId: original.id,
        kind: 'edited',
        fromStatus: null,
        toStatus: null,
        note: value.note ?? null,
        changes,
        createdAt: updatedAt,
      });
      return this.requireFinding(value);
    });
  }

  updateFindingStatus(input: FindingIdentity & { status: FindingStatus; note?: string }): FindingDetail {
    const parsed = updateFindingStatusInputSchema.safeParse(input);
    if (!parsed.success) {
      const emptyTerminalNote = (input.status === 'resolved' || input.status === 'dismissed')
        && typeof input.note === 'string'
        && input.note.trim() === ''
        && parsed.error.issues.every(({ path }) => path.length === 1 && path[0] === 'note');
      if (emptyTerminalNote) {
        throw new AppError('TERMINAL_NOTE_REQUIRED', 'A note is required for a terminal status');
      }
      throw validationError(parsed.error);
    }
    const value = parsed.data;
    return this.repository.immediate(() => {
      const original = this.requireFinding(value);
      if (original.status === value.status) {
        throw new AppError('NO_STATUS_CHANGE', 'Finding already has that status');
      }
      if ((value.status === 'resolved' || value.status === 'dismissed') && !value.note) {
        throw new AppError('TERMINAL_NOTE_REQUIRED', 'A note is required for a terminal status');
      }

      const updatedAt = timestampAfter(original.updatedAt);
      this.repository.updateStatus(value.projectId, value.findingId, value.status, updatedAt);
      this.repository.insertEvent({
        id: randomUUID(),
        findingId: value.findingId,
        kind: 'status_changed',
        fromStatus: original.status,
        toStatus: value.status,
        note: value.note ?? null,
        changes: null,
        createdAt: updatedAt,
      });
      return this.requireFinding(value);
    });
  }

  addFindingNote(input: FindingIdentity & { note: string }): FindingDetail {
    const value = parse(addFindingNoteInputSchema, input);
    return this.repository.immediate(() => {
      const original = this.requireFinding(value);
      const updatedAt = timestampAfter(original.updatedAt);
      this.repository.touchFinding(value.projectId, value.findingId, updatedAt);
      this.repository.insertEvent({
        id: randomUUID(),
        findingId: value.findingId,
        kind: 'note',
        fromStatus: null,
        toStatus: null,
        note: value.note,
        changes: null,
        createdAt: updatedAt,
      });
      return this.requireFinding(value);
    });
  }

  findPossibleDuplicates(input: {
    projectId: string;
    title: string;
    excludeFindingId?: string;
  }): DuplicateCandidate[] {
    const value = parse(duplicateSearchInputSchema, input);
    this.requireProject(value.projectId);
    const target = normalizedTitle(value.title);
    const targetTokens = new Set(target.split(' ').filter(Boolean));

    // ponytail: linear per-project scan; add FTS only if measured project size makes it slow.
    return this.repository.duplicateRows(value.projectId, value.excludeFindingId)
      .flatMap((row): DuplicateCandidate[] => {
        if (row.normalizedTitle === target) {
          return [{
            id: row.id,
            projectId: row.projectId,
            title: row.title,
            severity: row.severity,
            status: row.status,
            updatedAt: row.updatedAt,
            match: 'exact',
            score: 1,
          }];
        }
        if (targetTokens.size < 2) return [];
        const candidateTokens = new Set(row.normalizedTitle.split(' ').filter(Boolean));
        const shared = [...targetTokens].filter((token) => candidateTokens.has(token)).length;
        if (shared < 2) return [];
        const score = shared / new Set([...targetTokens, ...candidateTokens]).size;
        if (score < 0.6) return [];
        return [{
          id: row.id,
          projectId: row.projectId,
          title: row.title,
          severity: row.severity,
          status: row.status,
          updatedAt: row.updatedAt,
          match: 'similar',
          score,
        }];
      })
      .sort((left, right) => {
        const matchOrder = (left.match === 'exact' ? 0 : 1) - (right.match === 'exact' ? 0 : 1);
        return matchOrder || right.score - left.score || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
      })
      .slice(0, 5);
  }

  private requireUser(userId: string): void {
    if (!this.repository.findUserById(userId)) {
      throw new AppError('USER_NOT_FOUND', 'User not found');
    }
  }

  private requireProject(projectId: string): void {
    if (!this.repository.hasProject(projectId)) {
      throw new AppError('PROJECT_NOT_FOUND', 'Project not found');
    }
  }

  private requireFinding(identity: FindingIdentity): FindingDetail {
    const finding = this.repository.getFinding(identity.projectId, identity.findingId);
    if (!finding) throw new AppError('FINDING_NOT_FOUND', 'Finding not found');
    return finding;
  }
}
