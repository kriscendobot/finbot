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

## Notes from the field (2026-06-26, v1 SES landing)

The `finbot-ses-compartments` follow-on landed real SES compartments and a real `@endo/exo` wallet Far in `packages/pipeline/cap-attenuation.js`. The `ambient` column is no longer documentary — it is the enforced globals policy.

- **Lockdown.** Importing `cap-attenuation.js` calls `lockdown()` once for the process (guarded on `Object.isFrozen(Object.prototype)`, idempotent across peer importers). `@endo/exo`/`@endo/patterns` are imported *after* lockdown via top-level `await import(…)` because they bind the SES-provided `harden` and lockdown refuses to run if a foreign `harden` was installed first. The whole existing suite (72 pipeline tests + the other packages) stays green under lockdown with `overrideTaming: 'severe'`.
- **Real compartments.** `buildRolePolicy(role)` turns the `ambient` string into the exact set of host globals the role may name (`console`, `fetch`, a *seeded* `random` for the forecaster's `rng`, the `full`/`bounded` orchestrator surfaces). `makeRoleCompartment` / `evaluateInRoleCompartment` run role code in a `new Compartment({ globals })` whose `globalThis` is that policy plus its attenuated vended caps — nothing else. Ambient authority is the empty set: `test/cap-compartment.test.js` proves a forecaster compartment cannot name `process`/`require`/`fetch`, cannot reach them through `Function("…")()` (the constructor binds the compartment global, not the host realm), has `Math.random` denied (ungoverned nondeterminism), and that direct `eval` is censored outright (`SES_EVAL_REJECTED`). The granted ambients (`console`, seeded `random`, and `fetch` for the oracle-watcher) *are* reachable.
- **Real wallet Far.** `makeWalletCapability` now builds an `@endo/exo` Far behind a dynamically-constructed `InterfaceGuard` over exactly the whitelisted methods (`passStyleOf(exo) === 'remotable'`; off-interface methods do not exist on the Far). Because errors thrown across an Exo membrane are flattened to generic passed errors, the **revoke gate is a revocable forwarder in front of the Exo** (the classic caretaker pattern) — `revoke()` makes the vended `cap` throw `CapabilityError`, keeping the fail-closed contract the v0.5 tests asserted. The forwarder, not the raw Exo, is what gets vended; revocation is a lifecycle concern orthogonal to the guard.
- **Process boundary (CapTP).** `signing-worker.js` ships the § Process boundary machinery: the worker side (`makeSigningWorkerBootstrap`) holds the backing signer and offers the wallet Exo as a CapTP bootstrap, and `connectSigningWorkerInProcess` wires an executor end to a worker end so the executor operates the wallet *purely as a remote `E(wallet)` presence* — it never holds the backing signer. `test/signing-worker.test.js` proves the remote call path, the InterfaceGuard rejecting an off-interface call across the boundary, and teardown revoking the worker-side wallet. The cross-process transport itself (Unix socket vs. a `MessageChannel` child; persistent vs. spawn-fresh) is still an § Open question, so `spawnSigningWorker` is a **gated stub**: it refuses unless `live_authorized: true` *and* a keystore handle are supplied, and even then throws rather than commit to an unchosen transport. Dry-run never reaches any of this.
- **Deviation from the brief.** The build called for `@endo/compartment-mapper`. That package loads an on-disk *module graph* into compartments from a declared policy; finbot's roles are in-memory functions, not archived module trees, so the faithful realization is `buildRolePolicy` → `new Compartment({ globals })` directly. `compartment-mapper` is therefore **not** a dependency (it was added then removed once unused); adopting it belongs with the harness's `compartmentAttenuator` hook when role code is actually loaded from `roles/<role>/` archives. `ses`, `@endo/exo`, `@endo/pass-style`, `@endo/patterns`, `@endo/eventual-send`, and `@endo/captp` are the live deps in `packages/pipeline/package.json`.

Status: SES compartments and a real Far+InterfaceGuard wallet in force; ambient-authority denial tested; live executor still gated (dry-run only, no real wallet/key/funds wired). The first live (paper-wallet test-net) run chooses the CapTP transport and replaces the `spawnSigningWorker` stub.
