import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import { currentSchemaVersion } from './database.js';

// Consistent copies through SQLite's online backup API: it reads one snapshot through the WAL,
// which copying the main file of a live database does not. Sources are opened read-only and are
// never migrated, so a copy taken before an update keeps the schema the old version wrote.
//
// A copy counts as valid only once its manifest exists and still matches its bytes. Retention
// removes nothing else: manual copies, files without a manifest and pre-update copies stay.

export type BackupKind = 'daily' | 'pre-update';

export type DatabaseCounts = { users: number; projects: number; findings: number; findingEvents: number };

export type SnapshotCheck = { schemaVersion: number; counts: DatabaseCounts };

export type BackupManifest = {
  format: 1;
  file: string;
  kind: BackupKind;
  createdAt: string;
  schemaVersion: number;
  appVersion: string;
  bytes: number;
  sha256: string;
  counts: DatabaseCounts;
};

export type BackupEntry = BackupManifest & { valid: boolean };

const appVersionPattern = /^[0-9A-Za-z._-]{1,40}$/;
const backupNamePattern = /^security-inbox-(daily|pre-update)-(\d{8}T\d{6}Z)-schema(\d+)-([0-9A-Za-z._-]{1,40})\.json$/;
const busyTimeoutMs = 5000;

function openReadOnly(path: string): BetterSqlite3.Database {
  const database = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  return database;
}

function hasTable(database: BetterSqlite3.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

// users only exists from schema version 3, so an older copy counts it as empty.
function countRows(database: BetterSqlite3.Database, table: string): number {
  if (!hasTable(database, table)) return 0;
  return (database.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
}

/** Proves a database file is intact and returns its schema version and row counts only. */
export function checkSnapshot(path: string): SnapshotCheck {
  const database = openReadOnly(path);
  try {
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`integrity_check failed for ${basename(path)}`);
    }
    if ((database.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error(`foreign_key_check failed for ${basename(path)}`);
    }
    const schemaVersion = database.pragma('user_version', { simple: true }) as number;
    if (schemaVersion < 1 || !hasTable(database, 'projects')) {
      throw new Error(`${basename(path)} is not a Security Inbox database`);
    }
    return {
      schemaVersion,
      counts: {
        users: countRows(database, 'users'),
        projects: countRows(database, 'projects'),
        findings: countRows(database, 'findings'),
        findingEvents: countRows(database, 'finding_events'),
      },
    };
  } finally {
    database.close();
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function syncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function manifestPathFor(databaseFile: string): string {
  return databaseFile.replace(/\.sqlite$/, '.json');
}

// Writes the copy beside its final name, then links it into place: link() fails instead of
// replacing a file that already exists, so publication never overwrites anything.
async function copyDatabase(sourcePath: string, partialPath: string): Promise<void> {
  const source = openReadOnly(sourcePath);
  try {
    await source.backup(partialPath);
  } finally {
    source.close();
  }
  // The copy inherits WAL from the source header; a rollback journal keeps it one file.
  const copy = new BetterSqlite3(partialPath);
  try {
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
  chmodSync(partialPath, 0o600);
  syncFile(partialPath);
}

function publish(partialPath: string, finalPath: string): void {
  linkSync(partialPath, finalPath);
  unlinkSync(partialPath);
}

// Unique per run, so two runs never share a temporary file; status reports any left by a killed run.
function temporaryPath(directory: string, name: string, suffix = 'partial'): string {
  return join(directory, `.${name}.${randomBytes(6).toString('hex')}.${suffix}`);
}

function removePartial(path: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

/** Temporary files of interrupted backups, which never count as copies. */
export function countPartials(directory: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((name) => /^\.security-inbox-.*\.partial$/.test(name)).length;
}

export async function createBackup(options: {
  databasePath: string;
  backupDirectory: string;
  kind: BackupKind;
  appVersion: string;
  now?: Date;
}): Promise<BackupManifest> {
  if (!appVersionPattern.test(options.appVersion)) {
    throw new Error('The application version must be 1-40 letters, digits, dots, hyphens or underscores');
  }
  if (options.kind !== 'daily' && options.kind !== 'pre-update') throw new Error(`Unknown backup kind ${options.kind}`);
  const source = openReadOnly(options.databasePath);
  let schemaVersion: number;
  try {
    schemaVersion = source.pragma('user_version', { simple: true }) as number;
  } finally {
    source.close();
  }
  if (schemaVersion < 1) throw new Error('The source is not a Security Inbox database');

  const now = options.now ?? new Date();
  const file = `security-inbox-${options.kind}-${compactTimestamp(now)}-schema${schemaVersion}-${options.appVersion}.sqlite`;
  mkdirSync(options.backupDirectory, { recursive: true, mode: 0o700 });
  const finalPath = join(options.backupDirectory, file);
  const partialPath = temporaryPath(options.backupDirectory, file);
  const manifestPath = manifestPathFor(finalPath);
  const manifestPartial = temporaryPath(options.backupDirectory, basename(manifestPath));
  if (existsSync(finalPath)) throw new Error(`${file} already exists`);

  try {
    await copyDatabase(options.databasePath, partialPath);
    const check = checkSnapshot(partialPath);
    if (check.schemaVersion !== schemaVersion) {
      throw new Error(`The copy reports schema version ${check.schemaVersion}, expected ${schemaVersion}`);
    }
    const manifest: BackupManifest = {
      format: 1,
      file,
      kind: options.kind,
      createdAt: now.toISOString(),
      schemaVersion,
      appVersion: options.appVersion,
      bytes: statSync(partialPath).size,
      sha256: sha256(partialPath),
      counts: check.counts,
    };
    publish(partialPath, finalPath);
    writeFileSync(manifestPartial, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    syncFile(manifestPartial);
    publish(manifestPartial, manifestPath);
    return manifest;
  } catch (error) {
    removePartial(partialPath);
    removePartial(manifestPartial);
    throw error;
  }
}

function readManifest(directory: string, name: string): BackupManifest | null {
  const match = backupNamePattern.exec(name);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, name), 'utf8'));
  } catch {
    return null;
  }
  const manifest = parsed as Partial<BackupManifest>;
  const file = name.replace(/\.json$/, '.sqlite');
  if (
    manifest.format !== 1
    || manifest.file !== file
    || manifest.kind !== match[1]
    || manifest.schemaVersion !== Number(match[3])
    || manifest.appVersion !== match[4]
    || typeof manifest.createdAt !== 'string'
    || Number.isNaN(Date.parse(manifest.createdAt))
    || compactTimestamp(new Date(manifest.createdAt)) !== match[2]
    || typeof manifest.bytes !== 'number'
    || typeof manifest.sha256 !== 'string'
    || typeof manifest.counts !== 'object'
  ) return null;
  return manifest as BackupManifest;
}

/** Copies made by this routine, newest first; invalid ones are listed but never pruned. */
export function listBackups(directory: string): BackupEntry[] {
  if (!existsSync(directory)) return [];
  const entries: BackupEntry[] = [];
  for (const name of readdirSync(directory)) {
    const manifest = readManifest(directory, name);
    if (!manifest) continue;
    const databasePath = join(directory, manifest.file);
    const valid = existsSync(databasePath)
      && statSync(databasePath).size === manifest.bytes
      && sha256(databasePath) === manifest.sha256;
    entries.push({ ...manifest, valid });
  }
  return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.file.localeCompare(left.file));
}

/** Removes valid daily copies beyond the newest `keep`; returns the removed database files. */
export function pruneDailyBackups(directory: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('Retention must keep at least one copy');
  const expired = listBackups(directory).filter(({ kind, valid }) => kind === 'daily' && valid).slice(keep);
  for (const entry of expired) {
    // The manifest goes first: an interrupted removal leaves an unlisted file, never a listed
    // copy without its database.
    unlinkSync(join(directory, manifestPathFor(entry.file)));
    unlinkSync(join(directory, entry.file));
  }
  return expired.map(({ file }) => file);
}

export async function restoreBackup(options: { backupPath: string; targetPath: string }): Promise<SnapshotCheck> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(`${options.targetPath}${suffix}`)) {
      throw new Error(`${basename(options.targetPath)}${suffix} already exists; restore only into a new path`);
    }
  }
  const manifestPath = manifestPathFor(options.backupPath);
  if (options.backupPath.endsWith('.sqlite') && existsSync(manifestPath)) {
    const manifest = readManifest(dirname(manifestPath), basename(manifestPath));
    if (!manifest || statSync(options.backupPath).size !== manifest.bytes || sha256(options.backupPath) !== manifest.sha256) {
      throw new Error(`${basename(options.backupPath)} does not match its manifest`);
    }
  }
  const source = checkSnapshot(options.backupPath);
  if (source.schemaVersion > currentSchemaVersion) {
    throw new Error(
      `The copy has schema version ${source.schemaVersion}; this build supports at most ${currentSchemaVersion}`,
    );
  }

  const partialPath = temporaryPath(dirname(options.targetPath), basename(options.targetPath), 'restore-partial');
  try {
    await copyDatabase(options.backupPath, partialPath);
    const restored = checkSnapshot(partialPath);
    if (JSON.stringify(restored) !== JSON.stringify(source)) throw new Error('The restored copy differs from the backup');
    publish(partialPath, options.targetPath);
    return restored;
  } catch (error) {
    removePartial(partialPath);
    throw error;
  }
}
