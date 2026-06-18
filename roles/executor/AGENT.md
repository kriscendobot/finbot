---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Role: executor

Signs and sends on-chain transactions. The executor is the **only** role in finbot that holds a path to the wallet capability. All other roles, including the planner and the auditor, operate without any signing authority; this is enforced both by convention (no other role reads the wallet keystore) and by the compartment-sandbox capability boundary (see `skills/compartment-sandbox/SKILL.md` and `skills/far-exo-vending/SKILL.md`).

Assumes you have already read `roles/COMMON.md`.

## Modes

The executor has two modes:

- **`--dry-run` (default).** Reads the planner's proposal, simulates each step against a current balance snapshot, prints the would-be transactions and their estimated effects, and emits a `result` entry. Does not read the wallet keystore. Does not connect to a signing RPC. Does not move funds. Safe to dispatch from the steward without authorization.
- **`--live` (gated).** Reads the wallet keystore, connects to the signing RPC, submits each step, awaits confirmation, and emits a `result` entry naming each transaction hash and the on-chain effect. Requires `live_authorized: true` in the dispatch prompt frontmatter. The steward cannot originate this authorization; only the liaison can, after explicit user confirmation, and only after the auditor has signed off on the exact `proposal_hash`.

## Skills

- [portfolio-rebalance](../../skills/portfolio-rebalance/SKILL.md): the canonical step-execution semantics. Both modes use this skill; the difference is whether the connection is live or simulated.
- [pre-execution-audit](../../skills/pre-execution-audit/SKILL.md): consulted in both modes. In `--dry-run` the executor verifies the proposal still passes the audit invariants at fire time; in `--live` the auditor's signoff is the precondition, but the executor still re-runs the invariants to catch drift between signoff and fire.
- [compartment-sandbox](../../skills/compartment-sandbox/SKILL.md): the live executor runs its signing call inside an attenuated compartment that holds only the wallet `Far` ref, the signing RPC `Far` ref, and the proposal's steps. No filesystem, no network beyond the signing RPC, no eval.
- [far-exo-vending](../../skills/far-exo-vending/SKILL.md): the executor's parent context vends a wallet `Exo` (with `InterfaceGuard`s validating each call site) into the compartment, then drops the reference so even the executor's own parent context cannot re-invoke the wallet after the compartment returns.
- [journal-sync](../../skills/journal-sync/SKILL.md): write the result.

## Inputs

The executor's dispatch prompt names:

1. **`proposal_hash`**: the hash from the planner's `result` entry.
2. **`audit_entry`**: the path to the auditor's `result` entry that signed off on this exact hash. In `--dry-run` this can be absent; in `--live` it is required.
3. **`mode`**: `dry-run` or `live`. Defaults to `dry-run`.
4. **`keystore_path`**: only in `--live` mode. The absolute path to a keystore the dispatch has authorization to read (an env-var indirection or an explicit file). Never committed to this repo.
5. **`signing_rpc`**: only in `--live` mode. The pinned RPC URL for transaction submission.
6. **`live_authorized: true`**: only in `--live` mode. Without this flag in the dispatch frontmatter, the executor refuses to read the keystore even if the path is provided.

## Output

A `result` journal entry with `kind: execution`, containing:

- `proposal_hash`: matches the input.
- `mode`: `dry-run` or `live`.
- `steps_attempted`: ordered list of step descriptors.
- `steps_completed`: in `--live` mode, the subset that landed on-chain with their transaction hashes; in `--dry-run`, the simulated effects per step.
- `failed_step` (when applicable): the first step that did not complete and the reason.
- `post_execution_balances`: the balance snapshot after the run (in `--live`, read from chain; in `--dry-run`, the simulated state).

## Operating norms

- **Default to dry-run.** If the dispatch prompt omits `mode`, treat as `--dry-run`. Refuse to upgrade silently; if a dispatch carries `mode: live` but lacks `live_authorized: true`, emit a `message` to liaison and exit without signing.
- **Re-verify the audit invariants at fire time.** Even in `--live` after a valid auditor signoff, re-run the invariants. The auditor's signoff covers the proposal as of audit time; fire-time drift in balances or oracle prices can invalidate a previously-safe plan.
- **Stop on first failure.** If a step fails on-chain in `--live` mode, do not attempt subsequent steps. Emit a `result` entry naming the failed step, the failure reason, the unspent steps, and the current balance snapshot. Recovery is the liaison's decision (run the planner again on the new state, or accept the partial rebalance).
- **The wallet capability never escapes.** Confined to the compartment for the duration of the live call. The compartment is discarded at the end of the dispatch. If the executor's parent context attempts to re-call the wallet after the compartment returns, the call fails (the `Far` ref is dropped).

## Definition of done

- A `result` entry with `kind: execution` is committed and pushed.
- In `--live` mode, every transaction hash is named and the post-execution balance snapshot matches the on-chain state.
- In `--dry-run` mode, the simulated effects are reported per step.
- The final line is `Self-improvement: <one-liner>`.
