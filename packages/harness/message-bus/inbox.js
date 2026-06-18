/**
 * Per-role inbox over the journal.
 *
 * Pattern borrowed from the parent garden's `skills/inbox-drain/SKILL.md`:
 * a per-host state file at `journal/inboxes/<host>/<role>.md` carries the
 * last-drained position; `drainInbox()` returns entries authored *for*
 * this role (or to `*`) since the state file's last-drained commit.
 *
 * Posting is the inverse: write a `message` entry with `to: <role>`.
 * Anything written through `recordEntry({ kind: 'message', to: '<role>' })`
 * lands in that role's inbox; `postToInbox()` is sugar.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { recordEntry } from '../observation/record.js';
import { commitAndPush, runGit } from './journal-sync.js';

/**
 * Post a message into a role's inbox. Wraps recordEntry with a `to:` field.
 *
 * @param {string} journalRoot
 * @param {object} params
 * @param {string} params.to — recipient role; `'*'` for broadcast.
 * @param {string} params.from — sender role.
 * @param {string} params.body — markdown body.
 * @param {string} [params.project]
 * @param {string[]} [params.refs]
 * @param {object} [opts]
 * @param {boolean} [opts.localOnly]
 * @param {object} [opts.gitOps]
 */
export async function postToInbox(journalRoot, params, opts = {}) {
  return recordEntry(journalRoot, {
    kind: 'message',
    role: params.from,
    to: params.to,
    project: params.project,
    refs: params.refs,
    body: params.body,
  }, opts);
}

/**
 * Drain inbox: list entries addressed to `role` since the last drained
 * commit. Updates the state file (commits + pushes) on success.
 *
 * @param {string} journalRoot
 * @param {string} role
 * @param {object} [opts]
 * @param {string} [opts.hostKey] override `hostname -s` (used by tests)
 * @param {object} [opts.gitOps] inject git operations for tests
 * @param {boolean} [opts.localOnly] skip push
 * @returns {Promise<Array<{ path: string, to: string, ts: string, role: string }>>}
 */
export async function drainInbox(journalRoot, role, opts = {}) {
  const host = opts.hostKey || os.hostname().split('.')[0];
  const stateRel = path.join('inboxes', host, `${role}.md`);
  const stateAbs = path.join(journalRoot, stateRel);
  const gitOps = opts.gitOps || { runGit };

  // ensure the state directory exists
  await fs.mkdir(path.dirname(stateAbs), { recursive: true });

  let lastDrainedCommit = null;
  try {
    const raw = await fs.readFile(stateAbs, 'utf8');
    const m = raw.match(/^last_drained_commit:\s*(\S+)/m);
    if (m) lastDrainedCommit = m[1];
  } catch {
    // no state file yet
  }

  // current HEAD of the journal
  const { stdout: headSha } = await gitOps.runGit(journalRoot, ['rev-parse', 'HEAD']);
  const currentHead = headSha.trim();

  if (lastDrainedCommit === currentHead) {
    return [];
  }

  // list new entries committed since last drain
  let entries;
  if (lastDrainedCommit) {
    try {
      const { stdout } = await gitOps.runGit(journalRoot, [
        'diff',
        '--name-only',
        '--diff-filter=A',
        `${lastDrainedCommit}..HEAD`,
        '--',
        'entries/',
      ]);
      entries = stdout.split('\n').filter(Boolean);
    } catch {
      // history rewrite; fall back to all entries
      entries = await listAllEntries(journalRoot);
    }
  } else {
    // initialize: no historical replay
    entries = [];
  }

  // filter to entries with to: role or to: '*'
  const matched = [];
  for (const rel of entries) {
    if (!rel.endsWith('.md')) continue;
    let raw;
    try {
      raw = await fs.readFile(path.join(journalRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const fm = readSimpleFrontmatter(raw);
    if (fm.to === role || fm.to === '*' || fm.to === '"*"') {
      matched.push({ path: rel, to: fm.to, ts: fm.ts || '', role: fm.role || '' });
    }
  }

  // sort chronologically by ts (filename order is also chronological)
  matched.sort((a, b) => (a.path < b.path ? -1 : 1));

  // emit a state file commit only when matched is non-empty (the parent
  // garden's 2026-06-02 optimization to avoid runaway state-file commits)
  if (matched.length > 0 || !lastDrainedCommit) {
    const state = [
      '---',
      `host: ${host}`,
      `role: ${role}`,
      `last_drained_at: ${new Date().toISOString()}`,
      `last_drained_commit: ${currentHead}`,
      '---',
      '',
      'Per-host inbox state. Maintained by @finbot/harness/message-bus/inbox.',
      '',
    ].join('\n');
    await fs.writeFile(stateAbs, state);
    await commitAndPush(journalRoot, {
      paths: [stateRel],
      message: `inbox: drain ${role}@${host} -> ${currentHead.slice(0, 8)}`,
      localOnly: opts.localOnly,
      gitOps,
    });
  }

  return matched;
}

async function listAllEntries(journalRoot) {
  const entriesDir = path.join(journalRoot, 'entries');
  const out = [];
  async function walk(dir) {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else if (d.isFile() && full.endsWith('.md')) {
        out.push(path.relative(journalRoot, full));
      }
    }
  }
  await walk(entriesDir);
  return out;
}

/**
 * Minimal YAML frontmatter reader for inbox dispatch. Returns flat string
 * map of the leading `---` block, or `{}` if the file lacks frontmatter.
 *
 * @param {string} raw
 */
export function readSimpleFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return {};
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) return {};
  const fm = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[m[1]] = v;
  }
  return fm;
}
