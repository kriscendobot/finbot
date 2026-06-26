/**
 * Inference-driven OODA role dispatch.
 *
 * `runOodaCycle` (this package's `ooda-cycle.js`) runs every stage as a
 * deterministic function call — pure automation, no LLM. This module is the
 * other half the design asks for: drive an OODA stage by **inference**, with
 * the deterministic pipeline functions available to the reasoning subagent as
 * tools. Concretely, `dispatchAnalyzer` spawns the analyzer as an LLM-shaped
 * subagent (via `@finbot/harness`'s `spawn`), hands it the oracle-watcher
 * output in its brief plus the orient-phase pipeline tools, and lets it reason
 * over the opportunities and CALL `score_opportunities` (the deterministic
 * `analyze`) as a tool. The stage's product — the scored AnalyzerResult — is
 * extracted from the tool-execution events, so the inference-driven path and
 * the headless path yield the same structured orient output.
 *
 * The LLM is injected. With no `llm`, `spawn` uses its deterministic stub, so
 * tests stay offline; pass `harness.providers.makeAnthropicLlm()` for real
 * inference, or `makeScriptedAnalyzerLlm(input)` for a faithful offline double
 * that calls the scoring tool with the real opportunity data.
 *
 * DRY-RUN by construction: this drives the ORIENT stage only (analyzer is
 * read-only; it scores, it does not trade). No wallet capability is reachable
 * from the analyzer's tool subset. Live execution stays gated behind the
 * executor per `designs/cap-attenuation.md`.
 */

import crypto from 'node:crypto';

import { pipelineToolRegistry, PIPELINE_TOOL_NAMES } from './agent-tools.js';

/**
 * Compose the analyzer's dispatch brief from an oracle-watcher observation and
 * the portfolio context. The brief embeds the structured inputs as JSON and
 * tells the subagent to score via the tool rather than by hand.
 *
 * @param {object} input
 * @returns {string}
 */
export function analyzerBrief(input) {
  const payload = {
    opportunities: input.opportunities || [],
    readings: input.readings || [],
    portfolio: input.portfolio || { cash: 0, balances: {} },
    prices: input.prices || null,
  };
  return [
    'An oracle-watcher read surfaced opportunity-deviation events. Score them for a possible',
    'rebalance. You are read-only: produce a scored recommendation and (if warranted) a candidate',
    'target weight; you do not trade.',
    '',
    'Use the `score_opportunities` tool for the risk-adjusted scoring — pass it the opportunities,',
    'the reading window, the portfolio snapshot, and the price book below. Do not compute the',
    'metric yourself. You may call `realized_volatility` to reason about a single asset risk.',
    '',
    'Then report next_action and, if proposing a rebalance, the candidate target weights.',
    '',
    'Inputs (JSON):',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

/**
 * Dispatch the analyzer as an inference-driven subagent over an oracle-watcher
 * observation, with the orient-phase pipeline functions available as tools.
 *
 * @param {object} input  oracle output + portfolio context: { opportunities, readings, portfolio, prices }
 * @param {object} deps
 * @param {Function} deps.spawn        the harness `spawn` function
 * @param {string}   deps.finbotRoot   root holding `roles/<role>/AGENT.md`
 * @param {Function} [deps.llm]        injected LLM; omit to use the harness stub (offline)
 * @param {Record<string, object>} [deps.tools]  tool registry (default: pipeline orient tools)
 * @param {string[]} [deps.capabilities]         tool subset the analyzer may call (default: pipeline tool names)
 * @returns {Promise<object>} { handle, analysis, scored, toolCalls, finalText, status }
 */
export async function dispatchAnalyzer(input, deps) {
  if (!deps || typeof deps.spawn !== 'function') {
    throw new Error('dispatchAnalyzer: deps.spawn (the harness spawn function) is required');
  }
  const tools = deps.tools || pipelineToolRegistry();
  const capabilities = deps.capabilities || PIPELINE_TOOL_NAMES;

  const handle = await deps.spawn(
    {
      role: 'analyzer',
      brief: analyzerBrief(input),
      capabilities,
      llm: deps.llm,
    },
    { finbotRoot: deps.finbotRoot, tools },
  );
  await handle.done;

  const toolCalls = extractToolCalls(handle.events);
  const analysis = lastScoringResult(handle.events);

  return {
    handle,
    status: handle.status,
    analysis,
    scored: analysis != null,
    toolCalls,
    finalText: handle.result ? handle.result.finalText : '',
  };
}

/**
 * Pull the names of the tools the subagent invoked, in order.
 *
 * @param {Array<object>} events
 * @returns {string[]}
 */
export function extractToolCalls(events) {
  return (events || [])
    .filter((e) => e.type === 'tool_execution_start' && e.toolCall)
    .map((e) => e.toolCall.name);
}

/**
 * Find the AnalyzerResult produced by the most recent successful
 * `score_opportunities` tool call (the orient stage's structured product).
 *
 * @param {Array<object>} events
 * @returns {object|null}
 */
export function lastScoringResult(events) {
  for (let i = (events || []).length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type !== 'tool_execution_end' || !e.toolCall || e.toolCall.name !== 'score_opportunities') continue;
    const result = e.result;
    if (!result || result.isError) continue;
    const jsonBlock = (result.content || []).find((c) => c && c.type === 'json');
    if (jsonBlock) return jsonBlock.value;
  }
  return null;
}

/**
 * A deterministic, offline stand-in for an inference-driven analyzer LLM: it
 * calls `score_opportunities` with the real opportunity data on turn 0, then
 * ends with a one-line summary on turn 1. This is the test double (and the
 * `--offline` path for the bin) that exercises the same dispatch wiring as a
 * real provider without a network call — the deterministic counterpart the job
 * asks to keep alongside the real provider.
 *
 * @param {object} input  same shape passed to {@link dispatchAnalyzer}
 * @returns {Function} an `llm` matching the spawn contract
 */
export function makeScriptedAnalyzerLlm(input) {
  return async function scriptedAnalyzerLlm(args) {
    if (args.turn === 0 && args.tools && args.tools.score_opportunities) {
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Scoring the opportunities via the deterministic scorer.' },
          {
            type: 'toolCall',
            id: crypto.randomBytes(4).toString('hex'),
            name: 'score_opportunities',
            arguments: {
              opportunities: input.opportunities || [],
              readings: input.readings || [],
              portfolio: input.portfolio || { cash: 0, balances: {} },
              prices: input.prices,
              config: input.analyzerConfig || { scoreFloor: 0 },
            },
          },
        ],
        stopReason: 'tool_use',
        timestamp: Date.now(),
      };
    }
    // Turn 1+: summarize the scored result (if surfaced in the tool result) and stop.
    const summary = summarizeFromToolResults(args.messages);
    return {
      role: 'assistant',
      content: [{ type: 'text', text: summary }],
      stopReason: 'end_turn',
      timestamp: Date.now(),
    };
  };
}

/**
 * @param {Array<object>} messages
 * @returns {string}
 */
function summarizeFromToolResults(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'toolResult') continue;
    const jsonBlock = (m.content || []).find((c) => c && c.type === 'json');
    if (jsonBlock && jsonBlock.value && jsonBlock.value.next_action) {
      const v = jsonBlock.value;
      return `Analyzer orient complete: next_action=${v.next_action}`
        + (v.targetWeights ? `, target=${JSON.stringify(v.targetWeights)}` : '');
    }
  }
  return 'Analyzer orient complete.';
}
