import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

export type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

const currentSchemaVersion = 3;
const uuidIdCheck = `
  length(id) = 36
  AND id GLOB '????????-????-????-????-????????????'
  AND id NOT GLOB '*[^0-9A-Fa-f-]*'
  AND length(replace(id, '-', '')) = 32
`;

const migrationV1 = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY CHECK (${uuidIdCheck}),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
    repository_reference TEXT CHECK (
      repository_reference IS NULL OR length(trim(repository_reference)) BETWEEN 1 AND 500
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY CHECK (${uuidIdCheck}),
    project_id TEXT NOT NULL REFERENCES projects(id),
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    normalized_title TEXT NOT NULL,
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 10000),
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'informational')),
    status TEXT NOT NULL CHECK (status IN ('pending_review', 'confirmed', 'in_progress', 'resolved', 'dismissed')),
    file_path TEXT CHECK (file_path IS NULL OR length(trim(file_path)) BETWEEN 1 AND 1000),
    line_number INTEGER CHECK (line_number IS NULL OR line_number BETWEEN 1 AND 10000000),
    commit_ref TEXT CHECK (commit_ref IS NULL OR length(trim(commit_ref)) BETWEEN 1 AND 200),
    evidence TEXT NOT NULL CHECK (length(trim(evidence)) BETWEEN 1 AND 10000),
    recommendation TEXT CHECK (
      recommendation IS NULL OR length(trim(recommendation)) BETWEEN 1 AND 5000
    ),
    origin TEXT NOT NULL CHECK (length(trim(origin)) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL CHECK (updated_at >= created_at),
    CHECK (line_number IS NULL OR file_path IS NOT NULL),
    UNIQUE (project_id, idempotency_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS finding_events (
    id TEXT PRIMARY KEY CHECK (${uuidIdCheck}),
    finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('created', 'edited', 'status_changed', 'note')),
    from_status TEXT CHECK (
      from_status IS NULL OR from_status IN ('pending_review', 'confirmed', 'in_progress', 'resolved', 'dismissed')
    ),
    to_status TEXT CHECK (
      to_status IS NULL OR to_status IN ('pending_review', 'confirmed', 'in_progress', 'resolved', 'dismissed')
    ),
    note TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 5000),
    changes_json TEXT CHECK (changes_json IS NULL OR json_valid(changes_json)),
    created_at TEXT NOT NULL,
    CHECK (
      (kind = 'created' AND from_status IS NULL AND to_status = 'pending_review' AND note IS NULL AND changes_json IS NULL)
      OR (kind = 'edited' AND from_status IS NULL AND to_status IS NULL AND changes_json IS NOT NULL)
      OR (
        kind = 'status_changed'
        AND from_status IS NOT NULL
        AND to_status IS NOT NULL
        AND from_status != to_status
        AND (to_status NOT IN ('resolved', 'dismissed') OR note IS NOT NULL)
        AND changes_json IS NULL
      )
      OR (kind = 'note' AND from_status IS NULL AND to_status IS NULL AND note IS NOT NULL AND changes_json IS NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_findings_project_updated
    ON findings(project_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_findings_project_status_updated
    ON findings(project_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_findings_project_severity_updated
    ON findings(project_id, severity, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_finding_events_finding_created
    ON finding_events(finding_id, created_at, id);

  CREATE TRIGGER IF NOT EXISTS prevent_finding_event_update
    BEFORE UPDATE ON finding_events
    BEGIN
      SELECT RAISE(ABORT, 'finding events are append-only');
    END;

  CREATE TRIGGER IF NOT EXISTS prevent_finding_event_delete
    BEFORE DELETE ON finding_events
    BEGIN
      SELECT RAISE(ABORT, 'finding events are append-only');
    END;
`;

const migrationV2 = `
  ALTER TABLE projects ADD COLUMN directory_path TEXT CHECK (
    directory_path IS NULL OR length(trim(directory_path)) BETWEEN 1 AND 4096
  );
  CREATE UNIQUE INDEX idx_projects_directory_path
    ON projects(directory_path) WHERE directory_path IS NOT NULL;
`;

const migrationV3Users = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY CHECK (${uuidIdCheck}),
    slug TEXT NOT NULL UNIQUE CHECK (
      length(slug) BETWEEN 1 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'
    ),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    color TEXT NOT NULL CHECK (
      color IN ('violeta', 'turquesa', 'ambar', 'coral', 'indigo', 'jade')
    ),
    created_at TEXT NOT NULL
  ) STRICT;
`;

// SQLite cannot add a NOT NULL column that carries a REFERENCES clause, so projects is
// rebuilt. legacy_alter_table stops the rename from rewriting the findings foreign key, which
// keeps pointing at the name "projects" and so resolves to the new table.
//
// The old table is renamed away before the new one is created, rather than dropped after it:
// dropping a table that findings still references increments SQLite's deferred-violation
// counter, and nothing decrements it again, so the transaction would fail at COMMIT even
// though foreign_key_check reports a consistent database.
const migrationV3ProjectsRename = `
  ALTER TABLE projects RENAME TO projects_legacy
`;

const migrationV3ProjectsCreate = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY CHECK (${uuidIdCheck}),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
    repository_reference TEXT CHECK (
      repository_reference IS NULL OR length(trim(repository_reference)) BETWEEN 1 AND 500
    ),
    directory_path TEXT CHECK (
      directory_path IS NULL OR length(trim(directory_path)) BETWEEN 1 AND 4096
    ),
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;
`;

const migrationV3ProjectsCopy = `
  INSERT INTO projects (
    id, name, description, repository_reference, directory_path, owner_id, created_at, updated_at
  )
  SELECT id, name, description, repository_reference, directory_path, ?, created_at, updated_at
  FROM projects_legacy
`;

const migrationV3ProjectsSwap = `
  DROP TABLE projects_legacy;

  CREATE UNIQUE INDEX idx_projects_directory_path
    ON projects(directory_path) WHERE directory_path IS NOT NULL;
  CREATE INDEX idx_projects_owner_updated
    ON projects(owner_id, updated_at DESC);
`;

const walRetryDelays = [10, 25, 50, 100, 200];
const walWaitSignal = new Int32Array(new SharedArrayBuffer(4));

function enableWriteAheadLogging(database: SqliteDatabase): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (database.pragma('journal_mode', { simple: true }) === 'wal') return;
      database.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      if (
        !(error instanceof BetterSqlite3.SqliteError)
        || error.code !== 'SQLITE_BUSY'
        || attempt >= walRetryDelays.length
      ) throw error;
      Atomics.wait(walWaitSignal, 0, 0, walRetryDelays[attempt]);
    }
  }
}

export type OpenDatabaseOptions = {
  defaultUserSlug?: string;
};

const defaultUserColor = 'violeta';

// Schema version 3 makes projects.owner_id NOT NULL. A database that already holds projects
// therefore needs one user to inherit them, named by SECURITY_INBOX_DEFAULT_USER. A database
// with no projects needs nothing: the copy moves zero rows.
function backfillOwnerId(
  database: SqliteDatabase,
  defaultUserSlug: string | undefined,
): string | null {
  const projectCount = database.prepare('SELECT count(*) AS total FROM projects_legacy').get() as { total: number };
  if (projectCount.total === 0) return null;

  const slug = (defaultUserSlug ?? '').trim();
  if (!slug) {
    throw new Error(
      'SECURITY_INBOX_DEFAULT_USER is required to migrate existing projects to schema version 3',
    );
  }
  if (slug.length > 40 || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(
      'SECURITY_INBOX_DEFAULT_USER must be 1-40 characters of lowercase letters, digits or hyphens',
    );
  }

  const id = randomUUID();
  database.prepare(`
    INSERT INTO users (id, slug, name, color, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, slug, slug, defaultUserColor, new Date().toISOString());
  return id;
}

export function openDatabase(
  databasePath?: string,
  options: OpenDatabaseOptions = {},
): SqliteDatabase {
  const configuredPath = databasePath ?? process.env.SECURITY_INBOX_DB ?? 'data/security-inbox.sqlite';
  const path = configuredPath === ':memory:' ? configuredPath : resolve(configuredPath);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const database = new BetterSqlite3(path);
  try {
    database.pragma('busy_timeout = 5000');

    const version = database.pragma('user_version', { simple: true }) as number;
    if (version > currentSchemaVersion) {
      throw new Error(`Unsupported database schema version ${version}; expected at most ${currentSchemaVersion}`);
    }
    enableWriteAheadLogging(database);
    if (version < currentSchemaVersion) {
      // Migrations run with foreign keys disabled, as SQLite's own table-rebuild recipe
      // requires: only then does legacy_alter_table stop ALTER TABLE RENAME from rewriting
      // the REFERENCES clauses of other tables. Integrity is proven with foreign_key_check
      // once the transaction has committed.
      // better-sqlite3 enables foreign keys on every connection, so they are turned off here
      // explicitly. PRAGMA foreign_keys is a no-op inside a transaction, hence before it.
      database.pragma('foreign_keys = OFF');
      database.pragma('legacy_alter_table = ON');
      database.transaction(() => {
        let currentVersion = database.pragma('user_version', { simple: true }) as number;
        if (currentVersion === 0) {
          const applicationTable = database.prepare(`
            SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name IN ('projects', 'findings', 'finding_events')
            LIMIT 1
          `).get();
          if (applicationTable) throw new Error('Unversioned or incompatible application schema');
          database.exec(migrationV1);
          database.pragma('user_version = 1');
          currentVersion = 1;
        }
        if (currentVersion === 1) {
          database.exec(migrationV2);
          database.pragma('user_version = 2');
          currentVersion = 2;
        }
        if (currentVersion === 2) {
          try {
            database.exec(migrationV3Users);
            database.exec(migrationV3ProjectsRename);
            database.exec(migrationV3ProjectsCreate);
            const ownerId = backfillOwnerId(
              database,
              options.defaultUserSlug ?? process.env.SECURITY_INBOX_DEFAULT_USER,
            );
            database.prepare(migrationV3ProjectsCopy).run(ownerId);
            database.exec(migrationV3ProjectsSwap);
          } finally {
            database.pragma('legacy_alter_table = OFF');
          }
          database.pragma('user_version = 3');
          currentVersion = 3;
        }
        if (currentVersion !== currentSchemaVersion) {
          throw new Error(`Unsupported database schema version ${currentVersion}; expected ${currentSchemaVersion}`);
        }
      }).immediate();
      database.pragma('legacy_alter_table = OFF');
      const violations = database.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(`Migration to schema version ${currentSchemaVersion} left dangling foreign keys`);
      }
    }

    database.pragma('foreign_keys = ON');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
