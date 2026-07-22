# finbot

A self-driving portfolio garden: an OODA loop (observe, orient, decide, act) over on-chain positions, oracle prices, and forecast distributions. Pattern-borrowed from the [kriskowal/garden](https://github.com/kriskowal/garden) agent-orchestration garden and from the Agoric [ymax planner](https://github.com/Agoric/agoric-sdk/tree/master/services/ymax-planner) + [portfolio-contract](https://github.com/Agoric/agoric-sdk/tree/master/packages/portfolio-contract); capability safety borrowed from the [Endo](https://github.com/endojs/endo) family (CapTP, Exo, Compartments, daemon).

## What it does

finbot is a meta library of agent **roles** and **skills** plus a **journal** that records what the bot has done. The bot itself has four loops running in concert:

- **Observe.** The `oracle-watcher` polls price oracles on a schedule and emits opportunity-deviation events to the inbox and the job board. The `monitor` watches on-chain account state and external feeds.
- **Orient.** The `analyzer` scores opportunities across instruments using risk-adjusted return metrics. The `forecaster` runs Monte Carlo ensemble simulations across a fixed time horizon and emits histogram projections.
- **Decide.** The `planner` (ymax-shaped) consumes balance state, analyst recommendations, and forecaster projections to produce portfolio rebalance proposals.
- **Act.** The `executor` is the only role that holds the wallet capability. It consumes planner proposals after the `auditor` has reviewed them and signs + sends on-chain transactions.

The safety story is layered:

1. **Capability attenuation.** Subagents run in [Endo compartments](https://github.com/endojs/endo/tree/master/packages/ses) with attenuated globals. They receive only the [Far](https://github.com/endojs/endo/tree/master/packages/pass-style)/[Exo](https://github.com/endojs/endo/tree/master/packages/exo) references their job requires; the wallet reference never reaches anything but the executor. See `designs/cap-attenuation.md`.
2. **Pre-execution audit.** Every on-chain action passes through the `auditor` before it fires. The auditor checks invariants (no withdrawal above the day's budget, no rebalance that moves more than N percent of NAV in one step, no transaction lacking a citing forecaster projection).
3. **Dry-run first.** The executor's default mode is `--dry-run`; live mode requires explicit per-job authorization in the dispatch prompt.

## OODA loop diagram

```
oracle-watcher ──────────┐
                          │
monitor (on-chain) ───────┼──> analyzer ──> planner ──> auditor ──> executor ──> chain
                          │       ▲
forecaster ───────────────┘       │
   ▲                              │
   └────── opportunity-comparison ┘
```

## Layout

See `CLAUDE.md` for the full layout and the dispatch contract. Quick map:

- `roles/<role>/AGENT.md`: operating brief for one role.
- `skills/<skill>/SKILL.md`: self-contained playbook for one capability.
- `journal/`: orphan-branch worktree of this repo; transcript and message bus.
- `scripts/`: executable helpers (driver, watchers, daemon-management).
- `designs/`: design documents.
- `references/`: read-only shelves imported from other libraries.
- `worktrees/`: bare clones + per-PR worktrees for downstream projects.
- `dispatches/`: per-dispatch ephemeral worktree triples.

## Status

The **end-to-end dry-run OODA cycle works** over the simulator. `@finbot/pipeline`
implements each role as a deterministic function over the simulator world and wires
them into one cycle — `oracle-watcher` emits an opportunity → `analyzer` scores it →
`forecaster` runs a Monte Carlo ensemble (via the simulator's nested-fork
`forecast()`) → `planner` emits a hashed, cited, ymax-shaped rebalance proposal →
`auditor` checks the invariant set → `executor` **dry-runs** the approved steps on a
clone of the portfolio. The wallet capability is confined to the executor and is
never even constructed in dry-run. Run it:

```
node bin/finbot-ooda --seed=7        # one dry-run cycle, printed report
node bin/finbot-ooda --seed=7 --json # structured result
npm test                             # all tests across harness, simulator, pipeline
```

`npm test` also runs in CI (`.github/workflows/ci.yml`) on every pull request and
on pushes to `main`, so a red suite blocks a merge.

The cycle above is pure automation (every stage a function call, no LLM). The
**inference-driven path** is also wired: a real subagent can drive an OODA stage
and call the deterministic pipeline functions as tools. `@finbot/harness`'s
subagent `spawn` takes an injected `llm` — the deterministic stub stays the
default so tests stay offline, and `harness.providers.makeAnthropicLlm()` is the
real provider (Anthropic, `claude-opus-4-8`, via `fetch`, no new dependency).
`@finbot/pipeline` exposes the orient-phase scorers as harness tools
(`pipelineToolRegistry`) and `dispatchAnalyzer` spawns the analyzer over an
oracle-watcher observation so it reasons over the opportunities and **calls
`score_opportunities` (the deterministic `analyze`) as a tool**. The DECIDE
stage is wired the same way: `plannerToolRegistry` exposes the ymax-shaped
planner as `propose_rebalance`, and `dispatchPlanner` spawns the planner over
the analyzer's target allocation so it reasons then **calls `propose_rebalance`
(the deterministic `plan`) as a tool** to emit the hashed proposal. The
inference path reproduces the headless planner's `proposal_hash` byte-for-byte:

```
node bin/finbot-dispatch --seed=7              # offline: deterministic scripted analyzer + planner LLMs
node bin/finbot-dispatch --seed=7 --live-llm   # real inference (needs ANTHROPIC_API_KEY)
```

This drives the ORIENT and DECIDE stages end-to-end in dry-run (the planner runs
only when the analyzer proposes a rebalance); both roles are read-only and their
tool subsets can reach no wallet capability.

Still scaffolding / follow-on work: the role `AGENT.md` briefs describe the
LLM-dispatch form of each role (the pipeline is the computation those dispatches
drive); the cap-attenuation layer is the dependency-free in-process v0.5 (the SES /
`@endo/compartment-mapper` upgrade is the next step); live execution against a real
substrate is unbuilt and gated. See the posted `finbot-*` follow-on jobs.

## Safety

finbot does not currently hold or transact on a live portfolio. Bringing it online requires:

- A wallet key landed under a separate secrets-management surface (not in this repo).
- An RPC URL pinned per environment (not in this repo).
- An explicit maintainer authorization recorded in the journal that enables live executor mode.

Until those three are in place, `executor` runs in `--dry-run` mode only and signs nothing.

## License

Apache-2.0. See `LICENSE`.
