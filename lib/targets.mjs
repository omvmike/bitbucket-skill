import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

function findGitRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    try {
      statSync(join(dir, '.git'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

function parseBitbucketRemote(url) {
  const trimmed = url.trim().replace(/\.git$/, '');
  const ssh = trimmed.match(/^git@bitbucket\.org:([^/]+)\/(.+)$/);
  if (ssh) return { workspace: ssh[1], slug: ssh[2] };
  const https = trimmed.match(/^https?:\/\/(?:[^@]+@)?bitbucket\.org\/([^/]+)\/(.+)$/);
  if (https) return { workspace: https[1], slug: https[2] };
  return null;
}

export function detectRepoFromGit(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = parseBitbucketRemote(url);
    if (!parsed) {
      return { ok: false, reason: `remote "${url.trim()}" is not a bitbucket.org URL` };
    }
    return { ok: true, ...parsed };
  } catch (err) {
    return { ok: false, reason: `git remote get-url origin failed: ${err.message}` };
  }
}

function parseEnvFile(contents) {
  const out = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadBbConfig(cwd) {
  const gitRoot = findGitRoot(cwd) ?? cwd;
  const candidates = [join(gitRoot, '.bb'), join(homedir(), '.config', 'bitbucket', '.bb')];
  for (const path of candidates) {
    try {
      const st = statSync(path);
      const env = parseEnvFile(readFileSync(path, 'utf8'));
      const worldReadable = (st.mode & 0o077) !== 0;
      return { path, env, worldReadable };
    } catch {}
  }
  return { path: null, env: {}, worldReadable: false };
}

export function resolveTarget({ cwd, repoOverride }) {
  const config = loadBbConfig(cwd);
  let workspace = null;
  let slug = null;
  let source = null;

  if (repoOverride) {
    const [w, s] = repoOverride.split('/');
    if (!w || !s) throw new Error(`--repo must be "<workspace>/<slug>", got "${repoOverride}"`);
    workspace = w;
    slug = s;
    source = 'flag';
  } else {
    const detected = detectRepoFromGit(cwd);
    if (detected.ok) {
      workspace = config.env.BB_WORKSPACE || detected.workspace;
      slug = detected.slug;
      source = config.env.BB_WORKSPACE ? 'git+env' : 'git';
    } else if (config.env.BB_WORKSPACE) {
      workspace = config.env.BB_WORKSPACE;
      source = 'env';
    }
  }

  return {
    workspace,
    slug,
    source,
    config,
    token: config.env.BB_TOKEN || null,
    user: config.env.BB_USER || null,
  };
}
