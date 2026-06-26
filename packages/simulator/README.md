# @finbot/simulator

Self-improvement simulator for the finbot harness.

The simulator wraps the cut-2 harness primitives (`@finbot/harness`) with a
deterministic in-memory world (portfolio + price feed) so the OODA loop can
run continuously, the planner can spawn nested simulations to forecast
proposed actions, and an outside observer can measure efficacy through
streamed metrics.

## Pieces

- `world.js` builds a `World` shape (portfolio + price feed + harness config
  + seeded RNG).
- `portfolio.js` is a simulated portfolio (balances, trade history, P&L).
- `price-feed.js` is a deterministic price generator: geometric Brownian
  motion seeded by a small PRNG (`sfc32`), or replay from a CSV fixture.
- `runner.js` exposes `runSimulator(world)` returning `{ tick, observe,
  fork }`. The same primitive runs the outer simulation and any nested
  inner simulation a planner asks for; that is the meta-circularity.
- `metrics.js` computes efficacy metrics (P&L, drawdown, Sharpe).
- `forecast.js` runs a Monte Carlo ensemble forecast over `fork()`-spawned
  futures and returns a histogram + summary stats.
- `self-improvement.js` reflects on recent observations + metrics and
  proposes one or more small bounded rule/skill changes as a journal
  entry.
- `fixtures.js` generates seeded synthetic-oracle price series with known
  parameters: `cyclicSeries` (sinusoid: frequency/amplitude/phase/drift),
  `gbmSeries` (geometric Brownian motion: drift `mu`, volatility `sigma`),
  `synthesisSeries` (superposed cycles of differing period+amplitude atop a
  GBM trend), and `blockBootstrapSeries` (resample a user-supplied historical
  or speculated series). Named presets live in `test/fixtures/presets.js`.
- `forecast-eval.js` scores the ensemble forecaster against the *known*
  generating process: CRPS, pinball loss, interval coverage / hit-rate, PIT
  uniformity (KS), and point error. `evaluateForecast` fits a GBM to a
  training window, runs the forecaster, and compares its predicted
  distribution to fresh realizations of the true process; `evalTableOverPresets`
  rolls that across the presets.
- `instruments.js` models three return shapes over a price series — `growth`
  (appreciation only), `yield` (periodic accrual), `dividend` (discrete
  payouts) — that a strategy can `mixReturns`, each drivable from a synthetic
  fixture or a user-supplied/speculated series. Each shape carries realistic
  dynamics:
  - **yield**: a constant rate, a yield curve / short-rate path (an array
    sampled by tick), a stochastic short-rate (a seeded function), or a
    DeFi utilization-driven APY (`kinkedUtilizationApy`, the Aave/Compound
    two-slope model); simple or `compounding`; paid into cash or reinvested
    into the position (`reinvest: 'position'`, DRIP).
  - **dividend**: dividend growth and cuts (`dividendGrowth`, or an explicit
    per-payout schedule), irregular payout schedules (`payoutTicks` /
    `scheduleAt`), payout-ratio dividends over an earnings series
    (`payoutRatio` + `earningsPerUnit`), and an ex-dividend price adjustment
    (`exDividendDrop`) that marks the price down at the payout instant —
    `exDividendAdjustedSeries` materializes that drop onto the oracle series.
  - **all shapes**: per-payout and per-reinvest **fees** (`fees`) and **taxes**
    (`tax.income` on payouts, `tax.capGains` on the realized terminal gain),
    so returns are reported gross and net. `instrumentReturns` is a pure
    stateful walk over `stepInstrument`, the single per-tick source of truth.
- `instrument-mix.js` (`rebalanceMix`) is a target-allocation rebalancer over
  a mix of instruments: it periodically trades legs back toward a target
  weight vector, charging slippage, gas, and per-trade fees (`costs.js`),
  while leg payouts flow into a shared cash account it redeploys. It mirrors
  the protocol shape of `@finbot/pipeline`'s `rebalance.js` over an
  instrument mix, and shares `stepInstrument` with the single-leg path so a
  leg behaves identically alone or in the mix.
- `history.js` ingests **real** user-supplied price history: `parsePriceSeriesCsv`
  (single-asset, accepting one-price-per-line / `t,price` / a named column),
  `seriesFromFrames` (extract an asset from `parseCsvFrames` output),
  `validateSeries`, and the read-only file loaders `loadPriceSeries` /
  `loadPriceFrames`. An ingested series drives an instrument directly or seeds
  a `blockBootstrapSeries` ensemble for the risk/reward sweep.
- `risk-reward.js` represents a user **volatility tolerance** (`tau` in
  [0,1]) as a mean-variance certainty-equivalent objective, optimizes the
  risk-for-reward balance it implies (`chooseStrategy`), traces the
  trade-off frontier across a tolerance sweep (`toleranceFrontier`), and
  sketches tolerance elicitation (from a stated worst-acceptable drawdown,
  or a single lottery choice).
- `evaluation.js` ties the three together: `runEvaluation` produces the
  forecast-evaluation table plus the risk/reward frontier over the three
  instrument types; `renderEvaluationText` formats them.

## Forecast evaluation

`bin/finbot-eval` runs the evaluation harness end to end:

```
node bin/finbot-eval --horizon=32 --ensemble=300 --realizations=500
```

Because every fixture's generating process is known, the harness measures
whether the ensemble forecaster recovers the distribution it should. The
headline reading: on a GBM process with adequate history the forecaster is
well calibrated (90% interval covers ~90% of realized outcomes, PIT near
uniform); on a cyclic oracle it is not (the GBM forecaster cannot capture
mean-reverting cyclical structure, so its intervals over- or mis-cover) —
which is the gap the parked
[`finbot-richer-forecasting`](../../journal/jobs) plan would close. The
risk/reward sweep shows a diversified growth+yield mix dominating either
instrument alone across most volatility-tolerance appetites. Richer
instrument dynamics (stochastic/utilization yield, dividend growth/cuts,
ex-dividend marking, fees/taxes/reinvestment, and a mix rebalancer) landed
in `instruments.js` / `instrument-mix.js` / `history.js`; see *Pieces* above.

## Volatility-tolerance elicitation

The risk/reward sweep is parameterized by a single volatility tolerance
`tau in [0,1]`. `elicitation.js` calibrates it from a bounded interaction
and `profile-store.js` persists the result for the planner to read.

The strong instrument is an **adaptive lottery ladder**: a short sequence of
50/50 gamble-vs-certain choices that *bisects* the user's mean-variance
risk-aversion `lambda`. Each rung offers a coin flip (`+30%` / `-10%` of a
notional stake) versus a guaranteed return set to the certainty-equivalent of
the current `lambda` bracket's midpoint; "took the gamble" halves the bracket
downward, "took the sure thing" upward. After N rungs the midpoint is `lambda`
to resolution `range / 2^N`, which `toleranceFromRiskAversion` maps to `tau`
with a confidence band from the residual bracket. Payoffs are fractional
returns (not dollars) so the elicited `lambda` lives in the same units as the
risk/reward score, and the offered certain amount stays inside the gamble's own
range at every rung.

Other signals reconcile alongside it: a stated worst-acceptable drawdown
(`inferToleranceFromMaxDrawdown`), a target Sharpe hurdle
(`inferToleranceFromTargetSharpe`), a direct `0..1` slider, or a one-shot
lottery. `reconcileSignals` folds them into one posterior `tau` by
inverse-variance (precision) weighting — agreeing signals tighten the band
below any single one, and a confident signal dominates a vague one.
`makeVolatilityProfile` stamps the posterior, its provenance, and a
re-calibration deadline (`recalibrationStatus` reports when a profile is due,
either by elapsed cadence or by too wide a confidence band).

The planner consumes a persisted profile in `@finbot/pipeline`
(`profile-allocation.js`): `selectAllocationForProfile` reads the profile's
`tau` and lets `chooseStrategy` pick among candidate allocations on the
frontier; `planForProfile` formalizes the choice through the existing
deterministic `plan()`. `bin/finbot-elicit` is the usable terminal flow:

```
node bin/finbot-elicit --user=alice --store=./profiles --steps=8
node bin/finbot-elicit --user=alice --drawdown=0.3 --sharpe=0.5
node bin/finbot-elicit --user=alice --show
node bin/finbot-elicit --user=alice --auto=3.0   # non-interactive (simulated user)
```

`elicitation.js` is pure (no clock, no I/O, no randomness); a truthful
simulated user (`truthfulLadderResponder`) makes the whole ladder testable —
bisecting against a known `lambda` recovers it. The terminal/chat surface
(the liaison interaction) lives in `elicitation-ui.js` as pure render/parse
helpers; the real adapter is a thin loop over `parseLotteryAnswer` and
`runLotteryLadder`'s responder contract.

## CLI

The entry script is `bin/finbot-sim` at the repo root. Run a 100-tick
deterministic simulation with metrics output:

```
node bin/finbot-sim --ticks=100 --seed=42 --out=./sim-metrics.jsonl
```

Add `--self-improve` to run the reflection step at the end of the batch.
Add `--dry-run` to skip writing the self-improvement journal entry.

## Determinism

Everything is seeded. The simulator never reads `Math.random()`; the only
randomness source is the `sfc32` PRNG, seeded from the user-supplied
seed. Two runs with the same seed produce byte-identical metric streams
and byte-identical self-improvement proposals.

## Meta-circularity

`runSimulator(world)` is the single primitive used at every level. An
outer simulator drives the harness against a simulated reality. A planner
can call `fork(seed)` on its world to get a child world (same shape,
fresh RNG), pass that child to `runSimulator`, and drive N futures to
score a proposed action. The forecast layer is the same shape as the
outer driver; the only difference is the seed and the number of ticks.
