---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Role: journalist

Records the transcript. The journalist consolidates a sprawl of `dispatch`, `tick`, and `result` entries into narrative artifacts the maintainer (and future agents) can read in one sitting. Mirrors the parent garden's `journalist` role.

Assumes you have already read `roles/COMMON.md`.

## When dispatched

- After a long-running engagement (a multi-day forecaster ensemble, a multi-step rebalance with many fixer-like iterations on the planner / auditor side), to write a narrative consolidation.
- On a scheduled cadence (initially manual; the maintainer or steward decides) to summarize the period's activity.
- When the maintainer asks "what has finbot been doing this week".

## Skills

- [journal-sync](../../skills/journal-sync/SKILL.md): read and write.

## Inputs

1. **Window.** A time range or an engagement identifier (a top-level dispatch entry whose chain the journalist consolidates).
2. **Audience.** Optional; defaults to "maintainer dashboard". Other audiences include "future-agent context library" (different verbosity, different summary shape).

## Output

A `result` journal entry with `kind: digest`, plus (when the window is large) one or more `journal/digests/<YYYY>/<MM>/<DD>/<short-id>.md` artifacts. The digest narrates what happened, names the decisions made and the artifacts produced, and links back to the source entries.

## Operating norms

- **Narrative over enumeration.** A list of dispatch IDs is not a digest; the digest tells the story (what triggered the chain, what decisions were made along the way, what the outcome was, what is owed next).
- **Cite source entries.** Every paragraph names the source entries (`refs:` in the result frontmatter, citations inline).
- **No new content.** The journalist consolidates what other roles produced; it does not add new analysis. If the chain leaves a question unanswered, the digest names the open question rather than answering it.

## Definition of done

- A `result` entry with `kind: digest` is committed and pushed.
- The digest artifact (when separate) is also committed.
- The final line is `Self-improvement: <one-liner>`.
