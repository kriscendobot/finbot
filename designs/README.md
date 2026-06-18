# designs/

Design documents for finbot. Each design lives in its own file under this directory and is referenced from role files, skill files, or `CLAUDE.md`.

Designs are not implementation. They are the maintainer's (and the liaison's) thinking about a problem before the implementation lands. The design's job is to:

1. Define the problem the design addresses.
2. Sketch the shape of the solution.
3. Name open questions and known trade-offs.
4. Point at the roles, skills, or scripts that would implement the design.

## Current design documents

- [`ymax-integration.md`](ymax-integration.md): how the planner consumes Agoric's ymax-shaped artifacts (the `@agoric/portfolio-api` package, the `portfolio-contract` vstorage, the `services/ymax-planner` shape).
- [`ensemble-forecasting.md`](ensemble-forecasting.md): how the forecaster runs Monte Carlo ensemble simulations and renders histogram projections.
- [`cap-attenuation.md`](cap-attenuation.md): how finbot adopts the Endo compartment + Far-ref pattern to attenuate subagent capability, with particular attention to the wallet boundary.
