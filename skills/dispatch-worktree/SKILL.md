---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: dispatch-worktree

The per-dispatch worktree triple: how to prepare one before invoking `Agent`, how it is torn down on return, and what the contract guarantees. Mirrors the parent garden's identically-named skill; adapted for finbot's wallet-capability boundary.

## When to use

Every `Agent` invocation runs in its own per-dispatch worktree triple. The orchestrator (liaison or steward) runs the prepare script immediately before invoking `Agent` and the teardown script immediately after the subagent returns (or stalls). The subagent never creates or destroys worktrees itself.

Standing monitor and oracle-watcher daemons are the documented exception. They are not per-dispatch entities and are not torn down between dispatches.

## Inputs

For `dispatch-prepare.sh`:

- `<role>`: the dispatching role (`oracle-watcher`, `planner`, `auditor`, `executor`, etc.).
- `<purpose-slug>`: short kebab-case slug describing this specific dispatch.
- `<owner>/<repo> <branch>`: optional; when given, a third sub-worktree `project/` is added at the named branch off the bare clone at `worktrees/<owner>-<repo>.git/`. Rare in finbot's bootstrap state; finbot does not yet open PRs against external repos.

For `dispatch-teardown.sh`:

- `<dispatch-root>`: the absolute path the prepare script printed on stdout.

## Procedure

### Prepare

```sh
DISPATCH_ROOT=$(skills/dispatch-worktree/dispatch-prepare.sh <role> <purpose>)
```

The script creates:

```
dispatches/<role>--<short-id>/
  finbot/    # detached worktree of finbot's main branch
  journal/   # detached worktree of finbot's journal branch
  project/   # (only when applicable) detached worktree of an external repo
```

All three sub-worktrees are detached HEAD. The short-id is six hex chars; the orchestrator reuses it for the matching `dispatch` journal entry's filename so the two cross-reference cleanly.

The directory name omits the purpose slug and the timestamp on purpose (UNIX socket path length limits in deep build trees; this is the parent garden's hard-won lesson). The full purpose / timestamp metadata lives in the matching `dispatch` journal entry.

### Identity pinning

`dispatch-prepare.sh` reads the bot identity from finbot's local config (`<finbot-root>/.git/config`'s `user.name` and `user.email`) and writes it into each sub-worktree's local config before returning. Every commit a subagent makes carries the bot identity by default, regardless of what the orchestrator's shell has set in `~/.gitconfig`.

Each host configures its bot identity once at setup time:

```sh
git -C <finbot-root> config user.name  <bot-login>
git -C <finbot-root> config user.email <bot-email>
```

### Wallet-capability boundary (finbot-specific)

For executor dispatches in `--live` mode, the orchestrator additionally:

1. Reads the wallet keystore path from the dispatch's frontmatter (`keystore_path:`).
2. Reads the signing RPC URL from the dispatch's frontmatter (`signing_rpc:`).
3. Vends these into the executor's compartment per `skills/far-exo-vending/SKILL.md`. The keystore and the RPC URL do not enter any other role's dispatch; they live only in the executor's dispatch root for the duration of the live call.

For `--dry-run` executor dispatches and every other role, neither the keystore nor the live RPC is read; they do not enter the dispatch root.

### Teardown

```sh
skills/dispatch-worktree/dispatch-teardown.sh "$DISPATCH_ROOT"
```

Idempotent. Removes `finbot/`, `journal/`, and (if present) `project/` worktrees via `git worktree remove --force`, then removes the dispatch root directory.

For executor dispatches that ran `--live`, the teardown additionally ensures the wallet `Far` ref has been dropped (the compartment's normal exit drops it; an early exit may leak the reference into the orchestrator's parent context, which is a discipline violation worth surfacing in the dispatch's `result` entry).

## Output

`dispatch-prepare.sh` prints the absolute dispatch root path on stdout. The orchestrator passes that path into the subagent's dispatch prompt.

`dispatch-teardown.sh` is silent on success; reports a one-line note on missing pieces.

## State

The scripts are stateless. State that survives across dispatches lives in the journal (the entries the subagent writes) or in the bare clones. The dispatch root itself holds no durable state.

The wallet keystore lives outside this repo entirely; it is never committed and never enters the dispatch root for any role except the executor in `--live` mode.

## Notes

This skill body is the procedural contract; the executable scripts (`dispatch-prepare.sh`, `dispatch-teardown.sh`) are siblings to this file. The bootstrap state of finbot does not yet ship the executables; the first liaison engagement that needs them adapts the parent garden's scripts (`/home/kris/skills/dispatch-worktree/dispatch-prepare.sh` and sibling) by swapping `garden` for `finbot` in the path resolution and adding the wallet-capability boundary check above.
