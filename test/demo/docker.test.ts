import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const compose = readFileSync('compose.yaml', 'utf8');
const verifyDemo = readFileSync('scripts/verify-demo.sh', 'utf8');

function serviceBlock(name: string): string {
  return compose.match(new RegExp(`  ${name}:[\\s\\S]*?(?=\\n  [a-z]+:|\\nnetworks:|$)`))?.[0] ?? '';
}

test('Docker image includes runtime assets while only data is writable', () => {
  expect(dockerfile).toContain('FROM node:24-bookworm');
  expect(dockerfile).toContain('COPY src ./src');
  expect(dockerfile).toContain('COPY test ./test');
  expect(dockerfile).toContain('COPY views ./views');
  expect(dockerfile).toContain('COPY public ./public');
  expect(dockerfile).toContain('COPY Dockerfile ./Dockerfile');
  expect(dockerfile).toContain('COPY compose.yaml ./compose.yaml');
  expect(dockerfile).toContain('COPY README.md ./README.md');
  expect(dockerfile).toContain('COPY AGENTS.md ./AGENTS.md');
  expect(dockerfile).toContain('COPY tasks/lessons.md ./tasks/lessons.md');
  expect(dockerfile).toContain('COPY scripts/verify-demo.sh ./scripts/verify-demo.sh');
  expect(dockerfile).toContain('chown node:node /app/data');
  expect(dockerfile).not.toContain('chown -R node:node /app');
  expect(dockerfile).toContain('USER node');
});

test('Compose uses its project bridge with loopback-only web and stdio MCP', () => {
  const app = serviceBlock('app');
  const web = serviceBlock('web');
  const mcp = serviceBlock('mcp');
  expect(app).toContain('build:');
  expect(web).not.toContain('build:');
  expect(mcp).not.toContain('build:');
  expect(mcp).toContain('command: ["node", "dist/src/mcp/server.js"]');
  expect(mcp).not.toContain('npm run mcp');
  expect(compose).toContain('source: ./data');
  expect(compose).toContain('SECURITY_INBOX_PROJECTS_ROOT: /projects');
  expect(compose).toContain(
    'SECURITY_INBOX_PROJECTS_DISPLAY_ROOT: ${SECURITY_INBOX_PROJECTS_HOST_ROOT:-/root/Proyectos}',
  );
  expect(compose).toContain('source: ${SECURITY_INBOX_PROJECTS_HOST_ROOT:-/root/Proyectos}');
  expect(compose).toContain('target: /projects');
  expect(compose).toContain('read_only: true');
  expect(web.match(/^\s+- "[^\"]+"$/gm)).toEqual(['      - "127.0.0.1:3300:3300"']);
  expect(mcp).not.toMatch(/\n\s+ports:/);
  expect(compose).not.toContain('internal: true');
  expect(compose).not.toMatch(/^\s*networks:/m);
});

test('MCP verification allows Compose stderr while rejecting server failures', () => {
  expect(verifyDemo).toContain('test "$mcp_status" -eq 0');
  expect(verifyDemo).toContain('test -z "$mcp_stdout"');
  expect(verifyDemo).toContain(
    '! grep -Fq "Security Inbox MCP failed to start" "$mcp_stderr"',
  );
  expect(verifyDemo).not.toContain('test ! -s "$mcp_stderr"');
});
