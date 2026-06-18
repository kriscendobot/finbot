---
created: 2026-06-17
updated: 2026-06-17
author: architect
---

# Subagent standing instructions

These apply to every dispatched subagent regardless of role. Read this first, then your role file at `roles/<role>/AGENT.md`. Then load skills only as you need them.

The §_Improving your role and skills_ section below is common to **every** role including the liaison; the per-dispatch sections (cwd, worktree triple, journal write path) only apply to subagents the orchestrator dispatched via the `Agent` tool, not to the orchestrator's own turn.

## Your dispatch root

Every subagent runs from a per-dispatch worktree triple created by the orchestrator immediately before the `Agent` invocation:

```
<dispatch-root>/
  finbot/    # detached worktree of finbot's `main` branch; read roles/skills here
  journal/   # detached worktree of finbot's `journal` branch; write entries here
  project/   # (when applicable) detached worktree of an external repo
```

The dispatch prompt names `<dispatch-root>` explicitly. Your cwd is `project/` if a project worktree exists, otherwise the dispatch root itself. Use `finbot/` for read-only role and skill consultation. Use `journal/` for journal commits. Do not write into `finbot/`; meta-evolution is the liaison's job and happens in the orchestrator's own checkout, not under a dispatch root.

All three sub-worktrees are detached HEAD. Commits go to `HEAD`; pushes use `git push origin HEAD:<branch>`. See `finbot/skills/journal-sync/SKILL.md` for the journal-side details.

Each sub-worktree's git identity is pinned to the bot at prepare time, so any commit you make carries the bot identity by default. Do not edit the worktree's `user.name` / `user.email`.

When you finish, the orchestrator runs `skills/dispatch-worktree/dispatch-teardown.sh` on your dispatch root. Do not delete the worktrees yourself.

## Improving your role and skills

The final task of every engagement, common to every role including the liaison. Follow `finbot/skills/self-improvement/SKILL.md` for what to look for, where to route the lesson, the threshold rules, and the one-line report format.

The subagent does not commit role or skill changes itself; structural lessons go to a `message` entry addressed to `liaison`, which lands the change on `main` in its own checkout.

## Style

Three prose-style rules apply to every document you author or edit in finbot, including journal entry bodies:

- Avoid em-dashes in prose; rewrite as period, parentheses, or colon.
- Paths within one document tree are relative; absolute paths are reserved for the cross-tree case.
- Avoid Latin shorthand (`cf.`, `i.e.`, `e.g.`, `etc.`, `et al.`, `vs.`, `viz.`, `ad hoc`); use the English equivalent.

Vendored content under `references/<source>/` is exempt from all three: references are read-only snapshots.

## Document frontmatter

Every persistent document in finbot (role files, skill files, top-level docs) carries YAML frontmatter at the top with creation, last-updated, and author fields:

```yaml
---
created: 2026-06-17
updated: 2026-06-17
author: liaison
---
```

When you edit a document, update `updated`. If your authorship changes the document's center of gravity, prepend yourself to `author`. Trivial fixes (typos, link repair) do not warrant an authorship change.

The journal does **not** use this frontmatter. Entries already carry `ts:` and `role:`, and they are append-only so `updated` is moot.

## Capability discipline

finbot subagents run in attenuated environments (see `skills/compartment-sandbox/SKILL.md` and `skills/far-exo-vending/SKILL.md`). The standing discipline:

- **Treat ambient authority as poison.** If your role does not say it should reach the network, the wallet, the filesystem outside the dispatch root, or any other authority, it cannot. Read the powers your dispatch prompt names; do not improvise around a missing one.
- **The wallet capability is the executor's alone.** No other role's dispatch carries a wallet reference. If you find yourself reading or being handed one, treat it as a bug and `message` the liaison.
- **Live mode is opt-in per dispatch.** `live_authorized: true` must be present in your dispatch prompt frontmatter; absent it, every signing path is a no-op (the executor's `--dry-run` default). Roles other than executor never see this authorization at all.

## Monitoring safety constraint

Standing-monitor daemons feed event bodies into the LLM's context on every wake. finbot's safe set, by construction, is:

- Pinned-endpoint oracle JSON-RPC responses (the prices themselves are numbers, not text from an untrusted author).
- Our own contract's `vstorage` reads.
- Our own RPC node's responses.

Re-enabling a feed outside that set (arbitrary web feeds, social-media sentiment, third-party news APIs) requires explicit maintainer authorization recorded in a journal `message` entry. The liaison forwards it; the steward never originates it.

## External-repo etiquette

A subagent dispatched into a fork worktree must not initiate, on issues or pull requests in *any* repository, any of:

- Comments, reviews, or review-comments
- Reactjis
- Cross-references
- Issue or PR opens, edits, or closes

Exception: the dispatch prompt explicitly authorizes the action. This rule mirrors the parent garden's; finbot inherits it directly because the same identity-hygiene reasoning applies (the bot's authority is bounded by its dispatch prompt, not by GitHub's permission gate).

## Project context

Project specifics (RPC URLs, contract addresses, keystore paths, account conventions) live in the **journal**, not in role or skill files. The role/skill layer is project-agnostic and stays small; per-project facts accumulate as `message` entries with a `project:` slug. The journal's `projects/<slug>/README.md` is the canonical context document for a given project.

To find what finbot knows about a project, grep the journal's entries for the project slug:

```sh
grep -rl '^project: <slug>' journal/entries/
```

The most recent matching entry is the current source of truth; older entries are history.

## Where things are

- Your dispatch root: in the dispatch prompt; `pwd` reports the project subworktree (or the dispatch root if there is none).
- finbot `main` checkout (read-only for you): `<dispatch-root>/finbot/`.
- Journal worktree (write entries here): `<dispatch-root>/journal/`.
- Project worktree (when applicable, external code lives here): `<dispatch-root>/project/`.

## The journal

The journal is finbot's transcript and message bus. It is a worktree of the finbot repo on an orphan branch. Its history is independent of `main`, so journal commits never enter PRs or pollute code-side blame.

### Entry layout

```
journal/entries/<YYYY>/<MM>/<DD>/<HHMMSS>Z-<kind>-<role>-<short-id>.md
```

- `<HHMMSS>Z`: UTC time of day, zero-padded.
- `<short-id>`: 6 hex chars, random or from your session id.

### Entry shape

```markdown
---
ts: 2026-06-17T14:23:45Z
kind: tick                          # dispatch | tick | message | result | worktree
role: planner                       # role producing the entry
project: <slug>                     # optional
to: "*"                             # for messages: target role, or "*" for broadcast
refs:
  - entries/2026/06/17/142200Z-dispatch-liaison-a7f2c1.md
---

<one paragraph or short structured body>
```

### Writing an entry

Follow `finbot/skills/journal-sync/SKILL.md`. It handles the detached-HEAD fetch / rebase / push retry loop.

## Reporting

When done with a one-shot task, write a `result` entry to the journal **and** return a concise summary in your final message. Both end with a one-line `Self-improvement: ...` per `finbot/skills/self-improvement/SKILL.md` (or `Self-improvement: nothing this time.`).

When you are interrupted or hit a blocker you cannot resolve, write a `message` entry addressed to `liaison` describing what you tried and what you need.
