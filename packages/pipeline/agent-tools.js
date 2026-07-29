/**
 * Pipeline functions, exposed as harness tools.
 *
 * The OODA roles are deterministic functions over the simulator world (see
 * this package's `index.js`). This module wraps the OBSERVE, ORIENT, DECIDE,
 * AUDIT, and dry-run ACT functions as `@finbot/harness` Tool definitions so an
 * inference-driven subagent can CALL them as tools — the "automatic inference,
 * automation born from inference" blend the design describes. Each stage
 * reasons in natural language but delegates deterministic computation to its
 * corresponding pipeline function rather than doing it by hand.
 *
 * Each tool's `run` calls the pure function and returns a `toolResult` whose
 * JSON block is the function's structured output (so the harness loop feeds it
 * straight back into the model) plus a one-line text summary. The functions
 * stay the single source of truth: the same `analyze` the headless dry-run
 * cycle (`runOodaCycle`) calls is the one the subagent calls.
 *
 * This adapter lives in `@finbot/pipeline`, not `@finbot/harness`, for the same
 * reason `driver-compute.js` does: the harness depends on neither the simulator
 * nor the pipeline, so the wiring that needs the pipeline's functions belongs
 * here, where that dependency is already paid.
 */

// `harden` is used to snapshot dispatch-bound inputs. Import SES here rather
// than relying on a caller having happened to import cap-attenuation first.
import 'ses';

import { toolResult } from '@finbot/harness/schemas';
import { Portfolio } from '@finbot/simulator/portfolio';

import { observeOpportunities } from './oracle-watcher.js';
import { analyze, realizedVolatility } from './analyzer.js';
import { plan } from './planner.js';
import { audit } from './auditor.js';
import { execute } from './executor.js';

/**
 * Build the orient-phase pipeline tool registry (keyed by tool name), suitable
 * for passing as `ctx.tools` to `spawn` (or merging into a larger registry).
 *
 * @returns {Record<string, object>} a registry of `assertToolDef`-shaped tools
 */
export function pipelineToolRegistry() {
  const tools = [scoreOpportunitiesTool(), realizedVolatilityTool()];
  const registry = {};
  for (const t of tools) registry[t.name] = t;
  return registry;
}

/** Names of the tools in {@link pipelineToolRegistry}, for capability subsets. */
export const PIPELINE_TOOL_NAMES = ['score_opportunities', 'realized_volatility'];

/**
 * Build the observe-phase (oracle-watcher) tool registry: the deterministic
 * deviation detector exposed as `observe_opportunities`, so an inference-driven
 * observer subagent can reason over a price-reading window and delegate the
 * actual threshold-crossing detection to the deterministic `observeOpportunities`
 * function rather than eyeballing the price moves by hand. Strictly read-only —
 * the observer consumes a price history and produces opportunity-deviation
 * events; it never trades and no wallet capability is reachable from the
 * observe-phase tool subset. This is the OBSERVE-stage counterpart to the
 * orient/decide/act registries: it exposes ONLY the detector, keeping the
 * stage's authority to the least it needs (the risk-denominator
 * `realized_volatility` is an orient-phase concern, not an observe one).
 *
 * @param {object} trustedInput oracle window, threshold, and asset allowlist
 *   captured at dispatch creation; it is cloned and hardened before vending.
 * @returns {Record<string, object>} a registry of `assertToolDef`-shaped tools
 */
export function observerToolRegistry(trustedInput) {
  const tools = [observeOpportunitiesTool(boundObservationWindow(trustedInput))];
  const registry = {};
  for (const t of tools) registry[t.name] = t;
  return registry;
}

/** Names of the tools in {@link observerToolRegistry}, for capability subsets. */
export const OBSERVER_TOOL_NAMES = ['observe_opportunities'];

/**
 * Create the frozen, defensive snapshot used by an OBSERVE dispatch. Both the
 * tool closure and the canonical recompute receive this exact object so model
 * arguments and later caller mutation cannot alter the input set.
 *
 * @param {object} input trusted observer input
 * @returns {object} a hardened deep clone
 */
export function boundObservationWindow(input) {
  if (input == null || typeof input !== 'object') {
    throw new TypeError('observerToolRegistry requires dispatch-bound trusted input');
  }
  return harden(structuredClone(input));
}

/**
 * Build the decide-phase (planner) tool registry: the deterministic `plan`
 * function exposed as `propose_rebalance`, so an inference-driven planner
 * subagent can reason over the analyzer's target allocation and the forecast,
 * then delegate the funds-flow-step derivation and hashing to the deterministic
 * planner rather than composing the ymax-shaped proposal by hand. Read-only —
 * a proposal is not a signed transaction; no wallet capability is reachable.
 *
 * @returns {Record<string, object>} a registry of `assertToolDef`-shaped tools
 */
export function plannerToolRegistry() {
  const tools = [proposeRebalanceTool()];
  const registry = {};
  for (const t of tools) registry[t.name] = t;
  return registry;
}

/** Names of the tools in {@link plannerToolRegistry}, for capability subsets. */
export const PLANNER_TOOL_NAMES = ['propose_rebalance'];

/**
 * Build the audit-phase (auditor) tool registry: the deterministic `audit`
 * gate exposed as `audit_proposal`, so an inference-driven auditor subagent can
 * reason over the planner's proposal and the forecast that justified it, then
 * delegate the invariant checks (citation completeness, risk bounds, tail-risk
 * floor, hash reproducibility, pricing freshness, place/route reachability) to
 * the deterministic auditor rather than adjudicating them by hand. Strictly
 * read-only — the auditor recomputes and returns a verdict; a verdict is a
 * precondition for a live executor dispatch, never an authorization, and no
 * wallet capability is reachable from the audit-phase tool subset.
 *
 * @returns {Record<string, object>} a registry of `assertToolDef`-shaped tools
 */
export function auditorToolRegistry() {
  const tools = [auditProposalTool()];
  const registry = {};
  for (const t of tools) registry[t.name] = t;
  return registry;
}

/** Names of the tools in {@link auditorToolRegistry}, for capability subsets. */
export const AUDITOR_TOOL_NAMES = ['audit_proposal'];

/**
 * Build the act-phase (executor) tool registry: the deterministic `execute`
 * function, PINNED to dry-run, exposed as `simulate_execution`, so an
 * inference-driven executor subagent can reason over the audited proposal then
 * delegate the fire-time drift-guard re-audit, the clone-and-simulate of the
 * steps, and the would-be substrate transaction build to the deterministic
 * executor rather than mutating balances by hand.
 *
 * Safety is by construction: the tool hard-codes `mode: 'dry-run'` and vends
 * NO parent capabilities, so the executor runs with an empty cap set — the
 * capability attenuator never vends a wallet in dry-run, and the tool exposes
 * no path to request `mode: 'live'` or a keystore. `walletTouched` is therefore
 * always false, and it is returned as the proof the wallet was never reached.
 * A live executor dispatch — with a real wallet capability behind CapTP — stays
 * gated per `designs/cap-attenuation.md` and is not reachable from this tool.
 *
 * @returns {Record<string, object>} a registry of `assertToolDef`-shaped tools
 */
export function executorToolRegistry() {
  const tools = [simulateExecutionTool()];
  const registry = {};
  for (const t of tools) registry[t.name] = t;
  return registry;
}

/** Names of the tools in {@link executorToolRegistry}, for capability subsets. */
export const EXECUTOR_TOOL_NAMES = ['simulate_execution'];

/**
 * `execute` (the act-phase executor), pinned to dry-run, as a tool. This is the
 * deterministic simulation the design asks an inference-driven executor to
 * call: given the audited proposal, a pre-trade portfolio snapshot, the price
 * book, the forecast (the tail anchor for the fire-time drift-guard audit), the
 * freshness clock, and the cited oracle readings, it re-runs the audit
 * invariants at fire time, simulates the approved steps against a CLONE of the
 * portfolio (the live book is never mutated), builds the would-be substrate
 * transaction from the steps, and returns the execution result. Strictly
 * dry-run: no wallet capability is vended, no keystore is read, nothing is
 * signed or sent; `walletTouched` is always false and is the proof.
 */
function simulateExecutionTool() {
  return {
    name: 'simulate_execution',
    description:
      'Simulate execution of an audited rebalance proposal in DRY-RUN. Given the proposal (with its '
      + 'ordered steps and proposal_hash), the pre-trade portfolio snapshot, the latest price book, '
      + "the forecaster's terminal-equity projection (the tail anchor), the current tick (freshness "
      + 'clock), and the cited oracle readings, it re-runs the audit invariants at fire time (the '
      + 'drift guard), simulates the approved steps against a CLONE of the portfolio so the live '
      + 'book is never mutated, builds the would-be substrate transaction from the steps, and '
      + 'returns the completed steps, the post-execution balances, the prepared (unsigned) '
      + 'transaction, and the fire-time audit verdict. Use this to simulate the act phase rather '
      + 'than adjusting balances by hand. STRICTLY DRY-RUN: no wallet is vended, no keystore is '
      + 'read, nothing is signed or sent — walletTouched is always false and is the proof the '
      + 'wallet was never reached. A live execution is a separate, gated capability, never this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: { type: 'object', description: 'the audited planner proposal: { steps, proposal_hash, cited_forecasts, cited_analyses, substrate? }' },
        portfolio: { type: 'object', description: 'pre-trade snapshot: { cash, balances: { ASSET: qty }, quoteCurrency? }' },
        prices: { type: 'object', description: 'latest price book { ASSET: price }' },
        forecast: { type: 'object', description: 'the forecaster projection carrying p05Equity (the tail-risk anchor for the fire-time audit)' },
        currentTick: { type: 'number', description: 'the freshness clock (cited readings must be within the staleness window of it)' },
        oracleReadings: { type: 'array', description: 'cited oracle readings (carry observedAtTick for the freshness invariant)' },
        config: { type: 'object', description: 'optional audit bounds for the fire-time drift guard: { maxStepPct, maxDayPct, concentrationCapPct, tailFloorPct, stalenessWindowTicks }' },
        substrate: { type: 'string', description: "target substrate id ('sim' | 'agoric' | 'evm' | 'solana') for the prepared transaction; default the proposal's" },
      },
      required: ['proposal', 'portfolio', 'prices'],
      additionalProperties: true,
    },
    run: async (args) => {
      try {
        const snapshot = args.portfolio || { cash: 0, balances: {} };
        // Reconstruct a Portfolio from the plain snapshot and a minimal world
        // whose priceFeed just reports the supplied book. The executor only
        // reaches world.portfolio (clone / markToMarket) and world.priceFeed
        // (current), so this is the whole surface it needs.
        const portfolio = new Portfolio({
          cash: snapshot.cash != null ? snapshot.cash : 0,
          balances: snapshot.balances || {},
          quoteCurrency: snapshot.quoteCurrency,
        });
        const prices = args.prices || {};
        const world = {
          portfolio,
          priceFeed: { current: () => prices, t: args.currentTick },
        };
        // mode is hard-pinned to dry-run and no parentCaps are vended — the
        // executor runs with an empty capability set, so no wallet is reachable.
        const result = await execute(
          {
            proposal: args.proposal,
            world,
            forecast: args.forecast,
            oracleReadings: args.oracleReadings || [],
            currentTick: args.currentTick,
            parentCaps: {},
          },
          {
            mode: 'dry-run',
            auditConfig: args.config || {},
            substrate: args.substrate,
          },
        );
        const summary = `simulate_execution: ${result.steps_completed.length} step(s) simulated, `
          + `post-equity ${result.post_execution_balances.equity.toFixed(2)}, `
          + `fire-time audit ${result.fire_time_audit ? result.fire_time_audit.verdict : 'n/a'}, `
          + `wallet touched: ${result.walletTouched}`;
        return toolResult(true, [
          { type: 'json', value: result },
          { type: 'text', text: summary },
        ]);
      } catch (err) {
        return toolResult(false, [{ type: 'text', text: `simulate_execution failed: ${err.message || err}` }]);
      }
    },
  };
}

/**
 * `audit` (the pre-execution invariant gate) as a tool. This is the
 * deterministic adjudication the design asks an inference-driven auditor to
 * call: given the planner's proposal, the forecast that justified it, the
 * pre-trade portfolio snapshot, the price book, the freshness clock, and the
 * cited oracle readings, it recomputes every standing invariant and returns the
 * approved/rejected verdict naming any failed invariants. Read-only — the
 * auditor never mutates the proposal and never signs; no wallet is reachable.
 * The auditor reproduces the planner's hash, so the verdict is a deterministic
 * function of its inputs.
 */
function auditProposalTool() {
  return {
    name: 'audit_proposal',
    description:
      'Adjudicate a planner proposal against the standing pre-execution invariant set. Given the '
      + "proposal (with its ordered steps and proposal_hash), the forecaster's terminal-equity "
      + 'projection, the pre-trade portfolio snapshot, the latest price book, the current tick '
      + '(freshness clock), and the cited oracle readings, returns a verdict '
      + "('approved' | 'rejected'), the per-invariant results (citation-completeness, "
      + 'risk-bound-compliance, tail-risk-floor, reproducibility, pricing-freshness, '
      + 'place-route-reachability), and the names of any failed invariants. Use this to adjudicate '
      + 'the proposal rather than checking the invariants by hand — the auditor recomputes the '
      + 'proposal hash, so the verdict is the deterministic function of the inputs. Read-only: an '
      + 'approved verdict is a precondition for execution, never an authorization to trade.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: { type: 'object', description: 'the planner proposal: { steps, proposal_hash, cited_forecasts, cited_analyses, substrate? }' },
        forecast: { type: 'object', description: 'the forecaster projection carrying p05Equity (the tail-risk anchor)' },
        portfolio: { type: 'object', description: 'pre-trade snapshot: { cash, balances: { ASSET: qty } }' },
        prices: { type: 'object', description: 'latest price book { ASSET: price }' },
        currentTick: { type: 'number', description: 'the freshness clock (cited readings must be within the staleness window of it)' },
        oracleReadings: { type: 'array', description: 'cited oracle readings (carry observedAtTick for the freshness invariant)' },
        config: { type: 'object', description: 'optional bounds: { maxStepPct, maxDayPct, concentrationCapPct, tailFloorPct, stalenessWindowTicks }' },
      },
      required: ['proposal', 'portfolio', 'prices'],
      additionalProperties: true,
    },
    run: async (args) => {
      try {
        const verdict = audit(
          {
            proposal: args.proposal,
            forecast: args.forecast,
            portfolio: args.portfolio || { cash: 0, balances: {} },
            prices: args.prices || {},
            currentTick: args.currentTick,
            oracleReadings: args.oracleReadings || [],
          },
          args.config || {},
        );
        const summary = `audit_proposal: ${verdict.verdict}`
          + (verdict.failed_invariants.length > 0
            ? ` (failed: ${verdict.failed_invariants.join(', ')})`
            : ` (all ${verdict.invariant_results.length} invariants pass)`);
        return toolResult(true, [
          { type: 'json', value: verdict },
          { type: 'text', text: summary },
        ]);
      } catch (err) {
        return toolResult(false, [{ type: 'text', text: `audit_proposal failed: ${err.message || err}` }]);
      }
    },
  };
}

/**
 * `plan` (the ymax-shaped rebalance planner) as a tool. This is the
 * deterministic proposal-derivation the design asks an inference-driven
 * planner to call: given the portfolio, the analyzer's target weights, a price
 * book, risk bounds, and forecast/analysis citations, it returns the ordered
 * funds-flow steps, the content hash, and the dry-run summary. Read-only — the
 * planner emits a proposal; it never signs, so no wallet capability is reachable.
 */
function proposeRebalanceTool() {
  return {
    name: 'propose_rebalance',
    description:
      'Derive a ymax-shaped rebalance proposal. Given the current portfolio snapshot, the target '
      + 'weights (from the analyzer), the latest price book, optional risk bounds and target '
      + 'substrate, and citations of the forecasts/analyses that justify the move, returns the '
      + 'ordered funds-flow steps, a deterministic proposal_hash over them, whether a risk bound '
      + 'clamped a step, the NAV, and a human-readable dry_run_summary. Use this to compose the '
      + 'proposal rather than deriving the steps and hash by hand — the auditor reproduces this '
      + 'exact hash, so the plan must be the deterministic function of its inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        portfolio: { type: 'object', description: 'current snapshot: { cash, balances: { ASSET: qty }, quoteCurrency? }' },
        prices: { type: 'object', description: 'latest price book { ASSET: price }' },
        targetWeights: { type: 'object', description: 'desired allocation { ASSET: weight } (from the analyzer)' },
        bounds: { type: 'object', description: 'optional risk bounds: { maxStepFractionOfNav, maxWeightPerAsset, … }' },
        cited_forecasts: { type: 'array', description: 'forecaster entry ids/paths that justify the plan' },
        cited_analyses: { type: 'array', description: 'analyzer entry ids/paths that justify the plan' },
        substrate: { type: 'string', description: "target substrate id ('sim' | 'agoric' | 'evm' | 'solana'); default 'sim'" },
        venueMap: { type: 'object', description: 'optional asset -> venue/place id for the chosen substrate' },
      },
      required: ['portfolio', 'prices', 'targetWeights'],
      additionalProperties: true,
    },
    run: async (args) => {
      try {
        const proposal = plan({
          portfolio: args.portfolio || { cash: 0, balances: {} },
          prices: args.prices || {},
          targetWeights: args.targetWeights || {},
          bounds: args.bounds,
          cited_forecasts: args.cited_forecasts,
          cited_analyses: args.cited_analyses,
          substrate: args.substrate,
          venueMap: args.venueMap,
        });
        const summary = `propose_rebalance: ${proposal.steps.length} step(s), `
          + `hash=${proposal.proposal_hash.slice(0, 12)}…`
          + (proposal.clamped ? ', clamped by a risk bound' : '');
        return toolResult(true, [
          { type: 'json', value: proposal },
          { type: 'text', text: summary },
        ]);
      } catch (err) {
        return toolResult(false, [{ type: 'text', text: `propose_rebalance failed: ${err.message || err}` }]);
      }
    },
  };
}

/**
 * `analyze` (the analyzer's risk-adjusted scoring) as a tool. This is the
 * deterministic scoring the design asks an inference-driven analyzer to call.
 */
function scoreOpportunitiesTool() {
  return {
    name: 'score_opportunities',
    description:
      'Risk-adjusted scoring of oracle-watcher opportunities. Given the opportunity-deviation '
      + 'events, the price-reading window, the current portfolio snapshot, and the latest price '
      + 'book, returns per-asset scores (descending), the top-K recommendations with rationale, a '
      + "next_action ('propose-rebalance' | 'no-action'), and, when proposing, candidate "
      + 'targetWeights. Use this to score opportunities rather than computing the metric by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        opportunities: { type: 'array', description: 'oracle-watcher crossings (asset, deviationBps, direction, …)' },
        readings: { type: 'array', description: 'ordered price-reading window: [{ t, prices: { ASSET: price } }]' },
        portfolio: { type: 'object', description: 'current snapshot: { cash, balances: { ASSET: qty } }' },
        prices: { type: 'object', description: 'latest price book { ASSET: price }; defaults to the last reading' },
        config: { type: 'object', description: 'optional: { k, scoreFloor, reversionStrength, maxTargetWeight }' },
      },
      required: ['opportunities', 'readings', 'portfolio'],
      additionalProperties: true,
    },
    run: async (args) => {
      try {
        const result = analyze(
          {
            opportunities: args.opportunities || [],
            readings: args.readings || [],
            portfolio: args.portfolio || { cash: 0, balances: {} },
            prices: args.prices,
          },
          args.config || {},
        );
        const top = result.scores[0];
        const summary = `score_opportunities: next_action=${result.next_action}`
          + (top ? `; top ${top.asset} score=${top.score.toFixed(4)}` : '; no candidates')
          + (result.targetWeights ? ` target=${JSON.stringify(result.targetWeights)}` : '');
        return toolResult(true, [
          { type: 'json', value: result },
          { type: 'text', text: summary },
        ]);
      } catch (err) {
        return toolResult(false, [{ type: 'text', text: `score_opportunities failed: ${err.message || err}` }]);
      }
    },
  };
}

/** `realizedVolatility` as a tool (the score's risk denominator). */
function realizedVolatilityTool() {
  return {
    name: 'realized_volatility',
    description:
      'Realized volatility (stddev of per-step log returns) of one asset across a reading window. '
      + 'The risk denominator the scoring uses; call it to reason about an asset risk in isolation.',
    inputSchema: {
      type: 'object',
      properties: {
        readings: { type: 'array', description: 'ordered window: [{ t, prices: { ASSET: price } }]' },
        asset: { type: 'string', description: 'the asset symbol' },
      },
      required: ['readings', 'asset'],
      additionalProperties: true,
    },
    run: async (args) => {
      try {
        const vol = realizedVolatility(args.readings || [], args.asset);
        return toolResult(true, [
          { type: 'json', value: { asset: args.asset, volatility: vol } },
          { type: 'text', text: `realized_volatility(${args.asset}) = ${(vol * 100).toFixed(2)}%` },
        ]);
      } catch (err) {
        return toolResult(false, [{ type: 'text', text: `realized_volatility failed: ${err.message || err}` }]);
      }
    },
  };
}

/** `observeOpportunities` as a dispatch-bound tool (the observe-phase detector). */
function observeOpportunitiesTool(trustedInput) {
  return {
    name: 'observe_opportunities',
    description:
      'Detect opportunity-deviation events over this dispatch\'s trusted price-reading window. '
      + 'Inputs are bound by the dispatch and cannot be changed by the model. Read-only. Returns '
      + 'the crossings (most significant first) and the latest price book.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    run: async () => {
      try {
        // The model chooses whether to call the detector, but not its inputs.
        const source = trustedInput;
        const options = {};
        if (source.thresholdBps != null) options.thresholdBps = source.thresholdBps;
        if (source.assets) options.assets = source.assets;
        const observed = observeOpportunities({ readings: source.readings || [] }, options);
        return toolResult(true, [
          { type: 'json', value: observed },
          { type: 'text', text: `observe_opportunities: ${observed.crossings.length} crossing(s)` },
        ]);
      } catch (err) {
        return toolResult(false, [{ type: 'text', text: `observe_opportunities failed: ${err.message || err}` }]);
      }
    },
  };
}
