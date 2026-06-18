---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: portfolio-rebalance

The canonical funds-flow step semantics. A rebalance step moves a specified amount of a source instrument into a destination instrument; this skill defines what that means precisely, what gas / slippage it costs, and how to simulate it in `--dry-run` vs. execute it in `--live`.

Used by both the [planner](../../roles/planner/AGENT.md) (which composes steps into a proposal) and the [executor](../../roles/executor/AGENT.md) (which fires them).

## Purpose

Define a single canonical step's:

- Semantics (what `(source, destination, amount)` means).
- Preconditions (what must hold for the step to succeed).
- Postconditions (what the step changes about the chain state and the balance snapshot).
- Cost model (gas + slippage estimate).
- Live execution call (the transaction the executor sends).
- Dry-run simulation (the function the planner and the executor in `--dry-run` apply to the in-memory balance snapshot).

## Step shape

```yaml
id: 1
source:                   # an instrument identifier
  chain: agoric | noble | ethereum | base | ...
  protocol: usdn | aave | compound | ...
  asset: USDC
destination:              # same shape as source
amount:                   # signed integer in minor units
  brand: USDC
  value: 1000000000       # 1000 USDC at 6 decimals
preconditions:
  - source.balance >= amount
  - destination.protocol.deposit_enabled == true
  # ... others depending on the protocol pair
gas_estimate:
  chain: ethereum
  gas_units: 250000
  gas_price_gwei: 30
expected_slippage_pct: 0.05
```

## Atomic step vs. multi-step chain

A logical rebalance often requires multiple atomic steps: withdraw from a yield protocol on chain A, bridge to chain B, deposit into a yield protocol on chain B. Each atomic step is a separate `id`; the chain proceeds only as far as the steps succeed. A failure on step `id=3` of a 5-step chain leaves the portfolio in a partial state; the planner's next dispatch reads the new balance and emits a fresh proposal that picks up from there.

This is intentional. Atomic on-chain transactions are the trust boundary; "all-or-nothing" semantics across chains would require an off-chain orchestrator with cross-chain rollback authority, which finbot does not have and would not want.

## Cost model

Per-step cost is `gas_estimate * gas_price + (amount * expected_slippage_pct)`. The planner uses the cost when ranking alternative step orderings; the executor reports the realized cost in its `result` entry.

Estimates are inputs (the planner reads them from a per-protocol cost-estimator), not derived. They can be stale; the executor re-estimates at fire time and aborts if the realized estimate exceeds the planner's by more than a configured margin.

## Dry-run simulation

For each step in order:

```pseudo
function simulate(state, step):
  assert all step.preconditions hold in state.
  state.balances[step.source] -= step.amount
  state.balances[step.destination] += (step.amount * (1 - step.expected_slippage_pct))
  state.gas_spent[step.gas_estimate.chain] += step.gas_estimate.gas_units * step.gas_estimate.gas_price_gwei
  return state
```

The simulation is purely functional. Same input state + same step list -> same output state.

## Live execution call

For each step in order:

```pseudo
function execute(wallet, signing_rpc, step):
  tx = construct_transaction(step)
  signed_tx = wallet.sign(tx)               # only the executor's compartment holds wallet
  receipt = signing_rpc.submit_and_wait(signed_tx)
  assert receipt.status == success
  return { tx_hash: receipt.tx_hash, gas_used: receipt.gas_used }
```

The `wallet` and `signing_rpc` references are `Far`s vended into the executor's compartment per `skills/far-exo-vending/SKILL.md`; they cannot escape the compartment. The executor's parent context cannot re-call them after the compartment returns.

## Per-protocol adapters

The construct-transaction step varies per (source, destination) pair. Each adapter lives in a sibling file (`portfolio-rebalance/adapters/<chain>-<protocol>.md` for the spec; the code adapters land alongside when implementations arrive). Adapters known to be needed at bootstrap:

- `agoric-usdn`: deposit / withdraw USDC into / out of Noble USDN.
- `agoric-aave-via-axelar`: bridge USDC to an EVM chain via Axelar GMP; deposit into Aave.
- `agoric-compound-via-axelar`: same shape, Compound.
- Cosmos -> EVM and back.

None of these are implemented yet. The shape above is the contract; adapter implementations land as separate dispatches.

## Notes

This skill is the gateway between the planner's abstract steps and the executor's concrete transactions. The shape is borrowed from the ymax `plan-deposit.ts` / `plan-solve.ts` / portfolio-contract sequence; the adapters are finbot-specific because the protocol set is the maintainer's portfolio (not ymax's).
