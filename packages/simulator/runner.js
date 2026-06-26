/**
 * runSimulator — the meta-circular simulator primitive.
 *
 * Same shape at every level:
 *
 *   const { tick, observe, fork } = runSimulator(world);
 *   for (let i = 0; i < N; i += 1) tick();
 *   const snap = observe();
 *   // ...
 *   const child = fork(seed);
 *   // child is a fresh runner over a cloned world with new RNG
 *
 * The outer driver calls runSimulator(outerWorld) and ticks it
 * indefinitely. A planner that wants to forecast a proposed action
 * calls fork(seed) on its current world, applies the proposed action
 * on the child, ticks N futures, and aggregates.
 *
 * The simulator is intentionally minimal: it advances the price feed,
 * gives the world's tick function (if any) a chance to react, and
 * records an observation. It does not by itself wire to the @finbot/
 * harness; the agent loop is whatever you pass as `world.tick` or
 * `world.harnessConfig.tickFn`. v0 supplies a default null tickFn so
 * the simulator can run as a pure price/portfolio walk without an
 * agent.
 */

import { cloneWorld, makeWorld } from './world.js';
import { accruePortfolio, hasAccruingInstrument } from './yield-accrual.js';

/**
 * @typedef {object} Observation
 * @property {number} t
 * @property {string} tag
 * @property {number} seed
 * @property {Record<string, number>} prices
 * @property {import('./portfolio.js').PortfolioSnapshot} portfolio
 * @property {object} [agentResult]      output of the world's tickFn, if any
 */

/**
 * @typedef {object} Simulator
 * @property {() => Observation} tick
 * @property {() => Observation} observe
 * @property {(seed: number, opts?: {tag?: string}) => Simulator} fork
 * @property {import('./world.js').World} world
 * @property {Observation[]} history
 */

/**
 * Build a simulator over a world.
 *
 * @param {import('./world.js').World} world
 * @param {object} [opts]
 * @param {Function} [opts.tickFn]                 optional agent tick. Signature: (world, t, prices) -> agentResult
 * @param {boolean} [opts.recordHistory]           default true
 * @returns {Simulator}
 */
export function runSimulator(world, opts = {}) {
  if (!world || !world.portfolio || !world.priceFeed) {
    throw new Error('runSimulator: world must have { portfolio, priceFeed }');
  }
  const tickFn = opts.tickFn || world.harnessConfig?.tickFn || null;
  const recordHistory = opts.recordHistory !== false;
  /** @type {Observation[]} */
  const history = [];
  // Per-run yield/dividend accrual state, keyed by asset. Lives on the runner
  // (not the world) so it is fresh per fork; the world only carries the
  // read-only instrument registry. No registry / all-growth => the fast path.
  const accruing = hasAccruingInstrument(world.instruments);
  /** @type {Record<string, {payoutIndex: number, accruedCash: number}>} */
  const accrualState = {};

  function observe() {
    const prices = world.priceFeed.current();
    const portfolio = world.portfolio.markToMarket(prices);
    return {
      t: world.priceFeed.t,
      tag: world.tag,
      seed: world.seed,
      prices,
      portfolio,
    };
  }

  function tick() {
    const prices = world.priceFeed.tick();
    // Accrue held yield / dividend positions into the portfolio before the
    // agent reacts, so the agent's tick sees this period's income in cash.
    let accrualFlows;
    if (accruing) {
      accrualFlows = accruePortfolio(world.portfolio, world.instruments, world.priceFeed.t, prices, accrualState);
    }
    let agentResult;
    if (tickFn) {
      // The agent tick may mutate world.portfolio via applyTrade.
      agentResult = tickFn(world, world.priceFeed.t, prices);
    }
    const portfolio = world.portfolio.markToMarket(prices);
    const obs = {
      t: world.priceFeed.t,
      tag: world.tag,
      seed: world.seed,
      prices,
      portfolio,
    };
    if (agentResult !== undefined) obs.agentResult = agentResult;
    if (accrualFlows && accrualFlows.length > 0) obs.accruals = accrualFlows;
    if (recordHistory) history.push(obs);
    return obs;
  }

  function fork(seed, forkOpts = {}) {
    const child = cloneWorld(world, { seed, tag: forkOpts.tag });
    return runSimulator(child, opts);
  }

  // Seed the history with the t=0 observation so callers can read
  // observe() at the boundary.
  if (recordHistory) history.push(observe());

  return { tick, observe, fork, world, history };
}

/**
 * Convenience: build a world and a simulator in one call.
 *
 * @param {object} cfg                              forwarded to makeWorld()
 * @param {object} [opts]                           forwarded to runSimulator()
 * @returns {Simulator}
 */
export function runSimulatorFromConfig(cfg, opts) {
  return runSimulator(makeWorld(cfg), opts);
}
