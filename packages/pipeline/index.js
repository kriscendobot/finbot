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
// `round12` is named here, not only on the `./forecaster` subpath, because it is
// a cross-MODULE contract with an out-of-package consumer: the auditor's gate and
// `bin/finbot-ooda` both quantize through the one `round12`, and an export the
// package's own bins consume belongs at the entry point, so "exactly one
// quantizer" is enforceable from it. `computeDataSufficiency` is NOT promoted —
// it has no consumer outside `forecaster.js` (its tests import the module
// directly), and the criterion has to hold for every name it covers.
export { project, makeRebalanceAction, round12 } from './forecaster.js';
export { plan, hashProposal } from './planner.js';
export {
  toleranceFromProfile, selectAllocationForProfile, planForProfile,
} from './profile-allocation.js';
// The auditor's recording and gating primitives are promoted on the same
// criterion, and each has the same out-of-package consumer — `bin/finbot-ooda`,
// which re-records the coverage evidence and validates the flag that arms the
// gate. A caller-supplied identifier the auditor sanitizes before recording is
// sanitized (and bounded, hence `MAX_LABEL_CODE_POINTS`) by every module that
// records it; a coverage ratio the auditor formats for a record is formatted the
// same way by every module that records it; and the arming/usability predicates
// are the one definition the CLI's validation must not drift from.
export {
  audit, sanitizeLabel, MAX_LABEL_CODE_POINTS, formatCoverage,
  coverageThresholdUsable, coverageGateArmed,
} from './auditor.js';
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
