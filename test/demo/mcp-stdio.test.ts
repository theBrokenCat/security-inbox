import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// scripts/mcp-stdio.sh against a stand-in for docker that logs its arguments and ends the way
// a real session can: normally, killed by SIGPIPE after the client left, with an error, or
// still waiting when the session is hung up or the launcher alone is told to stop. Every path
// must remove the one container the script named, pass stdio through untouched and keep
// compose's exit status. Like the real CLI, the stand-in prints the removed name on stdout.

const script = resolve('scripts/mcp-stdio.sh');
const fakeDocker = `#!/bin/sh
case "$1" in
  compose)
    printf 'run %s\\n' "$*" >> "$DOCKER_LOG"
    case "$FAKE_MODE" in
      ok) exec cat ;;
      sigpipe) kill -PIPE $$ ;;
      fail) exit 3 ;;
      hang) printf 'waiting\\n' >> "$DOCKER_LOG"; exec sleep 30 ;;
    esac ;;
  rm) printf 'rm %s\\n' "$*" >> "$DOCKER_LOG"; printf '%s\\n' "$3" ;;
esac
`;

let directory: string;
let log: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'security-inbox-mcp-stdio-'));
  log = join(directory, 'docker.log');
  writeFileSync(join(directory, 'docker'), fakeDocker);
  chmodSync(join(directory, 'docker'), 0o755);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

type Run = { code: number | null; stdout: string; stderr: string; pid: number };

function launch(
  shell: string,
  mode: string,
  input: string,
  signal?: 'group-hangup' | 'launcher-term',
  retryDelays = '0 0',
): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(shell, [script, '-e', 'SECURITY_INBOX_USER=guzman'], {
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        DOCKER_LOG: log,
        FAKE_MODE: mode,
        SECURITY_INBOX_MCP_CLEANUP_RETRY: retryDelays,
      },
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr, pid: child.pid! }));
    child.stdin.end(input);
    if (signal) {
      const poll = setInterval(() => {
        if (existsSync(log) && readFileSync(log, 'utf8').includes('waiting')) {
          clearInterval(poll);
          if (signal === 'group-hangup') process.kill(-child.pid!, 'SIGHUP');
          else process.kill(child.pid!, 'SIGTERM');
        }
      }, 20);
    }
  });
}

function calls(): string[] {
  return readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== 'waiting');
}

// The removals after an abnormal end run detached, so they may land after the launcher exits.
async function removalsOf(name: string, expected: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  let removals: string[] = [];
  while (Date.now() < deadline) {
    removals = calls().filter((line) => line.startsWith('rm '));
    if (removals.length >= expected) break;
    await new Promise((wake) => setTimeout(wake, 25));
  }
  expect(removals).toEqual(Array.from({ length: expected }, () => `rm rm -f ${name}`));
  return removals;
}

const nameIn = (compose: string) => /--name (\S+)/.exec(compose)![1]!;

describe.each(['dash', 'bash'])('scripts/mcp-stdio.sh under %s', (shell) => {
  test('passes stdio through and removes the named container once after a normal session', async () => {
    const run = await launch(shell, 'ok', '{"jsonrpc":"2.0"}\n');
    expect(run).toMatchObject({ code: 0, stdout: '{"jsonrpc":"2.0"}\n', stderr: '' });
    const [compose] = calls();
    const name = /--name (security-inbox-mcp-session-\d{8}T\d{6}Z-\d+) /.exec(compose!)?.[1];
    expect(compose).toBe(
      `run compose -f ${resolve('compose.yaml')} run --rm -T --name ${name} -e SECURITY_INBOX_USER=guzman mcp`,
    );
    await new Promise((wake) => setTimeout(wake, 200));
    await removalsOf(name!, 1);
  });

  test.each([
    ['sigpipe', 141],
    ['fail', 3],
  ])('removes the container when compose ends with %s, keeps its status and retries later', async (mode, status) => {
    const run = await launch(shell, mode, '');
    expect(run).toMatchObject({ code: status, stdout: '', stderr: '' });
    await removalsOf(nameIn(calls()[0]!), 3);
  });

  test('retries after the session has closed, and a stop sent to its process group cannot cancel them', async () => {
    const run = await launch(shell, 'fail', '', undefined, '1 1');
    const name = nameIn(calls()[0]!);
    // The client saw the session end before the later removals ran.
    expect(calls().filter((line) => line.startsWith('rm '))).toEqual([`rm rm -f ${name}`]);
    try {
      process.kill(-run.pid, 'SIGTERM');
    } catch {
      // The group is already gone only if the retries were not detached into it.
    }
    await removalsOf(name, 3);
  }, 15_000);

  test('removes the container when the whole session is hung up while compose waits', async () => {
    const run = await launch(shell, 'hang', '', 'group-hangup');
    expect([129, 143]).toContain(run.code);
    expect(run.stdout).toBe('');
    await removalsOf(nameIn(calls()[0]!), 3);
  }, 15_000);

  test('passes a stop sent only to the launcher on to compose at once', async () => {
    const started = Date.now();
    const run = await launch(shell, 'hang', '', 'launcher-term');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.code).toBe(143);
    expect(run.stdout).toBe('');
    await removalsOf(nameIn(calls()[0]!), 3);
  }, 15_000);
});
