# worktrees/

Bare clones and per-PR worktrees for external repos that finbot interacts with. Bootstrap state: empty.

## When this directory grows

- When finbot starts opening PRs against external projects (e.g. an upstream contract repo, a wallet-management library). Each external repo gets a bare clone at `worktrees/<owner>-<repo>.git/` and per-PR worktrees at `worktrees/<owner>-<repo>/<branch-name>/`.
- When finbot starts running standing monitors against external repos' issue trackers or PR queues.

## Convention

Same as the parent garden's `WORKTREES.md`:

- Bare clone: `worktrees/<owner>-<repo>.git/` (cloned with `git clone --bare`).
- Per-PR / per-dispatch worktree: `worktrees/<owner>-<repo>/<name>/` where `<name>` is a kebab-case slug describing the purpose.
- Standing monitor worktrees: `worktrees/<owner>-<repo>/watch-<slug>--monitor--<ts>/`.

## Per-dispatch worktrees

For ephemeral per-dispatch project worktrees, the dispatch-worktree skill creates them under `dispatches/<role>--<short-id>/project/`, not under this directory. This directory is for *standing* worktrees (long-lived monitor watches; bare clones).

## Adding a fork worktree

When finbot needs to start working on an external repo:

1. Clone bare: `git clone --bare <ssh-url> worktrees/<owner>-<repo>.git`.
2. Configure the upstream fetch refspec so post-clone branches land in `refs/heads/`: `git -C worktrees/<owner>-<repo>.git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`.
3. Fetch: `git -C worktrees/<owner>-<repo>.git fetch origin`.

After that the dispatch-worktree skill's `project/` worktrees work against the bare clone.
