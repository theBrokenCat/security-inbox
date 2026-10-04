import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { normalizeRepositoryReference } from '../../src/core/repository-reference.js';
import { SecurityInboxService } from '../../src/core/service.js';
import { ProjectDirectoryManager } from '../../src/projects/directory-manager.js';
import { testOwnerId } from '../support/owner.js';

describe('repository reference normalisation', () => {
  test.each([
    ['git@github.com:theBrokenCat/Security-Inbox.git', 'github.com/thebrokencat/security-inbox'],
    ['https://github.com/theBrokenCat/security-inbox.git', 'github.com/thebrokencat/security-inbox'],
    ['https://github.com/theBrokenCat/security-inbox/', 'github.com/thebrokencat/security-inbox'],
    ['ssh://git@github.com:22/theBrokenCat/security-inbox', 'github.com/thebrokencat/security-inbox'],
    ['git+ssh://git@gitlab.example.com/group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
    ['github.com/theBrokenCat/security-inbox', 'github.com/thebrokencat/security-inbox'],
    ['demo://security-inbox-api', 'demo://security-inbox-api'],
    ['https://git.example.com:8443/team/app.git', 'git.example.com:8443/team/app'],
    ['https://github.com:443/acme/app', 'github.com/acme/app'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeRepositoryReference(raw)).toBe(expected);
  });

  test.each([
    (token: string) => `git+https://user:${token}@github.com/acme/app.git`,
    (token: string) => `svn+ssh://user:${token}@svn.example.com/acme/app`,
    (token: string) => `ftp://user:${token}@files.example.com/app`,
    (token: string) => `https://oauth2:${token}@[bad/acme/app`,
    (token: string) => `user:${token}@github.com/acme/app`,
    (token: string) => `${token}@github.com:acme/app.git`,
  ])('never keeps a credential: %s', (spell) => {
    const token = `${'ghp_'}${'c'.repeat(36)}`;
    const normalized = normalizeRepositoryReference(spell(token));
    expect(normalized.toLowerCase()).not.toContain(token.toLowerCase());
    expect(normalized).not.toContain('@');
  });

  test('drops credentials embedded in an HTTPS remote', () => {
    const token = `${'ghp_'}${'a'.repeat(36)}`;
    const normalized = normalizeRepositoryReference(`https://someone:${token}@github.com/acme/app.git`);
    expect(normalized).toBe('github.com/acme/app');
    expect(normalized).not.toContain(token);
  });
});

describe('projects identified by repository', () => {
  let directory: string;
  let service: SecurityInboxService;
  let directories: ProjectDirectoryManager;
  let ownerId: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'security-inbox-repo-'));
    service = new SecurityInboxService(join(directory, 'inbox.sqlite'));
    ownerId = testOwnerId(service);
    directories = new ProjectDirectoryManager(service, { accessibleRoot: directory, displayRoot: directory });
  });

  afterEach(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('the same remote from two machines resolves to one project', () => {
    const laptop = directories.register({
      directoryPath: '/Users/guzman/z_dev/app', external: true, ownerId,
      repositoryReference: 'git@github.com:acme/app.git',
    });
    const desktop = directories.register({
      directoryPath: '/home/arturo/Proyectos/app', external: true, ownerId,
      repositoryReference: 'https://github.com/acme/app',
    });
    expect(laptop.created).toBe(true);
    expect(desktop).toEqual({ project: laptop.project, created: false });
    expect(laptop.project.repositoryReference).toBe('github.com/acme/app');
  });

  test('a project registered by path adopts the reference once, then matches by it', () => {
    const first = directories.register({ directoryPath: '/srv/app', external: true, ownerId });
    expect(first.project.repositoryReference).toBeNull();
    const again = directories.register({
      directoryPath: '/srv/app', external: true, ownerId, repositoryReference: 'git@github.com:acme/app.git',
    });
    expect(again.created).toBe(false);
    expect(again.project.repositoryReference).toBe('github.com/acme/app');
    expect(directories.register({
      directoryPath: '/elsewhere/app', external: true, ownerId, repositoryReference: 'github.com/acme/app',
    }).project.id).toBe(first.project.id);
  });

  test('list_projects filters by any spelling of the remote and never stores credentials', () => {
    const token = `${'ghp_'}${'b'.repeat(36)}`;
    const { project } = directories.register({
      directoryPath: '/srv/app', external: true, ownerId,
      repositoryReference: `https://x:${token}@github.com/acme/app.git`,
    });
    directories.register({ directoryPath: '/srv/other', external: true, ownerId });
    const found = service.listProjects({ scope: 'all', repositoryReference: 'git@github.com:acme/app.git' });
    expect(found.map(({ id }) => id)).toEqual([project.id]);
    expect(JSON.stringify(service.listProjects({ scope: 'all' }))).not.toContain(token);
  });
});
