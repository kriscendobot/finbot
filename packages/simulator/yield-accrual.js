/**
 * Live yield / dividend accrual over a walked portfolio.
 *
 * `instruments.js` models an instrument's total-return *trajectory* over a
 * fixed price series (buy-and-hold or a rebalanced mix). This module is the
 * complement for the **live OODA world**: as `runSimulator` advances the
 * price feed tick by tick, a yield-bearing or dividend-paying position the
 * portfolio actually holds accrues into that same portfolio's cash account
 * (or, under DRIP, back into the position). The accrual is the thing that
 * makes "a position that accrues over ticks" real in the simulator world the
 * forecaster forks, rather than only in the offline return analysis.
 *
 * A live instrument descriptor reuses `instruments.js`'s policy field names
 * so the same resolvers drive both surfaces:
 *
 *   { type: 'growth' | 'yield' | 'dividend',
 *     // yield:
 *     yieldRate? | apr? , accrualPeriod?, compounding?, reinvest?,
 *     utilization?, apyFromUtilization?,
 *     // dividend:
 *     dividendPerUnit? | dividendGrowth? | (payoutRatio? + earningsPerUnit?),
 *     period? | payoutTicks? | scheduleAt?, reinvest?,
 *     // shared:
 *     fees?, tax?, ticksPerYear? }
 *
 * `apr` is the ergonomic alias for a yield position: an annualized rate that
 * is converted to the per-accrual-period rate via `aprToPerPeriodRate`. A
 * descriptor may give `yieldRate` directly instead (a scalar, a rate curve,
 * a short-rate function, or a utilization model) exactly as `yieldInstrument`
 * accepts.
 *
 * Determinism is preserved: accrual is pure arithmetic over the live position
 * value and the descriptor; it never calls Math.random and never perturbs the
 * price-feed RNG. A world with no instrument registry accrues nothing, so the
 * prior single-asset behaviour stays byte-for-byte identical.
 */

import { resolveYieldRate, resolveDividendPerUnit, isPayoutTick } from './instruments.js';

const DEFAULT_TICKS_PER_YEAR = 365;

/**
 * Convert an annualized rate (APR) into the per-accrual-period rate the
 * accrual loop applies. With `accrualPeriod` ticks between accruals and
 * `ticksPerYear` ticks per year, one accrual carries `apr * accrualPeriod /
 * ticksPerYear` of the year's rate (simple, pre-compounding).
 *
 * @param {number} apr
 * @param {number} [accrualPeriod]   default 1
 * @param {number} [ticksPerYear]    default 365
 * @returns {number}
 */
export function aprToPerPeriodRate(apr, accrualPeriod = 1, ticksPerYear = DEFAULT_TICKS_PER_YEAR) {
  if (!Number.isFinite(apr)) return 0;
  const tpy = ticksPerYear > 0 ? ticksPerYear : DEFAULT_TICKS_PER_YEAR;
  return (apr * accrualPeriod) / tpy;
}

/**
 * The headline APR of a live instrument descriptor, for reporting and for
 * the analyzer's APR-vs-risk scoring. A descriptor that carries `apr` reports
 * it directly; one that carries a scalar `yieldRate` is annualized back up
 * through `ticksPerYear`; a curve / function / utilization model has no single
 * headline rate, so this returns 0 (the analyzer then leans on price signal
 * alone for that leg).
 *
 * @param {object} descriptor
 * @returns {number}                annualized rate (0 when not expressible as one)
 */
export function aprOf(descriptor) {
  if (!descriptor || descriptor.type !== 'yield') return 0;
  if (Number.isFinite(descriptor.apr)) return descriptor.apr;
  if (typeof descriptor.yieldRate === 'number') {
    const accrualPeriod = descriptor.accrualPeriod != null ? descriptor.accrualPeriod : 1;
    const tpy = descriptor.ticksPerYear != null ? descriptor.ticksPerYear : DEFAULT_TICKS_PER_YEAR;
    return (descriptor.yieldRate * tpy) / (accrualPeriod > 0 ? accrualPeriod : 1);
  }
  return 0;
}

/**
 * Resolve a yield descriptor's per-accrual-period rate at tick `t`, honoring
 * the `apr` alias and falling through to `instruments.js`'s resolver for the
 * scalar / curve / function / utilization forms.
 *
 * @param {object} descriptor
 * @param {object} ctx     { t, ... }
 * @returns {number}
 */
function perPeriodYieldRate(descriptor, ctx) {
  if (descriptor.yieldRate == null && !descriptor.apyFromUtilization && Number.isFinite(descriptor.apr)) {
    const accrualPeriod = descriptor.accrualPeriod != null ? descriptor.accrualPeriod : 1;
    const tpy = descriptor.ticksPerYear != null ? descriptor.ticksPerYear : DEFAULT_TICKS_PER_YEAR;
    return aprToPerPeriodRate(descriptor.apr, accrualPeriod, tpy);
  }
  return resolveYieldRate(descriptor, ctx);
}

/**
 * @typedef {object} AccrualFlow
 * @property {string} asset
 * @property {'yield' | 'dividend'} kind
 * @property {number} gross          gross accrued income this tick (quote units)
 * @property {number} fee            payout + reinvest frictions deducted
 * @property {number} incomeTax      income tax deducted
 * @property {number} net            net income that reached cash or the position
 * @property {number} reinvested     net redeployed into the position (DRIP), else 0
 */

/**
 * Accrue one tick of yield / dividends for every held position whose
 * descriptor pays, mutating the portfolio (cash credit, or a DRIP buy) and
 * advancing the per-asset accrual state. Growth-only positions and assets the
 * portfolio does not hold are skipped.
 *
 * @param {import('./portfolio.js').Portfolio} portfolio
 * @param {Record<string, object>} instruments    asset -> live instrument descriptor
 * @param {number} t                              current tick index (post price advance)
 * @param {Record<string, number>} prices         current price book
 * @param {Record<string, {payoutIndex: number, accruedCash: number}>} state  per-asset accrual state (mutated)
 * @returns {AccrualFlow[]}                        per-asset flows this tick
 */
export function accruePortfolio(portfolio, instruments, t, prices, state) {
  if (!instruments) return [];
  /** @type {AccrualFlow[]} */
  const flows = [];
  // Deterministic asset order so a recorded accrual trail is stable.
  for (const asset of Object.keys(instruments).sort()) {
    const descriptor = instruments[asset];
    if (!descriptor || descriptor.type === 'growth') continue;
    const qty = portfolio.balances[asset] || 0;
    if (qty <= 0) continue;
    const price = prices[asset];
    if (price == null || price <= 0) continue;

    const st = state[asset] || (state[asset] = { payoutIndex: 0, accruedCash: 0 });
    const positionValue = qty * price;

    let gross = 0;
    let kind = null;
    if (descriptor.type === 'yield') {
      const accrualPeriod = descriptor.accrualPeriod != null ? descriptor.accrualPeriod : 1;
      if (t > 0 && accrualPeriod > 0 && t % accrualPeriod === 0) {
        const rate = perPeriodYieldRate(descriptor, { t, positionValue, qty, price });
        const base = positionValue + (descriptor.compounding ? st.accruedCash : 0);
        gross = rate * base;
        kind = 'yield';
      }
    } else if (descriptor.type === 'dividend') {
      if (isPayoutTick(descriptor, t)) {
        const perUnit = resolveDividendPerUnit(descriptor, { t, payoutIndex: st.payoutIndex });
        gross = perUnit * qty;
        st.payoutIndex += 1;
        kind = 'dividend';
      }
    }

    if (gross <= 0 || kind == null) continue;

    const fees = descriptor.fees || {};
    const tax = descriptor.tax || {};
    const payoutBps = fees.payoutBps || 0;
    const reinvestBps = fees.reinvestBps || 0;
    const gasPerPayout = fees.gasPerPayout || 0;
    const incomeRate = tax.income || 0;
    const reinvest = descriptor.reinvest || 'cash';

    let fee = gross * (payoutBps / 10000) + gasPerPayout;
    const afterFee = Math.max(0, gross - fee);
    const incomeTax = afterFee * incomeRate;
    const net = afterFee - incomeTax;
    let reinvested = 0;

    if (reinvest === 'position' && net > 0) {
      const reinvestFee = net * (reinvestBps / 10000);
      fee += reinvestFee;
      const investable = Math.max(0, net - reinvestFee);
      if (investable > 0) {
        // Credit the cash the income provides, then immediately redeploy it
        // into the position at the current price (a DRIP). Net cash effect is
        // zero; the held quantity grows.
        portfolio.creditCash(investable, { kind, asset, t, reinvested: true });
        portfolio.applyTrade({ t, side: 'buy', asset, qty: investable / price, price });
        reinvested = investable;
      }
    } else if (net > 0) {
      portfolio.creditCash(net, { kind, asset, t });
      st.accruedCash += net;
    }

    flows.push({ asset, kind, gross, fee, incomeTax, net, reinvested });
  }
  return flows;
}

/**
 * Does a world carry any non-growth (income-accruing) instrument? The runner
 * uses this to take the zero-cost fast path when there is nothing to accrue.
 *
 * @param {Record<string, object> | undefined} instruments
 * @returns {boolean}
 */
export function hasAccruingInstrument(instruments) {
  if (!instruments) return false;
  return Object.values(instruments).some((d) => d && (d.type === 'yield' || d.type === 'dividend'));
}
