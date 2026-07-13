/**
 * The end-to-end OODA cycle, wired over the simulator in dry-run.
 *
 *   observe   oracle-watcher  -> opportunity-deviation events
 *   orient    analyzer        -> risk-adjusted scores + candidate target
 *             forecaster      -> Monte Carlo terminal-equity distribution
 *   decide    planner         -> bounded, hashed, cited rebalance proposal
 *   act       auditor         -> invariant verdict (gate)
 *             executor        -> DRY-RUN simulation of the approved steps
 *
 * Every stage's output is returned in a single structured result and,
 * optionally, recorded to the journal via an injected `recorder`. The cycle
 * is deterministic given its world + config (the only nondeterminism, the
 * journal entry filenames, lives in the recorder, not the decision path).
 *
 * The wallet capability is never constructed in this cycle; `walletTouched`
 * in the returned result is the executor's proof it never reached one.
 */

import { observeOpportunities, windowFromHistory } from './oracle-watcher.js';
import { analyze } from './analyzer.js';
import { project } from './forecaster.js';
import { plan } from './planner.js';
import { audit } from './auditor.js';
import { execute } from './executor.js';
import { navOf } from './rebalance.js';

/**
 * @typedef {object} OodaResult
 * @property {string} cycleId
 * @property {Array} opportunities
 * @property {object} analysis
 * @property {object|null} forecast
 * @property {object|null} proposal
 * @property {object|null} audit
 * @property {object|null} execution
 * @property {boolean} walletTouched
 * @property {string} outcome   'no-opportunity' | 'no-action' | 'rejected' | 'dry-run-complete'
 * @property {string} summary
 */

/**
 * Run one full dry-run OODA cycle.
 *
 * @param {object} input
 * @param {import('@finbot/simulator/world').World} input.world   already warmed up (history present on its sim, or pass `readings`)
 * @param {Array<{ t: number, prices: Record<string, number> }>} [input.readings]   oracle window; else derived from `input.history`
 * @param {Array<{ t: number, prices: Record<string, number> }>} [input.fitReadings]   longer rolling window for the vol-surface fit only; else derived from `input.history` via `config.fitWindowTicks`, else the oracle window
 * @param {Array<object>} [input.history]   simulator history to window from when `readings` absent
 * @param {object} [input.config]           per-stage config; `config.windowTicks` (oracle/realized-vol window, default 10) and `config.fitWindowTicks` (longer vol-fit window, default = windowTicks) among them
 * @param {object} [input.recorder]         optional { record(entry): Promise<string> }
 * @param {string} [input.cycleId]
 * @returns {Promise<OodaResult>}
 */
export async function runOodaCycle(input) {
  const world = input.world;
  const config = input.config || {};
  const cycleId = input.cycleId || 'cycle';
  const record = input.recorder ? (e) => input.recorder.record(e) : async () => null;

  const prices = world.priceFeed.current();
  const currentTick = world.priceFeed.t;
  const nav = navOf(world.portfolio.markToMarket(prices), prices);

  // The auditor enforces the same risk bounds the planner planned within
  // unless the caller overrides them on `config.auditor`. Inheriting the
  // bounds keeps the gate consistent with the plan by construction (a looser
  // planner than auditor would otherwise self-reject every cycle).
  const auditorConfig = { ...(config.bounds || {}), ...(config.auditor || {}) };

  const windowTicks = config.windowTicks || 10;
  const readings = input.readings
    || windowFromHistory(input.history || [], windowTicks);

  // Separable fit window: the oracle deviation and realized-vol reads want a
  // short, recent window (`readings`), but the GARCH vol-surface fit wants a
  // LONGER rolling history so the per-asset MLE (>=12 returns) can engage on a
  // live cycle. `config.fitWindowTicks` (default = windowTicks) draws that
  // longer window from the same history; it ends at the same current tick, so
  // the regime read still lands "where in the vol cycle we are now". Absent or
  // <= windowTicks → fitReadings === readings and the cycle is byte-identical.
  const fitWindowTicks = config.fitWindowTicks && config.fitWindowTicks > windowTicks
    ? config.fitWindowTicks
    : windowTicks;
  const fitReadings = input.fitReadings
    || (fitWindowTicks > windowTicks && !input.readings
      ? windowFromHistory(input.history || [], fitWindowTicks)
      : readings);

  // ----- OBSERVE: oracle-watcher -----
  const observed = observeOpportunities({ readings }, config.oracle || {});
  await record({
    kind: 'oracle-read', role: 'oracle-watcher', project: 'finbot',
    body: oracleBody(cycleId, observed),
  });

  if (observed.crossings.length === 0) {
    return finalize({ cycleId, opportunities: [], outcome: 'no-opportunity',
      summary: `oracle-watcher saw no deviation past threshold; NAV ${nav.toFixed(2)} held.` });
  }

  // ----- ORIENT (a): analyzer -----
  // The world's instrument registry (yield/APR descriptors) and the price
  // feed's correlation spec feed the analyzer's carry and correlation-cluster
  // scoring. Either may be absent (single risk asset, no correlation), in
  // which case those terms are zero.
  // Thread the regime read through: when the forecaster fits an adaptive vol
  // surface but the analyzer was given no explicit `regimeVol`, read the
  // CURRENT conditional-vol regime with the SAME descriptor, so the orient
  // stage scores under the very surface the ensemble will project under.
  const analyzerConfig = { ...(config.analyzer || {}) };
  if (analyzerConfig.regimeVol === undefined && config.forecaster && config.forecaster.adaptiveVol) {
    analyzerConfig.regimeVol = config.forecaster.adaptiveVol;
  }
  const analysis = analyze(
    {
      opportunities: observed.crossings,
      readings,
      fitReadings,
      portfolio: world.portfolio.markToMarket(prices),
      prices,
      instruments: world.instruments,
      correlations: config.correlations || (world.priceFeed && world.priceFeed.correlations) || undefined,
    },
    analyzerConfig,
  );
  const analysisId = await record({
    kind: 'analysis', role: 'analyzer', project: 'finbot',
    body: analysisBody(cycleId, analysis),
  });

  if (analysis.next_action === 'no-action') {
    return finalize({ cycleId, opportunities: observed.crossings, analysis, outcome: 'no-action',
      summary: `analyzer: no-action (top score below floor); NAV ${nav.toFixed(2)} held.` });
  }

  // ----- ORIENT (b): forecaster (Monte Carlo via simulator) -----
  const forecast = project(
    { world, targetWeights: analysis.targetWeights, bounds: config.bounds || {}, readings, fitReadings },
    config.forecaster || {},
  );
  const forecastId = await record({
    kind: 'forecast', role: 'forecaster', project: 'finbot',
    body: forecastBody(cycleId, forecast),
  });

  // ----- DECIDE: planner (ymax-shaped) -----
  const proposal = plan({
    portfolio: world.portfolio.markToMarket(prices),
    prices,
    targetWeights: analysis.targetWeights,
    bounds: config.bounds || {},
    cited_forecasts: [forecastId || `forecast:${cycleId}`],
    cited_analyses: [analysisId || `analysis:${cycleId}`],
  });
  await record({
    kind: 'proposal', role: 'planner', project: 'finbot',
    body: proposalBody(cycleId, proposal),
  });

  // ----- ACT (a): auditor (gate) -----
  const verdict = audit(
    {
      proposal, forecast,
      portfolio: world.portfolio.markToMarket(prices),
      prices, currentTick,
      oracleReadings: observed.crossings,
    },
    auditorConfig,
  );
  await record({
    kind: 'audit', role: 'auditor', project: 'finbot',
    body: auditBody(cycleId, verdict),
  });

  if (verdict.verdict !== 'approved') {
    return finalize({ cycleId, opportunities: observed.crossings, analysis, forecast, proposal, audit: verdict,
      outcome: 'rejected',
      summary: `auditor REJECTED (${verdict.failed_invariants.join(', ')}); no execution.` });
  }

  // ----- ACT (b): executor (DRY-RUN) -----
  const execution = await execute(
    {
      proposal, world, forecast,
      oracleReadings: observed.crossings,
      currentTick,
      parentCaps: {}, // no wallet vended; dry-run never receives one
    },
    { mode: 'dry-run', auditConfig: auditorConfig },
  );
  await record({
    kind: 'execution', role: 'executor', project: 'finbot',
    body: executionBody(cycleId, execution),
  });

  return finalize({
    cycleId, opportunities: observed.crossings, analysis, forecast, proposal, audit: verdict,
    execution, walletTouched: execution.walletTouched,
    outcome: 'dry-run-complete',
    summary: `dry-run executed ${execution.steps_completed.length} step(s); `
      + `post-equity ${execution.post_execution_balances.equity.toFixed(2)}; `
      + `wallet touched: ${execution.walletTouched}.`,
  });
}

function finalize(partial) {
  return {
    cycleId: partial.cycleId,
    opportunities: partial.opportunities || [],
    analysis: partial.analysis || null,
    forecast: partial.forecast || null,
    proposal: partial.proposal || null,
    audit: partial.audit || null,
    execution: partial.execution || null,
    walletTouched: partial.walletTouched === true,
    outcome: partial.outcome,
    summary: partial.summary,
  };
}

// ---- journal entry bodies (markdown) ----

function oracleBody(cycleId, observed) {
  const lines = [`# oracle-read (${cycleId})`, '', `crossings: ${observed.crossings.length}`, ''];
  for (const c of observed.crossings) {
    lines.push(`- ${c.asset}: ${c.referencePrice.toFixed(4)} -> ${c.currentPrice.toFixed(4)} `
      + `(${c.deviationBps >= 0 ? '+' : ''}${c.deviationBps.toFixed(0)}bps, ${c.direction})`);
  }
  return lines.join('\n') + '\n';
}

function analysisBody(cycleId, a) {
  const lines = [`# analysis (${cycleId})`, '', `next_action: ${a.next_action}`, ''];
  for (const s of a.recommendations) lines.push(`- ${s.rationale}`);
  if (a.targetWeights) lines.push('', `candidate targetWeights: ${JSON.stringify(a.targetWeights)}`);
  return lines.join('\n') + '\n';
}

function forecastBody(cycleId, f) {
  return [
    `# forecast (${cycleId})`, '',
    `ensemble_size: ${f.ensembleSize}`,
    `horizon: ${f.horizon}`,
    `currentNav: ${f.currentNav.toFixed(2)}`,
    `meanEquity: ${f.summary.meanEquity.toFixed(2)}`,
    `p05 / p50 / p95: ${f.summary.p05.toFixed(2)} / ${f.summary.p50.toFixed(2)} / ${f.summary.p95.toFixed(2)}`,
    `pProfit: ${(f.pProfit * 100).toFixed(1)}%`,
    '',
  ].join('\n');
}

function proposalBody(cycleId, p) {
  return [
    `# proposal (${cycleId})`, '',
    `proposal_hash: ${p.proposal_hash}`,
    `cited_forecasts: ${p.cited_forecasts.join(', ')}`,
    `cited_analyses: ${p.cited_analyses.join(', ')}`,
    `clamped: ${p.clamped}`,
    '',
    `dry_run_summary: ${p.dry_run_summary}`,
    '',
  ].join('\n');
}

function auditBody(cycleId, v) {
  const lines = [`# audit (${cycleId})`, '', `proposal_hash: ${v.proposal_hash}`, `verdict: ${v.verdict}`, ''];
  for (const r of v.invariant_results) lines.push(`- [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}: ${r.detail}`);
  return lines.join('\n') + '\n';
}

function executionBody(cycleId, e) {
  const lines = [
    `# execution (${cycleId})`, '',
    `mode: ${e.mode}`,
    `walletTouched: ${e.walletTouched}`,
    `steps_completed: ${e.steps_completed.length}`,
    `post_equity: ${e.post_execution_balances.equity.toFixed(2)}`,
    '',
  ];
  for (const s of e.steps_completed) lines.push(`- ${s.simulated_effect}`);
  return lines.join('\n') + '\n';
}
