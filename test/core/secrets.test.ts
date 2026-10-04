import { describe, expect, test } from 'vitest';

import { assertNoSecrets, detectSecrets } from '../../src/core/secrets.js';

// Values are assembled at run time so this file never contains a literal that a secret scanner
// would itself report.
const repeat = (character: string, length: number) => character.repeat(length);

describe('secret detection', () => {
  test.each([
    ['private key', `-----BEGIN ${'RSA '}PRIVATE KEY-----\nMIIE...`],
    ['AWS access key', `key ${'AKIA'}${repeat('Q', 16)} in config`],
    ['GitHub token', `token ${'ghp_'}${repeat('a', 36)}`],
    ['GitHub token', `${'github_pat_'}${repeat('B', 30)}`],
    ['Slack token', `${'xoxb'}-${repeat('1', 12)}-abc`],
    ['API key', `ANTHROPIC ${'sk-ant-'}${repeat('z', 30)}`],
    ['Google API key', `${'AIza'}${repeat('c', 35)}`],
    ['JSON Web Token', `${'eyJ'}${repeat('h', 12)}.${'eyJ'}${repeat('p', 12)}.${repeat('s', 12)}`],
    ['credentials in a URL', 'postgres://app:S3cr3tPassw0rd@db.internal:5432/app'],
    ['password or key assignment', 'DB_PASSWORD=hunter2hunter2'],
    ['password or key assignment', 'api_key: "9f8e7d6c5b4a3210"'],
  ])('reports a %s', (kind, text) => {
    expect(detectSecrets(text)).toContain(kind);
  });

  test.each([
    'The password field is not validated on the login form.',
    'Rotate the API key used by the deploy job.',
    'password=<redacted>',
    'api_key: ${API_KEY}',
    'token = process.env.GITHUB_TOKEN',
    'DB_PASSWORD=******',
    'postgres://app:<password>@db.internal/app',
    'https://github.com/theBrokenCat/security-inbox.git',
    'secret: changeme',
    'sk-short',
  ])('accepts ordinary text: %s', (text) => {
    expect(detectSecrets(text)).toEqual([]);
  });

  test('names every field with a secret and never echoes the value', () => {
    const value = `${'ghp_'}${repeat('a', 36)}`;
    try {
      assertNoSecrets({ title: 'Leaked token', description: `found ${value}`, evidence: 'x' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'SECRET_DETECTED',
        fieldErrors: { description: ['Looks like a GitHub token; remove or redact it'] },
      });
      expect(JSON.stringify(error)).not.toContain(value);
      expect((error as Error).message).not.toContain(value);
    }
  });
});
