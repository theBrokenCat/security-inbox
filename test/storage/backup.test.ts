import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import {
  checkSnapshot,
  createBackup,
  listBackups,
  pruneDailyBackups,
  restoreBackup,
} from '../../src/storage/backup.js';
import { downgradeFindingsToV3 } from '../support/legacy-v3.js';
import { testOwnerId } from '../support/owner.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function privateRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-backup-'));
  directories.push(directory);
  return directory;
}

type Fixture = { service: SecurityInboxService; path: string; projectId: string; findingIds: string[] };

// Synthetic inbox with two findings and every kind of history event. The service stays open,
// so the rows live in the WAL and a copy of the main file alone would miss them.
function syntheticInbox(root: string): Fixture {
  const path = join(root, 'inbox.sqlite');
  const service = new SecurityInboxService(path);
  const project = service.createProject({
    ownerId: testOwnerId(service),
    name: 'Synthetic backup project',
    description: 'Synthetic project for backup rehearsals.',
  });
  const first = service.registerFinding({
    projectId: project.id,
    idempotencyKey: 'backup-first',
    title: 'Synthetic finding one',
    description: 'Synthetic description one.',
    severity: 'medium',
    evidence: 'Synthetic evidence one.',
    origin: 'backup-test',
  }).finding;
  const second = service.registerFinding({
    projectId: project.id,
    idempotencyKey: 'backup-second',
    title: 'Synthetic finding two',
    description: 'Synthetic description two.',
    severity: 'medium',
    evidence: 'Synthetic evidence two.',
    origin: 'backup-test',
  }).finding;
  service.updateFinding({ projectId: project.id, findingId: first.id, severity: 'low' });
  service.updateFindingStatus({ projectId: project.id, findingId: first.id, status: 'confirmed' });
  service.addFindingNote({ projectId: project.id, findingId: second.id, note: 'Synthetic note.' });
  return { service, path, projectId: project.id, findingIds: [first.id, second.id] };
}

function rows(path: string, sql: string): unknown[] {
  const database = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

const identityQueries = [
  'SELECT id, slug FROM users ORDER BY id',
  'SELECT id, owner_id FROM projects ORDER BY id',
  'SELECT id, project_id, idempotency_key, request_fingerprint FROM findings ORDER BY id',
  'SELECT id, finding_id, kind, from_status, to_status, note, actor_slug, created_at FROM finding_events ORDER BY id',
];

describe('createBackup', () => {
  test('copies committed rows that still live only in the WAL', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    try {
      const naive = join(root, 'naive-copy.sqlite');
      copyFileSync(fixture.path, naive);
      const naiveFindings = rows(naive, "SELECT name FROM sqlite_schema WHERE name = 'findings'");
      // The main file alone is not a backup: without the WAL it misses the schema and rows.
      expect(naiveFindings).toEqual([]);

      const manifest = await createBackup({
        databasePath: fixture.path,
        backupDirectory: join(root, 'backups'),
        kind: 'daily',
        appVersion: 'abc1234',
        now: new Date('2026-10-13T09:30:00Z'),
      });
      const copy = join(root, 'backups', manifest.file);

      expect(manifest.counts).toEqual({ users: 1, projects: 1, findings: 2, findingEvents: 5 });
      for (const query of identityQueries) expect(rows(copy, query)).toEqual(rows(fixture.path, query));
    } finally {
      fixture.service.close();
    }
  });

  test('publishes a private, self-contained copy named by kind, time, schema and version', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const backupDirectory = join(root, 'backups');

    const manifest = await createBackup({
      databasePath: fixture.path,
      backupDirectory,
      kind: 'pre-update',
      appVersion: '4c7f731',
      now: new Date('2026-10-13T09:30:05Z'),
    });

    expect(manifest.file).toBe('security-inbox-pre-update-20261013T093005Z-schema5-4c7f731.sqlite');
    expect(manifest).toMatchObject({ kind: 'pre-update', schemaVersion: 5, appVersion: '4c7f731' });
    expect(manifest.createdAt).toBe('2026-10-13T09:30:05.000Z');
    expect(readdirSync(backupDirectory).sort()).toEqual([
      'security-inbox-pre-update-20261013T093005Z-schema5-4c7f731.json',
      'security-inbox-pre-update-20261013T093005Z-schema5-4c7f731.sqlite',
    ]);
    const copy = join(backupDirectory, manifest.file);
    expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(statSync(copy.replace(/\.sqlite$/, '.json')).mode & 0o777).toBe(0o600);
    expect(statSync(copy).size).toBe(manifest.bytes);
    expect(JSON.parse(readFileSync(copy.replace(/\.sqlite$/, '.json'), 'utf8'))).toEqual(manifest);
    const database = new BetterSqlite3(copy, { readonly: true });
    try {
      expect(database.pragma('journal_mode', { simple: true })).toBe('delete');
    } finally {
      database.close();
    }
    expect(checkSnapshot(copy)).toEqual({ schemaVersion: 5, counts: manifest.counts });
  });

  test('copies an older schema as it is, without migrating the source or the copy', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    downgradeFindingsToV3(fixture.path);

    const manifest = await createBackup({
      databasePath: fixture.path,
      backupDirectory: join(root, 'backups'),
      kind: 'pre-update',
      appVersion: 'old',
    });

    expect(manifest.schemaVersion).toBe(3);
    expect(rows(fixture.path, 'PRAGMA user_version')).toEqual([{ user_version: 3 }]);
    expect(rows(join(root, 'backups', manifest.file), 'PRAGMA user_version')).toEqual([{ user_version: 3 }]);
  });

  test('publishes nothing when the source cannot be backed up', async () => {
    const root = privateRoot();
    const backupDirectory = join(root, 'backups');
    writeFileSync(join(root, 'not-a-database.sqlite'), 'synthetic text, not SQLite');

    await expect(createBackup({
      databasePath: join(root, 'missing.sqlite'),
      backupDirectory,
      kind: 'daily',
      appVersion: 'abc1234',
    })).rejects.toThrow();
    await expect(createBackup({
      databasePath: join(root, 'not-a-database.sqlite'),
      backupDirectory,
      kind: 'daily',
      appVersion: 'abc1234',
    })).rejects.toThrow();

    expect(existsSync(backupDirectory) ? readdirSync(backupDirectory) : []).toEqual([]);
  });

  test('rejects an application version that cannot be part of a file name', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();

    await expect(createBackup({
      databasePath: fixture.path,
      backupDirectory: join(root, 'backups'),
      kind: 'daily',
      appVersion: '../escape',
    })).rejects.toThrow(/version/i);
    expect(existsSync(join(root, 'backups'))).toBe(false);
  });
});

describe('listBackups and pruneDailyBackups', () => {
  async function dailySeries(root: string, count: number): Promise<{ path: string; directory: string }> {
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const directory = join(root, 'backups');
    for (let day = 1; day <= count; day += 1) {
      await createBackup({
        databasePath: fixture.path,
        backupDirectory: directory,
        kind: 'daily',
        appVersion: 'abc1234',
        now: new Date(Date.UTC(2026, 9, day, 3, 30)),
      });
    }
    return { path: fixture.path, directory };
  }

  test('keeps the newest daily copies and never touches other files', async () => {
    const root = privateRoot();
    const { path, directory } = await dailySeries(root, 9);
    await createBackup({
      databasePath: path,
      backupDirectory: directory,
      kind: 'pre-update',
      appVersion: 'abc1234',
      now: new Date(Date.UTC(2026, 8, 1)),
    });
    writeFileSync(join(directory, 'before-v5-20261004T183337Z.sqlite'), 'manual copy');
    writeFileSync(join(directory, 'security-inbox-daily-20260901T000000Z-schema5-abc1234.sqlite'), 'no manifest');

    const removed = pruneDailyBackups(directory, 7);

    expect(removed).toEqual([
      'security-inbox-daily-20261002T033000Z-schema5-abc1234.sqlite',
      'security-inbox-daily-20261001T033000Z-schema5-abc1234.sqlite',
    ]);
    const remaining = readdirSync(directory);
    expect(remaining).not.toContain('security-inbox-daily-20261001T033000Z-schema5-abc1234.json');
    expect(remaining).toContain('security-inbox-pre-update-20260901T000000Z-schema5-abc1234.sqlite');
    expect(remaining).toContain('before-v5-20261004T183337Z.sqlite');
    expect(remaining).toContain('security-inbox-daily-20260901T000000Z-schema5-abc1234.sqlite');
    const daily = listBackups(directory).filter(({ kind }) => kind === 'daily');
    expect(daily.map(({ createdAt }) => createdAt.slice(0, 10))).toEqual([
      '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03',
    ]);
  });

  test('marks a copy whose bytes no longer match its manifest as invalid and keeps it', async () => {
    const root = privateRoot();
    const { directory } = await dailySeries(root, 2);
    const [newest] = listBackups(directory);
    writeFileSync(join(directory, newest!.file), 'tampered');

    const entries = listBackups(directory);

    expect(entries.map(({ valid }) => valid)).toEqual([false, true]);
    expect(pruneDailyBackups(directory, 1)).toEqual([]);
    expect(existsSync(join(directory, newest!.file))).toBe(true);
  });

  test('refuses a retention that would keep no copy', async () => {
    const root = privateRoot();
    const { directory } = await dailySeries(root, 1);

    expect(() => pruneDailyBackups(directory, 0)).toThrow();
    expect(listBackups(directory)).toHaveLength(1);
  });

  test('lists nothing for a directory that does not exist yet', () => {
    expect(listBackups(join(privateRoot(), 'missing'))).toEqual([]);
  });
});

describe('restoreBackup', () => {
  test('restores into a new path with the same identities and history', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const manifest = await createBackup({
      databasePath: fixture.path,
      backupDirectory: join(root, 'backups'),
      kind: 'daily',
      appVersion: 'abc1234',
    });
    mkdirSync(join(root, 'restore'));
    const target = join(root, 'restore', 'security-inbox.sqlite');

    const restored = await restoreBackup({ backupPath: join(root, 'backups', manifest.file), targetPath: target });

    expect(restored).toEqual({ schemaVersion: 5, counts: manifest.counts });
    for (const query of identityQueries) expect(rows(target, query)).toEqual(rows(fixture.path, query));
    const service = new SecurityInboxService(target);
    try {
      const finding = service.getFinding({ projectId: fixture.projectId, findingId: fixture.findingIds[0]! });
      // Events written in the same millisecond tie on created_at, so compare them as a set.
      expect(finding.history.map(({ kind }) => kind).sort()).toEqual(['created', 'edited', 'status_changed']);
    } finally {
      service.close();
    }
  });

  test('never overwrites an existing database', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const manifest = await createBackup({
      databasePath: fixture.path,
      backupDirectory: join(root, 'backups'),
      kind: 'daily',
      appVersion: 'abc1234',
    });
    const before = readFileSync(fixture.path);

    await expect(restoreBackup({ backupPath: join(root, 'backups', manifest.file), targetPath: fixture.path }))
      .rejects.toThrow(/exists/);
    expect(readFileSync(fixture.path).equals(before)).toBe(true);
  });

  test('refuses a copy that does not match its manifest', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const manifest = await createBackup({
      databasePath: fixture.path,
      backupDirectory: join(root, 'backups'),
      kind: 'daily',
      appVersion: 'abc1234',
    });
    const copy = join(root, 'backups', manifest.file);
    const bytes = readFileSync(copy);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(copy, bytes);
    mkdirSync(join(root, 'restore'));

    await expect(restoreBackup({ backupPath: copy, targetPath: join(root, 'restore', 'inbox.sqlite') }))
      .rejects.toThrow(/manifest/);
    expect(readdirSync(join(root, 'restore'))).toEqual([]);
  });

  test('refuses a schema newer than this build supports', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const future = new BetterSqlite3(fixture.path);
    future.pragma('user_version = 99');
    future.close();
    mkdirSync(join(root, 'restore'));

    await expect(restoreBackup({ backupPath: fixture.path, targetPath: join(root, 'restore', 'inbox.sqlite') }))
      .rejects.toThrow(/schema version 99/);
    expect(readdirSync(join(root, 'restore'))).toEqual([]);
  });
});

describe('checkSnapshot', () => {
  test('fails on a damaged database file', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const manifest = await createBackup({
      databasePath: fixture.path,
      backupDirectory: join(root, 'backups'),
      kind: 'daily',
      appVersion: 'abc1234',
    });
    const copy = join(root, 'backups', manifest.file);
    const bytes = readFileSync(copy);
    // Overwrite the second page, a table b-tree page, with garbage.
    bytes.fill(0x5a, 4096, 4096 + 512);
    writeFileSync(copy, bytes);

    expect(() => checkSnapshot(copy)).toThrow();
  });
});

describe('backup command', () => {
  const cli = join(process.cwd(), 'src/storage/backup-cli.ts');
  const run = (args: string[]) => execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args]);

  test('creates a daily copy, prunes old ones and reports a fresh status without inbox content', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const directory = join(root, 'backups');

    const created = await run(['backup', '--kind', 'daily', '--db', fixture.path, '--dir', directory, '--app-version', 'abc1234']);
    const status = await run(['status', '--dir', directory, '--max-age-hours', '36']);

    expect(JSON.parse(created.stdout)).toMatchObject({ kind: 'daily', schemaVersion: 5, removed: [] });
    expect(JSON.parse(status.stdout)).toMatchObject({ fresh: true, valid: 1, latest: { kind: 'daily' } });
    expect(created.stdout + status.stdout).not.toContain('Synthetic');
  }, 30_000);

  test('status fails when there is no valid copy', async () => {
    const root = privateRoot();

    await expect(run(['status', '--dir', join(root, 'backups'), '--max-age-hours', '36']))
      .rejects.toMatchObject({ code: 1 });
  }, 30_000);

  test('status judges freshness by daily copies and reports leftover partial files', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const directory = join(root, 'backups');
    await createBackup({
      databasePath: fixture.path,
      backupDirectory: directory,
      kind: 'daily',
      appVersion: 'abc1234',
      now: new Date(Date.now() - 72 * 3_600_000),
    });
    // A recent pre-update copy must not hide a daily routine that stopped running.
    await createBackup({ databasePath: fixture.path, backupDirectory: directory, kind: 'pre-update', appVersion: 'abc1234' });
    writeFileSync(join(directory, '.security-inbox-daily-20261001T033000Z-schema5-abc1234.sqlite.0a1b2c.partial'), 'x');

    const failure = await run(['status', '--dir', directory, '--max-age-hours', '36']).catch((error) => error);

    expect(failure).toMatchObject({ code: 1 });
    expect(JSON.parse(failure.stdout)).toMatchObject({
      fresh: false,
      valid: 2,
      partials: 1,
      latest: { kind: 'pre-update' },
      latestDaily: { kind: 'daily' },
    });
  }, 30_000);

  test('rejects an unknown command with the usage status', async () => {
    await expect(run(['frobnicate'])).rejects.toMatchObject({ code: 2 });
  }, 30_000);
});

describe('failure paths', () => {
  test('removes its partial copy when the copied database fails verification', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const broken = new BetterSqlite3(fixture.path);
    broken.pragma('foreign_keys = OFF');
    broken.prepare(`
      INSERT INTO finding_events (id, finding_id, kind, note, created_at)
      VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'note', 'x', ?)
    `).run(new Date().toISOString());
    broken.close();
    const directory = join(root, 'backups');

    await expect(createBackup({ databasePath: fixture.path, backupDirectory: directory, kind: 'daily', appVersion: 'abc1234' }))
      .rejects.toThrow(/foreign_key_check/);
    expect(readdirSync(directory)).toEqual([]);
  });

  test('ignores a manifest whose date is not a date instead of failing the whole directory', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const directory = join(root, 'backups');
    const good = await createBackup({ databasePath: fixture.path, backupDirectory: directory, kind: 'daily', appVersion: 'abc1234' });
    const name = 'security-inbox-daily-20260101T000000Z-schema5-abc1234';
    writeFileSync(join(directory, `${name}.sqlite`), 'synthetic');
    writeFileSync(join(directory, `${name}.json`), JSON.stringify({ ...good, file: `${name}.sqlite`, createdAt: 'not a date' }));

    expect(listBackups(directory).map(({ file }) => file)).toEqual([good.file]);
    expect(pruneDailyBackups(directory, 1)).toEqual([]);
    expect(existsSync(join(directory, `${name}.sqlite`))).toBe(true);
  });

  test('restores a copy without manifest after its own checks, but never next to a WAL', async () => {
    const root = privateRoot();
    const fixture = syntheticInbox(root);
    fixture.service.close();
    const manual = join(root, 'manual-copy.sqlite');
    copyFileSync(fixture.path, manual);
    mkdirSync(join(root, 'restore'));
    const target = join(root, 'restore', 'inbox.sqlite');
    writeFileSync(`${target}-wal`, '');

    await expect(restoreBackup({ backupPath: manual, targetPath: target })).rejects.toThrow(/-wal already exists/);
    rmSync(`${target}-wal`);
    await expect(restoreBackup({ backupPath: manual, targetPath: target }))
      .resolves.toMatchObject({ schemaVersion: 5, counts: { findings: 2 } });
  });
});
