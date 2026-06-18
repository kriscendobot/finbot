/**
 * Job board over the journal.
 *
 * A producer posts a job to `journal/jobs/open/<UTC>--<sid>--<slug>.md`;
 * eligible consumers race to `claim-job` by `git mv` into `claimed/...`.
 * The git push to `origin/journal` is the serialization point; the loser
 * resets and falls back.
 *
 * Pattern borrowed verbatim from the parent garden's
 * `skills/job-board/SKILL.md`, transliterated from bash to Node.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

import { commitAndPush, runGit } from './journal-sync.js';

/**
 * Post a new job to the board.
 *
 * @param {string} journalRoot
 * @param {object} params
 * @param {string} params.verb
 * @param {string} params.slug
 * @param {string} params.body
 * @param {string[]} params.eligible — role names that may claim
 * @param {string} [params.project]
 * @param {string} [params.repo]
 * @param {number} [params.pr]
 * @param {string} [params.deadline]
 * @param {object} [params.authorizations]
 * @param {object} [opts]
 * @param {boolean} [opts.localOnly]
 * @param {object} [opts.gitOps]
 * @returns {Promise<string>} relative path under journalRoot
 */
export async function postJob(journalRoot, params, opts = {}) {
  const utc = utcStamp();
  const sid = shortId();
  const slug = sanitizeSlug(params.slug);
  const rel = path.join('jobs', 'open', `${utc}--${sid}--${slug}.md`);
  const abs = path.join(journalRoot, rel);

  await fs.mkdir(path.dirname(abs), { recursive: true });

  const frontmatter = [
    '---',
    `job: ${sid}`,
    `posted_by_role: driver`,
    `posted_by_host: ${os.hostname().split('.')[0]}`,
    `posted_at: ${new Date().toISOString()}`,
    `verb: ${params.verb}`,
    `project: ${params.project || 'null'}`,
    `target:`,
    `  repo: ${params.repo || 'null'}`,
    `  pr: ${params.pr ?? 'null'}`,
    `authorizations:`,
    `  live: ${Boolean(params.authorizations?.live)}`,
    `priority: normal`,
    `deadline: ${params.deadline || 'null'}`,
    `eligible_roles:`,
    ...params.eligible.map((r) => `  - ${r}`),
    '---',
    '',
    params.body || '',
    '',
  ].join('\n');

  await fs.writeFile(abs, frontmatter);
  await commitAndPush(journalRoot, {
    paths: [rel],
    message: `jobs: post ${sid} ${params.verb} ${slug}`,
    localOnly: opts.localOnly,
    gitOps: opts.gitOps,
  });
  return rel;
}

/**
 * Claim an open job for a role. Returns the resulting claimed path, or
 * throws `lost-race` if another consumer claimed first.
 *
 * @param {string} journalRoot
 * @param {string} sourceRel — `jobs/open/<...>.md`
 * @param {object} params
 * @param {string} params.role
 * @param {string} [params.host]
 * @param {string} [params.sessionId]
 * @param {object} [opts]
 * @param {boolean} [opts.localOnly]
 * @param {object} [opts.gitOps]
 */
export async function claimJob(journalRoot, sourceRel, params, opts = {}) {
  const gitOps = opts.gitOps || { runGit };
  const host = params.host || os.hostname().split('.')[0];
  const sid = params.sessionId || shortId(4);
  const role = params.role;
  const baseName = path.basename(sourceRel, '.md');
  const [, originalSid, slug] = baseName.split('--');
  const utc = utcStamp();
  const destRel = path.join(
    'jobs',
    'claimed',
    `${utc}--${host}--${role}--${sid}--${originalSid}--${slug}.md`,
  );

  // sync first; a stale HEAD is a lost race waiting to happen
  if (!opts.localOnly) {
    try {
      await gitOps.runGit(journalRoot, ['fetch', '--quiet', 'origin', 'journal']);
      await gitOps.runGit(journalRoot, ['reset', '--hard', 'origin/journal']);
    } catch {
      // tolerate fetch failures locally
    }
  }
  // (localOnly skips fetch/reset; the working tree is the authority for tests)

  const sourceAbs = path.join(journalRoot, sourceRel);
  try {
    await fs.access(sourceAbs);
  } catch {
    const e = new Error('lost-race');
    e.code = 'LOST_RACE';
    throw e;
  }

  // append claim stamp to the file body before the git mv
  const original = await fs.readFile(sourceAbs, 'utf8');
  const stamped = appendClaimStamp(original, { role, host, sessionId: sid });
  await fs.writeFile(sourceAbs, stamped);

  await fs.mkdir(path.join(journalRoot, 'jobs', 'claimed'), { recursive: true });
  await gitOps.runGit(journalRoot, ['mv', sourceRel, destRel]);

  // commit + push; rejection = lost race
  try {
    await commitAndPush(journalRoot, {
      paths: [sourceRel, destRel],
      message: `jobs: claim ${originalSid} on ${host}/${role}/${sid}`,
      localOnly: opts.localOnly,
      maxRetries: 1,
      gitOps,
    });
  } catch (err) {
    if (!opts.localOnly) {
      try {
        await gitOps.runGit(journalRoot, ['reset', '--hard', 'origin/journal']);
      } catch {
        // ignore
      }
    }
    const lost = new Error('lost-race');
    lost.code = 'LOST_RACE';
    lost.cause = err;
    throw lost;
  }
  return destRel;
}

/**
 * Complete (or abandon) a claimed job.
 *
 * @param {string} journalRoot
 * @param {string} claimedRel
 * @param {'done' | 'abandoned'} outcome
 * @param {object} [params]
 * @param {string} [params.resultEntry]
 * @param {string} [params.abandonReason]
 * @param {object} [opts]
 */
export async function completeJob(journalRoot, claimedRel, outcome, params = {}, opts = {}) {
  const gitOps = opts.gitOps || { runGit };
  const utc = utcStamp();
  const name = path.basename(claimedRel);
  const rest = name.slice(name.indexOf('--') + 2);
  const destRel = path.join('jobs', outcome, `${utc}--${rest}`);

  const claimedAbs = path.join(journalRoot, claimedRel);
  const original = await fs.readFile(claimedAbs, 'utf8');
  const stamp = [
    '',
    '# Completion stamp',
    `completed_at: ${new Date().toISOString()}`,
    `outcome: ${outcome}`,
    params.resultEntry ? `result_entry: ${params.resultEntry}` : null,
    params.abandonReason ? `abandon_reason: ${params.abandonReason}` : null,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  await fs.writeFile(claimedAbs, original + stamp);

  await fs.mkdir(path.join(journalRoot, 'jobs', outcome), { recursive: true });
  await gitOps.runGit(journalRoot, ['mv', claimedRel, destRel]);
  await commitAndPush(journalRoot, {
    paths: [claimedRel, destRel],
    message: `jobs: ${outcome} ${name.split('--')[4] || name}`,
    localOnly: opts.localOnly,
    gitOps,
  });
  return destRel;
}

/**
 * List open job paths (relative to journalRoot).
 *
 * @param {string} journalRoot
 */
export async function listOpenJobs(journalRoot) {
  const dir = path.join(journalRoot, 'jobs', 'open');
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((n) => n.endsWith('.md')).map((n) => path.join('jobs', 'open', n));
  } catch {
    return [];
  }
}

function utcStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function shortId(bytes = 3) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sanitizeSlug(s) {
  return String(s || 'job')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function appendClaimStamp(original, { role, host, sessionId }) {
  // append after the first `---\n...\n---\n` close
  const m = original.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return original;
  const head = original.slice(0, m[0].length);
  const body = original.slice(m[0].length);
  const claim = [
    `claimed_by_role: ${role}`,
    `claimed_by_host: ${host}`,
    `claimed_by_session: ${sessionId}`,
    `claimed_at: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  // insert just before the closing `---`
  const replaced = head.replace(/\n---\n$/, `\n${claim}---\n`);
  return replaced + body;
}
