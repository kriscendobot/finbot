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

## Notes from the field (2026-06-26 — richer-forecasting build)

The first richer build chose concrete implementations for the open axes. All
live in `@finbot/simulator`; the pipeline `forecaster.project()` consumes them.

- **Correlation handling.** Implemented. `packages/simulator/correlation.js` factors
  a correlation matrix via Cholesky (`L · Lᵀ = R`); `GBMPriceFeed` draws one
  standard-normal shock per asset per tick and runs the shock vector through `L`
  when a `correlations` spec is supplied. The draw count per tick is unchanged, so
  an uncorrelated feed stays byte-for-byte identical to the prior independent walk
  — the determinism contract is preserved across the upgrade. Spec accepts a sparse
  pair map (`{ "ATOM:OSMO": 0.6 }`), a nested map, or a full matrix; a
  non-positive-definite (inconsistent) request throws.
- **Volatility surface.** Implemented as *empirical bootstrap of realized vol*
  (`packages/simulator/vol-surface.js`). `surfaceFromPriceHistory()` derives a
  rolling-window realized-vol sample set per asset from a price history;
  `VolatilitySurface.sample()` draws a sigma per tick from a *separate* seeded RNG
  stream so the price-shock schedule is undisturbed. This widens the terminal
  distribution's tails toward what the record actually showed without assuming a
  distributional family. GARCH / implied surfaces remain open for a later cut.
- **Execution-cost noise.** `packages/simulator/costs.js` adds size-aware slippage
  (`slippageFill`) and jittered per-trade gas (`gasCost`), both seeded.
- **Bootstrap confidence bands.** `packages/simulator/bootstrap.js` resamples the
  ensemble B times under a seeded RNG and reports `{point, lo, hi, stderr}` per
  quantile. `forecast()` bands the tails (p01/p05/p50/p95/p99) by default — the
  report can now name how much to trust the noisy tails.
- **Path statistics.** `packages/simulator/path-stats.js` computes max-drawdown and
  time-to-recovery per trajectory; `forecast()` aggregates them into the
  `pathStats` distributions (drawdown quantiles + histogram, recovery-time
  distribution over recovered paths, and the recovery rate).
- **Renderer.** Chose **plain SVG via a deterministic builder**
  (`packages/simulator/histogram-svg.js`) — no DOM, no dependency, byte-diffable,
  embeds in markdown. `report` style draws the terminal-equity histogram with the
  p05–p95 / p25–p75 quantile bands shaded and the p50 line, plus a max-drawdown
  panel; `compact` is the single-panel form. Same forecast result → byte-identical
  SVG; the renderer never reads system time or `Math.random`. PNG rasterization
  remains the deferred fallback.
- **Output shape.** `forecaster.writeForecastArtifacts()` honors the role brief's
  `histogram_path` + `projection_path`: it writes `<id>.json` (the canonical
  artifact) and `<id>.svg` under a forecasts directory, where `<id>` is a SHA-256
  over the canonical artifact JSON — so the auditor can recompute the id and
  confirm a cited projection. The fs surface is injected, never hard-imported.

Status: implemented (richer build). Open axes still deferred: GARCH/implied vol
surfaces, PNG rasterization, far-ref vending of large forecasts to the analyzer.
