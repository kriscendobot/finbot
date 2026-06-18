---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: compartment-sandbox

How a subagent runs in an attenuated [SES Compartment](https://github.com/endojs/endo/tree/master/packages/ses) with only the globals and modules its role requires. Borrowed from the Endo family: SES (Secure ECMAScript) lockdown + Compartments + the compartment-mapper's load-time policy.

The finbot subagents that this skill governs are not just text-prompt LLM dispatches; they are *also* JavaScript subprocesses (or compartments-in-process) that execute role-specific code. The LLM-text side of a dispatch reads the role file and reasons about the task; the code side runs in a compartment whose ambient authority is attenuated to the role's stated powers.

## Purpose

Run a role's code in a Compartment that:

- Has had SES `lockdown` applied (frozen primordials; no `eval` of untrusted code; tamed `Date`, `Math.random`, error stack capture).
- Has been given an explicit `globals` map (no ambient `process`, `fs`, network access except as named).
- Has been given an explicit `modules` map (only the imports the role declares as needed).
- Receives `Far` / `Exo` references for any cross-compartment capability the role consumes (see `skills/far-exo-vending/SKILL.md`).

## Source citations

- [`endojs/endo` packages/ses/README.md](https://github.com/endojs/endo/tree/master/packages/ses): the lockdown contract.
- [`endojs/endo` packages/compartment-mapper/README.md](https://github.com/endojs/endo/tree/master/packages/compartment-mapper): the compartment-load discipline.
- [`endojs/endo` packages/exo/README.md](https://github.com/endojs/endo/tree/master/packages/exo): the InterfaceGuard pattern for cross-compartment object boundaries.
- [`endojs/endo` packages/captp/README.md](https://github.com/endojs/endo/tree/master/packages/captp): the capability-transfer protocol used when the compartment runs in a separate process / worker.
- [`endojs/endo` packages/daemon/README.md](https://github.com/endojs/endo/tree/master/packages/daemon): the prototype harness for a daemon that vends Far refs to guest programs in hardened JS workers. The daemon's bootstrap-and-derive-facets pattern is the model for finbot's executor compartment setup.

## When to use

Every role whose dispatch executes code (the executor at minimum; the planner and the auditor when they reach the point of running solver code rather than just orchestrating subagents) runs in a compartment shaped by this skill.

In the bootstrap state, this skill is *aspirational*: finbot does not yet ship a compartment-mapper-configured runner. The first dispatch that needs a sandbox builds one against this contract.

## Compartment shape

```js
import 'ses';
lockdown({
  // strict mode mitigations; see ses/README.md for the full set.
  errorTaming: 'safe',
  consoleTaming: 'safe',
  dateTaming: 'safe',
  mathTaming: 'safe',
});

import { importLocation } from '@endo/compartment-mapper';

const { namespace } = await importLocation(
  read,
  roleEntryUrl,
  {
    globals: rolePolicy.globals,    // e.g. { console } for analyzer; nothing for sealed roles
    modules: rolePolicy.modules,    // e.g. { 'sha256': sha256Module } for the planner
  },
);

// Vend role-specific Far refs into the namespace, per skills/far-exo-vending.
namespace.bootstrap(vendedFarRefs);
```

## Role-specific policies

Each role declares its policy in its `AGENT.md` (the *Skills* and *Inputs* sections name the powers it needs); the dispatching orchestrator applies the policy when constructing the compartment. The initial set:

| Role            | globals                           | modules                                | Far refs vended                           |
| --------------- | --------------------------------- | -------------------------------------- | ----------------------------------------- |
| `oracle-watcher`| `console`, `fetch` (pinned hosts) | `crypto/hash`                          | none                                      |
| `monitor`       | `console`                         | `crypto/hash`                          | rpc-read `Far` (read-only chain queries)  |
| `forecaster`    | `console`, seeded `Math.random`   | `monte-carlo-lib`                      | none                                      |
| `analyzer`      | `console`                         | `correlation`, `sharpe`                | forecaster-results `Far` (read-only)      |
| `planner`       | `console`                         | `solver`, `target-balances`            | analyzer-results, forecast `Far`s         |
| `auditor`       | `console`                         | `invariant-checks`, `freshness`        | rpc-read `Far`, planner-result `Far`     |
| `executor`      | `console`                         | `tx-builder`, `signer`                 | **wallet** `Far` (live only), signing-rpc `Far` (live only) |
| `journalist`    | `console`                         | `markdown-render`                      | journal-read `Far`                        |

The wallet `Far` exists only in the executor's compartment, only in `--live` mode, only for the duration of the dispatch.

## InterfaceGuards

Every `Far` ref vended into a compartment is also an `Exo` with an `InterfaceGuard` (per `skills/far-exo-vending`). The guard validates every method argument and return value at the boundary; a misuse from the compartment surfaces as a guard violation, not as a downstream error halfway through the logic.

## Process boundary

For roles that need stronger isolation than in-process compartments (the executor with the live wallet), the compartment runs in a separate worker process and communicates via CapTP over a pipe / Unix socket. The Endo daemon's pattern is the model. Same role policies apply; the additional boundary is the OS process boundary.

## Notes

The bootstrap state of finbot has no compartment-mapper-configured runner. The first dispatch that needs the sandbox builds one; the contract above is the shape. Until then, the discipline is informal: subagents read their role files, do not improvise around the powers they were not granted, and surface any "I needed X but did not have it" finding in their `result` entry's self-improvement line.
