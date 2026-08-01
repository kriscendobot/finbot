---
created: 2026-06-18
updated: 2026-07-22
author: builder, architect
---

# @finbot/harness

The runtime harness for finbot. Implements:

- An **OODA driving loop** (`loop.js`) that wakes on a cadence, surveys
  the journal, and dispatches work into the next phase.
- A **tool-call surface** (`tools.js`) that loads `skills/<name>/SKILL.md`
  stubs as named tools an LLM-shaped agent (or a deterministic driver)
  can invoke.
- A **subagent spawn** primitive (`spawn.js`) with a hardened, role-scoped
  capability policy by default. Legacy callers can explicitly inject the
  permissive attenuator.
- A **message bus** (`message-bus/`) over the journal: a per-role
  inbox and a job board, both serialized through git push.
- An **observation recorder** (`observation/`) that writes journal
  entries and monitors running subagents.

Pattern-borrowed from:

- **Pi harness** (`badlogic/pi-mono`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-agent`): the agent loop, the tool registry
  shape (`{ name, description, inputSchema, run }`), the event stream
  with before/after-tool-call hooks, and the queue-on-steering
  message model.
- **The parent garden** (`kriskowal/garden`): the dispatch contract,
  the per-dispatch worktree triple, and the two-channel message bus
  (inbox + job board) serialized through `git push`.
- **Endo daemon family** (`@endo/captp`, `@endo/exo`,
  `@endo/compartment-mapper`): the capability-attenuation hook the
  permissive v0 sandbox stubs out and the v1 target wires up.

## Quickstart

```sh
# from the finbot root
node bin/finbot --once --dry-run
```

This runs one OODA tick:

1. **Observe.** Drain the `oracle-watcher` and `monitor` inboxes
   from the journal.
2. **Orient.** If new observations exist, post `analyzer` and
   `forecaster` jobs to the board.
3. **Decide.** If recent analysis + forecast results exist, post a
   `planner` job.
4. **Act.** If a planner proposal landed, post an `auditor` job;
   on signoff, post an `executor` job with the run's safety mode.

Subagents are spawned via `spawn.js` per their role. Each spawn gets a hardened
role policy and its own tool registry slice. A caller that supplies `llmProgram`
gets a real SES Compartment for its role JavaScript: the program receives only
an immutable turn snapshot and its allowed tool names, then returns a requested
tool call for the host to execute. The program never receives host tool objects.

## Module map

- `index.js` — public exports + `run({ mode, safety, ... })`.
- `loop.js` — the OODA tick.
- `spawn.js` — `spawn({ role, brief, capabilities })`.
- `tools.js` — `loadTools(skillsDir)`, `Tool` shape.
- `message-bus/inbox.js` — `postToInbox`, `drainInbox`.
- `message-bus/job-board.js` — `postJob`, `claimJob`,
  `completeJob`.
- `message-bus/journal-sync.js` — `commitAndPush` (rebase retry
  loop).
- `observation/record.js` — `recordEntry({ kind, role, body, ... })`.
- `observation/monitor.js` — `monitorSubagent(handle)`.
- `sandbox/permissive.js` — role-scoped compartment policy, the
  `runCompartmentLlm` SES runner for `llmProgram`, and the explicit permissive
  legacy fallback.
- `schemas/tool.js`, `schemas/spawn.js` — JSON-schema-shaped
  validators.

## State

The harness is stateless across ticks. Everything durable lives in
the journal (`journal/entries/`, `journal/inboxes/<host>/<role>.md`,
`journal/jobs/<state>/<file>.md`). One tick can be killed and
re-run without losing work; the next tick will see the same journal
state and pick up where the previous left off.

## Testing

```sh
node --test packages/harness/test/*.test.js
```

The integration test (`test/integration.test.js`) drives one
end-to-end OODA tick against a synthetic journal worktree, verifies
journal entries land, and verifies the dry-run executor does not
sign.

## Roadmap to v1

- `sandbox/permissive.js` supplies the default hardened role policy and tool
  slice. `llmProgram` now runs local role JavaScript in an SES Compartment, with
  prompt data copied across the boundary and tool calls mediated by the host. A
  later archive-backed `@endo/compartment-mapper` loader can carry module graphs
  into the same boundary.
- The LLM-call boundary is deliberately abstracted (`spawn.js`
  accepts an `llm` function). v0 uses a deterministic stub that
  returns canned tool calls; v1 wires to the dispatching parent's
  LLM session (Claude, OpenAI, etc.) per the project's `references/`
  shelf.
- `tools.js` loads SKILL.md frontmatter and uses the procedure
  section as the tool's natural-language description. v1 may
  generate JSON-schema input schemas from a SKILL.md "inputs"
  section.
