import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AppError, SecurityInboxService } from '../../src/core/service.js';
import { ProjectDirectoryManager } from '../../src/projects/directory-manager.js';
import { testOwnerId } from '../support/owner.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

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
  vi.mocked(homedir).mockReturnValue(root);
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

test('rejects traversal and symlinks outside an explicitly configured root', () => {
  expectCode(() => manager.browse('../outside'), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse(outside), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse('\\etc'), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse('\\definitely-not-present'), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse('outside-link'), 'DIRECTORY_INVALID');
  expectCode(() => manager.browse({ directoryPath: outside }), 'DIRECTORY_INVALID');
});

test('starts in the personal folder and can navigate up and select an unrelated directory', () => {
  const native = new ProjectDirectoryManager(service);
  const initial = native.browse();
  expect(initial.displayPath).toBe(root);
  expect(initial.parentRelativePath).toBe(relative('/', directory));
  expect(native.browse(initial.parentRelativePath!).directories.map(({ name }) => name))
    .toEqual(['outside', 'projects']);

  const chosen = native.browse({ directoryPath: outside });
  expect(chosen.displayPath).toBe(outside);
  const registered = native.register({ ownerId: testOwnerId(service), directoryPath: outside });
  const alias = native.register({ ownerId: testOwnerId(service), directoryPath: join(root, 'outside-link') });
  expect(registered.project.directoryPath).toBe(outside);
  expect(alias).toEqual({ project: registered.project, created: false });
});

test('maps absolute displayed paths and allows selecting the current root folder', () => {
  expect(manager.browse({ directoryPath: '/srv/projects/alpha' }).relativePath).toBe('alpha');
  const first = manager.register({ ownerId: testOwnerId(service), directoryPath: '/srv/projects' });
  expect(first.project).toMatchObject({ name: 'projects', directoryPath: '/srv/projects' });
  expect(manager.register({ ownerId: testOwnerId(service), relativePath: '' }))
    .toEqual({ project: first.project, created: false });
});

test('rejects ambiguous, missing, malformed and unavailable directory selections', () => {
  const native = new ProjectDirectoryManager(service);
  const ownerId = testOwnerId(service);
  writeFileSync(join(outside, 'file.txt'), 'Synthetic fixture');
  expectCode(() => native.register({ ownerId }), 'VALIDATION_ERROR');
  expectCode(() => native.register({ ownerId, relativePath: 'tmp', directoryPath: outside }), 'VALIDATION_ERROR');
  expectCode(() => native.browse({ directoryPath: 'relative/folder' }), 'DIRECTORY_INVALID');
  expectCode(() => native.browse({ directoryPath: `${outside}\0` }), 'DIRECTORY_INVALID');
  expectCode(() => native.browse({ directoryPath: join(outside, 'missing') }), 'DIRECTORY_UNAVAILABLE');
  expectCode(() => native.register({ ownerId, directoryPath: join(outside, 'file.txt') }), 'DIRECTORY_UNAVAILABLE');
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
