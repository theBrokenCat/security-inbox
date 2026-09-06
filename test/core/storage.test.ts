import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import BetterSqlite3 from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { testOwnerId } from '../support/owner.js';

const execFileAsync = promisify(execFile);

function downgradeProjectsToV1(path: string): void {
  const legacy = new BetterSqlite3(path);
  // A real version 1 database has no users table and no owner_id, so both are removed here.
  legacy.pragma('foreign_keys = OFF');
  legacy.pragma('legacy_alter_table = ON');
  legacy.exec('DROP INDEX IF EXISTS idx_projects_directory_path');
  legacy.exec('DROP INDEX IF EXISTS idx_projects_owner_updated');
  legacy.exec('ALTER TABLE projects RENAME TO projects_current');
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      repository_reference TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO projects (id, name, description, repository_reference, created_at, updated_at)
      SELECT id, name, description, repository_reference, created_at, updated_at FROM projects_current;
    DROP TABLE projects_current;
    DROP TABLE IF EXISTS users;
  `);
  legacy.pragma('legacy_alter_table = OFF');
  legacy.pragma('user_version = 1');
  legacy.close();
}

test('configures SQLite and repeats critical invariants with database constraints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-schema-'));
  const path = join(directory, 'inbox.sqlite');
  const service = new SecurityInboxService(path);
  const project = service.createProject({ ownerId: testOwnerId(service), name: 'Project', description: 'Description' });
  const finding = service.registerFinding({
    projectId: project.id,
    idempotencyKey: 'schema-test',
    title: 'Finding',
    description: 'Description',
    severity: 'high',
    evidence: 'Evidence',
    origin: 'test',
  }).finding;
  const database = openDatabase(path);

  try {
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000);

    expect(() => database.prepare(`
      INSERT INTO projects (id, name, description, created_at, updated_at)
      VALUES (?, 'Invalid UUID', 'Description', ?, ?)
    `).run('x'.repeat(36), new Date().toISOString(), new Date().toISOString())).toThrow();

    const insertFinding = database.prepare(`
      INSERT INTO findings (
        id, project_id, idempotency_key, request_fingerprint, title, normalized_title,
        description, severity, status, file_path, line_number, evidence, origin,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();

    expect(() => insertFinding.run(
      randomUUID(), project.id, 'invalid-line', 'a'.repeat(64), 'Other', 'other',
      'Description', 'high', 'pending_review', null, 1, 'Evidence', 'test',
      now, now,
    )).toThrow();
    expect(() => insertFinding.run(
      randomUUID(), project.id, 'schema-test', 'a'.repeat(64), 'Other', 'other',
      'Description', 'high', 'pending_review', null, null, 'Evidence', 'test',
      now, now,
    )).toThrow();
    expect(() => insertFinding.run(
      randomUUID(), randomUUID(), 'foreign-key', 'a'.repeat(64), 'Other', 'other',
      'Description', 'high', 'pending_review', null, null, 'Evidence', 'test',
      now, now,
    )).toThrow();

    expect(() => database.prepare(`
      INSERT INTO finding_events (
        id, finding_id, kind, from_status, to_status, note, changes_json, created_at
      ) VALUES (?, ?, 'status_changed', 'pending_review', 'resolved', NULL, NULL, ?)
    `).run(randomUUID(), finding.id, new Date().toISOString())).toThrow();
    expect(() => database.prepare(`
      UPDATE finding_events SET created_at = created_at WHERE finding_id = ?
    `).run(finding.id)).toThrow();
    expect(() => database.prepare('DELETE FROM finding_events WHERE finding_id = ?').run(finding.id)).toThrow();
  } finally {
    database.close();
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('opens a new database concurrently from two processes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-open-race-'));
  const worker = join(process.cwd(), 'test/core/open-database-worker.ts');

  try {
    for (let round = 0; round < 32; round += 1) {
      const path = join(directory, `round-${round}.sqlite`);
      await Promise.all([
        execFileAsync(process.execPath, ['--import', 'tsx', worker, path]),
        execFileAsync(process.execPath, ['--import', 'tsx', worker, path]),
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test('does not rewrite journal mode when the database is already in WAL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-existing-wal-'));
  const path = join(directory, 'inbox.sqlite');
  const seed = openDatabase(path);
  seed.close();
  const pragma = BetterSqlite3.prototype.pragma;
  let walWrites = 0;
  const pragmaSpy = vi.spyOn(BetterSqlite3.prototype, 'pragma').mockImplementation(function (
    this: SqliteDatabase,
    source,
    options,
  ) {
    if (source === 'journal_mode = WAL') walWrites += 1;
    return pragma.call(this, source, options);
  });

  try {
    openDatabase(path).close();
    expect(walWrites).toBe(0);
  } finally {
    pragmaSpy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retries bounded transient SQLITE_BUSY errors while enabling WAL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-wal-busy-'));
  const path = join(directory, 'inbox.sqlite');
  const pragma = BetterSqlite3.prototype.pragma;
  let walWrites = 0;
  const pragmaSpy = vi.spyOn(BetterSqlite3.prototype, 'pragma').mockImplementation(function (
    this: SqliteDatabase,
    source,
    options,
  ) {
    if (source === 'journal_mode = WAL' && walWrites++ < 3) {
      throw new BetterSqlite3.SqliteError('database is locked', 'SQLITE_BUSY');
    }
    return pragma.call(this, source, options);
  });

  try {
    const database = openDatabase(path);
    try {
      expect(walWrites).toBe(4);
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      database.close();
    }
  } finally {
    pragmaSpy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not retry non-busy WAL errors and closes the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-wal-error-'));
  const path = join(directory, 'inbox.sqlite');
  const expected = new Error('WAL failed');
  const pragma = BetterSqlite3.prototype.pragma;
  let walWrites = 0;
  const pragmaSpy = vi.spyOn(BetterSqlite3.prototype, 'pragma').mockImplementation(function (
    this: SqliteDatabase,
    source,
    options,
  ) {
    if (source === 'journal_mode = WAL') {
      walWrites += 1;
      throw expected;
    }
    return pragma.call(this, source, options);
  });
  const closeSpy = vi.spyOn(BetterSqlite3.prototype, 'close');

  try {
    expect(() => openDatabase(path)).toThrow(expected);
    expect(walWrites).toBe(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  } finally {
    closeSpy.mockRestore();
    pragmaSpy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upgrades a v1 database to the current version without changing existing project ids', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-v1-upgrade-'));
  const path = join(directory, 'inbox.sqlite');
  const service = new SecurityInboxService(path);
  const project = service.createProject({ ownerId: testOwnerId(service), name: 'Existing', description: 'Keep me' });
  service.close();

  downgradeProjectsToV1(path);

  try {
    const upgraded = openDatabase(path, { defaultUserSlug: 'legacy-owner' });
    try {
      expect(upgraded.pragma('user_version', { simple: true })).toBe(3);
      expect((upgraded.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>)
        .map(({ name }) => name)).toContain('directory_path');
      expect(upgraded.prepare('SELECT id, directory_path FROM projects').get()).toEqual({
        id: project.id,
        directory_path: null,
      });
      // The backfilled owner keeps the NOT NULL column satisfied for the pre-existing row.
      expect(upgraded.prepare(`
        SELECT u.slug FROM projects p JOIN users u ON u.id = p.owner_id
      `).get()).toEqual({ slug: 'legacy-owner' });
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rolls back a failed v1 to v2 migration without changing the project', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-v2-rollback-'));
  const path = join(directory, 'inbox.sqlite');
  const service = new SecurityInboxService(path);
  const project = service.createProject({ ownerId: testOwnerId(service), name: 'Existing', description: 'Keep me' });
  service.close();
  downgradeProjectsToV1(path);
  const conflict = new BetterSqlite3(path);
  conflict.exec('CREATE TABLE idx_projects_directory_path (value TEXT) STRICT');
  conflict.close();

  try {
    expect(() => openDatabase(path, { defaultUserSlug: 'legacy-owner' })).toThrow();
    const reopened = new BetterSqlite3(path);
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(1);
      expect((reopened.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>)
        .map(({ name }) => name)).not.toContain('directory_path');
      expect(reopened.prepare('SELECT id FROM projects').get()).toEqual({ id: project.id });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a future schema version without downgrading it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-future-schema-'));
  const path = join(directory, 'inbox.sqlite');
  const seed = new BetterSqlite3(path);
  seed.pragma('user_version = 4');
  seed.close();

  try {
    expect(() => openDatabase(path)).toThrow(/version 4/i);
    const reopened = new BetterSqlite3(path);
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(4);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects an unversioned application schema without partially migrating it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-unversioned-schema-'));
  const path = join(directory, 'inbox.sqlite');
  const seed = new BetterSqlite3(path);
  seed.exec('CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT');
  seed.close();

  try {
    expect(() => openDatabase(path)).toThrow(/unversioned|incompatible/i);
    const reopened = new BetterSqlite3(path);
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(0);
      expect(reopened.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN ('findings', 'finding_events')
      `).all()).toEqual([]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rolls back a failed initial migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-failed-migration-'));
  const path = join(directory, 'inbox.sqlite');
  const seed = new BetterSqlite3(path);
  seed.exec('CREATE TABLE idx_findings_project_updated (value TEXT) STRICT');
  seed.close();

  try {
    expect(() => openDatabase(path)).toThrow();
    const reopened = new BetterSqlite3(path);
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(0);
      expect(reopened.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN ('projects', 'findings', 'finding_events')
      `).all()).toEqual([]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
