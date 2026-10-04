import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { AppError } from '../core/errors.js';
import type {
  DirectoryEntry,
  DirectoryListing,
  DirectorySelection,
  RegisterProjectDirectoryInput,
  RegisterProjectDirectoryResult,
} from '../core/types.js';
import { SecurityInboxService } from '../core/service.js';
import { validationError } from '../core/errors.js';
import {
  browseProjectDirectoriesInputSchema,
  registerProjectDirectoryInputSchema,
} from '../core/validation.js';

type ProjectDirectoryOptions = {
  accessibleRoot?: string;
  displayRoot?: string;
};

type ResolvedDirectory = {
  relativePath: string;
  accessiblePath: string;
  displayPath: string;
};

function normalizedRelativePath(value = ''): string {
  const normalized = value.trim().replaceAll('\\', '/');
  if (
    normalized.includes('\0')
    || normalized.startsWith('/')
    || isAbsolute(normalized)
    || normalized.split('/').includes('..')
  ) {
    throw new AppError('DIRECTORY_INVALID', 'Directory is outside the configured root');
  }
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '').replace(/\/$/, '');
}

export class ProjectDirectoryManager {
  private readonly accessibleRoot: string;
  private readonly displayRoot: string;
  private readonly initialRelativePath: string;

  constructor(
    private readonly service: SecurityInboxService,
    options: ProjectDirectoryOptions = {},
  ) {
    try {
      this.accessibleRoot = realpathSync(options.accessibleRoot ?? parse(process.cwd()).root);
      if (!statSync(this.accessibleRoot).isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new AppError('DIRECTORY_UNAVAILABLE', 'Configured project root is unavailable');
    }
    this.displayRoot = resolve(options.displayRoot ?? this.accessibleRoot);
    this.initialRelativePath = options.accessibleRoot ? '' : relative(this.accessibleRoot, homedir()).replaceAll(sep, '/');
  }

  browse(input: DirectorySelection | string = {}): DirectoryListing {
    const parsed = browseProjectDirectoriesInputSchema.safeParse(typeof input === 'string' ? { relativePath: input } : input);
    if (!parsed.success) throw validationError(parsed.error);
    const current = this.resolveDirectory(this.selectionPath(parsed.data, this.initialRelativePath));
    let entries;
    try {
      entries = readdirSync(current.accessiblePath, { withFileTypes: true });
    } catch {
      throw new AppError('DIRECTORY_UNAVAILABLE', 'Directory is unavailable');
    }
    const seen = new Set<string>();
    const directories = entries
      .filter(({ name }) => !name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name, 'en-US', { sensitivity: 'base' }))
      .flatMap((entry): DirectoryEntry[] => {
        const { name } = entry;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
        const childRelativePath = current.relativePath ? join(current.relativePath, name) : name;
        try {
          const child = this.resolveDirectory(childRelativePath);
          if (seen.has(child.accessiblePath)) return [];
          seen.add(child.accessiblePath);
          return [{ name: basename(child.relativePath), relativePath: child.relativePath, displayPath: child.displayPath }];
        } catch {
          return [];
        }
      });

    return {
      rootDisplayPath: this.displayRoot,
      relativePath: current.relativePath,
      displayPath: current.displayPath,
      parentRelativePath: current.relativePath
        ? (dirname(current.relativePath) === '.' ? '' : dirname(current.relativePath).replaceAll(sep, '/'))
        : null,
      directories,
    };
  }

  register(input: RegisterProjectDirectoryInput): RegisterProjectDirectoryResult {
    const parsed = registerProjectDirectoryInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    // A remote inbox cannot inspect an agent's local filesystem. External paths are
    // reported workspace identities only; they never authorize server-side browsing.
    const displayPath = parsed.data.external
      ? this.externalDirectoryPath(parsed.data.directoryPath!)
      : this.resolveDirectory(this.selectionPath(parsed.data)).displayPath;
    return this.service.registerProjectDirectory({
      name: basename(displayPath) || displayPath,
      description: parsed.data.description || `${parsed.data.external ? 'External workspace' : 'Local project'} at ${displayPath}`,
      directoryPath: displayPath,
      repositoryReference: parsed.data.repositoryReference ?? null,
      ownerId: parsed.data.ownerId,
    });
  }

  private externalDirectoryPath(value: string): string {
    if (value.includes('\0') || !isAbsolute(value)) {
      throw new AppError('DIRECTORY_INVALID', 'Choose an absolute directory path');
    }
    return resolve(value);
  }

  private selectionPath(input: DirectorySelection, fallback = ''): string {
    if (input.directoryPath === undefined) return input.relativePath ?? fallback;
    if (input.directoryPath.includes('\0') || !isAbsolute(input.directoryPath)) {
      throw new AppError('DIRECTORY_INVALID', 'Choose an absolute directory path');
    }
    const displayPath = resolve(input.directoryPath);
    const selected = relative(this.displayRoot, displayPath).replaceAll(sep, '/');
    // Absolute paths use the displayed namespace, including host paths mapped into Docker.
    // The same containment and symlink checks apply to both input forms.
    return normalizedRelativePath(selected);
  }

  private resolveDirectory(value = ''): ResolvedDirectory {
    const relativePath = normalizedRelativePath(value);
    const requestedPath = resolve(this.accessibleRoot, relativePath);
    normalizedRelativePath(relative(this.accessibleRoot, requestedPath).replaceAll(sep, '/'));
    let accessiblePath: string;
    try {
      accessiblePath = realpathSync(requestedPath);
      if (!statSync(accessiblePath).isDirectory()) throw new Error('Not a directory');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('DIRECTORY_UNAVAILABLE', 'Directory is unavailable');
    }
    normalizedRelativePath(relative(this.accessibleRoot, accessiblePath).replaceAll(sep, '/'));
    const canonicalRelativePath = relative(this.accessibleRoot, accessiblePath).replaceAll(sep, '/');
    return {
      relativePath: canonicalRelativePath,
      accessiblePath,
      displayPath: canonicalRelativePath ? resolve(this.displayRoot, canonicalRelativePath) : this.displayRoot,
    };
  }
}
