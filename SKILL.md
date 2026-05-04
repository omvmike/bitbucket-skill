---
name: bitbucket
description: Use when the user asks Claude to list, inspect, or create Bitbucket Cloud pull requests, or to check pipeline status and logs, in the project's Bitbucket repository. Triggers on phrases like "list PRs", "show open pull requests", "latest PRs", "pipeline status", "why did the pipeline fail", "create a PR from this branch", "open PR". Auto-detects workspace/repo from the git remote; reads BB_TOKEN from a local .bb file.
allow_implicit_invocation: true
allowed-tools: Bash(node *), Read
---

# bitbucket — Bitbucket Cloud skill

Thin Node.js wrapper over the Bitbucket Cloud v2 REST API. Use it when the user asks about PRs or pipelines in this repo — it replaces ad-hoc curl calls and avoids leaking a token into the terminal history.

## When to use

- Listing / inspecting pull requests (open, merged, mine, by author)
- Fetching a PR's diff, comments, activity feed, or approvals
- Creating a pull request from a branch
- Reading, adding, or editing PR comments (top-level)
- Checking pipeline run status / step logs / why a pipeline failed

## When NOT to use

- Repo is on GitHub, GitLab, or self-hosted Bitbucket Server — this skill only speaks Bitbucket Cloud (`api.bitbucket.org/2.0`).
- User wants to merge / approve / decline a PR, or delete a comment — these writes are intentionally not supported. Say so and fall back to the Bitbucket UI.

## Bootstrap (one-time, per clone)

If `bb --whoami` returns exit code 2 with "no .bb file found", guide the user:

1. Open the API-token page:
   `https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken=&appId=bitbucket`

   Tick these scopes (read-only profile — covers everything except `bb pr create`):
   - `read:user:bitbucket` *(required for `--whoami`)*
   - `read:repository:bitbucket`
   - `read:pullrequest:bitbucket`
   - `read:pipeline:bitbucket`

   Also tick `write:pullrequest:bitbucket` for `bb pr create`, `bb pr comment add`, or `bb pr comment edit`.

2. At the repo root:
   ```sh
   umask 077
   cat > .bb <<'EOF'
   BB_USER=<your-atlassian-email>
   BB_TOKEN=<paste-api-token>
   EOF
   echo .bb >> .gitignore
   ```
3. For OAuth / workspace / repository / project access tokens instead of API tokens: omit `BB_USER` (Bearer auth is used automatically).

Never invent a token. Never write a token into a tracked file.

## Step order Claude must follow

1. Run `bb --whoami` first to confirm auth and print the detected `workspace/slug`. If the user is on an unexpected workspace, stop and confirm with them.
2. Default output is `--format json` (slimmed to relevant fields) so Claude can reason over results. When surfacing results directly to the user, pass `--format table` to render a markdown pipe-table, or reformat the JSON yourself if the user asked for a specific view.
3. **Before `bb pr create`**, restate `source → target`, the title, and a one-line summary of the body to the user, then wait for explicit confirmation. Never invent reviewer usernames — either ask the user or omit `--reviewer`.
4. **Before `bb pr comment add` / `bb pr comment edit`**, restate the PR id (and the comment id for `edit`) and show the comment body to the user, then wait for explicit confirmation. Never invent comment text the user didn't ask for. `pr comment edit` overwrites — fetch the existing body first via `pr comments` if you need to amend rather than replace.
5. Pipeline logs can be long. Prefer `bb pipeline steps <uuid>` first to pick the right step before fetching `bb pipeline log`.

## CLI reference

```
node ~/.claude/skills/bitbucket/bin/bb.mjs <command> [flags]

General:
  --whoami                                 Show detected repo + token validity
  --list-targets                           Show detected repo + .bb file info (no network call)

PRs:
  pr list   [--state OPEN|MERGED|DECLINED|ALL] [--mine|--author <uuid|nickname>] [--limit N]
  pr get    <id>
  pr diff   <id>
  pr activity <id>
  pr create --source <branch> --target <branch> --title <t>
            [--body <text>|@file] [--close-source-branch] [--draft]
            [--reviewer <uuid|nickname>]  (repeatable)
            [--yes]                       Required when stdin is a TTY

  pr comments    <pr-id> [--limit N]    List PR comments (newest first)
  pr comment add  <pr-id> --body <text>|@file [--yes]
  pr comment edit <pr-id> <comment-id> --body <text>|@file [--yes]

Pipelines:
  pipeline list  [--branch <name>] [--status pending|in_progress|successful|failed|stopped] [--limit N]
  pipeline get   <uuid>
  pipeline steps <uuid>
  pipeline log   <pipeline-uuid> <step-uuid>

Global flags:
  --repo <workspace>/<slug>                Override auto-detected repo
  --format json|table                      Default: json (diff/log always raw text)
  --limit N                                Default: 10
  --timeout MS                             Default: 15000
```

## Exit codes

| Code | Meaning | Response |
|------|---------|----------|
| 0 | Success | — |
| 2 | Config / auth (missing .bb, invalid token, 401/403) | Guide through bootstrap or ask for a fresh token |
| 3 | Not found (404) | Surface to user; don't retry |
| 4 | Validation (bad flags, unknown command) | Fix the command and retry |
| 5 | Network / timeout / 5xx | Retry once, then surface |
| 6 | Rate-limited (429) | Back off; surface `retry-after` from stderr |

## Config precedence

- Workspace: `--repo` flag > `BB_WORKSPACE` in `.bb` > git-remote parse
- Repo slug: `--repo` flag > git-remote parse
- `.bb` location: project root (walking up from CWD to first `.git`) > `~/.config/bitbucket/.bb`
