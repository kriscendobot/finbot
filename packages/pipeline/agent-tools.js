/**
 * Pipeline functions, exposed as harness tools.
 *
 * The OODA roles are deterministic functions over the simulator world (see
 * this package's `index.js`). This module wraps the orient-phase scoring
 * functions as `@finbot/harness` Tool definitions so an inference-driven
 * subagent can CALL them as tools — the "automatic inference, automation born
 * from inference" blend the design describes: the analyzer subagent reasons in
 * natural language over the oracle-watcher output, then delegates the actual
 * risk-adjusted scoring to the deterministic `analyze` function rather than
 * doing arithmetic in its head.
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

import { toolResult } from '@finbot/harness/schemas';

import { observeOpportunities } from './oracle-watcher.js';
import { analyze, realizedVolatility } from './analyzer.js';

/**
 * Build the orient-phase pipeline tool registry (keyed by tool name), suitable
 * for passing as `ctx.tools` to `spawn` (or merging into a larger registry).
 *
 * @returns {Record<string, object>} a registry of `assertToolDef`-shaped tools
 */
export function pipelineToolRegistry() {
  const tools = [scoreOpportunitiesTool(), realizedVolatilityTool(), observeOpportunitiesTool()];
  const registry = {};
  for (const t of tools) registry[t.name] = t;
  return registry;
}

/** Names of the tools in {@link pipelineToolRegistry}, for capability subsets. */
export const PIPELINE_TOOL_NAMES = ['score_opportunities', 'realized_volatility', 'observe_opportunities'];

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

/** `observeOpportunities` as a tool (the observe-phase detector). */
function observeOpportunitiesTool() {
  return {
    name: 'observe_opportunities',
    description:
      'Detect opportunity-deviation events over a price-reading window: assets whose price has '
      + 'deviated from the window reference by more than thresholdBps. Read-only. Returns the '
      + 'crossings (most significant first) and the latest price book.',
    inputSchema: {
      type: 'object',
      properties: {
        readings: { type: 'array', description: 'ordered window: [{ t, prices: { ASSET: price } }]' },
        thresholdBps: { type: 'number', description: 'minimum |deviation| in basis points to emit (default 50)' },
        assets: { type: 'array', description: 'optional asset allowlist' },
      },
      required: ['readings'],
      additionalProperties: true,
    },
    run: async (args) => {
      try {
        const opts = {};
        if (args.thresholdBps != null) opts.thresholdBps = args.thresholdBps;
        if (args.assets) opts.assets = args.assets;
        const observed = observeOpportunities({ readings: args.readings || [] }, opts);
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
