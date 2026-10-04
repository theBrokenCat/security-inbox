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
// do not parse and scheme-less forms alike. Paths are lowercased (GitHub-style hosts are
// case-insensitive) and dot segments resolve as in any URL. Other references (for example
// demo://fixture) keep their scheme.
const schemePattern = /^([a-z][a-z0-9+.-]{0,30}):\/\//i;
const defaultPorts: Record<string, string> = { 'ssh:': '22', 'git+ssh:': '22', 'https:': '443', 'http:': '80', 'git:': '9418' };
const gitSchemes = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'git+https:', 'git+http:']);

function tidyPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
}

/** Drops "user:secret@" from the authority, which ends at the first "/" (or the end). */
function withoutUserInfo(authorityAndPath: string): string {
  const slash = authorityAndPath.indexOf('/');
  const authority = slash === -1 ? authorityAndPath : authorityAndPath.slice(0, slash);
  const at = authority.lastIndexOf('@');
  return at === -1 ? authorityAndPath : authorityAndPath.slice(at + 1);
}

export function normalizeRepositoryReference(raw: string): string {
  const value = raw.trim();
  const scheme = schemePattern.exec(value);
  if (scheme) {
    const protocol = `${scheme[1]!.toLowerCase()}:`;
    const rest = withoutUserInfo(value.slice(scheme[0].length));
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
  const bare = withoutUserInfo(value);
  // scp-like "host:owner/repo" (the user, if any, is already gone).
  const scp = /^([^:/\s]+):(?!\/\/)(\S+)$/.exec(bare);
  if (scp) return `${scp[1]}/${tidyPath(scp[2]!)}`.toLowerCase();
  return tidyPath(bare).toLowerCase();
}
