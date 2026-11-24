import BetterSqlite3 from 'better-sqlite3';

// Reconstruct the pre-capture schema for upgrade tests. Old schemas require evidence and
// a classified severity, and their history has no author columns.
export function downgradeFindingsToV3(path: string): void {
  const database = new BetterSqlite3(path);
  try {
    database.pragma('foreign_keys = OFF');
    database.pragma('legacy_alter_table = ON');
    const { sql } = database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'findings'")
      .get() as { sql: string };
    const legacySchema = sql.replace(/^CREATE TABLE findings\b/, 'CREATE TABLE findings_v3')
      .replace(", 'unclassified'", '')
      .replace('length(trim(evidence)) <= 10000', 'length(trim(evidence)) BETWEEN 1 AND 10000');
    database.exec(legacySchema);
    database.exec(`
      INSERT INTO findings_v3 SELECT * FROM findings;
      DROP TABLE findings;
      ALTER TABLE findings_v3 RENAME TO findings;
      CREATE INDEX idx_findings_project_updated ON findings(project_id, updated_at DESC);
      CREATE INDEX idx_findings_project_status_updated ON findings(project_id, status, updated_at DESC);
      CREATE INDEX idx_findings_project_severity_updated ON findings(project_id, severity, updated_at DESC);
      ALTER TABLE finding_events DROP COLUMN actor_name;
      ALTER TABLE finding_events DROP COLUMN actor_slug;
    `);
    database.pragma('user_version = 3');
  } finally {
    database.close();
  }
}

// Rebuilds a version 2 database: projects without owner_id, no users table.
export function downgradeToV2(path: string): void {
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
