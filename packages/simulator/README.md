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
