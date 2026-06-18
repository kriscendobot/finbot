/**
 * Self-improvement: reflection + proposal generator.
 *
 * After a batch of ticks the simulator can run a reflection step that
 * inspects recent observations and efficacy metrics and produces a
 * small bounded list of proposals for rule/skill changes. Proposals
 * are written as a journal entry (via the @finbot/harness
 * observation/record API) so the next batch picks them up through
 * journal-sync.
 *
 * Proposals are intentionally narrow:
 *
 *   - "the analyzer should weigh momentum signal at 0.7 not 0.5"
 *   - "the planner should cap any single-asset allocation at 30%"
 *   - "the executor should skip trades smaller than $5 notional"
 *
 * Not wholesale rewrites. The reflector enforces the bound by only
 * proposing changes to numeric weights present in `harnessConfig`,
 * and by capping the number of proposals per reflection (default 3).
 *
 * The reflector is deterministic given the same observations + metrics
 * + harnessConfig. No LLM call in v0; the proposal heuristic is rule-
 * based. A later cut can plug in an LLM via the harness's spawn() to
 * elaborate on the rule-based seed, and the proposal shape stays the
 * same so downstream consumers do not break.
 */

import { summaryMetrics } from './metrics.js';

/**
 * @typedef {object} Proposal
 * @property {string} target              dotted path into harnessConfig (e.g. "weights.momentum")
 * @property {number | string | boolean} from
 * @property {number | string | boolean} to
 * @property {string} rationale           one-sentence why
 * @property {number} confidence          0..1
 */

/**
 * Reflect on a window of observations + metrics and emit proposals.
 *
 * @param {object} cfg
 * @param {Array<{t: number, portfolio: object}>} cfg.observations
 * @param {object} [cfg.harnessConfig]     the world's harnessConfig at reflection time
 * @param {object} [cfg.priorProposals]    list of prior proposals; reflector avoids
 *                                          re-proposing the same target within one batch
 * @param {number} [cfg.maxProposals]      default 3
 * @returns {{ summary: object, proposals: Proposal[] }}
 */
export function reflect(cfg) {
  const obs = cfg.observations || [];
  const harnessConfig = cfg.harnessConfig || {};
  const priorProposals = cfg.priorProposals || [];
  const maxProposals = cfg.maxProposals != null ? cfg.maxProposals : 3;

  const summary = summaryMetrics(obs);
  const proposals = [];
  const seen = new Set(priorProposals.map((p) => p.target));

  const weights = harnessConfig.weights || {};
  // Heuristic 1: negative P&L -> propose damping the most-trusted signal weight
  if (summary.pnlPct < 0 && weights.momentum != null) {
    if (!seen.has('weights.momentum')) {
      const next = Math.max(0, +(weights.momentum * 0.8).toFixed(3));
      proposals.push({
        target: 'weights.momentum',
        from: weights.momentum,
        to: next,
        rationale: `Batch P&L was ${(summary.pnlPct * 100).toFixed(2)}%; reduce momentum weight by 20% to lower exposure to trend-chasing.`,
        confidence: 0.5,
      });
      seen.add('weights.momentum');
    }
  }

  // Heuristic 2: high drawdown -> propose tightening drawdown stop
  if (summary.maxDrawdownPct > 0.15 && harnessConfig.drawdownStopPct != null) {
    if (!seen.has('drawdownStopPct')) {
      const next = +(harnessConfig.drawdownStopPct * 0.9).toFixed(3);
      proposals.push({
        target: 'drawdownStopPct',
        from: harnessConfig.drawdownStopPct,
        to: next,
        rationale: `Max drawdown of ${(summary.maxDrawdownPct * 100).toFixed(2)}% breached the soft threshold; tighten the stop by 10%.`,
        confidence: 0.6,
      });
      seen.add('drawdownStopPct');
    }
  }

  // Heuristic 3: negative Sharpe -> propose raising the per-trade minimum
  // notional to filter noise trades
  if (summary.sharpe < 0 && harnessConfig.minTradeNotional != null) {
    if (!seen.has('minTradeNotional')) {
      const next = +(harnessConfig.minTradeNotional * 1.5).toFixed(2);
      proposals.push({
        target: 'minTradeNotional',
        from: harnessConfig.minTradeNotional,
        to: next,
        rationale: `Sharpe of ${summary.sharpe.toFixed(2)} is negative; raise the per-trade minimum to filter noise.`,
        confidence: 0.4,
      });
      seen.add('minTradeNotional');
    }
  }

  // Heuristic 4: strong positive Sharpe -> propose loosening allocation cap
  // (the planner has been conservative and could deploy more capital)
  if (summary.sharpe > 1 && harnessConfig.maxAllocationPct != null) {
    if (!seen.has('maxAllocationPct')) {
      const cap = harnessConfig.maxAllocationPct;
      const next = Math.min(1, +(cap + 0.05).toFixed(3));
      if (next !== cap) {
        proposals.push({
          target: 'maxAllocationPct',
          from: cap,
          to: next,
          rationale: `Sharpe of ${summary.sharpe.toFixed(2)} suggests the strategy can absorb more allocation; raise cap by 5 percentage points.`,
          confidence: 0.5,
        });
        seen.add('maxAllocationPct');
      }
    }
  }

  // Heuristic 5: zero trades over the window -> propose lowering the
  // threshold that gates planner proposals
  if (summary.tradeCount === 0 && harnessConfig.proposeThreshold != null) {
    if (!seen.has('proposeThreshold')) {
      const next = +(harnessConfig.proposeThreshold * 0.8).toFixed(4);
      proposals.push({
        target: 'proposeThreshold',
        from: harnessConfig.proposeThreshold,
        to: next,
        rationale: 'No trades fired this batch; lower the propose threshold by 20% to surface more candidates.',
        confidence: 0.4,
      });
      seen.add('proposeThreshold');
    }
  }

  return { summary, proposals: proposals.slice(0, maxProposals) };
}

/**
 * Render reflection output as a journal-entry body string.
 *
 * @param {{summary: object, proposals: Proposal[]}} reflection
 * @param {object} [opts]
 * @param {string} [opts.tag]             a label for the reflection (e.g. 'batch-0042')
 * @returns {string}
 */
export function renderReflection(reflection, opts = {}) {
  const { summary, proposals } = reflection;
  const lines = [];
  lines.push(`# Self-improvement reflection${opts.tag ? ` (${opts.tag})` : ''}`);
  lines.push('');
  lines.push('## Window summary');
  lines.push('');
  lines.push(`- ticks: ${summary.ticks}`);
  lines.push(`- initial equity: ${formatNum(summary.initialEquity)}`);
  lines.push(`- final equity: ${formatNum(summary.finalEquity)}`);
  lines.push(`- total P&L: ${formatNum(summary.totalPnL)} (${(summary.pnlPct * 100).toFixed(2)}%)`);
  lines.push(`- max drawdown: ${formatNum(summary.maxDrawdown)} (${(summary.maxDrawdownPct * 100).toFixed(2)}%)`);
  lines.push(`- volatility (annualized): ${(summary.volatility * 100).toFixed(2)}%`);
  lines.push(`- Sharpe (annualized): ${summary.sharpe.toFixed(3)}`);
  lines.push(`- trades: ${summary.tradeCount}`);
  lines.push('');
  lines.push('## Proposals');
  lines.push('');
  if (proposals.length === 0) {
    lines.push('No proposals this batch; metrics are within acceptable bands.');
  } else {
    for (const p of proposals) {
      lines.push(`- **${p.target}**: ${formatVal(p.from)} -> ${formatVal(p.to)} (confidence ${p.confidence.toFixed(2)})`);
      lines.push(`    Rationale: ${p.rationale}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Convenience: run reflect() and write the result as a journal entry
 * via the @finbot/harness observation recorder.
 *
 * @param {object} cfg                                  forwarded to reflect()
 * @param {string} cfg.journalRoot
 * @param {Function} cfg.recordEntry                    typically @finbot/harness recordEntry
 * @param {string} [cfg.role]                           default 'simulator'
 * @param {string} [cfg.project]                        default 'finbot'
 * @param {string} [cfg.tag]
 * @param {boolean} [cfg.dryRun]                        skip the journal write; return rendered body only
 * @returns {Promise<{ summary: object, proposals: Proposal[], path?: string, body: string }>}
 */
export async function reflectAndRecord(cfg) {
  const reflection = reflect(cfg);
  const body = renderReflection(reflection, { tag: cfg.tag });
  if (cfg.dryRun || !cfg.recordEntry) {
    return { ...reflection, body };
  }
  const path = await cfg.recordEntry(cfg.journalRoot, {
    kind: 'message',
    role: cfg.role || 'simulator',
    body,
    project: cfg.project || 'finbot',
    to: 'liaison',
  }, { localOnly: cfg.localOnly });
  return { ...reflection, body, path };
}

function formatNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  return n.toFixed(2);
}

function formatVal(v) {
  if (typeof v === 'number') return v.toString();
  return JSON.stringify(v);
}
