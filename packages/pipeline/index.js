/**
 * @finbot/pipeline — the OODA role pipeline.
 *
 * Each OODA role is exposed as a deterministic pure function over the
 * simulator world (observe -> orient -> decide -> act), plus the
 * capability-attenuation layer that confines the wallet to the executor and
 * the `runOodaCycle` orchestrator that wires the whole dry-run cycle.
 *
 * The roles' AGENT.md briefs describe the LLM-dispatch form of each role;
 * this package is the computation those dispatches drive (and the form the
 * harness loop runs in-process for a dry-run cycle, with no LLM required).
 */

export { observeOpportunities, windowFromHistory } from './oracle-watcher.js';
export { analyze, realizedVolatility } from './analyzer.js';
export { project, makeRebalanceAction } from './forecaster.js';
export { plan, hashProposal } from './planner.js';
export { audit } from './auditor.js';
export { execute, currentNav } from './executor.js';
export {
  navOf, computeTargetBalances, deriveSteps, applyStepsToPortfolio,
} from './rebalance.js';
export {
  CapabilityError, CAPABILITY_MAP, LIVE_ONLY_CAPS,
  makeWalletCapability, attenuateForRole, runInAttenuatedCompartment,
} from './cap-attenuation.js';
export { runOodaCycle } from './ooda-cycle.js';
export { makeDryRunCompute, deriveSeed } from './driver-compute.js';
