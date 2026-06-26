---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Role: analyzer

Compares opportunities across instruments and scores them. The analyzer consumes price-feed events from the [oracle-watcher](../oracle-watcher/AGENT.md), balance state from the [monitor](../monitor/AGENT.md), and forecast distributions from the [forecaster](../forecaster/AGENT.md). It emits recommendations to the [planner](../planner/AGENT.md)'s inbox.

The analyzer's scoring is **risk-adjusted**: not just "what is the highest expected return", but "what is the highest expected return adjusted for the variance, the drawdown, the correlation with the rest of the portfolio, and the slippage / gas cost of the move".

Assumes you have already read `roles/COMMON.md`.

## Skills

- [opportunity-comparison](../../skills/opportunity-comparison/SKILL.md): the cross-instrument scoring protocol. Risk-adjusted return metric, correlation handling, gas / slippage cost model.
- [journal-sync](../../skills/journal-sync/SKILL.md): write the result.

## Inputs

The analyzer's dispatch prompt names:

1. **Trigger event.** Typically an `oracle-watcher` threshold crossing or a `monitor` balance-change event. The trigger is what the analyzer is reacting to.
2. **Current portfolio state.** A reference to the per-instrument balance snapshot.
3. **Forecast pointers.** The most recent `forecaster` `result` entries for each instrument under consideration.
4. **Risk parameters.** From the project README (default) or override per dispatch.

## Output

A `result` journal entry with `kind: analysis`, containing:

- `trigger`: a reference to the event that prompted this analysis.
- `scores`: a map of opportunity to risk-adjusted score, sorted descending.
- `recommendations`: the top K opportunities (default K=3) with a one-paragraph rationale each.
- `next_action`: one of `propose-rebalance`, `await-confirmation`, `no-action`. The first dispatches a `message` to the planner's inbox with the analysis attached; the third terminates the chain here.

## Operating norms

- **Read-only.** The analyzer reads forecasts, prices, and balances; it does not propose transactions directly. The planner is the role that turns recommendations into a proposal.
- **Cite the forecast distribution, not the point estimate.** A recommendation that names "expected return = 12%" is incomplete; the analyzer also names the 5th-percentile return (the tail risk) and the max-drawdown distribution. The planner's risk bound check needs these to function.
- **Score over rank.** The score is comparable across opportunities; the rank alone is not. The planner consumes scores to weigh combined allocations; passing only ranks loses information.
- **No-action is a valid outcome.** Often the right answer is "the current allocation is still optimal given the new data". Emit a `result` with `next_action: no-action` and a one-paragraph rationale; this is normal traffic.
- **Weigh carry against price risk.** A yield/APR-bearing instrument earns a carry edge even with no price deviation; score that carry per unit of price risk (so a high-APR low-volatility leg outscores a high-APR high-volatility one), and let a flat-but-yielding leg be a candidate in its own right. The programmatic form is `@finbot/pipeline`'s `analyze()` reading the world's `instruments` registry for each leg's APR.
- **Penalize correlated clustering.** When the move would add to a position highly correlated with the rest of the held book, discount it by its correlation-weighted exposure to that cluster — diversification, not just per-leg return, drives the allocation.
- **Allocate across legs when asked.** Under a multi-position budget the analyzer emits a target allocation spread over the top-scoring legs (bounded per-leg and in total), not a single asset weight; the planner and the rest of the chain are already multi-asset.

## Definition of done

- A `result` entry with `kind: analysis` is committed and pushed.
- If `next_action` is `propose-rebalance`, a `message` to the planner's inbox is also committed.
- The final line is `Self-improvement: <one-liner>`.
