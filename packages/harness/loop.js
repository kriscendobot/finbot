/**
 * OODA driving loop.
 *
 * One tick is one pass through observe / orient / decide / act. Per-tick
 * state lives in the journal (`journal/inboxes/`, `journal/jobs/`,
 * `journal/entries/`). The loop is stateless across ticks; killing the
 * loop and re-running it picks up where the previous tick left off.
 *
 * The loop is intentionally deterministic given its journal inputs. Two
 * concurrent ticks on the same journal converge because:
 *
 *   - inbox-drain is idempotent (the state file pins a HWM)
 *   - job-board claims race through git push (the loser falls back)
 *   - entry writes carry a fresh short-id (no collision)
 *
 * Inspired by Pi's `agentLoop` shape (`@earendil-works/pi-agent`'s outer
 * loop + steering-message injection), refracted through the garden's
 * per-tick worktree model: every tick is one orchestrator pass, not a
 * long-running stateful coroutine.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { loadTools } from './tools.js';
import { spawn } from './spawn.js';
import { recordEntry } from './observation/record.js';
import { drainInbox } from './message-bus/inbox.js';
import { postJob, listOpenJobs } from './message-bus/job-board.js';

/**
 * Run a single OODA tick.
 *
 * Phases:
 *
 *   1. observe — drain oracle-watcher + monitor inboxes for the tick role
 *   2. orient — if new observations, post analyzer + forecaster jobs
 *   3. decide — if recent analysis + forecast entries, post planner job
 *   4. act — if planner proposal exists, post auditor; on signoff,
 *      executor (gated by safety mode)
 *
 * @param {object} config
 * @param {string} config.finbotRoot
 * @param {string} config.journalRoot
 * @param {'dry-run' | 'live'} config.safety
 * @param {string} [config.roleHost] — host name for inbox addressing; defaults to `os.hostname()`
 * @param {object} [config.spies] — optional test hooks to capture per-phase calls
 * @param {boolean} [config.jobBoard=true] — when false, the orient/decide/act phases
 *   drain inboxes but post no jobs. Lets a compute-only driver run the in-process
 *   cycle without flooding the board with jobs no consumer will claim.
 * @param {function} [config.compute] — optional in-process compute hook. When set, a
 *   fifth `compute` phase runs it with a journal-bound recorder and the tick context,
 *   then journals a `tick` summary. This is the dry-run path that runs `runOodaCycle`
 *   in-process and records real per-stage entries. The hook lives in `@finbot/pipeline`
 *   or a bin, never here, so `@finbot/harness` keeps its no-dependency stance (the
 *   wiring that needs both the simulator and the pipeline cannot live in the harness).
 * @param {boolean} [config.localOnly=false] — when true, the compute recorder and the
 *   tick summary commit locally without pushing (a local journal worktree).
 */
export async function runOnce(config) {
  const finbotRoot = path.resolve(config.finbotRoot);
  const journalRoot = path.resolve(config.journalRoot);
  const safety = config.safety || 'dry-run';
  const spies = config.spies || {};
  const jobBoard = config.jobBoard !== false;

  const tickId = randomShortId();
  const startedAt = new Date().toISOString();
  const localOnly = config.localOnly === true;

  // Tools available to subagents this tick. Loaded once per tick so a
  // mid-tick SKILL.md edit cannot perturb in-flight subagent behavior.
  const tools = await loadTools(path.join(finbotRoot, 'skills'));

  await recordEntry(journalRoot, {
    kind: 'tick',
    role: 'driver',
    body: `# OODA tick ${tickId}\n\nphase: starting\nsafety: ${safety}\nstarted_at: ${startedAt}\ntools: ${Object.keys(tools).length}\n`,
  }, { localOnly });

  const tickContext = {
    tickId,
    startedAt,
    safety,
    finbotRoot,
    journalRoot,
    jobBoard,
    localOnly,
    tools,
    spies,
  };

  const observations = await observe(tickContext);
  spies.afterObserve?.(observations);

  const orientations = jobBoard ? await orient(tickContext, observations) : { posted: [] };
  spies.afterOrient?.(orientations);

  const decisions = jobBoard ? await decide(tickContext, orientations) : { posted: [] };
  spies.afterDecide?.(decisions);

  const actions = jobBoard ? await act(tickContext, decisions) : { posted: [] };
  spies.afterAct?.(actions);

  const computation = await compute(tickContext, config);
  spies.afterCompute?.(computation);

  await recordEntry(journalRoot, {
    kind: 'tick',
    role: 'driver',
    body: [
      `# OODA tick ${tickId} complete`,
      ``,
      `safety: ${safety}`,
      `job_board: ${jobBoard}`,
      `observations: ${observations.count}`,
      `orientations_posted: ${orientations.posted.length}`,
      `decisions_posted: ${decisions.posted.length}`,
      `actions_posted: ${actions.posted.length}`,
      `computed: ${computation.ran ? computation.result?.outcome ?? 'ran' : 'no'}`,
      `finished_at: ${new Date().toISOString()}`,
    ].join('\n'),
  }, { localOnly: tickContext.localOnly });

  return { tickId, observations, orientations, decisions, actions, computation };
}

/**
 * Persistent driver: keep ticking on cadence until SIGINT.
 *
 * @param {object} config
 */
export async function runPersistent(config) {
  const cadenceMs = config.cadenceMs || 60_000;
  // eslint-disable-next-line no-console
  console.log(`finbot: persistent mode, cadence=${cadenceMs}ms, safety=${config.safety}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await runOnce(config);
      // eslint-disable-next-line no-console
      console.log(`finbot: tick ${r.tickId} done`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('finbot: tick error', err);
    }
    await sleep(cadenceMs);
  }
}

/**
 * Phase 1: observe.
 *
 * Drain the per-host inboxes for oracle-watcher and monitor; collect any
 * new entries addressed to them. (The actual watchers are jobs that
 * the driver posts; their results return as inbox messages addressed to
 * the role.)
 *
 * @param {object} ctx
 */
export async function observe(ctx) {
  const inboxes = {};
  for (const role of ['oracle-watcher', 'monitor']) {
    inboxes[role] = await drainInbox(ctx.journalRoot, role, {
      hostKey: ctx.roleHost,
      localOnly: ctx.localOnly,
    });
  }
  const count = Object.values(inboxes).reduce((a, b) => a + b.length, 0);
  if (count > 0) {
    await recordEntry(ctx.journalRoot, {
      kind: 'tick',
      role: 'driver',
      body: `# observe (${ctx.tickId})\n\nnew_messages: ${count}\n`,
      refs: Object.values(inboxes).flat().map((e) => e.path),
    }, { localOnly: ctx.localOnly });
  }
  return { count, inboxes };
}

/**
 * Phase 2: orient.
 *
 * If new observations exist, post analyzer + forecaster jobs to the
 * board. Otherwise no-op.
 *
 * @param {object} ctx
 * @param {object} observations
 */
export async function orient(ctx, observations) {
  if (observations.count === 0) return { posted: [] };
  const posted = [];
  for (const role of ['analyzer', 'forecaster']) {
    const jobPath = await postJob(ctx.journalRoot, {
      verb: `orient-${role}`,
      slug: `tick-${ctx.tickId}`,
      eligible: [role],
      body: `# Orient: ${role}\n\nTick ${ctx.tickId} surfaced ${observations.count} new observations. Read inbox entries cited above and produce a result.\n`,
      project: 'finbot',
    }, { localOnly: ctx.localOnly });
    posted.push({ role, jobPath });
  }
  return { posted };
}

/**
 * Phase 3: decide.
 *
 * If the board has recent analyzer + forecaster results (visible via
 * `done/` paths newer than the prior tick), post a planner job. v0 is
 * permissive: any non-empty `done/` triggers a planner post.
 *
 * @param {object} ctx
 * @param {object} orientations
 */
export async function decide(ctx, orientations) {
  // v0 heuristic: if we just posted orientation jobs, we presume the planner
  // wants to wake on their completion. Real implementation watches the
  // jobs/done/ stream and only posts planner when the orient board is
  // drained.
  if (orientations.posted.length === 0) {
    // still check whether prior orientation results sit pending
    const open = await listOpenJobs(ctx.journalRoot);
    const orientStillOpen = open.some((p) => p.includes('orient-analyzer') || p.includes('orient-forecaster'));
    if (orientStillOpen) return { posted: [] };
  }
  const jobPath = await postJob(ctx.journalRoot, {
    verb: 'decide-planner',
    slug: `tick-${ctx.tickId}`,
    eligible: ['planner'],
    body: `# Decide: planner\n\nTick ${ctx.tickId} produced orientation results. Emit a rebalance proposal.\n`,
    project: 'finbot',
  }, { localOnly: ctx.localOnly });
  return { posted: [{ role: 'planner', jobPath }] };
}

/**
 * Phase 4: act.
 *
 * Post an auditor job; on signoff (out-of-band, in a future tick), post
 * an executor job with the run's safety mode. v0 posts the auditor; the
 * executor authorization is gated by `safety === 'live'` and a
 * subsequent tick reading the auditor's `done/` result.
 *
 * @param {object} ctx
 * @param {object} decisions
 */
export async function act(ctx, decisions) {
  const posted = [];
  for (const proposal of decisions.posted) {
    const auditorJobPath = await postJob(ctx.journalRoot, {
      verb: 'act-audit',
      slug: `tick-${ctx.tickId}`,
      eligible: ['auditor'],
      body: `# Act: audit\n\nReview the planner proposal posted at ${proposal.jobPath}. Reject any uncited steps. Decide signoff.\n`,
      project: 'finbot',
    }, { localOnly: ctx.localOnly });
    posted.push({ role: 'auditor', jobPath: auditorJobPath });
    if (ctx.safety === 'live') {
      // post the executor job conditioned on auditor signoff; the executor
      // refuses to fire without an auditor `done` entry citing the same
      // proposal_hash, so this post is safe even if the auditor rejects.
      const execJobPath = await postJob(ctx.journalRoot, {
        verb: 'act-execute',
        slug: `tick-${ctx.tickId}`,
        eligible: ['executor'],
        body: `# Act: execute\n\nLIVE mode. Only fire if the auditor's signoff entry cites this proposal's hash.\n`,
        project: 'finbot',
        authorizations: { live: true },
      }, { localOnly: ctx.localOnly });
      posted.push({ role: 'executor', jobPath: execJobPath });
    }
  }
  return { posted };
}

/**
 * Phase 5: compute (optional).
 *
 * The in-process dry-run path. When `config.compute` is supplied, run it with a
 * journal-bound recorder and the tick context. The hook is expected to drive an
 * end-to-end dry-run OODA cycle (the form `@finbot/pipeline`'s `runOodaCycle`
 * computes) and return its structured result; the per-stage entries are written
 * by the hook through the recorder we hand it. We then journal a single `compute`
 * tick summarizing the outcome.
 *
 * The hook lives outside the harness on purpose: the cycle needs both
 * `@finbot/simulator` and `@finbot/pipeline`, and the harness depends on neither.
 * Injecting the hook keeps the dependency arrow pointing the right way.
 *
 * @param {object} ctx
 * @param {object} config
 * @returns {Promise<{ ran: boolean, result: object|null }>}
 */
export async function compute(ctx, config) {
  if (typeof config.compute !== 'function') return { ran: false, result: null };
  const recorder = {
    record: (entry) => recordEntry(ctx.journalRoot, entry, { localOnly: ctx.localOnly }),
  };
  const result = await config.compute({
    tickId: ctx.tickId,
    safety: ctx.safety,
    finbotRoot: ctx.finbotRoot,
    journalRoot: ctx.journalRoot,
    recorder,
  });
  return { ran: true, result: result || null };
}

/**
 * @returns {string}
 */
export function randomShortId() {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-exported for tests that want to ensure the journal layout exists. */
export async function ensureJournalLayout(journalRoot) {
  for (const dir of [
    'entries',
    'inboxes',
    'jobs/open',
    'jobs/claimed',
    'jobs/done',
    'jobs/abandoned',
  ]) {
    await fs.mkdir(path.join(journalRoot, dir), { recursive: true });
  }
}
