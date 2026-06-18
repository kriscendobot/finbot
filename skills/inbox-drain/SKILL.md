---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Skill: inbox-drain

Find journal entries addressed to a role since the last time that role drained its inbox. Mirrors the parent garden's identically-named skill verbatim in shape; the only finbot-specific note is that some inbox messages carry pre-staged `live_authorized: true` for the executor and the steward forwards these without modification.

## When to use

- **Liaison session start**: drain to surface anything other roles (typically the steward, or returning subagent dispatches from a sibling session) have written to the liaison while the user was away.
- **Steward per cycle**: drain to pick up `message` entries from subagents the steward dispatched, plus broadcasts the steward should react to, plus any pre-staged authorizations the liaison left for the steward to forward.
- **Continuous monitor wrapping**: run the script in a loop so new messages flow into the parent session as notifications.

## State file

`journal/inboxes/<host>/<role>.md` carries the last-drained position:

```yaml
---
host: <hostname -s>
role: <role>
last_drained_at: <ISO>
last_drained_commit: <SHA>
---
```

The state file is committed and pushed back to the journal so other hosts (or the same host across sessions) can pick up where the last drain left off. The first call on a host initializes the state at current `HEAD` and outputs nothing; subsequent calls find new messages.

## Running once

```sh
skills/inbox-drain/inbox-drain.sh liaison
```

Output (chronological by entry timestamp; one line per match):

```
2026-06-17T14:23:45Z liaison entries/2026/06/17/142345Z-message-steward-cf7b09.md
2026-06-17T14:24:12Z * entries/2026/06/17/142412Z-message-monitor-afa436.md
```

`<to-field>` is the role name for direct messages or `*` for broadcasts. Empty output means no new addressed-to-this-role entries since the last drain.

## Running as a continuous monitor

```sh
while sleep 90; do skills/inbox-drain/inbox-drain.sh steward; done
```

Each output line becomes a notification in the parent session. The wrapper stays quiet between drains.

## What the script considers a "message"

The filter is on the `to:` frontmatter field: `to: <role>` or `to: "*"` (broadcast). Any entry with that field set counts. Entries without `to:` are skipped (most ticks and worktree entries).

## finbot-specific: pre-staged authorizations

When the liaison wants to authorize a live executor dispatch the steward will fire later (the maintainer steps away after authorizing but before the auditor's signoff arrives), the liaison writes a `message: liaison → steward` with the authorization in the body:

```yaml
---
ts: ...
kind: message
role: liaison
to: steward
authorization:
  live_authorized: true
  proposal_hash: <hash>
  expires_at: <ISO>
  one_shot: true
---
```

The steward's drain surfaces this; when the auditor's signoff arrives for that same `proposal_hash` before `expires_at`, the steward forwards the authorization into the executor dispatch verbatim. After the dispatch returns, the steward marks the authorization consumed (a follow-up `message: steward → liaison` `kind: tick` naming the proposal_hash and the executor's `result` entry).

The steward never originates such an authorization; it only forwards.

## Notes

The script body is the parent garden's adapted by path; finbot does not yet ship the executable. The first liaison or steward engagement that needs it adapts `/home/kris/skills/inbox-drain/inbox-drain.sh` for finbot's paths.
