import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AppError } from '../core/errors.js';
import type {
  DirectoryEntry,
  DirectoryListing,
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

  constructor(
    private readonly service: SecurityInboxService,
    options: ProjectDirectoryOptions = {},
  ) {
    try {
      this.accessibleRoot = realpathSync(options.accessibleRoot ?? process.cwd());
      if (!statSync(this.accessibleRoot).isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new AppError('DIRECTORY_UNAVAILABLE', 'Configured project root is unavailable');
    }
    this.displayRoot = resolve(options.displayRoot ?? this.accessibleRoot);
  }

  browse(relativePath = ''): DirectoryListing {
    const parsed = browseProjectDirectoriesInputSchema.safeParse({ relativePath });
    if (!parsed.success) throw validationError(parsed.error);
    const current = this.resolveDirectory(parsed.data.relativePath);
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
    const selected = this.resolveDirectory(parsed.data.relativePath);
    if (!selected.relativePath) {
      throw new AppError('DIRECTORY_INVALID', 'Select a directory below the configured root');
    }
    return this.service.registerProjectDirectory({
      name: basename(selected.relativePath),
      description: parsed.data.description || `Local project at ${selected.displayPath}`,
      directoryPath: selected.displayPath,
    });
  }

  private resolveDirectory(value = ''): ResolvedDirectory {
    const relativePath = normalizedRelativePath(value);
    const requestedPath = resolve(this.accessibleRoot, relativePath);
    if (requestedPath !== this.accessibleRoot && !requestedPath.startsWith(`${this.accessibleRoot}${sep}`)) {
      throw new AppError('DIRECTORY_INVALID', 'Directory is outside the configured root');
    }
    let accessiblePath: string;
    try {
      accessiblePath = realpathSync(requestedPath);
      if (!statSync(accessiblePath).isDirectory()) throw new Error('Not a directory');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('DIRECTORY_UNAVAILABLE', 'Directory is unavailable');
    }
    if (accessiblePath !== this.accessibleRoot && !accessiblePath.startsWith(`${this.accessibleRoot}${sep}`)) {
      throw new AppError('DIRECTORY_INVALID', 'Directory is outside the configured root');
    }
    const canonicalRelativePath = relative(this.accessibleRoot, accessiblePath).replaceAll(sep, '/');
    return {
      relativePath: canonicalRelativePath,
      accessiblePath,
      displayPath: canonicalRelativePath ? resolve(this.displayRoot, canonicalRelativePath) : this.displayRoot,
    };
  }
}
