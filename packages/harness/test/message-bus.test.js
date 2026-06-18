/**
 * Message bus tests.
 *
 * Sets up a real git repo locally (the orphan-journal shape) and
 * exercises `recordEntry`, `postToInbox`, `drainInbox`, `postJob`,
 * `claimJob`, `completeJob`, `listOpenJobs`. The journal-sync push is
 * neutralized by `localOnly: true`; we exercise the commit shape but
 * not the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { recordEntry } from '../observation/record.js';
import { postToInbox, drainInbox } from '../message-bus/inbox.js';
import { postJob, claimJob, completeJob, listOpenJobs } from '../message-bus/job-board.js';
import { runGit } from '../message-bus/journal-sync.js';

async function setupJournal() {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-journal-'));
  await runGit(root, ['init', '--initial-branch=journal']);
  await runGit(root, ['config', 'user.name', 'finbot-test']);
  await runGit(root, ['config', 'user.email', 'finbot-test@example.com']);
  await runGit(root, ['commit', '--allow-empty', '-m', 'journal: initial']);
  return root;
}

test('recordEntry: writes a journal entry and commits', async () => {
  const root = await setupJournal();
  try {
    const rel = await recordEntry(root, {
      kind: 'tick',
      role: 'driver',
      body: 'hello',
    }, { localOnly: true });
    assert.match(rel, /^entries\/\d{4}\/\d{2}\/\d{2}\/\d{6}Z-tick-driver-[0-9a-f]{6}\.md$/);
    const { stdout } = await runGit(root, ['log', '--oneline']);
    assert.match(stdout, /entry: tick driver/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('postToInbox + drainInbox: round-trip', async () => {
  const root = await setupJournal();
  try {
    // drain once to initialize state (returns empty on first run)
    const initial = await drainInbox(root, 'planner', { hostKey: 'test-host', localOnly: true });
    assert.deepEqual(initial, []);

    // post a message addressed to planner
    await postToInbox(root, {
      to: 'planner',
      from: 'driver',
      body: 'please plan',
    }, { localOnly: true });
    // ensure the commit reaches HEAD (gives drainInbox an entry to find)

    // drain should now find it
    const second = await drainInbox(root, 'planner', { hostKey: 'test-host', localOnly: true });
    assert.equal(second.length, 1);
    assert.equal(second[0].to, 'planner');

    // a second drain immediately after should be empty (HWM advanced)
    const third = await drainInbox(root, 'planner', { hostKey: 'test-host', localOnly: true });
    assert.deepEqual(third, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('drainInbox: filters by recipient', async () => {
  const root = await setupJournal();
  try {
    await drainInbox(root, 'planner', { hostKey: 'h', localOnly: true });
    await postToInbox(root, { to: 'auditor', from: 'driver', body: 'audit' }, { localOnly: true });
    await postToInbox(root, { to: 'planner', from: 'driver', body: 'plan' }, { localOnly: true });
    const drained = await drainInbox(root, 'planner', { hostKey: 'h', localOnly: true });
    assert.equal(drained.length, 1);
    assert.equal(drained[0].to, 'planner');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('drainInbox: broadcasts ("*") are surfaced to all roles', async () => {
  const root = await setupJournal();
  try {
    await drainInbox(root, 'planner', { hostKey: 'h', localOnly: true });
    await drainInbox(root, 'auditor', { hostKey: 'h', localOnly: true });
    await postToInbox(root, { to: '*', from: 'driver', body: 'all hands' }, { localOnly: true });
    const plannerDrain = await drainInbox(root, 'planner', { hostKey: 'h', localOnly: true });
    const auditorDrain = await drainInbox(root, 'auditor', { hostKey: 'h', localOnly: true });
    assert.equal(plannerDrain.length, 1);
    assert.equal(auditorDrain.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('postJob + listOpenJobs: round-trip', async () => {
  const root = await setupJournal();
  try {
    const before = await listOpenJobs(root);
    assert.deepEqual(before, []);
    const rel = await postJob(root, {
      verb: 'orient-analyzer',
      slug: 'tick-abc',
      eligible: ['analyzer'],
      body: '# Orient: analyzer',
    }, { localOnly: true });
    assert.match(rel, /^jobs\/open\/\d{8}T\d{6}Z--[0-9a-f]+--tick-abc\.md$/);
    const after = await listOpenJobs(root);
    assert.equal(after.length, 1);
    assert.equal(after[0], rel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('claimJob: moves open -> claimed and stamps frontmatter', async () => {
  const root = await setupJournal();
  try {
    const openRel = await postJob(root, {
      verb: 'orient-planner',
      slug: 'tick-claim',
      eligible: ['planner'],
      body: 'plan it',
    }, { localOnly: true });
    const claimedRel = await claimJob(root, openRel, { role: 'planner', host: 'h', sessionId: 'sid' }, { localOnly: true });
    assert.match(claimedRel, /^jobs\/claimed\/\d{8}T\d{6}Z--h--planner--sid--/);
    const open = await listOpenJobs(root);
    assert.equal(open.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('claimJob: lost-race when source file no longer present', async () => {
  const root = await setupJournal();
  try {
    await assert.rejects(
      claimJob(root, 'jobs/open/00000000T000000Z--ffffff--gone.md', { role: 'planner' }, { localOnly: true }),
      (err) => err.code === 'LOST_RACE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completeJob: moves claimed -> done with completion stamp', async () => {
  const root = await setupJournal();
  try {
    const openRel = await postJob(root, {
      verb: 'orient-planner',
      slug: 'tick-complete',
      eligible: ['planner'],
      body: 'plan it',
    }, { localOnly: true });
    const claimedRel = await claimJob(root, openRel, { role: 'planner', host: 'h', sessionId: 'sid' }, { localOnly: true });
    const doneRel = await completeJob(root, claimedRel, 'done', { resultEntry: 'entries/2026/06/18/result.md' }, { localOnly: true });
    assert.match(doneRel, /^jobs\/done\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
