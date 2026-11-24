import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  matchesRepositoryReference,
  normalizeRepositoryReference,
  storableRepositoryReference,
} from '../../src/core/repository-reference.js';
import { SecurityInboxService } from '../../src/core/service.js';
import { ProjectDirectoryManager } from '../../src/projects/directory-manager.js';
import { testOwnerId } from '../support/owner.js';

const normalCases: Array<[string, string]> = [
  ['git@github.com:theBrokenCat/Security-Inbox.git', 'github.com/thebrokencat/security-inbox'],
  ['https://github.com/theBrokenCat/security-inbox.git', 'github.com/thebrokencat/security-inbox'],
  ['https://github.com/theBrokenCat/security-inbox/', 'github.com/thebrokencat/security-inbox'],
  ['ssh://git@github.com:22/theBrokenCat/security-inbox', 'github.com/thebrokencat/security-inbox'],
  ['git+ssh://git@gitlab.example.com/group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
  ['github.com/theBrokenCat/security-inbox', 'github.com/thebrokencat/security-inbox'],
  ['demo://security-inbox-api', 'demo://security-inbox-api'],
  ['https://git.example.com:8443/team/app.git', 'git.example.com:8443/team/app'],
  ['https://github.com:443/acme/app', 'github.com/acme/app'],
  ['//git.example.com/team/app', 'git.example.com/team/app'],
];

const credentialSpellings = [
  (token: string) => `git+https://user:${token}@github.com/acme/app.git`,
  (token: string) => `svn+ssh://user:${token}@svn.example.com/acme/app`,
  (token: string) => `ftp://user:${token}@files.example.com/app`,
  (token: string) => `https://oauth2:${token}@[bad/acme/app`,
  (token: string) => `user:${token}@github.com/acme/app`,
  (token: string) => `${token}@github.com:acme/app.git`,
  (token: string) => `//deploy:${token}@git.example.com/team/app`,
  (token: string) => `ftp:///user:${token}@files.example.com/app`,
  (token: string) => `https:///user:${token}@github.com/acme/app`,
  (token: string) => `https:/user:${token}@github.com/acme/app`,
];

describe('repository reference normalisation', () => {
  test.each(normalCases.map(([raw]) => raw))('%s is stored as its normalised form and matches it', (raw) => {
    const normalized = normalizeRepositoryReference(raw);
    expect(storableRepositoryReference(raw)).toBe(normalized);
    expect(matchesRepositoryReference(normalized, normalized)).toBe(true);
  });

  // Spellings normalisation does not take apart keep an "@", so they are refused rather than
  // stored, and the refusal does not repeat the value.
  test.each([
    (secret: string) => `a@/b:${secret}@git.example.com/r`,
    (secret: string) => `/https://${secret}@git.example.com/r`,
    (secret: string) => `git_https://u:${secret}@git.example.com/r`,
    (secret: string) => `${'s'.repeat(40)}://u:${secret}@git.example.com/r`,
    (secret: string) => `https/alice:${secret}@github.com/o/r`,
  ])('refuses to store %s', (spell) => {
    const secret = 'hunter22hunter22';
    try {
      storableRepositoryReference(spell(secret));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'SECRET_DETECTED', fieldErrors: { repositoryReference: [expect.any(String)] } });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  // A stored value is compared as stored, or else normalised once more: never when it is a
  // normalised host:port, whose port a second pass would read as a path.
  test.each([
    ['git.example.com:8443/team/app', 'https://git.example.com:8443/team/app.git', true],
    ['git.example.com:8443/team/app', 'https://git.example.com/8443/team/app', false],
    ['git.example.com:8443/', 'https://git.example.com:8443', true],
    ['git.example.com:8443/', 'https://git.example.com/8443', false],
    ['github-work:acme/app', 'git@github-work:acme/app.git', true],
    ['//github.com/acme/app', 'https://github.com/acme/app', true],
    ['https://GitHub.com/Acme/App.git', 'git@github.com:acme/app.git', true],
    ['github.com/acme/app', 'https://github.com/acme/other', false],
  ] as const)('stored %s matches %s: %s', (stored, query, expected) => {
    expect(matchesRepositoryReference(stored, normalizeRepositoryReference(query))).toBe(expected);
  });

  test.each(normalCases)('%s -> %s', (raw, expected) => {
    expect(normalizeRepositoryReference(raw)).toBe(expected);
  });

  test.each(credentialSpellings)('never keeps a credential: %s', (spell) => {
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

  test('an unrecognised spelling that keeps an "@" is refused, by register and create alike', () => {
    const odd = `a@/b:${'hunter22'.repeat(2)}@git.example.com/r`;
    expect(() => directories.register({ directoryPath: '/srv/odd', external: true, ownerId, repositoryReference: odd }))
      .toThrow(expect.objectContaining({ code: 'SECRET_DETECTED' }));
    expect(() => service.createProject({ ownerId, name: 'odd', description: 'Odd remote', repositoryReference: odd }))
      .toThrow(expect.objectContaining({ code: 'SECRET_DETECTED' }));
    expect(service.listProjects({ scope: 'all' })).toEqual([]);
  });

  test.each(['git@', 'x@ /', 'İ'.repeat(300)])('a remote the column cannot hold (%j) is a validation error', (remote) => {
    expect(() => service.createProject({ ownerId, name: 'bad', description: 'Bad remote', repositoryReference: remote }))
      .toThrow(expect.objectContaining({ code: expect.stringMatching(/^(VALIDATION_ERROR|SECRET_DETECTED)$/) }));
    expect(service.listProjects({ scope: 'all' })).toEqual([]);
  });
});

describe('references stored before normalisation', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'security-inbox-legacy-ref-'));
    path = join(directory, 'inbox.sqlite');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test('lose their credentials when the database opens, keeping ids and timestamps', () => {
    const token = `${'ghp_'}${'d'.repeat(36)}`;
    const seeded = new SecurityInboxService(path);
    const ownerId = testOwnerId(seeded);
    const create = (name: string) => seeded.createProject({ ownerId, name, description: 'Legacy reference' });
    const withToken = create('with-token');
    const scpUser = create('scp-user');
    const withPort = create('with-port');
    const onlyUser = create('only-user');
    const atInPath = create('at-in-path');
    const oddSpelling = create('odd-spelling');
    const nulAfterUser = create('nul-after-user');
    seeded.close();

    // What createProject stored before 0c72131: the reference exactly as it was typed.
    const legacy = new BetterSqlite3(path);
    const store = legacy.prepare('UPDATE projects SET repository_reference = ? WHERE id = ?');
    store.run(`https://someone:${token}@GitHub.com/Acme/App.git`, withToken.id);
    store.run('git@github.com:acme/other.git', scpUser.id);
    store.run('git.example.com:8443/team/app', withPort.id);
    store.run('someone@', onlyUser.id);
    store.run('github.com/acme/tool@v1', atInPath.id);
    store.run(`https/alice:${token}@github.com/o/r`, oddSpelling.id);
    // Accepted by the column (SQLite's length() stops at the NUL), refused by the rule: an
    // update to the lone NUL left after normalising would fail and keep the database closed.
    store.run('x@\u0000', nulAfterUser.id);
    legacy.close();

    const reopened = new SecurityInboxService(path);
    try {
      const projects = reopened.listProjects({ scope: 'all' });
      expect(JSON.stringify(projects)).not.toContain(token);
      const reference = (id: string) => projects.find((project) => project.id === id)!.repositoryReference;
      expect(reference(withToken.id)).toBe('github.com/acme/app');
      expect(reference(scpUser.id)).toBe('github.com/acme/other');
      expect(reference(withPort.id)).toBe('git.example.com:8443/team/app');
      expect(reference(onlyUser.id)).toBeNull();
      // Anything that still has an "@" once normalised is dropped: it may hide a credential.
      expect(reference(atInPath.id)).toBeNull();
      expect(reference(oddSpelling.id)).toBeNull();
      expect(reference(nulAfterUser.id)).toBeNull();
      expect(projects.find(({ id }) => id === withToken.id)!.updatedAt).toBe(withToken.updatedAt);
      expect(reopened.listProjects({ scope: 'all', repositoryReference: 'git@github.com:Acme/App.git' })
        .map(({ id }) => id)).toEqual([withToken.id]);
    } finally {
      reopened.close();
    }
  });

  test('a reference with a non-default port is found by any spelling of its remote', () => {
    const service = new SecurityInboxService(path);
    try {
      const ownerId = testOwnerId(service);
      const project = service.createProject({
        ownerId, name: 'ported', description: 'Self-hosted', repositoryReference: 'https://git.example.com:8443/team/app.git',
      });
      expect(project.repositoryReference).toBe('git.example.com:8443/team/app');
      expect(service.listProjects({ scope: 'all', repositoryReference: 'https://git.example.com:8443/team/app' })
        .map(({ id }) => id)).toEqual([project.id]);
      // A different repository whose path starts with that number is not the same project.
      expect(service.listProjects({ scope: 'all', repositoryReference: 'https://git.example.com/8443/team/app' }))
        .toEqual([]);
    } finally {
      service.close();
    }
  });

  test('keep the project that already answers to the cleaned remote, and never block the open', () => {
    const token = `${'ghp_'}${'g'.repeat(36)}`;
    const seeded = new SecurityInboxService(path);
    const ownerId = testOwnerId(seeded);
    const directories = new ProjectDirectoryManager(seeded, { accessibleRoot: directory, displayRoot: directory });
    const legacy = seeded.createProject({ ownerId, name: 'legacy', description: 'Credentialed spelling' });
    const blank = seeded.createProject({ ownerId, name: 'blank', description: 'Nothing left once cleaned' });
    const twinOne = seeded.createProject({ ownerId, name: 'twin-one', description: 'Two old spellings' });
    const twinTwo = seeded.createProject({ ownerId, name: 'twin-two', description: 'Two old spellings' });
    const raw = new BetterSqlite3(path);
    const store = raw.prepare('UPDATE projects SET repository_reference = ? WHERE id = ?');
    store.run(`https://someone:${token}@github.com/acme/app.git`, legacy.id);
    store.run('x@ /', blank.id);
    store.run(`https://one:${token}@github.com/acme/twin`, twinOne.id);
    store.run(`https://two:${token}@github.com/acme/twin`, twinTwo.id);
    // Both can share a millisecond; make the older one explicit, since the oldest keeps the remote.
    const age = raw.prepare('UPDATE projects SET created_at = ?, updated_at = ? WHERE id = ?');
    age.run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', twinOne.id);
    age.run('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', twinTwo.id);
    raw.close();
    // Registered later from another machine: the exact lookup could not see the legacy row.
    const current = directories.register({
      directoryPath: '/srv/app', external: true, ownerId, repositoryReference: 'git@github.com:acme/app.git',
    }).project;
    expect(current.id).not.toBe(legacy.id);
    seeded.close();

    const reopened = new SecurityInboxService(path);
    try {
      const reference = (id: string) => reopened.listProjects({ scope: 'all' })
        .find((project) => project.id === id)!.repositoryReference;
      expect(reference(legacy.id)).toBeNull();
      expect(reference(current.id)).toBe('github.com/acme/app');
      expect(reference(blank.id)).toBeNull();
      expect(reference(twinOne.id)).toBe('github.com/acme/twin');
      expect(reference(twinTwo.id)).toBeNull();
      const again = new ProjectDirectoryManager(reopened, { accessibleRoot: directory, displayRoot: directory });
      expect(again.register({
        directoryPath: '/elsewhere/app', external: true, ownerId, repositoryReference: 'https://github.com/acme/app',
      }).project.id).toBe(current.id);
      expect(JSON.stringify(reopened.listProjects({ scope: 'all' }))).not.toContain(token);
    } finally {
      reopened.close();
    }
  });
});
