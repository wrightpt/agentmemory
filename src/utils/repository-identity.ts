import { createHash } from "node:crypto";

export interface RepositoryIdentity {
  canonicalRepoId: string;
  repoRemote: string;
}

const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);

function normalizedRepositoryPath(value: string): string | undefined {
  const path = value
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!path || /[\\\s?#]/.test(path)) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return undefined;
  }
  return path;
}

/**
 * Convert a network Git origin into a credential-free locator and stable ID.
 * Local paths and file:// remotes deliberately return undefined.
 */
export function normalizeRepositoryRemote(remote: string): RepositoryIdentity | undefined {
  const raw = remote.trim();
  if (!raw || /[\r\n\0]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return undefined;
  }

  let protocol: string;
  let authority: string;
  let repositoryPath: string | undefined;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return undefined;
    }
    if (!NETWORK_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return undefined;
    protocol = parsed.protocol.toLowerCase();
    authority = parsed.host.toLowerCase();
    repositoryPath = normalizedRepositoryPath(parsed.pathname);
  } else {
    const scp = raw.match(/^[^@\s]+@([^:\s]+):(.+)$/);
    if (!scp) return undefined;
    protocol = "ssh:";
    authority = scp[1].toLowerCase();
    repositoryPath = normalizedRepositoryPath(scp[2]);
  }

  if (!repositoryPath) return undefined;
  const github = authority === "github.com";
  const canonicalPath = github ? repositoryPath.toLowerCase() : repositoryPath;
  if (github && canonicalPath.split("/").length !== 2) return undefined;

  return {
    canonicalRepoId: github ? canonicalPath : `${authority}/${canonicalPath}`,
    repoRemote: `${protocol}//${authority}/${canonicalPath}`,
  };
}

/** Workstation-local identity for remote-less Git repositories and all linked worktrees. */
export function localGitRepositoryId(gitCommonDir: string): string {
  const digest = createHash("sha256").update(gitCommonDir).digest("hex");
  return `local-git:${digest}`;
}
