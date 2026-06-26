/**
 * Loop tests.
 *
 * Verify each OODA phase posts the right number of jobs given inputs.
 * The integration test in integration.test.js covers the end-to-end
 * tick; this file covers each phase in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runOnce, randomShortId } from '../loop.js';
import { runGit } from '../message-bus/journal-sync.js';
import { listOpenJobs } from '../message-bus/job-board.js';
import { postToInbox } from '../message-bus/inbox.js';

async function setupJournal() {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-loop-journal-'));
  await runGit(root, ['init', '--initial-branch=journal']);
  await runGit(root, ['config', 'user.name', 'finbot-test']);
  await runGit(root, ['config', 'user.email', 'finbot-test@example.com']);
  await runGit(root, ['commit', '--allow-empty', '-m', 'journal: initial']);
  return root;
}

async function setupFinbotRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-loop-root-'));
  await mkdir(path.join(root, 'skills'), { recursive: true });
  await mkdir(path.join(root, 'skills', 'noop'), { recursive: true });
  await writeFile(path.join(root, 'skills', 'noop', 'SKILL.md'), '# Skill: noop\n\nNo-op.\n');
  return root;
}

test('randomShortId: produces 6 hex chars', () => {
  for (let i = 0; i < 20; i += 1) {
    const sid = randomShortId();
    assert.match(sid, /^[0-9a-f]{6}$/);
  }
});

test('runOnce: dry-run with no observations posts no jobs', async () => {
  const journalRoot = await setupJournal();
  const finbotRoot = await setupFinbotRoot();
  try {
    // patch internals to localOnly via the env-injection — use a fresh wrapper
    // We rely on commitAndPush detecting localOnly via opts; in loop.js
    // we don't pass localOnly to commitAndPush, so we need an alternate route.
    // The simplest is to make the loop bypass network: pretend journal repo
    // has no `origin`, which makes push fail and rebase fall through.
    // Since the runOnce loops 5 times on push failure (~3 seconds total),
    // we instead initialize a bare-remote pointing at a sibling dir.
    const bare = await mkdtemp(path.join(tmpdir(), 'finbot-loop-bare-'));
    await runGit(bare, ['init', '--bare', '--initial-branch=journal']);
    await runGit(journalRoot, ['remote', 'add', 'origin', bare]);
    await runGit(journalRoot, ['push', 'origin', 'HEAD:journal']);

    const r = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'dry-run',
      roleHost: 'test-host',
    });
    assert.equal(r.observations.count, 0);
    assert.equal(r.orientations.posted.length, 0);
    // Decide phase still posts a planner job even with zero orientations
    // (the v0 heuristic). Verify that.
    assert.equal(r.decisions.posted.length, 1);
    assert.equal(r.actions.posted.length, 1);
    const open = await listOpenJobs(journalRoot);
    assert.ok(open.length >= 2);
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
    await rm(finbotRoot, { recursive: true, force: true });
  }
});

test('runOnce: with new observations posts orient + decide + act', async () => {
  const journalRoot = await setupJournal();
  const finbotRoot = await setupFinbotRoot();
  try {
    const bare = await mkdtemp(path.join(tmpdir(), 'finbot-loop-bare-'));
    await runGit(bare, ['init', '--bare', '--initial-branch=journal']);
    await runGit(journalRoot, ['remote', 'add', 'origin', bare]);
    await runGit(journalRoot, ['push', 'origin', 'HEAD:journal']);

    // seed an inbox: drainInbox initializes HWM on first run, so we run the
    // loop once to set HWM, then post a message, then run again.
    await runOnce({ finbotRoot, journalRoot, safety: 'dry-run', roleHost: 'test-host' });

    await postToInbox(journalRoot, {
      to: 'oracle-watcher',
      from: 'driver',
      body: 'price deviation 100bps',
    });

    const r = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'dry-run',
      roleHost: 'test-host',
    });
    assert.ok(r.observations.count >= 1);
    assert.equal(r.orientations.posted.length, 2); // analyzer + forecaster
    assert.equal(r.decisions.posted.length, 1);
    assert.equal(r.actions.posted.length, 1); // auditor only (dry-run)
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
    await rm(finbotRoot, { recursive: true, force: true });
  }
});

test('runOnce: compute hook runs, receives a recorder, and is summarized', async () => {
  const journalRoot = await setupJournal();
  const finbotRoot = await setupFinbotRoot();
  try {
    const bare = await mkdtemp(path.join(tmpdir(), 'finbot-loop-bare-'));
    await runGit(bare, ['init', '--bare', '--initial-branch=journal']);
    await runGit(journalRoot, ['remote', 'add', 'origin', bare]);
    await runGit(journalRoot, ['push', 'origin', 'HEAD:journal']);

    let seenCtx = null;
    // A fake compute hook stands in for @finbot/pipeline's real one; the harness
    // must stay free of any pipeline/simulator dependency, so the test injects a
    // plain function and asserts the contract (recorder handed in, result echoed).
    const compute = async (ctx) => {
      seenCtx = ctx;
      await ctx.recorder.record({ kind: 'oracle-read', role: 'oracle-watcher', body: '# fake stage\n' });
      return { outcome: 'dry-run-complete', walletTouched: false };
    };

    const r = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'dry-run',
      roleHost: 'test-host',
      compute,
    });

    assert.equal(r.computation.ran, true);
    assert.equal(r.computation.result.outcome, 'dry-run-complete');
    assert.ok(seenCtx, 'compute hook was called with a context');
    assert.equal(typeof seenCtx.recorder.record, 'function');
    assert.equal(seenCtx.tickId, r.tickId);

    // the fake stage entry the hook recorded is on disk
    await runGit(journalRoot, ['fetch', 'origin', 'journal']);
    const logged = await runGit(journalRoot, ['log', '--oneline']);
    assert.match(logged.stdout, /oracle-watcher/);
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
    await rm(finbotRoot, { recursive: true, force: true });
  }
});

test('runOnce: jobBoard=false suppresses orient/decide/act posts', async () => {
  const journalRoot = await setupJournal();
  const finbotRoot = await setupFinbotRoot();
  try {
    const bare = await mkdtemp(path.join(tmpdir(), 'finbot-loop-bare-'));
    await runGit(bare, ['init', '--bare', '--initial-branch=journal']);
    await runGit(journalRoot, ['remote', 'add', 'origin', bare]);
    await runGit(journalRoot, ['push', 'origin', 'HEAD:journal']);

    let computed = false;
    const r = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'dry-run',
      roleHost: 'test-host',
      jobBoard: false,
      compute: async () => { computed = true; return { outcome: 'no-opportunity' }; },
    });

    assert.equal(r.orientations.posted.length, 0);
    assert.equal(r.decisions.posted.length, 0);
    assert.equal(r.actions.posted.length, 0);
    assert.equal(computed, true);
    const open = await listOpenJobs(journalRoot);
    assert.equal(open.length, 0, 'no jobs posted when jobBoard is false');
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
    await rm(finbotRoot, { recursive: true, force: true });
  }
});

test('runOnce: live mode posts executor in addition to auditor', async () => {
  const journalRoot = await setupJournal();
  const finbotRoot = await setupFinbotRoot();
  try {
    const bare = await mkdtemp(path.join(tmpdir(), 'finbot-loop-bare-'));
    await runGit(bare, ['init', '--bare', '--initial-branch=journal']);
    await runGit(journalRoot, ['remote', 'add', 'origin', bare]);
    await runGit(journalRoot, ['push', 'origin', 'HEAD:journal']);

    const r = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'live',
      roleHost: 'test-host',
    });
    assert.equal(r.actions.posted.length, 2); // auditor + executor
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
    await rm(finbotRoot, { recursive: true, force: true });
  }
});
