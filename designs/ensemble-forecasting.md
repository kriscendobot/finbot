---
created: 2026-06-17
updated: 2026-06-17
author: architect
status: stub
---

# Design: ensemble forecasting

How the forecaster runs Monte Carlo ensemble simulations and renders histogram projections.

## Problem

The maintainer's directive: "Ensemble Forecasting, automation that we will need to grow that is capable of both executing and producing compelling visual projections through iterative Monte Carlo simulation of the histogram distributions of likely outcomes for particular financial programs on a fixed time horizon."

The forecaster is the orient phase of finbot's OODA loop. Its output (histogram + path statistics) feeds the analyzer (which scores opportunities against the distributions) and the planner (which bounds risk against the tails).

## Shape

A forecaster dispatch takes:

- A *program*: a function from (chain state, time, stochastic inputs) to (chain state, P&L). Programs range from "hold a fixed USDC balance and accrue interest" to "rebalance every block according to this strategy".
- A *time horizon*: a duration over which to simulate.
- An *ensemble size*: N independent trajectories.
- A *seed*: for reproducibility.
- *Input distributions*: parameterized stochastic sources (price feed model, volatility surface, gas cost distribution, slippage distribution).

It produces:

- A *histogram*: terminal value distribution.
- *Path statistics*: max drawdown distribution, time-to-recovery distribution.
- *Quantile summary*: p05 / p25 / p50 / p75 / p95.
- *Bootstrap confidence bands* on the quantile estimates.
- A *visual projection*: SVG / PNG rendered deterministically.

## Determinism contract

Same program + horizon + ensemble + seed + input_distributions_hash -> identical bytes. This matters because the auditor verifies the planner's cited forecast by recomputing the hash; without byte determinism the audit chain breaks.

## Stochastic-process choices

Open. Three obvious axes:

- **Price feed model.** Geometric Brownian Motion (the textbook default), mean-reverting (Ornstein-Uhlenbeck), empirical bootstrap (resample from historical returns). The empirical bootstrap has the advantage of not assuming a distributional family but the disadvantage of being limited by the historical window.
- **Volatility surface.** Constant, time-varying (GARCH-like), implied (from options market data). For instruments where options markets are not deep, this is empirical bootstrap of realized volatility.
- **Correlation handling.** Per-instrument independent simulation is wrong; correlated sampling via a Cholesky factorization of the historical correlation matrix is the standard fix.

The bootstrap state of finbot does not commit to any of these; the first forecaster engagement chooses and the choice goes here as a Notes from the field.

## Rendering choices

Open. Three obvious choices:

- **Plain SVG via a deterministic builder.** No DOM dependency; output is byte-deterministic; embeds in markdown directly. Good for the journalist's digests.
- **Matplotlib in deterministic mode.** Python dependency; well-understood; backend-pinned. Good for rich multi-panel projections.
- **D3 in headless mode.** JavaScript; works with the rest of finbot's stack; renders to SVG.

The choice should be deferred until a concrete visual style is settled; the contract is "deterministic given inputs", the implementation can swap.

## Long-running dispatches

A 10,000-simulation ensemble on a non-trivial program takes minutes. The orchestrator's prompt should set expectations. The forecaster journals a `tick` entry partway through if the run is long (say, every 1000 simulations, with progress percent and elapsed time). The journalist consolidates the ticks into a single narrative entry for the maintainer.

## Open questions

- What is the right N for routine forecasts vs. high-confidence pre-rebalance forecasts? N=10,000 is the default; tail risk at p01 / p99 is noisy there.
- How does the forecaster handle programs whose horizon exceeds the historical window? (A 30-day forecast of a 3-month-old instrument has thin data.) Probably name the data scarcity in the result and let the planner downweight.
- Does the forecaster vend its output as a Far ref to the analyzer (per `skills/far-exo-vending`) or as a journal-entry path the analyzer reads? The latter is simpler at bootstrap; the former is the right shape if forecasts get large enough that we want to lazy-load.

## Implementation pointers

- The ensemble runner lives in `skills/monte-carlo-ensemble`; the renderer lives in `skills/histogram-projection-render`. Both are stubs.
- The forecaster role file names the inputs and outputs; the implementation lands when the first concrete program is chosen for forecasting.

Status: stub. The first forecaster engagement chooses a concrete program, a concrete stochastic-process implementation, and a concrete renderer.
