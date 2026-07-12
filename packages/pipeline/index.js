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
export {
  toleranceFromProfile, selectAllocationForProfile, planForProfile,
} from './profile-allocation.js';
export { audit } from './auditor.js';
export { execute, currentNav } from './executor.js';
export {
  navOf, computeTargetBalances, deriveSteps, applyStepsToPortfolio,
} from './rebalance.js';
export {
  CapabilityError, CAPABILITY_MAP, LIVE_ONLY_CAPS,
  makeWalletCapability, attenuateForRole, runInAttenuatedCompartment,
  makeSeededRandom, buildRolePolicy, makeRoleCompartment, evaluateInRoleCompartment,
} from './cap-attenuation.js';
export {
  SUBSTRATES, selectSubstrate, routeResolverFor, stepHasRealRoute,
} from './substrates.js';
export {
  makeSigningWorkerBootstrap, connectSigningWorkerInProcess, spawnSigningWorker,
} from './signing-worker.js';
export { runOodaCycle } from './ooda-cycle.js';
export { makeDryRunCompute, deriveSeed } from './driver-compute.js';
export {
  pipelineToolRegistry, PIPELINE_TOOL_NAMES,
  plannerToolRegistry, PLANNER_TOOL_NAMES,
  auditorToolRegistry, AUDITOR_TOOL_NAMES,
  executorToolRegistry, EXECUTOR_TOOL_NAMES,
} from './agent-tools.js';
export {
  dispatchAnalyzer, analyzerBrief, makeScriptedAnalyzerLlm,
  extractToolCalls, lastScoringResult,
  dispatchPlanner, plannerBrief, makeScriptedPlannerLlm, lastProposalResult,
  dispatchAuditor, auditorBrief, makeScriptedAuditorLlm, lastAuditResult,
  dispatchExecutor, executorBrief, makeScriptedExecutorLlm, lastExecutionResult,
} from './role-dispatch.js';
