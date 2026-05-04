function truncate(str, max) {
  if (str == null) return '';
  const s = String(str).replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function duration(seconds) {
  if (seconds == null) return '';
  const n = Number(seconds);
  if (Number.isNaN(n)) return String(seconds);
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m${n % 60}s`;
  return `${Math.floor(n / 3600)}h${Math.floor((n % 3600) / 60)}m`;
}

function mdTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const pad = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-|-');
  return [`| ${pad(headers)} |`, `|-${sep}-|`, ...rows.map((r) => `| ${pad(r)} |`)].join('\n');
}

export function formatPrList(values, { format }) {
  if (format === 'json') {
    return JSON.stringify(
      values.map((pr) => ({
        id: pr.id,
        title: pr.title,
        state: pr.state,
        author: pr.author?.display_name ?? pr.author?.nickname,
        source: pr.source?.branch?.name,
        destination: pr.destination?.branch?.name,
        updated_on: pr.updated_on,
        created_on: pr.created_on,
        link: pr.links?.html?.href,
      })),
      null,
      2,
    );
  }
  const rows = values.map((pr) => [
    pr.id,
    truncate(pr.title, 60),
    truncate(pr.author?.display_name ?? pr.author?.nickname ?? '', 20),
    `${truncate(pr.source?.branch?.name ?? '', 20)} → ${truncate(pr.destination?.branch?.name ?? '', 20)}`,
    pr.state,
    shortDate(pr.updated_on),
  ]);
  return mdTable(['#', 'title', 'author', 'src→dst', 'state', 'updated'], rows);
}

export function formatPrDetail(pr, { format }) {
  if (format === 'json') return JSON.stringify(pr, null, 2);
  const lines = [
    `# PR #${pr.id}: ${pr.title}`,
    '',
    `- **state**: ${pr.state}`,
    `- **author**: ${pr.author?.display_name ?? pr.author?.nickname ?? ''}`,
    `- **source → destination**: ${pr.source?.branch?.name} → ${pr.destination?.branch?.name}`,
    `- **created**: ${shortDate(pr.created_on)}`,
    `- **updated**: ${shortDate(pr.updated_on)}`,
    `- **link**: ${pr.links?.html?.href ?? ''}`,
  ];
  if (pr.reviewers?.length) {
    lines.push(`- **reviewers**: ${pr.reviewers.map((r) => r.display_name ?? r.nickname).join(', ')}`);
  }
  if (pr.description) {
    lines.push('', '## description', '', pr.description);
  }
  return lines.join('\n');
}

export function formatPrActivity(values, { format }) {
  if (format === 'json') return JSON.stringify(values, null, 2);
  const lines = [];
  for (const entry of values) {
    if (entry.comment) {
      const c = entry.comment;
      const who = c.user?.display_name ?? c.user?.nickname ?? '?';
      const where = c.inline ? ` on ${c.inline.path}:${c.inline.to ?? c.inline.from ?? ''}` : '';
      lines.push(`[${shortDate(c.created_on)}] comment by ${who}${where}`);
      if (c.content?.raw) lines.push(`  ${truncate(c.content.raw, 500)}`);
    } else if (entry.approval) {
      const a = entry.approval;
      lines.push(`[${shortDate(a.date)}] approved by ${a.user?.display_name ?? a.user?.nickname ?? '?'}`);
    } else if (entry.changes_requested) {
      const a = entry.changes_requested;
      lines.push(`[${shortDate(a.date)}] changes requested by ${a.user?.display_name ?? a.user?.nickname ?? '?'}`);
    } else if (entry.update) {
      const u = entry.update;
      lines.push(`[${shortDate(u.date)}] updated: ${u.state ?? ''} by ${u.author?.display_name ?? '?'}`);
    }
  }
  return lines.join('\n');
}

export function formatPipelineList(values, { format }) {
  if (format === 'json') {
    return JSON.stringify(
      values.map((p) => ({
        build_number: p.build_number,
        uuid: p.uuid,
        state: p.state?.name,
        result: p.state?.result?.name ?? null,
        branch: p.target?.ref_name ?? p.target?.branch,
        trigger: p.trigger?.name ?? p.trigger?.type,
        creator: p.creator?.display_name,
        created_on: p.created_on,
        duration_in_seconds: p.duration_in_seconds,
        link: p.links?.html?.href,
      })),
      null,
      2,
    );
  }
  const rows = values.map((p) => [
    p.build_number,
    truncate(p.trigger?.name ?? p.trigger?.type ?? '', 16),
    truncate(p.target?.ref_name ?? p.target?.branch ?? '', 30),
    p.state?.name ?? '',
    p.state?.result?.name ?? '',
    shortDate(p.created_on),
    duration(p.duration_in_seconds),
  ]);
  return mdTable(['#', 'trigger', 'branch', 'state', 'result', 'created', 'dur'], rows);
}

export function formatPipelineDetail(p, { format }) {
  if (format === 'json') return JSON.stringify(p, null, 2);
  return [
    `# Pipeline #${p.build_number} — ${p.state?.name ?? ''}${p.state?.result?.name ? ` (${p.state.result.name})` : ''}`,
    '',
    `- **uuid**: ${p.uuid}`,
    `- **branch**: ${p.target?.ref_name ?? p.target?.branch ?? ''}`,
    `- **commit**: ${p.target?.commit?.hash ?? ''}`,
    `- **trigger**: ${p.trigger?.name ?? p.trigger?.type ?? ''}`,
    `- **creator**: ${p.creator?.display_name ?? ''}`,
    `- **created**: ${shortDate(p.created_on)}`,
    `- **completed**: ${shortDate(p.completed_on)}`,
    `- **duration**: ${duration(p.duration_in_seconds)}`,
    `- **link**: ${p.links?.html?.href ?? ''}`,
  ].join('\n');
}

export function formatPipelineSteps(values, { format }) {
  if (format === 'json') return JSON.stringify(values, null, 2);
  const rows = values.map((s, i) => [
    i + 1,
    truncate(s.name ?? '', 40),
    s.state?.name ?? '',
    s.state?.result?.name ?? '',
    duration(s.duration_in_seconds),
    s.uuid,
  ]);
  return mdTable(['#', 'name', 'state', 'result', 'dur', 'uuid'], rows);
}

function commentJsonShape(c) {
  return {
    id: c.id,
    parent_id: c.parent?.id ?? null,
    author: c.user?.display_name ?? c.user?.nickname ?? null,
    created_on: c.created_on,
    updated_on: c.updated_on,
    body: c.content?.raw ?? null,
    inline: c.inline ? { path: c.inline.path, from: c.inline.from ?? null, to: c.inline.to ?? null } : null,
    deleted: c.deleted ?? false,
    link: c.links?.html?.href ?? null,
  };
}

export function formatCommentList(values, { format }) {
  if (format === 'json') {
    return JSON.stringify(values.map(commentJsonShape), null, 2);
  }
  const rows = values.map((c) => [
    c.id,
    truncate(c.user?.display_name ?? c.user?.nickname ?? '', 20),
    shortDate(c.created_on),
    c.inline ? `${truncate(c.inline.path, 24)}:${c.inline.to ?? c.inline.from ?? ''}` : '',
    truncate(c.content?.raw ?? (c.deleted ? '(deleted)' : ''), 60),
  ]);
  return mdTable(['id', 'author', 'created', 'inline', 'preview'], rows);
}

export function formatCommentDetail(c, { format }) {
  if (format === 'json') {
    return JSON.stringify(commentJsonShape(c), null, 2);
  }
  const lines = [
    `# Comment ${c.id}`,
    '',
    `- **author**: ${c.user?.display_name ?? c.user?.nickname ?? ''}`,
    `- **created**: ${shortDate(c.created_on)}`,
    `- **updated**: ${shortDate(c.updated_on)}`,
  ];
  if (c.parent?.id) lines.push(`- **reply to**: ${c.parent.id}`);
  if (c.inline) {
    lines.push(`- **inline**: ${c.inline.path}:${c.inline.to ?? c.inline.from ?? ''}`);
  }
  if (c.links?.html?.href) lines.push(`- **link**: ${c.links.html.href}`);
  if (c.content?.raw) lines.push('', '## body', '', c.content.raw);
  return lines.join('\n');
}
