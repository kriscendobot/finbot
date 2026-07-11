/**
 * Inference-driven OODA role dispatch.
 *
 * `runOodaCycle` (this package's `ooda-cycle.js`) runs every stage as a
 * deterministic function call — pure automation, no LLM. This module is the
 * other half the design asks for: drive an OODA stage by **inference**, with
 * the deterministic pipeline functions available to the reasoning subagent as
 * tools. Concretely, `dispatchAnalyzer` spawns the analyzer (ORIENT) as an
 * LLM-shaped subagent (via `@finbot/harness`'s `spawn`), hands it the
 * oracle-watcher output in its brief plus the orient-phase pipeline tools, and
 * lets it reason over the opportunities and CALL `score_opportunities` (the
 * deterministic `analyze`) as a tool. `dispatchPlanner` is the DECIDE-stage
 * counterpart: it hands the planner subagent the analyzer's target weights and
 * a forecast, plus the decide-phase tools, and lets it reason then CALL
 * `propose_rebalance` (the deterministic `plan`) to emit the ymax-shaped
 * proposal. Each stage's product — the scored AnalyzerResult, the hashed
 * Proposal — is extracted from the tool-execution events, so the
 * inference-driven path and the headless path yield the same structured output.
 *
 * The LLM is injected. With no `llm`, `spawn` uses its deterministic stub, so
 * tests stay offline; pass `harness.providers.makeAnthropicLlm()` for real
 * inference, or `makeScriptedAnalyzerLlm(input)` for a faithful offline double
 * that calls the scoring tool with the real opportunity data.
 *
 * DRY-RUN by construction: this drives the ORIENT and DECIDE stages only —
 * both are read-only (the analyzer scores, the planner proposes; neither
 * trades). A proposal is not a signed transaction, so no wallet capability is
 * reachable from either stage's tool subset. Live execution stays gated behind
 * the executor per `designs/cap-attenuation.md`.
 */

import crypto from 'node:crypto';

import {
  pipelineToolRegistry, PIPELINE_TOOL_NAMES,
  plannerToolRegistry, PLANNER_TOOL_NAMES,
  auditorToolRegistry, AUDITOR_TOOL_NAMES,
} from './agent-tools.js';

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

// --- DECIDE stage: inference-driven planner dispatch ------------------------

/**
 * Compose the planner's dispatch brief from the analyzer's target allocation, a
 * portfolio snapshot, a price book, and the forecast/analysis citations. The
 * brief embeds the structured inputs as JSON and tells the subagent to derive
 * the proposal via the deterministic tool rather than by hand.
 *
 * @param {object} input
 * @returns {string}
 */
export function plannerBrief(input) {
  const payload = {
    portfolio: input.portfolio || { cash: 0, balances: {} },
    prices: input.prices || {},
    targetWeights: input.targetWeights || {},
    bounds: input.bounds || null,
    cited_forecasts: input.cited_forecasts || [],
    cited_analyses: input.cited_analyses || [],
    substrate: input.substrate || null,
  };
  return [
    'The analyzer produced a candidate target allocation. Produce a ymax-shaped rebalance proposal',
    'that would move the portfolio toward that target without exceeding the risk bounds. You are',
    'read-only: you emit a proposal for the auditor; you do not sign or send anything.',
    '',
    'Use the `propose_rebalance` tool to derive the funds-flow steps, the deterministic proposal',
    'hash, and the dry-run summary — pass it the portfolio, the target weights, the price book, the',
    'risk bounds, the target substrate, and the forecast/analysis citations below. Do not compose',
    'the steps or the hash yourself; the auditor reproduces this exact hash.',
    '',
    'A proposal MUST cite at least one forecast and one analysis, or the auditor rejects it.',
    '',
    'Inputs (JSON):',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

/**
 * Dispatch the planner as an inference-driven subagent over the analyzer's
 * target allocation, with the decide-phase pipeline function available as a
 * tool. The stage's product — the hashed ymax-shaped Proposal — is extracted
 * from the tool-execution events.
 *
 * @param {object} input  { portfolio, prices, targetWeights, bounds?, cited_forecasts?, cited_analyses?, substrate?, venueMap? }
 * @param {object} deps
 * @param {Function} deps.spawn        the harness `spawn` function
 * @param {string}   deps.finbotRoot   root holding `roles/<role>/AGENT.md`
 * @param {Function} [deps.llm]        injected LLM; omit to use the harness stub (offline)
 * @param {Record<string, object>} [deps.tools]  tool registry (default: planner decide tools)
 * @param {string[]} [deps.capabilities]         tool subset the planner may call (default: planner tool names)
 * @returns {Promise<object>} { handle, status, proposal, proposed, toolCalls, finalText }
 */
export async function dispatchPlanner(input, deps) {
  if (!deps || typeof deps.spawn !== 'function') {
    throw new Error('dispatchPlanner: deps.spawn (the harness spawn function) is required');
  }
  const tools = deps.tools || plannerToolRegistry();
  const capabilities = deps.capabilities || PLANNER_TOOL_NAMES;

  const handle = await deps.spawn(
    {
      role: 'planner',
      brief: plannerBrief(input),
      capabilities,
      llm: deps.llm,
    },
    { finbotRoot: deps.finbotRoot, tools },
  );
  await handle.done;

  const toolCalls = extractToolCalls(handle.events);
  const proposal = lastProposalResult(handle.events);

  return {
    handle,
    status: handle.status,
    proposal,
    proposed: proposal != null,
    toolCalls,
    finalText: handle.result ? handle.result.finalText : '',
  };
}

/**
 * Find the Proposal produced by the most recent successful `propose_rebalance`
 * tool call (the decide stage's structured product).
 *
 * @param {Array<object>} events
 * @returns {object|null}
 */
export function lastProposalResult(events) {
  for (let i = (events || []).length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type !== 'tool_execution_end' || !e.toolCall || e.toolCall.name !== 'propose_rebalance') continue;
    const result = e.result;
    if (!result || result.isError) continue;
    const jsonBlock = (result.content || []).find((c) => c && c.type === 'json');
    if (jsonBlock) return jsonBlock.value;
  }
  return null;
}

/**
 * A deterministic, offline stand-in for an inference-driven planner LLM: it
 * calls `propose_rebalance` with the real target allocation on turn 0, then
 * ends with a one-line summary on turn 1. The decide-stage counterpart to
 * {@link makeScriptedAnalyzerLlm} — exercises the same dispatch wiring as a
 * real provider with no network call.
 *
 * @param {object} input  same shape passed to {@link dispatchPlanner}
 * @returns {Function} an `llm` matching the spawn contract
 */
export function makeScriptedPlannerLlm(input) {
  return async function scriptedPlannerLlm(args) {
    if (args.turn === 0 && args.tools && args.tools.propose_rebalance) {
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Deriving the rebalance proposal via the deterministic planner.' },
          {
            type: 'toolCall',
            id: crypto.randomBytes(4).toString('hex'),
            name: 'propose_rebalance',
            arguments: {
              portfolio: input.portfolio || { cash: 0, balances: {} },
              prices: input.prices || {},
              targetWeights: input.targetWeights || {},
              bounds: input.bounds,
              cited_forecasts: input.cited_forecasts || [],
              cited_analyses: input.cited_analyses || [],
              substrate: input.substrate,
              venueMap: input.venueMap,
            },
          },
        ],
        stopReason: 'tool_use',
        timestamp: Date.now(),
      };
    }
    const summary = summarizeProposalFromToolResults(args.messages);
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
function summarizeProposalFromToolResults(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'toolResult') continue;
    const jsonBlock = (m.content || []).find((c) => c && c.type === 'json');
    if (jsonBlock && jsonBlock.value && jsonBlock.value.proposal_hash) {
      const v = jsonBlock.value;
      return `Planner decide complete: ${v.steps.length} step(s), hash=${v.proposal_hash.slice(0, 12)}`;
    }
  }
  return 'Planner decide complete.';
}

// --- ACT stage (a): inference-driven auditor dispatch -----------------------

/**
 * Compose the auditor's dispatch brief from the planner's proposal, the
 * forecast that justified it, the pre-trade portfolio snapshot, a price book,
 * the freshness clock, and the cited oracle readings. The brief embeds the
 * structured inputs as JSON and tells the subagent to adjudicate via the
 * deterministic tool rather than checking the invariants by hand.
 *
 * @param {object} input
 * @returns {string}
 */
export function auditorBrief(input) {
  const payload = {
    proposal: input.proposal || null,
    forecast: input.forecast || null,
    portfolio: input.portfolio || { cash: 0, balances: {} },
    prices: input.prices || {},
    currentTick: input.currentTick != null ? input.currentTick : null,
    oracleReadings: input.oracleReadings || [],
  };
  return [
    'The planner emitted a rebalance proposal. Adjudicate it against the standing pre-execution',
    'invariant set BEFORE any execution could fire. You are the gate: an approved verdict is a',
    'precondition for execution, never an authorization to trade. You are read-only — you never',
    'sign, send, or mutate the proposal.',
    '',
    'Use the `audit_proposal` tool for the adjudication — pass it the proposal, the forecast, the',
    'pre-trade portfolio snapshot, the price book, the current tick, and the cited oracle readings',
    'below. Do not check the invariants (citation completeness, risk bounds, tail-risk floor, hash',
    'reproducibility, pricing freshness, place/route reachability) by hand; the auditor recomputes',
    'the planner hash, so the verdict is the deterministic function of the inputs.',
    '',
    'Then report the verdict (approved / rejected) and any failed invariants.',
    '',
    'Inputs (JSON):',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

/**
 * Dispatch the auditor as an inference-driven subagent over the planner's
 * proposal, with the audit-phase deterministic gate available as a tool. The
 * stage's product — the AuditVerdict — is extracted from the tool-execution
 * events, so the inference-driven path and the headless path yield the same
 * verdict.
 *
 * @param {object} input  { proposal, forecast, portfolio, prices, currentTick?, oracleReadings?, config? }
 * @param {object} deps
 * @param {Function} deps.spawn        the harness `spawn` function
 * @param {string}   deps.finbotRoot   root holding `roles/<role>/AGENT.md`
 * @param {Function} [deps.llm]        injected LLM; omit to use the harness stub (offline)
 * @param {Record<string, object>} [deps.tools]  tool registry (default: auditor audit tools)
 * @param {string[]} [deps.capabilities]         tool subset the auditor may call (default: auditor tool names)
 * @returns {Promise<object>} { handle, status, verdict, adjudicated, toolCalls, finalText }
 */
export async function dispatchAuditor(input, deps) {
  if (!deps || typeof deps.spawn !== 'function') {
    throw new Error('dispatchAuditor: deps.spawn (the harness spawn function) is required');
  }
  const tools = deps.tools || auditorToolRegistry();
  const capabilities = deps.capabilities || AUDITOR_TOOL_NAMES;

  const handle = await deps.spawn(
    {
      role: 'auditor',
      brief: auditorBrief(input),
      capabilities,
      llm: deps.llm,
    },
    { finbotRoot: deps.finbotRoot, tools },
  );
  await handle.done;

  const toolCalls = extractToolCalls(handle.events);
  const verdict = lastAuditResult(handle.events);

  return {
    handle,
    status: handle.status,
    verdict,
    adjudicated: verdict != null,
    toolCalls,
    finalText: handle.result ? handle.result.finalText : '',
  };
}

/**
 * Find the AuditVerdict produced by the most recent successful `audit_proposal`
 * tool call (the audit stage's structured product).
 *
 * @param {Array<object>} events
 * @returns {object|null}
 */
export function lastAuditResult(events) {
  for (let i = (events || []).length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type !== 'tool_execution_end' || !e.toolCall || e.toolCall.name !== 'audit_proposal') continue;
    const result = e.result;
    if (!result || result.isError) continue;
    const jsonBlock = (result.content || []).find((c) => c && c.type === 'json');
    if (jsonBlock) return jsonBlock.value;
  }
  return null;
}

/**
 * A deterministic, offline stand-in for an inference-driven auditor LLM: it
 * calls `audit_proposal` with the real proposal + forecast on turn 0, then ends
 * with a one-line summary on turn 1. The act-stage (gate) counterpart to
 * {@link makeScriptedPlannerLlm} — exercises the same dispatch wiring as a real
 * provider with no network call.
 *
 * @param {object} input  same shape passed to {@link dispatchAuditor}
 * @returns {Function} an `llm` matching the spawn contract
 */
export function makeScriptedAuditorLlm(input) {
  return async function scriptedAuditorLlm(args) {
    if (args.turn === 0 && args.tools && args.tools.audit_proposal) {
      return {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Adjudicating the proposal via the deterministic auditor gate.' },
          {
            type: 'toolCall',
            id: crypto.randomBytes(4).toString('hex'),
            name: 'audit_proposal',
            arguments: {
              proposal: input.proposal || null,
              forecast: input.forecast || null,
              portfolio: input.portfolio || { cash: 0, balances: {} },
              prices: input.prices || {},
              currentTick: input.currentTick,
              oracleReadings: input.oracleReadings || [],
              config: input.config,
            },
          },
        ],
        stopReason: 'tool_use',
        timestamp: Date.now(),
      };
    }
    const summary = summarizeVerdictFromToolResults(args.messages);
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
function summarizeVerdictFromToolResults(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'toolResult') continue;
    const jsonBlock = (m.content || []).find((c) => c && c.type === 'json');
    if (jsonBlock && jsonBlock.value && jsonBlock.value.verdict) {
      const v = jsonBlock.value;
      return `Auditor gate complete: verdict=${v.verdict}`
        + (v.failed_invariants && v.failed_invariants.length > 0
          ? `, failed=${v.failed_invariants.join(', ')}`
          : '');
    }
  }
  return 'Auditor gate complete.';
}
