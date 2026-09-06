import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

export type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

const currentSchemaVersion = 2;
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

export function openDatabase(databasePath?: string): SqliteDatabase {
  const configuredPath = databasePath ?? process.env.SECURITY_INBOX_DB ?? 'data/security-inbox.sqlite';
  const path = configuredPath === ':memory:' ? configuredPath : resolve(configuredPath);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const database = new BetterSqlite3(path);
  try {
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');

    const version = database.pragma('user_version', { simple: true }) as number;
    if (version > currentSchemaVersion) {
      throw new Error(`Unsupported database schema version ${version}; expected at most ${currentSchemaVersion}`);
    }
    enableWriteAheadLogging(database);
    if (version < currentSchemaVersion) {
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
        if (currentVersion !== currentSchemaVersion) {
          throw new Error(`Unsupported database schema version ${currentVersion}; expected ${currentSchemaVersion}`);
        }
      }).immediate();
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
