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
import { project, projectionId } from './forecaster.js';
import { plan } from './planner.js';
import { audit, coverageGateArmed, sanitizeLabel } from './auditor.js';
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
 * @param {Array<{ t: number, prices: Record<string, number> }>} [input.fitReadings]   longer rolling window for the vol-surface fit and data-sufficiency coverage; else derived from `input.history` via `config.fitWindowTicks`, else the oracle window
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
  // When the forecaster fits an adaptive vol surface, its per-instrument GARCH
  // persistence lands in the forecast's volFit — so let the audit gate tighten
  // the tail floor on a persistent regime by default (the caller can still pin
  // or disable it with an explicit `config.auditor.regimeTailBump`). Mirrors the
  // regimeVol threading below: adaptive vol on → the regime informs the gate too.
  if (auditorConfig.regimeTailBump === undefined
      && config.forecaster && config.forecaster.adaptiveVol) {
    auditorConfig.regimeTailBump = 0.1;
  }

  // The observed-window semantics FORK on whether the coverage gate is armed,
  // because an explicit `0` means two different things in the two modes.
  //
  //   Gate OFF — reproduce the pre-feature `config.windowTicks || 10` coercion
  //   EXACTLY. Every falsy window (0, NaN, negative-zero, absent) → the default
  //   10; a truthy one → itself, byte-identical to `origin/main`. In particular
  //   `windowTicks: 0` off the gate is NOT an empty window — it is the default,
  //   the same as before this feature. An empty observed window is only
  //   meaningful under an armed gate (it is the state the data-sufficiency
  //   invariant measures), so `0` is honored as empty ONLY there.
  //
  //   Gate ARMED — an explicit `0` is a valid empty window, honored verbatim;
  //   only an omitted value takes the default 10. A MALFORMED explicit window
  //   (NaN, fractional, negative, unsafe integer) must never flow into
  //   `windowFromHistory`, whose `Math.max(0, length - NaN)` slice-start is
  //   `NaN` and selects the ENTIRE history; it collapses to an empty window,
  //   leaving the auditor no coverage evidence so the data-sufficiency invariant
  //   fails CLOSED. The `fitWindowTicksValid` guard bounds a truthy-but-invalid
  //   fit window (15.5, an unsafe integer) here too — a truthiness check alone
  //   would let those slice a fractional/whole-history vol-fit window.
  const coverageGateOn = coverageGateArmed(auditorConfig.dataSufficiencyMinCoverage);
  const validTickCount = (value) => Number.isSafeInteger(value) && value >= 0;
  let windowTicks;
  let fitWindowTicks;
  let readings;
  let fitReadings;
  if (!coverageGateOn) {
    // `|| 10` verbatim: 0/NaN/absent → 10, any truthy value → itself.
    windowTicks = config.windowTicks || 10;
    fitWindowTicks = config.fitWindowTicks && config.fitWindowTicks > windowTicks
      ? config.fitWindowTicks
      : windowTicks;
    readings = input.readings || windowFromHistory(input.history || [], windowTicks);
    fitReadings = input.fitReadings
      || (fitWindowTicks > windowTicks && !input.readings
        ? windowFromHistory(input.history || [], fitWindowTicks)
        : readings);
  } else {
    const requestedWindowTicks = config.windowTicks ?? 10;
    const requestedFitWindowTicks = config.fitWindowTicks;
    const windowTicksValid = validTickCount(requestedWindowTicks);
    const fitWindowTicksValid = requestedFitWindowTicks == null || validTickCount(requestedFitWindowTicks);
    const windowMalformed = !windowTicksValid || !fitWindowTicksValid;
    // A malformed window collapses to empty (fail-closed); an explicit valid 0 is
    // honored. `windowFromHistory(history, 0)` already returns `[]`, so a valid
    // zero window needs no special case beyond the malformed collapse.
    windowTicks = windowMalformed ? 0 : requestedWindowTicks;
    fitWindowTicks = !windowMalformed
      && requestedFitWindowTicks && requestedFitWindowTicks > windowTicks
      ? requestedFitWindowTicks
      : windowTicks;
    readings = windowMalformed
      ? []
      : input.readings || windowFromHistory(input.history || [], windowTicks);
    fitReadings = windowMalformed
      ? []
      : input.fitReadings
      || (fitWindowTicks > windowTicks && !input.readings
        ? windowFromHistory(input.history || [], fitWindowTicks)
        : readings);
  }

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
  // The analyzer's direct regime-position-sizing lever is opt-in at its own
  // API boundary, but an adaptive OODA cycle has explicitly elected to fit a
  // live volatility regime. In that mode default to cutting a fully persistent
  // asset's target by half. Callers can pin 0 to retain score-only behavior.
  if (analyzerConfig.regimePositionShrink === undefined && config.forecaster && config.forecaster.adaptiveVol) {
    analyzerConfig.regimePositionShrink = 0.5;
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
  // When the forecaster fits an adaptive vol surface, its worst-asset GARCH
  // persistence can also stretch the projection horizon so a persistent regime's
  // shock is projected long enough to resolve rather than truncate. Default it on
  // (the caller can pin or disable it with `config.forecaster.regimeHorizonStretch`),
  // mirroring how the audit gate defaults `regimeTailBump` above: adaptive vol on →
  // the regime informs BOTH the horizon and the gate.
  const forecasterConfig = { ...(config.forecaster || {}) };
  if (forecasterConfig.regimeHorizonStretch === undefined && forecasterConfig.adaptiveVol) {
    forecasterConfig.regimeHorizonStretch = 0.5;
  }
  // Data-sufficiency gate: the auditor's `dataSufficiencyMinCoverage` can only
  // bite on evidence the forecaster actually emits — auto-enable the report when
  // the operator set only the auditor threshold, so a lone gate knob yields a
  // live gate. An explicit `forecaster.reportDataSufficiency` still wins, but it
  // can no longer disarm the gate: an explicit `false` under an armed threshold
  // leaves the auditor with no evidence, which now FAILS the invariant closed
  // rather than passing it vacuously. Both off -> unchanged.
  // The arming test is the auditor's own exported predicate, not a copy of it: a
  // mirror that drifted would either withhold evidence from an armed gate or
  // arm the forecaster's measurement for a gate that is off.
  if (forecasterConfig.reportDataSufficiency === undefined
      && coverageGateArmed(auditorConfig.dataSufficiencyMinCoverage)) {
    forecasterConfig.reportDataSufficiency = true;
  }
  const forecast = project(
    { world, targetWeights: analysis.targetWeights, bounds: config.bounds || {}, readings, fitReadings },
    forecasterConfig,
  );
  const forecastId = await record({
    kind: 'forecast', role: 'forecaster', project: 'finbot',
    body: forecastBody(cycleId, forecast),
  });

  // ----- DECIDE: planner (ymax-shaped) -----
  // When the forecaster attached a data-sufficiency descriptor, cite the forecast
  // by its canonical projectionId too, so the auditor's data-sufficiency gate can
  // BIND that descriptor to the artifact this proposal commits to (a descriptor
  // swapped before the audit changes the id and fails the gate closed). Off ->
  // no descriptor -> no extra citation, so the proposal and its journal entry
  // stay byte-identical to before.
  const forecastProvenanceId = forecast.dataSufficiency ? projectionId(forecast) : null;
  const proposal = plan({
    portfolio: world.portfolio.markToMarket(prices),
    prices,
    targetWeights: analysis.targetWeights,
    bounds: config.bounds || {},
    cited_forecasts: [
      forecastId || `forecast:${cycleId}`,
      ...(forecastProvenanceId ? [forecastProvenanceId] : []),
    ],
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
  const lines = [
    `# forecast (${cycleId})`, '',
    `ensemble_size: ${f.ensembleSize}`,
    `horizon: ${f.horizon}`,
    `currentNav: ${f.currentNav.toFixed(2)}`,
    `meanEquity: ${f.summary.meanEquity.toFixed(2)}`,
    `p05 / p50 / p95: ${f.summary.p05.toFixed(2)} / ${f.summary.p50.toFixed(2)} / ${f.summary.p95.toFixed(2)}`,
    `pProfit: ${(f.pProfit * 100).toFixed(1)}%`,
  ];
  if (f.dataSufficiency) {
    // This line enters the journal as Markdown. JSON escapes C0 controls but
    // leaves Unicode line separators and bidi controls intact, so preserve the
    // descriptor while applying the same recorder-safe label discipline the
    // auditor uses for its verdict detail.
    const worstAsset = f.dataSufficiency.worstAsset;
    const recorded = {
      ...f.dataSufficiency,
      worstAsset: typeof worstAsset === 'string' ? sanitizeLabel(worstAsset) : worstAsset,
    };
    lines.push(`data_sufficiency: ${JSON.stringify(recorded)}`);
  }
  lines.push('');
  return lines.join('\n');
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
