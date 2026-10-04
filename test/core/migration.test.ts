import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import { openDatabase } from '../../src/storage/database.js';
import { downgradeFindingsToV3 } from '../support/legacy-v3.js';

const directories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-migration-'));
  directories.push(directory);
  return join(directory, 'inbox.sqlite');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Rebuilds a version 2 database: projects without owner_id, no users table.
function downgradeToV2(path: string): void {
  downgradeFindingsToV3(path);
  const legacy = new BetterSqlite3(path);
  legacy.pragma('foreign_keys = OFF');
  legacy.exec(`
    CREATE TABLE projects_v2 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      repository_reference TEXT,
      directory_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO projects_v2 (id, name, description, repository_reference, directory_path, created_at, updated_at)
      SELECT id, name, description, repository_reference, directory_path, created_at, updated_at FROM projects;
    DROP TABLE projects;
  `);
  legacy.pragma('legacy_alter_table = ON');
  legacy.exec('ALTER TABLE projects_v2 RENAME TO projects');
  legacy.pragma('legacy_alter_table = OFF');
  legacy.exec(`
    CREATE UNIQUE INDEX idx_projects_directory_path
      ON projects(directory_path) WHERE directory_path IS NOT NULL;
    DROP TABLE users;
  `);
  legacy.pragma('user_version = 2');
  legacy.close();
}

function seedOneProjectWithFinding(path: string): { projectId: string; findingId: string } {
  const service = new SecurityInboxService(path);
  const owner = service.registerUser({ slug: 'seed-owner' }).user;
  const project = service.createProject({
    name: 'Legacy project',
    description: 'Registered before schema version 3.',
    ownerId: owner.id,
  });
  const finding = service.registerFinding({
    projectId: project.id,
    idempotencyKey: 'migration-fixture',
    title: 'Legacy finding',
    description: 'Recorded before schema version 3.',
    severity: 'high',
    evidence: 'Synthetic evidence.',
    origin: 'migration-test',
  });
  service.close();
  return { projectId: project.id, findingId: finding.finding.id };
}

test('assigns pre-existing projects to the configured default user', () => {
  const path = temporaryDatabase();
  const { projectId, findingId } = seedOneProjectWithFinding(path);
  downgradeToV2(path);

  const service = new SecurityInboxService(path, { defaultUserSlug: 'guzman' });
  const projects = service.listProjects();

  expect(projects).toHaveLength(1);
  expect(projects[0]!.id).toBe(projectId);
  expect(projects[0]!.owner.slug).toBe('guzman');
  // The history survives the table rebuild.
  expect(service.getFinding({ projectId, findingId }).history).toHaveLength(1);
  service.close();
});

test('keeps owner_id NOT NULL after the rebuild', () => {
  const path = temporaryDatabase();
  seedOneProjectWithFinding(path);
  downgradeToV2(path);

  const service = new SecurityInboxService(path, { defaultUserSlug: 'guzman' });
  service.close();

  const database = openDatabase(path);
  const columns = database.prepare('PRAGMA table_info(projects)').all() as Array<{
    name: string;
    notnull: number;
  }>;
  const ownerColumn = columns.find(({ name }) => name === 'owner_id');
  expect(ownerColumn?.notnull).toBe(1);
  expect(database.pragma('foreign_key_check')).toEqual([]);
  database.close();
});

test('refuses to migrate existing projects without a default user and rolls back cleanly', () => {
  const path = temporaryDatabase();
  const { projectId, findingId } = seedOneProjectWithFinding(path);
  downgradeToV2(path);

  expect(() => new SecurityInboxService(path, { defaultUserSlug: '' }))
    .toThrow(/SECURITY_INBOX_DEFAULT_USER/);

  // The failed attempt must leave no half-migrated state behind.
  const database = new BetterSqlite3(path);
  const tables = (database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table'",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  expect(database.pragma('user_version', { simple: true })).toBe(2);
  expect(tables).not.toContain('users');
  expect(tables).not.toContain('projects_legacy');
  expect((database.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>)
    .map(({ name }) => name)).not.toContain('owner_id');
  expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(database.pragma('foreign_key_check')).toEqual([]);
  expect(database.prepare('SELECT count(*) AS total FROM projects').get()).toEqual({ total: 1 });
  database.close();

  // And a later attempt with a usable slug still migrates, history intact.
  const service = new SecurityInboxService(path, { defaultUserSlug: 'guzman' });
  expect(service.listProjects()[0]!.owner.slug).toBe('guzman');
  expect(service.getFinding({ projectId, findingId }).history).toHaveLength(1);
  service.close();
});

test('normalises the default user slug the way the rest of the application does', () => {
  const path = temporaryDatabase();
  seedOneProjectWithFinding(path);
  downgradeToV2(path);

  // A capitalised environment value must land on the same slug the web would have created,
  // otherwise the migration, the web and MCP each disagree about who the owner is.
  const service = new SecurityInboxService(path, { defaultUserSlug: '  Guzman  ' });
  expect(service.listProjects()[0]!.owner.slug).toBe('guzman');
  expect(service.requireUserBySlug('guzman').id).toBe(service.listProjects()[0]!.ownerId);
  service.close();
});

test('migrates an empty database without needing a default user', () => {
  const path = temporaryDatabase();
  const service = new SecurityInboxService(path);
  service.close();

  const database = openDatabase(path);
  expect(database.pragma('user_version', { simple: true })).toBe(5);
  database.close();
});

test('upgrades v3 without changing existing findings, retries or append-only history', () => {
  const path = temporaryDatabase();
  const { projectId, findingId } = seedOneProjectWithFinding(path);
  const previous = new SecurityInboxService(path);
  previous.updateFindingStatus({ projectId, findingId, status: 'confirmed', note: 'Reviewed before upgrade' });
  previous.addFindingNote({ projectId, findingId, note: 'Legacy context' });
  const original = previous.getFinding({ projectId, findingId });
  previous.close();
  downgradeFindingsToV3(path);
  const legacy = new BetterSqlite3(path);
  expect(() => legacy.prepare('UPDATE findings SET evidence = ? WHERE id = ?').run('', findingId)).toThrow();
  expect(() => legacy.prepare('UPDATE findings SET severity = ? WHERE id = ?').run('unclassified', findingId)).toThrow();
  legacy.close();

  const service = new SecurityInboxService(path);
  try {
    expect(service.getFinding({ projectId, findingId })).toEqual(original);
    expect(original.history.every(event => event.actor === null)).toBe(true);
    const retry = service.registerFinding({ projectId, idempotencyKey: 'migration-fixture', title: 'Legacy finding', description: 'Recorded before schema version 3.', severity: 'high', evidence: 'Synthetic evidence.', origin: 'migration-test' });
    expect(retry.created).toBe(false);
    expect(retry.finding.id).toBe(findingId);
    const fresh = service.registerFinding({ projectId, idempotencyKey: 'after-upgrade', title: 'Functional issue', description: 'A brief observation' }, { slug: 'new-agent', name: 'New agent' });
    expect(fresh.finding).toMatchObject({ severity: 'unclassified', evidence: '' });
    expect(fresh.finding.history[0]!.actor?.slug).toBe('new-agent');
    const database = openDatabase(path);
    try {
      expect(database.pragma('foreign_key_check')).toEqual([]);
      expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(() => database.prepare('DELETE FROM finding_events WHERE finding_id = ?').run(findingId)).toThrow(/append-only/);
      expect(() => database.prepare('UPDATE finding_events SET note = ? WHERE finding_id = ?').run('Changed', findingId)).toThrow(/append-only/);
    } finally { database.close(); }
  } finally { service.close(); }
  const reopened = new SecurityInboxService(path);
  expect(reopened.getFinding({ projectId, findingId })).toEqual(original);
  reopened.close();
});

test('rolls back v4 when integrity validation fails, keeping the v3 schema and history', () => {
  const path = temporaryDatabase();
  const { projectId, findingId } = seedOneProjectWithFinding(path);
  downgradeFindingsToV3(path);
  const legacy = new BetterSqlite3(path);
  legacy.pragma('foreign_keys = OFF');
  legacy.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  legacy.close();
  expect(() => openDatabase(path)).toThrow(/dangling foreign keys/);
  const database = new BetterSqlite3(path);
  try {
    expect(database.pragma('user_version', { simple: true })).toBe(3);
    expect((database.prepare('PRAGMA table_info(finding_events)').all() as Array<{ name: string }>).map(c => c.name)).not.toContain('actor_slug');
    expect(database.prepare('SELECT id FROM findings').get()).toEqual({ id: findingId });
    expect(database.prepare('SELECT count(*) AS total FROM finding_events').get()).toEqual({ total: 1 });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'findings_legacy'").get()).toBeUndefined();
  } finally { database.close(); }
});

test('upgrades v4 to v5 keeping every finding and letting pre-v5 retries stay idempotent', () => {
  const path = temporaryDatabase();
  const service = new SecurityInboxService(path);
  const ownerId = service.registerUser({ slug: 'guzman' }).user.id;
  const project = service.createProject({ ownerId, name: 'Legacy', description: 'Before external references' });
  const registration = {
    projectId: project.id,
    idempotencyKey: 'pre-v5',
    title: 'Missing rate limit on login',
    description: 'Unlimited attempts are accepted.',
  };
  const original = service.registerFinding(registration).finding;
  service.close();

  // Rebuild what a v4 file looks like: no external_ref column, no index, user_version 4.
  const legacy = new BetterSqlite3(path);
  legacy.exec('DROP INDEX idx_findings_project_external_ref; ALTER TABLE findings DROP COLUMN external_ref;');
  legacy.pragma('user_version = 4');
  legacy.close();

  const upgraded = new SecurityInboxService(path);
  try {
    const database = openDatabase(path);
    expect(database.pragma('user_version', { simple: true })).toBe(5);
    database.close();
    expect(upgraded.getFinding({ projectId: project.id, findingId: original.id })).toEqual({ ...original, externalRef: null });
    const retry = upgraded.registerFinding(registration);
    expect(retry.created).toBe(false);
    expect(retry.finding.id).toBe(original.id);
  } finally {
    upgraded.close();
  }
});
