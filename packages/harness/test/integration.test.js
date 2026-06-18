/**
 * Integration test: drive one OODA tick end-to-end.
 *
 * Setup:
 *   - A synthetic finbot root with skills/oracle-poll, skills/analyzer,
 *     skills/forecaster, skills/portfolio-rebalance, skills/pre-execution-audit
 *   - A synthetic journal root with an init commit
 *   - A bare repo standing in for origin/journal
 *
 * Tick exercise:
 *   1. Seed an oracle-watcher inbox message (a fake price deviation).
 *   2. Run runOnce({safety: 'dry-run'}).
 *   3. Verify orient + decide + act jobs were posted to jobs/open/.
 *   4. Verify the tick start and tick complete entries land in entries/.
 *   5. Verify the auditor was posted but no executor (dry-run).
 *   6. Run a second tick to verify HWM advances (no double-fire).
 *
 * Subagent exercise:
 *   7. Spawn a fake "analyzer" subagent using the harness's spawn().
 *   8. Drive its event stream through monitorSubagent into a journal
 *      entry via recordSubagentTrace.
 *   9. Verify the spawn completed, the trace entry exists, and the
 *      tool was invoked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { runOnce } from '../loop.js';
import { runGit } from '../message-bus/journal-sync.js';
import { postToInbox } from '../message-bus/inbox.js';
import { listOpenJobs } from '../message-bus/job-board.js';
import { spawn } from '../spawn.js';
import { recordSubagentTrace } from '../observation/monitor.js';
import { loadTools } from '../tools.js';
import { toolResult } from '../schemas/tool.js';

async function setupJournal() {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-integ-journal-'));
  await runGit(root, ['init', '--initial-branch=journal']);
  await runGit(root, ['config', 'user.name', 'finbot-test']);
  await runGit(root, ['config', 'user.email', 'finbot-test@example.com']);
  await runGit(root, ['commit', '--allow-empty', '-m', 'journal: initial']);
  const bare = await mkdtemp(path.join(tmpdir(), 'finbot-integ-bare-'));
  await runGit(bare, ['init', '--bare', '--initial-branch=journal']);
  await runGit(root, ['remote', 'add', 'origin', bare]);
  await runGit(root, ['push', 'origin', 'HEAD:journal']);
  return { root, bare };
}

async function setupFinbotRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'finbot-integ-root-'));
  for (const skill of ['oracle-poll', 'analyzer', 'forecaster', 'portfolio-rebalance', 'pre-execution-audit']) {
    await mkdir(path.join(root, 'skills', skill), { recursive: true });
    await writeFile(
      path.join(root, 'skills', skill, 'SKILL.md'),
      `---\ncreated: 2026-06-18\n---\n# Skill: ${skill}\n\nSynthetic ${skill} for the integration test.\n`,
    );
  }
  for (const role of ['oracle-watcher', 'analyzer', 'forecaster', 'planner', 'auditor', 'executor']) {
    await mkdir(path.join(root, 'roles', role), { recursive: true });
    await writeFile(
      path.join(root, 'roles', role, 'AGENT.md'),
      `---\ncreated: 2026-06-18\n---\n# Role: ${role}\n\nSynthetic role brief.\n`,
    );
  }
  return root;
}

test('integration: one OODA tick end-to-end (dry-run)', async () => {
  const { root: journalRoot, bare } = await setupJournal();
  const finbotRoot = await setupFinbotRoot();
  try {
    // tick 1: initializes inbox HWMs, no observations yet
    const tick1 = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'dry-run',
      roleHost: 'integ-host',
    });
    assert.equal(tick1.observations.count, 0);

    // seed an oracle-watcher inbox message
    await postToInbox(journalRoot, {
      to: 'oracle-watcher',
      from: 'oracle-watcher-daemon',
      body: '# Price deviation\n\nusdc_pyth: 1.0000 -> 1.0010 (+10bps)\n',
      project: 'finbot',
    });

    // tick 2: observations -> orient -> decide -> act
    const tick2 = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'dry-run',
      roleHost: 'integ-host',
    });
    assert.ok(tick2.observations.count >= 1, 'observe should drain at least one message');
    assert.equal(tick2.orientations.posted.length, 2, 'orient should post analyzer + forecaster');
    assert.equal(tick2.decisions.posted.length, 1, 'decide should post planner');
    assert.equal(tick2.actions.posted.length, 1, 'dry-run act should post auditor only');

    // verify the job-board has the posted jobs (the verb lives in the
    // frontmatter, not in the filename slug, so we read each file)
    const open = await listOpenJobs(journalRoot);
    assert.ok(open.length >= 4, `expected >=4 open jobs, got ${open.length}: ${open.join(', ')}`);
    const verbs = [];
    for (const p of open) {
      const raw = await fs.readFile(path.join(journalRoot, p), 'utf8');
      const m = raw.match(/^verb:\s*(\S+)/m);
      if (m) verbs.push(m[1]);
    }
    verbs.sort();
    assert.ok(verbs.includes('orient-analyzer'), `verbs: ${verbs.join(', ')}`);
    assert.ok(verbs.includes('orient-forecaster'));
    assert.ok(verbs.includes('decide-planner'));
    assert.ok(verbs.includes('act-audit'));
    assert.ok(!verbs.includes('act-execute'), 'dry-run must not post executor');

    // verify a few journal entries landed in entries/
    const entriesDir = path.join(journalRoot, 'entries');
    const yearDirs = await fs.readdir(entriesDir);
    assert.ok(yearDirs.length > 0);

    // tick 3: HWM should have advanced; no new observations
    const tick3 = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'dry-run',
      roleHost: 'integ-host',
    });
    assert.equal(tick3.observations.count, 0, 'HWM should have advanced; tick 3 sees no new messages');
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
    await rm(finbotRoot, { recursive: true, force: true });
  }
});

test('integration: live mode posts executor alongside auditor', async () => {
  const { root: journalRoot, bare } = await setupJournal();
  const finbotRoot = await setupFinbotRoot();
  try {
    const tick = await runOnce({
      finbotRoot,
      journalRoot,
      safety: 'live',
      roleHost: 'integ-host',
    });
    assert.equal(tick.actions.posted.length, 2);
    const roles = tick.actions.posted.map((a) => a.role).sort();
    assert.deepEqual(roles, ['auditor', 'executor']);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
    await rm(finbotRoot, { recursive: true, force: true });
  }
});

test('integration: spawn + monitor + journal trace for a subagent', async () => {
  const { root: journalRoot, bare } = await setupJournal();
  const finbotRoot = await setupFinbotRoot();
  try {
    const tools = await loadTools(path.join(finbotRoot, 'skills'));
    assert.ok(tools['analyzer'] || tools.analyzer);
    // wrap the analyzer tool's run so the test observes it
    let invoked = false;
    const wrapped = {
      ...tools,
      analyzer: {
        ...tools.analyzer,
        run: async (args) => {
          invoked = true;
          return toolResult(true, [{ type: 'text', text: 'analyzer result' }], { args });
        },
      },
    };
    const handle = await spawn(
      { role: 'analyzer', brief: 'analyze the seeded price deviation' },
      { finbotRoot, tools: wrapped },
    );
    await handle.done;
    assert.equal(handle.status, 'completed');
    assert.equal(invoked, true, 'analyzer tool should have been invoked');

    const traceRel = await recordSubagentTrace(journalRoot, handle);
    assert.match(traceRel, /^entries\/\d{4}\/\d{2}\/\d{2}\/\d{6}Z-tick-analyzer-/);
    const traceAbs = path.join(journalRoot, traceRel);
    const traceBody = await fs.readFile(traceAbs, 'utf8');
    assert.match(traceBody, /Subagent trace/);
    assert.match(traceBody, /status: completed/);
    assert.match(traceBody, /tool_execution_start/);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
    await rm(finbotRoot, { recursive: true, force: true });
  }
});
