import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { SecurityInboxService } from '../../src/core/service.js';
import { seedDemo } from '../../src/demo/seed.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('demo seed', () => {
  test('creates two projects and varied findings, then stays stable after close and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'security-inbox-demo-'));
    directories.push(directory);
    const databasePath = join(directory, 'demo.sqlite');

    const first = seedDemo(databasePath);
    const firstProjectIds = first.projects.map(({ id }) => id);
    const firstFindingIds = first.findings.map(({ id }) => id);

    expect(first.projects).toHaveLength(2);
    expect(first.findings).toHaveLength(6);
    expect(new Set(first.findings.map(({ severity }) => severity))).toEqual(
      new Set(['critical', 'high', 'medium', 'low', 'informational']),
    );
    expect(new Set(first.findings.map(({ status }) => status)).size).toBeGreaterThanOrEqual(4);
    expect(first.findings.every(({ history }) => history.length >= 1)).toBe(true);

    const second = seedDemo(databasePath);
    expect(second.projects.map(({ id }) => id)).toEqual(firstProjectIds);
    expect(second.findings.map(({ id }) => id)).toEqual(firstFindingIds);

    const reopened = new SecurityInboxService(databasePath);
    try {
      expect(reopened.listProjects()).toHaveLength(2);
      const rows = reopened.listProjects().flatMap(({ id }) => reopened.listFindings({ projectId: id }));
      expect(rows).toHaveLength(6);
      for (const finding of second.findings) {
        const detail = reopened.getFinding({ projectId: finding.projectId, findingId: finding.id });
        expect(detail.history.map(({ id }) => id)).toEqual(finding.history.map(({ id }) => id));
      }
    } finally {
      reopened.close();
    }
  });

  test('keeps a real homonymous project separate from the synthetic fixture', () => {
    const directory = mkdtempSync(join(tmpdir(), 'security-inbox-demo-collision-'));
    directories.push(directory);
    const databasePath = join(directory, 'demo.sqlite');
    const service = new SecurityInboxService(databasePath);
    const real = service.createProject({
      name: 'Security Inbox API',
      description: 'Real project with the same display name.',
      repositoryReference: 'git://real.example/security-inbox',
    });
    service.close();

    const seeded = seedDemo(databasePath);
    const demoProject = seeded.projects.find(({ repositoryReference }) => repositoryReference === 'demo://security-inbox-api');
    expect(demoProject).toBeDefined();
    expect(demoProject?.id).not.toBe(real.id);

    const reopened = new SecurityInboxService(databasePath);
    try {
      expect(reopened.listProjects()).toHaveLength(3);
      expect(reopened.listFindings({ projectId: real.id })).toEqual([]);
      expect(reopened.listFindings({ projectId: demoProject!.id })).toHaveLength(3);
    } finally {
      reopened.close();
    }

    const retry = seedDemo(databasePath);
    expect(retry.projects.find(({ repositoryReference }) => repositoryReference === 'demo://security-inbox-api')?.id)
      .toBe(demoProject!.id);
  });
});
