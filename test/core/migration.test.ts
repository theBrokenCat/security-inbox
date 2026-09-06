import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import { openDatabase } from '../../src/storage/database.js';

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

test('refuses to migrate existing projects without a default user', () => {
  const path = temporaryDatabase();
  seedOneProjectWithFinding(path);
  downgradeToV2(path);

  expect(() => new SecurityInboxService(path, { defaultUserSlug: '' }))
    .toThrow(/SECURITY_INBOX_DEFAULT_USER/);
});

test('migrates an empty database without needing a default user', () => {
  const path = temporaryDatabase();
  const service = new SecurityInboxService(path);
  service.close();

  const database = openDatabase(path);
  expect(database.pragma('user_version', { simple: true })).toBe(3);
  database.close();
});
