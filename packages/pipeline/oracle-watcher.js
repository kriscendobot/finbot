/**
 * oracle-watcher (observe phase, programmatic form).
 *
 * The role brief (`roles/oracle-watcher/AGENT.md`) describes both a
 * standing shell daemon and a one-shot LLM dispatch. This module is the
 * deterministic computation underneath both: given a window of price
 * readings (the most recent N observations from the simulator's price
 * feed, or any equivalent oracle history), detect assets whose price has
 * deviated from the window's reference by more than a configured threshold
 * and emit an opportunity-deviation event per crossing.
 *
 * Read-only by construction: it consumes a price history and produces
 * events; it never trades and never touches a wallet.
 */

/**
 * @typedef {object} Opportunity
 * @property {string} asset
 * @property {number} referencePrice   price at the window's start
 * @property {number} currentPrice     latest price
 * @property {number} deviationBps      signed basis-point deviation
 * @property {'up' | 'down'} direction
 * @property {number} observedAtTick    tick index of the latest reading (freshness anchor)
 */

/**
 * Detect opportunity-deviation events over a price-reading window.
 *
 * @param {object} input
 * @param {Array<{ t: number, prices: Record<string, number> }>} input.readings
 *        ordered oldest..newest; each carries a tick index and a price book
 * @param {object} [opts]
 * @param {number} [opts.thresholdBps]   minimum |deviation| to emit (default 50)
 * @param {string[]} [opts.assets]       restrict to these assets (default: all in the latest reading)
 * @returns {{ readings: Record<string, number>, crossings: Opportunity[], observedAtTick: number }}
 */
export function observeOpportunities(input, opts = {}) {
  const thresholdBps = opts.thresholdBps != null ? opts.thresholdBps : 50;
  const readings = input.readings || [];
  if (readings.length < 2) {
    const latest = readings[readings.length - 1];
    return {
      readings: latest ? { ...latest.prices } : {},
      crossings: [],
      observedAtTick: latest ? latest.t : 0,
    };
  }
  const first = readings[0];
  const last = readings[readings.length - 1];
  const assets = opts.assets || Object.keys(last.prices);

  /** @type {Opportunity[]} */
  const crossings = [];
  for (const asset of assets.slice().sort()) {
    const ref = first.prices[asset];
    const cur = last.prices[asset];
    if (ref == null || cur == null || ref <= 0) continue;
    const deviationBps = ((cur - ref) / ref) * 10000;
    if (Math.abs(deviationBps) >= thresholdBps) {
      crossings.push({
        asset,
        referencePrice: ref,
        currentPrice: cur,
        deviationBps,
        direction: deviationBps >= 0 ? 'up' : 'down',
        observedAtTick: last.t,
      });
    }
  }
  // Most significant crossing first.
  crossings.sort((a, b) => Math.abs(b.deviationBps) - Math.abs(a.deviationBps));

  return { readings: { ...last.prices }, crossings, observedAtTick: last.t };
}

/**
 * Convenience: pull the trailing window of readings out of a simulator's
 * recorded history (each history observation has `{ t, prices }`).
 *
 * @param {Array<{ t: number, prices: Record<string, number> }>} history
 * @param {number} windowTicks
 * @returns {Array<{ t: number, prices: Record<string, number> }>}
 */
export function windowFromHistory(history, windowTicks) {
  if (!history || history.length === 0) return [];
  const start = Math.max(0, history.length - windowTicks);
  return history.slice(start).map((o) => ({ t: o.t, prices: o.prices }));
}
