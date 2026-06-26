/**
 * Target-allocation rebalancer over a mix of instruments.
 *
 * `mixReturns` (in `instruments.js`) blends legs buy-and-hold; this module
 * periodically trades legs back toward a target weight vector, charging the
 * real frictions a rebalance incurs: slippage on each fill, gas per trade,
 * and a basis-point fee on notional (`costs.js`). Instrument payouts (yield
 * accrual, dividends) flow into a shared cash account that the rebalancer
 * redeploys, unless a leg's own policy reinvests into its position (DRIP).
 *
 * The walk shares `stepInstrument` with the single-leg path, so a leg behaves
 * identically whether walked alone or inside the mix. It is pure over its
 * inputs and seeded: pass `rng` (or `seed`) and two runs are byte-identical.
 *
 * This mirrors the protocol shape of `@finbot/pipeline`'s `rebalance.js`
 * (NAV -> target balances -> funds-flow deltas, bounded and costed) over an
 * instrument mix rather than a flat price book, so a portfolio of these
 * instruments can be driven from the same target-weight decision.
 */

import { slippageFill, gasCost } from './costs.js';
import { sfc32 } from './price-feed.js';
import { stepInstrument, initInstrumentState } from './instruments.js';

/**
 * Walk a mix of instruments under a target-allocation rebalancer.
 *
 * @param {Array<{instrument: object, weight?: number}>} legs
 * @param {object} [opts]
 * @param {number} [opts.capital]          starting capital in quote units, default 1000
 * @param {number} [opts.rebalancePeriod]  ticks between rebalances, default 20
 * @param {number} [opts.length]           steps to walk; default the shortest leg
 * @param {number} [opts.feeBps]           per-trade fee on notional, basis points, default 0
 * @param {object} [opts.slippage]         SlippageModel for `slippageFill`
 * @param {object} [opts.gas]              GasModel for `gasCost`; default no gas
 * @param {number} [opts.minTradeNotional] skip dust trades below this, default 1e-6
 * @param {() => number} [opts.rng]        seeded uniform [0,1); else built from `seed`
 * @param {number} [opts.seed]             default 12345
 * @returns {object} { totalValueSeries, totalReturn, returns, finalWeights, finalCash, trades, costs }
 */
export function rebalanceMix(legs, opts = {}) {
  if (!Array.isArray(legs) || legs.length === 0) {
    throw new Error('rebalanceMix: need at least one leg');
  }
  const capital = opts.capital != null ? opts.capital : 1000;
  const rebalancePeriod = opts.rebalancePeriod != null ? opts.rebalancePeriod : 20;
  const feeBps = opts.feeBps != null ? opts.feeBps : 0;
  const slippageModel = opts.slippage || { baseBps: 0, jitterBps: 0 };
  const gasModel = opts.gas || { mean: 0, jitter: 0 };
  const minTrade = opts.minTradeNotional != null ? opts.minTradeNotional : 1e-6;
  const rng = opts.rng || sfc32(opts.seed != null ? opts.seed : 12345);
  const length = opts.length != null
    ? opts.length
    : Math.min(...legs.map((l) => l.instrument.series.length - 1));

  const n = legs.length;
  const weights = legs.map((l) => (l.weight != null ? l.weight : 1 / n));

  // Initial allocation at the t=0 marked price (t=0 has no ex-div drop yet).
  const states = legs.map((l, i) => {
    const price0 = l.instrument.series[0];
    const legValue = weights[i] * capital;
    const qty = price0 > 0 ? legValue / price0 : 0;
    return initInstrumentState(l.instrument, { qty });
  });
  let cash = capital - states.reduce((acc, s, i) => acc + s.qty * legs[i].instrument.series[0], 0);

  const costs = { fees: 0, gas: 0, slippage: 0, tax: 0, total: 0 };
  const totalValueSeries = [];
  let trades = 0;

  const markedPrices = new Array(n);

  for (let t = 0; t <= length; t += 1) {
    // 1. Advance every leg one tick; route payouts to shared cash (unless the
    //    leg DRIPs into its own position).
    for (let i = 0; i < n; i += 1) {
      const r = stepInstrument(legs[i].instrument, states[i], t);
      states[i] = r.state;
      cash += r.cashToAccount;
      costs.fees += r.fee;
      costs.tax += r.incomeTax;
      markedPrices[i] = r.markedPrice;
    }

    // 2. Rebalance toward target weights on the schedule.
    if (t > 0 && rebalancePeriod > 0 && t % rebalancePeriod === 0) {
      const legValues = states.map((s, i) => s.qty * markedPrices[i]);
      let nav = cash;
      for (const v of legValues) nav += v;

      const deltas = legs.map((l, i) => weights[i] * nav - legValues[i]);

      // Sells first (free up cash), then buys clamped to available cash, in
      // deterministic leg order so the seeded rng draws are reproducible.
      for (let i = 0; i < n; i += 1) {
        if (deltas[i] >= -minTrade) continue;
        const mid = markedPrices[i];
        if (mid <= 0) continue;
        let qty = Math.min(states[i].qty, -deltas[i] / mid);
        if (qty * mid < minTrade) continue;
        const fill = slippageFill({ side: 'sell', price: mid, notional: qty * mid, rng }, slippageModel);
        const gas = gasCost(rng, gasModel);
        const proceedsRaw = qty * fill;
        const fee = proceedsRaw * (feeBps / 10000);
        cash += proceedsRaw - gas - fee;
        // Reduce cost basis proportionally to units sold.
        const frac = states[i].qty > 0 ? qty / states[i].qty : 0;
        states[i] = { ...states[i], qty: states[i].qty - qty, costBasis: states[i].costBasis * (1 - frac) };
        costs.slippage += qty * (mid - fill);
        costs.gas += gas;
        costs.fees += fee;
        trades += 1;
      }

      for (let i = 0; i < n; i += 1) {
        if (deltas[i] <= minTrade) continue;
        const mid = markedPrices[i];
        if (mid <= 0) continue;
        const gas = gasCost(rng, gasModel);
        // Notional we can afford after gas, capped by the target delta and a
        // fee on notional: notional + notional*feeBps/1e4 + gas <= cash.
        const feeRate = feeBps / 10000;
        let notional = Math.min(deltas[i], Math.max(0, (cash - gas) / (1 + feeRate)));
        if (notional < minTrade) continue;
        const fill = slippageFill({ side: 'buy', price: mid, notional, rng }, slippageModel);
        const fee = notional * feeRate;
        const qty = notional / fill;
        cash -= notional + fee + gas;
        states[i] = { ...states[i], qty: states[i].qty + qty, costBasis: states[i].costBasis + notional };
        costs.slippage += qty * (fill - mid);
        costs.gas += gas;
        costs.fees += fee;
        trades += 1;
      }
    }

    // 3. Mark NAV (positions at marked price + cash) after any rebalance.
    let nav = cash;
    for (let i = 0; i < n; i += 1) nav += states[i].qty * markedPrices[i];
    totalValueSeries.push(nav);
  }

  costs.total = costs.fees + costs.gas + costs.slippage + costs.tax;

  const v0 = totalValueSeries[0];
  const vN = totalValueSeries[totalValueSeries.length - 1];
  const totalReturn = v0 > 0 ? vN / v0 - 1 : 0;
  const returns = [];
  for (let i = 1; i < totalValueSeries.length; i += 1) {
    const a = totalValueSeries[i - 1];
    if (a > 0) returns.push(totalValueSeries[i] / a - 1);
  }

  const finalNav = vN;
  const finalWeights = states.map((s, i) => (finalNav > 0 ? (s.qty * markedPrices[i]) / finalNav : 0));

  return {
    totalValueSeries,
    totalReturn,
    returns,
    finalWeights,
    finalCash: cash,
    trades,
    costs,
  };
}
