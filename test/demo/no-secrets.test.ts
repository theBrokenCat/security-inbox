import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

const root = process.cwd();

test('demo sources and operational examples contain no common secret formats', () => {
  const candidates = [
    ...readdirSync(join(root, 'src/demo')).map((name) => join(root, 'src/demo', name)),
    join(root, 'Dockerfile'),
    join(root, 'compose.yaml'),
    join(root, 'README.md'),
    join(root, 'AGENTS.md'),
    join(root, 'tasks/lessons.md'),
    join(root, 'scripts/verify-demo.sh'),
  ];
  const paths = candidates.filter((path) => existsSync(path));
  const contents = paths.map((path) => readFileSync(path, 'utf8')).join('\n');

  expect(contents).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  expect(contents).not.toMatch(/gh[pousr]_[A-Za-z0-9_]{20,}/);
  expect(contents).not.toMatch(/AKIA[0-9A-Z]{16}/);
  expect(contents).not.toMatch(/-----BEGIN [A-Z ]+ PRIVATE KEY-----/);
});
