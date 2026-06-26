/**
 * Execution-cost noise: gas cost and slippage.
 *
 * A dry-run forecast that ignores trading frictions overstates the
 * upside of any rebalance. Two frictions matter on-chain:
 *
 *   - Slippage: the execution price drifts against you versus the quoted
 *     mid, by an amount that scales with trade size and varies tick to
 *     tick. Modeled as a multiplicative factor on the fill price: a buy
 *     fills slightly above mid, a sell slightly below.
 *   - Gas cost: a quote-currency charge per executed trade, with jitter
 *     to reflect a varying fee market.
 *
 * Both draw from a *seeded* RNG the caller threads through, so a forecast
 * with cost noise stays byte-deterministic. Never calls Math.random.
 */

/**
 * @typedef {object} SlippageModel
 * @property {number} [baseBps]      baseline slippage in basis points (default 5)
 * @property {number} [jitterBps]    +/- uniform jitter in basis points (default 5)
 * @property {number} [impactPerUnitNotional]   extra bps per 1.0 of notional (default 0)
 */

/**
 * Compute a slippage-adjusted fill price.
 *
 * @param {object} args
 * @param {'buy' | 'sell'} args.side
 * @param {number} args.price            quoted mid price
 * @param {number} [args.notional]       trade notional (for size impact); default 0
 * @param {() => number} args.rng        seeded uniform [0,1)
 * @param {SlippageModel} [model]
 * @returns {number}                     adjusted fill price (>= 0)
 */
export function slippageFill({ side, price, notional = 0, rng }, model = {}) {
  const baseBps = model.baseBps != null ? model.baseBps : 5;
  const jitterBps = model.jitterBps != null ? model.jitterBps : 5;
  const impact = model.impactPerUnitNotional != null ? model.impactPerUnitNotional : 0;
  // Uniform jitter in [-jitterBps, +jitterBps].
  const jitter = (rng() * 2 - 1) * jitterBps;
  const totalBps = baseBps + jitter + impact * notional;
  const frac = totalBps / 10000;
  // Adverse direction: buys fill higher, sells fill lower.
  const adjusted = side === 'buy' ? price * (1 + frac) : price * (1 - frac);
  return Math.max(0, adjusted);
}

/**
 * @typedef {object} GasModel
 * @property {number} [mean]         mean gas cost per trade in quote currency (default 0.5)
 * @property {number} [jitter]       +/- uniform jitter in quote currency (default 0.25)
 */

/**
 * Draw a gas cost for one executed trade.
 *
 * @param {() => number} rng         seeded uniform [0,1)
 * @param {GasModel} [model]
 * @returns {number}                 gas cost in quote currency (>= 0)
 */
export function gasCost(rng, model = {}) {
  const mean = model.mean != null ? model.mean : 0.5;
  const jitter = model.jitter != null ? model.jitter : 0.25;
  const draw = mean + (rng() * 2 - 1) * jitter;
  return Math.max(0, draw);
}
