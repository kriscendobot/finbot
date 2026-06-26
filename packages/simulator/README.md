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
  uniformity (KS), and point error. `evaluateForecast` fits a model to a
  training window, runs the forecaster, and compares its predicted
  distribution to fresh realizations of the true process; `evalTableOverPresets`
  rolls that across the presets. Pass `forecaster: 'harmonic'` (default `'gbm'`)
  to score the cyclical-structure-aware model below;
  `compareForecastersOverPresets` pairs the two into a before/after table.
- `harmonic.js` is the cyclical-structure-aware forecaster — a seasonal
  decomposition plus a residual GBM. `fitHarmonicModel` recovers a log-linear
  trend and a small set of harmonics (frequency/amplitude/phase) from a
  training window, detecting frequencies on the *differenced* (whitened) log
  series so a pure random walk selects none and the model degrades cleanly to
  a fitted GBM. `HarmonicPriceFeed` (in `price-feed.js`) replays the
  decomposition under the unchanged fork-based `forecast()` shape: every fork
  shares the deterministic seasonal trajectory but walks an independent
  residual, so the ensemble's center tracks the cycle while its spread
  reflects only the residual volatility.
- `instruments.js` models three return shapes over a price series — `growth`
  (appreciation only), `yield` (periodic accrual), `dividend` (discrete
  payouts) — that a strategy can `mixReturns`, each drivable from a synthetic
  fixture or a user-supplied/speculated series.
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
headline reading: on a GBM process with adequate history the GBM forecaster
is well calibrated (90% interval covers ~90% of realized outcomes, PIT near
uniform); on a cyclic oracle it is not (a random walk cannot capture
mean-reverting cyclical structure, so its intervals over- or mis-cover). The
**harmonic** forecaster (`harmonic.js`) closes that gap: at horizon 32 over
the presets it cuts cyclic CRPS by ~30-60x (e.g. `cyclic-wild` 11.0 -> 0.17)
and slashes point error, fixes `cyclic-drifting` coverage (0.0 -> ~1.0),
improves synthesis PIT-KS (`synthesis-turbulent` 0.25 -> 0.09), and — because
GBM data selects zero harmonics — leaves the GBM presets unchanged. The
before/after table prints as the "Forecaster comparison" section of
`finbot-eval`. The
risk/reward sweep shows a diversified growth+yield mix dominating either
instrument alone across most volatility-tolerance appetites; richer
instrument models are the parked `finbot-additional-instruments` slice.

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
