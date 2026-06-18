---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: monte-carlo-ensemble

The Monte Carlo ensemble simulation machinery. Run N independent stochastic trajectories of a financial program over a fixed time horizon; aggregate into a histogram of terminal outcomes and a set of path-statistic distributions. The forecaster's central skill; "the meat of this machine" per the maintainer's framing.

## Purpose

Produce a deterministic, reproducible histogram of likely outcomes for a financial program, plus path-statistic distributions (max drawdown, time-to-recovery), given:

- A program (function from chain state and time to action).
- A time horizon.
- An ensemble size N.
- A deterministic seed.
- An input distribution per stochastic source (price feed, volatility surface, gas cost, slippage, oracle drift).

## Inputs

```yaml
program:                  # one of: terminal-price | allocation-value | hedge-pnl | custom
  kind: ...
  config: ...             # program-specific parameters
horizon:                  # e.g. 1d, 7d, 30d
ensemble_size:            # e.g. 10000
seed:                     # 32-byte hex; same seed -> same output
input_distributions:
  price_feed:
    instrument: USDC
    history: <path-to-historical-prices>
    model: gbm | mean-reverting | empirical-bootstrap
  volatility_surface:
    source: <path-to-implied-vol-data>
  gas_cost:
    distribution: <constant | empirical | fee-market-model>
  slippage:
    distribution: <constant | depth-aware>
```

## Procedure

```pseudo
1. Initialize the deterministic RNG from `seed`.
2. For each of N trajectories:
   a. Sample initial conditions from input_distributions.
   b. Step the program forward in time-step increments to the horizon, sampling
      each stochastic source at each step from the same seeded RNG.
   c. Record terminal value and path statistics (max drawdown, time-to-recovery,
      whatever the program declares).
3. Aggregate:
   a. Histogram of terminal values (with configurable bin count; default 100).
   b. Quantile summary: 5, 25, 50, 75, 95.
   c. Path-statistic distributions (per-trajectory series of max drawdown etc.).
4. Bootstrap confidence bands on the quantile estimates (default 1000 resamples).
5. Emit:
   a. JSON artifact under `journal/forecasts/<YYYY>/<MM>/<DD>/<short-id>.json`.
   b. Companion projection SVG / PNG via `histogram-projection-render`.
```

## Output shape (JSON)

```json
{
  "program": {...},
  "horizon": "7d",
  "ensemble_size": 10000,
  "seed": "deadbeef...",
  "histogram": {
    "bin_edges": [...],
    "counts": [...]
  },
  "quantiles": {
    "p05": ...,
    "p25": ...,
    "p50": ...,
    "p75": ...,
    "p95": ...,
    "p05_ci_low": ...,
    "p05_ci_high": ...,
    ...
  },
  "path_statistics": {
    "max_drawdown": {
      "histogram": {...},
      "quantiles": {...}
    },
    "time_to_recovery": {...}
  },
  "input_distributions_hash": "<sha256 of the canonical-json of input_distributions>"
}
```

The `input_distributions_hash` is the audit trail: a forecast is reproducible by re-running with the same `seed` against the same `input_distributions_hash`.

## Determinism contract

Same program + horizon + ensemble_size + seed + input_distributions_hash -> identical output bytes. If the simulation calls any random source other than the seeded RNG (Math.random, system time, network jitter), that is a bug. The forecaster's `result` entry asserts byte-identity against a known prior run when one exists; drift surfaces a regression.

## Quantile stability

Tail quantiles are noisy at small N. The skill computes a confidence band on each quantile via bootstrap (resample the ensemble with replacement, recompute the quantile, repeat 1000 times, take the 5th and 95th percentile of the bootstrap distribution). The forecaster's report names the band; the planner consumes both the point estimate and the band.

At N=10,000, the 5th and 95th percentiles are tight (band typically less than 5% of the estimate). At N=1,000, they are wide enough that the planner often refuses to bound risk on them and the forecaster's report says so. The maintainer can request N=100,000 or higher when the tails matter; runtime scales linearly.

## Notes

This is a stub. The actual implementation needs:

- A pluggable program interface (the program is a function of state and time; different programs go beyond terminal-price into hedge strategies, portfolio allocations, etc.).
- A choice of stochastic-process library (TBD; the parent garden does not have a financial-stochastics dependency to mirror).
- A pluggable price-feed model (GBM, mean-reverting, empirical bootstrap from historical returns).

The shape above is the contract the planner and the histogram renderer depend on; the implementation lands incrementally.
