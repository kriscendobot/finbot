/**
 * The driver's in-process dry-run compute hook.
 *
 * `@finbot/harness`'s loop exposes a `compute` config hook (see
 * `packages/harness/loop.js` § Phase 5) but cannot construct the cycle itself:
 * the cycle needs both `@finbot/simulator` (to build and warm a world) and this
 * package's `runOodaCycle`, and the harness depends on neither. This module is
 * where that wiring is allowed to live, because `@finbot/pipeline` already
 * depends on both. `bin/finbot` imports `makeDryRunCompute` and threads the
 * returned hook into the harness loop as `config.compute`.
 *
 * What the hook does per tick:
 *
 *   1. Build a fresh simulator world. The GBM seed is derived from the tick id
 *      so every tick faces a different (but reproducible) market, instead of
 *      replaying one frozen cycle forever.
 *   2. Warm the price feed `warmup` ticks so the oracle window has history.
 *   3. Run one end-to-end dry-run `runOodaCycle`, recording each stage through
 *      the recorder the harness hands us.
 *   4. Assert the cycle never touched a wallet. This path is DRY-RUN ONLY; a
 *      true `walletTouched` is a safety violation and throws.
 *
 * DRY-RUN ONLY. This hook never enables live mode, never reads a keystore, and
 * never constructs a wallet capability (`runOodaCycle` passes `parentCaps: {}`
 * and runs the executor in `mode: 'dry-run'`). Live execution stays gated behind
 * an explicit authorized executor dispatch per `designs/cap-attenuation.md`.
 */

import { makeWorld } from '@finbot/simulator/world';
import { runSimulator } from '@finbot/simulator/runner';

import { runOodaCycle } from './ooda-cycle.js';

const DEFAULTS = {
  seed: 7,
  drift: -0.01,
  vol: 0.02,
  warmup: 10,
  threshold: 30,
  ensemble: 200,
  horizon: 20,
  tailFloor: 0.6,
  startCash: 1000,
  startBalance: 10,
  initialPrice: 10,
  asset: 'ATOM',
};

/**
 * Build a dry-run compute hook for the harness driving loop.
 *
 * @param {object} [options] — overrides for the world + cycle config (see DEFAULTS).
 * @returns {(ctx: object) => Promise<object>} a hook matching `config.compute`'s contract.
 */
export function makeDryRunCompute(options = {}) {
  const opts = { ...DEFAULTS, ...options };

  return async function computeDryRunCycle(ctx) {
    const seed = deriveSeed(opts.seed, ctx?.tickId);

    const world = makeWorld({
      portfolio: {
        cash: opts.startCash,
        balances: { [opts.asset]: opts.startBalance },
        initialPrice: opts.initialPrice,
      },
      priceFeed: {
        kind: 'gbm',
        initialPrices: { [opts.asset]: opts.initialPrice },
        volatilities: { [opts.asset]: opts.vol },
        drifts: { [opts.asset]: opts.drift },
        seed,
      },
      seed,
      tag: `driver-${seed}`,
    });

    const sim = runSimulator(world);
    for (let i = 0; i < opts.warmup; i += 1) sim.tick();

    const cycleId = `tick-${ctx?.tickId || seed}`;
    const result = await runOodaCycle({
      world,
      history: sim.history,
      recorder: ctx?.recorder || null,
      cycleId,
      config: {
        windowTicks: opts.warmup,
        oracle: { thresholdBps: opts.threshold },
        analyzer: { scoreFloor: 0 },
        forecaster: { ensembleSize: opts.ensemble, horizon: opts.horizon, baseSeed: 1000 + seed },
        bounds: { maxStepPct: 0.25, maxDayPct: 0.5, concentrationCapPct: 0.9 },
        auditor: { tailFloorPct: opts.tailFloor, stalenessWindowTicks: opts.warmup + 1 },
      },
    });

    // The whole point, restated as an invariant: dry-run never constructs a wallet.
    if (result.walletTouched) {
      throw new Error(
        `finbot driver: SAFETY VIOLATION — walletTouched is true in a dry-run cycle (${cycleId})`,
      );
    }

    return result;
  };
}

/**
 * Derive a per-tick GBM seed from the base seed and the tick id, so each tick
 * faces a fresh market while staying reproducible from (baseSeed, tickId). A
 * missing tick id falls back to the base seed (one fixed cycle).
 *
 * @param {number} baseSeed
 * @param {string} [tickId] — 6 hex chars from the harness, or undefined
 * @returns {number}
 */
export function deriveSeed(baseSeed, tickId) {
  if (!tickId) return baseSeed;
  const n = parseInt(String(tickId), 16);
  if (!Number.isFinite(n)) return baseSeed;
  // Keep it a modest positive integer; the price feed's PRNG hashes it anyway.
  return (baseSeed + n) % 0x7fffffff;
}
