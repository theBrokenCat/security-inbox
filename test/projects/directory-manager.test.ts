import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { AppError, SecurityInboxService } from '../../src/core/service.js';
import { ProjectDirectoryManager } from '../../src/projects/directory-manager.js';
import { testOwnerId } from '../support/owner.js';

let directory: string;
let root: string;
let outside: string;
let service: SecurityInboxService;
let manager: ProjectDirectoryManager;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'security-inbox-directories-'));
  root = join(directory, 'projects');
  outside = join(directory, 'outside');
  mkdirSync(join(root, 'Zulu'), { recursive: true });
  mkdirSync(join(root, 'alpha', 'nested'), { recursive: true });
  mkdirSync(join(root, '.hidden'));
  mkdirSync(outside);
  symlinkSync(join(root, 'alpha'), join(root, 'inside-link'));
  symlinkSync(outside, join(root, 'outside-link'));
  service = new SecurityInboxService(join(directory, 'inbox.sqlite'));
  manager = new ProjectDirectoryManager(service, {
    accessibleRoot: root,
    displayRoot: '/srv/projects',
  });
});

afterEach(() => {
  service?.close();
  rmSync(directory, { recursive: true, force: true });
});

function expectCode(run: () => unknown, code: string) {
  try {
    run();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

test('lists visible directories in order and keeps paths relative to the configured root', () => {
  const listing = manager.browse();

  expect(listing).toMatchObject({
    rootDisplayPath: '/srv/projects',
    relativePath: '',
    displayPath: '/srv/projects',
    parentRelativePath: null,
  });
  expect(listing.directories.map(({ name, relativePath, displayPath }) => ({
    name,
    relativePath,
    displayPath,
  }))).toEqual([
    { name: 'alpha', relativePath: 'alpha', displayPath: '/srv/projects/alpha' },
    { name: 'Zulu', relativePath: 'Zulu', displayPath: '/srv/projects/Zulu' },
  ]);
  expect(manager.browse('alpha/nested')).toMatchObject({
    relativePath: 'alpha/nested',
    parentRelativePath: 'alpha',
    directories: [],
  });
});

test('rejects traversal, absolute paths, the root itself and symlinks outside the root', () => {
  expectCode(() => manager.browse('../outside'), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse(outside), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse('\\etc'), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse('\\definitely-not-present'), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse('outside-link'), 'DIRECTORY_INVALID');
  expectCode(() => manager.register({ ownerId: testOwnerId(service), relativePath: '' }), 'DIRECTORY_INVALID');
});

test('derives the name and display path and returns the existing project on retry', () => {
  const first = manager.register({ ownerId: testOwnerId(service), relativePath: 'alpha/nested' });
  const retry = manager.register({ ownerId: testOwnerId(service), relativePath: 'alpha/nested', description: 'Ignored on retry' });

  expect(first.created).toBe(true);
  expect(first.project).toMatchObject({
    name: basename(join(root, 'alpha/nested')),
    description: 'Local project at /srv/projects/alpha/nested',
    directoryPath: '/srv/projects/alpha/nested',
  });
  expect(retry).toEqual({ project: first.project, created: false });
});

test('canonicalizes an internal symlink to the same stored path and project id', () => {
  const real = manager.register({ ownerId: testOwnerId(service), relativePath: 'alpha' });
  const alias = manager.register({ ownerId: testOwnerId(service), relativePath: 'inside-link' });

  expect(alias).toEqual({ project: real.project, created: false });
  expect(real.project.directoryPath).toBe('/srv/projects/alpha');
  expect(service.listProjects()).toHaveLength(1);
});
