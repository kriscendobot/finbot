/**
 * Journal sync — commit + push under a rebase-retry loop.
 *
 * Pattern borrowed verbatim from the parent garden's
 * `skills/journal-sync/SKILL.md`. Every journal write goes through
 * `commitAndPush()`; concurrent writers on different paths converge
 * because git's rebase resolves non-overlapping commits, and writers on
 * the same path (the job-board claim race) deliberately reset-and-fail
 * the loser so the winner is unambiguous.
 *
 * The harness exposes a `gitOps` injection point so the integration
 * test can swap a real git for an in-process journal store. Default is
 * the real git.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Run `git` with the given args at `cwd` and resolve with stdout. Reject
 * with the stderr on non-zero exit.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    proc.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(Object.assign(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`), { stdout, stderr, code }));
    });
    proc.on('error', reject);
  });
}

/**
 * Commit (always) and push (with rebase-retry) the given files in the
 * journal worktree.
 *
 * @param {string} journalRoot
 * @param {object} opts
 * @param {string[]} opts.paths — paths under journalRoot to add
 * @param {string} opts.message — commit message
 * @param {number} [opts.maxRetries] default 5
 * @param {boolean} [opts.localOnly] — skip push (test mode)
 * @param {object} [opts.gitOps] — optional injected runner (for tests)
 */
export async function commitAndPush(journalRoot, opts) {
  const gitOps = opts.gitOps || { runGit };
  const maxRetries = opts.maxRetries ?? 5;
  // `git add` tolerates deletion via the parent directory: pass each path's
  // parent directory so that both halves of a rename done upstream of this
  // call (e.g. `git mv` in claimJob) are staged. Direct add on a deleted
  // pathspec errors with "did not match any files".
  const parents = new Set();
  for (const p of opts.paths) {
    parents.add(path.dirname(p));
  }
  for (const parent of parents) {
    await gitOps.runGit(journalRoot, ['add', '-A', '--', parent]);
  }
  // detect whether there is anything to commit
  const { stdout: status } = await gitOps.runGit(journalRoot, ['status', '--porcelain']);
  if (status.trim() === '') {
    return { committed: false };
  }
  await gitOps.runGit(journalRoot, ['commit', '-m', opts.message]);
  if (opts.localOnly) {
    return { committed: true, pushed: false };
  }
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await gitOps.runGit(journalRoot, ['push', 'origin', 'HEAD:journal']);
      return { committed: true, pushed: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      try {
        await gitOps.runGit(journalRoot, ['fetch', '--quiet', 'origin', 'journal']);
        await gitOps.runGit(journalRoot, ['rebase', 'origin/journal']);
      } catch (rebaseErr) {
        try {
          await gitOps.runGit(journalRoot, ['rebase', '--abort']);
        } catch {
          // ignore
        }
        await sleep(attempt * attempt * 200);
      }
    }
  }
  throw lastErr || new Error('commitAndPush: max retries exhausted');
}

/**
 * Ensure a path exists under journalRoot; mkdir -p the parent.
 *
 * @param {string} journalRoot
 * @param {string} relPath
 */
export async function ensureUnderJournal(journalRoot, relPath) {
  await fs.mkdir(path.join(journalRoot, path.dirname(relPath)), { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
