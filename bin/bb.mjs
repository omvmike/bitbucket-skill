#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveTarget } from '../lib/targets.mjs';
import { makeClient, ApiError, EXIT } from '../lib/api.mjs';
import {
  formatPrList,
  formatPrDetail,
  formatPrActivity,
  formatCommentList,
  formatCommentDetail,
  formatPipelineList,
  formatPipelineDetail,
  formatPipelineSteps,
} from '../lib/format.mjs';

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = JSON.parse(readFileSync(join(SKILL_DIR, 'config.json'), 'utf8'));

const HELP = `bb — Bitbucket Cloud skill CLI

Usage:
  bb <command> [flags]

Commands:
  --whoami                                    Show detected repo + token validity
  --list-targets                              Show git-remote-detected repo and .bb file

  pr list   [--state OPEN|MERGED|DECLINED|ALL] [--mine] [--author <uuid|nickname>]
            [--limit N]
  pr get    <id>
  pr diff   <id>
  pr activity <id>
  pr create --source <branch> --target <branch> --title <t>
            [--body <text>|@file] [--close-source-branch] [--draft]
            [--reviewer <uuid|nickname>] (repeatable)
            [--yes]                           Required when stdin is a TTY

  pr comments    <pr-id> [--limit N]          List PR comments (newest first)
  pr comment add  <pr-id> --body <text>|@file [--yes]
  pr comment edit <pr-id> <comment-id> --body <text>|@file [--yes]

  pipeline list  [--branch <name>] [--status pending|in_progress|successful|failed|stopped]
                 [--limit N]
  pipeline get   <uuid>
  pipeline steps <uuid>
  pipeline log   <pipeline-uuid> <step-uuid>

Global flags:
  --repo <workspace>/<slug>   Override auto-detected repo
  --format json|table         Default: json
  --limit N                   Default: ${CONFIG.defaultLimit}
  --timeout MS                Default: ${CONFIG.timeoutMs}
  -h, --help                  Show this help

Exit codes: 0=ok 2=auth/config 3=not-found 4=validation 5=network 6=rate-limited`;

function die(msg, exit = EXIT.VALIDATION) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(exit);
}

function emitHintBlock(hints) {
  process.stderr.write('─── bitbucket: setup hint ───\n');
  for (const line of hints) process.stderr.write(`${line}\n`);
  process.stderr.write('─────────────────────────────\n');
}

function applyHints(output, hints) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }
  const isJson = parsed !== undefined && typeof parsed === 'object';
  if (hints.length === 0) return { output, isJson };
  if (isJson && !Array.isArray(parsed)) {
    parsed._hint = hints.map((h) => `[bitbucket] ${h}`).join('\n');
    return { output: JSON.stringify(parsed, null, 2), isJson };
  }
  emitHintBlock(hints);
  return { output, isJson };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const repeatable = { reviewer: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const bools = new Set(['mine', 'close-source-branch', 'draft', 'whoami', 'list-targets', 'yes']);
      if (bools.has(key)) {
        flags[key] = true;
      } else if (key === 'reviewer') {
        repeatable.reviewer.push(next);
        i++;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  flags.reviewer = repeatable.reviewer;
  return { positional, flags };
}

function bodyFromFlag(raw) {
  if (raw == null) return undefined;
  if (raw.startsWith('@')) {
    return readFileSync(raw.slice(1), 'utf8');
  }
  return raw;
}

const TOKEN_URL =
  'https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken=&appId=bitbucket';

function ensureAuth(target, hints) {
  if (!target.config.path) {
    die(
      `no .bb file found.\n\n` +
        `1. Create an Atlassian API token at:\n` +
        `   ${TOKEN_URL}\n` +
        `   On that page, tick these scopes (read-only profile, covers everything except pr create):\n` +
        `     - read:me\n` +
        `     - read:repository:bitbucket\n` +
        `     - read:pullrequest:bitbucket\n` +
        `     - read:pipeline:bitbucket\n` +
        `   Add write:pullrequest:bitbucket if you also want \`bb pr create\`.\n\n` +
        `2. Save it at the project root:\n` +
        `   umask 077\n` +
        `   cat > .bb <<'EOF'\n` +
        `   BB_USER=<your-atlassian-email>\n` +
        `   BB_TOKEN=<paste-api-token>\n` +
        `   EOF\n` +
        `   echo .bb >> .gitignore\n\n` +
        `Bearer tokens (OAuth / workspace / repo / project access tokens) also work —\n` +
        `in that case omit BB_USER and set only BB_TOKEN.`,
      EXIT.CONFIG,
    );
  }
  if (!target.token) die(`BB_TOKEN missing in ${target.config.path}. Create one at ${TOKEN_URL}`, EXIT.CONFIG);
  if (target.config.worldReadable) {
    hints.push(`${target.config.path} is not chmod 600 — run \`chmod 600 ${target.config.path}\` to lock it down.`);
  }
}

function ensureRepo(target) {
  if (!target.workspace || !target.slug) {
    die(
      `could not resolve workspace/repo. Either run inside a bitbucket.org clone, set BB_WORKSPACE in .bb, or pass --repo <workspace>/<slug>.`,
      EXIT.CONFIG,
    );
  }
}

async function cmdWhoami(client, target) {
  const me = await client.get('/user');
  const lines = [`user:      ${me.display_name ?? me.username ?? me.uuid ?? '?'}`];
  if (me.account_id) lines.push(`accountId: ${me.account_id}`);
  if (me.uuid) lines.push(`uuid:      ${me.uuid}`);
  if (target.workspace && target.slug) {
    lines.push(`repo:      ${target.workspace}/${target.slug} (source: ${target.source})`);
  } else {
    lines.push(`repo:      (not resolved — pass --repo or run inside a clone)`);
  }
  lines.push(`.bb:       ${target.config.path ?? '(none)'}`);
  lines.push(`auth:      ${target.user ? 'Basic' : 'Bearer'}`);
  return lines.join('\n');
}

function listTargets(target) {
  const lines = [];
  lines.push(`workspace: ${target.workspace ?? '(unresolved)'}`);
  lines.push(`slug:      ${target.slug ?? '(unresolved)'}`);
  lines.push(`source:    ${target.source ?? '(none)'}`);
  lines.push(`.bb:       ${target.config.path ?? '(none)'}`);
  lines.push(`has BB_TOKEN: ${target.token ? 'yes' : 'no'}`);
  lines.push(`has BB_USER:  ${target.user ? 'yes' : 'no'}`);
  lines.push(`has BB_WORKSPACE: ${target.config.env?.BB_WORKSPACE ? 'yes' : 'no'}`);
  return lines.join('\n');
}

async function cmdPrList(client, target, flags, limit) {
  const state = (flags.state ?? 'OPEN').toUpperCase();
  const validStates = new Set(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED', 'ALL']);
  if (!validStates.has(state)) die(`--state must be one of ${[...validStates].join(',')}`);
  const query = { sort: '-updated_on' };
  if (state !== 'ALL') query.state = state;
  let q = [];
  if (flags.mine) {
    const me = await client.get('/user');
    q.push(`author.uuid="${me.uuid}"`);
  } else if (flags.author) {
    const v = flags.author.startsWith('{') ? flags.author : `"${flags.author}"`;
    q.push(`author.uuid=${v}`);
  }
  if (q.length) query.q = q.join(' AND ');
  const { values } = await client.paginated(
    `/repositories/${target.workspace}/${target.slug}/pullrequests`,
    query,
    { limit },
  );
  return formatPrList(values, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPrGet(client, target, id, flags) {
  if (!id) die('pr get requires <id>');
  const pr = await client.get(`/repositories/${target.workspace}/${target.slug}/pullrequests/${id}`);
  return formatPrDetail(pr, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPrDiff(client, target, id) {
  if (!id) die('pr diff requires <id>');
  return client.get(
    `/repositories/${target.workspace}/${target.slug}/pullrequests/${id}/diff`,
    null,
    { accept: 'text/plain' },
  );
}

async function cmdPrActivity(client, target, id, flags, limit) {
  if (!id) die('pr activity requires <id>');
  const { values } = await client.paginated(
    `/repositories/${target.workspace}/${target.slug}/pullrequests/${id}/activity`,
    {},
    { limit },
  );
  return formatPrActivity(values, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPrCreate(client, target, flags) {
  if (process.stdin.isTTY && !flags.yes) {
    die('pr create from a TTY requires --yes to confirm', EXIT.VALIDATION);
  }
  if (!flags.source) die('pr create requires --source <branch>');
  if (!flags.target) die('pr create requires --target <branch>');
  if (!flags.title) die('pr create requires --title <text>');
  const body = {
    title: flags.title,
    source: { branch: { name: flags.source } },
    destination: { branch: { name: flags.target } },
  };
  const description = bodyFromFlag(flags.body);
  if (description != null) body.description = description;
  if (flags['close-source-branch']) body.close_source_branch = true;
  if (flags.draft) body.draft = true;
  if (flags.reviewer?.length) {
    body.reviewers = flags.reviewer.map((r) => (r.startsWith('{') ? { uuid: r } : { nickname: r }));
  }
  const pr = await client.post(`/repositories/${target.workspace}/${target.slug}/pullrequests`, body);
  return formatPrDetail(pr, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPrComments(client, target, prId, flags, limit) {
  if (!prId) die('pr comments requires <pr-id>');
  const { values } = await client.paginated(
    `/repositories/${target.workspace}/${target.slug}/pullrequests/${prId}/comments`,
    { sort: '-created_on' },
    { limit },
  );
  return formatCommentList(values, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPrCommentAdd(client, target, prId, flags) {
  if (process.stdin.isTTY && !flags.yes) {
    die('pr comment add from a TTY requires --yes to confirm', EXIT.VALIDATION);
  }
  if (!prId) die('pr comment add requires <pr-id>');
  const raw = bodyFromFlag(flags.body);
  if (!raw) die('pr comment add requires --body <text>|@file');
  const created = await client.post(
    `/repositories/${target.workspace}/${target.slug}/pullrequests/${prId}/comments`,
    { content: { raw } },
  );
  return formatCommentDetail(created, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPrCommentEdit(client, target, prId, commentId, flags) {
  if (process.stdin.isTTY && !flags.yes) {
    die('pr comment edit from a TTY requires --yes to confirm', EXIT.VALIDATION);
  }
  if (!prId) die('pr comment edit requires <pr-id>');
  if (!commentId) die('pr comment edit requires <comment-id>');
  const raw = bodyFromFlag(flags.body);
  if (!raw) die('pr comment edit requires --body <text>|@file');
  const updated = await client.put(
    `/repositories/${target.workspace}/${target.slug}/pullrequests/${prId}/comments/${commentId}`,
    { content: { raw } },
  );
  return formatCommentDetail(updated, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPipelineList(client, target, flags, limit) {
  const query = { sort: '-created_on' };
  if (flags.branch) query['target.branch'] = flags.branch;
  if (flags.status) query['state.name'] = flags.status;
  const { values } = await client.paginated(
    `/repositories/${target.workspace}/${target.slug}/pipelines/`,
    query,
    { limit },
  );
  return formatPipelineList(values, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPipelineGet(client, target, uuid, flags) {
  if (!uuid) die('pipeline get requires <uuid>');
  const p = await client.get(`/repositories/${target.workspace}/${target.slug}/pipelines/${uuid}`);
  return formatPipelineDetail(p, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPipelineSteps(client, target, uuid, flags) {
  if (!uuid) die('pipeline steps requires <uuid>');
  const res = await client.get(`/repositories/${target.workspace}/${target.slug}/pipelines/${uuid}/steps/`);
  return formatPipelineSteps(res.values ?? [], { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdPipelineLog(client, target, pipelineUuid, stepUuid) {
  if (!pipelineUuid || !stepUuid) die('pipeline log requires <pipeline-uuid> <step-uuid>');
  return client.get(
    `/repositories/${target.workspace}/${target.slug}/pipelines/${pipelineUuid}/steps/${stepUuid}/log`,
    null,
    { accept: 'text/plain' },
  );
}

async function main() {
  const startedAt = Date.now();
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || positional.length === 0 && !flags.whoami && !flags['list-targets']) {
    process.stdout.write(`${HELP}\n`);
    process.exit(flags.help ? 0 : EXIT.VALIDATION);
  }

  const cwd = process.cwd();
  let target;
  try {
    target = resolveTarget({ cwd, repoOverride: flags.repo });
  } catch (err) {
    die(err.message, EXIT.VALIDATION);
  }

  if (flags['list-targets']) {
    process.stdout.write(`${listTargets(target)}\n`);
    process.exit(EXIT.OK);
  }

  const hints = [];
  ensureAuth(target, hints);
  const timeoutMs = flags.timeout ? Number(flags.timeout) : CONFIG.timeoutMs;
  const limit = flags.limit ? Number(flags.limit) : CONFIG.defaultLimit;
  const client = makeClient({ user: target.user, token: target.token, timeoutMs });

  try {
    let output;
    if (flags.whoami) {
      output = await cmdWhoami(client, target);
    } else {
      const [group, sub, ...rest] = positional;
      if (group === 'pr') {
        ensureRepo(target);
        if (sub === 'list') output = await cmdPrList(client, target, flags, limit);
        else if (sub === 'get') output = await cmdPrGet(client, target, rest[0], flags);
        else if (sub === 'diff') output = await cmdPrDiff(client, target, rest[0]);
        else if (sub === 'activity') output = await cmdPrActivity(client, target, rest[0], flags, limit);
        else if (sub === 'create') output = await cmdPrCreate(client, target, flags);
        else if (sub === 'comments') output = await cmdPrComments(client, target, rest[0], flags, limit);
        else if (sub === 'comment') {
          const action = rest[0];
          if (action === 'add') output = await cmdPrCommentAdd(client, target, rest[1], flags);
          else if (action === 'edit') output = await cmdPrCommentEdit(client, target, rest[1], rest[2], flags);
          else die(`unknown pr comment action: ${action ?? '(missing)'} — expected add|edit`);
        }
        else die(`unknown pr subcommand: ${sub}`);
      } else if (group === 'pipeline') {
        ensureRepo(target);
        if (sub === 'list') output = await cmdPipelineList(client, target, flags, limit);
        else if (sub === 'get') output = await cmdPipelineGet(client, target, rest[0], flags);
        else if (sub === 'steps') output = await cmdPipelineSteps(client, target, rest[0], flags);
        else if (sub === 'log') output = await cmdPipelineLog(client, target, rest[0], rest[1]);
        else die(`unknown pipeline subcommand: ${sub}`);
      } else {
        die(`unknown command: ${group}`);
      }
    }
    const result = applyHints(output, hints);
    process.stdout.write(`${result.output}\n`);
    const elapsed = Date.now() - startedAt;
    if (target.workspace && target.slug && !result.isJson) {
      process.stderr.write(`-- ${elapsed}ms from ${target.workspace}/${target.slug}\n`);
    }
    process.exit(EXIT.OK);
  } catch (err) {
    if (err instanceof ApiError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exit);
    }
    process.stderr.write(`error: ${err.stack ?? err.message}\n`);
    process.exit(EXIT.NETWORK);
  }
}

main();
