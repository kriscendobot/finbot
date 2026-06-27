---
created: 2026-06-17
updated: 2026-06-27
author: architect, gardener
status: stub
---

# Design: ymax integration

How finbot's planner consumes Agoric's ymax-shaped artifacts.

## Problem

The maintainer's directive: "This will require some research into Agoric's ymax project, which consists of a planner and on blockchain contracts and price oracles. We need a machine that can periodically execute changes to a portfolio's balance and analyze opportunities with other instruments."

ymax is exactly that machine, already built, in production on Agoric. The integration question is: does finbot's planner *use* ymax as its execution backbone (with finbot adding the forecaster + analyzer + auditor layer on top), or does it *mimic* ymax's shape against a different on-chain substrate (or against a paper portfolio)?

## Research findings

Located in agoric-sdk:

- **`services/ymax-planner/`** is an off-chain service. Subscribes to Agoric block events via Cosmos RPC, queries vstorage for portfolio state, computes rebalance plans via the shared solver, and submits `rebalanceTx` calls back to the portfolio-manager contract. Key files: `src/main.ts`, `src/engine.ts`, `src/plan-deposit.ts`, `src/pending-tx-manager.ts`.
- **`packages/portfolio-contract/`** is the on-chain contract. Holds per-portfolio state in vstorage; exposes offer-handlers for portfolio open / rebalance / withdraw; manages cross-chain accounts (Agoric Local Accounts, Noble ICAs); integrates with USDN, Aave (via Axelar GMP), Compound (via Axelar GMP). Files: `src/portfolio.contract.js`, `src/planner.exo.ts`, `src/type-guards.ts`, `tools/plan-solve.ts`.
- **`packages/portfolio-api/`** is the shared API package. The off-chain planner and the on-chain contract both consume it. Key exports: `computeTargetBalances` (the target-balance helper), `PROD_NETWORK` (the network spec), `places.ts` (place / asset identifiers), `evm-wallet/eip712-messages.js` (EIP-712 message handling for EVM-side actions).

The architecture is clean: the planner sees published events, the planner emits a plan, the contract executes the plan, the contract publishes new state, the planner sees the new event. This is the OODA loop on Agoric.

## Three integration paths

### Path A: Use ymax as the on-chain substrate

finbot's planner becomes a *second* off-chain planner that emits proposals against the same portfolio-contract instance Agoric runs. The planner submits via the same `rebalanceTx` call. The forecaster + analyzer + auditor layer is finbot's addition.

Pros: leverages existing on-chain infrastructure; the executor's job becomes "submit a rebalanceTx whose body is the planner's steps".

Cons: ties finbot to Agoric. The maintainer's framing suggests broader applicability ("other instruments") may not all live on Agoric.

### Path B: Mimic ymax's shape against a paper portfolio

finbot reuses the `computeTargetBalances` helper and the solver, but the "execution" is in-memory simulation. No on-chain transactions. The executor in `--dry-run` mode is the only mode.

Pros: safe; immediate development feedback; the forecaster + analyzer + auditor layer can be exercised end-to-end without risk.

Cons: not actually doing the maintainer's stated job (executing changes to a portfolio's balance).

### Path C: Mimic ymax's shape against a non-Agoric substrate

finbot's planner targets a portfolio on a different chain (Ethereum, Base, Solana). It uses ymax's *protocol* (the solver, the helper, the plan shape) but not ymax's *implementation* (the contract, the orchestrator).

Pros: most general; works for any portfolio the maintainer holds.

Cons: most work; the executor's per-protocol adapters are now finbot's problem rather than Agoric's.

## Recommendation (tentative)

Phase 1 (bootstrap, now): Path B. Build the planner + forecaster + analyzer + auditor + executor in `--dry-run` mode against an in-memory paper portfolio. Validate the OODA loop end-to-end on simulated data.

Phase 2: Path A for any portfolio that does live on Agoric (the on-chain substrate is there; we are not building a duplicate). Path C for any portfolio that does not.

## Open questions

- Which packages does finbot adopt directly vs. reimplement? `computeTargetBalances` is small and clearly reusable; `plan-solve.ts` is small and reusable; the contract itself is Agoric-specific.
- Does finbot run on Node or in an Agoric vat? The ymax planner is a Node service; running in a vat would give us native CapTP across the boundary to the contract but would tie us harder to Agoric's lifecycle.
- How does finbot's executor authenticate to the on-chain contract? ymax's planner uses a signing smart wallet (`makeSigningSmartWalletKit`); the same primitive applies.

## Implementation pointers

- The planner's solver is mirrored from `packages/portfolio-contract/tools/plan-solve.ts`.
- The target-balance helper is imported from `@agoric/portfolio-api` directly.
- The auditor's invariant set extends (does not replace) the on-chain contract's invariants. The contract checks what it can on-chain; the auditor checks what the contract cannot (forecast tail-risk, citation completeness, freshness).

## Notes from the field (2026-06-26)

Phase 1 (Path B) is implemented. `packages/pipeline/rebalance.js` mirrors the ymax *protocol* — `computeTargetBalances(nav, targetWeights)` (weight·NAV per asset) and `deriveSteps(...)` (the target-balance → funds-flow-step solver) — without importing `@agoric/portfolio-api` (the public shape is small and clearly reusable; we borrow the protocol, not the implementation). The planner (`packages/pipeline/planner.js`) emits a proposal with a content `proposal_hash`, ordered steps, and forecast/analysis citations; the auditor's invariant set (`packages/pipeline/auditor.js`) *extends* rather than replaces what an on-chain contract would check (it adds forecast tail-risk, citation completeness, reproducibility, and pricing freshness). The executor dry-runs the steps against a paper portfolio; no on-chain transaction is built.

Where internal ymax detail would refine a step (the place identifier for Aave/Compound/USDN, Axelar GMP routing, the pending-tx handle), each step carries a `route: 'sim:single-venue'` marker — flagged, not fabricated, so Path A/C work can fill it from the real `portfolio-contract` shape later.

Open for Phase 2 (posted as `finbot-substrate-adapters`): adopt `computeTargetBalances` / `plan-solve` directly vs. keep the mirror; the executor's per-substrate signing adapters (Agoric smart wallet for Path A, EVM/Solana for Path C).

Status: Path B landed against the simulator. Phase 2 substrate work is decomposed into follow-on jobs.

## Notes from the field (2026-06-27)

Phase 2 substrate adapters landed behind the live gate (`finbot-substrate-adapters` job). `packages/pipeline/substrates.js` is the per-substrate layer that fills the step `route` with a real place identifier and builds the would-be transaction:

- **Path A (Agoric):** `SUBSTRATES.agoric` resolves each step to a public portfolio-contract pool place (`USDN`, `Aave_Arbitrum`, `Compound_Optimism`, ...) with its chain, protocol, and transport (`axelar-gmp` for the EVM pools, `ica-noble` for USDN). `buildTransaction` emits a `rebalanceTx`-shaped continuing-offer (`invitationMakerName: 'Rebalance'`) whose flows move quote value between the Agoric-local cash place and each pool place. The live path (`signAndSubmit`) submits through a smart-wallet capability (`makeSigningSmartWalletKit` shape: `sign` then `submit`), which `cap-attenuation.js` vends only to a `--live`-authorized executor.
- **Path C (EVM):** `SUBSTRATES.evm` resolves to `evm:<chain>:<protocol>` (e.g. `evm:Base:Aave-v3`) and builds an approve+supply / withdraw call batch.
- **Path C (Solana):** `SUBSTRATES.solana` resolves to `solana:<cluster>:<program>` and builds an instruction batch.

The planner takes `substrate` + `venueMap` (asset -> place) and stamps each step's route via a resolver; the default substrate stays `sim` so the paper-portfolio dry-run is unchanged (route remains `'sim:single-venue'`). The auditor's invariant #6 became a real `place-route-reachability` check: a step whose route is still unmapped or names an unknown venue fails the gate; a route that only awaits deploy-config detail is reachable.

**Adopt vs. mirror decision (Path A open question):** kept the mirror. `computeTargetBalances` and the solver stay reimplemented in `rebalance.js`; the substrate layer borrows only the *place/route vocabulary and the offer shape* from the public portfolio-contract, not the package. Importing `@agoric/portfolio-api` would pull the Agoric dependency tree into a substrate-agnostic pipeline for two small, stable functions. Revisit if/when finbot runs inside an Agoric vat.

**Provenance discipline.** Every place identifier, transport, and offer field is drawn from the PUBLIC portfolio-contract / portfolio-api / `agoric-to-axelar-local` design surface. Concrete deploy/runtime values that live only in the internal ymax-web / deployment config are carried per-route in `needs_internal_detail` (the continuing-offer id, pool contract addresses, Axelar GMP channel ids, Solana program ids, brand-scaled amounts), flagged rather than fabricated, so a later live-enable job fills them from the real config. No adapter constructs a real signer, RPC client, or key; live signing stays gated behind explicit per-job maintainer authorization.

Proven by `packages/pipeline/test/substrates.test.js`: real routes on all three substrates, the rebalanceTx / call-batch / instruction-batch builders, the dry-run executor building the tx while the wallet stays untouched (the fake signer is never called), the live-without-authorization refusal, and `signAndSubmit` failing closed without a wallet capability.
