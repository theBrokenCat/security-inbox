import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AppError, SecurityInboxService } from '../../src/core/service.js';
import type { FindingStatus, RegisterFindingInput, Severity } from '../../src/core/types.js';
import { testOwnerId } from '../support/owner.js';

const execFileAsync = promisify(execFile);

let directory: string;
let databasePath: string;
let service: SecurityInboxService;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'security-inbox-'));
  databasePath = join(directory, 'inbox.sqlite');
  service = new SecurityInboxService(databasePath);
});

afterEach(() => {
  service.close();
  rmSync(directory, { recursive: true, force: true });
});

function expectCode(run: () => unknown, code: string) {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

function registration(
  projectId: string,
  idempotencyKey: string,
  overrides: Partial<RegisterFindingInput> = {},
): RegisterFindingInput {
  return {
    projectId,
    idempotencyKey,
    title: 'SQL injection in users endpoint',
    description: 'Unsanitized user input reaches a query.',
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

describe('SecurityInboxService', () => {
  test('creates stable UUID projects and summarizes their open findings', () => {
    const zebra = service.createProject({ ownerId: testOwnerId(service),
      name: ' Zebra ',
      description: ' Main app ',
      repositoryReference: ' git@example.test:zebra.git ',
    });
    const alpha = service.createProject({ ownerId: testOwnerId(service), name: 'Alpha', description: 'API' });

    expect(zebra.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(zebra).toMatchObject({
      name: 'Zebra',
      description: 'Main app',
      repositoryReference: 'git@example.test:zebra.git',
      directoryPath: null,
    });
    expect(zebra.createdAt).toBe(zebra.updatedAt);

    const severities: Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];
    const statuses: FindingStatus[] = ['pending_review', 'confirmed', 'in_progress', 'resolved', 'dismissed'];
    severities.forEach((severity, index) => {
      const finding = service.registerFinding(registration(zebra.id, `count-${index}`, {
        title: `${severity} finding`,
        severity,
      })).finding;
      if (statuses[index] !== 'pending_review') {
        service.updateFindingStatus({
          projectId: zebra.id,
          findingId: finding.id,
          status: statuses[index]!,
          ...(statuses[index] === 'resolved' || statuses[index] === 'dismissed'
            ? { note: 'terminal reason' }
            : {}),
        });
      }
    });

    expect(service.listProjects().find(({ id }) => id === zebra.id)).toMatchObject({
      openCounts: { critical: 1, high: 1, medium: 1, low: 0, informational: 0 },
      openTotal: 3,
      pendingReviewCount: 1,
    });
    expect(service.listProjects().find(({ id }) => id === alpha.id)?.openTotal).toBe(0);
  });

  test('registers a project directory once and returns the stable project on retry', () => {
    const first = service.registerProjectDirectory({ ownerId: testOwnerId(service),
      name: 'checkout',
      description: 'Selected directory',
      directoryPath: '/srv/projects/checkout',
    });
    const retry = service.registerProjectDirectory({ ownerId: testOwnerId(service),
      name: 'ignored-on-retry',
      description: 'Ignored on retry',
      directoryPath: '/srv/projects/checkout',
    });

    expect(first.created).toBe(true);
    expect(first.project).toMatchObject({
      name: 'checkout',
      directoryPath: '/srv/projects/checkout',
    });
    expect(retry).toEqual({ project: first.project, created: false });
    expect(service.listProjects()).toHaveLength(1);
  });

  test('serializes the same directory path across two database connections', async () => {
    const input = JSON.stringify({
      name: 'shared',
      description: 'Concurrent project',
      directoryPath: '/srv/projects/shared',
    });
    const worker = join(process.cwd(), 'test/core/register-project-worker.ts');
    const run = () => execFileAsync(process.execPath, ['--import', 'tsx', worker, databasePath, input]);

    const results = (await Promise.all([run(), run()]))
      .map(({ stdout }) => JSON.parse(stdout) as { created: boolean; id: string });

    expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(service.listProjects()).toHaveLength(1);
  }, 15_000);

  test('registers all fields, isolates projects, filters, searches and returns detail history', () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'One', description: 'First' });
    const otherProject = service.createProject({ ownerId: testOwnerId(service), name: 'Two', description: 'Second' });
    const created = service.registerFinding(registration(project.id, 'one'));
    const second = service.registerFinding(registration(project.id, 'two', {
      title: 'Weak cookie flags',
      severity: 'medium',
      origin: 'scanner',
    })).finding;

    expect(created.created).toBe(true);
    const { idempotencyKey: _idempotencyKey, ...expectedFinding } = registration(project.id, 'one');
    expect(created.finding).toMatchObject({
      ...expectedFinding,
      status: 'pending_review',
    });
    expect(created.finding.history.map(({ kind }) => kind)).toEqual(['created']);
    expect(created.finding.history[0]).toMatchObject({
      findingId: created.finding.id,
      kind: 'created',
      fromStatus: null,
      toStatus: 'pending_review',
      note: null,
      changes: null,
    });

    expect(service.listFindings({ projectId: project.id })).toHaveLength(2);
    expect(service.listFindings({ projectId: otherProject.id })).toEqual([]);
    expect(service.listFindings({ projectId: project.id, severity: 'high' }).map(({ id }) => id)).toEqual([
      created.finding.id,
    ]);
    expect(service.listFindings({ projectId: project.id, status: 'pending_review', query: ' COOKIE ' })
      .map(({ id }) => id)).toEqual([second.id]);
    expect(service.listFindings({ projectId: project.id, limit: 1 })).toHaveLength(1);

    expect(service.getFinding({ projectId: project.id, findingId: created.finding.id })).toEqual(created.finding);
    expectCode(
      () => service.getFinding({ projectId: otherProject.id, findingId: created.finding.id }),
      'FINDING_NOT_FOUND',
    );
    expectCode(() => service.listFindings({ projectId: crypto.randomUUID() }), 'PROJECT_NOT_FOUND');
  });

  test('edits only mutable fields, records changes and uses the edit note on the same event', () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Project', description: 'Description' });
    const original = service.registerFinding(registration(project.id, 'edit')).finding;

    const edited = service.updateFinding({
      projectId: project.id,
      findingId: original.id,
      title: 'New title',
      description: 'New description',
      severity: 'critical',
      filePath: 'src/new.ts',
      lineNumber: 9,
      commitRef: 'def456',
      evidence: 'New evidence',
      recommendation: 'New recommendation',
      origin: 'follow-up',
      note: 'Reviewed with the team',
    });

    expect(edited).toMatchObject({
      id: original.id,
      projectId: project.id,
      title: 'New title',
      description: 'New description',
      severity: 'critical',
      status: 'pending_review',
      filePath: 'src/new.ts',
      lineNumber: 9,
      commitRef: 'def456',
      evidence: 'New evidence',
      recommendation: 'New recommendation',
      origin: 'follow-up',
      createdAt: original.createdAt,
    });
    expect(edited.updatedAt > original.updatedAt).toBe(true);
    expect(edited.history).toHaveLength(2);
    expect(edited.history[1]).toMatchObject({
      kind: 'edited',
      note: 'Reviewed with the team',
      changes: {
        title: { from: original.title, to: 'New title' },
        description: { from: original.description, to: 'New description' },
        severity: { from: 'high', to: 'critical' },
        filePath: { from: 'src/users.ts', to: 'src/new.ts' },
        lineNumber: { from: 42, to: 9 },
        commitRef: { from: 'abc123', to: 'def456' },
        evidence: { from: original.evidence, to: 'New evidence' },
        recommendation: { from: original.recommendation, to: 'New recommendation' },
        origin: { from: 'manual-review', to: 'follow-up' },
      },
    });
    expectCode(
      () => service.updateFinding({ projectId: project.id, findingId: original.id, note: 'note only' }),
      'VALIDATION_ERROR',
    );
    expectCode(
      () => service.updateFinding({ projectId: project.id, findingId: original.id, filePath: null }),
      'VALIDATION_ERROR',
    );
    const cleared = service.updateFinding({
      projectId: project.id,
      findingId: original.id,
      filePath: null,
      lineNumber: null,
      recommendation: null,
      commitRef: null,
    });
    expect(cleared).toMatchObject({ filePath: null, lineNumber: null, recommendation: null, commitRef: null });
  });

  test('leaves timestamps and history unchanged when an edit has no real field changes', () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Project', description: 'Description' });
    const original = service.registerFinding(registration(project.id, 'no-op-edit')).finding;

    const unchanged = service.updateFinding({
      projectId: project.id,
      findingId: original.id,
      title: ` ${original.title} `,
      recommendation: original.recommendation,
      note: 'This must not create an event',
    });

    expect(unchanged).toEqual(original);
  });

  test('records only fields whose values actually changed in a partial edit', () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Project', description: 'Description' });
    const original = service.registerFinding(registration(project.id, 'partial-edit')).finding;

    const edited = service.updateFinding({
      projectId: project.id,
      findingId: original.id,
      title: original.title,
      description: original.description,
      severity: 'critical',
      recommendation: original.recommendation,
    });

    expect(edited.updatedAt > original.updatedAt).toBe(true);
    expect(edited.history.at(-1)).toMatchObject({
      kind: 'edited',
      changes: { severity: { from: 'high', to: 'critical' } },
    });
    expect(Object.keys(edited.history.at(-1)?.changes ?? {})).toEqual(['severity']);
  });

  test('adds notes and atomically requires a fresh note for terminal status changes', () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Project', description: 'Description' });
    const original = service.registerFinding(registration(project.id, 'status')).finding;

    expectCode(
      () => service.updateFindingStatus({ projectId: project.id, findingId: original.id, status: 'resolved' }),
      'TERMINAL_NOTE_REQUIRED',
    );
    expectCode(
      () => service.updateFindingStatus({
        projectId: project.id,
        findingId: original.id,
        status: 'resolved',
        note: '   ',
      }),
      'TERMINAL_NOTE_REQUIRED',
    );
    expect(service.getFinding({ projectId: project.id, findingId: original.id })).toEqual(original);

    const withPriorNote = service.addFindingNote({
      projectId: project.id,
      findingId: original.id,
      note: 'Old context',
    });
    expect(withPriorNote.status).toBe('pending_review');
    expect(withPriorNote.history.at(-1)).toMatchObject({ kind: 'note', note: 'Old context' });
    expectCode(
      () => service.updateFindingStatus({ projectId: project.id, findingId: original.id, status: 'dismissed' }),
      'TERMINAL_NOTE_REQUIRED',
    );
    expect(service.getFinding({ projectId: project.id, findingId: original.id })).toEqual(withPriorNote);

    const confirmed = service.updateFindingStatus({
      projectId: project.id,
      findingId: original.id,
      status: 'confirmed',
    });
    expect(confirmed.history.at(-1)).toMatchObject({
      kind: 'status_changed',
      fromStatus: 'pending_review',
      toStatus: 'confirmed',
      note: null,
    });
    expectCode(
      () => service.updateFindingStatus({ projectId: project.id, findingId: original.id, status: 'confirmed' }),
      'NO_STATUS_CHANGE',
    );

    const resolved = service.updateFindingStatus({
      projectId: project.id,
      findingId: original.id,
      status: 'resolved',
      note: 'Fixed and verified',
    });
    expect(resolved.updatedAt > confirmed.updatedAt).toBe(true);
    expect(resolved.history.at(-1)).toMatchObject({
      kind: 'status_changed',
      fromStatus: 'confirmed',
      toStatus: 'resolved',
      note: 'Fixed and verified',
    });
  });

  test('returns the same finding for an identical retry and rejects key reuse with another payload', () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Project', description: 'Description' });
    const first = service.registerFinding(registration(project.id, 'same-key'));
    const retry = service.registerFinding(registration(project.id, ' same-key ', { title: ' SQL injection in users endpoint ' }));

    expect(retry.created).toBe(false);
    expect(retry.finding).toEqual(first.finding);
    expect(service.listFindings({ projectId: project.id })).toHaveLength(1);
    expectCode(
      () => service.registerFinding(registration(project.id, 'same-key', { evidence: 'Different evidence' })),
      'IDEMPOTENCY_CONFLICT',
    );
    expect(service.listFindings({ projectId: project.id })).toHaveLength(1);
    expect(service.getFinding({ projectId: project.id, findingId: first.finding.id }).history).toHaveLength(1);
  });

  test('serializes the same idempotency key across two database connections', async () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Project', description: 'Description' });
    const input = JSON.stringify(registration(project.id, 'concurrent'));
    const worker = join(process.cwd(), 'test/core/register-worker.ts');
    const run = () => execFileAsync(process.execPath, ['--import', 'tsx', worker, databasePath, input]);

    const outputs = await Promise.all([run(), run()]);
    const results = outputs.map(({ stdout }) => JSON.parse(stdout) as { created: boolean; id: string });

    expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(service.listFindings({ projectId: project.id })).toHaveLength(1);
  }, 15_000);

  test('finds deterministic exact and similar candidates without merging across projects', () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Project', description: 'Description' });
    const otherProject = service.createProject({ ownerId: testOwnerId(service), name: 'Other', description: 'Description' });
    const exact = service.registerFinding(registration(project.id, 'exact', {
      title: 'Secret leaked in public logs',
      severity: 'critical',
    })).finding;
    const similar = service.registerFinding(registration(project.id, 'similar', {
      title: 'Secret leaked public logs today',
      severity: 'medium',
    })).finding;
    service.registerFinding(registration(project.id, 'unrelated', { title: 'Weak TLS configuration' }));
    service.registerFinding(registration(otherProject.id, 'other', { title: 'secret leaked in public logs' }));

    expect(service.findPossibleDuplicates({
      projectId: project.id,
      title: ' SECRET leaked in public logs! ',
    })).toEqual([
      expect.objectContaining({ id: exact.id, match: 'exact', score: 1 }),
      expect.objectContaining({ id: similar.id, match: 'similar', score: 4 / 6 }),
    ]);
    expect(service.findPossibleDuplicates({ projectId: project.id, title: 'Secret' })).toEqual([]);

    const result = service.registerFinding(registration(project.id, 'new', {
      title: 'Secret leaked in public logs',
    }));
    expect(result.created).toBe(true);
    expect(result.finding.id).not.toBe(exact.id);
    expect(result.possibleDuplicates[0]).toMatchObject({ id: exact.id, match: 'exact' });
    expect(result.possibleDuplicates.every(({ id }) => id !== result.finding.id)).toBe(true);
  });

  test('persists projects, findings and ordered events after closing and reopening the file', () => {
    const project = service.createProject({ ownerId: testOwnerId(service), name: 'Persistent', description: 'Stored on disk' });
    const finding = service.registerFinding(registration(project.id, 'persist')).finding;
    service.addFindingNote({ projectId: project.id, findingId: finding.id, note: 'Durable note' });
    service.updateFindingStatus({ projectId: project.id, findingId: finding.id, status: 'resolved', note: 'Done' });
    service.close();

    service = new SecurityInboxService(databasePath);
    const reopened = service.getFinding({ projectId: project.id, findingId: finding.id });

    expect(service.listProjects()[0]?.id).toBe(project.id);
    expect(reopened.id).toBe(finding.id);
    expect(reopened.status).toBe('resolved');
    expect(reopened.history.map(({ kind }) => kind)).toEqual(['created', 'note', 'status_changed']);
    expect(reopened.history.map(({ note }) => note)).toEqual([null, 'Durable note', 'Done']);
  });

  test('converts invalid input and missing records to public AppError codes', () => {
    expectCode(() => service.createProject({ ownerId: testOwnerId(service), name: '', description: 'x' }), 'VALIDATION_ERROR');
    const missingProject = crypto.randomUUID();
    expectCode(() => service.registerFinding(registration(missingProject, 'missing')), 'PROJECT_NOT_FOUND');
    expectCode(
      () => service.getFinding({ projectId: missingProject, findingId: crypto.randomUUID() }),
      'FINDING_NOT_FOUND',
    );
  });
});

describe('users and project ownership', () => {
  test('registers users idempotently by slug and assigns distinct colors', () => {
    const first = service.registerUser({ slug: 'Ada ', name: 'Ada' });
    const repeat = service.registerUser({ slug: 'ada', name: 'Ignored on retry' });

    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(repeat.user.id).toBe(first.user.id);
    expect(repeat.user.name).toBe('Ada');
    expect(service.listUsers()).toHaveLength(1);

    // Without an explicit color, users cycle through the palette instead of colliding.
    const second = service.registerUser({ slug: 'bruno' }).user;
    expect(second.color).not.toBe(first.user.color);
    expect(second.name).toBe('bruno');
  });

  test('rejects slugs that would not survive a cookie, a URL or a class name', () => {
    expectCode(() => service.registerUser({ slug: 'con espacios' }), 'VALIDATION_ERROR');
    expectCode(() => service.registerUser({ slug: 'acentuación' }), 'VALIDATION_ERROR');
    expectCode(() => service.registerUser({ slug: '' }), 'VALIDATION_ERROR');
    expectCode(() => service.registerUser({ slug: 'a'.repeat(41) }), 'VALIDATION_ERROR');
  });

  test('scopes the project list to one owner without hiding it from the full list', () => {
    const ada = service.registerUser({ slug: 'ada' }).user;
    const bruno = service.registerUser({ slug: 'bruno' }).user;
    service.createProject({ name: 'Ada one', description: 'Hers', ownerId: ada.id });
    service.createProject({ name: 'Bruno one', description: 'His', ownerId: bruno.id });

    expect(service.listProjects({ scope: 'mine', ownerId: ada.id }).map(({ name }) => name))
      .toEqual(['Ada one']);
    expect(service.listProjects({ scope: 'all' }).map(({ name }) => name).sort())
      .toEqual(['Ada one', 'Bruno one']);
    expect(service.listProjects().map(({ name }) => name).sort()).toEqual(['Ada one', 'Bruno one']);

    // Every summary carries its owner, so the full list can label what belongs to whom.
    expect(service.listProjects({ scope: 'all' }).map(({ owner }) => owner.slug).sort())
      .toEqual(['ada', 'bruno']);
  });

  test('refuses a scoped list without an owner and a project without a known one', () => {
    expectCode(() => service.listProjects({ scope: 'mine' }), 'VALIDATION_ERROR');
    expectCode(
      () => service.createProject({
        name: 'Orphan',
        description: 'No owner',
        ownerId: '3f7d1a9c-7e64-4a1f-9b0e-2c5d8f4a6b31',
      }),
      'USER_NOT_FOUND',
    );
    expectCode(() => service.requireUserBySlug('ghost'), 'USER_NOT_FOUND');
  });

  test('reports the worst open severity per project and ignores closed findings', () => {
    const ownerId = testOwnerId(service);
    const project = service.createProject({ name: 'Mixed', description: 'Mixed', ownerId });
    service.registerFinding(registration(project.id, 'worst-high', { severity: 'high' }));
    const critical = service.registerFinding(
      registration(project.id, 'worst-critical', { severity: 'critical' }),
    ).finding;

    expect(service.listProjects({ scope: 'all' })[0]!.worstOpenSeverity).toBe('critical');

    service.updateFindingStatus({
      projectId: project.id,
      findingId: critical.id,
      status: 'resolved',
      note: 'Checked against the rebuilt query and confirmed fixed.',
    });

    const [summary] = service.listProjects({ scope: 'all' });
    expect(summary!.worstOpenSeverity).toBe('high');
    expect(summary!.openCounts.critical).toBe(0);
  });
});

describe('ordering, transfer and user removal', () => {
  test('orders projects by their latest project or finding activity, regardless of severity', () => {
    vi.useFakeTimers();
    try {
      const ownerId = testOwnerId(service);
      vi.setSystemTime('2026-09-07T08:00:00.000Z');
      const critical = service.createProject({ name: 'Critical old', description: 'x', ownerId });
      const criticalFinding = service.registerFinding(
        registration(critical.id, 'critical-old', { severity: 'critical' }),
      ).finding;
      const editable = service.createProject({ name: 'Editable', description: 'x', ownerId });
      const editableFinding = service.registerFinding(registration(editable.id, 'editable')).finding;

      vi.setSystemTime('2026-09-07T09:00:00.000Z');
      const clean = service.createProject({ name: 'Clean recent', description: 'x', ownerId });
      expect(service.listProjects({ scope: 'all' }).map(({ name }) => name))
        .toEqual(['Clean recent', 'Critical old', 'Editable']);
      expect(service.listProjects({ scope: 'all' })[0]!.lastActivityAt).toBe(clean.updatedAt);

      vi.setSystemTime('2026-09-07T10:00:00.000Z');
      const noted = service.addFindingNote({
        projectId: critical.id,
        findingId: criticalFinding.id,
        note: 'Fresh evidence from the latest review.',
      });
      expect(service.listProjects({ scope: 'all' })[0]).toMatchObject({
        id: critical.id,
        lastActivityAt: noted.updatedAt,
      });

      vi.setSystemTime('2026-09-07T11:00:00.000Z');
      const edited = service.updateFinding({
        projectId: editable.id,
        findingId: editableFinding.id,
        evidence: 'New evidence from a later audit.',
      });
      expect(service.listProjects({ scope: 'all' })[0]).toMatchObject({
        id: editable.id,
        lastActivityAt: edited.updatedAt,
      });

      vi.setSystemTime('2026-09-07T12:00:00.000Z');
      const changed = service.updateFindingStatus({
        projectId: critical.id,
        findingId: criticalFinding.id,
        status: 'confirmed',
      });
      expect(service.listProjects({ scope: 'all' })[0]).toMatchObject({
        id: critical.id,
        lastActivityAt: changed.updatedAt,
      });

      vi.setSystemTime('2026-09-07T13:00:00.000Z');
      const registered = service.registerFinding(registration(clean.id, 'new-on-clean')).finding;
      expect(service.listProjects({ scope: 'all' })[0]).toMatchObject({
        id: clean.id,
        lastActivityAt: registered.updatedAt,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('breaks activity ties by case-insensitive name and UUID', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime('2026-09-07T08:00:00.000Z');
      const ownerId = testOwnerId(service);
      const projects = [
        service.createProject({ name: 'zeta', description: 'x', ownerId }),
        service.createProject({ name: 'Alpha', description: 'x', ownerId }),
        service.createProject({ name: 'alpha', description: 'x', ownerId }),
      ];
      const expected = [...projects].sort((left, right) => (
        left.name.localeCompare(right.name, 'en', { sensitivity: 'base' })
        || left.id.localeCompare(right.id)
      ));

      expect(service.listProjects({ scope: 'all' }).map(({ id }) => id))
        .toEqual(expected.map(({ id }) => id));
      expect(service.listProjects({ scope: 'all' }).every(
        (project) => project.lastActivityAt === project.updatedAt,
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('transfers a project between owners and keeps its findings', () => {
    const ada = service.registerUser({ slug: 'ada' }).user;
    const bruno = service.registerUser({ slug: 'bruno' }).user;
    const project = service.createProject({ name: 'Handover', description: 'x', ownerId: ada.id });
    service.registerFinding(registration(project.id, 'kept', { severity: 'medium' }));

    const moved = service.transferProject({ projectId: project.id, ownerId: bruno.id });

    expect(moved.ownerId).toBe(bruno.id);
    expect(service.listProjects({ scope: 'mine', ownerId: ada.id })).toHaveLength(0);
    expect(service.listProjects({ scope: 'mine', ownerId: bruno.id })[0]!.owner.slug).toBe('bruno');
    expect(service.listFindings({ projectId: project.id })).toHaveLength(1);
    expect(new Date(moved.updatedAt).getTime())
      .toBeGreaterThan(new Date(project.updatedAt).getTime() - 1);
  });

  test('refuses to delete a user that still owns projects', () => {
    const ada = service.registerUser({ slug: 'ada' }).user;
    const bruno = service.registerUser({ slug: 'bruno' }).user;
    const project = service.createProject({ name: 'Held', description: 'x', ownerId: ada.id });

    expectCode(() => service.deleteUser('ada'), 'USER_HAS_PROJECTS');
    expect(service.findUserBySlug('ada')).toBeDefined();

    // Handing the project over is what unblocks the removal; owner_id is NOT NULL and must
    // never be left pointing at nobody.
    service.transferProject({ projectId: project.id, ownerId: bruno.id });
    service.deleteUser('ada');

    expect(service.findUserBySlug('ada')).toBeUndefined();
    expect(service.listProjects({ scope: 'all' })[0]!.owner.slug).toBe('bruno');
    expectCode(() => service.deleteUser('nadie'), 'USER_NOT_FOUND');
  });
});
