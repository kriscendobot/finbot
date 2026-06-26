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
| `analyzer.js`        | risk-adjusted scoring; candidate target weight; no-action is valid         |
| `forecaster.js`      | Monte Carlo via the simulator's nested-fork `forecast()`; deterministic    |
| `planner.js`         | ymax-shaped proposal: hashed steps + forecast/analysis citations           |
| `auditor.js`         | the invariant set (citation, risk-bound, tail-risk, reproducibility, freshness) |
| `executor.js`        | dry-run simulation on a clone; refuses live without authorization          |
| `rebalance.js`       | ymax-shaped `computeTargetBalances` + `deriveSteps` solver                  |
| `cap-attenuation.js` | the wallet boundary: capability map, interface-guarded revocable wallet     |
| `ooda-cycle.js`      | `runOodaCycle` — wires the six roles + optional journal recording          |

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
