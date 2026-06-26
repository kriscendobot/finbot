---
created: 2026-06-17
updated: 2026-06-17
author: architect
status: stub
---

# Design: capability attenuation

How finbot adopts the Endo compartment + Far-ref pattern to attenuate subagent capability. The safety story for "subagents with different contexts and capabilities" per the maintainer's framing.

## Problem

Standard agent-orchestration systems give every dispatched subagent the same ambient authority the orchestrator has: full filesystem, full network, full process control. This is fine when subagents only read public state and write journal entries; it is catastrophic when one subagent (the executor) holds a wallet capability that signs real transactions.

The maintainer's framing: "This will require some research into Agoric's ymax project ... unlike this garden, it will borrow ideas from the Endo agent harnesses as well, to safely run subagents with different contexts and capabilities, blending inference, automation, automatic inference, automation born from inference."

The Endo family (CapTP, Exo, Compartments, SES) is built around exactly this problem: how to give an untrusted program only the capabilities it needs, in a form that lets the host validate every cross-program call at the boundary.

## Shape

Two complementary surfaces, both governed by skills:

1. **Compartment sandbox** (`skills/compartment-sandbox`): each subagent's code runs in an [SES Compartment](https://github.com/endojs/endo/tree/master/packages/ses) with explicit `globals` and `modules` maps. Ambient authority is the empty set; named authority is what the role file declares.
2. **Far / Exo vending** (`skills/far-exo-vending`): the orchestrator builds an `Exo` wrapping each capability the subordinate needs, vends the Exo into the compartment, and drops the outside reference when the subagent returns. The `InterfaceGuard` on the Exo validates every method call at the boundary.

## Capability map (bootstrap)

| Role            | Ambient                     | Vended Far refs                            |
| --------------- | --------------------------- | ------------------------------------------ |
| `liaison`       | full (orchestrator surface) | none (the orchestrator builds Fars)        |
| `steward`       | bounded (no live executor)  | none (same)                                |
| `oracle-watcher`| pinned `fetch`, `console`   | none                                       |
| `monitor`       | `console`                   | `rpc-read` (read-only chain queries)       |
| `forecaster`    | `console`, seeded RNG       | none                                       |
| `analyzer`      | `console`                   | `forecaster-results`, `monitor-results`    |
| `planner`       | `console`                   | `analyzer-results`, `forecasts`, `rpc-read`|
| `auditor`       | `console`                   | `rpc-read`, `planner-result`               |
| `executor`      | `console`                   | (dry-run) none; (live) `wallet`, `signing-rpc` |
| `journalist`    | `console`                   | `journal-read`                             |

The **wallet** Far exists only in the executor's compartment, only in `--live` mode, only for the duration of the dispatch. No other role ever sees it. The executor's parent context drops it on dispatch return; the compartment is discarded; the wallet reference becomes unreachable. The next live executor dispatch builds a fresh wallet Far from the keystore again.

## Process boundary

For the executor's `--live` mode the compartment runs in a separate worker process and communicates via CapTP over a Unix socket. The Endo daemon's pattern is the model. The OS process boundary adds defense in depth: a JS-level escape of the compartment is contained to the worker process; a worker process compromise does not give an attacker the orchestrator's authority.

Other roles run in in-process compartments (fewer ceremony; the threat model is less severe for read-only roles).

## Why this matters specifically for finbot

The parent garden has no analogous capability boundary. Every subagent the parent garden dispatches has full filesystem access, full network access, full process control; the discipline is that subagents do not abuse this. The parent garden's threat model is "the LLM might make a mistake"; the boundary is the dispatch prompt itself (telling the subagent what to do and not to do) and the per-dispatch worktree triple (so the mistake's blast radius is bounded to one worktree).

finbot's threat model is more demanding because the action is irreversible. The dispatch prompt can tell the executor "do not sign anything you would not want to be permanent", but a buggy executor that ignores the prompt has already signed by the time the orchestrator notices. The compartment + Far-vending pattern moves the safety from "the LLM correctly follows the prompt" to "the runtime cannot reach the wallet unless the orchestrator has explicitly vended it". The buggy executor that tries to sign an unauthorized transaction trips the InterfaceGuard or the missing-capability error, not the chain.

## Open questions

- **CapTP transport choice.** Unix socket (the Endo daemon's default) or TCP-bound-to-localhost? Unix socket is simpler; TCP allows the worker to live in a separate container. Bootstrap state defers.
- **Persistent vs. ephemeral worker.** Does the executor's worker process persist across dispatches (faster, but harder to reason about state hygiene) or is it spawned fresh each dispatch (slower; trivial state hygiene)? Spawn-fresh is the safer default for the wallet boundary; persistence is an optimization.
- **Auditor-as-Far for the executor.** Should the executor's compartment receive an `audit-verdict` Far that the executor calls before each live step? Today the executor consumes the audit verdict as a journal-entry path; vending a Far is a tighter coupling that the maintainer should decide on.

## Implementation pointers

- `skills/compartment-sandbox/SKILL.md`: the compartment-build procedure with role-specific policies.
- `skills/far-exo-vending/SKILL.md`: the Exo + InterfaceGuard vending pattern with citations to `@endo/exo`, `@endo/pass-style`, `@endo/patterns`, `@endo/eventual-send`, `@endo/captp`.
- `roles/executor/AGENT.md`: the executor's modes and the wallet-Far lifecycle.

## Notes from the field (2026-06-26)

The first end-to-end dry-run OODA cycle landed `packages/pipeline/cap-attenuation.js`, the **in-process v0.5 attenuator** that enforces the *boundary* this design specifies without yet pulling in SES/@endo:

- `CAPABILITY_MAP` is the table above, in code. `attenuateForRole(role, parentCaps, { live })` returns only the cap names a role may see; `wallet` and `signing-rpc` are in `LIVE_ONLY_CAPS` and are dropped unless `live === true`. The executor is the only role whose `vended` set contains `wallet`, so no other role can name it even in a live run.
- `makeWalletCapability(backing, methods)` is the plain-JS stand-in for an `@endo/exo` Far ref behind an InterfaceGuard: only whitelisted methods are callable, and `revoke()` makes every method throw (fail-closed) so a reference retained past the dispatch is inert.
- `runInAttenuatedCompartment({ role, parentCaps, live, walletRevoke, fn })` runs `fn` with the attenuated set and revokes the vended wallet in a `finally`, the in-process analog of "the compartment is discarded; the wallet reference becomes unreachable".
- The executor (`packages/pipeline/executor.js`) asserts, in dry-run, that `caps.wallet === undefined`, and carries `walletTouched: false` as the proof; `bin/finbot-ooda` exits non-zero if a dry-run cycle ever reports `walletTouched: true`.

What remains for v1 (a posted `finbot-ses-compartments` follow-on): replace the in-process attenuator with `@endo/compartment-mapper` so the *globals/modules* surface is sandboxed too (today `ambient` in the map is documentary), and move the live executor's signing call into a separate worker process over CapTP per § Process boundary.

Status: boundary enforced in-process; SES upgrade pending. The first live (paper-wallet test-net) run builds the worker-process + real-Far machinery and updates this section.
