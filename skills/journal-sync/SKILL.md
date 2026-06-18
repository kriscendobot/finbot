---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: journal-sync

Append a journal entry safely against concurrent writers. The journal is an orphan branch of finbot pushed to `origin/journal`; multiple agents on multiple hosts append concurrently, and the push is the serialization point.

## When to use

Every subagent that writes a journal entry (every dispatched role's `result`, every standing role's `tick`, every `message` between roles). The orchestrator uses it too, for the `dispatch` entry it writes before invoking `Agent`.

## Procedure

```sh
# Assumes $JRN is the journal worktree (the dispatch root's journal/ sub-worktree, or
# the orchestrator's standing journal/ worktree).

UTC=$(date -u +%Y%m%dT%H%M%SZ)
SHORT=$(openssl rand -hex 3)
DAY=$(date -u +%Y/%m/%d)
HHMMSS=$(date -u +%H%M%S)
KIND=...   # dispatch | tick | message | result | worktree
ROLE=...   # planner | executor | ...
DEST="entries/${DAY}/${HHMMSS}Z-${KIND}-${ROLE}-${SHORT}.md"

mkdir -p "$JRN/entries/${DAY}"
# Write the entry body into $DEST.

# Sync, commit, push with retry on rejection.
git -C "$JRN" fetch --quiet origin journal
git -C "$JRN" rebase origin/journal || { git -C "$JRN" rebase --abort; }
git -C "$JRN" add "$DEST"
git -C "$JRN" commit -m "${KIND}: ${ROLE} ${SHORT}"
for i in 1 2 3 4 5; do
  git -C "$JRN" push origin HEAD:journal && break
  git -C "$JRN" fetch --quiet origin journal
  git -C "$JRN" rebase origin/journal || { git -C "$JRN" rebase --abort; sleep $((i*i)); }
done
```

The detached-HEAD push (`HEAD:journal`) is required because the dispatch's journal sub-worktree is detached; a bare `git push` would fail with no upstream.

## Concurrency

Two appends from different agents do not collide on path (each has a fresh short-id and a fresh timestamp). They can collide on the commit (one rebased onto the other's commit succeeds; the loser rebases and retries). The retry loop above absorbs up to four collisions before giving up.

## Frontmatter shape

```markdown
---
ts: 2026-06-17T14:23:45Z
kind: tick
role: planner
project: <slug>                # optional
worktree: dispatches/...       # when applicable
to: steward                    # for messages: target role, or "*" for broadcast
refs:
  - entries/2026/06/17/142200Z-dispatch-liaison-a7f2c1.md
---

<body>
```

The `refs:` list cross-links entries that form a chain (`dispatch` -> `result`, `message` -> `tick` that consumed it, etc.).

## Pitfalls

- **Forgetting to rebase before pushing.** A push that rejects without rebase leaks a stale local commit; the retry loop handles this, but a malformed retry can drop the entry. Use the loop above verbatim.
- **Writing into the wrong branch.** The journal sub-worktree is detached. If you accidentally check out a named branch in the dispatch's journal sub-worktree, you may push to the wrong ref. Always push with the explicit `HEAD:journal` form.
- **Editing the state file directly.** Inbox state and job board state are managed by their own skills; do not edit them from journal-sync.

## Notes

This skill body is the procedural contract. finbot does not yet ship a dedicated `journal-sync.sh` script; the procedure inlines into each role's commit step. A future engagement may extract a sibling executable.
