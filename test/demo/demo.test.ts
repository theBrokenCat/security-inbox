import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { runDemo } from '../../src/demo/demo.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('demo verifies UUID selection, idempotent retry, transition history and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-inbox-demo-route-'));
  directories.push(directory);

  const first = runDemo(join(directory, 'demo.sqlite'));
  expect(first.projectId).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.findingId).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.firstCreated).toBe(true);
  expect(first.retryCreated).toBe(false);
  expect(first.historyLength).toBeGreaterThanOrEqual(2);
  expect(first.reopenedHistoryLength).toBe(first.historyLength);

  const second = runDemo(join(directory, 'demo.sqlite'));
  expect(second.findingId).toBe(first.findingId);
  expect(second.firstCreated).toBe(false);
  expect(second.retryCreated).toBe(false);
  expect(second.reopenedHistoryLength).toBe(first.reopenedHistoryLength);
});
