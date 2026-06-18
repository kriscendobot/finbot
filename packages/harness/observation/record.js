/**
 * Observation recorder.
 *
 * Writes journal entries under `entries/<YYYY>/<MM>/<DD>/<HHMMSS>Z-<kind>-<role>-<sid>.md`
 * and pushes through the journal-sync rebase-retry loop. This is the
 * primitive every other observation flows through: subagent progress
 * events, message-bus posts, tick markers, results.
 *
 * Entry shape (mirrors the parent garden's COMMON.md):
 *
 *   ---
 *   ts: <ISO>
 *   kind: dispatch | tick | message | result | worktree
 *   role: <role>
 *   project: <slug>
 *   to: <role>          # for messages
 *   refs:
 *     - <path>
 *   ---
 *
 *   <body>
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';

import { commitAndPush } from '../message-bus/journal-sync.js';

/**
 * Record a journal entry.
 *
 * @param {string} journalRoot
 * @param {object} entry
 * @param {string} entry.kind
 * @param {string} entry.role
 * @param {string} entry.body
 * @param {string} [entry.to]
 * @param {string} [entry.project]
 * @param {string[]} [entry.refs]
 * @param {string} [entry.worktree]
 * @param {string} [entry.repo]
 * @param {object} [opts]
 * @param {boolean} [opts.localOnly]
 * @param {object} [opts.gitOps]
 * @returns {Promise<string>} relative path under journalRoot
 */
export async function recordEntry(journalRoot, entry, opts = {}) {
  const now = new Date();
  const utcDate = isoDate(now);
  const utcTime = isoTimeCompact(now);
  const sid = shortId();
  const dirRel = path.join('entries', utcDate.replace(/-/g, '/'));
  const rel = path.join(
    dirRel,
    `${utcTime}-${entry.kind}-${entry.role}-${sid}.md`,
  );
  const abs = path.join(journalRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const fmLines = [
    '---',
    `ts: ${now.toISOString()}`,
    `kind: ${entry.kind}`,
    `role: ${entry.role}`,
  ];
  if (entry.worktree) fmLines.push(`worktree: ${entry.worktree}`);
  if (entry.repo) fmLines.push(`repo: ${entry.repo}`);
  if (entry.project) fmLines.push(`project: ${entry.project}`);
  if (entry.to) {
    fmLines.push(entry.to === '*' ? 'to: "*"' : `to: ${entry.to}`);
  }
  if (entry.refs && entry.refs.length > 0) {
    fmLines.push('refs:');
    for (const r of entry.refs) fmLines.push(`  - ${r}`);
  } else {
    fmLines.push('refs: []');
  }
  fmLines.push('---', '');

  const content = fmLines.join('\n') + (entry.body || '') + '\n';
  await fs.writeFile(abs, content);
  await commitAndPush(journalRoot, {
    paths: [rel],
    message: `entry: ${entry.kind} ${entry.role} ${sid}`,
    localOnly: opts.localOnly,
    gitOps: opts.gitOps,
  });
  return rel;
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function isoTimeCompact(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function shortId() {
  return crypto.randomBytes(3).toString('hex');
}
