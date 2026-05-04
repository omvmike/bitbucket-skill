# bitbucket-skill

Read-only Bitbucket Cloud access (with one opt-in write) as an Agent Skill. One codebase, works in **Claude Code** and **Codex CLI**.

Thin Node wrapper over the Bitbucket Cloud v2 REST API. Replaces ad-hoc `curl` calls and keeps the API token out of shell history. Auto-detects workspace/slug from `git remote`.

## What it does

- Single Node CLI: `bin/bb.mjs`
- Pull requests: `pr list`, `pr get`, `pr diff`, `pr activity`, `pr create`
- PR comments: `pr comments` (list), `pr comment add`, `pr comment edit`
- Pipelines: `pipeline list`, `pipeline get`, `pipeline steps`, `pipeline log`
- Auto-detects `<workspace>/<slug>` from `git remote get-url origin`
- Basic auth (scoped Atlassian API token + email) and Bearer auth (OAuth / workspace / repo / project access tokens) via the same `.bb` file
- JSON output stays pure (no trailers); text output gets a divider-block hint when the skill emits a notice
- Inline `_hint` field in JSON object output makes skill-emitted messages obvious vs. Bitbucket API responses
- Zero third-party dependencies; uses native `fetch` and `git`

## Install

Pick the location for the tool you use. Both tools read the exact same files.

### Claude Code

```bash
# personal (available in every project)
git clone https://github.com/omvmike/bitbucket-skill ~/.claude/skills/bitbucket

# or project-scoped (committed with your repo)
git clone https://github.com/omvmike/bitbucket-skill .claude/skills/bitbucket
```

Invoke with `/bitbucket` or let Claude trigger it automatically when you ask about a PR or pipeline.

### Codex CLI

```bash
# personal
git clone https://github.com/omvmike/bitbucket-skill ~/.agents/skills/bitbucket

# or project-scoped
git clone https://github.com/omvmike/bitbucket-skill .agents/skills/bitbucket
```

Invoke with `$bitbucket` or let Codex trigger it automatically.

### Update

```bash
cd <install-dir> && git pull
```

## Runtime requirement

Node 18+ (uses native `fetch`, `node:fs`, `node:child_process`). No npm install required — zero third-party dependencies. `git` must be available on `PATH` for workspace/slug auto-detection.

## Setup `.bb`

1. Create a scoped Atlassian API token at:

   https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken=&appId=bitbucket

   On that page, tick these scopes (read-only profile — covers everything except `bb pr create`):

   - `read:me`
   - `read:repository:bitbucket`
   - `read:pullrequest:bitbucket`
   - `read:pipeline:bitbucket`

   Also tick `write:pullrequest:bitbucket` if you want `bb pr create`.

2. Save credentials at the project root:

   ```bash
   umask 077
   cat > .bb <<'EOF'
   BB_USER=<your-atlassian-email>
   BB_TOKEN=<paste-api-token>
   EOF
   chmod 600 .bb
   echo .bb >> .gitignore
   ```

   For OAuth 2.0 / workspace / repository / project access tokens (Bearer auth), omit `BB_USER`.

3. Verify:

   ```bash
   node ~/.claude/skills/bitbucket/bin/bb.mjs --whoami
   ```

## Daily use

Replace the install path with wherever you cloned.

```bash
# List open PRs
node ~/.claude/skills/bitbucket/bin/bb.mjs pr list

# My open PRs as markdown table (default is JSON)
node ~/.claude/skills/bitbucket/bin/bb.mjs pr list --mine --format table

# PR detail + diff
node ~/.claude/skills/bitbucket/bin/bb.mjs pr get 42
node ~/.claude/skills/bitbucket/bin/bb.mjs pr diff 42 > /tmp/pr42.diff

# Activity (comments, approvals, updates) as a single mixed feed
node ~/.claude/skills/bitbucket/bin/bb.mjs pr activity 42 --format table

# Comments only (newest first)
node ~/.claude/skills/bitbucket/bin/bb.mjs pr comments 42 --format table

# Add a comment (requires write:pullrequest:bitbucket scope)
node ~/.claude/skills/bitbucket/bin/bb.mjs pr comment add 42 --body 'LGTM, merging after CI' --yes

# Add a comment from a file
node ~/.claude/skills/bitbucket/bin/bb.mjs pr comment add 42 --body '@review-notes.md' --yes

# Edit an existing comment (overwrites the body)
node ~/.claude/skills/bitbucket/bin/bb.mjs pr comment edit 42 12345 --body 'Updated review notes' --yes

# Pipelines for master
node ~/.claude/skills/bitbucket/bin/bb.mjs pipeline list --branch master --limit 5

# Failed step log
node ~/.claude/skills/bitbucket/bin/bb.mjs pipeline steps '{pipeline-uuid}'
node ~/.claude/skills/bitbucket/bin/bb.mjs pipeline log '{pipeline-uuid}' '{step-uuid}'

# Open a PR (requires write:pullrequest:bitbucket scope)
node ~/.claude/skills/bitbucket/bin/bb.mjs pr create \
  --source feat/foo --target master \
  --title 'feat: foo' --body '@CHANGES.md' \
  --reviewer '{uuid-of-reviewer}' --yes

# Identity / auth check
node ~/.claude/skills/bitbucket/bin/bb.mjs --whoami

# Where am I reading config from?
node ~/.claude/skills/bitbucket/bin/bb.mjs --list-targets
```

## Configuration

`config.json` in the skill directory holds the runtime defaults.

| Key | Default | Notes |
|-----|---------|-------|
| `defaultFormat` | `json` | Output format when `--format` is not passed (`json` or `table`). `pr diff` and `pipeline log` always return raw text. |
| `defaultLimit` | `10` | Pagination limit for list endpoints |
| `timeoutMs` | `15000` | HTTP timeout per request |
| `maxRowsPerPage` | `50` | Bitbucket API page size cap |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Config / auth (missing `.bb`, invalid token, 401/403) |
| 3 | Not found (404) |
| 4 | Validation (bad flags, unknown command) |
| 5 | Network / timeout / 5xx |
| 6 | Rate-limited (429) |

## How `.bb` is found

The script walks up from `process.cwd()` (the directory you ran `claude` / `codex` from) and stops at the first directory containing a `.git` folder. If `.bb` isn't there, it falls back to `~/.config/bitbucket/.bb`. The resolved path is shown by `--list-targets` and `--whoami`.

Workspace/slug are detected by parsing `git remote get-url origin` for SSH (`git@bitbucket.org:<workspace>/<slug>`) and HTTPS (`https://bitbucket.org/<workspace>/<slug>`) Bitbucket Cloud URLs. Override with `--repo <workspace>/<slug>` or set `BB_WORKSPACE` in `.bb`.

## Auth and routing

- **Scoped API tokens** — set `BB_USER` (your Atlassian email) + `BB_TOKEN`. Auth header is `Basic base64(email:token)`, routed against `api.bitbucket.org/2.0/...` directly (no API gateway needed for Bitbucket).
- **OAuth 2.0 / workspace / repository / project access tokens** — omit `BB_USER`, set only `BB_TOKEN`. Auth header is `Bearer <token>`, same direct routing.

## Token scopes

The skill requests the minimum scopes needed for each operation. Generated tokens land at `https://api.bitbucket.org/2.0/...` directly — no gateway routing.

**Read-only profile (recommended default — 4 scopes):**

| Scope | Justification |
|---|---|
| `read:me` | `--whoami` (calls `GET /user`) |
| `read:repository:bitbucket` | All `/repositories/{w}/{s}/...` paths require this |
| `read:pullrequest:bitbucket` | `pr list`, `pr get`, `pr diff`, `pr activity`, `pr comments` |
| `read:pipeline:bitbucket` | `pipeline list`, `pipeline get`, `pipeline steps`, `pipeline log` |

**Write profile (adds 1 scope, total 5)** — required for `pr create` and `pr comment add` / `pr comment edit`:

| Scope | Justification |
|---|---|
| `write:pullrequest:bitbucket` | `POST /pullrequests` (`pr create`), `POST /pullrequests/{id}/comments` (`pr comment add`), `PUT /pullrequests/{id}/comments/{cid}` (`pr comment edit`) |

**Explicitly NOT needed.** Compared to the older `selectedScopes=all` link, this drops 35 scopes:

- All 4 `admin:*` scopes — the skill never modifies repo/project/workspace/pipeline settings
- All 8 `delete:*` scopes — the skill never deletes anything
- All other `write:*` scopes — only `write:pullrequest:bitbucket` is used (and only for `pr create`)
- `read:project:bitbucket`, `read:workspace:bitbucket` — the skill doesn't query project or workspace resources directly
- `read:gpg-key`, `read:ssh-key`, `read:webhook`, `read:wiki`, `read:snippet`, `read:issue`, `read:runner`, `read:test`, `read:package`, `read:permission` — none of these resources are touched
- `manage:org` — irrelevant
- `read:account`, `read:user:bitbucket` — embedded user display names (PR author, reviewers, pipeline creator) are typically returned with the parent resource scope. If names render as `?` in your output, regenerate with `read:user:bitbucket` added.

## License

MIT
