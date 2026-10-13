import {
  checkSnapshot,
  countPartials,
  createBackup,
  listBackups,
  pruneDailyBackups,
  restoreBackup,
  type BackupEntry,
  type BackupKind,
} from './backup.js';

// Operator entry point for copies of the inbox. Output is one JSON object with file names,
// versions and counts: never inbox content. Exit status 1 means the operation or check failed.

const usage = `Usage:
  backup --kind daily|pre-update --dir <directory> [--db <path>] [--app-version <version>] [--keep <copies>]
  status --dir <directory> [--max-age-hours <hours>]
  verify <database-file>
  restore <backup-file> <new-database-path>
`;

class UsageError extends Error {}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return value;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new UsageError(`${name} is required`);
  return value;
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${name} must be a positive number`);
  return parsed;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'backup': {
      const kind = required(args, '--kind');
      if (kind !== 'daily' && kind !== 'pre-update') throw new UsageError('--kind must be daily or pre-update');
      const backupDirectory = required(args, '--dir');
      const keep = positiveNumber(option(args, '--keep') ?? '7', '--keep');
      const manifest = await createBackup({
        databasePath: option(args, '--db') ?? process.env.SECURITY_INBOX_DB ?? 'data/security-inbox.sqlite',
        backupDirectory,
        kind: kind as BackupKind,
        appVersion: option(args, '--app-version') ?? process.env.SECURITY_INBOX_APP_VERSION ?? 'unknown',
      });
      // Only after a verified copy exists, and never for pre-update copies.
      const removed = kind === 'daily' ? pruneDailyBackups(backupDirectory, keep) : [];
      print({ ...manifest, removed });
      return 0;
    }
    case 'status': {
      const maxAgeHours = positiveNumber(option(args, '--max-age-hours') ?? '36', '--max-age-hours');
      const backupDirectory = required(args, '--dir');
      const entries = listBackups(backupDirectory);
      const valid = entries.filter((entry) => entry.valid);
      // Freshness follows the daily routine: a recent pre-update copy must not hide a timer
      // that stopped running.
      const latestDaily = valid.find(({ kind }) => kind === 'daily');
      const ageHours = latestDaily ? (Date.now() - Date.parse(latestDaily.createdAt)) / 3_600_000 : null;
      const fresh = ageHours !== null && ageHours <= maxAgeHours;
      const summary = (entry: BackupEntry | undefined) => {
        if (!entry) return null;
        const { valid: _valid, ...manifest } = entry;
        return manifest;
      };
      print({
        fresh,
        valid: valid.length,
        invalid: entries.length - valid.length,
        partials: countPartials(backupDirectory),
        ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
        latestDaily: summary(latestDaily),
        latest: summary(valid[0]),
      });
      return fresh ? 0 : 1;
    }
    case 'verify': {
      const [file] = args;
      if (!file) throw new UsageError('verify needs a database file');
      print(checkSnapshot(file));
      return 0;
    }
    case 'restore': {
      const [backupPath, targetPath] = args;
      if (!backupPath || !targetPath) throw new UsageError('restore needs a backup file and a new database path');
      print(await restoreBackup({ backupPath, targetPath }));
      return 0;
    }
    default:
      throw new UsageError(command ? `Unknown command ${command}` : 'A command is required');
  }
}

process.umask(0o077);
try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof UsageError) process.stderr.write(usage);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
