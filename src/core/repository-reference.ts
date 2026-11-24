// A directory path identifies a workspace on one machine; the same repository cloned on two
// computers has two paths. The git remote is the identity they share, so it is normalised to
// host/path: one spelling for SSH, scp-like and HTTPS remotes.
//
//   git@github.com:Owner/Repo.git                 -> github.com/owner/repo
//   ssh://git@github.com:22/Owner/Repo            -> github.com/owner/repo
//   https://user:token@github.com/Owner/Repo.git  -> github.com/owner/repo
//   https://git.example.com:8443/team/app         -> git.example.com:8443/team/app
//
// Credentials never survive, whatever the spelling: everything up to the last "@" of the
// authority is dropped before any other step, for known schemes, unknown schemes, URLs that
// do not parse and scheme-less forms alike. As a backstop that does not depend on recognising
// every spelling, a reference is stored only if no "@" is left at all (see
// storableRepositoryReference). Paths are lowercased (GitHub-style hosts are
// case-insensitive) and dot segments resolve as in any URL. Other references (for example
// demo://fixture) keep their scheme.
import { AppError } from './errors.js';

const schemePattern = /^([a-z][a-z0-9+.-]{0,30}):\/\//i;
const defaultPorts: Record<string, string> = { 'ssh:': '22', 'git+ssh:': '22', 'https:': '443', 'http:': '80', 'git:': '9418' };
const gitSchemes = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'git+https:', 'git+http:']);

function tidyPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
}

/**
 * Drops "user:secret@" from the authority, which ends at the first "/" (or the end). Leading
 * slashes are skipped first, so "//user:secret@host/repo" loses its credential too.
 */
function withoutUserInfo(authorityAndPath: string): string {
  const lead = /^\/*/.exec(authorityAndPath)![0];
  const rest = authorityAndPath.slice(lead.length);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf('@');
  return at === -1 ? authorityAndPath : `${lead}${rest.slice(at + 1)}`;
}

const scpPattern = /^([^:/\s]+):(?!\/\/)(\S+)$/;

/**
 * The reference without any "user@" or "user:secret@", spelled otherwise as given. Covers the
 * authority after a scheme, a scheme-less authority, and the path of an scp-like form when it
 * starts with "/" ("https:/user:secret@host/repo" is no remote git accepts, but it is typed).
 */
function credentialFree(value: string): string {
  const scheme = schemePattern.exec(value);
  if (scheme) return `${scheme[0]}${withoutUserInfo(value.slice(scheme[0].length))}`;
  const bare = withoutUserInfo(value);
  const scp = scpPattern.exec(bare);
  return scp && scp[2]!.startsWith('/') ? `${scp[1]}:${withoutUserInfo(scp[2]!)}` : bare;
}

// A normalised reference with a non-default port. Normalising it again would read it as the
// scp-like "host:path" and turn the port into a path, so it is only ever compared as stored.
const hostWithPort = /^[^:/\s@]+:\d+(?:\/|$)/;

/** Whether a stored reference denotes the remote whose normalised form is `wanted`. */
export function matchesRepositoryReference(stored: string, wanted: string): boolean {
  return stored === wanted || (!hostWithPort.test(stored) && normalizeRepositoryReference(stored) === wanted);
}

export function normalizeRepositoryReference(raw: string): string {
  const value = credentialFree(raw.trim());
  const scheme = schemePattern.exec(value);
  if (scheme) {
    const protocol = `${scheme[1]!.toLowerCase()}:`;
    const rest = value.slice(scheme[0].length);
    if (gitSchemes.has(protocol)) {
      try {
        const url = new URL(`${protocol.replace(/^git\+/, '')}//${rest}`);
        const port = url.port && url.port !== defaultPorts[url.protocol] ? `:${url.port}` : '';
        return `${url.hostname}${port}/${tidyPath(decodeURIComponent(url.pathname))}`.toLowerCase();
      } catch {
        // Unparseable: keep the credential-free text rather than guessing.
      }
    }
    return `${protocol}//${rest}`.toLowerCase();
  }
  // scp-like "host:owner/repo" (the user, if any, is already gone).
  const scp = scpPattern.exec(value);
  if (scp) return `${scp[1]}/${tidyPath(scp[2]!)}`.toLowerCase();
  return tidyPath(value).toLowerCase();
}

// What projects.repository_reference accepts (CHECK length(trim(...)) BETWEEN 1 AND 500),
// stated so that JavaScript and SQLite agree: no surrounding whitespace and no control
// characters (SQLite's length() stops at a NUL), and at most 500 UTF-16 units, which is never
// fewer characters than SQLite counts. No "@" either: see storableRepositoryReference.
const controlCharacter = /[\u0000-\u001f\u007f]/;

/** Whether a normalised reference can be stored as it is. */
export function isStorableReference(value: string): boolean {
  return value.length >= 1 && value.length <= 500 && value === value.trim()
    && !controlCharacter.test(value) && !value.includes('@');
}

/**
 * The normalised reference to store. A git remote's identity never contains "@" once its
 * user info is gone, so one that is left means a spelling normalisation did not recognise
 * (for example "a@/b:secret@host/r" or an unusual scheme) and may still carry a credential:
 * it is refused, naming the field and never echoing the value. Anything else the column would
 * reject (nothing left, too long once lowercased, control characters) is a validation error.
 */
export function storableRepositoryReference(raw: string): string {
  const normalized = normalizeRepositoryReference(raw);
  if (normalized.includes('@')) {
    throw new AppError('SECRET_DETECTED', 'Input looks like it contains a secret', {
      repositoryReference: ['Looks like a user or credentials in the reference; remove them'],
    });
  }
  if (!isStorableReference(normalized)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid input', {
      repositoryReference: ['Use a repository remote of 1-500 printable characters'],
    });
  }
  return normalized;
}
