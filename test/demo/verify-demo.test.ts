import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

// The port is validated before Docker is even looked up, so these run anywhere and prove the
// script stops without creating a root, a project or an image.
async function verifyWithPort(port: string): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync('bash', ['scripts/verify-demo.sh'], {
      env: { PATH: process.env.PATH, SECURITY_INBOX_VERIFY_PORT: port },
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    return { code: failure.code, stderr: failure.stderr };
  }
}

test.each(['3300', '3301'])('refuses the shared service port %s', async (port) => {
  await expect(verifyWithPort(port)).resolves.toEqual({
    code: 1,
    stderr: `Port ${port} belongs to the shared service; choose another SECURITY_INBOX_VERIFY_PORT.\n`,
  });
});

test.each(['03300', '0', '80', '65536', 'abc'])('refuses the port %j', async (port) => {
  await expect(verifyWithPort(port)).resolves.toEqual({
    code: 1,
    stderr: 'SECURITY_INBOX_VERIFY_PORT must be a port between 1024 and 65535.\n',
  });
});
