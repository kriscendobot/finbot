---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: opportunity-comparison

Cross-instrument opportunity scoring. Given a set of candidate instruments (each with its current yield, its forecast distribution, its correlation with the rest of the portfolio, and its gas / slippage cost to enter or exit), produce a risk-adjusted score per instrument and a ranked list.

Used by the [analyzer](../../roles/analyzer/AGENT.md) role.

## Purpose

Compare instruments on a single dimension (risk-adjusted return) that the planner can consume. Without this skill the planner would have to weigh multiple incommensurate dimensions (expected return, variance, correlation, cost) inline, which makes the planner harder to audit and harder to reason about.

## Inputs

```yaml
candidates:
  - instrument: <id>
    current_apr: <number>            # current yield (annualized)
    forecast_ref: <journal-entry-path>  # cited forecaster entry
    cost_to_enter:
      gas_pct: <number>
      slippage_pct: <number>
    cost_to_exit:
      gas_pct: <number>
      slippage_pct: <number>
portfolio_state:                     # current balances; used for correlation and concentration
  ...
risk_parameters:
  risk_free_rate: <number>           # for Sharpe-like comparison
  correlation_weight: <number>       # how strongly to penalize correlated additions
  concentration_cap_pct: <number>    # the planner's cap; over this the score goes to 0
horizon_days: <number>               # over which horizon the comparison applies
```

## Output

```yaml
scores:
  - instrument: <id>
    score: <number>                  # higher is better; comparable across candidates
    decomposition:                   # so the analyzer can name why in its rationale
      expected_return_annualized: <number>
      volatility_annualized: <number>
      sharpe: <number>
      correlation_penalty: <number>
      cost_drag_pct: <number>
      concentration_penalty: <number>
    tail_risk:
      p05_terminal_pct: <number>     # 5th-percentile terminal value as percent of entry
      max_drawdown_p95: <number>     # 95th-percentile max drawdown over the horizon
```

## Scoring formula (initial)

The initial formula, to be refined as the maintainer accumulates experience:

```
score = (sharpe - correlation_penalty - concentration_penalty) - cost_drag_pct

where:
  sharpe                = (expected_return - risk_free_rate) / volatility
  correlation_penalty   = correlation_weight * max(0, portfolio_correlation - 0.5)
  concentration_penalty = step * (concentration_pct > concentration_cap_pct ? infinity : 0)
  cost_drag_pct         = cost_to_enter.gas_pct + cost_to_enter.slippage_pct +
                          cost_to_exit.gas_pct + cost_to_exit.slippage_pct
```

The infinity penalty on concentration is intentional; opportunities that would breach the cap score to negative-infinity and are excluded from any planner consideration.

## Tail-risk floor

In addition to the score, each candidate carries the cited forecast's 5th-percentile terminal value. The analyzer reports it; the planner's risk-bound check rejects any candidate whose p05 falls below the configured tail-risk floor.

## Correlation handling

`portfolio_correlation` is the correlation of the candidate's returns with the rest of the portfolio's, computed from the historical price series cited in the forecast. The skill assumes the analyzer has access to the same historical series the forecaster consumed; in the bootstrap state this is informal (an entry path), but a future engagement may formalize a correlation cache.

## Notes

This is a stub. The actual implementation needs:

- A correlation estimator (rolling-window Pearson on historical returns is a reasonable default).
- A cost-model lookup per protocol (gas estimate + depth-aware slippage; the same model the planner uses).
- A formula refinement loop: the initial Sharpe-shaped formula is a starting point, not a research-backed recommendation.
