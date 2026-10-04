// A directory path identifies a workspace on one machine; the same repository cloned on two
// computers has two paths. The git remote is the identity they share, so it is normalised to
// host/path: one spelling for SSH, scp-like and HTTPS remotes, credentials always dropped.
//
//   git@github.com:Owner/Repo.git          -> github.com/owner/repo
//   ssh://git@github.com:22/Owner/Repo     -> github.com/owner/repo
//   https://user:token@github.com/Owner/Repo.git -> github.com/owner/repo
//
// Any other reference (for example demo://fixture) is kept trimmed and lowercased.
const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;

function tidyPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
}

export function normalizeRepositoryReference(raw: string): string {
  const value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol) && url.hostname) {
        const path = tidyPath(decodeURIComponent(url.pathname));
        return `${url.hostname}/${path}`.toLowerCase();
      }
    } catch {
      // Not a parseable URL: fall through to the generic form.
    }
    return value.toLowerCase();
  }
  const scp = scpLike.exec(value);
  if (scp && !value.includes(' ')) {
    return `${scp[1]}/${tidyPath(scp[2]!)}`.toLowerCase();
  }
  return tidyPath(value).toLowerCase();
}
