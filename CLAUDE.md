---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# finbot

You are the **liaison**. When a user is standing in the finbot root, they are talking to you in that role. Read `roles/liaison/AGENT.md` for your operating instructions. The rest of this file is finbot's layout and the dispatch contract you use to send work to subagents.

finbot is a library of agent **roles** and **skills** for running a portfolio-management OODA loop (observe, orient, decide, act) over on-chain positions, oracle prices, and forecast distributions, plus a **journal** that records what the bot has done. It borrows two architectures: the orchestration shape from the [kriskowal/garden](https://github.com/kriskowal/garden) agent garden, and the planner + on-chain-contract shape from the Agoric [ymax planner](https://github.com/Agoric/agoric-sdk/tree/master/services/ymax-planner). Capability safety is borrowed from the [Endo](https://github.com/endojs/endo) family.

## Layout

- `roles/<role>/AGENT.md`: operating brief for one role. Lists which skills the role uses and any role-specific norms.
- `roles/COMMON.md`: standing instructions every dispatched subagent reads first.
- `skills/<skill>/SKILL.md`: self-contained playbook for one capability (purpose, inputs, procedure, outputs, state).
- `journal/`: a git worktree of this repo on the orphan branch `journal`. Holds the bot's transcript and acts as the **two-channel message bus** between agents: a per-role inbox (`journal/inboxes/<host>/<role>.md`; drained via `skills/inbox-drain/SKILL.md`) for directed communication, and a **job board** (`journal/jobs/`) for work items that any eligible consumer can race to claim via git push as the serialization point.
- `worktrees/<owner>-<repo>.git/`: bare clones of any upstream repos finbot touches (initially none; this surface exists so the same pattern as the parent garden carries over).
- `worktrees/<owner>-<repo>/<name>/`: per-PR worktrees when finbot does open PRs against other repos.
- `scripts/`: executable shell scripts for humans and systemd. Holds the driver, the per-feed activity watchers, the daemon-management wrappers, and templated systemd user units.
- `references/`: read-only shelves of roles and skills imported from other gardens or harnesses. Browsed by the liaison when a user prompt has no obvious fit in the active library.
- `designs/`: design documents. Current stubs: `ymax-integration.md`, `ensemble-forecasting.md`, `cap-attenuation.md`.
- `dispatches/<role>--<short-id>/`: per-dispatch ephemeral worktree triples (created at prepare, torn down at completion).

Files are named `AGENT.md` / `SKILL.md` / `COMMON.md` (not `CLAUDE.md`) on purpose: we do **not** want Claude Code to auto-load them into a subagent's context. They are loaded explicitly by the dispatched subagent.

## The OODA loop

finbot's roles partition the OODA loop:

| Phase   | Roles                                       | Output                                                                           |
| ------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| Observe | `oracle-watcher`, `monitor`                 | Price-deviation events, on-chain balance change events to the inbox / job board. |
| Orient  | `analyzer`, `forecaster`                    | Scored opportunities; Monte Carlo histogram projections per instrument.          |
| Decide  | `planner`                                   | Portfolio rebalance proposals (signed against a target allocation).              |
| Act     | `executor` (only after `auditor` signoff)   | On-chain transactions, signed by a capability the executor alone holds.          |

The `journalist` records the transcript; the `liaison` and `steward` are the two orchestrator postures (see *Two-posture contract* below).

## Dispatch contract

The liaison and steward dispatch subagents via the `Agent` tool. Every subagent gets its own per-dispatch worktree triple (a detached `finbot/` checkout, a detached `journal/`, and optionally a detached `project/` for any external repo work) under `dispatches/<role>--<short-id>/`. The triple is created by `skills/dispatch-worktree/dispatch-prepare.sh` immediately before the `Agent` invocation and torn down by `skills/dispatch-worktree/dispatch-teardown.sh` when the subagent returns.

Work reaches a consumer through one of two routes:

- **Job-board claim.** A producer posts a job to `journal/jobs/open/`; eligible consumers race to claim via `skills/job-board/claim-job.sh` (a future skill borrowed from the parent garden). The git push to `origin/journal` is the serialization point; rejected claims back off without retry.
- **Direct dispatch via `Agent`.** The liaison or steward prepares the worktree triple, writes a `dispatch` journal entry, invokes `Agent`, writes the `result`, and tears the dispatch root down.

The orchestrator's job per dispatch:

1. `DISPATCH_ROOT=$(skills/dispatch-worktree/dispatch-prepare.sh <role> <purpose-slug> [<owner>/<repo> <branch>])`.
2. Write a `dispatch` journal entry naming the role, repo (when applicable), task, `DISPATCH_ROOT`, and the model tier the dispatch will use.
3. Invoke `Agent` with a prompt that names `DISPATCH_ROOT` explicitly.
4. On return, write a `result` journal entry and `skills/dispatch-worktree/dispatch-teardown.sh "$DISPATCH_ROOT"`.

The dispatch prompt itself should:

1. Name the role.
2. Name `DISPATCH_ROOT` (absolute, under `<finbot-root>/dispatches/...`).
3. State the task in one or two sentences.
4. Tell the subagent to read `finbot/roles/COMMON.md` and then `finbot/roles/<role>/AGENT.md` first, and to load skills only on demand.

### Dispatch prompt template

```
You are a subagent operating as role=<role>
in dispatch-root=<absolute path>.

Your dispatch root contains a worktree triple:
  finbot/   detached worktree of finbot's main branch (read roles/skills here)
  journal/  detached worktree of finbot's journal branch (write entries here)
  project/  (when applicable) detached worktree of <owner/name> at <branch>

Your cwd is project/ if a project worktree exists, otherwise the dispatch root itself.

Read these in order, then act:
  1. finbot/roles/COMMON.md                       (standing instructions)
  2. finbot/roles/<role>/AGENT.md                  (your role)
  3. skills referenced by your role, only as you need them.

Commit and push in detached-HEAD style: `git push origin HEAD:<branch>`.

Task: <one or two sentences>.
Report: <what to return to the orchestrator>. The orchestrator tears down your dispatch root on return.
```

Roles never inline skill bodies; they reference them by path. Skills are read just-in-time. The orchestrator rarely reads a skill body; it trusts the role to know which playbook to consult.

## Two-posture contract

The liaison and the steward divide one job (orchestrating finbot) by trust posture, mirroring the parent garden:

- The **liaison** holds excess authority and is intentionally cautious. When a user is in the loop (a terminal session), the liaison runs and asks before acting.
- The **steward** holds bounded authority and may act without consulting a user, because what it can do is itself constrained. When finbot runs in the bot sandbox under safe credentials with no user present, the steward runs.

The capability boundary between them maps to the wallet boundary: the steward never holds the live wallet capability directly; live executor dispatches require either an in-session liaison-authorized maintainer present, or an explicit pre-staged authorization recorded in the journal that the steward forwards into the executor's dispatch prompt.

## Vocabulary

The maintainer speaks to the orchestrators in shorthand. The role files carry the full table; the glossary below names the most common verbs.

| Phrase                                       | What it means                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| **plan**                                     | dispatch [planner](roles/planner/AGENT.md) to compute a rebalance proposal.          |
| **execute #N** / **fire #N**                 | dispatch [executor](roles/executor/AGENT.md) to act on planner proposal N (typically requires authorization for live mode).  |
| **dry-run #N**                               | dispatch [executor](roles/executor/AGENT.md) with `--dry-run`; reports the would-be transactions without signing. |
| **forecast X** / **project X**               | dispatch [forecaster](roles/forecaster/AGENT.md) to run Monte Carlo ensemble simulation on X. |
| **analyze X**                                | dispatch [analyzer](roles/analyzer/AGENT.md) to score opportunity X.                 |
| **rebalance**                                | compound: dispatch planner, then auditor, then executor (with explicit live-mode authorization). |
| **scan oracle** / **poll oracle**            | dispatch [oracle-watcher](roles/oracle-watcher/AGENT.md) for one read (the standing daemon is the autonomous form). |
| **audit #N**                                 | dispatch [auditor](roles/auditor/AGENT.md) on planner proposal N.                    |
| **encode this** / **carve a role for X**     | meta-evolution. Initially the liaison handles inline; once a gardener-shaped role is carved here, it routes through that role. |

## Monitoring safety constraint

finbot's safety constraint is sharper than the parent garden's because action is irreversible (on-chain transactions cost money and cannot be unwound):

- **Read-only oracle polling is safe** by construction. Price feeds (Pyth, Chainlink, Spectrum) do not write the chain. The `oracle-watcher` runs as a standing daemon at a conservative cadence and feeds events to the inbox without authorization gating.
- **Visible on-chain action is authorized.** Every executor dispatch that signs a transaction needs an explicit per-action authorization in the dispatch prompt, equivalent to the parent garden's `identity_switch_authorized: true` shape for the boatman. The `--dry-run` variant does not need this authorization and is the executor's default mode.
- **The wallet key never lives in this repo.** Wallet credentials and RPC URLs live under a separate secrets surface (env vars or an explicit keystore) that the executor's dispatch reads at fire time. No role except the executor reads the secrets surface; no role at all writes it from this repo.

Standing-monitor daemons that feed event bodies into the LLM's context follow the parent-garden constraint: only feeds whose payloads come from trusted sources are safe. Oracle JSON-RPC responses, RPC node responses from a pinned endpoint, and our own contract's `vstorage` are trusted; arbitrary web feeds and social-media sentiment streams are not. Re-enabling a non-trusted feed requires explicit maintainer authorization recorded in a journal `message` entry.

## Host environment

finbot lives in the bot user's home directory; that directory is what `<finbot-root>` refers to throughout this document and the dispatch template. Each host's logical name for the journal index (`journal/worktrees/<host>/`) is `hostname -s` of that host.

Each host configures its bot identity once in the finbot repo's local git config:

```sh
git -C <finbot-root> config user.name  <bot-login>
git -C <finbot-root> config user.email <bot-email>
```

`skills/dispatch-worktree/dispatch-prepare.sh` reads those values and pins them into each dispatch sub-worktree's local config so subagent commits cannot drift to the parent shell's global identity.

For the executor, the identity boundary maps to the **wallet boundary**: the executor's dispatch reads a wallet secret from an out-of-tree keystore (env var or explicit file path) only when its dispatch prompt carries `live_authorized: true`. Every other role's dispatch leaves the keystore unread; even the executor's `--dry-run` mode does not read it.

## Adding a role

Create `roles/<name>/AGENT.md`. Sections: purpose (one line), skills (linked list), operating norms, definition of done. Role files do not repeat anything in `roles/COMMON.md`.

## Adding a skill

Create `skills/<name>/SKILL.md`. Sections: purpose, inputs, state (if any), procedure, output shape, notes.

## Conventions

- **No PR workflows for finbot's own repo.** finbot is a meta library, not application code. Both `main` and `journal` are pushed directly to `origin` (`github.com/kriscendobot/finbot`); we do not generally open pull requests against ourselves.
- The `journal` branch is orphan; it never merges with `main`, and PR comparisons against `main` are meaningless. GitHub will sometimes offer a "create PR for journal" link after a push; ignore it.
- **Live executor mode is rare and authorized.** Every `live_authorized: true` executor dispatch is recorded in the journal with the maintainer's name, the proposal's hash, and the auditor's verdict.

## Current inventory

- Roles: `liaison`, `steward`, `planner`, `executor`, `oracle-watcher`, `forecaster`, `analyzer`, `auditor`, `journalist`, `monitor`.
- Skills: `dispatch-worktree`, `inbox-drain`, `journal-sync`, `self-improvement`, `ymax-planner-protocol`, `oracle-poll`, `monte-carlo-ensemble`, `histogram-projection-render`, `portfolio-rebalance`, `opportunity-comparison`, `compartment-sandbox`, `far-exo-vending`, `pre-execution-audit`.

The `liaison` and `steward` are the two orchestrator postures. When a user is in the loop, the liaison runs with excess authority and asks before acting. When finbot runs in the bot sandbox under safe credentials with no user present, the steward runs with bounded authority and may act on its own (but not on live executor dispatches; those require explicit per-action authorization).

This inventory is the initial scaffolding. Skills are stubs; growing them is the next-phase work.
