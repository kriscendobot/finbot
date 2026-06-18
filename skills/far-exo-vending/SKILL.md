---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: far-exo-vending

How a role vends [Far](https://github.com/endojs/endo/tree/master/packages/pass-style) / [Exo](https://github.com/endojs/endo/tree/master/packages/exo) references to a subordinate subagent's compartment, defining the capability boundary. Sibling to `skills/compartment-sandbox`; this skill is the vending shape, that skill is the compartment shape.

## Purpose

Give a subordinate compartment a typed, guarded reference to a capability the orchestrator holds (a wallet, an RPC client, a journal writer), without giving the compartment ambient access to the underlying state. The reference is a single `Far` object protected by an `InterfaceGuard` (an `Exo`); every method the compartment can call on it is validated by the guard before the method body runs.

## Source citations

- [`endojs/endo` packages/exo/README.md](https://github.com/endojs/endo/tree/master/packages/exo): `makeExo`, `defineExoClass`, `defineExoClassKit`. The three patterns; `makeExo` is the right one for one-off vending.
- [`endojs/endo` packages/pass-style/README.md](https://github.com/endojs/endo/tree/master/packages/pass-style): `Far` and the marshal rules. A `Far` is the basic remotable; an `Exo` is a `Far` plus a guard.
- [`endojs/endo` packages/patterns/README.md](https://github.com/endojs/endo/tree/master/packages/patterns): `M` (the matcher library) used to compose `InterfaceGuard`s.
- [`endojs/endo` packages/eventual-send/README.md](https://github.com/endojs/endo/tree/master/packages/eventual-send): `E` and `HandledPromise`, used to send messages across the compartment boundary.
- [`endojs/endo` packages/captp/README.md](https://github.com/endojs/endo/tree/master/packages/captp): the wire protocol when the vended Far crosses a process boundary.

## When to use

Every role that needs a capability it did not declare in its ambient `modules` / `globals` (per `compartment-sandbox`) receives the capability as a vended Far. The orchestrator builds the Far on the outside, vends it in, and drops the outside reference when the subagent returns.

## Vending procedure

```js
import { Far } from '@endo/pass-style';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

// Outside the compartment: define the interface.
const WalletI = M.interface('Wallet', {
  sign: M.call(M.string()).returns(M.string()),                   // sign(tx) -> signature
  getAddress: M.call().returns(M.string()),
  // ... only the methods the role's role file says it needs.
});

// Build the Exo around the real wallet.
const wallet = await loadWallet(keystorePath, signingRpc);
const guardedWallet = makeExo('Wallet', WalletI, {
  sign(txHex) { return wallet.signTransaction(txHex); },
  getAddress() { return wallet.address; },
});

// Vend into the compartment.
compartment.evaluate('bootstrap(wallet)', { wallet: guardedWallet });

// After the compartment returns:
//   - drop the outside reference (let GC reclaim it, or null it explicitly).
//   - the compartment's reference becomes unreachable when its compartment is discarded.
```

The guard rejects calls with wrong argument types before the method body runs. A call like `wallet.sign(123)` (where the guard expects a string) raises a TypeError at the boundary, not inside `signTransaction`.

## Why guards matter for finbot

Without the guard, a buggy subagent that constructs the wrong transaction type still gets the wallet to sign it. With the guard, the wallet only signs hex strings of a particular shape; anything else is rejected at the boundary. This is a defense-in-depth complement to the auditor: the auditor checks the planner's proposal *content*; the guard checks every method call's *shape*.

## Vending discipline

- **Vend only what the role's role file declares.** A role that does not name "wallet" in its Inputs section never receives a wallet Far. The dispatching orchestrator reads the role file and refuses to vend extra capabilities.
- **Vend Exos, not bare Fars.** A bare `Far` has no input validation. Every cross-compartment ref in finbot is an `Exo`.
- **Drop the outside ref when the subagent returns.** The compartment is discarded; the outside ref is the only remaining holder. Drop it so GC reclaims; do not stash it for "next time".
- **Process-boundary refs use CapTP.** When the vending crosses a process boundary (the executor's separate worker), use `makeCapTP` from `@endo/captp`. The Exo on the outside, the Far reference on the inside, the wire protocol in between.

## Promise pipelining

When the vended ref's method returns a promise, the compartment can call further methods on the promise without waiting:

```js
const sigP = E(wallet).sign(txHex);              // returns a HandledPromise
const submitP = E(rpc).submit(sigP);              // pipelines the sig into the submit call
const receiptP = await submitP;                   // single await at the end
```

This matters for the executor's transaction-submission path: the wallet signs, the RPC submits, the receipt arrives, all without per-call await round-trips across the process boundary. Per `@endo/eventual-send`.

## Notes

The bootstrap state has no actual vending machinery. The contract above is the shape; the first dispatch that needs a vended Far builds the pattern around the role's specific powers.
