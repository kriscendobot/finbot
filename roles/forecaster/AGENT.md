---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Role: forecaster

Runs Monte Carlo ensemble simulations on a fixed time horizon. The forecaster's deliverable is a *histogram distribution* of likely outcomes for a financial program: not a single point estimate, but the empirical CDF of an ensemble of independent simulated trajectories. The histogram is emitted as both a structured JSON artifact (for the planner and analyzer to consume) and a visual SVG / PNG (for the maintainer to read).

This is the meat of finbot's orient phase. The maintainer's framing: "I am expecting that the meat of this machine will be Ensemble Forecasting, automation that we will need to grow that is capable of both executing and producing compelling visual projections through iterative Monte Carlo simulation of the histogram distributions of likely outcomes for particular financial programs on a fixed time horizon."

Assumes you have already read `roles/COMMON.md`.

## What an ensemble run produces

For a given financial program (an instrument, a portfolio allocation, a hedge strategy) and a fixed time horizon (one day, one week, one month), the forecaster runs N independent simulations (default N=10,000) with stochastic inputs sampled from the empirical distribution of the underlying price feed, the volatility surface, and any program-specific noise sources (gas-cost variance, slippage, oracle drift).

The output is:

- A histogram of terminal portfolio values at the horizon (or terminal P&L, depending on the program).
- A set of quantile statistics (5th, 25th, 50th, 75th, 95th percentile).
- A path-dependent statistic set (max drawdown distribution, time-to-recovery distribution).
- A visual projection rendered deterministically given the same input seed.

## Skills

- [monte-carlo-ensemble](../../skills/monte-carlo-ensemble/SKILL.md): the simulation machinery. Parameter shapes, output histogram format, seeding discipline.
- [histogram-projection-render](../../skills/histogram-projection-render/SKILL.md): the visual output. Deterministic given the same input seed.
- [journal-sync](../../skills/journal-sync/SKILL.md): write the result.

## Inputs

The forecaster's dispatch prompt names:

1. **Program.** What we are forecasting (an instrument's terminal price, a portfolio allocation's terminal value, a hedge strategy's terminal P&L).
2. **Time horizon.** A duration (e.g. `1d`, `7d`, `30d`).
3. **Ensemble size.** N independent simulations. Default 10,000; the maintainer can request more for higher-confidence quantile estimates at the tails.
4. **Seed.** A deterministic seed. Same program + horizon + ensemble size + seed produces identical output.
5. **Input distributions.** Pointers to the price-feed history and volatility-surface artifacts the simulation samples from.

## Output

A `result` journal entry with `kind: forecast`, containing:

- `program`, `horizon`, `ensemble_size`, `seed`: inputs verbatim.
- `histogram_path`: the JSON artifact (under `journal/forecasts/<YYYY>/<MM>/<DD>/<short-id>.json`).
- `projection_path`: the SVG / PNG (alongside the histogram).
- `quantiles`: the 5/25/50/75/95 summary.
- `max_drawdown_p50` and `max_drawdown_p95`: path statistics.

## Operating norms

- **Determinism over speed.** Reproducibility is the contract. Same inputs + same seed produce identical histogram. If the simulation calls a random source other than the seeded one, that is a bug.
- **Quantile stability.** Tail quantiles (1st, 99th) are noisy at N=10,000. Reports name a confidence band on each quantile (typically computed by bootstrap on the ensemble). Do not claim more precision than the ensemble supports.
- **Cite input distributions.** Every forecast names the price-feed and volatility artifacts it sampled from. The planner cites these forwards through its proposal; the audit trail is end-to-end.
- **Long-running dispatches are expected.** A 10,000-simulation ensemble on a non-trivial program takes minutes. The orchestrator's prompt should set expectations; the forecaster journals a `tick` entry partway through if the run is long.

## Definition of done

- A `result` entry with `kind: forecast` is committed and pushed.
- The histogram JSON and the projection SVG / PNG artifacts are committed.
- The final line is `Self-improvement: <one-liner>`.
