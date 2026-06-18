---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: ymax-planner-protocol

How the planner produces proposals. Borrowed in shape from Agoric's [ymax-planner](https://github.com/Agoric/agoric-sdk/tree/master/services/ymax-planner) service and the [portfolio-contract](https://github.com/Agoric/agoric-sdk/tree/master/packages/portfolio-contract) package. The ymax design partitions concerns cleanly between (a) an off-chain planner that watches balance events, computes rebalance plans, and submits them; and (b) on-chain contracts that hold the wallet, expose offer-handlers, and enforce per-portfolio invariants. finbot adopts the same partition and adapts the planner to operate without (initially) any on-chain contract counterparty: the planner emits proposals, the auditor verifies them, the executor signs and submits.

## Purpose

Define the proposal shape, the rebalance-step solver, the citation requirements, and the deterministic-hash composition.

## Source citations

Files in agoric-sdk that shape this skill:

- `services/ymax-planner/src/engine.ts`: the main planner loop. Subscribes to block events, queries balances, and per-portfolio computes rebalance plans.
- `services/ymax-planner/src/plan-deposit.ts`: `planDepositToAllocations`, `planRebalanceToAllocations`, `planWithdrawFromAllocations`. These are the entry points to the rebalance-step solver.
- `packages/portfolio-contract/tools/plan-solve.ts`: `planRebalanceFlow`, `NoSolutionError`. The solver itself.
- `packages/portfolio-api/src/target-balances.ts`: `computeTargetBalances`, `TargetBalanceError`. The target-balance helper shared between the off-chain planner and the on-chain contract.
- `packages/portfolio-api/src/network/network-spec.js`: `NetworkSpec`. The network-wide configuration the planner consumes.
- `packages/portfolio-contract/src/type-guards.ts`: `PortfolioStatusShapeExt`, `flowIdFromKey`, etc. Type-guards that the planner uses to validate vstorage reads.

The ymax planner runs as a long-lived service (`services/ymax-planner/src/main.ts` plus `engine.ts`); finbot's planner is dispatched per-rebalance and emits a proposal. The compute is the same shape; the lifecycle is different.

## Proposal shape

```yaml
proposal_hash: <hex>            # content hash of the body below; the auditor verifies
proposal_version: 1
generated_at: <ISO>
generated_by: <dispatch-id>
inputs:
  current_balances:
    <instrument-id>: <amount>   # repeat per instrument
  target_allocation:
    <instrument-id>: <fraction> # sums to 1.0 (within rounding)
  risk_bounds:
    per_step_max_pct_nav: <number>
    per_day_max_pct_nav: <number>
    per_instrument_concentration_cap_pct: <number>
  cited_forecasts:
    - <journal-entry-path>
  cited_analyses:
    - <journal-entry-path>
steps:
  - id: 1
    source: <instrument-id>
    destination: <instrument-id>
    amount: <signed-int-minor-units>     # positive = move out of source into destination
    estimated_gas: <amount-or-null>
    expected_slippage_pct: <number>
    justifies_with:
      - <citation-ref-within-cited_forecasts>
      - <citation-ref-within-cited_analyses>
  # ... more steps
expected_post_state:
  <instrument-id>: <amount>     # what current_balances becomes if all steps complete
```

## Hash composition

The `proposal_hash` is `sha256(canonical-json(body without proposal_hash))`. Canonical-json means sorted keys, no whitespace, deterministic number representation (use signed integers in minor units, never floats). The auditor recomputes the hash and rejects on mismatch.

## Solver

The rebalance solver (mirrored from `plan-solve.ts`) takes:

- A source set: instruments that currently hold more than their target allocation.
- A destination set: instruments that currently hold less than their target allocation.
- A cost model: per-edge gas + slippage.

It produces a minimum-cost flow of source -> destination edges that brings each instrument's balance to within a configured tolerance of its target. `NoSolutionError` (also mirrored) names when a feasible flow does not exist within the risk bounds; the planner then emits a `message` to liaison naming the breach rather than a partial plan.

The solver is deterministic given identical inputs. Two planner dispatches with identical inputs produce identical `proposal_hash`.

## Computing target balances

The shared `computeTargetBalances` helper (`packages/portfolio-api/src/target-balances.ts`) is the function:

```js
const changedTargets = computeTargetBalances({
  brand,                  // the asset brand (e.g. USDC)
  currentBalances,        // map of instrument-id -> amount
  balanceDelta,           // recent deposit / withdrawal delta
  targetAllocation,       // the configured target fractions
  network,                // NetworkSpec (chain config)
  depositFromChain,       // where new funds entered, for routing
});
```

`changedTargets` contains only the balances that need to change. Use signed minor-unit deltas: positive for deposits, negative for withdrawals, `0n` for rebalances.

finbot's planner consumes this helper directly (`import { computeTargetBalances } from '@agoric/portfolio-api/src/target-balances.js'`) when targeting an Agoric portfolio, and reimplements equivalent semantics for any other-chain portfolio.

## Citation requirements

Every step must carry `justifies_with` pointing to at least one entry in `cited_forecasts` and at least one entry in `cited_analyses`. The auditor rejects steps that cite nothing.

The forecasts cited must be fresh (within a configured staleness window; default 24h) and must be on the instruments the step touches (a step that moves USDC into Aave cannot cite a forecast on Compound).

## Notes

This skill body is a stub; the actual planner implementation needs the solver code, the canonical-JSON serializer, the hash composition, and the network-spec loader. The shape above is the contract the auditor and executor depend on; the implementation lands incrementally.
