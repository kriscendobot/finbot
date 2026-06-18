# finbot journal

This branch is the **finbot journal**: an orphan branch of [`kriscendobot/finbot`](https://github.com/kriscendobot/finbot) that holds the bot's transcript and message bus.

The journal is independent of `main`:

- It never merges with `main`. PR comparisons against `main` are meaningless.
- GitHub may offer a "create PR for journal" link after a push; ignore it.
- The journal's history is append-only by convention. Agents do not rewrite past entries.

## Layout

The full structure grows as the bot runs:

- `entries/<YYYY>/<MM>/<DD>/<HHMMSS>Z-<kind>-<role>-<short-id>.md`: journal entries, one per dispatch / tick / message / result / worktree.
- `inboxes/<host>/<role>.md`: per-host per-role inbox state (the `inbox-drain` skill's tracking file).
- `jobs/{open,claimed,done,abandoned}/...`: the job board (the `job-board` skill's queue, when it lands here).
- `projects/<slug>/README.md`: per-project context documents (RPC URLs, contract addresses, keystore conventions; never the secrets themselves).
- `worktrees/<host>/<name>.md`: per-host long-lived worktree index entries.
- `presence/<host>/<role>.md`: per-host per-role presence files for standing agents (the steward, the standing monitors).
- `forecasts/<YYYY>/<MM>/<DD>/<short-id>.{json,svg,png}`: forecaster output artifacts.

## Reading the journal

```sh
git -C journal log --since='24 hours ago' --pretty='%h %ai %s'
```

## Writing to the journal

Subagents follow `finbot/skills/journal-sync/SKILL.md` on the `main` branch. The procedure handles the detached-HEAD fetch / rebase / push retry loop.

## Bootstrap

This is the initial journal stub. The first dispatch the liaison fires will append a `dispatch` entry under `entries/2026/06/.../`; the corresponding `result` will follow. The bulletin (a top-level dashboard the journalist consolidates) lands when there is enough activity to warrant one.
