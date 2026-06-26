# @finbot/pipeline

The OODA role pipeline: each role from the `roles/<role>/AGENT.md` briefs,
implemented as a **deterministic function over the simulator world**, plus the
capability-attenuation layer that confines the wallet to the executor, plus the
`runOodaCycle` orchestrator that wires the whole **dry-run** cycle.

```
observe   oracle-watcher  observeOpportunities()  -> opportunity-deviation events
orient    analyzer        analyze()               -> risk-adjusted scores + candidate target
          forecaster      project()               -> Monte Carlo terminal-equity distribution
decide    planner         plan()                  -> bounded, hashed, cited rebalance proposal
act       auditor         audit()                 -> invariant verdict (the gate)
          executor        execute()               -> DRY-RUN simulation on a portfolio clone
```

The role `AGENT.md` files describe the LLM-dispatch form of each role; this
package is the computation those dispatches drive, and the form the harness runs
in-process for a dry-run cycle with **no LLM required**.

## Modules

| Module               | Role / concern                                                            |
| -------------------- | ------------------------------------------------------------------------- |
| `oracle-watcher.js`  | detect price deviations past a basis-point threshold over a reading window |
| `analyzer.js`        | risk-adjusted scoring (price edge + APR carry, less a correlated-cluster penalty); single- or multi-leg target allocation; no-action is valid |
| `forecaster.js`      | Monte Carlo via the simulator's nested-fork `forecast()`; deterministic    |
| `planner.js`         | ymax-shaped proposal: hashed steps + forecast/analysis citations           |
| `auditor.js`         | the invariant set (citation, risk-bound, tail-risk, reproducibility, freshness) |
| `executor.js`        | dry-run simulation on a clone; refuses live without authorization          |
| `rebalance.js`       | ymax-shaped `computeTargetBalances` + `deriveSteps` solver                  |
| `cap-attenuation.js` | the wallet boundary: capability map, interface-guarded revocable wallet     |
| `ooda-cycle.js`      | `runOodaCycle` — wires the six roles + optional journal recording          |

## Multi-instrument portfolios

The cycle runs end to end over a target allocation across several instruments,
including yield/APR-bearing legs that accrue over ticks:

- A world's `instruments` registry (`asset -> @finbot/simulator/yield-accrual`
  descriptor) and its price feed's `correlations` flow into `analyze()`. The
  analyzer weighs each candidate's **APR carry against its price risk** and
  subtracts a **correlated-cluster penalty** so adding to an already-correlated
  position is discounted.
- With `analyzer.maxPositions > 1`, the analyzer emits a multi-leg target
  allocation (bounded by `maxTotalWeight` / `maxTargetWeight`), folding in
  registry yield legs that did not themselves deviate. The `rebalance.js`
  solver, planner, forecaster, auditor, and executor are already multi-asset,
  so the allocation flows through unchanged. The default `maxPositions: 1`
  keeps the legacy single-risk-asset behaviour byte-for-byte.
- The forecaster's forked futures carry the same registry, so a yield leg's
  accrual compounds inside the Monte Carlo projection, not only in the live
  walk.

## Safety

Dry-run only. The wallet capability is vended **only** to the executor and
**only** in `live` mode (`cap-attenuation.js`); the dry-run executor asserts the
wallet is absent from its attenuated capability set and reports
`walletTouched: false`. No keystore is read, no key is loaded, no funds move.
See `designs/cap-attenuation.md` for the boundary and its planned SES upgrade.

## Run

```
node ../../bin/finbot-ooda --seed=7   # one cycle, printed report
node --test test/*.test.js            # the package's tests
```
